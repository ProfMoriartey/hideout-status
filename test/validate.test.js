'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const V = require('../lib/validate');
const { check } = require('../bin/check');
const H = require('../lib/hideout');
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
  const memberProps = schema.properties.members.additionalProperties.properties;
  assert.deepEqual([...V.MEMBER_STATES], memberProps.state.enum);
  assert.deepEqual(Object.keys(memberProps).sort(), ['mission', 'progress', 'since', 'state', 'updatedAt', 'verb']);
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

test('timestamps must be real calendar dates', () => {
  assert.ok(V.isTime('2026-02-28T23:59:59.999Z'));
  assert.ok(V.isTime('2028-02-29T00:00:00Z'));
  for (const t of ['2026-02-31T00:00:00Z', '2026-02-29T00:00:00Z', '2026-13-01T00:00:00Z',
    '2026-01-01T24:00:00Z', '2026-01-01T00:60:00Z', '2026-01-01T00:00:60Z', '2026-01-01 00:00:00Z']) {
    assert.equal(V.isTime(t), false, t);
  }
});

test('duplicates are rejected: allowlist entries and mission codenames in the feed', () => {
  assert.notDeepEqual(V.checkAllowlist({ members: ['feitan', 'feitan'], verbs: ['testing'] }), []);
  assert.notDeepEqual(V.checkAllowlist({ members: ['feitan'], verbs: ['testing', 'testing'] }), []);
  const d = freshFeed();
  const m = { codename: 'Silk Lantern', state: 'done', startedAt: d.updatedAt };
  d.missions = [m, { ...m }];
  assert.ok(V.validateStatus(d, lists).some((e) => /duplicate codename/.test(e)));
});

test('canonical bytes: CI rejects duplicate keys and any non-canonical layout', () => {
  const feed = freshFeed();
  const good = V.serialize(feed);
  assert.deepEqual(V.parseStatus(good), feed);
  const variants = [
    good.replace('"version": 1,', '"version": 1,\n  "version": 1,'),
    good.replace('"version": 1,', '"note": "ACMEMERGER",\n  "version": 1,').replace('"note": "ACMEMERGER",\n  "version": 1,', '"version": 1,\n  "version": 1,'),
    good.trimEnd(),
    `${good}\n`,
    JSON.stringify(feed),
    good.replace(/\n/g, '\r\n'),
    `﻿${good}`,
  ];
  for (const raw of variants) {
    assert.throws(() => V.parseStatus(raw), /canonical|not valid JSON/);
    const dir = tmpdir();
    writeContract(dir);
    fs.writeFileSync(path.join(dir, 'status.json'), raw);
    const errs = check(dir);
    assert.notDeepEqual(errs, []);
    assert.ok(!errs.join(' ').includes('ACMEMERGER'));
  }
  // a duplicate key hiding free text: parses to a valid feed, still refused
  const sneaky = good.replace('"version": 1,', '"version": "ACMEMERGER plans",\n  "version": 1,');
  assert.deepEqual(V.validateStatus(JSON.parse(sneaky), lists), []);
  assert.throws(() => V.parseStatus(sneaky), /canonical/);
});

test('symlinked or non-regular allowlist files are refused', () => {
  for (const rel of ['missions.allow', 'schema/allowlist.json', 'schema']) {
    const dir = tmpdir();
    writeContract(dir);
    const outside = path.join(tmpdir(), 'outside');
    fs.renameSync(path.join(dir, rel), outside);
    fs.symlinkSync(outside, path.join(dir, rel));
    assert.notDeepEqual(check(dir), [], rel);
  }
  const dir = tmpdir();
  writeContract(dir);
  fs.rmSync(path.join(dir, 'missions.allow'));
  fs.mkdirSync(path.join(dir, 'missions.allow'));
  assert.notDeepEqual(check(dir), []);
});

test('mission list: 10 max, drops the oldest finished one, refuses an 11th active', () => {
  const names = ['Ant', 'Bee', 'Cat', 'Dog', 'Elk', 'Fox', 'Gnu', 'Hen', 'Ibis', 'Jay', 'Kit'];
  const big = { ...lists, missions: names };
  const t = (n) => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;
  let d = freshFeed();
  d.missions = names.slice(0, 10).map((c, i) => ({ codename: c, state: 'done', startedAt: t(i), endedAt: t(30 - i) }));
  d = H.applyOp(d, { command: 'mission start', target: 'Kit' }, t(50));
  assert.equal(d.missions.length, 10);
  assert.ok(!d.missions.some((x) => x.codename === 'Jay'), 'Jay ended earliest and is dropped');
  assert.deepEqual(V.validateStatus(d, big), []);

  const all = freshFeed();
  all.missions = names.slice(0, 10).map((c, i) => ({ codename: c, state: 'active', startedAt: t(i) }));
  assert.throws(() => H.applyOp(all, { command: 'mission start', target: 'Kit' }, t(50)), /already 10 active missions/);
});

test('push classification and backoff budget', () => {
  assert.equal(H.classifyPush(' ! [rejected]        main -> main (fetch first)'), 'race');
  assert.equal(H.classifyPush(' ! [rejected]        main -> main (non-fast-forward)'), 'race');
  assert.equal(H.classifyPush(" ! [remote rejected] main -> main (cannot lock ref 'refs/heads/main')"), 'race');
  assert.equal(H.classifyPush(' ! [remote rejected] main -> main (failed to update ref)'), 'race');
  assert.equal(H.classifyPush(' ! [remote rejected] main -> main (protected branch hook declined)'), 'fatal');
  assert.equal(H.classifyPush(' ! [remote rejected] main -> main (pre-receive hook declined)'), 'fatal');
  assert.equal(H.classifyPush('fatal: unable to access: Could not resolve host'), 'fatal');
  assert.equal(H.MAX_RETRIES, 10);
  for (let a = 0; a <= H.MAX_RETRIES; a++) {
    for (let i = 0; i < 50; i++) {
      const w = H.backoffMs(a);
      assert.ok(w >= 0 && w <= 5000 && w <= 400 * 2 ** a, `attempt ${a}: ${w}`);
    }
  }
});
