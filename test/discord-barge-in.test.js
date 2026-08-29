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
  assert.match(body, /onSpeechStop:/);
  assert.match(body, /clearVoiceOverlap/);
  assert.match(body, /isSpeaking\(guildId\)/);
  assert.match(body, /voiceBusy\.has\(guildId\)/);
  // Echo: do not arm 1.5s barge from xAI VAD while she is playing.
  assert.equal(/armVoiceOverlap/.test(body), false);
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

test('PCM playback writes 3840-byte frames and prebuffers 2-3 frames (~40-60ms), not 120ms', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/voice.js'), 'utf8');
  const { OPUS_FRAME_BYTES, PCM_PREBUFFER_FRAMES } = require('../connectors/types/discord/voice');
  assert.equal(OPUS_FRAME_BYTES, 3840);
  assert.ok(PCM_PREBUFFER_FRAMES >= 2 && PCM_PREBUFFER_FRAMES <= 3);
  assert.ok(PCM_PREBUFFER_FRAMES * 20 <= 60);
  assert.match(src, /PCM_PREBUFFER_FRAMES = [23]/);
  assert.equal(/PCM_PREBUFFER_FRAMES = 6/.test(src), false);
  assert.match(src, /primePcmPlayback/);
  assert.match(src, /queued\.length >= PCM_PREBUFFER_FRAMES \* OPUS_FRAME_BYTES/);
  const play = src.slice(src.indexOf('function pushPcm24Play'), src.indexOf('function startDrone'));
  assert.match(play, /pcm48MonoToPcm48Stereo/);
  assert.equal(/pcm24MonoToPcm48Stereo/.test(play), false);
});

test('ignore bot user in recv: isSelfUser + speaking start/end return before subscribe', () => {
  const { isSelfUser } = require('../connectors/types/discord/voice');
  assert.equal(isSelfUser({ user: { id: 'bot' } }, 'bot'), true);
  assert.equal(isSelfUser({ user: { id: 'bot' } }, 'human'), false);
  assert.equal(isSelfUser({ user: { id: 99 } }, '99'), true);
  assert.equal(isSelfUser(null, '1'), false);
  assert.equal(isSelfUser({ user: {} }, '1'), false);
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/voice.js'), 'utf8');
  const start = src.slice(src.indexOf("receiver.speaking.on('start'"), src.indexOf("if (onBargeEnd)"));
  assert.match(start, /isSelfUser\(client, userId\)/);
  assert.match(start, /return;/);
  const end = src.slice(src.indexOf("receiver.speaking.on('end'"), src.indexOf('return true;'));
  assert.match(end, /isSelfUser\(client, userId\)/);
});

test('play turn to completion: onResponseDone / endPcmPlayback without hard does not player.stop(true)', () => {
  const voiceSrc = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/voice.js'), 'utf8');
  const endFn = voiceSrc.slice(voiceSrc.indexOf('function endPcmPlayback'), voiceSrc.indexOf('function primePcmPlayback'));
  assert.match(endFn, /if \(forceStop\)/);
  assert.match(endFn, /return waitPcmIdle/);
  const drainAt = endFn.indexOf('Do NOT player.stop(true)');
  assert.ok(drainAt >= 0, 'drain path comments that it must not hard-stop');
  const drainPath = endFn.slice(drainAt, endFn.indexOf('return waitPcmIdle', drainAt) + 40);
  assert.match(drainPath, /return waitPcmIdle/);
  assert.equal(/player\.stop\(true\)/.test(drainPath.replace('Do NOT player.stop(true)', '')), false);
  const startFn = voiceSrc.slice(voiceSrc.indexOf('function startPcmPlayback'), voiceSrc.indexOf('function pushPcm24Play'));
  assert.equal(/hard:\s*true/.test(startFn), false);
  const idx = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  const done = idx.slice(idx.indexOf('onResponseDone:'), idx.indexOf('onError:'));
  assert.match(done, /endPcmPlayback\(guildId\)/);
  assert.equal(/endPcmPlayback\([^\n]*hard:\s*true/.test(done), false);
  assert.match(done, /endSpeech/);
});

test('Live uses local 1.5s barge; onBargeIn does not skip converseSessions', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  const barge = src.slice(src.indexOf('onBargeIn:'), src.indexOf('onBargeEnd:'));
  assert.equal(/converseSessions\.has\(guildId\)\s*return/.test(barge), false);
  assert.match(barge, /armVoiceOverlap/);
  const end = src.slice(src.indexOf('onBargeEnd:'), src.indexOf('log: (m)'));
  assert.equal(/converseSessions\.has\(guildId\)\s*return/.test(end), false);
  assert.match(src, /BARGE_MIN_SPEECH_MS = 1500/);
});

test('Live play path uses pcm48MonoToPcm48Stereo not pcm24MonoToPcm48Stereo; session 48k', () => {
  const play = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/voice.js'), 'utf8');
  const fn = play.slice(play.indexOf('function pushPcm24Play'), play.indexOf('function startDrone'));
  assert.match(fn, /pcm48MonoToPcm48Stereo/);
  assert.equal(/pcm24MonoToPcm48Stereo/.test(fn), false);
  const { pcm48MonoToPcm48Stereo } = require('../shared/speech/converse-grok');
  const src = Buffer.alloc(2);
  src.writeInt16LE(7, 0);
  const out = pcm48MonoToPcm48Stereo(src);
  assert.equal(out.length, src.length * 2);
  assert.notEqual(out.length, src.length * 4);
  const { buildSessionUpdate } = require('../shared/speech/converse-grok');
  const u = buildSessionUpdate({});
  assert.equal(u.session.audio.input.format.rate, 48000);
  assert.equal(u.session.audio.output.format.rate, 48000);
});
