'use strict';
/**
 * Email send-dedup — same To + subject (or body hash if no subject) inside a
 * short window is already delivered. Return ok without hitting SMTP.
 *
 * Compaction / a later tool round in the same Discord turn used to resend
 * because the original ✓ was no longer in context. The owner said: confirm
 * here, stop, wait for them to say it never arrived.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_WINDOW_MS = 30 * 60 * 1000;
const MAX_ROWS = 80;
const SKIP_KINDS = new Set(['guild_post', 'guild_resolve']);

function windowMs() {
  const n = Number(process.env.ASMLTR_SEND_DEDUP_WINDOW_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WINDOW_MS;
}

function enabled() {
  const v = String(process.env.ASMLTR_SEND_DEDUP || '').trim().toLowerCase();
  return v !== 'off' && v !== '0' && v !== 'false' && v !== 'no';
}

function filePath() {
  return process.env.ASMLTR_SEND_DEDUP_FILE
    || path.join(os.homedir(), '.asmltr', 'send-recent.json');
}

function fingerprint(body) {
  if (!body || typeof body !== 'object') return null;
  const ch = String(body.channel || '').toLowerCase();
  if (ch !== 'email') return null;
  const kind = String(body.kind || 'text');
  if (SKIP_KINDS.has(kind)) return null;
  const tgt = String(body.target || '').trim().toLowerCase();
  if (!tgt) return null;
  const subj = String(body.subject || '').trim().toLowerCase();
  if (subj) return `email|${tgt}|subj:${subj}`;
  const h = crypto.createHash('sha256')
    .update(kind + '\n' + String(body.text || '') + '\n' + String(body.path || ''))
    .digest('hex').slice(0, 16);
  return `email|${tgt}|body:${h}`;
}

function load(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (_) { return []; }
}

function save(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function prune(rows, now, win) {
  return rows.filter((r) => r && r.fp && typeof r.ts === 'number' && (now - r.ts) < win).slice(-MAX_ROWS);
}

function check(body, opts = {}) {
  if (!enabled()) return null;
  if (body && body.force) return null;
  const fp = fingerprint(body);
  if (!fp) return null;
  const now = opts.now || Date.now();
  const win = opts.windowMs || windowMs();
  const file = opts.file || filePath();
  const rows = prune(load(file), now, win);
  const hit = rows.find((r) => r.fp === fp);
  if (!hit) return null;
  return {
    ok: true,
    already_sent: true,
    skipped: true,
    at: new Date(hit.ts).toISOString(),
    via: hit.via || undefined,
    fingerprint: fp,
  };
}

function record(body, extra = {}, opts = {}) {
  if (!enabled()) return null;
  const fp = fingerprint(body);
  if (!fp) return null;
  const now = opts.now || Date.now();
  const win = opts.windowMs || windowMs();
  const file = opts.file || filePath();
  const rows = prune(load(file), now, win).filter((r) => r.fp !== fp);
  const row = {
    fp,
    ts: now,
    channel: 'email',
    target: String(body.target || '').trim(),
    subject: String(body.subject || '').trim() || undefined,
    via: extra.via || undefined,
  };
  rows.push(row);
  try { save(file, rows); } catch (_) { /* never fail a real send because the ledger could not write */ }
  return row;
}

function formatAlready(body, hit) {
  const ch = String((body && body.channel) || 'email');
  const tgt = String((body && body.target) || '');
  const at = (hit && hit.at) || '';
  const via = (hit && hit.via) ? ` (${hit.via})` : '';
  return `✓ already sent text to ${ch}:${tgt}${via} at ${at} — not resent. Same email within 30m. Do not send again unless they say it never arrived.`;
}

module.exports = {
  DEFAULT_WINDOW_MS,
  enabled,
  fingerprint,
  check,
  record,
  formatAlready,
  filePath,
};
