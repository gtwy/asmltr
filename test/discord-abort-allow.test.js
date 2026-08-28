'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { canAbortTurn, starterIdFromSlot } = require('../connectors/types/discord/abort-allow');

test('owner can abort any turn', () => {
  assert.equal(canAbortTurn({ isOwner: true, authorId: 'owner', starterId: 'friend' }), true);
  assert.equal(canAbortTurn({ isOwner: true, authorId: 'owner', starterId: 'owner' }), true);
});

test('starter can abort even if not owner', () => {
  assert.equal(canAbortTurn({ isOwner: false, authorId: '111', starterId: '111' }), true);
  assert.equal(canAbortTurn({ isOwner: false, authorId: 111, starterId: '111' }), true);
});

test('third person cannot abort', () => {
  assert.equal(canAbortTurn({ isOwner: false, authorId: '333', starterId: '111' }), false);
});

test('steerer is not starter and cannot abort', () => {
  assert.equal(canAbortTurn({ isOwner: false, authorId: 'steerer', starterId: '111' }), false);
});

test('missing starter: only owner (fail closed)', () => {
  assert.equal(canAbortTurn({ isOwner: false, authorId: '111', starterId: null }), false);
  assert.equal(canAbortTurn({ isOwner: true, authorId: 'owner', starterId: null }), true);
  assert.equal(starterIdFromSlot(true), null);
  assert.equal(starterIdFromSlot({ starterId: '111' }), '111');
});

test('discord stop is not in OWNER_ONLY_CMDS; processing stores starterId', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.match(src, /canAbortTurn/);
  assert.match(src, /starterId:/);
  const block = src.match(/const OWNER_ONLY_CMDS = new Set\((\[[\s\S]*?\])\)/);
  assert.ok(block);
  assert.equal(/['\"]stop['\"]/.test(block[1]), false);
});

test('send voice stream inject register abortTarget; stop passes identities; not owner-only', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.match(src, /function abortTarget\(/);
  const sendSlice = src.slice(src.indexOf("app.post('/out'"), src.indexOf("app.post('/out'") + 3500);
  assert.match(sendSlice, /abortTarget\(/);
  assert.match(src, /loadOutboundStage/);
  const voiceSlice = src.slice(src.indexOf('voiceBusy.add(guildId)'), src.indexOf('voiceBusy.add(guildId)') + 400);
  assert.match(voiceSlice, /abortTarget\(/);
  assert.match(src, /abortTarget\(cid, message\.author\.id, 'stream'\)/);
  assert.match(src, /abortTarget\(cid, message\.author\.id, 'inject'\)/);
  assert.match(src, /speakerId: String\(message\.author\.id\)/);
  assert.match(src, /starterId: starterId/);
  const block = src.match(/const OWNER_ONLY_CMDS = new Set\((\[[\s\S]*?\])\)/);
  assert.ok(block);
  assert.equal(/['"]stop['"]/.test(block[1]), false);
});
