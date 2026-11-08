'use strict';
// Core of bin/hideout: argument parsing, feed mutations and the git
// fetch -> mutate -> validate -> commit -> push (retry) loop.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const V = require('./validate');

const STATUS_FILE = 'status.json';
const MAX_RETRIES = 5;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const MISSION_WHO = 'chrollo';

class UsageError extends Error {}

const USAGE = `usage:
  hideout start <member> --verb <verb> [--mission <codename>] [--progress N/M]
  hideout progress <member> [--verb <verb>] [--progress N/M]
  hideout done <member>
  hideout idle <member>
  hideout mission start|progress|done <codename> [--tickets N/M]
options: --dry-run  --repo <path>  --branch <name> (default main)  --help`;

// Flags each command accepts (besides the global ones).
const COMMAND_FLAGS = {
  start: ['verb', 'mission', 'progress'],
  progress: ['verb', 'progress'],
  done: [],
  idle: [],
  'mission start': ['tickets'],
  'mission progress': ['tickets'],
  'mission done': ['tickets'],
};
const GLOBAL_VALUE_FLAGS = ['repo', 'branch'];
const GLOBAL_BOOL_FLAGS = ['dry-run', 'help'];

/**
 * Strictly parse argv. Unknown flags, duplicates and extra args are errors.
 * Only syntax is checked here; allowlists are checked against the repo.
 */
function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') throw new UsageError('"--" is not supported');
    if (a.startsWith('--')) {
      let name = a.slice(2);
      let value;
      const eq = name.indexOf('=');
      if (eq !== -1) { value = name.slice(eq + 1); name = name.slice(0, eq); }
      if (own(flags, name)) throw new UsageError('duplicate flag');
      if (GLOBAL_BOOL_FLAGS.includes(name)) {
        if (value !== undefined) throw new UsageError('flag takes no value');
        flags[name] = true;
        continue;
      }
      const known = GLOBAL_VALUE_FLAGS.includes(name) ||
        Object.values(COMMAND_FLAGS).some((f) => f.includes(name));
      if (!known) throw new UsageError('unknown flag');
      if (value === undefined) {
        if (i + 1 >= argv.length) throw new UsageError('flag needs a value');
        value = argv[++i];
      }
      flags[name] = value;
    } else if (a.startsWith('-') && a !== '-') {
      throw new UsageError('unknown flag');
    } else {
      pos.push(a);
    }
  }
  if (flags.help) return { help: true };

  let command;
  let target;
  if (pos[0] === 'mission') {
    command = `mission ${pos[1] ?? ''}`;
    target = pos[2];
    if (pos.length !== 3) throw new UsageError('expected: hideout mission start|progress|done <codename>');
  } else {
    command = pos[0];
    target = pos[1];
    if (pos.length !== 2) throw new UsageError('expected a command and exactly one member');
  }
  if (!own(COMMAND_FLAGS, command)) throw new UsageError('unknown command');
  for (const name of Object.keys(flags)) {
    if (GLOBAL_VALUE_FLAGS.includes(name) || GLOBAL_BOOL_FLAGS.includes(name)) continue;
    if (!COMMAND_FLAGS[command].includes(name)) throw new UsageError('flag not valid for this command');
  }
  if (command === 'start' && flags.verb === undefined) throw new UsageError('start needs --verb');
  if (command === 'progress' && flags.verb === undefined && flags.progress === undefined) {
    throw new UsageError('progress needs --verb and/or --progress');
  }
  if (command === 'mission progress' && flags.tickets === undefined) {
    throw new UsageError('mission progress needs --tickets');
  }

  // Syntax checks that do not need the repo.
  const op = { command, target };
  if (command.startsWith('mission ')) {
    if (!V.MISSION_RE.test(target)) throw new UsageError('invalid mission codename');
  } else if (!V.MEMBER_IDS.includes(target)) {
    throw new UsageError('unknown member');
  }
  if (flags.verb !== undefined) {
    if (!V.VERB_RE.test(flags.verb)) throw new UsageError('verb not allowed');
    op.verb = flags.verb;
  }
  if (flags.mission !== undefined) {
    if (!V.MISSION_RE.test(flags.mission)) throw new UsageError('invalid mission codename');
    op.mission = flags.mission;
  }
  for (const k of ['progress', 'tickets']) {
    if (flags[k] === undefined) continue;
    const c = V.parseCount(flags[k]);
    if (!c) throw new UsageError(`--${k} must be N/M with 0 <= N <= M, 1 <= M <= ${V.COUNT_MAX}`);
    op[k] = c;
  }
  if (flags.branch !== undefined && (!BRANCH_RE.test(flags.branch) || flags.branch.includes('..') ||
      flags.branch.endsWith('.lock'))) {
    throw new UsageError('invalid branch name');
  }
  return {
    op,
    dryRun: Boolean(flags['dry-run']),
    repo: flags.repo,
    branch: flags.branch,
  };
}

function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

/** Check the op against the repo's allowlists. */
function checkOp(op, lists) {
  if (op.command.startsWith('mission ')) {
    if (!V.isMission(op.target, lists)) throw new UsageError('mission not in missions.allow');
  } else if (!V.isMember(op.target, lists)) {
    throw new UsageError('unknown member');
  }
  if (op.verb !== undefined && !V.isVerb(op.verb, lists)) throw new UsageError('verb not allowed');
  if (op.mission !== undefined && !V.isMission(op.mission, lists)) {
    throw new UsageError('mission not in missions.allow');
  }
}

function pushEvent(doc, ev) {
  const clean = { at: ev.at, who: ev.who, kind: ev.kind };
  if (ev.verb !== undefined) clean.verb = ev.verb;
  if (ev.mission !== undefined) clean.mission = ev.mission;
  doc.events = [clean, ...doc.events].slice(0, V.MAX_EVENTS);
}

/**
 * Apply op to a deep copy of doc. Pure apart from `now`.
 * @returns {object} the new document
 */
function applyOp(input, op, now = new Date().toISOString()) {
  const doc = structuredClone(input);
  const { command, target } = op;
  doc.members ??= {};
  doc.missions ??= [];
  doc.events ??= [];

  if (command === 'start') {
    const m = { state: 'working', since: now, verb: op.verb };
    if (op.mission !== undefined) m.mission = op.mission;
    if (op.progress !== undefined) m.progress = op.progress;
    doc.members[target] = m;
    pushEvent(doc, { at: now, who: target, kind: 'start', verb: op.verb, mission: op.mission });
  } else if (command === 'progress') {
    const cur = doc.members[target];
    if (!cur || cur.state !== 'working') throw new UsageError('member is not working; use start');
    const m = { ...cur };
    if (op.verb !== undefined) m.verb = op.verb;
    if (op.progress !== undefined) m.progress = op.progress;
    doc.members[target] = m;
    pushEvent(doc, { at: now, who: target, kind: 'progress', verb: m.verb, mission: m.mission });
  } else if (command === 'done') {
    const cur = doc.members[target] ?? {};
    const m = { state: 'done', since: now };
    if (cur.verb !== undefined) m.verb = cur.verb;
    if (cur.mission !== undefined) m.mission = cur.mission;
    if (cur.progress !== undefined) m.progress = cur.progress;
    doc.members[target] = m;
    pushEvent(doc, { at: now, who: target, kind: 'done', verb: m.verb, mission: m.mission });
  } else if (command === 'idle') {
    doc.members[target] = { state: 'idle', since: now };
  } else if (command === 'mission start') {
    const existing = doc.missions.find((x) => x.codename === target);
    if (existing && existing.state === 'active') throw new UsageError('mission already active');
    const ms = { codename: target, state: 'active', startedAt: now };
    if (op.tickets !== undefined) ms.tickets = op.tickets;
    let list = doc.missions.filter((x) => x.codename !== target);
    if (list.length >= V.MAX_MISSIONS) {
      // Drop the oldest finished mission to make room.
      const done = list.filter((x) => x.state === 'done')
        .sort((a, b) => (a.endedAt ?? a.startedAt).localeCompare(b.endedAt ?? b.startedAt));
      if (!done.length) throw new UsageError(`already ${V.MAX_MISSIONS} active missions`);
      list = list.filter((x) => x !== done[0]);
    }
    doc.missions = [...list, ms];
    pushEvent(doc, { at: now, who: MISSION_WHO, kind: 'mission-start', mission: target });
  } else if (command === 'mission progress' || command === 'mission done') {
    const idx = doc.missions.findIndex((x) => x.codename === target);
    if (idx === -1 || doc.missions[idx].state !== 'active') throw new UsageError('mission is not active');
    const ms = { ...doc.missions[idx] };
    if (op.tickets !== undefined) ms.tickets = op.tickets;
    if (command === 'mission done') { ms.state = 'done'; ms.endedAt = now; }
    doc.missions = doc.missions.map((x, i) => (i === idx ? ms : x));
    pushEvent(doc, {
      at: now, who: MISSION_WHO,
      kind: command === 'mission done' ? 'mission-done' : 'mission-progress', mission: target,
    });
  } else {
    throw new UsageError('unknown command');
  }
  doc.updatedAt = now;
  return doc;
}

/** Fixed-format commit message built only from validated tokens. */
function commitMessage(op) {
  if (op.command.startsWith('mission ')) return `hideout: ${op.command} ${op.target}`;
  if (op.command === 'start' || op.command === 'progress') {
    return op.verb ? `hideout: ${op.target} ${op.command} ${op.verb}` : `hideout: ${op.target} ${op.command}`;
  }
  return `hideout: ${op.target} ${op.command}`;
}

function serialize(doc) { return `${JSON.stringify(doc, null, 2)}\n`; }

/** Read, check, mutate and validate. Throws on any problem; writes nothing. */
function computeNext(repo, op, now) {
  const lists = V.loadAllowlists(repo);
  checkOp(op, lists);
  const cur = JSON.parse(V.readSmall(path.join(repo, STATUS_FILE)));
  const curErr = V.validateStatus(cur, lists);
  if (curErr.length) throw new Error(`current status.json is invalid: ${curErr.join('; ')}`);
  const next = applyOp(cur, op, now);
  const errs = V.validateStatus(next, lists);
  if (errs.length) throw new Error(`refusing to write invalid feed: ${errs.join('; ')}`);
  return next;
}

// ---- git ----

function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    ...opts,
  }).trim();
}

function gitTry(repo, args) {
  try { return { ok: true, out: git(repo, args) }; } catch (e) {
    return { ok: false, out: String(e.stdout ?? ''), err: String(e.stderr ?? e.message) };
  }
}

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

const REJECTED_RE = /\[(remote )?rejected\]|fetch first|non-fast-forward|cannot lock ref|failed to update ref/i;

/** Fetch and fast-forward the local branch to the remote tip; refuse otherwise. */
function syncToRemote(repo, branch) {
  git(repo, ['fetch', '--quiet', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  const remoteTip = git(repo, ['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]);
  const head = git(repo, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head !== remoteTip) {
    const ff = gitTry(repo, ['merge-base', '--is-ancestor', head, remoteTip]);
    if (!ff.ok) throw new Error(`local ${branch} has commits not on origin; refusing (would push them)`);
    git(repo, ['merge', '--ff-only', '--quiet', remoteTip]);
  }
  if (git(repo, ['rev-parse', 'HEAD']) !== remoteTip) throw new Error('could not update to remote tip');
  return remoteTip;
}

function preflight(repo, branch) {
  const top = git(repo, ['rev-parse', '--show-toplevel']);
  if (path.resolve(top) !== path.resolve(repo) && fs.realpathSync(top) !== fs.realpathSync(repo)) {
    throw new Error('--repo must be the top of a git checkout');
  }
  const cur = gitTry(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!cur.ok || cur.out !== branch) {
    throw new Error(`checkout is not on branch ${branch}; use a dedicated clone on ${branch}`);
  }
  const dirty = git(repo, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) throw new Error('working tree has uncommitted changes; refusing');
}

/**
 * Full write flow with retries. Returns the document that landed.
 * @param {{op: object, repo: string, branch: string, log?: (s: string) => void}} o
 */
function publish({ op, repo, branch, log = () => {} }) {
  preflight(repo, branch);
  const file = path.join(repo, STATUS_FILE);
  const msg = commitMessage(op);
  for (let attempt = 0; ; attempt++) {
    const base = syncToRemote(repo, branch);
    const next = computeNext(repo, op);
    fs.writeFileSync(file, serialize(next));
    try {
      git(repo, ['add', '--', STATUS_FILE]);
      git(repo, ['commit', '--quiet', '-m', msg, '--', STATUS_FILE]);
    } catch (e) {
      gitTry(repo, ['reset', '--quiet', '--hard', base]);
      throw new Error(`commit failed: ${String(e.stderr ?? e.message).trim()}`);
    }
    const push = gitTry(repo, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
    if (push.ok) {
      log(`pushed: ${msg}`);
      return next;
    }
    // Drop our local commit; the next attempt re-applies the op to the fresh file.
    gitTry(repo, ['reset', '--quiet', '--hard', base]);
    if (!REJECTED_RE.test(push.err) || attempt >= MAX_RETRIES) {
      throw new Error(`push failed after ${attempt + 1} attempt(s): ${push.err.trim()}`);
    }
    const wait = 200 * 2 ** attempt + Math.floor(Math.random() * 300);
    log(`push rejected, retrying in ${wait} ms`);
    sleepMs(wait);
  }
}

/** CLI entry. Returns the process exit code. */
function main(argv, { defaultRepo, stdout = process.stdout, stderr = process.stderr } = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    stderr.write(`hideout: ${e.message}\n${USAGE}\n`);
    return 2;
  }
  if (parsed.help) { stdout.write(`${USAGE}\n`); return 0; }
  const repo = path.resolve(parsed.repo || process.env.HIDEOUT_REPO || defaultRepo);
  const branch = parsed.branch ?? 'main';
  try {
    if (parsed.dryRun) {
      stdout.write(serialize(computeNext(repo, parsed.op)));
      return 0;
    }
    publish({ op: parsed.op, repo, branch, log: (s) => stderr.write(`hideout: ${s}\n`) });
    return 0;
  } catch (e) {
    stderr.write(`hideout: ${e.message}\n`);
    return e instanceof UsageError ? 2 : 1;
  }
}

module.exports = { parseArgs, applyOp, commitMessage, computeNext, publish, main, UsageError, USAGE };
