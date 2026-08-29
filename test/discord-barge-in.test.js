'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { shouldBargeIn } = require('../connectors/types/discord/barge-in');

const GRACE = 1200;

// speaking maps to voice.isSpeaking(); replyStartedAt is set only when first audio plays.
test('barge-in during thinking (isSpeaking false, voiceBusy true) does not cancel', () => {
  assert.equal(shouldBargeIn({
    busy: true,
    speaking: false,
    replyStartedAt: undefined,
    now: 10_000,
    graceMs: GRACE,
  }), false);
});

test('barge-in after first audio + grace elapsed does cancel', () => {
  assert.equal(shouldBargeIn({
    busy: true,
    speaking: true,
    replyStartedAt: 10_000,
    now: 10_000 + GRACE,
    graceMs: GRACE,
  }), true);
});

test('barge-in during the 1200ms after first audio does not cancel', () => {
  assert.equal(shouldBargeIn({
    busy: true,
    speaking: true,
    replyStartedAt: 10_000,
    now: 10_000 + GRACE - 1,
    graceMs: GRACE,
  }), false);
});

test('thinking with startSpeech open (isSpeaking true) still does not cancel until first audio', () => {
  assert.equal(shouldBargeIn({
    busy: true,
    speaking: true,
    replyStartedAt: undefined,
    now: 10_000,
    graceMs: GRACE,
  }), false);
});

test('grace starts at first spoken audio, not wake; barge-in stays enabled', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.match(src, /shouldBargeIn/);
  const wake = src.slice(src.indexOf('voice.startSpeech(guildId)'), src.indexOf('voice.startSpeech(guildId)') + 280);
  assert.match(wake, /voice\.startSpeech\(guildId\)/);
  assert.equal(/voiceReplyStart\.set/.test(wake), false);
  const first = src.slice(src.indexOf('if (!firstAudio)'), src.indexOf('if (!firstAudio)') + 220);
  assert.match(first, /voiceReplyStart\.set/);
  assert.equal(/voice_barge_in\s*=\s*false/.test(src), false);
});
