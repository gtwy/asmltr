'use strict';
/**
 * shared/speech/converse-grok.js -- Grok Voice Live (duplex speech-to-speech) over one
 * xAI realtime WebSocket. Discord stays ear+mouth; this module is the mouth's brain when
 * the converse role is bound (vault xai_voice_api_key present).
 *
 * Transport: wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-2.0
 * Auth: shared/vault.js getSecret('xai_voice_api_key') as { value } -> Authorization Bearer.
 *   NEVER process.env.XAI_API_KEY (that key is for the grok CLI / text path).
 *   NEVER the ElevenLabs voice_id. Built-in Live voice is ara.
 */
const path = require('path');

const LIVE_VOICE = 'ara';
const LIVE_MODEL = 'grok-voice-think-fast-2.0';
const LIVE_URL = 'wss://api.x.ai/v1/realtime?model=' + encodeURIComponent(LIVE_MODEL);
const KEY_NAME = 'xai_voice_api_key';

const DEFAULT_INSTRUCTIONS = [
  'You are in a LIVE Discord voice meeting and your reply will be spoken aloud.',
  'Keep it short and natural -- 1 to 3 sentences. No markdown, no bullet lists, no code blocks, no emoji, no URLs read out.',
  'Do not use tools. Reply from what you already know. Keep the spoken answer brief and conversational.',
].join(' ');

function sessionUpdatePayload(opts) {
  const o = opts || {};
  return {
    type: 'session.update',
    session: {
      voice: LIVE_VOICE,
      instructions: o.instructions || DEFAULT_INSTRUCTIONS,
      tools: [],
      turn_detection: { type: 'server_vad' },
      reasoning: { effort: 'none' },
      audio: {
        input: { format: { type: 'audio/pcm', rate: 24000 } },
        output: { format: { type: 'audio/pcm', rate: 24000 } },
      },
    },
  };
}

function isLastSpeakerRelay({ window, userId, now, muted } = {}) {
  if (muted) return false;
  if (!window || window.userId == null || window.userId === '') return false;
  if (userId == null || userId === '') return false;
  if (String(window.userId) !== String(userId)) return false;
  if (window.expires != null && Number(window.expires) <= Number(now || Date.now())) return false;
  return true;
}

function loadWebSocket(override) {
  if (typeof override === 'function') return override;
  try { return require('ws'); } catch (_) {}
  return require(path.join(__dirname, '..', '..', 'connectors', 'node_modules', 'ws'));
}

async function loadVoiceKey(getSecret) {
  const getter = getSecret || ((name) => require('../vault').getSecret(name, 'ivy live converse'));
  const rec = await getter(KEY_NAME);
  const key = rec && (typeof rec === 'string' ? rec : rec.value);
  if (!key) throw new Error('no xai_voice_api_key');
  return String(key);
}

function applyServerMessage(m, handlers, state) {
  if (!m || typeof m !== 'object') return 'ignore';
  const t = String(m.type || '');
  const h = handlers || {};
  const st = state || {};
  if (t === 'error') {
    if (h.onError) {
      try { h.onError((m.error && m.error.message) || m.message || 'converse error'); } catch (_) {}
    }
    return 'error';
  }
  if (t === 'response.created') {
    if (!st.audioStarted) {
      st.audioStarted = true;
      if (h.onAudioStart) { try { h.onAudioStart(); } catch (_) {} }
    }
    return 'audio-start';
  }
  if (t === 'response.output_audio.delta' || t === 'response.audio.delta') {
    if (!st.audioStarted) {
      st.audioStarted = true;
      if (h.onAudioStart) { try { h.onAudioStart(); } catch (_) {} }
    }
    const b64 = m.delta || m.audio;
    if (b64 && h.onAudio) {
      try { h.onAudio(Buffer.from(b64, 'base64')); } catch (_) {}
    }
    return 'audio';
  }
  if (t === 'response.output_audio_transcript.delta' || t === 'response.audio_transcript.delta' || t === 'response.output_text.delta') {
    if (m.delta) st.transcript = (st.transcript || '') + m.delta;
    return 'transcript-delta';
  }
  if (t === 'response.output_audio_transcript.done' || t === 'response.audio_transcript.done') {
    if (m.transcript) st.transcript = m.transcript;
    return 'transcript';
  }
  if (t === 'response.done') {
    const text = String(st.transcript || '').trim();
    st.audioStarted = false;
    st.transcript = '';
    if (h.onAudioEnd) { try { h.onAudioEnd(text); } catch (_) {} }
    if (text && h.onTranscript) { try { h.onTranscript(text); } catch (_) {} }
    return 'done';
  }
  if (t === 'conversation.item.input_audio_transcription.updated' || t === 'conversation.item.input_audio_transcription.completed') {
    const text = String(m.transcript || '').trim();
    if (text && h.onInputTranscript) { try { h.onInputTranscript(text); } catch (_) {} }
    return 'input-transcript';
  }
  return 'ignore';
}

function attachWs(ws, { onOpen, onMessage, onError, onClose }) {
  if (typeof ws.on === 'function') {
    ws.on('open', onOpen);
    ws.on('message', (data) => onMessage(data));
    ws.on('error', (e) => onError(e));
    ws.on('close', (code) => onClose(code));
    return;
  }
  ws.onopen = onOpen;
  ws.onmessage = (ev) => onMessage(ev && ev.data != null ? ev.data : ev);
  ws.onerror = (e) => onError(e);
  ws.onclose = (e) => onClose(e && e.code);
}

function openSession(handlers, opts) {
  const h = handlers || {};
  const o = opts || {};
  let ws = null;
  let open = false;
  let closed = false;
  const queue = [];
  const state = { audioStarted: false, transcript: '' };

  const ready = (async () => {
    const key = await loadVoiceKey(o.getSecret);
    if (closed) return;
    const WS = loadWebSocket(o.WebSocket);
    const url = o.url || LIVE_URL;
    ws = new WS(url, { headers: { Authorization: 'Bearer ' + key } });
    attachWs(ws, {
      onOpen: () => {
        open = true;
        try { ws.send(JSON.stringify(sessionUpdatePayload(o))); } catch (_) {}
        for (const item of queue.splice(0)) {
          try { ws.send(item); } catch (_) {}
        }
        if (h.onOpen) { try { h.onOpen(); } catch (_) {} }
      },
      onMessage: (data) => {
        if (Buffer.isBuffer(data) && data.length && data[0] !== 0x7b) {
          if (!state.audioStarted) {
            state.audioStarted = true;
            if (h.onAudioStart) { try { h.onAudioStart(); } catch (_) {} }
          }
          if (h.onAudio) { try { h.onAudio(data); } catch (_) {} }
          return;
        }
        const s = typeof data === 'string' ? data : (Buffer.isBuffer(data) ? data.toString('utf8') : String(data || ''));
        let m;
        try { m = JSON.parse(s); } catch (_) { return; }
        applyServerMessage(m, h, state);
      },
      onError: (e) => {
        if (h.onError) { try { h.onError((e && e.message) || 'ws error'); } catch (_) {} }
      },
      onClose: (code) => {
        open = false;
        if (h.onClose) { try { h.onClose({ code }); } catch (_) {} }
      },
    });
  })().catch((e) => {
    if (h.onError) { try { h.onError(e.message || String(e)); } catch (_) {} }
  });

  function send(obj) {
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
    if (open && ws && ws.readyState === 1) {
      try { ws.send(s); } catch (_) {}
    } else if (queue.length < 400) queue.push(s);
  }

  return {
    ready,
    isOpen: () => open,
    pushPcm24(buf) {
      if (closed || !buf || !buf.length) return;
      send({ type: 'input_audio_buffer.append', audio: Buffer.from(buf).toString('base64') });
    },
    cancel() { send({ type: 'response.cancel' }); },
    close() {
      closed = true;
      open = false;
      try { if (ws) ws.close(); } catch (_) {}
    },
  };
}

module.exports = {
  LIVE_VOICE, LIVE_MODEL, LIVE_URL, KEY_NAME, DEFAULT_INSTRUCTIONS,
  sessionUpdatePayload, isLastSpeakerRelay, applyServerMessage, openSession, loadVoiceKey,
};
