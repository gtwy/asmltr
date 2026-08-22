'use strict';
/**
 * Stage files for connector attach (Discord /out, etc.) without Bash.
 * Safe names, no overwrite, delete only after a confirmed post, bounce GC > 1 day.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DAY_MS = 24 * 60 * 60 * 1000;

function stageDir() {
  return process.env.ASMLTR_ATTACH_STAGE
    || path.join(os.homedir(), '.asmltr', 'attach-stage');
}

function indexPath() {
  return path.join(stageDir(), 'index.json');
}

function ensureDir() {
  fs.mkdirSync(stageDir(), { recursive: true });
}

function loadIndex() {
  ensureDir();
  try {
    const j = JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
    if (j && typeof j === 'object' && j.items && typeof j.items === 'object') return j;
  } catch (_) {}
  return { items: {} };
}

function saveIndex(idx) {
  ensureDir();
  const tmp = indexPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2));
  fs.renameSync(tmp, indexPath());
}

/** Lowercase, [a-z0-9_-] stem, one '.' + [a-z0-9] ext. */
function sanitizeFilename(input, fallbackExt) {
  const raw = String(input || '').trim() || 'file';
  const base = path.basename(raw).toLowerCase();
  const lastDot = base.lastIndexOf('.');
  let stem = lastDot > 0 ? base.slice(0, lastDot) : base;
  let ext = lastDot > 0 ? base.slice(lastDot + 1) : String(fallbackExt || 'bin');
  stem = stem.replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  ext = ext.replace(/[^a-z0-9]+/g, '');
  if (!stem) stem = 'file';
  if (!ext) ext = 'bin';
  return stem + '.' + ext;
}

function uniqueName(name) {
  ensureDir();
  const safe = sanitizeFilename(name);
  const lastDot = safe.lastIndexOf('.');
  const stem = safe.slice(0, lastDot);
  const ext = safe.slice(lastDot + 1);
  let n = safe;
  let i = 2;
  const idx = loadIndex();
  while (fs.existsSync(path.join(stageDir(), n)) || idx.items[n]) {
    n = stem + '-' + i + '.' + ext;
    i += 1;
  }
  return n;
}

function stageFile(srcPath, opts) {
  const src = path.resolve(String(srcPath || ''));
  if (!src || !fs.existsSync(src) || !fs.statSync(src).isFile()) {
    throw new Error('source file missing: ' + srcPath);
  }
  const suggested = (opts && opts.name) || path.basename(src);
  const name = uniqueName(suggested);
  const dest = path.join(stageDir(), name);
  fs.copyFileSync(src, dest);
  const st = fs.statSync(dest);
  const rec = {
    name,
    path: dest,
    source: src,
    bytes: st.size,
    created_at: Date.now(),
    complete: true,
    posted: false,
    posted_at: null,
    message_id: null,
    channel: (opts && opts.channel) || null,
    target: (opts && opts.target) || null,
  };
  const idx = loadIndex();
  idx.items[name] = rec;
  saveIndex(idx);
  return rec;
}

function get(name) {
  const idx = loadIndex();
  return idx.items[String(name)] || null;
}

function listUnposted() {
  const idx = loadIndex();
  return Object.values(idx.items).filter((r) => r && r.complete && !r.posted && r.path && fs.existsSync(r.path));
}

function markPosted(name, meta) {
  const idx = loadIndex();
  const rec = idx.items[String(name)];
  if (!rec) throw new Error('not staged: ' + name);
  rec.posted = true;
  rec.posted_at = Date.now();
  rec.message_id = (meta && meta.messageId) || rec.message_id || null;
  if (meta && meta.channel) rec.channel = meta.channel;
  if (meta && meta.target) rec.target = meta.target;
  saveIndex(idx);
  return rec;
}

/** Delete staged bytes only after a confirmed post. */
function removePostedFile(name) {
  const idx = loadIndex();
  const rec = idx.items[String(name)];
  if (!rec) return { ok: false, error: 'not staged' };
  if (!rec.posted) return { ok: false, error: 'not posted yet — will not delete' };
  try {
    if (rec.path && fs.existsSync(rec.path)) fs.unlinkSync(rec.path);
  } catch (e) {
    return { ok: false, error: e.message, rec };
  }
  delete idx.items[String(name)];
  saveIndex(idx);
  return { ok: true, name };
}

function gc(maxAgeMs) {
  const age = maxAgeMs == null ? DAY_MS : Number(maxAgeMs);
  const cutoff = Date.now() - age;
  ensureDir();
  const idx = loadIndex();
  const removed = [];
  for (const [name, rec] of Object.entries(idx.items)) {
    const t = Number(rec && rec.created_at) || 0;
    if (t && t > cutoff) continue;
    try {
      if (rec.path && fs.existsSync(rec.path)) fs.unlinkSync(rec.path);
    } catch (_) {}
    delete idx.items[name];
    removed.push(name);
  }
  for (const f of fs.readdirSync(stageDir())) {
    if (f === 'index.json' || f.endsWith('.tmp')) continue;
    const p = path.join(stageDir(), f);
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      if (st.mtimeMs > cutoff) continue;
      if (idx.items[f]) continue;
      fs.unlinkSync(p);
      removed.push(f);
    } catch (_) {}
  }
  saveIndex(idx);
  return { ok: true, removed, dir: stageDir() };
}

module.exports = {
  DAY_MS, stageDir, sanitizeFilename, uniqueName, stageFile,
  get, listUnposted, markPosted, removePostedFile, gc,
};
