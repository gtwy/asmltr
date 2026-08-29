'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolve, IMPLEMENTED, ENGINES, readFileBindings } = require('../shared/speech/voice-engines');
const { applyDeepgramMessage } = require('../shared/speech/realtime-stt');

function withEnv(fn) {
  const prev = {
    ASMLTR_VOICE_ENGINES_FILE: process.env.ASMLTR_VOICE_ENGINES_FILE,
    DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
    ASMLTR_DEEPGRAM_API_KEY: process.env.ASMLTR_DEEPGRAM_API_KEY,
    ASMLTR_TTS_PROVIDER: process.env.ASMLTR_TTS_PROVIDER,
    XAI_API_KEY: process.env.XAI_API_KEY,
    XAI_VOICE_API_KEY: process.env.XAI_VOICE_API_KEY,
  };
  try { return fn(); }
  finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('resolver: Deepgram selected when key present', () => {
  withEnv(() => {
    delete process.env.DEEPGRAM_API_KEY;
    delete process.env.ASMLTR_DEEPGRAM_API_KEY;
    process.env.ASMLTR_VOICE_ENGINES_FILE = path.join(os.tmpdir(), 'asmltr-no-voice-engines-' + process.pid + '.json');
    try { fs.unlinkSync(process.env.ASMLTR_VOICE_ENGINES_FILE); } catch (_) {}
    const r = resolve('realtime_transcribe', { keys: { deepgram_api_key: true } });
    assert.equal(r.engine_id, 'deepgram');
    assert.equal(r.capabilities.provider, 'deepgram');
    assert.equal(r.capabilities.model, 'flux-general-en');
    assert.equal(IMPLEMENTED.has('deepgram'), true);
    assert.equal(fs.existsSync(process.env.ASMLTR_VOICE_ENGINES_FILE), false);
  });
});

test('resolver: openai-live-transcribe when key absent', () => {
  withEnv(() => {
    delete process.env.DEEPGRAM_API_KEY;
    delete process.env.ASMLTR_DEEPGRAM_API_KEY;
    process.env.ASMLTR_VOICE_ENGINES_FILE = path.join(os.tmpdir(), 'asmltr-no-voice-engines-' + process.pid + '.json');
    try { fs.unlinkSync(process.env.ASMLTR_VOICE_ENGINES_FILE); } catch (_) {}
    const r = resolve('realtime_transcribe', { keys: { deepgram_api_key: false } });
    assert.equal(r.engine_id, 'openai-live-transcribe');
    assert.equal(r.capabilities.provider, 'openai');
    assert.equal(fs.existsSync(process.env.ASMLTR_VOICE_ENGINES_FILE), false);
  });
});

test('resolver: does not write a hard deepgram bind', () => {
  withEnv(() => {
    const f = path.join(os.tmpdir(), 'asmltr-voice-engines-must-not-write-' + process.pid + '.json');
    process.env.ASMLTR_VOICE_ENGINES_FILE = f;
    try { fs.unlinkSync(f); } catch (_) {}
    resolve('realtime_transcribe', { keys: { deepgram_api_key: true } });
    resolve('realtime_transcribe', { keys: { deepgram_api_key: false } });
    assert.equal(fs.existsSync(f), false);
    assert.deepEqual(readFileBindings(), {});
  });
});

test('resolver: file binding wins over implicit Deepgram', () => {
  withEnv(() => {
    const f = path.join(os.tmpdir(), 'asmltr-voice-engines-explicit-' + process.pid + '.json');
    fs.writeFileSync(f, JSON.stringify({ version: 1, bindings: { realtime_transcribe: 'openai-live-transcribe' } }));
    process.env.ASMLTR_VOICE_ENGINES_FILE = f;
    const r = resolve('realtime_transcribe', { keys: { deepgram_api_key: true } });
    assert.equal(r.engine_id, 'openai-live-transcribe');
    fs.unlinkSync(f);
  });
});

test('synthesize default stays openai-tts (no elevenlabs bind)', () => {
  withEnv(() => {
    delete process.env.ASMLTR_TTS_PROVIDER;
    process.env.ASMLTR_VOICE_ENGINES_FILE = path.join(os.tmpdir(), 'asmltr-no-voice-engines-tts-' + process.pid + '.json');
    try { fs.unlinkSync(process.env.ASMLTR_VOICE_ENGINES_FILE); } catch (_) {}
    const r = resolve('synthesize', { keys: { elevenlabs_api_key: false } });
    assert.equal(r.engine_id, 'openai-tts');
    assert.equal(ENGINES.deepgram.model, 'flux-general-en');
  });
});

test('Flux TurnInfo EndOfTurn is a final; Update is a partial', () => {
  const finals = [];
  const partials = [];
  const h = { onFinal: (t) => finals.push(t), onPartial: (t) => partials.push(t) };
  assert.equal(applyDeepgramMessage({ type: 'TurnInfo', event: 'Update', transcript: 'hello there' }, h), 'partial');
  assert.equal(applyDeepgramMessage({ type: 'TurnInfo', event: 'EndOfTurn', transcript: 'hello there friend' }, h), 'final');
  assert.deepEqual(partials, ['hello there']);
  assert.deepEqual(finals, ['hello there friend']);
});

test('Deepgram adapter uses token subprotocol (Node global WebSocket)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../shared/speech/realtime-stt.js'), 'utf8');
  assert.match(src, /new WebSocket\(url, \['token', key\]\)/);
  assert.equal(/headers:\s*\{\s*Authorization/.test(src), false);
});

test('converse implicit grok-voice when xai_voice_api_key present; null when absent', () => {
  withEnv(() => {
    process.env.ASMLTR_VOICE_ENGINES_FILE = path.join(os.tmpdir(), 'asmltr-no-voice-engines-converse-' + process.pid + '.json');
    try { fs.unlinkSync(process.env.ASMLTR_VOICE_ENGINES_FILE); } catch (_) {}
    const on = resolve('converse', { keys: { xai_voice_api_key: true } });
    assert.equal(on.engine_id, 'grok-voice');
    assert.equal(IMPLEMENTED.has('grok-voice'), true);
    assert.equal(ENGINES['grok-voice'].key, 'xai_voice_api_key');
    const off = resolve('converse', { keys: { xai_voice_api_key: false } });
    assert.equal(off.engine_id, null);
    assert.equal(fs.existsSync(process.env.ASMLTR_VOICE_ENGINES_FILE), false);
  });
});

test('resolver: converse grok-voice when xai_voice_api_key present', () => {
  withEnv(() => {
    process.env.ASMLTR_VOICE_ENGINES_FILE = path.join(os.tmpdir(), 'asmltr-no-voice-engines-converse-' + process.pid + '.json');
    try { fs.unlinkSync(process.env.ASMLTR_VOICE_ENGINES_FILE); } catch (_) {}
    const r = resolve('converse', { keys: { xai_voice_api_key: true } });
    assert.equal(r.engine_id, 'grok-voice');
    assert.equal(r.capabilities.provider, 'xai');
    assert.equal(r.capabilities.model, 'grok-voice-think-fast-2.0');
    assert.equal(ENGINES['grok-voice'].key, 'xai_voice_api_key');
    assert.equal(IMPLEMENTED.has('grok-voice'), true);
  });
});

test('resolver: converse unbound when xai_voice_api_key missing (Flux+CLI+TTS fallback)', () => {
  withEnv(() => {
    process.env.ASMLTR_VOICE_ENGINES_FILE = path.join(os.tmpdir(), 'asmltr-no-voice-engines-converse-off-' + process.pid + '.json');
    try { fs.unlinkSync(process.env.ASMLTR_VOICE_ENGINES_FILE); } catch (_) {}
    delete process.env.XAI_API_KEY;
    delete process.env.XAI_VOICE_API_KEY;
    const r = resolve('converse', { keys: { xai_voice_api_key: false } });
    assert.equal(r.engine_id, null);
    assert.equal(r.engine, null);
    assert.equal(fs.existsSync(process.env.ASMLTR_VOICE_ENGINES_FILE), false);
  });
});

test('keyPresent does not treat process.env.XAI_API_KEY as xai_voice_api_key', () => {
  const { keyPresent } = require('../shared/speech/voice-engines');
  withEnv(() => {
    process.env.XAI_API_KEY = 'must-not-count';
    delete process.env.XAI_VOICE_API_KEY;
    assert.equal(keyPresent('xai_voice_api_key', {}), false);
    assert.equal(keyPresent('xai_voice_api_key', { keys: { xai_voice_api_key: true } }), true);
  });
});
