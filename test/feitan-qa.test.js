'use strict';
// QA tests from Operation Silk Lantern (Feitan). Tests marked DEFECT encode
// current bugs and fail until they are fixed; the rest protect behaviour.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, BRANCH, git, tmpdir, writeContract, makeRemote, remoteFeed, run, runAsync } = require('./helpers');

const CHECK = path.join(ROOT, 'bin', 'check.js');
const SECRET = 'ACMEMERGER';

function check(dir) {
  const r = spawnSync(process.execPath, [CHECK, dir], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

/** Replace status.json on the remote with `write(seedDir)` via a hand commit. */
function handPush(bare, write) {
  const dir = path.join(tmpdir(), 'hand');
  git(os.tmpdir(), 'clone', '--quiet', '--branch', BRANCH, bare, dir);
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  write(dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'hand edit');
  git(dir, 'push', '--quiet', 'origin', BRANCH);
}

test('DEFECT: check.js does not echo content of a syntactically broken status.json', () => {
  const dir = tmpdir();
  writeContract(dir);
  fs.writeFileSync(path.join(dir, 'status.json'), `{"version":1, "x": ${SECRET} plans}`);
  const r = check(dir);
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.out, new RegExp(SECRET), 'error text leaks file content into CI logs');
});

test('DEFECT: hideout does not echo content of a broken remote status.json', () => {
  const { bare, clones: [repo] } = makeRemote();
  handPush(bare, (d) => fs.writeFileSync(path.join(d, 'status.json'), `{"version":1, "x": ${SECRET} plans}`));
  const r = run(['start', 'feitan', '--verb', 'testing'], { repo });
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.stderr, new RegExp(SECRET));
});

test('DEFECT: check.js rejects status.json that is a symlink', () => {
  const dir = tmpdir();
  writeContract(dir);
  const outside = path.join(tmpdir(), 'outside.json');
  fs.renameSync(path.join(dir, 'status.json'), outside);
  fs.symlinkSync(outside, path.join(dir, 'status.json'));
  assert.notEqual(check(dir).code, 0, 'a symlinked feed must fail CI');
});

test('DEFECT: hideout never writes through a symlinked status.json', () => {
  const { bare, clones: [repo] } = makeRemote();
  const outside = path.join(tmpdir(), 'outside.json');
  handPush(bare, (d) => {
    fs.copyFileSync(path.join(d, 'status.json'), outside);
    fs.rmSync(path.join(d, 'status.json'));
    fs.symlinkSync(outside, path.join(d, 'status.json'));
  });
  const before = fs.readFileSync(outside, 'utf8');
  const r = run(['start', 'feitan', '--verb', 'testing'], { repo });
  assert.notEqual(r.code, 0);
  assert.equal(fs.readFileSync(outside, 'utf8'), before, 'file outside the checkout was modified');
});

test('rejects tricky argv and leaves remote untouched', () => {
  const { bare, clones: [repo] } = makeRemote();
  const tip = git(bare, 'rev-parse', BRANCH);
  const bad = [
    ['start', 'feitan', '--verb', 'tеsting'], // Cyrillic e
    ['start', 'feitan', '--verb', 'testing', '--verb=fixing'],
    ['start', 'feitan', '--verb=testing', '--verb=testing'],
    ['start', 'feitan', '--verb'],
    ['start', 'feitan', '--verb', 'testing', '--progress', '0/0'],
    ['start', 'feitan', '--verb', 'testing', '--progress', '5/3'],
    ['start', 'feitan', '--verb', 'testing', '--progress', '-1/3'],
    ['start', 'feitan', '--verb', 'testing', '--progress', '99999999999999999999/1'],
    ['start', 'feitan', '--verb', 'testing', '--progress', '١/٢'],
    ['start', 'feitan', '--verb', 'testing', '--mission', 'Silk Lantern '],
    ['start', 'feitan', '--verb', 'testing', '--mission', 'Silk Lantern\n'],
    ['start', 'feitan', '--verb', 'testing', '--__proto__=1'],
    ['start', 'feitan', '--verb', 'testing', '--dry-run=1'],
    ['start', 'feitan', '--verb', 'testing', '--', 'x'],
    ['mission', 'start', 'Silk  Lantern'],
  ];
  for (const args of bad) {
    const r = run(args, { repo });
    assert.equal(r.code, 2, JSON.stringify(args));
  }
  assert.equal(git(bare, 'rev-parse', BRANCH), tip);
});

test('flags before the command and --verb=x are accepted', () => {
  const { bare, clones: [repo] } = makeRemote();
  assert.equal(run(['--verb=testing', 'start', 'feitan'], { repo }).code, 0);
  assert.equal(remoteFeed(bare).members.feitan.verb, 'testing');
});

test('refuses detached HEAD, dirty tree and an unreachable remote', () => {
  const { bare, clones: [repo] } = makeRemote();
  const tip = git(bare, 'rev-parse', BRANCH);
  git(repo, 'checkout', '--quiet', '--detach');
  assert.equal(run(['done', 'feitan'], { repo }).code, 1);
  git(repo, 'checkout', '--quiet', BRANCH);
  fs.appendFileSync(path.join(repo, 'missions.allow'), 'Blue Moth\n');
  assert.equal(run(['done', 'feitan'], { repo }).code, 1);
  git(repo, 'checkout', '--quiet', '--', 'missions.allow');
  git(repo, 'remote', 'set-url', 'origin', path.join(tmpdir(), 'missing.git'));
  assert.equal(run(['done', 'feitan'], { repo }).code, 1);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(git(bare, 'rev-parse', BRANCH), tip);
});

test('8 parallel updaters x 2 rounds: every update lands, feed stays valid', async () => {
  const members = ['feitan', 'phinks', 'machi', 'shalnark', 'nobunaga', 'franklin', 'shizuku', 'kalluto'];
  const { bare, clones } = makeRemote(members.length);
  const base = Number(git(bare, 'rev-list', '--count', BRANCH));
  for (let round = 1; round <= 2; round++) {
    const res = await Promise.all(members.map((m, i) =>
      runAsync(['start', m, '--verb', 'testing', '--progress', `${round}/2`], { repo: clones[i] })));
    for (const r of res) assert.equal(r.code, 0, r.stderr);
  }
  assert.equal(Number(git(bare, 'rev-list', '--count', BRANCH)) - base, 16);
  const feed = remoteFeed(bare);
  const dir = tmpdir();
  writeContract(dir, { feed });
  assert.equal(check(dir).code, 0);
  assert.equal(feed.events.length, 16);
  for (let i = 1; i < feed.events.length; i++) assert.ok(feed.events[i - 1].at >= feed.events[i].at, 'newest first');
  for (const m of members) assert.deepEqual(feed.members[m].progress, { done: 2, total: 2 });
});
