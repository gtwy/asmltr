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
  return {
    provider: p.provider || process.env.ASMLTR_STT_PROVIDER || 'openai',
    model: p.model || process.env.ASMLTR_STT_MODEL || 'gpt-4o-transcribe',
    // language: '' means auto-detect; default 'en' (empty string is a valid, persistable choice).
    language: p.language !== undefined ? p.language : (process.env.ASMLTR_STT_LANGUAGE || 'en'),
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
  return { text: (j.text || '').trim(), model };
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
  const body = {
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription,
          // server_vad = OpenAI detects speech start/stop; ~600ms of silence ends a turn (auto-send trigger).
          turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 600 },
          noise_reduction: { type: 'near_field' },
        },
      },
    },
  };
  const r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `realtime token ${r.status}`);
  return { value: j.value, expires_at: j.expires_at, model };
}

module.exports = { transcribe, config, setConfig, realtimeToken };
