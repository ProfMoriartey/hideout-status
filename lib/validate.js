'use strict';
// Feed v1 validation: schema rules from schema/status.schema.json plus the
// allowlists (schema/allowlist.json, missions.allow). Zero dependencies.
// Used by bin/hideout (before every write) and bin/check.js (CI).

const fs = require('node:fs');
const path = require('node:path');

const MEMBER_IDS = Object.freeze([
  'chrollo', 'elders', 'pakunoda', 'shalnark', 'kortopi', 'phinks', 'feitan',
  'machi', 'nobunaga', 'franklin', 'shizuku', 'bonolenov', 'kalluto',
]);
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const VERB_RE = /^[a-z]{3,20}$/;
const MISSION_RE = /^[A-Z][a-z]+( [A-Z][a-z]+){0,2}$/;
const COUNT_RE = /^(\d{1,3})\/(\d{1,3})$/;
const COUNT_MAX = 999;
const MAX_EVENTS = 20;
const MAX_MISSIONS = 10;
const MEMBER_STATES = Object.freeze(['idle', 'working', 'done']);
const MISSION_STATES = Object.freeze(['active', 'done']);
const EVENT_KINDS = Object.freeze([
  'start', 'progress', 'done', 'mission-start', 'mission-progress', 'mission-done',
]);
const MAX_FILE_BYTES = 256 * 1024;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Read a small UTF-8 file, refusing anything oversized. */
function readSmall(file) {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error(`${file} is not a regular file`);
  if (st.size > MAX_FILE_BYTES) throw new Error(`${file} is too large`);
  return fs.readFileSync(file, 'utf8');
}

/**
 * Parse missions.allow text. Every non-empty line must match MISSION_RE.
 * @returns {{missions: string[], errors: string[]}}
 */
function parseMissionsAllow(text) {
  const errors = [];
  const missions = [];
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines.forEach((line, i) => {
    if (line === '') return;
    if (!MISSION_RE.test(line)) {
      errors.push(`missions.allow line ${i + 1} is not a valid codename`);
      return;
    }
    if (missions.includes(line)) errors.push(`missions.allow line ${i + 1} is a duplicate`);
    else missions.push(line);
  });
  return { missions, errors };
}

/**
 * Validate the allowlist.json object.
 * @returns {string[]} errors
 */
function checkAllowlist(obj) {
  const errors = [];
  if (!isObj(obj)) return ['allowlist.json must be an object'];
  for (const k of Object.keys(obj)) {
    if (k !== 'members' && k !== 'verbs') errors.push(`allowlist.json: unexpected key`);
  }
  if (!Array.isArray(obj.members)) errors.push('allowlist.json: members must be an array');
  else {
    for (const m of obj.members) {
      if (!MEMBER_IDS.includes(m)) errors.push('allowlist.json: member not in schema enum');
    }
  }
  if (!Array.isArray(obj.verbs)) errors.push('allowlist.json: verbs must be an array');
  else {
    for (const v of obj.verbs) {
      if (typeof v !== 'string' || !VERB_RE.test(v)) errors.push('allowlist.json: invalid verb');
    }
  }
  return errors;
}

/**
 * Load allowlists from a repo checkout. Throws on any problem.
 * @returns {{members: string[], verbs: string[], missions: string[]}}
 */
function loadAllowlists(repoDir) {
  const allow = JSON.parse(readSmall(path.join(repoDir, 'schema', 'allowlist.json')));
  const aErr = checkAllowlist(allow);
  if (aErr.length) throw new Error(aErr.join('; '));
  const { missions, errors } = parseMissionsAllow(readSmall(path.join(repoDir, 'missions.allow')));
  if (errors.length) throw new Error(errors.join('; '));
  return { members: [...allow.members], verbs: [...allow.verbs], missions };
}

const isMember = (v, lists) => typeof v === 'string' && MEMBER_IDS.includes(v) && lists.members.includes(v);
const isVerb = (v, lists) => typeof v === 'string' && VERB_RE.test(v) && lists.verbs.includes(v);
const isMission = (v, lists) => typeof v === 'string' && MISSION_RE.test(v) && lists.missions.includes(v);
const isTime = (v) => typeof v === 'string' && TIME_RE.test(v) && !Number.isNaN(Date.parse(v));

function isCount(v) {
  if (!isObj(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 2 || !own(v, 'done') || !own(v, 'total')) return false;
  const { done, total } = v;
  return Number.isInteger(done) && Number.isInteger(total) &&
    done >= 0 && total >= 1 && total <= COUNT_MAX && done <= total;
}

/**
 * Parse "N/M" into {done, total}; returns null if invalid.
 */
function parseCount(text) {
  if (typeof text !== 'string') return null;
  const m = COUNT_RE.exec(text);
  if (!m) return null;
  const c = { done: Number(m[1]), total: Number(m[2]) };
  return isCount(c) ? c : null;
}

function checkKeys(obj, allowed, required, where, errors) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errors.push(`${where}: unexpected field`);
  }
  for (const k of required) {
    if (!own(obj, k)) errors.push(`${where}: missing ${k}`);
  }
}

/**
 * Validate a parsed status.json against feed v1 + allowlists.
 * Error messages never echo input values (they may be hostile).
 * @returns {string[]} errors (empty when valid)
 */
function validateStatus(doc, lists) {
  const errors = [];
  if (!isObj(doc)) return ['status: must be an object'];
  checkKeys(doc, ['version', 'updatedAt', 'missions', 'members', 'events'],
    ['version', 'updatedAt', 'missions', 'members', 'events'], 'status', errors);
  if (own(doc, 'version') && doc.version !== 1) errors.push('status: version must be 1');
  if (own(doc, 'updatedAt') && !isTime(doc.updatedAt)) errors.push('status: bad updatedAt');

  if (own(doc, 'missions')) {
    if (!Array.isArray(doc.missions)) errors.push('missions: must be an array');
    else {
      if (doc.missions.length > MAX_MISSIONS) errors.push('missions: too many');
      const seen = new Set();
      doc.missions.forEach((m, i) => {
        const w = `missions[${i}]`;
        if (!isObj(m)) { errors.push(`${w}: must be an object`); return; }
        checkKeys(m, ['codename', 'state', 'startedAt', 'endedAt', 'tickets'],
          ['codename', 'state', 'startedAt'], w, errors);
        if (own(m, 'codename')) {
          if (!isMission(m.codename, lists)) errors.push(`${w}: codename not allowed`);
          else if (seen.has(m.codename)) errors.push(`${w}: duplicate codename`);
          else seen.add(m.codename);
        }
        if (own(m, 'state') && !MISSION_STATES.includes(m.state)) errors.push(`${w}: bad state`);
        if (own(m, 'startedAt') && !isTime(m.startedAt)) errors.push(`${w}: bad startedAt`);
        if (own(m, 'endedAt') && !isTime(m.endedAt)) errors.push(`${w}: bad endedAt`);
        if (own(m, 'tickets') && !isCount(m.tickets)) errors.push(`${w}: bad tickets`);
      });
    }
  }

  if (own(doc, 'members')) {
    if (!isObj(doc.members)) errors.push('members: must be an object');
    else {
      for (const [id, m] of Object.entries(doc.members)) {
        if (!isMember(id, lists)) { errors.push('members: unknown member id'); continue; }
        const w = `members.${id}`;
        if (!isObj(m)) { errors.push(`${w}: must be an object`); continue; }
        checkKeys(m, ['state', 'since', 'verb', 'mission', 'progress'], ['state', 'since'], w, errors);
        if (own(m, 'state') && !MEMBER_STATES.includes(m.state)) errors.push(`${w}: bad state`);
        if (own(m, 'since') && !isTime(m.since)) errors.push(`${w}: bad since`);
        if (own(m, 'verb') && !isVerb(m.verb, lists)) errors.push(`${w}: verb not allowed`);
        if (own(m, 'mission') && !isMission(m.mission, lists)) errors.push(`${w}: mission not allowed`);
        if (own(m, 'progress') && !isCount(m.progress)) errors.push(`${w}: bad progress`);
      }
    }
  }

  if (own(doc, 'events')) {
    if (!Array.isArray(doc.events)) errors.push('events: must be an array');
    else {
      if (doc.events.length > MAX_EVENTS) errors.push('events: too many');
      doc.events.forEach((e, i) => {
        const w = `events[${i}]`;
        if (!isObj(e)) { errors.push(`${w}: must be an object`); return; }
        checkKeys(e, ['at', 'who', 'kind', 'verb', 'mission'], ['at', 'who', 'kind'], w, errors);
        if (own(e, 'at') && !isTime(e.at)) errors.push(`${w}: bad at`);
        if (own(e, 'who') && !isMember(e.who, lists)) errors.push(`${w}: unknown who`);
        if (own(e, 'kind') && !EVENT_KINDS.includes(e.kind)) errors.push(`${w}: bad kind`);
        if (own(e, 'verb') && !isVerb(e.verb, lists)) errors.push(`${w}: verb not allowed`);
        if (own(e, 'mission') && !isMission(e.mission, lists)) errors.push(`${w}: mission not allowed`);
      });
    }
  }
  return errors;
}

module.exports = {
  MEMBER_IDS, TIME_RE, VERB_RE, MISSION_RE, COUNT_MAX, MAX_EVENTS, MAX_MISSIONS,
  MEMBER_STATES, MISSION_STATES, EVENT_KINDS, MAX_FILE_BYTES,
  readSmall, parseMissionsAllow, checkAllowlist, loadAllowlists,
  isMember, isVerb, isMission, isTime, isCount, parseCount, validateStatus,
};
