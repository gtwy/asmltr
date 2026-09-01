'use strict';
/**
 * Outbound attachment paths for `asmltr send` / manager /send / connector /out.
 *
 * Repeatable `--file` becomes `files: [path, …]` plus `path` (the first) for older connectors.
 * Cap is 25MB **total** of those files (not the inline signature image).
 */
const fs = require('fs');
const path = require('path');

const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

function collectOutboundFiles(body) {
  const raw = [];
  const push = (v) => {
    if (v == null || v === '') return;
    if (Array.isArray(v)) {
      for (const x of v) push(x);
      return;
    }
    const s = String(v).trim();
    if (s) raw.push(s);
  };
  if (body && typeof body === 'object') {
    push(body.files);
    push(body.path);
    push(body.file);
    push(body.filePath);
  }
  const seen = new Set();
  const out = [];
  for (const p of raw) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function attachmentsFromPaths(paths) {
  const list = Array.isArray(paths) ? paths : [];
  let total = 0;
  const atts = [];
  for (const p of list) {
    const abs = String(p || '').trim();
    if (!abs) continue;
    let st;
    try {
      st = fs.statSync(abs);
    } catch (e) {
      const err = new Error(`attachment not found: ${abs}`);
      err.code = 'ENOENT';
      err.cause = e;
      throw err;
    }
    if (!st.isFile()) {
      const err = new Error(`not a file: ${abs}`);
      err.code = 'ENOTFILE';
      throw err;
    }
    total += st.size;
    if (total > MAX_TOTAL_BYTES) {
      const err = new Error('attachments exceed 25MB total');
      err.code = 'ATTACH_TOO_LARGE';
      err.bytes = total;
      throw err;
    }
    atts.push({ path: abs, filename: path.basename(abs) });
  }
  return atts;
}

module.exports = { MAX_TOTAL_BYTES, collectOutboundFiles, attachmentsFromPaths };
