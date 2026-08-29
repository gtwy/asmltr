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

test('short overlap 400ms does not barge', () => {
  assert.equal(shouldBargeIn({
    busy: true,
    speaking: true,
    replyStartedAt: 10_000,
    now: 10_000 + GRACE,
    graceMs: GRACE,
    userSpeechMs: 400,
    minSpeechMs: 1500,
  }), false);
});

test('sustained 1500ms overlap after grace does barge', () => {
  assert.equal(shouldBargeIn({
    busy: true,
    speaking: true,
    replyStartedAt: 10_000,
    now: 10_000 + GRACE,
    graceMs: GRACE,
    userSpeechMs: 1500,
    minSpeechMs: 1500,
  }), true);
});

test('sustained overlap still respects 1200ms grace', () => {
  assert.equal(shouldBargeIn({
    busy: true,
    speaking: true,
    replyStartedAt: 10_000,
    now: 10_000 + GRACE - 1,
    graceMs: GRACE,
    userSpeechMs: 1500,
    minSpeechMs: 1500,
  }), false);
});

test('Live onSpeechStart does not immediately stopVoiceReply', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  const i = src.indexOf('onSpeechStart:');
  assert.ok(i >= 0);
  const body = src.slice(i, src.indexOf('onAssistantText:', i));
  assert.equal(/stopVoiceReply\s*\(/.test(body), false);
  assert.match(body, /armVoiceOverlap/);
  assert.match(body, /onSpeechStop:/);
  assert.match(body, /clearVoiceOverlap/);
});

test('flushPcm48Frames holds leftover bytes under 3840', () => {
  const { flushPcm48Frames, OPUS_FRAME_BYTES } = require('../connectors/types/discord/voice');
  assert.equal(OPUS_FRAME_BYTES, 3840);
  const acc = Buffer.alloc(3840 + 100, 7);
  const { frames, rest } = flushPcm48Frames(acc);
  assert.equal(frames.length, 3840);
  assert.equal(rest.length, 100);
  const tiny = flushPcm48Frames(Buffer.alloc(100));
  assert.equal(tiny.frames.length, 0);
  assert.equal(tiny.rest.length, 100);
  const exact = flushPcm48Frames(Buffer.alloc(3840 * 2));
  assert.equal(exact.frames.length, 3840 * 2);
  assert.equal(exact.rest.length, 0);
});

test('PCM playback writes 3840-byte frames and prebuffers ~120ms (6 frames)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/voice.js'), 'utf8');
  const { OPUS_FRAME_BYTES, PCM_PREBUFFER_FRAMES } = require('../connectors/types/discord/voice');
  assert.equal(OPUS_FRAME_BYTES, 3840);
  assert.equal(PCM_PREBUFFER_FRAMES, 6);
  assert.equal(PCM_PREBUFFER_FRAMES * 20, 120);
  assert.match(src, /PCM_PREBUFFER_FRAMES = 6/);
  assert.match(src, /primePcmPlayback/);
  assert.match(src, /queued\.length >= PCM_PREBUFFER_FRAMES \* OPUS_FRAME_BYTES/);
});
