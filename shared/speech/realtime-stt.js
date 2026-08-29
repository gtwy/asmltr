'use strict';
/**
 * shared/speech/realtime-stt.js — streaming speech-to-text over the OpenAI GA Realtime API (epic #135,
 * #140). Opens a transcription session, accepts PCM16/24kHz/mono audio as it arrives, and emits live
 * partial transcripts + server-VAD turn boundaries. This is the shared mechanism the Discord voice
 * bridge and the app can both use instead of batch clip STT — realtime captions + turn-taking that the
 * server decides (not a fixed silence timer).
 *
 * Transport: Node's global WebSocket (Node ≥22 — no dependency) to `wss://api.openai.com/v1/realtime`,
 * authenticated with an EPHEMERAL transcription secret passed as a subprotocol (the browser-realtime
 * pattern — the real key never rides the socket). The session (model, format, server_vad) is baked into
 * the minted secret by stt.realtimeToken, so no session.update is needed after connect.
 *
 * Audio: the API input is PCM16 little-endian, 24kHz, mono. Discord delivers 48kHz stereo, so callers
 * convert with `pcm48StereoToPcm24Mono()` before `pushPcm24()`.
 */
const stt = require('./stt');
const secrets = require('../secrets');

// The live streaming model (gpt-live-transcribe) emits each delta as a SLIDING WINDOW of the most
// recent words (it drops words off the front as it advances), not an incremental token — and never
// sends a `completed` event. Reconstruct the full running transcript by appending only the part of the
// new window that isn't already the tail of what we have (largest word-overlap).
function mergeWindow(full, window) {
  const fw = full ? full.trim().split(/\s+/).filter(Boolean) : [];
  const ww = (window || '').trim().split(/\s+/).filter(Boolean);
  if (!ww.length) return full || '';
  if (!fw.length) return ww.join(' ');
  const norm = (w) => w.toLowerCase().replace(/[.,!?;:]+$/, '');
  const maxK = Math.min(fw.length, ww.length);
  let best = 0;
  for (let k = maxK; k >= 1; k--) {
    let ok = true;
    for (let i = 0; i < k; i++) { if (norm(fw[fw.length - k + i]) !== norm(ww[i])) { ok = false; break; } }
    if (ok) { best = k; break; }
  }
  return fw.concat(ww.slice(best)).join(' ');
}

// Downsample 48kHz stereo s16le → 24kHz mono s16le (average L+R, then 2-tap average + decimate by 2).
function pcm48StereoToPcm24Mono(buf) {
  const frames = buf.length >> 2;          // 4 bytes per stereo frame (L16 + R16)
  const outSamples = frames >> 1;          // 48k→24k halves the rate
  const out = Buffer.allocUnsafe(outSamples * 2);
  for (let j = 0; j < outSamples; j++) {
    const a = j << 3;                       // stereo frame 2j  → byte offset 2j*4 = 8j
    const b = a + 4;                        // stereo frame 2j+1 → byte 8j+4
    const m0 = (buf.readInt16LE(a) + buf.readInt16LE(a + 2)) >> 1; // L+R → mono
    const m1 = (buf.readInt16LE(b) + buf.readInt16LE(b + 2)) >> 1;
    let s = (m0 + m1) >> 1;                  // 2-tap lowpass + decimate
    if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
    out.writeInt16LE(s, j * 2);
  }
  return out;
}

/**
 * Open a streaming transcription session.
 * @param {object} handlers
 *   onPartial(text)   — running transcript for the in-progress turn (fires on each delta)
 *   onFinal(text)     — a completed turn (server-VAD decided the boundary)
 *   onSpeechStart()   — server VAD detected speech onset
 *   onSpeechStop()    — server VAD detected end of speech
 *   onOpen()          — socket connected and ready
 *   onError(err)      — API/transport error (string or Error)
 *   onClose(info)     — socket closed
 * @param {object} [opts] { model } — transcription model (default from stt.config)
 * @returns {{ pushPcm24(Buffer):void, close():void, isOpen():boolean, ready:Promise }}
 */
function fluxEventName(m) {
  return String((m && (m.event || m.event_type || m.EventType || m.eventType)) || '');
}

function applyDeepgramMessage(m, handlers) {
  if (!m || typeof m !== 'object') return;
  const h = handlers || {};
  const typ = String(m.type || m.event || '');
  if (/^error$/i.test(typ) || m.code === 'ERROR') {
    if (h.onError) {
      try { h.onError((m.message || m.description || m.error || 'deepgram error')); } catch (_) {}
    }
    return 'error';
  }
  if (/^connected$/i.test(typ)) {
    if (h.onOpen) { try { h.onOpen(); } catch (_) {} }
    return 'open';
  }
  const text = String(m.transcript || (m.channel && m.channel.alternatives && m.channel.alternatives[0] && m.channel.alternatives[0].transcript) || '').trim();
  const ev = fluxEventName(m);
  if (/EndOfTurn/i.test(ev) || (typ === 'Results' && m.is_final)) {
    if (text && h.onFinal) { try { h.onFinal(text); } catch (_) {} }
    return 'final';
  }
  if (text && (typ === 'TurnInfo' || typ === 'Results' || /StartOfTurn|Update|EagerEndOfTurn|TurnResumed/i.test(ev))) {
    if (h.onPartial) { try { h.onPartial(text); } catch (_) {} }
    return 'partial';
  }
  return 'ignore';
}

function openDeepgramSession(handlers = {}, opts = {}) {
  const h = handlers;
  let ws = null;
  let open = false;
  let closed = false;
  const queue = [];

  const ready = (async () => {
    const key = await secrets.get(opts.keyName || 'deepgram_api_key');
    if (!key) throw new Error('no deepgram_api_key');
    if (closed) return;
    const model = opts.model || 'flux-general-en';
    const rate = Number(opts.sampleRate) || 24000;
    const url = 'wss://api.deepgram.com/v2/listen?model=' + encodeURIComponent(model)
      + '&encoding=linear16&sample_rate=' + encodeURIComponent(String(rate));
    ws = new WebSocket(url, { headers: { Authorization: 'Token ' + key } });
    ws.onopen = () => {
      open = true;
      for (const b of queue.splice(0)) {
        try { ws.send(b); } catch (_) {}
      }
      if (h.onOpen) { try { h.onOpen(); } catch (_) {} }
    };
    ws.onmessage = (ev) => {
      const raw = (ev && ev.data != null) ? ev.data : ev;
      const s = typeof raw === 'string' ? raw : (Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || ''));
      let m;
      try { m = JSON.parse(s); } catch (_) { return; }
      applyDeepgramMessage(m, h);
    };
    ws.onerror = (e) => { if (h.onError) { try { h.onError((e && e.message) || 'ws error'); } catch (_) {} } };
    ws.onclose = (e) => { open = false; if (h.onClose) { try { h.onClose({ code: e && e.code }); } catch (_) {} } };
  })().catch((e) => { if (h.onError) { try { h.onError(e.message || String(e)); } catch (_) {} } });

  return {
    ready,
    isOpen: () => open,
    pushPcm24(buf) {
      if (closed || !buf || !buf.length) return;
      if (open && ws && ws.readyState === 1) {
        try { ws.send(buf); } catch (_) {}
      } else if (queue.length < 400) queue.push(buf);
    },
    commit() {},
    endTurn() {},
    close() {
      closed = true;
      open = false;
      try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (_) {}
      try { ws && ws.close(); } catch (_) {}
    },
  };
}


function openSession(handlers = {}, opts = {}) {
  const provider = String(opts.provider || '').toLowerCase();
  if (provider === 'deepgram') return openDeepgramSession(handlers, opts);
  const h = handlers;
  let ws = null;
  let open = false;
  let closed = false;
  let cur = '';                 // accumulates the in-progress turn's deltas
  const queue = [];             // audio captured before the socket is ready

  const ready = (async () => {
    const tok = await stt.realtimeToken({ model: opts.model });
    if (closed) return;
    // GA transport: ephemeral secret as a subprotocol (no beta marker — that shape is retired).
    ws = new WebSocket('wss://api.openai.com/v1/realtime', ['realtime', 'openai-insecure-api-key.' + tok.value]);
    ws.onopen = () => {
      open = true;
      // flush anything captured during connect
      for (const b of queue.splice(0)) { try { ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b })); } catch (_) {} }
      if (h.onOpen) { try { h.onOpen(); } catch (_) {} }
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      switch (m.type) {
        case 'conversation.item.input_audio_transcription.delta':
          // live model → each delta is a sliding window (merge); batch model → incremental (append).
          if (m.delta) { cur = opts.live ? mergeWindow(cur, m.delta) : (cur + m.delta); if (h.onPartial) { try { h.onPartial(cur); } catch (_) {} } }
          break;
        case 'conversation.item.input_audio_transcription.completed': {
          const text = (m.transcript || cur || '').trim(); cur = '';
          if (text && h.onFinal) { try { h.onFinal(text); } catch (_) {} }
          break;
        }
        case 'input_audio_buffer.speech_started': if (h.onSpeechStart) { try { h.onSpeechStart(); } catch (_) {} } break;
        case 'input_audio_buffer.speech_stopped': if (h.onSpeechStop) { try { h.onSpeechStop(); } catch (_) {} } break;
        case 'error': if (h.onError) { try { h.onError((m.error && m.error.message) || 'realtime error'); } catch (_) {} } break;
        default: break;
      }
    };
    ws.onerror = (e) => { if (h.onError) { try { h.onError((e && e.message) || 'ws error'); } catch (_) {} } };
    ws.onclose = (e) => { open = false; if (h.onClose) { try { h.onClose({ code: e && e.code }); } catch (_) {} } };
  })().catch((e) => { if (h.onError) { try { h.onError(e.message || String(e)); } catch (_) {} } });

  return {
    ready,
    isOpen: () => open,
    // Append 24kHz mono PCM16. Buffers until the socket is ready so nothing is dropped during connect.
    pushPcm24(buf) {
      if (closed || !buf || !buf.length) return;
      const b64 = buf.toString('base64');
      if (open && ws) { try { ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 })); } catch (_) {} }
      else if (queue.length < 400) queue.push(b64); // cap the pre-connect backlog (~8s @ 20ms frames)
    },
    // Finalize the current turn for the live model (no server-VAD): commit the audio buffer, which
    // flushes the model's trailing words AND makes it emit a `completed` event with the clean full
    // transcript (→ onFinal). The caller commits on its own end-of-speech signal (Discord VAD).
    commit() { if (open && ws) { try { ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' })); } catch (_) {} } },
    // Fallback finalize from the reconstructed partial (used if a commit path isn't available).
    endTurn() { const t = (cur || '').trim(); cur = ''; if (t && h.onFinal) { try { h.onFinal(t); } catch (_) {} } },
    close() { closed = true; open = false; try { ws && ws.close(); } catch (_) {} },
  };
}

module.exports = { openSession, openDeepgramSession, applyDeepgramMessage, fluxEventName, pcm48StereoToPcm24Mono, mergeWindow };
