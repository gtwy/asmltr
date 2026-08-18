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

// From chunk 0's diarized segments, cut a short single-speaker reference clip per speaker and return them
// as `known` refs ({name, audio, mime}). Feeding these to later chunks makes gpt-4o-transcribe-diarize
// return the SAME label for a given voice across chunks (cross-chunk speaker consistency) instead of
// re-numbering per chunk. OpenAI caps known refs at 4, so we seed the 4 speakers with the most airtime.
function buildKnownRefsFromChunk(chunkPath, segs, work) {
  const byS = new Map(); // speaker → { start, end, dur } of its cleanest (longest) single segment + total airtime
  for (const s of segs) {
    if (s.speaker == null || s.start == null || s.end == null) continue;
    const dur = s.end - s.start; if (!(dur > 0)) continue;
    const cur = byS.get(s.speaker) || { start: s.start, end: s.end, dur: 0, total: 0 };
    if (dur > cur.dur) { cur.start = s.start; cur.end = s.end; cur.dur = dur; }
    cur.total += dur; byS.set(s.speaker, cur);
  }
  const ranked = [...byS.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 4); // OpenAI ≤4
  const known = [];
  ranked.forEach(([speaker, seg], idx) => {
    const clip = Math.min(8, Math.max(2, seg.dur)); // 2–8s reference from that speaker's longest turn
    const refPath = path.join(work, `ref_${idx}.mp3`);
    const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(seg.start), '-t', String(clip), '-i', chunkPath,
      '-ac', '1', '-ar', '16000', '-b:a', '32k', refPath], { encoding: 'utf8' });
    if (r.status === 0 && fs.existsSync(refPath)) known.push({ name: String(speaker), audio: fs.readFileSync(refPath), mime: 'audio/mpeg' });
  });
  return known.length ? known : null;
}

// Diarized long-audio transcription (epic #113 / #111). Same chunking as transcribeLong, but each chunk
// goes through stt.transcribeDiarized; segment start/end times are offset by the chunk position so they're
// absolute. Cross-chunk speaker CONSISTENCY: after chunk 0 we auto-seed `known_speaker_references` from its
// speakers (unless the caller passed explicit `known`), so a voice keeps ONE label across the whole file.
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
    const segments = []; const parts = []; const failedChunks = [];
    let known = opts.known || null; // caller-supplied named refs win; else we seed from chunk 0 below
    for (let i = 0; i < chunks.length; i++) {
      const chunkPath = path.join(work, chunks[i]);
      const buf = fs.readFileSync(chunkPath);
      // Per-chunk resilience: one slow/failed chunk must NOT sink a 70-minute job. Try once, retry once,
      // then skip that chunk (recording a gap) and press on.
      let out = null;
      for (let attempt = 0; attempt < 2 && !out; attempt++) {
        try { out = await stt.transcribeDiarized(buf, { filename: chunks[i], mime: 'audio/mpeg', language: opts.language, known, timeoutMs: opts.timeoutMs }); }
        catch (e) { if (attempt === 1) { failedChunks.push(i); onProgress({ index: i + 1, total: chunks.length, error: e.message }); } }
      }
      if (!out) continue;
      const offset = i * chunkSec;
      for (const s of (out.segments || [])) {
        segments.push({ speaker: s.speaker != null ? String(s.speaker) : null,
          start: s.start != null ? s.start + offset : null, end: s.end != null ? s.end + offset : null, text: s.text });
      }
      parts.push((out.text || '').trim());
      // Seed cross-chunk speaker refs from chunk 0 (only if the caller didn't pin known speakers already).
      if (i === 0 && !opts.known && chunks.length > 1) {
        try { known = buildKnownRefsFromChunk(chunkPath, out.segments || [], work) || known; } catch (_) {}
      }
      onProgress({ index: i + 1, total: chunks.length, segments: segments.length });
    }
    if (failedChunks.length === chunks.length) throw new Error('all diarize chunks failed (last: check key/model access)');
    const speakers = [...new Set(segments.map((s) => s.speaker).filter(Boolean))];
    return { text: parts.join('\n\n'), segments, speakers, chunks: chunks.length, failed_chunks: failedChunks, duration_sec: duration };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { transcribeLong, transcribeLongDiarized, buildKnownRefsFromChunk, ffprobeDuration };
