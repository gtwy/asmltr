'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  LIVE_VOICE, LIVE_MODEL, LIVE_URL, KEY_NAME,
  sessionUpdatePayload, isLastSpeakerRelay, applyServerMessage, openSession, loadVoiceKey,
} = require('../shared/speech/converse-grok');

test('session.update pins voice ara, empty tools, server_vad, reasoning none, PCM 24k', () => {
  const p = sessionUpdatePayload();
  assert.equal(p.type, 'session.update');
  assert.equal(p.session.voice, 'ara');
  assert.equal(LIVE_VOICE, 'ara');
  assert.deepEqual(p.session.tools, []);
  assert.deepEqual(p.session.turn_detection, { type: 'server_vad' });
  assert.deepEqual(p.session.reasoning, { effort: 'none' });
  assert.equal(p.session.audio.input.format.type, 'audio/pcm');
  assert.equal(p.session.audio.input.format.rate, 24000);
  assert.equal(p.session.audio.output.format.type, 'audio/pcm');
  assert.equal(p.session.audio.output.format.rate, 24000);
  const raw = JSON.stringify(p);
  assert.equal(raw.includes('eve'), false);
  assert.equal(raw.includes('voice_id'), false);
  assert.equal(raw.includes('elevenlabs'), false);
  assert.equal(raw.includes('web_search'), false);
  assert.equal(raw.includes('mcp'), false);
});

test('Live URL pins grok-voice-think-fast-2.0 (alias grok-voice-latest)', () => {
  assert.equal(LIVE_MODEL, 'grok-voice-think-fast-2.0');
  assert.match(LIVE_URL, /wss:\/\/api\.x\.ai\/v1\/realtime\?model=grok-voice-think-fast-2\.0/);
  assert.equal(KEY_NAME, 'xai_voice_api_key');
});

test('last-speaker PCM gate: same user in window only; muted / other speaker / expired denied', () => {
  const now = 1_000_000;
  const window = { expires: now + 25_000, userId: '42' };
  assert.equal(isLastSpeakerRelay({ window, userId: '42', now, muted: false }), true);
  assert.equal(isLastSpeakerRelay({ window, userId: '99', now, muted: false }), false);
  assert.equal(isLastSpeakerRelay({ window, userId: '42', now, muted: true }), false);
  assert.equal(isLastSpeakerRelay({ window: { expires: now - 1, userId: '42' }, userId: '42', now, muted: false }), false);
  assert.equal(isLastSpeakerRelay({ window: null, userId: '42', now, muted: false }), false);
});

test('applyServerMessage decodes output_audio.delta and completes on response.done', () => {
  const audio = [];
  const ends = [];
  const transcripts = [];
  const h = {
    onAudio: (b) => audio.push(b),
    onAudioEnd: (t) => ends.push(t),
    onTranscript: (t) => transcripts.push(t),
  };
  const st = { audioStarted: false, transcript: '' };
  const pcm = Buffer.from([0, 1, 2, 3]);
  assert.equal(applyServerMessage({ type: 'response.output_audio.delta', delta: pcm.toString('base64') }, h, st), 'audio');
  assert.equal(applyServerMessage({ type: 'response.output_audio_transcript.delta', delta: 'hello' }, h, st), 'transcript-delta');
  assert.equal(applyServerMessage({ type: 'response.done' }, h, st), 'done');
  assert.deepEqual(Buffer.concat(audio), pcm);
  assert.deepEqual(ends, ['hello']);
  assert.deepEqual(transcripts, ['hello']);
});

class FakeWS {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts || {};
    this.sent = [];
    this.readyState = 0;
    FakeWS.instances.push(this);
    setImmediate(() => {
      this.readyState = 1;
      if (this._open) this._open();
    });
  }
  on(ev, fn) {
    if (ev === 'open') this._open = fn;
    if (ev === 'message') this._message = fn;
    if (ev === 'error') this._error = fn;
    if (ev === 'close') this._close = fn;
  }
  send(s) { this.sent.push(s); }
  close() { this.readyState = 3; if (this._close) this._close(1000); }
}
FakeWS.instances = [];

test('openSession uses vault { value }, never process.env.XAI_API_KEY, sends ara session.update', async () => {
  process.env.XAI_API_KEY = 'WRONG-TEXT-KEY-DO-NOT-USE';
  FakeWS.instances = [];
  const got = [];
  const session = openSession({}, {
    WebSocket: FakeWS,
    getSecret: async (name) => { got.push(name); return { value: 'vault-live-key' }; },
    instructions: 'You are Ivy.',
  });
  await session.ready;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got, ['xai_voice_api_key']);
  assert.equal(FakeWS.instances.length, 1);
  const ws = FakeWS.instances[0];
  assert.match(ws.url, /wss:\/\/api\.x\.ai\/v1\/realtime\?model=grok-voice-think-fast-2\.0/);
  assert.equal(ws.opts.headers.Authorization, 'Bearer vault-live-key');
  assert.equal(ws.opts.headers.Authorization.includes('WRONG'), false);
  const update = JSON.parse(ws.sent[0]);
  assert.equal(update.session.voice, 'ara');
  assert.deepEqual(update.session.tools, []);
  assert.equal(JSON.stringify(update).includes('voice_id'), false);
  session.pushPcm24(Buffer.from([1, 0, 2, 0]));
  const append = JSON.parse(ws.sent[1]);
  assert.equal(append.type, 'input_audio_buffer.append');
  assert.ok(append.audio);
  session.cancel();
  assert.equal(JSON.parse(ws.sent[2]).type, 'response.cancel');
  delete process.env.XAI_API_KEY;
});

test('loadVoiceKey reads { value } and refuses missing', async () => {
  const k = await loadVoiceKey(async () => ({ value: 'abc' }));
  assert.equal(k, 'abc');
  await assert.rejects(() => loadVoiceKey(async () => null), /no xai_voice_api_key/);
});

test('source never reads XAI_API_KEY or ElevenLabs voice_id on the socket', () => {
  const src = fs.readFileSync(path.join(__dirname, '../shared/speech/converse-grok.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(code.includes('XAI_API_KEY'), false);
  assert.equal(code.includes('elevenlabs_api_key'), false);
  assert.equal(code.includes('voice_id'), false);
  assert.match(src, /voice: LIVE_VOICE/);
  assert.match(src, /require\('\.\.\/vault'\)\.getSecret/);
  assert.match(src, /xai_voice_api_key/);
  assert.match(src, /shared\/vault/);
});
