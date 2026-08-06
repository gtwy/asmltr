'use strict';
/**
 * shared/speech/transcribe-long.js — transcribe an arbitrarily long recording (roadmap §B1).
 *
 * The STT models cap per-request size/duration (~25MB), so a 70-minute meeting can't go in one call.
 * This downsamples to speech-optimized 16 kHz mono and segments into fixed-length chunks with ffmpeg,
 * transcribes each via the shared STT module (the SAME configured provider/key the core /v2/transcribe
 * uses — so this must run in a process that has secrets, i.e. the core), and stitches the text in order.
 *
 * Requires ffmpeg/ffprobe on PATH. Returns { text, chunks, duration_sec }.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const stt = require('./stt');

function ffprobeDuration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { encoding: 'utf8' });
  const d = parseFloat((r.stdout || '').trim());
  return Number.isFinite(d) ? d : null;
}

async function transcribeLong(audioPath, opts = {}) {
  if (!fs.existsSync(audioPath)) throw new Error('audio not found: ' + audioPath);
  const chunkSec = opts.chunkSec || 600; // 10 min — safely under model size/duration limits at 16k mono 32k
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-stt-'));
  try {
    const duration = ffprobeDuration(audioPath);
    // Re-encode to 16 kHz mono mp3 @32k and split into chunkSec segments (chunk_000.mp3, …).
    const seg = spawnSync('ffmpeg', ['-v', 'error', '-i', audioPath, '-ac', '1', '-ar', '16000', '-b:a', '32k',
      '-f', 'segment', '-segment_time', String(chunkSec), path.join(work, 'chunk_%03d.mp3')], { encoding: 'utf8' });
    if (seg.status !== 0) throw new Error('ffmpeg segment failed: ' + (seg.stderr || '').trim().slice(0, 300));
    const chunks = fs.readdirSync(work).filter((f) => /^chunk_\d+\.mp3$/.test(f)).sort();
    if (!chunks.length) throw new Error('no audio chunks produced');
    const parts = [];
    for (let i = 0; i < chunks.length; i++) {
      const buf = fs.readFileSync(path.join(work, chunks[i]));
      const out = await stt.transcribe(buf, { filename: chunks[i], mime: 'audio/mpeg', language: opts.language });
      parts.push((out.text || out.transcript || '').trim());
      onProgress({ index: i + 1, total: chunks.length, chars: parts[i].length });
    }
    return { text: parts.join('\n\n'), chunks: chunks.length, duration_sec: duration };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
  }
}

// Diarized long-audio transcription (epic #113 / #111). Same chunking as transcribeLong, but each chunk
// goes through stt.transcribeDiarized; segment start/end times are offset by the chunk position so they're
// absolute. NOTE: speaker labels are per-chunk (chunk N's "Speaker 1" may not equal chunk N+1's) unless
// `known` references are supplied — cross-chunk stitching is the caller's polish (see VOICE-CAPABILITY-BUILD.md).
async function transcribeLongDiarized(audioPath, opts = {}) {
  if (!fs.existsSync(audioPath)) throw new Error('audio not found: ' + audioPath);
  const chunkSec = opts.chunkSec || 600;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-diar-'));
  try {
    const duration = ffprobeDuration(audioPath);
    const seg = spawnSync('ffmpeg', ['-v', 'error', '-i', audioPath, '-ac', '1', '-ar', '16000', '-b:a', '32k',
      '-f', 'segment', '-segment_time', String(chunkSec), path.join(work, 'chunk_%03d.mp3')], { encoding: 'utf8' });
    if (seg.status !== 0) throw new Error('ffmpeg segment failed: ' + (seg.stderr || '').trim().slice(0, 300));
    const chunks = fs.readdirSync(work).filter((f) => /^chunk_\d+\.mp3$/.test(f)).sort();
    if (!chunks.length) throw new Error('no audio chunks produced');
    const segments = []; const parts = [];
    for (let i = 0; i < chunks.length; i++) {
      const buf = fs.readFileSync(path.join(work, chunks[i]));
      const out = await stt.transcribeDiarized(buf, { filename: chunks[i], mime: 'audio/mpeg', language: opts.language, known: opts.known });
      const offset = i * chunkSec;
      for (const s of (out.segments || [])) {
        segments.push({ speaker: s.speaker != null ? `${chunks.length > 1 ? 'c' + i + ':' : ''}${s.speaker}` : null,
          start: s.start != null ? s.start + offset : null, end: s.end != null ? s.end + offset : null, text: s.text });
      }
      parts.push((out.text || '').trim());
      onProgress({ index: i + 1, total: chunks.length, segments: segments.length });
    }
    return { text: parts.join('\n\n'), segments, chunks: chunks.length, duration_sec: duration };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { transcribeLong, transcribeLongDiarized, ffprobeDuration };
