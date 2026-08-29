'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_FOLLOWUP_MS,
  resolveVoiceFollowupMs,
  shouldAcceptFollowUp,
  armFollowUp,
} = require('../connectors/types/discord/voice-followup');

test('resolveVoiceFollowupMs: missing/0 → 25s; -1/false → strict', () => {
  assert.equal(DEFAULT_FOLLOWUP_MS, 25000);
  assert.equal(resolveVoiceFollowupMs(undefined), 25000);
  assert.equal(resolveVoiceFollowupMs(null), 25000);
  assert.equal(resolveVoiceFollowupMs(0), 25000);
  assert.equal(resolveVoiceFollowupMs('0'), 25000);
  assert.equal(resolveVoiceFollowupMs(-1), 0);
  assert.equal(resolveVoiceFollowupMs(false), 0);
  assert.equal(resolveVoiceFollowupMs(15000), 15000);
  assert.equal(resolveVoiceFollowupMs('30000'), 30000);
});

test('shouldAcceptFollowUp: same user inside window; expire; other user still needs name', () => {
  const now = 1_000_000;
  const window = { expires: now + 25_000, userId: 'james' };

  assert.equal(shouldAcceptFollowUp({ window, userId: 'james', now, addressed: false }), true);
  assert.equal(shouldAcceptFollowUp({ window, userId: 'james', now: now + 24_999, addressed: false }), true);
  assert.equal(shouldAcceptFollowUp({ window, userId: 'james', now: now + 25_000, addressed: false }), false);
  assert.equal(shouldAcceptFollowUp({ window, userId: 'other', now, addressed: false }), false);
  assert.equal(shouldAcceptFollowUp({ window, userId: 'other', now, addressed: true }), true);
  assert.equal(shouldAcceptFollowUp({ window: null, userId: 'james', now, addressed: false }), false);
  assert.equal(shouldAcceptFollowUp({ window, userId: '', now, addressed: false }), false);
  assert.equal(shouldAcceptFollowUp({
    window: { expires: now + 1000, userId: '' },
    userId: 'james',
    now,
    addressed: false,
  }), false);
});

test('armFollowUp keys last speaker userId (not just guild) and refuses empty/strict', () => {
  const w = armFollowUp({ now: 1000, windowMs: 25000, userId: 42 });
  assert.deepEqual(w, { expires: 26000, userId: '42' });
  assert.equal(armFollowUp({ now: 1000, windowMs: 0, userId: '42' }), null);
  assert.equal(armFollowUp({ now: 1000, windowMs: 25000, userId: '' }), null);
});

test('index.js arms after speech with last-speaker userId; 0-or-unset is 25s', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.match(src, /shouldAcceptFollowUp/);
  assert.match(src, /resolveVoiceFollowupMs/);
  assert.match(src, /armFollowUp/);
  assert.match(src, /voice_followup_ms:[\s\S]{0,400}default:\s*25000/);
  const handle = src.slice(src.indexOf('async function handleVoiceUtterance'), src.indexOf('async function engineKeys'));
  const awaitChain = handle.indexOf('await chain');
  const armAt = handle.lastIndexOf('voiceActive.set');
  assert.ok(awaitChain >= 0, 'await chain present');
  assert.ok(armAt > awaitChain, 'CLI fallback still arms after speak chain finishes');
  assert.match(handle, /armFollowUp\(/);
  assert.match(handle, /userId:\s*speakerId/);
  assert.match(handle, /firstAudio/);
  assert.equal(/voiceActive\.set\(guildId,\s*Date\.now\(\)/.test(handle), false);
});
