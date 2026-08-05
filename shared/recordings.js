'use strict';
/**
 * shared/recordings.js — the recording record store (issue #94, roadmap §B1).
 *
 * A recording is a first-class captured-context object: an audio file plus its transcript and
 * AI-derived metadata (semantic title, summary, action items — see §B3), optionally filed under a
 * context bank (§A) and/or linked to people (§B2). Storage is a directory per recording so the audio,
 * transcript, and future assets (stills/clips) live together and are easy to back up or move into a silo:
 *
 *   $ASMLTR_RECORDINGS_DIR (default ~/.asmltr/recordings)/<id>/
 *     ├── meta.json            the record (below)
 *     ├── audio.<ext>          the source audio
 *     ├── transcript.txt       the stitched transcript (once transcribed)
 *     └── assets/              timestamped stills/clips (§B7, later)
 *
 * meta.json:
 *   { id, created, source, mime, ext, audio_bytes, duration_sec,
 *     status: 'uploaded'|'transcribing'|'transcribed'|'enriched'|'error', error?,
 *     title, description, action_items[], highlights[],        // AI-derived (§B3), override-able
 *     ai_locked: { title?, description? },                     // true = user edited → don't AI-overwrite
 *     bank_id, people[], speakers[] }                          // §A / §B2, filled later
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function root() { return process.env.ASMLTR_RECORDINGS_DIR || path.join(os.homedir(), '.asmltr', 'recordings'); }
function dir(id) { return path.join(root(), id); }
function metaPath(id) { return path.join(dir(id), 'meta.json'); }

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

function readMeta(id) { try { return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')); } catch (_) { return null; } }

// Create a recording from an audio buffer already on hand. `created` is caller-supplied (the core stamps
// it) so this module stays free of wall-clock calls. Returns the stored record.
function create({ audio, mime, ext, source, created, title, bank_id }) {
  const id = 'rec_' + crypto.randomBytes(8).toString('hex');
  const e = (ext || extFromMime(mime) || 'bin').replace(/^\./, '');
  fs.mkdirSync(dir(id), { recursive: true });
  if (audio && audio.length) fs.writeFileSync(path.join(dir(id), 'audio.' + e), audio);
  const meta = {
    id, created: created || null, source: source || 'upload', mime: mime || 'application/octet-stream', ext: e,
    audio_bytes: audio ? audio.length : 0, duration_sec: null,
    status: 'uploaded', error: null,
    title: title || null, description: null, action_items: [], highlights: [],
    ai_locked: {}, bank_id: bank_id || null, people: [], speakers: [],
  };
  writeJsonAtomic(metaPath(id), meta);
  return meta;
}

function get(id) { const m = readMeta(id); if (!m) return null; m.has_transcript = fs.existsSync(path.join(dir(id), 'transcript.txt')); return m; }

// List newest-first. Cheap dir scan (fine for personal-scale counts); swap for an index if it ever grows.
function list() {
  let ids = [];
  try { ids = fs.readdirSync(root()).filter((d) => fs.existsSync(metaPath(d))); } catch (_) { return []; }
  return ids.map(readMeta).filter(Boolean).sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
}

// Merge a patch into meta (shallow), guarding AI-owned fields the user has locked by editing.
function update(id, patch) {
  const m = readMeta(id); if (!m) return null;
  const next = { ...m, ...patch, ai_locked: { ...(m.ai_locked || {}), ...(patch.ai_locked || {}) } };
  writeJsonAtomic(metaPath(id), next);
  return next;
}

function setTranscript(id, text) {
  if (!readMeta(id)) return null;
  fs.writeFileSync(path.join(dir(id), 'transcript.txt'), String(text || ''));
  return get(id);
}
function transcript(id) { try { return fs.readFileSync(path.join(dir(id), 'transcript.txt'), 'utf8'); } catch (_) { return null; } }

function audioPath(id) {
  const m = readMeta(id); if (!m) return null;
  const p = path.join(dir(id), 'audio.' + m.ext);
  return fs.existsSync(p) ? p : null;
}

function remove(id) { try { fs.rmSync(dir(id), { recursive: true, force: true }); return true; } catch (_) { return false; } }

function extFromMime(mime) {
  const map = { 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav',
    'audio/x-wav': 'wav', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/aac': 'aac', 'audio/flac': 'flac' };
  return map[String(mime || '').toLowerCase()] || null;
}

module.exports = { create, get, list, update, setTranscript, transcript, audioPath, remove, dir, root, extFromMime };
