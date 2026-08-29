'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  KEY_NAME, MODEL, WS_URL, VOICE, KEYTERMS,
  buildSessionUpdate, appendPcmEvent, shouldRelayPcm, applyServerEvent,
  asRealtimeFunctions, functionOutputItem,
  fetchVoiceApiKey, openSession, pcm24MonoToPcm48Stereo, pcm48StereoToPcm48Mono, pcm48MonoToPcm48Stereo, secretValue,
} = require('../shared/speech/converse-grok');

class MockWS {
  constructor(url, opts) {
    MockWS.last = { url, opts };
    MockWS.instances.push(this);
    this.url = url;
    this.opts = opts;
    this.readyState = 0;
    this.sent = [];
    this._h = {};
    queueMicrotask(() => {
      this.readyState = 1;
      if (this._h.open) this._h.open();
    });
  }
  on(ev, fn) { this._h[ev] = fn; return this; }
  send(data) { this.sent.push(typeof data === 'string' ? data : String(data)); }
  close() { this.readyState = 3; if (this._h.close) this._h.close(1000, ''); }
  emitMessage(obj) { if (this._h.message) this._h.message(JSON.stringify(obj)); }
}
MockWS.instances = [];

test('session.update: ara, tools=[], server_vad, reasoning none, PCM 48k, grok-voice-think-fast-2.0 URL', () => {
  assert.equal(MODEL, 'grok-voice-think-fast-2.0');
  assert.equal(VOICE, 'ara');
  assert.equal(WS_URL, 'wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-2.0');
  assert.equal(KEY_NAME, 'xai_voice_api_key');
  const u = buildSessionUpdate({ instructions: 'You are Ivy.', voice: 'eve' });
  assert.equal(u.type, 'session.update');
  assert.equal(u.session.voice, 'ara');
  assert.notEqual(u.session.voice, 'eve');
  assert.deepEqual(u.session.tools, []);
  assert.deepEqual(u.session.turn_detection, {
    type: 'server_vad', threshold: 0.5, prefix_padding_ms: 400, silence_duration_ms: 800, interrupt_response: false,
  });
  assert.equal(u.session.turn_detection.threshold, 0.5);
  assert.equal(u.session.turn_detection.interrupt_response, false);
  assert.deepEqual(u.session.reasoning, { effort: 'none' });
  assert.equal(u.session.audio.input.format.type, 'audio/pcm');
  assert.equal(u.session.audio.input.format.rate, 48000);
  assert.equal(u.session.audio.output.format.rate, 48000);
  assert.ok(u.session.audio.input.transcription.keyterms.includes('Ivy'));
  assert.ok(u.session.audio.input.transcription.keyterms.includes('ivy'));
  assert.ok(u.session.audio.input.transcription.keyterms.includes('IV'));
  assert.deepEqual(KEYTERMS.slice().sort(), ['IV', 'Ivy', 'ivy'].sort());
  assert.equal(u.session.instructions, 'You are Ivy.');
});

test('shouldRelayPcm: last-speaker only; empty speakerId does not forward; mute blocks', () => {
  assert.equal(shouldRelayPcm({ speakerId: '', userId: 'james' }), false);
  assert.equal(shouldRelayPcm({ speakerId: 'james', userId: 'james' }), true);
  assert.equal(shouldRelayPcm({ speakerId: 'james', userId: 'other' }), false);
  assert.equal(shouldRelayPcm({ speakerId: '', userId: '' }), false);
  assert.equal(shouldRelayPcm({ speakerId: '', userId: 'james', muted: true }), false);
});

test('openSession uses vault-shaped getKey, never process.env.XAI_API_KEY; mocked WS only', async () => {
  process.env.XAI_API_KEY = 'env-must-not-be-used';
  MockWS.instances = [];
  const audio = [];
  const session = openSession({
    onAudio: (pcm) => audio.push(pcm),
  }, {
    getKey: async () => 'vault-test-key',
    WebSocket: MockWS,
    instructions: 'Keep it short.',
  });
  await session.ready;
  const last = MockWS.last;
  assert.equal(last.url, WS_URL);
  assert.equal(last.opts.headers.Authorization, 'Bearer vault-test-key');
  const ws = MockWS.instances[0];
  assert.ok(ws.sent.length >= 1);
  const upd = JSON.parse(ws.sent[0]);
  assert.equal(upd.type, 'session.update');
  assert.deepEqual(upd.session.tools, []);
  assert.equal(upd.session.voice, 'ara');
  assert.equal(upd.session.reasoning.effort, 'none');

  const pcm = Buffer.alloc(4, 1);
  session.pushPcm24(pcm);
  const append = JSON.parse(ws.sent[ws.sent.length - 1]);
  assert.equal(append.type, 'input_audio_buffer.append');
  assert.equal(append.audio, pcm.toString('base64'));

  ws.emitMessage({ type: 'response.output_audio.delta', delta: Buffer.from('abcd').toString('base64') });
  assert.equal(audio.length, 1);
  assert.deepEqual(audio[0], Buffer.from('abcd'));

  session.cancel();
  assert.equal(JSON.parse(ws.sent[ws.sent.length - 1]).type, 'response.cancel');
  delete process.env.XAI_API_KEY;
});

test('fetchVoiceApiKey reads {value} and ignores process.env.XAI_API_KEY', async () => {
  process.env.XAI_API_KEY = 'env-must-not-be-used';
  const k = await fetchVoiceApiKey({ getKey: async () => secretValue({ value: 'from-vault' }) });
  assert.equal(k, 'from-vault');
  assert.equal(secretValue({ value: '  abc  ' }), 'abc');
  delete process.env.XAI_API_KEY;
});

test('source never reads process.env.XAI_API_KEY or puts the key on a spawn', () => {
  const src = fs.readFileSync(path.join(__dirname, '../shared/speech/converse-grok.js'), 'utf8');
  assert.equal(/=\s*process\.env\.XAI_API_KEY/.test(src), false);
  assert.match(src, /getSecret\(\s*KEY_NAME|getSecret\(\s*'xai_voice_api_key'/);
  assert.match(src, /wss:\/\/api\.x\.ai\/v1\/realtime\?model=/);
  assert.match(src, /asRealtimeFunctions/);
  assert.match(src, /server_vad/);
  assert.match(src, /threshold:\s*0\.5/);
  assert.match(src, /interrupt_response:\s*false/);
  assert.match(src, /effort:\s*'none'/);
  assert.match(src, /const VOICE = 'ara'/);
  assert.equal(src.includes('DODLEQ'), false);
  assert.equal(/=\s*process\.env\.XAI_API_KEY/.test(src), false);
});

test('pcm24MonoToPcm48Stereo doubles rate and mirrors L/R', () => {
  const src = Buffer.alloc(2);
  src.writeInt16LE(1000, 0);
  const out = pcm24MonoToPcm48Stereo(src);
  assert.equal(out.length, 8);
  assert.equal(out.readInt16LE(0), 1000);
  assert.equal(out.readInt16LE(2), 1000);
  assert.equal(out.readInt16LE(4), 1000);
  assert.equal(out.readInt16LE(6), 1000);
});

test('applyServerEvent maps output audio + input transcript', () => {
  const got = { audio: 0, user: '', done: 0 };
  applyServerEvent({ type: 'response.output_audio.delta', delta: Buffer.from('x').toString('base64') }, {
    onAudio: () => { got.audio += 1; },
  });
  applyServerEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Ivy hello' }, {
    onUserTranscript: (t) => { got.user = t; },
  });
  applyServerEvent({ type: 'response.done' }, { onResponseDone: () => { got.done += 1; } });
  assert.equal(got.audio, 1);
  assert.equal(got.user, 'Ivy hello');
  assert.equal(got.done, 1);
});

test('discord index.js does not send eve or ElevenLabs voice_id on the xAI socket', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.equal(/voice:\s*'eve'/.test(src), false);
  assert.equal(src.includes('DODLEQ'), false);
  assert.match(src, /skip handleStream \+ ElevenLabs TTS/);
  assert.match(src, /getSecret\('xai_voice_api_key'/);
  assert.match(src, /voice=ara tools=\[\]/);
});


test('pcm48StereoToPcm48Mono averages L/R; pcm48MonoToPcm48Stereo L=R length*2', () => {
  const stereo = Buffer.alloc(4);
  stereo.writeInt16LE(1000, 0);
  stereo.writeInt16LE(3000, 2);
  const mono = pcm48StereoToPcm48Mono(stereo);
  assert.equal(mono.length, 2);
  assert.equal(mono.readInt16LE(0), 2000);
  const up = pcm48MonoToPcm48Stereo(mono);
  assert.equal(up.length, mono.length * 2);
  assert.equal(up.readInt16LE(0), 2000);
  assert.equal(up.readInt16LE(2), 2000);
});

test('session.tools are function-type or []; never native web_search/x_search/mcp', () => {
  const empty = buildSessionUpdate({});
  assert.deepEqual(empty.session.tools, []);
  const mixed = buildSessionUpdate({
    tools: [
      { type: 'web_search' },
      { type: 'x_search' },
      { type: 'mcp', name: 'mcp' },
      { type: 'function', name: 'asmltr_sessions', description: 'list', parameters: { type: 'object', properties: {} } },
      { name: 'asmltr_map', description: 'map', inputSchema: { type: 'object', properties: {} } },
    ],
  });
  assert.equal(mixed.session.tools.every((t) => t.type === 'function'), true);
  assert.equal(mixed.session.tools.some((t) => t.type === 'web_search' || t.name === 'web_search'), false);
  assert.equal(mixed.session.tools.some((t) => t.type === 'x_search' || t.name === 'x_search'), false);
  assert.equal(mixed.session.tools.some((t) => t.type === 'mcp' || t.name === 'mcp'), false);
  assert.deepEqual(mixed.session.tools.map((t) => t.name).sort(), ['asmltr_map', 'asmltr_sessions']);
  const grok = require('fs').readFileSync(require('path').join(__dirname, '../shared/speech/converse-grok.js'), 'utf8');
  assert.equal(/type:\s*'web_search'/.test(grok), false);
  assert.equal(/type:\s*'x_search'/.test(grok), false);
  assert.equal(/type:\s*'mcp'/.test(grok), false);
});

test('function_call event → output item sent', async () => {
  MockWS.instances = [];
  const calls = [];
  const session = openSession({
    onFunctionCall: (x) => calls.push(x),
  }, { getKey: async () => 'vault-test-key', WebSocket: MockWS });
  await session.ready;
  const ws = MockWS.instances[0];
  ws.emitMessage({
    type: 'response.function_call_arguments.done',
    name: 'asmltr_sessions',
    call_id: 'c1',
    arguments: '{"x":1}',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'asmltr_sessions');
  assert.equal(calls[0].callId, 'c1');
  assert.deepEqual(calls[0].arguments, { x: 1 });
  session.sendFunctionOutput('c1', { ok: true, text: 'listed' });
  const types = ws.sent.map((x) => JSON.parse(x).type);
  assert.ok(types.includes('conversation.item.create'));
  assert.ok(types.includes('response.create'));
  const created = ws.sent.map((x) => JSON.parse(x)).find((e) => e.type === 'conversation.item.create');
  assert.equal(created.item.type, 'function_call_output');
  assert.equal(created.item.call_id, 'c1');
  const item = functionOutputItem('c1', { ok: true });
  assert.equal(item.item.type, 'function_call_output');
  assert.equal(asRealtimeFunctions([{ type: 'web_search' }]).length, 0);
});

test('forceMessage is xAI force_message, no response.create', async () => {
  MockWS.instances = [];
  const session = openSession({}, { getKey: async () => 'vault-test-key', WebSocket: MockWS });
  await session.ready;
  session.forceMessage("ivy's here");
  const parsed = MockWS.instances[0].sent.map((x) => JSON.parse(x));
  const item = parsed.find((x) => x.type === 'conversation.item.create');
  assert.ok(item);
  assert.equal(item.item.type, 'force_message');
  assert.equal(item.item.role, 'assistant');
  assert.equal(item.item.interruptible, false);
  assert.equal(item.item.content[0].text, "ivy's here");
  assert.equal(parsed.some((x) => x.type === 'response.create' && parsed.indexOf(x) > parsed.indexOf(item)), false);
});
