'use strict';
/**
 * asmltr shared MIME guesser — infer a content type from a file path/extension.
 *
 * Outbound attachments standardize on kind:'file' (see docs), so each connector must decide how to
 * ship a given file (image → inline photo vs. generic document, correct Content-Type on a stream).
 * That decision keys off the MIME type, which we infer from the extension here — one place, so every
 * connector agrees. Prefers the `mime-types` lib when installed; falls back to a small built-in map so
 * a minimal install still works.
 */
const path = require('path');

// Small fallback map — the extensions that actually matter for chat attachments (images + common docs).
const EXT_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.tiff': 'image/tiff',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.json': 'application/json', '.zip': 'application/zip', '.html': 'text/html',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};

let _lib = null;
try { _lib = require('mime-types'); } catch (_) { _lib = null; }

/** Best-effort MIME type for a path/filename. Returns 'application/octet-stream' when unknown. */
function guessMime(p) {
  const ext = path.extname(String(p || '')).toLowerCase();
  if (_lib) { const t = _lib.lookup(ext || String(p || '')); if (t) return t; }
  return EXT_MIME[ext] || 'application/octet-stream';
}

/** True when the inferred MIME is an image/* type (→ send inline as a photo, not a generic document). */
function isImage(p) { return guessMime(p).startsWith('image/'); }

module.exports = { guessMime, isImage };
