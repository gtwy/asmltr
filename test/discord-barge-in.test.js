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
  // Echo: ignore xAI VAD while she is playing; local Discord barge owns the 1.5s timer.
  assert.match(body, /isSpeaking\(guildId\)/);
  assert.match(body, /voiceBusy\.has\(guildId\)/);
  assert.equal(/armVoiceOverlap/.test(body), false);
});

test('isSelfUser is true only for the bot id', () => {
  const { isSelfUser } = require('../connectors/types/discord/voice');
  assert.equal(isSelfUser({ user: { id: 'bot1' } }, 'bot1'), true);
  assert.equal(isSelfUser({ user: { id: 'bot1' } }, 'human'), false);
  assert.equal(isSelfUser({ user: { id: 'bot1' } }, undefined), false);
  assert.equal(isSelfUser({}, 'bot1'), false);
  assert.equal(isSelfUser(null, 'bot1'), false);
});

test('recv ignores bot self: no subscribe, STT, onPcm24, barge', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/voice.js'), 'utf8');
  assert.match(src, /function isSelfUser\(/);
  const start = src.slice(src.indexOf("receiver.speaking.on('start'"), src.indexOf("if (onBargeEnd)"));
  assert.match(start, /if \(isSelfUser\(client, userId\)\) return/);
  const stt = src.indexOf('if (isSelfUser(client, userId)) return');
  const sub = src.indexOf('receiver.subscribe(userId');
  assert.ok(stt >= 0 && sub > stt, 'self skip is before subscribe');
  const end = src.slice(src.indexOf("receiver.speaking.on('end'"), src.indexOf('return true;'));
  assert.match(end, /if \(isSelfUser\(client, userId\)\) return/);
  assert.match(src, /function realtimeSpeaking[\s\S]*?if \(isSelfUser\(client, userId\)\) return/);
  assert.match(src, /function converseSpeaking[\s\S]*?if \(isSelfUser\(client, userId\)\) return/);
});

test('Live onBargeIn uses local 1.5s arm; does not return when converse is bound', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  const barge = src.slice(src.indexOf('onBargeIn:'), src.indexOf('onBargeEnd:'));
  assert.equal(/converseSessions\.has\(guildId\)\) return/.test(barge), false);
  assert.match(barge, /armVoiceOverlap/);
  const end = src.slice(src.indexOf('onBargeEnd:'), src.indexOf('log: (m)'));
  assert.equal(/converseSessions\.has\(guildId\)\) return/.test(end), false);
  assert.match(end, /clearVoiceOverlap/);
  assert.match(src, /BARGE_MIN_SPEECH_MS = 1500/);
  assert.match(src, /BARGE_GRACE_MS = 1200/);
});

test('echo mute: no conv.pushPcm24 while isSpeaking/voiceBusy; pcmRing still fills', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  const pcm = src.slice(src.indexOf('onPcm24:'), src.indexOf('onBargeIn:'));
  assert.match(pcm, /pcmRing/);
  assert.match(pcm, /isSpeaking\(guildId\)/);
  assert.match(pcm, /voiceBusy\.has\(guildId\)/);
  const muteAt = pcm.indexOf('voice.isSpeaking(guildId) || voiceBusy.has(guildId)');
  const pushAt = pcm.lastIndexOf('conv.pushPcm24');
  assert.ok(muteAt >= 0 && pushAt > muteAt, 'echo mute gates pushPcm24');
  const handle = src.slice(src.indexOf('async function handleVoiceUtterance'), src.indexOf('async function engineKeys'));
  assert.match(handle, /echoMute/);
});

test('onResponseDone drains (onDrain, no player.stop true); startPcmPlayback does not hard-kill unless barged', () => {
  const voiceSrc = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/voice.js'), 'utf8');
  const start = voiceSrc.slice(voiceSrc.indexOf('function startPcmPlayback'), voiceSrc.indexOf('function pushPcm24Play'));
  assert.match(start, /existing/);
  assert.match(start, /cancelled/);
  assert.match(start, /hard:\s*true/);
  assert.match(start, /do not hard-kill unless barged/);
  const end = voiceSrc.slice(voiceSrc.indexOf('function endPcmPlayback'), voiceSrc.indexOf('function primePcmPlayback'));
  assert.match(end, /onDrain/);
  assert.match(end, /pcm\.end/);
  assert.match(end, /AudioPlayerStatus\.Idle/);
  assert.match(end, /e\.draining = true/);
  assert.match(end, /tearDownHard/);
  assert.match(end, /player\.stop\(true\)/);
  const drainSlice = end.slice(end.indexOf('// Drain'));
  assert.equal(/player\.stop\(true\)/.test(drainSlice), false);
  assert.match(drainSlice, /do NOT hard-stop the player/);
  const idx = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  const done = idx.slice(idx.indexOf('onResponseDone:'), idx.indexOf('onError:'));
  assert.match(done, /endPcmPlayback/);
  assert.match(done, /onDrain:\s*finish/);
  assert.match(done, /endSpeech/);
  assert.equal(/player\.stop\(true\)/.test(done), false);
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
