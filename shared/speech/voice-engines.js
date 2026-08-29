'use strict';
/**
 * shared/speech/voice-engines.js — the pluggable VOICE ENGINE layer (epic #113).
 *
 * Voice is modeled as ROLES that engines fill, not fixed "STT slot + TTS slot" — so a future duplex
 * speech-to-speech API slots in with zero downstream rewrite. Surfaces ask the resolver BY ROLE
 * (`resolve('transcribe')`), never by engine, and gate features on the resolved engine's CAPABILITY
 * MANIFEST (same idea as the reasoning layer keying inject-once on `retainsHistory`).
 *
 * Roles:
 *   transcribe           file/clip STT (audio → text)
 *   realtime_transcribe  streaming STT + VAD
 *   synthesize           TTS (text → audio)
 *   converse             duplex speech-to-speech (audio ↔ audio in one model) — a SUPER-role: when
 *                        bound + enabled it owns the interactive turn and collapses transcribe+synthesize.
 *
 * A user BINDS a role → an engine (persisted). Split today (transcribe→openai, synthesize→elevenlabs);
 * duplex-ready tomorrow (bind converse→<engine> and the assistant path switches, while the recorder still
 * asks for `transcribe`). This module is the declarative catalog + bindings + resolver; concrete engine
 * I/O (the actual STT/TTS calls) stays in stt.js / tts.js / the realtime endpoint, which read the binding.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROLES = ['transcribe', 'realtime_transcribe', 'synthesize', 'converse'];

// Declarative engine catalog. `roles` = which roles it can fill; `caps` = its capability manifest;
// `key` = the secret name it needs (null = always available, e.g. a local engine). `model` hints the
// concrete model the role adapter should use. Kept declarative so adding an engine is a data change.
const ENGINES = {
  'openai-transcribe': {
    provider: 'openai', label: 'OpenAI Transcribe', key: 'openai_api_key', model: 'gpt-4o-transcribe',
    roles: ['transcribe', 'realtime_transcribe'],
    caps: { streaming: true, vad: true, diarization: false, word_timestamps: true, known_speakers: false, cost_per_min: 0.006 },
  },
  'openai-transcribe-diarize': {
    provider: 'openai', label: 'OpenAI Transcribe + Diarize', key: 'openai_api_key', model: 'gpt-4o-transcribe-diarize',
    roles: ['transcribe', 'realtime_transcribe'],
    caps: { streaming: true, vad: true, diarization: true, word_timestamps: true, known_speakers: true, cost_per_min: 0.006 },
  },
  'openai-live-transcribe': {
    provider: 'openai', label: 'OpenAI Live Transcribe (low latency)', key: 'openai_api_key', model: 'gpt-live-transcribe',
    roles: ['realtime_transcribe'],
    caps: { streaming: true, vad: true, diarization: false, low_latency: true, cost_per_min: 0.006 },
  },
  deepgram: {
    provider: 'deepgram', label: 'Deepgram', key: 'deepgram_api_key', model: 'flux-general-en',
    roles: ['transcribe', 'realtime_transcribe'],
    caps: { streaming: true, vad: true, diarization: true, word_timestamps: true, known_speakers: false, low_latency: true },
  },
  'local-whisper': {
    provider: 'local', label: 'Local Whisper (offline)', key: null, model: 'whisper',
    roles: ['transcribe'],
    caps: { streaming: false, vad: false, diarization: false, cost_per_min: 0, offline: true },
  },
  'openai-tts': {
    provider: 'openai', label: 'OpenAI TTS', key: 'openai_api_key', model: 'tts-1',
    roles: ['synthesize'], caps: { voices: 'standard' },
  },
  elevenlabs: {
    provider: 'elevenlabs', label: 'ElevenLabs', key: 'elevenlabs_api_key', model: 'eleven_turbo_v2_5',
    roles: ['synthesize'], caps: { voices: 'premium', cloning: true },
  },
  'grok-voice': {
    provider: 'xai', label: 'Grok Voice (Live)', key: 'xai_voice_api_key', model: 'grok-voice-think-fast-2.0',
    roles: ['converse'],
    caps: { duplex: true, streaming: true, vad: true, voice: 'ara' },
  },
};


const DEFAULT_BINDINGS = {
  transcribe: 'openai-transcribe',
  realtime_transcribe: 'openai-live-transcribe', // streaming during-speech captions (Discord voice + app)
  synthesize: process.env.ASMLTR_TTS_PROVIDER === 'elevenlabs' ? 'elevenlabs' : 'openai-tts',
  converse: null,
};

function file() { return process.env.ASMLTR_VOICE_ENGINES_FILE || path.join(os.homedir(), '.asmltr', 'voice-engines.json'); }
function readFileBindings() {
  try { const j = JSON.parse(fs.readFileSync(file(), 'utf8')); return (j && j.bindings) || {}; }
  catch (_) { return {}; }
}
function readBindings() {
  return { ...DEFAULT_BINDINGS, ...readFileBindings() };
}

const ENV_KEY_ALIASES = {
  deepgram_api_key: ['DEEPGRAM_API_KEY', 'ASMLTR_DEEPGRAM_API_KEY'],
};

function keyPresent(name, opts) {
  if (opts && opts.keys && Object.prototype.hasOwnProperty.call(opts.keys, name)) return !!opts.keys[name];
  if (opts && typeof opts.has === 'function') return !!opts.has(name);
  for (const e of (ENV_KEY_ALIASES[name] || [])) {
    if (process.env[e]) return true;
  }
  return false;
}

function implicitBinding(role, opts) {
  if (role === 'realtime_transcribe' && keyPresent('deepgram_api_key', opts)) return 'deepgram';
  if (role === 'converse' && keyPresent('xai_voice_api_key', opts)) return 'grok-voice';
  return DEFAULT_BINDINGS[role];
}
function writeBindings(b) {
  const f = file(); fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ version: 1, bindings: b }, null, 2)); fs.renameSync(tmp, f);
}

function enginesForRole(role) { return Object.entries(ENGINES).filter(([, e]) => e.roles.includes(role)).map(([id, e]) => ({ id, ...e })); }

// Resolve a role → the engine bound to it (or the first engine that can fill it as a fallback). Returns
// { role, engine_id, engine, capabilities } — surfaces use `capabilities` to gate features.
function resolve(role, opts) {
  if (!ROLES.includes(role)) throw new Error('unknown voice role: ' + role);
  const fileB = readFileBindings();
  const fromFile = Object.prototype.hasOwnProperty.call(fileB, role);
  let id = fromFile ? fileB[role] : implicitBinding(role, opts);
  if (!id || !ENGINES[id] || !ENGINES[id].roles.includes(role)) {
    // converse is opt-in (vault xai_voice_api_key). Do not fall back to the catalog entry
    // when the key is missing -- that would steal the Flux+CLI+TTS path.
    if (role === 'converse' && !fromFile) id = null;
    else { const first = enginesForRole(role)[0]; id = first ? first.id : null; }
  }
  const engine = id ? ENGINES[id] : null;
  return { role, engine_id: id, engine, capabilities: engine ? { ...engine.caps, model: engine.model, provider: engine.provider } : null };
}
function capabilities(role) { return resolve(role).capabilities; }

function bind(role, engineId) {
  if (!ROLES.includes(role)) throw new Error('unknown role: ' + role);
  if (engineId && !ENGINES[engineId]) throw new Error('unknown engine: ' + engineId);
  if (engineId && !ENGINES[engineId].roles.includes(role)) throw new Error(`engine ${engineId} does not fill role ${role}`);
  const b = readBindings(); b[role] = engineId || null; writeBindings(b); return b;
}

// Which engines are actually usable (their key is present). `has(name)` is an async predicate the caller
// supplies (e.g. from shared/secrets) so this module stays free of a hard secrets dependency.
async function availability(has) {
  const out = {};
  for (const [id, e] of Object.entries(ENGINES)) out[id] = e.key ? !!(has && await has(e.key)) : true;
  return out;
}

// Which engines actually have their I/O adapter wired in asmltr TODAY. Catalog entries NOT in this set are
// real/plannable configs but their adapter isn't built yet — the GUI shows them as "planned" so the list
// never overpromises. As adapters land (diarize, live, deepgram, local-whisper), add them here.
const IMPLEMENTED = new Set(['openai-transcribe', 'openai-transcribe-diarize', 'openai-live-transcribe', 'deepgram', 'openai-tts', 'elevenlabs', 'grok-voice']);
// Per-engine status: 'ready' (adapter built + key ok) · 'needs_key' (built but key missing) · 'planned'
// (adapter not built yet). `keyOk` is the caller's availability result for this engine.
function statusOf(id, keyOk) {
  const e = ENGINES[id]; if (!e) return 'unknown';
  if (!IMPLEMENTED.has(id)) return 'planned';
  if (e.key && !keyOk) return 'needs_key';
  return 'ready';
}

function catalog() { return { roles: ROLES, engines: ENGINES, bindings: readBindings() }; }

module.exports = { ROLES, ENGINES, IMPLEMENTED, resolve, capabilities, bind, enginesForRole, availability, statusOf, catalog, readBindings, readFileBindings, keyPresent, implicitBinding };
