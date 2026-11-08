'use strict';
// Core of bin/hideout: argument parsing, feed mutations and the git
// fetch -> mutate -> validate -> commit -> push (retry) loop.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const V = require('./validate');

const STATUS_FILE = 'status.json';
const MAX_RETRIES = 10;
const BACKOFF_CAP_MS = 5000;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const MISSION_WHO = 'chrollo';

class UsageError extends Error {}

const USAGE = `usage:
  hideout start <member> --verb <verb> [--mission <codename>] [--progress N/M]
  hideout progress <member> [--verb <verb>] [--progress N/M]
  hideout done <member>
  hideout idle <member>
  hideout mission start|progress|done <codename> [--tickets N/M]
  hideout mission retire <codename>
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
  'mission retire': [],
};
const GLOBAL_VALUE_FLAGS = ['repo', 'branch'];
const GLOBAL_BOOL_FLAGS = ['dry-run', 'help'];

function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

function validBranch(b) {
  return BRANCH_RE.test(b) && b !== 'HEAD' && !b.startsWith('refs/') &&
    !b.includes('..') && !b.split('/').some((p) => p.endsWith('.lock') || p.endsWith('.'));
}

/**
 * Strictly parse argv. Unknown flags, duplicates and extra args are errors.
 * Only syntax is checked here; allowlists are checked against the repo.
 */
function parseArgs(argv) {
  const flags = Object.create(null);
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
      if (value.startsWith('--')) throw new UsageError('flag needs a value');
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
    if (pos.length !== 3) throw new UsageError('expected: hideout mission start|progress|done|retire <codename>');
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
  if (flags.branch !== undefined && !validBranch(flags.branch)) throw new UsageError('invalid branch name');
  return {
    op,
    dryRun: Boolean(flags['dry-run']),
    repo: flags.repo,
    branch: flags.branch,
  };
}

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

/** Build a member record in canonical key order. */
function memberRecord(state, since, now, { verb, mission, progress } = {}) {
  const m = { state, since, updatedAt: now };
  if (verb !== undefined) m.verb = verb;
  if (mission !== undefined) m.mission = mission;
  if (progress !== undefined) m.progress = progress;
  return m;
}

/**
 * Apply op to a deep copy of doc. Pure apart from `now`.
 * @returns {object|null} the new document, or null when the op is a no-op
 */
function applyOp(input, op, now = new Date().toISOString()) {
  const doc = structuredClone(input);
  const { command, target } = op;
  doc.members ??= {};
  doc.missions ??= [];
  doc.events ??= [];
  const cur = own(doc.members, target) ? doc.members[target] : undefined;
  // `since` moves only when the state changes.
  const sinceFor = (state) => (cur && cur.state === state ? cur.since : now);

  if (command === 'start') {
    doc.members[target] = memberRecord('working', sinceFor('working'), now, op);
    pushEvent(doc, { at: now, who: target, kind: 'start', verb: op.verb, mission: op.mission });
  } else if (command === 'progress') {
    if (!cur || cur.state !== 'working') throw new UsageError('not working');
    const verb = op.verb ?? cur.verb;
    doc.members[target] = memberRecord('working', cur.since, now,
      { verb, mission: cur.mission, progress: op.progress ?? cur.progress });
    // Only a change of verb is news; progress ticks update state silently.
    if (verb !== cur.verb) pushEvent(doc, { at: now, who: target, kind: 'progress', verb, mission: cur.mission });
  } else if (command === 'done') {
    if (cur?.state === 'done') return null;
    if (!cur || cur.state !== 'working') throw new UsageError('not working');
    doc.members[target] = memberRecord('done', now, now, cur);
    pushEvent(doc, { at: now, who: target, kind: 'done', verb: cur.verb, mission: cur.mission });
  } else if (command === 'idle') {
    doc.members[target] = memberRecord('idle', sinceFor('idle'), now);
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
    const old = doc.missions[idx];
    const ms = { codename: old.codename, state: old.state, startedAt: old.startedAt };
    if (command === 'mission done') { ms.state = 'done'; ms.endedAt = now; }
    const tickets = op.tickets ?? old.tickets;
    if (tickets !== undefined) ms.tickets = tickets;
    doc.missions = doc.missions.map((x, i) => (i === idx ? ms : x));
    pushEvent(doc, {
      at: now, who: MISSION_WHO,
      kind: command === 'mission done' ? 'mission-done' : 'mission-progress', mission: target,
    });
  } else if (command === 'mission retire') {
    const m = doc.missions.find((x) => x.codename === target);
    if (m && m.state === 'active') throw new UsageError('mission is active; run mission done first');
    const usedBy = Object.entries(doc.members).filter(([, x]) => x.mission === target);
    const inEvents = doc.events.some((e) => e.mission === target);
    if (!m && !usedBy.length && !inEvents) return null;
    doc.missions = doc.missions.filter((x) => x.codename !== target);
    for (const [id, x] of usedBy) {
      const { mission, ...rest } = x;
      doc.members[id] = rest;
    }
    doc.events = doc.events.filter((e) => e.mission !== target);
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

/**
 * Read, check, mutate and validate. Throws on any problem; writes nothing.
 * @returns {{cur: object, next: object|null}} next is null for a no-op
 */
function computeNext(repo, op, now) {
  const lists = V.loadAllowlists(repo);
  checkOp(op, lists);
  const cur = V.parseStatus(V.readSmall(repo, STATUS_FILE));
  const curErr = V.validateStatus(cur, lists);
  if (curErr.length) throw new Error(`current status.json is invalid: ${curErr.join('; ')}`);
  const next = applyOp(cur, op, now);
  if (next) {
    const errs = V.validateStatus(next, lists);
    if (errs.length) throw new Error(`refusing to write invalid feed: ${errs.join('; ')}`);
  }
  return { cur, next };
}

/** Overwrite root/status.json without ever following a symlink. */
function writeStatus(repo, text) {
  const file = V.assertRegular(repo, STATUS_FILE);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${STATUS_FILE} is not a regular file`);
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}

// ---- git ----

// No repo-controlled hooks or fsmonitor commands run on behalf of the tool.
const GIT_SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...GIT_SAFE, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function gitTry(repo, args) {
  try { return { ok: true, out: git(repo, args) }; } catch (e) {
    return { ok: false, out: String(e.stdout ?? ''), err: String(e.stderr ?? e.message) };
  }
}

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** Classify a failed push: 'race' (retry) or 'fatal'. */
function classifyPush(stderr) {
  if (/\[remote rejected\]/.test(stderr)) {
    return /cannot lock ref|failed to update ref/.test(stderr) ? 'race' : 'fatal';
  }
  if (/\[rejected\]|fetch first|non-fast-forward/.test(stderr)) return 'race';
  return 'fatal';
}

/** Base delay in ms for the first retry; HIDEOUT_RETRY_BASE_MS may only lower it (tests). */
function backoffBase() {
  const env = Number(process.env.HIDEOUT_RETRY_BASE_MS);
  return Number.isInteger(env) && env >= 0 && env < 200 ? env : 200;
}

function backoffMs(attempt) {
  return Math.min(BACKOFF_CAP_MS, Math.floor(backoffBase() * 2 ** attempt * Math.random() * 2));
}

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
 * Full write flow with retries.
 * @returns {{doc: object, attempts: number, changed: boolean}}
 */
function publish({ op, repo, branch, log = () => {} }) {
  preflight(repo, branch);
  const msg = commitMessage(op);
  for (let attempt = 0; ; attempt++) {
    const base = syncToRemote(repo, branch);
    const { cur, next } = computeNext(repo, op);
    if (!next) {
      log('nothing to change');
      return { doc: cur, attempts: attempt + 1, changed: false };
    }
    try {
      writeStatus(repo, V.serialize(next));
      git(repo, ['add', '--', STATUS_FILE]);
      git(repo, ['commit', '--quiet', '--no-verify', '-m', msg, '--', STATUS_FILE]);
    } catch (e) {
      gitTry(repo, ['reset', '--quiet', '--hard', base]);
      throw new Error(`commit failed: ${String(e.stderr || e.message).trim()}`);
    }
    const push = gitTry(repo, ['push', '--quiet', '--no-verify', 'origin', `HEAD:refs/heads/${branch}`]);
    if (push.ok) {
      log(`pushed: ${msg}${attempt ? ` (after ${attempt} retr${attempt === 1 ? 'y' : 'ies'})` : ''}`);
      return { doc: next, attempts: attempt + 1, changed: true };
    }
    // Drop our local commit; the next attempt re-applies the op to the fresh file.
    gitTry(repo, ['reset', '--quiet', '--hard', base]);
    const kind = classifyPush(push.err);
    if (kind === 'fatal') {
      const hint = /\[remote rejected\]/.test(push.err)
        ? ' (the remote refused the update; check branch protection or server hooks)' : '';
      throw new Error(`push failed${hint}: ${push.err.trim()}`);
    }
    if (attempt >= MAX_RETRIES) {
      throw new Error(`push still rejected after ${MAX_RETRIES} retries; try again later`);
    }
    const wait = backoffMs(attempt);
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
      const { cur, next } = computeNext(repo, parsed.op);
      stdout.write(V.serialize(next ?? cur));
      return 0;
    }
    publish({ op: parsed.op, repo, branch, log: (s) => stderr.write(`hideout: ${s}\n`) });
    return 0;
  } catch (e) {
    stderr.write(`hideout: ${e.message}\n`);
    return e instanceof UsageError ? 2 : 1;
  }
}

module.exports = {
  parseArgs, applyOp, commitMessage, computeNext, classifyPush, backoffMs, publish, main,
  UsageError, USAGE, MAX_RETRIES,
};
