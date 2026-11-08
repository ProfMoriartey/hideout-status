'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'bin', 'hideout');
const BRANCH = 'test-feed';

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hideout-test-')); }

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function identity(dir) {
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

/** A fresh feed with every allowlisted member idle. */
function freshFeed(now = '2026-01-01T00:00:00.000Z') {
  const ids = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'allowlist.json'), 'utf8')).members;
  const members = {};
  for (const id of ids) members[id] = { state: 'idle', since: now };
  return { version: 1, updatedAt: now, missions: [], members, events: [] };
}

/** Write the contract files (schema, allowlist, missions.allow, status.json) into dir. */
function writeContract(dir, { missions = 'Silk Lantern\nBlue Moth\n', feed = freshFeed() } = {}) {
  fs.mkdirSync(path.join(dir, 'schema'), { recursive: true });
  for (const f of ['allowlist.json', 'status.schema.json']) {
    fs.copyFileSync(path.join(ROOT, 'schema', f), path.join(dir, 'schema', f));
  }
  fs.writeFileSync(path.join(dir, 'missions.allow'), missions);
  fs.writeFileSync(path.join(dir, 'status.json'), `${JSON.stringify(feed, null, 2)}\n`);
}

/** Bare remote seeded on BRANCH, plus `n` clones on that branch. */
function makeRemote(n = 1, opts = {}) {
  const base = tmpdir();
  const bare = path.join(base, 'remote.git');
  git(base, 'init', '--quiet', '--bare', `--initial-branch=${BRANCH}`, bare);
  const seed = path.join(base, 'seed');
  git(base, 'init', '--quiet', `--initial-branch=${BRANCH}`, seed);
  identity(seed);
  writeContract(seed, opts);
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', bare);
  git(seed, 'push', '--quiet', 'origin', BRANCH);
  const clones = [];
  for (let i = 0; i < n; i++) {
    const c = path.join(base, `clone${i}`);
    git(base, 'clone', '--quiet', '--branch', BRANCH, bare, c);
    identity(c);
    clones.push(c);
  }
  return { base, bare, clones };
}

function remoteFeed(bare) {
  return JSON.parse(git(bare, 'show', `${BRANCH}:status.json`));
}

function run(args, { repo, env = {} } = {}) {
  const full = repo ? [...args, '--repo', repo, '--branch', BRANCH] : args;
  const r = spawnSync(process.execPath, [TOOL, ...full], {
    encoding: 'utf8', env: { ...process.env, HIDEOUT_REPO: '', ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function runAsync(args, { repo }) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [TOOL, ...args, '--repo', repo, '--branch', BRANCH], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

module.exports = { ROOT, TOOL, BRANCH, tmpdir, git, freshFeed, writeContract, makeRemote, remoteFeed, run, runAsync };
