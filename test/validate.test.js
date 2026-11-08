'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const V = require('../lib/validate');
const { check } = require('../bin/check');
const { ROOT, tmpdir, freshFeed, writeContract } = require('./helpers');

const lists = {
  members: [...V.MEMBER_IDS],
  verbs: ['interrogating', 'testing', 'building'],
  missions: ['Silk Lantern'],
};

test('validate.js constants match status.schema.json', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'status.schema.json'), 'utf8'));
  const d = schema.$defs;
  assert.deepEqual([...V.MEMBER_IDS], d.memberId.enum);
  assert.equal(V.TIME_RE.source, d.time.pattern);
  assert.equal(V.VERB_RE.source, d.verb.pattern);
  assert.equal(V.MISSION_RE.source, d.mission.pattern);
  assert.equal(V.COUNT_MAX, d.count.properties.total.maximum);
  assert.equal(V.MAX_EVENTS, schema.properties.events.maxItems);
  assert.equal(V.MAX_MISSIONS, schema.properties.missions.maxItems);
  assert.deepEqual([...V.EVENT_KINDS], schema.properties.events.items.properties.kind.enum);
  assert.deepEqual([...V.MEMBER_STATES], schema.properties.members.additionalProperties.properties.state.enum);
  const allow = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'allowlist.json'), 'utf8'));
  assert.deepEqual(allow.members, d.memberId.enum);
});

test('a fresh feed is valid', () => {
  assert.deepEqual(V.validateStatus(freshFeed(), lists), []);
});

test('the committed status.json and missions.allow pass the CI check', () => {
  assert.deepEqual(check(ROOT), []);
});

test('extra fields anywhere in status.json are rejected', () => {
  const cases = [
    (d) => { d.note = 'hello'; },
    (d) => { d.members.feitan.text = 'secret plans'; },
    (d) => { d.events.push({ at: d.updatedAt, who: 'feitan', kind: 'start', text: 'free text' }); },
    (d) => { d.missions.push({ codename: 'Silk Lantern', state: 'active', startedAt: d.updatedAt, owner: 'x' }); },
    (d) => { d.members.feitan.progress = { done: 1, total: 2, note: 'x' }; },
  ];
  for (const mutate of cases) {
    const d = freshFeed();
    mutate(d);
    assert.ok(V.validateStatus(d, lists).some((e) => /unexpected field|bad progress/.test(e)), String(mutate));
  }
});

test('values outside the allowlists are rejected', () => {
  const bad = [
    (d) => { d.members.hisoka = { state: 'idle', since: d.updatedAt }; },
    (d) => { d.members.feitan = { state: 'working', since: d.updatedAt, verb: 'hacking' }; },
    (d) => { d.members.feitan = { state: 'working', since: d.updatedAt, verb: 'testing', mission: 'Secret Op' }; },
    (d) => { d.members.feitan = { state: 'sleeping', since: d.updatedAt }; },
    (d) => { d.members.feitan = { state: 'idle', since: 'yesterday' }; },
    (d) => { d.version = 2; },
    (d) => { d.events = Array.from({ length: 21 }, () => ({ at: d.updatedAt, who: 'feitan', kind: 'start' })); },
    (d) => { d.members.feitan = { state: 'working', since: d.updatedAt, verb: 'testing', progress: { done: 6, total: 5 } }; },
    (d) => { d.members.feitan = { state: 'working', since: d.updatedAt, verb: 'testing', progress: { done: 1, total: 1000 } }; },
    (d) => { d.members.feitan = { state: 'working', since: d.updatedAt, verb: 'testing', progress: { done: 1.5, total: 2 } }; },
    (d) => { d.missions.push({ codename: 'silk lantern', state: 'active', startedAt: d.updatedAt }); },
  ];
  for (const mutate of bad) {
    const d = freshFeed();
    mutate(d);
    assert.notDeepEqual(V.validateStatus(d, lists), [], String(mutate));
  }
});

test('error messages never echo input values', () => {
  const d = freshFeed();
  d.members.feitan = { state: 'working', since: d.updatedAt, verb: 'leakedsecretword' };
  const errs = V.validateStatus(d, lists).join(' ');
  assert.ok(errs.length > 0);
  assert.ok(!errs.includes('leakedsecretword'));
});

test('parseCount accepts small N/M only', () => {
  assert.deepEqual(V.parseCount('2/5'), { done: 2, total: 5 });
  assert.deepEqual(V.parseCount('0/1'), { done: 0, total: 1 });
  assert.deepEqual(V.parseCount('999/999'), { done: 999, total: 999 });
  for (const s of ['6/5', '1/0', '0/0', '1/1000', '1000/1000', '-1/5', '1.0/5', ' 1/5', '1/5 ', '1/5\n', 'a/b', '1e2/999', '']) {
    assert.equal(V.parseCount(s), null, JSON.stringify(s));
  }
});

test('missions.allow lines must match the codename pattern', () => {
  assert.deepEqual(V.parseMissionsAllow('Silk Lantern\nBlue Moth Rising\n').errors, []);
  for (const bad of ['silk lantern\n', 'Silk  Lantern\n', 'Silk Lantern \n', 'One Two Three Four\n',
    'Silk-Lantern\n', 'Silk Lantern\r\n', 'X\n', '# comment\n', 'Silk Lantern\nSilk Lantern\n']) {
    assert.notDeepEqual(V.parseMissionsAllow(bad).errors, [], JSON.stringify(bad));
  }
});

test('check.js reports a bad missions.allow and an invalid status.json', () => {
  const dir = tmpdir();
  writeContract(dir, { missions: 'Silk Lantern\nnot ok\n' });
  assert.notDeepEqual(check(dir), []);
  const dir2 = tmpdir();
  const feed = freshFeed();
  feed.extra = true;
  writeContract(dir2, { feed });
  assert.notDeepEqual(check(dir2), []);
});
