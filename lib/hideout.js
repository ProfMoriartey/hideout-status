'use strict';
// Core of bin/hideout: argument parsing, feed mutations and the git
// fetch -> mutate -> validate -> commit -> push (retry) loop.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const V = require('./validate');

const STATUS_FILE = 'status.json';
const MAX_RETRIES = 10;
const GIT_TIMEOUT_MS = 60_000;
const BACKOFF_CAP_MS = 5000;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const MISSION_WHO = 'chrollo';

class UsageError extends Error {}

const USAGE = `usage:
  hideout start <member> --verb <verb> [--mission <codename>] [--progress N/M]
                          [--ticket N:title]
  hideout progress <member> [--verb <verb>] [--progress N/M] [--ticket N:title]
  hideout done <member>
  hideout idle <member>
  hideout mission start|progress|done <codename> [--tickets N/M]
  hideout mission retire <codename>
options: --dry-run  --repo <path>  --branch <name> (default main)  --help`;

// Flags each command accepts (besides the global ones).
const COMMAND_FLAGS = {
  start: ['verb', 'mission', 'progress', 'ticket'],
  progress: ['verb', 'progress', 'ticket'],
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
  if (command === 'progress' && flags.verb === undefined && flags.progress === undefined &&
      flags.ticket === undefined) {
    throw new UsageError('progress needs --verb, --progress and/or --ticket');
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
  if (flags.ticket !== undefined) {
    const t = V.parseTicket(flags.ticket);
    if (!t) throw new UsageError('--ticket must be N:title with 1 <= N <= 999');
    op.ticket = t;
  }
  if (flags.branch !== undefined && !validBranch(flags.branch)) throw new UsageError('invalid branch name');
  if (flags.repo !== undefined && flags.repo.trim() === '') throw new UsageError('--repo needs a path');
  return {
    op,
    dryRun: Boolean(flags['dry-run']),
    repo: flags.repo,
    branch: flags.branch,
  };
}

/** Check the op against the repo's allowlists. */
function checkOp(op, lists) {
  // retire may target a codename already removed from missions.allow (wrong
  // order); computeNext only lets that through if the feed still names it.
  if (op.command === 'mission retire') return;
  if (op.command.startsWith('mission ')) {
    if (!V.isMission(op.target, lists)) throw new UsageError('mission not in missions.allow');
  } else if (!V.isMember(op.target, lists)) {
    throw new UsageError('unknown member');
  }
  if (op.verb !== undefined && !V.isVerb(op.verb, lists)) throw new UsageError('verb not allowed');
  if (op.ticket !== undefined && !V.isTitle(op.ticket.title, lists)) throw new UsageError('ticket title not allowed');
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
function memberRecord(state, since, now, { verb, mission, progress, ticket } = {}) {
  const m = { state, since, updatedAt: now };
  if (verb !== undefined) m.verb = verb;
  if (mission !== undefined) m.mission = mission;
  if (progress !== undefined) m.progress = progress;
  if (ticket !== undefined) m.ticket = ticket;
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
      { verb, mission: cur.mission, progress: op.progress ?? cur.progress, ticket: op.ticket ?? cur.ticket });
    // Only a change of verb is news; progress ticks update state silently.
    if (verb !== cur.verb) pushEvent(doc, { at: now, who: target, kind: 'progress', verb, mission: cur.mission });
  } else if (command === 'done') {
    if (cur?.state === 'done') return null;
    if (!cur || cur.state !== 'working') throw new UsageError('not working');
    doc.members[target] = memberRecord('done', now, now, { verb: cur.verb, mission: cur.mission, progress: cur.progress });
    pushEvent(doc, { at: now, who: target, kind: 'done', verb: cur.verb, mission: cur.mission });
  } else if (command === 'idle') {
    if (cur?.state === 'idle' && cur.verb === undefined && cur.mission === undefined &&
        cur.progress === undefined) return null;
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
    // A codename already removed from missions.allow can be retired in any state.
    if (m && m.state === 'active' && !op.stale) throw new UsageError('mission is active; run mission done first');
    const usedBy = Object.entries(doc.members).filter(([, x]) => x.mission === target);
    const inEvents = doc.events.some((e) => e.mission === target);
    if (!m && !usedBy.length && !inEvents) return null;
    doc.missions = doc.missions.filter((x) => x.codename !== target);
    for (const [id, x] of usedBy) {
      const { mission, ...rest } = x;
      doc.members[id] = memberRecord(rest.state, rest.since, now, rest);
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
  // Codenames removed from missions.allow before they were retired: for
  // retiring one of them the feed may still name several. Accept those
  // (pattern-checked) on the current read, and on the next feed only the ones
  // that remain after the target is gone, so each can be retired in turn.
  // Retiring an allowed codename gets no such widening: it must not write on
  // top of a feed that already fails check.js.
  let readLists = lists;
  let nextLists = lists;
  const stale = op.command === 'mission retire' && !lists.missions.includes(op.target);
  if (stale) {
    const named = new Set([
      ...(Array.isArray(cur.missions) ? cur.missions.map((x) => x?.codename) : []),
      ...Object.values(cur.members ?? {}).map((x) => x?.mission),
      ...(Array.isArray(cur.events) ? cur.events.map((x) => x?.mission) : []),
    ].filter((c) => typeof c === 'string' && V.MISSION_RE.test(c)));
    const extra = (skip) => [...lists.missions, ...[...named].filter((c) => c !== skip)];
    readLists = { ...lists, missions: extra() };
    nextLists = { ...lists, missions: extra(op.target) };
  }
  const curErr = V.validateStatus(cur, readLists);
  if (curErr.length) throw new Error(`current status.json is invalid: ${curErr.join('; ')}`);
  const next = applyOp(cur, stale ? { ...op, stale: true } : op, now);
  if (next) {
    const errs = V.validateStatus(next, nextLists);
    if (errs.length) throw new Error(`refusing to write invalid feed: ${errs.join('; ')}`);
  }
  return { cur, next };
}

/**
 * Replace root/status.json atomically: write a fresh temp file (O_EXCL, so
 * never through a link), then rename over the target. rename replaces the
 * directory entry itself, so a symlink there would be replaced, not followed.
 */
function writeStatus(repo, text) {
  V.assertRegular(repo, STATUS_FILE);
  const tmp = path.join(repo, `.${STATUS_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const mode = fs.lstatSync(path.join(repo, STATUS_FILE)).mode & 0o777;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try {
    fs.fchmodSync(fd, mode); // not subject to the umask
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmp, path.join(repo, STATUS_FILE));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

const ATTRS = ['filter', 'text', 'eol', 'ident', 'working-tree-encoding', 'crlf'];

/** Refuse git attributes that could make the committed blob differ from what we validated. */
function assertNoAttributes(repo) {
  const out = git(repo, ['check-attr', ...ATTRS, '--', STATUS_FILE]);
  for (const line of out.split('\n')) {
    const value = line.split(': ').pop();
    if (value && value !== 'unspecified') {
      throw new Error(`${STATUS_FILE} has git attributes (${line.split(': ')[1]}) that could change its bytes; refusing`);
    }
  }
}

// ---- git ----

// No repo-controlled hooks or fsmonitor commands run on behalf of the tool,
// and commits are never signed (a signature would publish a key id).
const GIT_SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false',
  // Keep status.json byte-identical to the validated text whatever the user's EOL config.
  '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.safecrlf=false'];

// Feed commits carry a fixed identity and UTC dates, so the public history
// does not reveal who ran the tool, their email or their time zone.
const FEED_IDENTITY = { name: 'hideout', email: 'hideout@noreply.invalid' };

// GIT_* variables a caller may legitimately need for transport/auth.
const GIT_ENV_KEEP = new Set(['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_ASKPASS',
  'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'GIT_PROXY_COMMAND', 'GIT_EXEC_PATH']);

/** process.env without GIT_* overrides (GIT_DIR, GIT_INDEX_FILE, GIT_CONFIG_*, ...). */
function gitEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('GIT_') && !GIT_ENV_KEEP.has(k)) continue;
    env[k] = v;
  }
  return { ...env, LC_ALL: 'C', LANGUAGE: 'C', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', ...extra };
}

function feedCommitEnv() {
  const date = `${Math.floor(Date.now() / 1000)} +0000`;
  return {
    GIT_AUTHOR_NAME: FEED_IDENTITY.name, GIT_AUTHOR_EMAIL: FEED_IDENTITY.email, GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: FEED_IDENTITY.name, GIT_COMMITTER_EMAIL: FEED_IDENTITY.email, GIT_COMMITTER_DATE: date,
    TZ: 'UTC',
  };
}

/** HIDEOUT_GIT_TIMEOUT_MS may only lower the git timeout (tests). */
function gitTimeoutMs() {
  const raw = process.env.HIDEOUT_GIT_TIMEOUT_MS;
  const env = raw !== undefined && /^\d{1,5}$/.test(raw) ? Number(raw) : GIT_TIMEOUT_MS;
  return env > 0 && env < GIT_TIMEOUT_MS ? env : GIT_TIMEOUT_MS;
}

function git(repo, args, { extraEnv, raw = false } = {}) {
  try {
    const out = execFileSync('git', ['-C', repo, ...GIT_SAFE, ...args], {
      encoding: raw ? 'buffer' : 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: gitEnv(extraEnv),
      maxBuffer: 4 * V.MAX_FILE_BYTES,
      // A stalled fetch/push must end the run, not hang the session.
      timeout: gitTimeoutMs(),
      killSignal: 'SIGKILL',
    });
    return raw ? out : out.trim();
  } catch (e) {
    const stderr = String(e.stderr ?? '');
    const timedOut = e.code === 'ETIMEDOUT';
    const first = timedOut ? 'timed out'
      : stderr.split('\n').map((l) => l.trim()).find(Boolean) ?? e.message;
    const err = new Error(`git ${args[0]} failed: ${first}`);
    err.stdout = String(e.stdout ?? '');
    err.timedOut = timedOut;
    err.stderr = stderr;
    throw err;
  }
}

function gitTry(repo, args) {
  try { return { ok: true, out: git(repo, args) }; } catch (e) {
    return { ok: false, out: String(e.stdout ?? ''), err: String(e.stderr || e.message), timedOut: e.timedOut };
  }
}

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/**
 * Classify a failed push: 'race' (retry) or 'fatal'. Only git's own ref
 * status lines (" ! [rejected] a -> b (reason)") count; text printed by
 * server hooks ("remote: ...") can never make a rejection look like a race.
 */
function pushReasons(stderr) {
  const out = [];
  for (const line of stderr.split('\n')) {
    const m = /^ ! \[(rejected|remote rejected)\]\s+\S+ -> \S+ \((.*)\)$/.exec(line.trimEnd());
    if (m) out.push({ kind: m[1], reason: m[2] });
  }
  return out;
}

function classifyPush(stderr) {
  const reasons = pushReasons(stderr);
  if (!reasons.length) return 'fatal';
  const race = ({ kind, reason }) => (kind === 'rejected'
    ? /^(fetch first|non-fast-forward)$/.test(reason)
    : /^(cannot lock ref|failed to update ref)\b/.test(reason));
  return reasons.every(race) ? 'race' : 'fatal';
}

/** Base delay in ms for the first retry; HIDEOUT_RETRY_BASE_MS may only lower it (tests). */
function backoffBase() {
  const raw = process.env.HIDEOUT_RETRY_BASE_MS;
  if (raw === undefined || !/^\d{1,3}$/.test(raw)) return 200;
  const env = Number(raw);
  return env < 200 ? env : 200;
}

function backoffMs(attempt) {
  return Math.min(BACKOFF_CAP_MS, Math.floor(backoffBase() * 2 ** attempt * Math.random() * 2));
}

/** True when every local commit not on `tip` is a feed-identity commit touching only status.json. */
function onlyLeftoverFeedCommits(repo, tip) {
  const who = git(repo, ['log', '--format=%an <%ae>|%cn <%ce>', `${tip}..HEAD`]).split('\n');
  const id = `${FEED_IDENTITY.name} <${FEED_IDENTITY.email}>`;
  if (!who.every((l) => l === `${id}|${id}`)) return false;
  return git(repo, ['diff', '--name-only', `${tip}...HEAD`]) === STATUS_FILE;
}

/**
 * Fetch and fast-forward the local branch to the remote tip. Unpushed commits
 * are refused, except a leftover hideout commit from an interrupted run.
 */
function syncToRemote(repo, branch, log = () => {}) {
  git(repo, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  const remoteTip = git(repo, ['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]);
  const head = git(repo, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head !== remoteTip) {
    const ff = gitTry(repo, ['merge-base', '--is-ancestor', head, remoteTip]);
    if (!ff.ok && onlyLeftoverFeedCommits(repo, remoteTip)) {
      // A run killed after its commit but before its push: drop that commit.
      log('dropping an unpushed hideout commit left by an interrupted run');
      git(repo, ['reset', '--quiet', '--hard', remoteTip]);
    } else if (!ff.ok) throw new Error(`local ${branch} has commits not on origin; refusing (would push them) ` +
      `(inspect with git log origin/${branch}..HEAD; git reset --hard origin/${branch} if it is only a leftover hideout commit)`);
    else git(repo, ['merge', '--ff-only', '--quiet', remoteTip]);
  }
  if (git(repo, ['rev-parse', 'HEAD']) !== remoteTip) throw new Error('could not update to remote tip');
  return remoteTip;
}

function preflight(repo, branch, log = () => {}) {
  const top = git(repo, ['rev-parse', '--show-toplevel']);
  if (path.resolve(top) !== path.resolve(repo) && fs.realpathSync(top) !== fs.realpathSync(repo)) {
    throw new Error('--repo must be the top of a git checkout');
  }
  const cur = gitTry(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!cur.ok || cur.out !== branch) {
    throw new Error(`checkout is not on branch ${branch}; use a dedicated clone on ${branch}`);
  }
  const dirty = git(repo, ['status', '--porcelain', '--untracked-files=no']);
  // Only status.json changed: a run killed between its write and its commit.
  if (/^[MA]{1,2} +status\.json$/.test(dirty)) { // git() trims the leading space
    log('restoring status.json left changed by an interrupted run');
    git(repo, ['reset', '--quiet', '--hard', 'HEAD']);
  } else if (dirty) {
    throw new Error('working tree has uncommitted changes; refusing (in a dedicated feed clone: git reset --hard)');
  }
}

/**
 * Full write flow with retries.
 * @returns {{doc: object, attempts: number, changed: boolean}}
 */
function publish({ op, repo, branch, log = () => {} }) {
  preflight(repo, branch, log);
  const msg = commitMessage(op);
  for (let attempt = 0; ; attempt++) {
    const base = syncToRemote(repo, branch, log);
    const { cur, next } = computeNext(repo, op);
    if (!next) {
      log('nothing to change');
      return { doc: cur, attempts: attempt + 1, changed: false };
    }
    const bytes = V.serialize(next);
    assertNoAttributes(repo);
    try {
      writeStatus(repo, bytes);
      git(repo, ['add', '--', STATUS_FILE]);
      git(repo, ['commit', '--quiet', '--no-verify', '-m', msg, '--', STATUS_FILE], { extraEnv: feedCommitEnv() });
      // Filters, eol or encoding attributes must not change what is pushed.
      const blob = git(repo, ['cat-file', 'blob', `HEAD:${STATUS_FILE}`], { raw: true });
      if (!blob.equals(Buffer.from(bytes, 'utf8'))) {
        throw new Error('committed status.json differs from the validated bytes (git filter/eol attributes?)');
      }
    } catch (e) {
      gitTry(repo, ['reset', '--quiet', '--hard', base]);
      throw new Error(`commit failed: ${(e.stderr ? String(e.stderr).split('\n').find(Boolean) : '') || e.message}`);
    }
    const push = gitTry(repo, ['push', '--quiet', '--no-verify', 'origin', `HEAD:refs/heads/${branch}`]);
    if (push.ok) {
      log(`pushed: ${msg}${attempt ? ` (after ${attempt} retr${attempt === 1 ? 'y' : 'ies'})` : ''}`);
      return { doc: next, attempts: attempt + 1, changed: true };
    }
    // Drop our local commit; the next attempt re-applies the op to the fresh file.
    gitTry(repo, ['reset', '--quiet', '--hard', base]);
    if (push.timedOut) throw new Error('push timed out; it may have reached the remote, re-run to check');
    const kind = classifyPush(push.err);
    if (kind === 'fatal') {
      const hint = /\[remote rejected\]/.test(push.err)
        ? ' (the remote refused the update; check branch protection or server hooks)' : '';
      throw new Error(`push failed${hint}: ${push.err.trim()}`);
    }
    if (attempt >= MAX_RETRIES) {
      const last = pushReasons(push.err).map((r) => r.reason).join('; ');
      throw new Error(`push still rejected after ${MAX_RETRIES} retries (last: ${last}); try again later`);
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
  const repo = path.resolve(parsed.repo ?? (process.env.HIDEOUT_REPO || defaultRepo));
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
