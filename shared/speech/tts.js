'use strict';
/**
 * asmltr core speech layer — provider-agnostic text-to-speech.
 *
 * Turns a short piece of text (typically one sentence off the agent's live token stream) into an
 * audio clip. This is the engine the `speaker` pipeline drives to convert the core's streamed reply
 * into voice with the lowest possible time-to-first-word.
 *
 * OpenAI (`/v1/audio/speech`) is the default provider because its key is already on hand; the shape
 * deliberately leaves room for ElevenLabs (HTTP `/stream`, and later the WebSocket `stream-input`
 * for token-level latency). Config comes from env with sane defaults:
 *   ASMLTR_TTS_PROVIDER (openai) · ASMLTR_TTS_VOICE (alloy) · ASMLTR_TTS_MODEL (tts-1)
 *   ASMLTR_TTS_FORMAT (mp3) · ASMLTR_TTS_KEY_NAME (openai_api_key)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const secrets = require('../secrets');

// GUI/TUI-set voice + model persist to the asmltr state dir (like the agent model selection), so a
// change applies on the NEXT synthesized clip with no restart. Persisted values win over env defaults.
function stateDir() {
  const d = process.env.ASMLTR_STATE_DIR || path.join(os.homedir(), '.asmltr');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}
const cfgFile = () => path.join(stateDir(), 'tts-config');
function persisted() { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) || {}; } catch (_) { return {}; } }

// Provider-aware defaults: OpenAI (voice presets like "alloy") vs ElevenLabs (voice IDs + eleven_* models).
const DEFAULTS = {
  openai: { voice: 'alloy', model: 'tts-1', keyName: 'openai_api_key' },
  elevenlabs: { voice: '21m00Tcm4TlvDq8ikWAM', model: 'eleven_turbo_v2_5', keyName: 'elevenlabs_api_key' },
};
function config() {
  const p = persisted();
  const provider = p.provider || process.env.ASMLTR_TTS_PROVIDER || 'openai';
  const d = DEFAULTS[provider] || DEFAULTS.openai;
  return {
    provider,
    voice: p.voice || process.env.ASMLTR_TTS_VOICE || d.voice,
    model: p.model || process.env.ASMLTR_TTS_MODEL || d.model,
    format: p.format || process.env.ASMLTR_TTS_FORMAT || 'mp3',
    keyName: process.env.ASMLTR_TTS_KEY_NAME || d.keyName,
  };
}

// Persist a partial override ({voice, model, provider, format}). '' clears a key back to the env default.
function setConfig(partial) {
  const next = persisted();
  for (const k of ['provider', 'voice', 'model', 'format']) {
    if (!partial || partial[k] === undefined) continue;
    if (partial[k] === '' || partial[k] === null) delete next[k];
    else next[k] = String(partial[k]);
  }
  try { fs.writeFileSync(cfgFile(), JSON.stringify(next)); } catch (_) {}
  return config();
}

function mimeFor(fmt) {
  return { opus: 'audio/ogg', aac: 'audio/aac', wav: 'audio/wav', pcm: 'audio/L16', flac: 'audio/flac' }[fmt] || 'audio/mpeg';
}

// OpenAI: POST /v1/audio/speech. The HTTP body streams as the audio renders, so we forward bytes to
// `onChunk` as they land (enables sub-clip byte-streaming later) and also return the full Buffer.
async function openaiSynthesize(text, opts, onChunk) {
  const key = await secrets.get(opts.keyName);
  if (!key) throw new Error(`no TTS key (secret '${opts.keyName}' is empty)`);
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: opts.model, voice: opts.voice, input: text, response_format: opts.format }),
  });
  if (!res.ok || !res.body) {
    const t = res.body ? await res.text().catch(() => '') : '';
    throw new Error(`openai tts ${res.status} ${t.slice(0, 200)}`);
  }
  const chunks = [];
  for await (const c of res.body) { const b = Buffer.from(c); chunks.push(b); if (onChunk) { try { onChunk(b); } catch (_) {} } }
  return Buffer.concat(chunks);
}

// ElevenLabs: POST /v1/text-to-speech/{voiceId}. `voice` is an ElevenLabs voice ID; `model` an
// eleven_* model id. Returns mp3 (also byte-streamed to onChunk as it renders).
async function elevenlabsSynthesize(text, opts, onChunk) {
  const key = await secrets.get(opts.keyName);
  if (!key) throw new Error(`no TTS key (secret '${opts.keyName}' is empty)`);
  const fmt = { mp3: 'mp3_44100_128', opus: 'opus_48000_128', pcm: 'pcm_24000' }[opts.format] || 'mp3_44100_128';
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(opts.voice)}/stream?output_format=${fmt}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: opts.model }),
  });
  if (!res.ok || !res.body) {
    const t = res.body ? await res.text().catch(() => '') : '';
    throw new Error(`elevenlabs tts ${res.status} ${t.slice(0, 200)}`);
  }
  const chunks = [];
  for await (const c of res.body) { const b = Buffer.from(c); chunks.push(b); if (onChunk) { try { onChunk(b); } catch (_) {} } }
  return Buffer.concat(chunks);
}

/**
 * Synthesize one short text → { audio: Buffer, mime }. THE one TTS entry point for all of asmltr
 * (core /v2/speak + /v2/tts, and connectors like Discord voice) — pass per-call overrides to vary
 * provider/voice/model/key without touching global config.
 * @param {string} text
 * @param {object} [overrides] provider/voice/model/format/keyName
 * @param {(chunk:Buffer)=>void} [onChunk] optional per-byte-chunk callback (streaming)
 */
async function synthesize(text, overrides = {}, onChunk) {
  // provider-aware defaults: if the caller flips provider but not voice/model, use that provider's defaults
  const base = config();
  const provider = overrides.provider || base.provider;
  const d = DEFAULTS[provider] || DEFAULTS.openai;
  const opts = {
    provider,
    voice: overrides.voice || (overrides.provider && overrides.provider !== base.provider ? d.voice : base.voice),
    model: overrides.model || (overrides.provider && overrides.provider !== base.provider ? d.model : base.model),
    format: overrides.format || base.format,
    keyName: overrides.keyName || (overrides.provider && overrides.provider !== base.provider ? d.keyName : base.keyName),
  };
  const mime = mimeFor(opts.format);
  if (opts.provider === 'openai') { const audio = await openaiSynthesize(text, opts, onChunk); return { audio, mime, format: opts.format }; }
  if (opts.provider === 'elevenlabs') { const audio = await elevenlabsSynthesize(text, opts, onChunk); return { audio, mime, format: opts.format }; }
  throw new Error(`unknown TTS provider: ${opts.provider}`);
}

module.exports = { synthesize, config, setConfig, mimeFor };
