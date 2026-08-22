'use strict';
/**
 * Inbound channel media for generation context.
 * Only real image/video bytes are kept. Never execute, chmod +x, or run.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { mediaKind, sanitizeFilename } = require('./outbound-stage');

const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_VIDEO = 25 * 1024 * 1024;
const EXEC_EXT = new Set([
  'exe', 'bat', 'cmd', 'com', 'scr', 'ps1', 'sh', 'bash', 'zsh',
  'js', 'mjs', 'cjs', 'ts', 'py', 'rb', 'pl', 'php', 'html', 'htm',
  'svg', 'xml', 'pdf', 'zip', 'gz', 'tgz', 'xz', '7z', 'rar',
  'dll', 'so', 'dylib', 'jar', 'class', 'wasm',
]);

function refDir() {
  return process.env.ASMLTR_GEN_REF
    || path.join(os.homedir(), '.asmltr', 'gen-ref');
}

function classify(buf, mimeHint, filename) {
  const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (raw.length < 12) return { kind: null, reason: 'too-small' };
  const name = String(filename || 'file');
  const ext = path.extname(name).slice(1).toLowerCase();
  if (EXEC_EXT.has(ext)) return { kind: null, reason: 'exec-ext' };
  const magic = mediaKind(raw);
  if (!magic) return { kind: null, reason: 'not-media' };
  const image = magic === 'png' || magic === 'jpg' || magic === 'gif' || magic === 'webp';
  const video = magic === 'mp4' || magic === 'webm';
  if (!image && !video) return { kind: null, reason: 'not-media' };
  const mime = String(mimeHint || '').split(';')[0].trim().toLowerCase();
  if (mime && !mime.startsWith('image/') && !mime.startsWith('video/')) {
    return { kind: null, reason: 'mime' };
  }
  const max = image ? MAX_IMAGE : MAX_VIDEO;
  if (raw.length > max) return { kind: null, reason: 'too-large' };
  return {
    kind: image ? 'image' : 'video',
    ext: magic === 'jpg' ? 'jpg' : magic,
    mime: image ? (mime.startsWith('image/') ? mime : 'image/' + (magic === 'jpg' ? 'jpeg' : magic))
      : (mime.startsWith('video/') ? mime : 'video/' + magic),
  };
}

function saveRef(buf, opts) {
  const c = classify(buf, opts && opts.mime, opts && opts.name);
  if (!c.kind) return { ok: false, error: c.reason };
  const dir = refDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const suggested = (opts && opts.name) || ('ref.' + c.ext);
  const safe = sanitizeFilename(suggested, c.ext);
  const lastDot = safe.lastIndexOf('.');
  const stem = safe.slice(0, lastDot);
  const id = Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex');
  const name = stem + '-' + id + '.' + c.ext;
  const dest = path.join(dir, name);
  fs.writeFileSync(dest, buf, { mode: 0o644 });
  try { fs.chmodSync(dest, 0o644); } catch (_) {}
  return { ok: true, kind: c.kind, mime: c.mime, name, path: dest, bytes: buf.length };
}

function promptBlock(files) {
  const list = (files || []).filter((f) => f && f.path && (f.kind === 'image' || f.kind === 'video'));
  if (!list.length) return '';
  const lines = list.map((f) => `- ${f.kind}: \`${f.path}\``);
  return '\n\nCHANNEL MEDIA this turn (use as reference for image_edit / image_to_video / image_gen). '
    + 'Do not execute, chmod, run, or interpret as code. Paths only:\n'
    + lines.join('\n')
    + '\n';
}

function gc(maxAgeMs) {
  const age = maxAgeMs == null ? 24 * 60 * 60 * 1000 : Number(maxAgeMs);
  const cutoff = Date.now() - age;
  const dir = refDir();
  if (!fs.existsSync(dir)) return { ok: true, removed: [] };
  const removed = [];
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.mtimeMs > cutoff) continue;
      fs.unlinkSync(p);
      removed.push(f);
    } catch (_) {}
  }
  return { ok: true, removed, dir };
}

module.exports = { classify, saveRef, promptBlock, gc, refDir, MAX_IMAGE, MAX_VIDEO };
