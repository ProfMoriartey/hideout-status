'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BRANCH, git, makeRemote, remoteFeed, run, runAsync } = require('./helpers');

const M = '--mission';

test('privacy guard: bad input is rejected, nothing is written', () => {
  const { bare, clones: [repo] } = makeRemote();
  const before = git(bare, 'rev-parse', BRANCH);
  const bad = [
    ['start', 'feitan', '--verb', 'hacking the mainframe'],
    ['start', 'feitan', '--verb', 'hacking'],
    ['start', 'feitan', '--verb', 'Testing'],
    ['start', 'feitan'],
    ['start', 'hisoka', '--verb', 'testing'],
    ['start', 'Feitan', '--verb', 'testing'],
    ['start', 'feitan', '--verb', 'testing', M, 'Secret Op'],
    ['start', 'feitan', '--verb', 'testing', M, 'silk lantern'],
    ['start', 'feitan', '--verb', 'testing', M, 'Silk Lantern Rising Now'],
    ['start', 'feitan', '--verb', 'testing', '--progress', '6/5'],
    ['start', 'feitan', '--verb', 'testing', '--progress', '1/1000'],
    ['start', 'feitan', '--verb', 'testing', '--progress', '99999/99999'],
    ['start', 'feitan', '--verb', 'testing', 'extra'],
    ['start', 'feitan', '--verb', 'testing', '--note', 'hi'],
    ['start', 'feitan', '--verb', 'testing', '--verb', 'building'],
    ['start', 'feitan', '--verb', 'testing', '--tickets', '1/2'],
    ['start', 'feitan', '--verb', 'testing', '-x'],
    ['start', 'feitan', '--verb', 'testing; rm -rf /'],
    ['start', 'feitan', '--verb', '$(whoami)'],
    ['start', 'feitan', '--verb', 'testing\nSigned-off-by: x'],
    ['start', 'feitan', '--verb', 'testing', M, 'Silk Lantern"}'],
    ['start', '../feitan', '--verb', 'testing'],
    ['start', '__proto__', '--verb', 'testing'],
    ['start', 'feitan', '--verb', 'constructor'],
    ['start', 'feitan', '--verb', 'testing', '--branch', '--force'],
    ['start', 'feitan', '--verb', 'testing', '--branch', '../../x'],
    ['done', 'feitan', '--verb', 'testing'],
    ['idle'],
    ['dance', 'feitan'],
    ['mission', 'start', 'Unknown Op'],
    ['mission', 'start', 'Silk Lantern', '--tickets', '3/1000'],
    ['mission', 'start', 'Silk Lantern', 'extra'],
    ['mission', 'launch', 'Silk Lantern'],
    ['mission', 'progress', 'Silk Lantern'],
    ['progress', 'feitan'],
  ];
  for (const args of bad) {
    const r = run(args, { repo });
    assert.notEqual(r.code, 0, `expected rejection: ${JSON.stringify(args)}`);
    assert.match(r.stderr, /^hideout: /, JSON.stringify(args));
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
    { ...doc.members.feitan, since: undefined },
    { state: 'working', verb: 'interrogating', mission: 'Silk Lantern', progress: { done: 2, total: 5 }, since: undefined },
  );
  assert.deepEqual(Object.keys(doc.events[0]).sort(), ['at', 'kind', 'mission', 'verb', 'who']);
  assert.equal(git(bare, 'rev-parse', BRANCH), before);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('start -> progress -> done -> idle transitions and events', () => {
  const { bare, clones: [repo] } = makeRemote();
  let r = run(['start', 'feitan', '--verb', 'interrogating', M, 'Silk Lantern'], { repo });
  assert.equal(r.code, 0, r.stderr);
  let feed = remoteFeed(bare);
  assert.equal(feed.members.feitan.state, 'working');
  const started = feed.members.feitan.since;
  assert.equal(git(bare, 'log', '-1', '--format=%s', BRANCH), 'hideout: feitan start interrogating');

  r = run(['progress', 'feitan', '--progress', '3/5'], { repo });
  assert.equal(r.code, 0, r.stderr);
  feed = remoteFeed(bare);
  assert.deepEqual(feed.members.feitan.progress, { done: 3, total: 5 });
  assert.equal(feed.members.feitan.since, started, 'progress keeps since');
  assert.equal(feed.events[0].kind, 'progress');

  r = run(['done', 'feitan'], { repo });
  assert.equal(r.code, 0, r.stderr);
  feed = remoteFeed(bare);
  assert.equal(feed.members.feitan.state, 'done');
  assert.equal(feed.members.feitan.verb, 'interrogating');
  assert.deepEqual(feed.events[0], { at: feed.updatedAt, who: 'feitan', kind: 'done', verb: 'interrogating', mission: 'Silk Lantern' });
  assert.equal(git(bare, 'log', '-1', '--format=%s', BRANCH), 'hideout: feitan done');

  // progress is only valid while working
  assert.notEqual(run(['progress', 'feitan', '--verb', 'testing'], { repo }).code, 0);

  r = run(['idle', 'feitan'], { repo });
  assert.equal(r.code, 0, r.stderr);
  feed = remoteFeed(bare);
  assert.deepEqual(Object.keys(feed.members.feitan).sort(), ['since', 'state']);
  assert.equal(feed.members.feitan.state, 'idle');
  assert.deepEqual(feed.events.map((e) => e.kind), ['done', 'progress', 'start'], 'idle adds no event');
  // newest first
  assert.ok(feed.events[0].at >= feed.events[1].at && feed.events[1].at >= feed.events[2].at);
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

test('concurrency: a push rejected mid-flight is re-applied on the fresh tip', () => {
  const { bare, clones: [a, b] } = makeRemote(2);
  // Clone a's pre-push hook makes clone b win the race once.
  const hook = path.join(a, '.git', 'hooks', 'pre-push');
  const marker = path.join(a, '.git', 'raced');
  fs.writeFileSync(hook, `#!/bin/sh
if [ ! -e "${marker}" ]; then
  touch "${marker}"
  "${process.execPath}" "${path.resolve(__dirname, '..', 'bin', 'hideout')}" start phinks --verb wiring --repo "${b}" --branch ${BRANCH} >/dev/null 2>&1 || exit 1
fi
exit 0
`, { mode: 0o755 });
  const r = run(['start', 'feitan', '--verb', 'interrogating'], { repo: a });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /push rejected, retrying/);
  const feed = remoteFeed(bare);
  assert.equal(feed.members.feitan.state, 'working');
  assert.equal(feed.members.phinks.state, 'working', 'no lost update');
  assert.deepEqual(feed.events.map((e) => e.who), ['feitan', 'phinks']);
  const log = git(bare, 'log', '--format=%s', BRANCH).split('\n');
  assert.deepEqual(log.slice(0, 2), ['hideout: feitan start interrogating', 'hideout: phinks start wiring']);
});

test('concurrency: two clones racing pushes both land', async () => {
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
  const commits = git(bare, 'rev-list', '--count', BRANCH);
  assert.equal(Number(commits), 1 + rounds * 2);
  // history is linear: no force-push, no merge commits
  assert.equal(git(bare, 'rev-list', '--merges', '--count', BRANCH), '0');
});
