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
const secrets = require('../secrets');

function config() {
  return {
    provider: process.env.ASMLTR_TTS_PROVIDER || 'openai',
    voice: process.env.ASMLTR_TTS_VOICE || 'alloy',
    model: process.env.ASMLTR_TTS_MODEL || 'tts-1',
    format: process.env.ASMLTR_TTS_FORMAT || 'mp3',
    keyName: process.env.ASMLTR_TTS_KEY_NAME || 'openai_api_key',
  };
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

/**
 * Synthesize one short text → { audio: Buffer, mime }.
 * @param {string} text
 * @param {object} [overrides] provider/voice/model/format/keyName
 * @param {(chunk:Buffer)=>void} [onChunk] optional per-byte-chunk callback (streaming)
 */
async function synthesize(text, overrides = {}, onChunk) {
  const opts = { ...config(), ...overrides };
  const mime = mimeFor(opts.format);
  if (opts.provider === 'openai') { const audio = await openaiSynthesize(text, opts, onChunk); return { audio, mime, format: opts.format }; }
  throw new Error(`unknown TTS provider: ${opts.provider}`);
}

module.exports = { synthesize, config, mimeFor };
