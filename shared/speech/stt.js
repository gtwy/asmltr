'use strict';
/**
 * asmltr core speech layer — provider-agnostic speech-to-text (transcription).
 *
 * The counterpart to tts.js: turns a short audio clip (recorded in a browser / connector) into text
 * via a real transcription model. OpenAI (`/v1/audio/transcriptions`) is the default because its key
 * is already on hand and the same model the Discord voice bridge uses (`gpt-4o-transcribe`). The
 * shape leaves room for other providers. Config comes from env, with GUI/TUI-set overrides persisted
 * to the asmltr state dir so a model change applies to the next clip with no restart:
 *   ASMLTR_STT_PROVIDER (openai) · ASMLTR_STT_MODEL (gpt-4o-transcribe) · ASMLTR_STT_LANGUAGE (en)
 *   ASMLTR_STT_KEY_NAME (openai_api_key)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const secrets = require('../secrets');

function stateDir() {
  const d = process.env.ASMLTR_STATE_DIR || path.join(os.homedir(), '.asmltr');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}
const cfgFile = () => path.join(stateDir(), 'stt-config');
function persisted() { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) || {}; } catch (_) { return {}; } }

function config() {
  const p = persisted();
  const num = (v, d, lo, hi) => { let n = Number(v); if (!Number.isFinite(n)) n = d; return Math.max(lo, Math.min(hi, n)); };
  return {
    provider: p.provider || process.env.ASMLTR_STT_PROVIDER || 'openai',
    model: p.model || process.env.ASMLTR_STT_MODEL || 'gpt-4o-transcribe',
    // language: '' means auto-detect; default 'en' (empty string is a valid, persistable choice).
    language: p.language !== undefined ? p.language : (process.env.ASMLTR_STT_LANGUAGE || 'en'),
    // client-side VAD (end-of-utterance) tuning for push-to-talk surfaces (the mobile overlay). These are
    // hints the client applies; kept here so they're one global, GUI/TUI-editable setting.
    vad_endpoint_ms: num(p.vad_endpoint_ms, 1600, 400, 6000),   // silence AFTER speech that ends a turn — raise if it cuts you off between sentences
    vad_start_ms: num(p.vad_start_ms, 8000, 2000, 30000),       // give up if no speech starts within this
    vad_sensitivity: num(p.vad_sensitivity, 50, 0, 100),        // 0 = only loud speech triggers, 100 = very sensitive
    // Wake word (hands-free trigger). Default phrase derives from the assistant name ("hey <name>").
    wake_enabled: p.wake_enabled === undefined ? false : !!p.wake_enabled,
    wake_phrase: (p.wake_phrase !== undefined && p.wake_phrase !== null) ? String(p.wake_phrase) : `hey ${process.env.ASSISTANT_NAME || 'assistant'}`,
    wake_sensitivity: num(p.wake_sensitivity, 50, 0, 100),      // detection strictness (higher = more triggers, more false-accepts)
    // Stop phrases: say one of these and the turn is dropped (NOT sent to the LLM) + listening ends —
    // hands-free "that's all". Comma-separated; matched against the transcript before it's dispatched.
    stop_phrases: (p.stop_phrases !== undefined && p.stop_phrases !== null) ? String(p.stop_phrases) : "that's all, i'm done, thank you, stop listening, never mind, goodbye",
    keyName: process.env.ASMLTR_STT_KEY_NAME || 'openai_api_key',
  };
}

function setConfig(partial) {
  const next = persisted();
  for (const k of ['provider', 'model', 'language']) {
    if (!partial || partial[k] === undefined) continue;
    if (partial[k] === null) delete next[k];
    else next[k] = String(partial[k]);
  }
  for (const k of ['vad_endpoint_ms', 'vad_start_ms', 'vad_sensitivity', 'wake_sensitivity']) {
    if (!partial || partial[k] === undefined) continue;
    if (partial[k] === null) delete next[k];
    else next[k] = Number(partial[k]);
  }
  if (partial && partial.wake_enabled !== undefined) next.wake_enabled = !!partial.wake_enabled;
  if (partial && partial.wake_phrase !== undefined) { if (partial.wake_phrase === null) delete next.wake_phrase; else next.wake_phrase = String(partial.wake_phrase); }
  if (partial && partial.stop_phrases !== undefined) { if (partial.stop_phrases === null) delete next.stop_phrases; else next.stop_phrases = String(partial.stop_phrases); }
  try { fs.writeFileSync(cfgFile(), JSON.stringify(next)); } catch (_) {}
  return config();
}

/**
 * Transcribe an audio buffer → { text, model }. THE one STT entry point for all of asmltr
 * (core /v2/transcribe + connectors like Discord voice). Pass per-call overrides to vary
 * model/language/key/prompt without touching global config.
 * @param {Buffer} buffer  encoded audio (webm/opus, wav, mp4, mp3…)
 * @param {object} [opts]  { filename, mime, model, language, keyName, prompt }
 */
async function transcribe(buffer, opts = {}) {
  const cfg = config();
  if (cfg.provider !== 'openai') throw new Error(`unknown STT provider: ${cfg.provider}`);
  const key = await secrets.get(opts.keyName || cfg.keyName);
  if (!key) throw new Error(`no STT key (secret '${opts.keyName || cfg.keyName}' is empty)`);
  const model = opts.model || cfg.model;
  const language = opts.language !== undefined ? opts.language : cfg.language;

  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: opts.mime || 'audio/webm' }), opts.filename || 'audio.webm');
  fd.append('model', model);
  if (language) fd.append('language', language);
  if (opts.prompt) fd.append('prompt', opts.prompt); // bias the decoder (e.g. toward a wake word)
  fd.append('response_format', 'json');

  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd,
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`openai stt ${r.status} ${t.slice(0, 200)}`); }
  const j = await r.json().catch(() => ({}));
  // `duration` is only present when the model+format return it (verbose_json / some models). Fall back to
  // the clip byte length so the caller can estimate audio seconds for cost accounting (see shared/usage).
  return { text: (j.text || '').trim(), model, duration: j.duration, bytes: buffer.length };
}

/**
 * Transcribe with SPEAKER DIARIZATION (roadmap §B2 / epic #113). OpenAI gpt-4o-transcribe-diarize with
 * response_format=diarized_json → { text, segments:[{speaker,start,end,text}], model }. Optionally LABEL
 * known people by name: opts.known = [{ name, audio:Buffer, mime }] (≤4) → known_speaker_references.
 * Same ~25MB/request cap as transcribe(), so long files are chunked by the caller; cross-chunk speaker
 * consistency is the caller's job (pass known refs, or re-cluster) — see docs/VOICE-CAPABILITY-BUILD.md.
 */
async function transcribeDiarized(buffer, opts = {}) {
  const cfg = config();
  const key = await secrets.get(opts.keyName || cfg.keyName);
  if (!key) throw new Error(`no STT key (secret '${opts.keyName || cfg.keyName}' is empty)`);
  const model = opts.model || 'gpt-4o-transcribe-diarize';
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: opts.mime || 'audio/webm' }), opts.filename || 'audio.webm');
  fd.append('model', model);
  fd.append('response_format', 'diarized_json');
  if (opts.language) fd.append('language', opts.language);
  for (const k of (opts.known || []).slice(0, 4)) {
    if (k && k.name && k.audio) {
      fd.append('known_speaker_names[]', k.name);
      fd.append('known_speaker_references[]', new Blob([k.audio], { type: k.mime || 'audio/webm' }), (k.name || 'ref') + '.webm');
    }
  }
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd,
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`openai diarize ${r.status} ${t.slice(0, 200)}`); }
  const j = await r.json().catch(() => ({}));
  const segments = Array.isArray(j.segments) ? j.segments.map((s) => ({
    speaker: s.speaker != null ? String(s.speaker) : null,
    start: s.start != null ? +s.start : null, end: s.end != null ? +s.end : null,
    text: (s.text || '').trim(),
  })).filter((s) => s.text) : [];
  const text = (j.text && j.text.trim()) || segments.map((s) => (s.speaker ? s.speaker + ': ' : '') + s.text).join('\n');
  return { text, segments, model, duration: j.duration, bytes: buffer.length };
}

/**
 * Mint a short-lived ephemeral token for an OpenAI Realtime *transcription* session (streaming STT
 * with server-side VAD). The browser uses this token to connect to OpenAI directly (WebRTC) and
 * receive streaming transcript deltas + speech-start/stop events — the real key never leaves here.
 * @param {object} [opts] { model } — overrides the configured STT model
 * @returns {{ value:string, expires_at:number, model:string }}
 */
async function realtimeToken(opts = {}) {
  const cfg = config();
  if (cfg.provider !== 'openai') throw new Error(`realtime STT requires the openai provider (have ${cfg.provider})`);
  const key = await secrets.get(cfg.keyName);
  if (!key) throw new Error(`no STT key (secret '${cfg.keyName}' is empty)`);
  const model = opts.model || cfg.model;
  const transcription = { model };
  if (cfg.language) transcription.language = cfg.language;
  const input = {
    format: { type: 'audio/pcm', rate: 24000 },
    transcription,
    noise_reduction: { type: 'near_field' },
  };
  // server_vad = OpenAI detects speech start/stop (~600ms silence ends a turn → auto-send trigger). The
  // gpt-live-transcribe streaming model does NOT support server-side turn detection (it streams partials
  // continuously; the client decides turn boundaries), so only request it for models that accept it.
  if (!/live-transcribe/i.test(model)) {
    input.turn_detection = { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 600 };
  }
  const body = { session: { type: 'transcription', audio: { input } } };
  const r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `realtime token ${r.status}`);
  return { value: j.value, expires_at: j.expires_at, model };
}

module.exports = { transcribe, transcribeDiarized, config, setConfig, realtimeToken };
