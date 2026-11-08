#!/usr/bin/env node
'use strict';
// CI check: status.json matches feed v1 + allowlists, missions.allow is clean.
// usage: node bin/check.js [repo-dir]
const path = require('node:path');
const V = require('../lib/validate');

function check(repo) {
  const errors = [];
  let lists;
  try {
    lists = V.loadAllowlists(repo);
  } catch (e) {
    return [`allowlists: ${e.message}`];
  }
  let doc;
  try {
    doc = JSON.parse(V.readSmall(path.join(repo, 'status.json')));
  } catch (e) {
    return [...errors, `status.json: ${e.message}`];
  }
  return [...errors, ...V.validateStatus(doc, lists).map((m) => `status.json: ${m}`)];
}

if (require.main === module) {
  const repo = path.resolve(process.argv[2] ?? path.join(__dirname, '..'));
  const errors = check(repo);
  if (errors.length) {
    for (const e of errors) process.stderr.write(`check: ${e}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('check: status.json and missions.allow are valid\n');
  }
}

module.exports = { check };
