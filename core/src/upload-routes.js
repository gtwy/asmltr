'use strict';
/**
 * Chunked upload routes for the shared upload surface.
 *
 * The one-shot `/v2/upload` posts the whole file as base64 inside the JSON body, so the largest file
 * anyone can send is set by the smallest body limit on the path (nginx's 1 MiB default) minus base64's
 * 33% overhead. These routes make the wire unit a fixed-size chunk instead of the file, so file size
 * stops being a limit: a proxy only ever sees one chunk, memory only ever holds one chunk, and an
 * interrupted transfer resumes from what already landed.
 *
 *   POST   /v2/upload/init        { filename, mime, size, sha256?, conversation_key? }
 *                                 → { ok, upload_id, chunk_size, chunks, received }
 *   PUT    /v2/upload/:id/:index  raw application/octet-stream chunk bytes
 *                                 → { ok, received_count, chunks }
 *   GET    /v2/upload/:id         → { upload_id, size, chunk_size, chunks, received }   (resume)
 *   POST   /v2/upload/:id/finish  { sha256? } → { ok, file }   same `file` shape /v2/upload returns
 *   DELETE /v2/upload/:id         → { ok }
 *
 * `/v2/upload` is left in place: connectors and any older client keep working unchanged.
 */

const express = require('express');
const uploads = require('../../shared/uploads');

// Safety bound on ONE chunk body, deliberately independent of the advertised chunk_size: the server
// can raise or lower its recommendation without a client hitting a body-parser wall on a chunk in flight.
function maxChunkBody() { return process.env.ASMLTR_UPLOAD_MAX_CHUNK || '64mb'; }

const kindOf = (mime) => (/^image\//.test(mime || '') ? 'image' : 'document');

// shared/uploads throws plain Errors; turn the failure modes into codes a client can act on.
// 409 = send the rest. 422 = the bytes are wrong, start over. 404 = this upload is gone.
function statusFor(message) {
  if (/unknown upload/i.test(message)) return 404;
  if (/missing chunk/i.test(message)) return 409;
  if (/checksum mismatch|size mismatch/i.test(message)) return 422;
  if (/invalid chunk index|past the end/i.test(message)) return 400;
  return 500;
}

/**
 * @param {import('express').Express} app
 * @param {object} [opts]
 * @param {Function} [opts.record]  event-stream recorder, same signature server.js uses
 */
function mountUploadRoutes(app, opts = {}) {
  const record = typeof opts.record === 'function' ? opts.record : () => {};
  const ownerOf = (req) => process.env.ASMLTR_WEB_OWNER_ID || req.get('X-Remote-User') || 'dashboard';

  app.post('/v2/upload/init', (req, res) => {
    try {
      const { filename, mime, size, sha256, conversation_key } = req.body || {};
      const n = Number(size);
      if (!Number.isInteger(n) || n < 0) return res.status(400).json({ error: 'size (integer bytes) required' });
      const s = uploads.beginChunked({
        channel: 'assistant-web', filename, mime, size: n, sha256,
        sender: 'dashboard', senderId: String(ownerOf(req)),
        conversationKey: conversation_key || null, kind: kindOf(mime),
      });
      res.json({ ok: true, ...s });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Raw bytes, so a chunk costs exactly its own size on the wire (no base64 inflation).
  app.put('/v2/upload/:id/:index', express.raw({ type: () => true, limit: maxChunkBody() }), (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'empty chunk' });
      res.json(uploads.putChunk(req.params.id, req.params.index, req.body));
    } catch (e) { res.status(statusFor(e.message)).json({ error: e.message }); }
  });

  app.get('/v2/upload/:id', (req, res) => {
    const st = uploads.chunkStatus(req.params.id);
    if (!st) return res.status(404).json({ error: `unknown upload ${req.params.id}` });
    res.json(st);
  });

  app.post('/v2/upload/:id/finish', (req, res) => {
    try {
      const rec = uploads.finishChunked(req.params.id, { sha256: (req.body || {}).sha256 });
      record({
        surface: 'assistant-web', session_id: rec.conversation_key || null, event_type: 'control',
        identity: String(ownerOf(req)), source: 'core',
        payload: { action: 'upload', name: rec.filename, path: rec.path, bytes: rec.size, chunked: true },
      });
      res.json({
        ok: true,
        file: { path: rec.path, name: rec.filename, mime: rec.mime, kind: rec.kind, bytes: rec.size, sha256: rec.sha256 },
      });
    } catch (e) { res.status(statusFor(e.message)).json({ error: e.message }); }
  });

  app.delete('/v2/upload/:id', (req, res) => {
    res.json({ ok: uploads.abortChunked(req.params.id) });
  });
}

/**
 * Drop staging dirs left behind by uploads that were never finished. Unref'd so it never holds the
 * process open. Returns the timer for callers that want to stop it.
 */
function startPartialSweeper({ everyMs = 3600 * 1000, maxAgeMs = 24 * 3600 * 1000 } = {}) {
  const tick = () => {
    try {
      const n = uploads.sweepPartials(maxAgeMs);
      if (n) console.log(`[core] swept ${n} abandoned partial upload${n > 1 ? 's' : ''}`);
    } catch (e) { console.error('[core] partial upload sweep:', e.message); }
  };
  tick();
  const t = setInterval(tick, everyMs);
  if (t.unref) t.unref();
  return t;
}

module.exports = { mountUploadRoutes, startPartialSweeper };
