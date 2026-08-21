'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');

const CLI = path.join(__dirname, '..', 'cli', 'asmltr.js');

function run(args, deny) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ASMLTR_DENY_TOOLS: deny, NO_COLOR: '1' },
    timeout: 15000,
  });
}

test('asmltr send refuses when send denied', () => {
  const r = run(['send', 'discord', 'x', 'hi'], 'send');
  assert.notEqual(r.status, 0);
  assert.match(String(r.stderr || r.stdout), /denied: send/);
});

test('asmltr streams refuses when streams denied', () => {
  const r = run(['streams'], 'streams');
  assert.notEqual(r.status, 0);
  assert.match(String(r.stderr || r.stdout), /denied: streams/);
});

test('asmltr silo overview refuses when silo denied', () => {
  const r = run(['silo', 'overview'], 'silo');
  assert.notEqual(r.status, 0);
  assert.match(String(r.stderr || r.stdout), /denied: silo/);
});

test('asmltr announce refuses when send denied (send-class)', () => {
  const r = run(['announce', 'hi'], 'send');
  assert.notEqual(r.status, 0);
  assert.match(String(r.stderr || r.stdout), /denied: send/);
});

test('asmltr silo put refuses when siloWrite denied even if silo allowed', () => {
  const r = run(['silo', 'put', 'x', '/etc/hosts'], 'siloWrite');
  assert.notEqual(r.status, 0);
  assert.match(String(r.stderr || r.stdout), /denied: siloWrite/);
});
