'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { BRANCH, TOOL, git, tmpdir, makeRemote, remoteFeed, run, runAsync } = require('./helpers');

const tick = () => new Promise((r) => setTimeout(r, 5));

const M = '--mission';

const PROGRESS_MSG = '--progress must be N/M with 0 <= N <= M, 1 <= M <= 999';
const PRIVACY_CASES = [
  [['start', 'feitan', '--verb', 'hacking the mainframe'], 'verb not allowed'],
  [['start', 'feitan', '--verb', 'hacking'], 'verb not allowed'],
  [['start', 'feitan', '--verb', 'Testing'], 'verb not allowed'],
  [['start', 'feitan'], 'start needs --verb'],
  [['start', 'hisoka', '--verb', 'testing'], 'unknown member'],
  [['start', 'Feitan', '--verb', 'testing'], 'unknown member'],
  [['start', 'feitan', '--verb', 'testing', M, 'Secret Op'], 'mission not in missions.allow'],
  [['start', 'feitan', '--verb', 'testing', M, 'silk lantern'], 'invalid mission codename'],
  [['start', 'feitan', '--verb', 'testing', M, 'Silk Lantern Rising Now'], 'invalid mission codename'],
  [['start', 'feitan', '--verb', 'testing', '--progress', '6/5'], PROGRESS_MSG],
  [['start', 'feitan', '--verb', 'testing', '--progress', '1/1000'], PROGRESS_MSG],
  [['start', 'feitan', '--verb', 'testing', '--progress', '99999/99999'], PROGRESS_MSG],
  [['start', 'feitan', '--verb', 'testing', 'extra'], 'expected a command and exactly one member'],
  [['start', 'feitan', '--verb', 'testing', '--note', 'hi'], 'unknown flag'],
  [['start', 'feitan', '--verb', 'testing', '--verb', 'building'], 'duplicate flag'],
  [['start', 'feitan', '--verb', 'testing', '--tickets', '1/2'], 'flag not valid for this command'],
  [['start', 'feitan', '--verb', 'testing', '-x'], 'unknown flag'],
  [['start', 'feitan', '--verb', 'testing; rm -rf /'], 'verb not allowed'],
  [['start', 'feitan', '--verb', '$(whoami)'], 'verb not allowed'],
  [['start', 'feitan', '--verb', 'testing\nSigned-off-by: x'], 'verb not allowed'],
  [['start', 'feitan', '--verb', 'testing', M, 'Silk Lantern"}'], 'invalid mission codename'],
  [['start', '../feitan', '--verb', 'testing'], 'unknown member'],
  [['start', '__proto__', '--verb', 'testing'], 'unknown member'],
  [['start', 'feitan', '--verb', 'constructor'], 'verb not allowed'],
  [['start', 'feitan', '--verb', '--progress', '1/2'], 'flag needs a value'],
  [['start', 'feitan', '--verb', 'testing', '--branch', '--force'], 'flag needs a value'],
  [['start', 'feitan', '--verb', 'testing', '--branch', '../../x'], 'invalid branch name'],
  [['start', 'feitan', '--verb', 'testing', '--branch', 'HEAD'], 'invalid branch name'],
  [['start', 'feitan', '--verb', 'testing', '--branch', 'refs/heads/main'], 'invalid branch name'],
  [['done', 'feitan', '--verb', 'testing'], 'flag not valid for this command'],
  [['done', 'feitan'], 'not working'],
  [['progress', 'feitan', '--verb', 'testing'], 'not working'],
  [['idle'], 'expected a command and exactly one member'],
  [['dance', 'feitan'], 'unknown command'],
  [['mission', 'start', 'Unknown Op'], 'mission not in missions.allow'],
  [['mission', 'start', 'Silk Lantern', '--tickets', '3/1000'], '--tickets must be N/M with 0 <= N <= M, 1 <= M <= 999'],
  [['mission', 'start', 'Silk Lantern', 'extra'], 'expected: hideout mission start|progress|done|retire <codename>'],
  [['mission', 'launch', 'Silk Lantern'], 'unknown command'],
  [['mission', 'progress', 'Silk Lantern'], 'mission progress needs --tickets'],
  [['mission', 'retire', 'acme merger'], 'invalid mission codename'],
  [['progress', 'feitan'], 'progress needs --verb and/or --progress'],
  [['start', 'feitan', '--verb', 'testing', '--repo='], '--repo needs a path'],
];

test('privacy guard: bad input exits 2 with the exact message, nothing is written', () => {
  const { bare, clones: [repo] } = makeRemote();
  const before = git(bare, 'rev-parse', BRANCH);
  for (const [args, msg] of PRIVACY_CASES) {
    const r = args.includes('--branch') ? run([...args, '--repo', repo])
      : args.some((a) => a.startsWith('--repo')) ? run([...args, '--branch', BRANCH]) : run(args, { repo });
    assert.equal(r.code, 2, `expected exit 2: ${JSON.stringify(args)} ${r.stderr}`);
    assert.equal(r.stderr.split('\n')[0], `hideout: ${msg}`, JSON.stringify(args));
    assert.equal(r.stdout, '');
  }
  assert.equal(git(bare, 'rev-parse', BRANCH), before, 'remote unchanged');
  assert.equal(git(repo, 'status', '--porcelain'), '', 'clone unchanged');
});

test('--dry-run prints the new JSON and commits nothing', () => {
  const { bare, clones: [repo] } = makeRemote();
  const before = git(bare, 'rev-parse', BRANCH);
  const r = run(['start', 'feitan', '--verb', 'interrogating', M, 'Silk Lantern', '--progress', '2/5', '--dry-run'], { repo });
  assert.equal(r.code, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.deepEqual(
    { ...doc.members.feitan, since: undefined, updatedAt: undefined },
    { state: 'working', verb: 'interrogating', mission: 'Silk Lantern', progress: { done: 2, total: 5 }, since: undefined, updatedAt: undefined },
  );
  assert.deepEqual(Object.keys(doc.events[0]).sort(), ['at', 'kind', 'mission', 'verb', 'who']);
  assert.equal(git(bare, 'rev-parse', BRANCH), before);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('start -> progress -> done -> idle: since, updatedAt and events', async () => {
  const { bare, clones: [repo] } = makeRemote();
  let r = run(['start', 'feitan', '--verb', 'interrogating', M, 'Silk Lantern'], { repo });
  assert.equal(r.code, 0, r.stderr);
  let feed = remoteFeed(bare);
  assert.equal(feed.members.feitan.state, 'working');
  const started = feed.members.feitan.since;
  assert.equal(feed.members.feitan.updatedAt, started);
  assert.equal(git(bare, 'log', '-1', '--format=%s', BRANCH), 'hideout: feitan start interrogating');
  await tick();

  r = run(['progress', 'feitan', '--progress', '3/5'], { repo });
  assert.equal(r.code, 0, r.stderr);
  feed = remoteFeed(bare);
  assert.deepEqual(feed.members.feitan.progress, { done: 3, total: 5 });
  assert.equal(feed.members.feitan.since, started, 'progress keeps since');
  assert.ok(feed.members.feitan.updatedAt > started, 'progress moves updatedAt');
  assert.deepEqual(feed.events.map((e) => e.kind), ['start'], 'a progress tick adds no event');
  await tick();

  r = run(['progress', 'feitan', '--verb', 'questioning'], { repo });
  assert.equal(r.code, 0, r.stderr);
  feed = remoteFeed(bare);
  assert.equal(feed.members.feitan.since, started);
  assert.deepEqual(feed.members.feitan.progress, { done: 3, total: 5 }, 'progress kept');
  assert.deepEqual(feed.events[0], { at: feed.updatedAt, who: 'feitan', kind: 'progress', verb: 'questioning', mission: 'Silk Lantern' });
  await tick();

  r = run(['start', 'feitan', '--verb', 'interrogating', M, 'Silk Lantern'], { repo });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(remoteFeed(bare).members.feitan.since, started, 'start while working keeps since');
  await tick();

  r = run(['done', 'feitan'], { repo });
  assert.equal(r.code, 0, r.stderr);
  feed = remoteFeed(bare);
  assert.equal(feed.members.feitan.state, 'done');
  assert.ok(feed.members.feitan.since > started, 'state change moves since');
  assert.equal(feed.members.feitan.updatedAt, feed.members.feitan.since);
  assert.equal(feed.members.feitan.verb, 'interrogating');
  assert.deepEqual(feed.events[0], { at: feed.updatedAt, who: 'feitan', kind: 'done', verb: 'interrogating', mission: 'Silk Lantern' });
  assert.equal(git(bare, 'log', '-1', '--format=%s', BRANCH), 'hideout: feitan done');

  // done again: no-op, exit 0, no commit
  const tip = git(bare, 'rev-parse', BRANCH);
  r = run(['done', 'feitan'], { repo });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /nothing to change/);
  assert.equal(git(bare, 'rev-parse', BRANCH), tip);

  // progress is only valid while working
  r = run(['progress', 'feitan', '--verb', 'testing'], { repo });
  assert.equal(r.code, 2);
  assert.equal(r.stderr.trim(), 'hideout: not working');
  await tick();

  r = run(['idle', 'feitan'], { repo });
  assert.equal(r.code, 0, r.stderr);
  feed = remoteFeed(bare);
  assert.deepEqual(Object.keys(feed.members.feitan), ['state', 'since', 'updatedAt']);
  assert.equal(feed.members.feitan.state, 'idle');
  assert.deepEqual(feed.events.map((e) => e.kind), ['done', 'start', 'progress', 'start'], 'idle adds no event');
  assert.ok(feed.events.every((e, i, a) => i === 0 || a[i - 1].at >= e.at), 'newest first');
  // idle while idle: no-op, exit 0, no commit
  const idleTip = git(bare, 'rev-parse', BRANCH);
  r = run(['idle', 'feitan'], { repo });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /nothing to change/);
  assert.equal(git(bare, 'rev-parse', BRANCH), idleTip);
  assert.notEqual(run(['done', 'feitan'], { repo }).code, 0, 'done needs working');
});

test('mission start/progress/done use who chrollo', () => {
  const { bare, clones: [repo] } = makeRemote();
  assert.equal(run(['mission', 'start', 'Silk Lantern', '--tickets', '0/12'], { repo }).code, 0);
  assert.notEqual(run(['mission', 'start', 'Silk Lantern'], { repo }).code, 0, 'already active');
  assert.equal(run(['mission', 'progress', 'Silk Lantern', '--tickets', '4/12'], { repo }).code, 0);
  assert.equal(run(['mission', 'done', 'Silk Lantern', '--tickets=12/12'], { repo }).code, 0);
  const feed = remoteFeed(bare);
  assert.equal(feed.missions.length, 1);
  assert.equal(feed.missions[0].state, 'done');
  assert.ok(feed.missions[0].endedAt);
  assert.deepEqual(feed.missions[0].tickets, { done: 12, total: 12 });
  assert.deepEqual(feed.events.map((e) => [e.who, e.kind, e.mission]), [
    ['chrollo', 'mission-done', 'Silk Lantern'],
    ['chrollo', 'mission-progress', 'Silk Lantern'],
    ['chrollo', 'mission-start', 'Silk Lantern'],
  ]);
  assert.equal(git(bare, 'log', '-1', '--format=%s', BRANCH), 'hideout: mission done Silk Lantern');
  assert.notEqual(run(['mission', 'progress', 'Silk Lantern', '--tickets', '1/2'], { repo }).code, 0, 'not active');
});

test('mission retire removes every trace of a finished mission', () => {
  const { bare, clones: [repo] } = makeRemote();
  assert.equal(run(['mission', 'start', 'Blue Moth'], { repo }).code, 0);
  assert.equal(run(['mission', 'start', 'Silk Lantern'], { repo }).code, 0);
  assert.equal(run(['start', 'feitan', '--verb', 'testing', M, 'Blue Moth'], { repo }).code, 0);
  assert.equal(run(['start', 'machi', '--verb', 'stitching', M, 'Silk Lantern'], { repo }).code, 0);
  let r = run(['mission', 'retire', 'Blue Moth'], { repo });
  assert.equal(r.code, 2);
  assert.equal(r.stderr.trim(), 'hideout: mission is active; run mission done first');
  assert.equal(run(['mission', 'done', 'Blue Moth'], { repo }).code, 0);
  r = run(['mission', 'retire', 'Blue Moth'], { repo });
  assert.equal(r.code, 0, r.stderr);
  const feed = remoteFeed(bare);
  assert.equal(git(bare, 'log', '-1', '--format=%s', BRANCH), 'hideout: mission retire Blue Moth');
  assert.ok(!JSON.stringify(feed).includes('Blue Moth'), 'no trace left');
  assert.deepEqual(feed.missions.map((x) => x.codename), ['Silk Lantern']);
  assert.equal(feed.members.feitan.state, 'working');
  assert.equal(feed.members.feitan.mission, undefined);
  assert.equal(feed.members.feitan.updatedAt, feed.updatedAt, 'retire touches updatedAt of changed members');
  assert.equal(feed.members.machi.mission, 'Silk Lantern');
  assert.ok(feed.events.some((e) => e.mission === 'Silk Lantern'));
  // retiring again is a no-op
  const tip = git(bare, 'rev-parse', BRANCH);
  assert.equal(run(['mission', 'retire', 'Blue Moth'], { repo }).code, 0);
  assert.equal(git(bare, 'rev-parse', BRANCH), tip);
});

test('events are capped at 20, newest first', () => {
  const { bare, clones: [repo] } = makeRemote();
  for (let i = 1; i <= 23; i++) {
    const r = run(['start', 'machi', '--verb', 'stitching', '--progress', `${i}/23`], { repo });
    assert.equal(r.code, 0, r.stderr);
  }
  const feed = remoteFeed(bare);
  assert.equal(feed.events.length, 20);
  assert.equal(feed.members.machi.progress.done, 23);
  assert.ok(feed.events.every((e, i, a) => i === 0 || a[i - 1].at >= e.at));
});

test('refuses a dirty working tree, the wrong branch, and unpushed local commits', () => {
  const { bare, clones: [repo] } = makeRemote();
  const before = git(bare, 'rev-parse', BRANCH);

  fs.appendFileSync(path.join(repo, 'missions.allow'), 'Blue Moth\n');
  let r = run(['start', 'feitan', '--verb', 'testing'], { repo });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /uncommitted/);
  git(repo, 'checkout', '--', 'missions.allow');

  git(repo, 'checkout', '--quiet', '-b', 'other');
  r = run(['start', 'feitan', '--verb', 'testing'], { repo });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /not on branch/);
  git(repo, 'checkout', '--quiet', BRANCH);

  fs.writeFileSync(path.join(repo, 'stray.txt'), 'x');
  git(repo, 'add', 'stray.txt');
  git(repo, 'commit', '--quiet', '-m', 'stray');
  r = run(['start', 'feitan', '--verb', 'testing'], { repo });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /not on origin/);
  assert.equal(git(bare, 'rev-parse', BRANCH), before);
});

test('the allowlist on the remote tip is what counts', () => {
  const { clones: [a, b] } = makeRemote(2, { missions: 'Silk Lantern\n' });
  // b adds a codename (as Chrollo would) and pushes it.
  fs.appendFileSync(path.join(b, 'missions.allow'), 'Blue Moth\n');
  git(b, 'commit', '--quiet', '-am', 'add mission');
  git(b, 'push', '--quiet', 'origin', BRANCH);
  // a is stale but fetches first, so the new codename is accepted.
  const r = run(['start', 'feitan', '--verb', 'testing', M, 'Blue Moth'], { repo: a });
  assert.equal(r.code, 0, r.stderr);
});

/**
 * A `git` wrapper on PATH that, when the tool pushes, first lets clone `other`
 * win the race by running the tool there (once, or on every push).
 */
function raceEnv(other, mode) {
  const dir = tmpdir();
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const wrapper = path.join(dir, 'git');
  fs.writeFileSync(wrapper, `#!/bin/sh
for a in "$@"; do
  if [ "$a" = push ]; then
    if [ "${mode}" = always ] || [ ! -e "${dir}/raced" ]; then
      touch "${dir}/raced"
      PATH="$REAL_PATH" "${process.execPath}" "${TOOL}" start phinks --verb wiring --repo "${other}" --branch ${BRANCH} >/dev/null 2>&1 || exit 97
    fi
    break
  fi
done
exec "${realGit}" "$@"
`, { mode: 0o755 });
  return { PATH: `${dir}:${process.env.PATH}`, REAL_PATH: process.env.PATH, HIDEOUT_RETRY_BASE_MS: '10' };
}

test('concurrency: two clones race, the loser retries on the fresh tip, no lost update', () => {
  const { bare, clones: [a, b] } = makeRemote(2);
  const r = run(['start', 'feitan', '--verb', 'interrogating'], { repo: a, env: raceEnv(b, 'once') });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /push rejected, retrying/, 'a retry really happened');
  assert.match(r.stderr, /after 1 retry/);
  const feed = remoteFeed(bare);
  assert.equal(feed.members.feitan.state, 'working');
  assert.equal(feed.members.phinks.state, 'working', 'no lost update');
  assert.deepEqual(feed.events.map((e) => e.who), ['feitan', 'phinks']);
  const log = git(bare, 'log', '--format=%s', BRANCH).split('\n');
  assert.deepEqual(log.slice(0, 2), ['hideout: feitan start interrogating', 'hideout: phinks start wiring']);
  assert.equal(git(bare, 'rev-list', '--merges', '--count', BRANCH), '0', 'linear history');
});

test('retry exhaustion: gives up after 10 retries, writes nothing, leaves the clone clean', () => {
  const { bare, clones: [a, b] } = makeRemote(2);
  const r = run(['start', 'feitan', '--verb', 'interrogating'], { repo: a, env: raceEnv(b, 'always') });
  assert.equal(r.code, 1);
  assert.equal((r.stderr.match(/push rejected, retrying/g) ?? []).length, 10);
  assert.match(r.stderr, /still rejected after 10 retries/);
  assert.equal(remoteFeed(bare).members.feitan.state, 'idle');
  assert.equal(git(a, 'status', '--porcelain'), '');
  assert.equal(git(a, 'rev-parse', 'HEAD'), git(a, 'rev-parse', `origin/${BRANCH}`));
});

test('a non-race rejection (server hook, branch protection) fails fast', () => {
  const { bare, clones: [repo] } = makeRemote();
  const hook = path.join(bare, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\necho "protected branch" >&2\nexit 1\n', { mode: 0o755 });
  const tip = git(bare, 'rev-parse', BRANCH);
  const r = run(['start', 'feitan', '--verb', 'testing'], { repo });
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.stderr, /retrying/);
  assert.match(r.stderr, /branch protection/);
  assert.equal(git(bare, 'rev-parse', BRANCH), tip);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('refuses a non-canonical status.json on the remote (duplicate keys)', () => {
  const { bare, clones: [a, b] } = makeRemote(2);
  const file = path.join(b, 'status.json');
  const raw = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, raw.replace('"version": 1,', '"version": 1,\n  "version": 1,'));
  git(b, 'commit', '--quiet', '-am', 'hand edit');
  git(b, 'push', '--quiet', 'origin', BRANCH);
  const tip = git(bare, 'rev-parse', BRANCH);
  const r = run(['start', 'feitan', '--verb', 'testing'], { repo: a });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not in canonical form/);
  assert.equal(git(bare, 'rev-parse', BRANCH), tip);
});

test('concurrency: two clones racing in parallel both land every update', async () => {
  const { bare, clones: [a, b] } = makeRemote(2);
  const rounds = 4;
  const verbsA = ['testing', 'building', 'fixing', 'wiring'];
  const verbsB = ['stitching', 'sketching', 'planning', 'reading'];
  for (let i = 0; i < rounds; i++) {
    const [ra, rb] = await Promise.all([
      runAsync(['start', 'feitan', '--verb', verbsA[i]], { repo: a }),
      runAsync(['start', 'machi', '--verb', verbsB[i]], { repo: b }),
    ]);
    assert.equal(ra.code, 0, ra.stderr);
    assert.equal(rb.code, 0, rb.stderr);
  }
  const feed = remoteFeed(bare);
  assert.equal(feed.members.feitan.verb, 'wiring');
  assert.equal(feed.members.machi.verb, 'reading');
  assert.equal(feed.events.length, rounds * 2, 'every update kept');
  assert.equal(Number(git(bare, 'rev-list', '--count', BRANCH)), 1 + rounds * 2);
  assert.equal(git(bare, 'rev-list', '--merges', '--count', BRANCH), '0');
});

test('mission retire repairs a feed whose codename was removed from missions.allow first', () => {
  const { bare, clones: [a, b] } = makeRemote(2);
  assert.equal(run(['mission', 'start', 'Blue Moth'], { repo: a }).code, 0);
  assert.equal(run(['start', 'feitan', '--verb', 'testing', M, 'Blue Moth'], { repo: a }).code, 0);
  // Chrollo removes the line too early (mission still active and referenced).
  fs.writeFileSync(path.join(b, 'missions.allow'), 'Silk Lantern\n');
  git(b, 'pull', '--quiet', 'origin', BRANCH);
  git(b, 'commit', '--quiet', '-am', 'drop Blue Moth');
  git(b, 'push', '--quiet', 'origin', BRANCH);
  let r = run(['start', 'machi', '--verb', 'stitching'], { repo: a });
  assert.equal(r.code, 1, 'feed is stuck until retired');
  assert.match(r.stderr, /current status.json is invalid/);
  r = run(['mission', 'retire', 'Blue Moth'], { repo: a });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!JSON.stringify(remoteFeed(bare)).includes('Blue Moth'));
  assert.equal(run(['start', 'machi', '--verb', 'stitching'], { repo: a }).code, 0, 'feed works again');
});

test('mission retire of a codename the feed never named is a no-op and never reaches git', () => {
  const { bare, clones: [repo] } = makeRemote();
  const tip = git(bare, 'rev-parse', BRANCH);
  const r = run(['mission', 'retire', 'Acme Merger'], { repo });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /nothing to change/);
  assert.equal(git(bare, 'rev-parse', BRANCH), tip);
  assert.ok(!git(bare, 'log', '--all', '--format=%B').includes('Acme'));
});

test('git failures say why', () => {
  const { clones: [repo] } = makeRemote();
  git(repo, 'remote', 'set-url', 'origin', path.join(tmpdir(), 'missing.git'));
  const r = run(['start', 'feitan', '--verb', 'testing'], { repo });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^hideout: git fetch failed: .+/m);
  assert.doesNotMatch(r.stderr, /Command failed/);
});

test('feed commits use a fixed identity and UTC dates, never the caller\'s', () => {
  const { bare, clones: [repo] } = makeRemote();
  git(repo, 'config', 'user.name', 'Real Person');
  git(repo, 'config', 'user.email', 'real.person@home.example');
  const r = run(['start', 'phinks', '--verb', 'fixing'], { repo, env: { TZ: 'Asia/Tokyo' } });
  assert.equal(r.code, 0, r.stderr);
  const meta = git(bare, 'log', '-1', '--format=%an <%ae> %ad|%cn <%ce> %cd|%G?', '--date=raw', BRANCH);
  assert.match(meta, /^hideout <hideout@noreply\.invalid> \d+ \+0000\|hideout <hideout@noreply\.invalid> \d+ \+0000\|N$/);
  assert.doesNotMatch(git(bare, 'log', '-1', '--format=%B%an%ae%cn%ce', BRANCH), /Real|real\.person/);
});

test('hook text that mimics a race does not cause retries', () => {
  const { bare, clones: [repo] } = makeRemote();
  fs.writeFileSync(path.join(bare, 'hooks', 'pre-receive'),
    '#!/bin/sh\necho "failed to update ref: policy" >&2\necho " ! [rejected] x -> y (fetch first)" >&2\nexit 1\n', { mode: 0o755 });
  const r = run(['start', 'feitan', '--verb', 'testing'], { repo });
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.stderr, /retrying/);
  assert.match(r.stderr, /branch protection/);
});

test('GIT_* variables from the caller cannot redirect the tool', () => {
  const { bare, clones: [repo, other] } = makeRemote(2);
  const otherTip = git(other, 'rev-parse', 'HEAD');
  const r = run(['start', 'feitan', '--verb', 'testing'], {
    repo, env: { GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other, GIT_INDEX_FILE: path.join(other, '.git', 'index') },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(remoteFeed(bare).members.feitan.state, 'working');
  assert.equal(git(other, 'rev-parse', 'HEAD'), otherTip, 'the other clone was not touched');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), git(bare, 'rev-parse', BRANCH));
});

test('a git filter that would change the pushed bytes is refused', () => {
  const { bare, clones: [repo, b] } = makeRemote(2);
  fs.writeFileSync(path.join(b, '.gitattributes'), 'status.json filter=shout\n');
  git(b, 'add', '.gitattributes');
  git(b, 'commit', '--quiet', '-m', 'attrs');
  git(b, 'push', '--quiet', 'origin', BRANCH);
  git(repo, 'config', 'filter.shout.clean', 'tr a-z A-Z');
  const tip = git(bare, 'rev-parse', BRANCH);
  const r = run(['start', 'feitan', '--verb', 'testing'], { repo });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /git attributes \(filter\)/);
  assert.equal(git(bare, 'rev-parse', BRANCH), tip);
  // nothing was written: the file is still the committed blob
  // (git status would report it modified only because of the filter itself)
  assert.equal(fs.readFileSync(path.join(repo, 'status.json'), 'utf8'), `${git(repo, 'show', 'HEAD:status.json')}\n`);
});

test('the committed blob must equal the validated bytes (filter set only in config)', () => {
  const { bare, clones: [repo] } = makeRemote();
  // An info/attributes file is local-only; check-attr sees it, so the tool refuses up front.
  fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), 'status.json eol=crlf\n');
  const tip = git(bare, 'rev-parse', BRANCH);
  const r = run(['start', 'feitan', '--verb', 'testing'], { repo });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /git attributes/);
  assert.equal(git(bare, 'rev-parse', BRANCH), tip);
});

test('status.json is written atomically and no temp file is left behind', () => {
  const { clones: [repo] } = makeRemote();
  assert.equal(run(['start', 'feitan', '--verb', 'testing'], { repo }).code, 0);
  assert.deepEqual(fs.readdirSync(repo).filter((f) => f.includes('.tmp')), []);
});

const dropAllow = (clone, text) => {
  git(clone, 'pull', '--quiet', 'origin', BRANCH);
  fs.writeFileSync(path.join(clone, 'missions.allow'), text);
  git(clone, 'commit', '--quiet', '-am', 'edit missions.allow');
  git(clone, 'push', '--quiet', 'origin', BRANCH);
};

test('two codenames removed early can both be retired in turn', () => {
  const { bare, clones: [a, b] } = makeRemote(2);
  for (const m of ['Silk Lantern', 'Blue Moth']) {
    assert.equal(run(['mission', 'start', m], { repo: a }).code, 0);
    assert.equal(run(['mission', 'done', m], { repo: a }).code, 0);
  }
  assert.equal(run(['start', 'feitan', '--verb', 'testing', M, 'Silk Lantern'], { repo: a }).code, 0);
  dropAllow(b, 'Other One\n');
  for (const m of ['Blue Moth', 'Silk Lantern']) {
    const r = run(['mission', 'retire', m], { repo: a });
    assert.equal(r.code, 0, r.stderr);
  }
  assert.doesNotMatch(JSON.stringify(remoteFeed(bare)), /Blue Moth|Silk Lantern/);
  git(b, 'pull', '--quiet', 'origin', BRANCH);
  assert.deepEqual(require('../bin/check.js').check(b), []);
});

test('retire of a stale codename that is still an active mission', () => {
  const { bare, clones: [a, b] } = makeRemote(2);
  assert.equal(run(['mission', 'start', 'Blue Moth'], { repo: a }).code, 0);
  dropAllow(b, 'Silk Lantern\n');
  const r = run(['mission', 'retire', 'Blue Moth'], { repo: a });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(remoteFeed(bare).missions, []);
  git(b, 'pull', '--quiet', 'origin', BRANCH);
  assert.deepEqual(require('../bin/check.js').check(b), []);
  // Still refused while the codename is allowed.
  assert.equal(run(['mission', 'start', 'Silk Lantern'], { repo: a }).code, 0);
  const r2 = run(['mission', 'retire', 'Silk Lantern'], { repo: a });
  assert.equal(r2.code, 2);
  assert.match(r2.stderr, /mission is active; run mission done first/);
});

test('retire of an allowed codename does not write over a feed that fails check.js', () => {
  const { bare, clones: [a, b] } = makeRemote(2);
  for (const m of ['Silk Lantern', 'Blue Moth']) {
    assert.equal(run(['mission', 'start', m], { repo: a }).code, 0);
    assert.equal(run(['mission', 'done', m], { repo: a }).code, 0);
  }
  dropAllow(b, 'Silk Lantern\n'); // Blue Moth is now stale in the feed
  const before = git(bare, 'rev-parse', BRANCH);
  const r = run(['mission', 'retire', 'Silk Lantern'], { repo: a });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /current status.json is invalid/);
  assert.equal(git(bare, 'rev-parse', BRANCH), before, 'nothing pushed');
  // Retiring the stale one first still works, then the allowed one.
  assert.equal(run(['mission', 'retire', 'Blue Moth'], { repo: a }).code, 0);
  assert.equal(run(['mission', 'retire', 'Silk Lantern'], { repo: a }).code, 0);
});

test('core.autocrlf=true in the clone does not break runs after a fast-forward', () => {
  const { bare, clones: [a, b] } = makeRemote(2);
  git(a, 'config', 'core.autocrlf', 'true');
  assert.equal(run(['start', 'feitan', '--verb', 'testing'], { repo: b }).code, 0);
  let r = run(['start', 'machi', '--verb', 'stitching'], { repo: a });
  assert.equal(r.code, 0, r.stderr);
  r = run(['idle', 'machi'], { repo: a });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!git(bare, 'show', `${BRANCH}:status.json`).includes('\r'));
});

test('a stale temp file with the same pid does not block a run, and the file mode is kept', () => {
  const { clones: [repo] } = makeRemote();
  fs.writeFileSync(path.join(repo, `.status.json.${process.pid}.tmp`), 'junk');
  fs.chmodSync(path.join(repo, 'status.json'), 0o600);
  const r = run(['start', 'feitan', '--verb', 'testing'], { repo });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.statSync(path.join(repo, 'status.json')).mode & 0o777, 0o600);
});

test('unpushed local commits: the message carries a recovery hint', () => {
  const { clones: [repo] } = makeRemote();
  fs.writeFileSync(path.join(repo, 'stray.txt'), 'x');
  git(repo, 'add', 'stray.txt');
  git(repo, 'commit', '--quiet', '-m', 'stray');
  const r = run(['start', 'feitan', '--verb', 'testing'], { repo });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, `hideout: local ${BRANCH} has commits not on origin; refusing (would push them) ` +
    `(inspect with git log origin/${BRANCH}..HEAD; git reset --hard origin/${BRANCH} if it is only a leftover hideout commit)\n`);
});

test('caller GIT_AUTHOR/COMMITTER identity and non-UTC dates never reach the feed commit', () => {
  const { bare, clones: [repo] } = makeRemote();
  const env = {
    GIT_AUTHOR_NAME: 'Chrollo', GIT_AUTHOR_EMAIL: 'kaito9814@gmail.com',
    GIT_COMMITTER_NAME: 'Chrollo', GIT_COMMITTER_EMAIL: 'kaito9814@gmail.com',
    GIT_AUTHOR_DATE: '1700000000 +0900', GIT_COMMITTER_DATE: '1700000000 -0500',
  };
  const r = run(['start', 'phinks', '--verb', 'fixing'], { repo, env });
  assert.equal(r.code, 0, r.stderr);
  const meta = git(bare, 'log', '-1', '--format=%an <%ae> %ad|%cn <%ce> %cd', '--date=raw', BRANCH);
  assert.match(meta, /^hideout <hideout@noreply\.invalid> \d+ \+0000\|hideout <hideout@noreply\.invalid> \d+ \+0000$/);
  assert.doesNotMatch(meta, /1700000000/);
});

test('a run killed after its write (dirty status.json) does not brick the clone', () => {
  const { bare, clones: [repo] } = makeRemote();
  fs.writeFileSync(path.join(repo, 'status.json'), '{"half": "written"}\n');
  const r = run(['start', 'feitan', '--verb', 'testing'], { repo });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /restoring status.json left changed by an interrupted run/);
  assert.equal(remoteFeed(bare).members.feitan.verb, 'testing');
});

test('a run killed after its commit (unpushed feed commit) does not brick the clone', () => {
  const { bare, clones: [a, b] } = makeRemote(2);
  // Leave a feed-identity commit in `a` that never reached origin, then move origin on.
  fs.writeFileSync(path.join(a, 'status.json'),
    run(['start', 'machi', '--verb', 'reading', '--dry-run'], { repo: a }).stdout);
  execFileSync('git', ['-C', a, 'commit', '--quiet', '-am', 'hideout: machi start reading'], {
    env: { ...process.env, GIT_AUTHOR_NAME: 'hideout', GIT_AUTHOR_EMAIL: 'hideout@noreply.invalid',
      GIT_COMMITTER_NAME: 'hideout', GIT_COMMITTER_EMAIL: 'hideout@noreply.invalid' },
  });
  assert.equal(run(['start', 'phinks', '--verb', 'wiring'], { repo: b }).code, 0);
  const r = run(['start', 'feitan', '--verb', 'testing'], { repo: a });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /dropping an unpushed hideout commit/);
  const feed = remoteFeed(bare);
  assert.equal(feed.members.phinks.verb, 'wiring');
  assert.equal(feed.members.feitan.verb, 'testing');
  assert.equal(feed.members.machi.verb, undefined, 'the dropped commit was never pushed');
});

test('a stalled git call times out instead of hanging the session', () => {
  const { clones: [repo] } = makeRemote();
  const hang = path.join(repo, '..', 'hang.sh');
  fs.writeFileSync(hang, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  git(repo, 'config', 'remote.origin.uploadpack', hang);
  const t0 = Date.now();
  const r = run(['start', 'feitan', '--verb', 'testing'], { repo, env: { HIDEOUT_GIT_TIMEOUT_MS: '1500' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /git fetch failed: timed out/);
  assert.ok(Date.now() - t0 < 15000, 'returned long before the stalled command would have');
});
