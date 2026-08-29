'use strict';
/**
 * shared/speech/converse-grok.js — Ivy Live duplex speech-to-speech.
 *
 * ONE WebSocket replaces Flux → grok CLI spawn → sentence HTTP TTS:
 *   wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-2.0  (alias grok-voice-latest)
 *
 * Locked: session.voice = "ara" (never eve, never an ElevenLabs voice_id).
 *         session.tools = []  (no web_search, no MCP, no functions).
 *         turn_detection = { type: "server_vad", threshold: 0.85, prefix_padding_ms: 400, silence_duration_ms: 800, interrupt_response: false }
 *         reasoning.effort = "none"
 *         PCM 24 kHz mono s16le both ways.
 *
 * Auth: vault secret `xai_voice_api_key` ({ value }) via shared/vault.js getSecret.
 * NEVER process.env.XAI_API_KEY. NEVER pass this key to the grok CLI child.
 */
const path = require('path');

const KEY_NAME = 'xai_voice_api_key';
const MODEL = 'grok-voice-think-fast-2.0';
const WS_URL = 'wss://api.x.ai/v1/realtime?model=' + MODEL;
const VOICE = 'ara';
const VOICES = Object.freeze(['ara', 'eve', 'leo', 'rex', 'sal']);
const KEYTERMS = Object.freeze(['Ivy', 'ivy', 'IV']); // STT bias; IV is 2 chars (API max 50)

function loadWebSocket(opts) {
  if (opts && typeof opts.WebSocket === 'function') return opts.WebSocket;
  try { return require('ws'); } catch (_) {}
  try {
    return require(require.resolve('ws', { paths: [path.join(__dirname, '..', '..', 'connectors')] }));
  } catch (e) {
    throw new Error('converse-grok needs the ws package (pass opts.WebSocket in tests)');
  }
}

function secretValue(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data.trim();
  if (typeof data.value === 'string') return data.value.trim();
  return '';
}

/** session.update payload. voice is ALWAYS ara; tools ALWAYS empty. Extra opts cannot override those. */
function buildSessionUpdate(opts) {
  const instructions = (opts && opts.instructions) || '';
  const session = {
    voice: VOICE,
    tools: [],
    turn_detection: { type: 'server_vad', threshold: 0.85, prefix_padding_ms: 400, silence_duration_ms: 800, interrupt_response: false },
    reasoning: { effort: 'none' },
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        transcription: { keyterms: KEYTERMS.slice() },
      },
      output: { format: { type: 'audio/pcm', rate: 24000 } },
    },
  };
  if (instructions) session.instructions = String(instructions);
  return { type: 'session.update', session };
}

function appendPcmEvent(pcm24) {
  const buf = Buffer.isBuffer(pcm24) ? pcm24 : Buffer.from(pcm24 || []);
  return { type: 'input_audio_buffer.append', audio: buf.toString('base64') };
}

/** Last-speaker only. Empty speakerId → nobody is addressee yet → do not forward. */
function shouldRelayPcm({ speakerId, userId, muted } = {}) {
  if (muted) return false;
  const a = speakerId != null && speakerId !== '' ? String(speakerId) : '';
  const b = userId != null && userId !== '' ? String(userId) : '';
  return !!a && a === b;
}

async function fetchVoiceApiKey(opts) {
  if (opts && typeof opts.getKey === 'function') {
    const k = await opts.getKey();
    return k ? String(k) : '';
  }
  if (opts && opts.apiKey) return String(opts.apiKey);
  const v = await require('../vault').getSecret(KEY_NAME, 'ivy live converse');
  return secretValue(v);
}

function decodeAudioDelta(ev) {
  const b64 = ev && (ev.delta || ev.audio);
  if (!b64 || typeof b64 !== 'string') return null;
  try { return Buffer.from(b64, 'base64'); } catch (_) { return null; }
}

function pcm24MonoToPcm48Stereo(buf) {
  const src = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const samples = src.length >> 1;
  const out = Buffer.allocUnsafe(samples * 8);
  let o = 0;
  for (let i = 0; i < samples; i++) {
    const s = src.readInt16LE(i * 2);
    out.writeInt16LE(s, o); o += 2;
    out.writeInt16LE(s, o); o += 2;
    out.writeInt16LE(s, o); o += 2;
    out.writeInt16LE(s, o); o += 2;
  }
  return out;
}

function applyServerEvent(ev, handlers) {
  if (!ev || typeof ev !== 'object') return;
  const h = handlers || {};
  const typ = String(ev.type || '');
  if (typ === 'error' || typ === 'session.error') {
    if (h.onError) {
      try { h.onError(ev.error && (ev.error.message || ev.error.code) || ev.message || 'converse error'); } catch (_) {}
    }
    return 'error';
  }
  if (typ === 'input_audio_buffer.speech_started') {
    if (h.onSpeechStart) { try { h.onSpeechStart(ev); } catch (_) {} }
    return 'speech_start';
  }
  if (typ === 'input_audio_buffer.speech_stopped') {
    if (h.onSpeechStop) { try { h.onSpeechStop(ev); } catch (_) {} }
    return 'speech_stop';
  }
  if (typ === 'response.output_audio.delta' || typ === 'response.audio.delta') {
    const pcm = decodeAudioDelta(ev);
    if (pcm && pcm.length && h.onAudio) { try { h.onAudio(pcm); } catch (_) {} }
    return 'audio';
  }
  if (typ === 'response.output_audio.done' || typ === 'response.audio.done') {
    if (h.onAudioDone) { try { h.onAudioDone(ev); } catch (_) {} }
    return 'audio_done';
  }
  if (typ === 'response.done' || typ === 'response.completed') {
    if (h.onResponseDone) { try { h.onResponseDone(ev); } catch (_) {} }
    return 'done';
  }
  if (typ === 'response.cancelled' || typ === 'response.output_audio.interrupted') {
    if (h.onCancelled) { try { h.onCancelled(ev); } catch (_) {} }
    return 'cancelled';
  }
  if (typ === 'response.output_text.delta' || typ === 'response.audio_transcript.delta' || typ === 'response.output_audio_transcript.delta') {
    const t = ev.delta || ev.text || '';
    if (t && h.onAssistantDelta) { try { h.onAssistantDelta(String(t)); } catch (_) {} }
    return 'assistant_delta';
  }
  if (typ === 'response.output_text.done' || typ === 'response.audio_transcript.done' || typ === 'response.output_audio_transcript.done') {
    const t = ev.transcript || ev.text || ev.delta || '';
    if (t && h.onAssistantText) { try { h.onAssistantText(String(t)); } catch (_) {} }
    return 'assistant_text';
  }
  if (typ === 'conversation.item.input_audio_transcription.completed' || typ === 'conversation.item.input_audio_transcription.updated') {
    const t = (ev.transcript || (ev.item && ev.item.transcript) || ev.text || '').trim();
    if (t && h.onUserTranscript) { try { h.onUserTranscript(t, ev); } catch (_) {} }
    return 'user_transcript';
  }
  if (typ === 'session.updated' || typ === 'session.created') return 'session';
  return undefined;
}

function attach(ws, ev, fn) {
  if (!ws) return;
  if (typeof ws.on === 'function') { ws.on(ev, fn); return; }
  if (ev === 'open') ws.onopen = fn;
  else if (ev === 'message') ws.onmessage = (e) => fn(e && e.data != null ? e.data : e);
  else if (ev === 'error') ws.onerror = fn;
  else if (ev === 'close') ws.onclose = (e) => fn(e && e.code, e && e.reason);
}

/**
 * Open a converse WebSocket.
 * @param {object} handlers onOpen, onAudio(pcm24), onSpeechStart, onSpeechStop, onResponseDone,
 *   onCancelled, onAssistantText, onAssistantDelta, onUserTranscript, onError, onClose
 * @param {object} [opts] { getKey, apiKey, WebSocket, instructions }
 * @returns {{ pushPcm24(Buffer):void, cancel():void, close():void, isOpen():boolean, ready:Promise }}
 */
function openSession(handlers, opts) {
  const h = handlers || {};
  const WS = loadWebSocket(opts);
  let ws = null;
  let opened = false;
  const pending = [];

  function sendJson(obj) {
    if (!ws || ws.readyState !== 1) {
      if (obj) pending.push(obj);
      return;
    }
    try { ws.send(JSON.stringify(obj)); } catch (e) { if (h.onError) try { h.onError(e.message || e); } catch (_) {} }
  }

  const ready = (async () => {
    const apiKey = await fetchVoiceApiKey(opts || {});
    if (!apiKey) throw new Error(KEY_NAME + ' missing');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('converse ws timeout')), 12000);
      const ok = (v) => { clearTimeout(timer); resolve(v); };
      const fail = (e) => { clearTimeout(timer); reject(e); };
      ws = new WS(WS_URL, { headers: { Authorization: 'Bearer ' + apiKey } });
      attach(ws, 'open', () => {
        opened = true;
        try { ws.send(JSON.stringify(buildSessionUpdate(opts))); } catch (e) { if (h.onError) try { h.onError(e.message || e); } catch (_) {} }
        while (pending.length) {
          const item = pending.shift();
          try { ws.send(JSON.stringify(item)); } catch (_) {}
        }
        if (h.onOpen) { try { h.onOpen(); } catch (_) {} }
        ok(true);
      });
      attach(ws, 'message', (data) => {
        const raw = Buffer.isBuffer(data) || data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8') : String(data);
        if (!raw || raw.charCodeAt(0) !== 0x7b) return;
        let ev;
        try { ev = JSON.parse(raw); } catch (_) { return; }
        applyServerEvent(ev, h);
      });
      attach(ws, 'error', (e) => {
        if (h.onError) try { h.onError((e && e.message) || e); } catch (_) {}
        if (!opened) fail(e instanceof Error ? e : new Error((e && e.message) || 'ws error'));
      });
      attach(ws, 'close', (code, reason) => {
        opened = false;
        if (h.onClose) try { h.onClose({ code, reason: reason ? String(reason) : '' }); } catch (_) {}
      });
    });
    return true;
  })();
  ready.catch((e) => { if (h.onError) try { h.onError(e.message || String(e)); } catch (_) {} });

  return {
    pushPcm24(buf) {
      if (!buf || !buf.length) return;
      sendJson(appendPcmEvent(buf));
    },
    cancel() { sendJson({ type: 'response.cancel' }); },
    close() {
      opened = false;
      pending.length = 0;
      try { if (ws) ws.close(); } catch (_) {}
      ws = null;
    },
    isOpen() { return !!(opened && ws && ws.readyState === 1); },
    ready,
  };
}

module.exports = {
  KEY_NAME, MODEL, WS_URL, VOICE, KEYTERMS,
  secretValue, buildSessionUpdate, appendPcmEvent, shouldRelayPcm, applyServerEvent,
  fetchVoiceApiKey, openSession, pcm24MonoToPcm48Stereo, decodeAudioDelta,
};
