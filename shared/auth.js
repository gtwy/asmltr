'use strict';
/**
 * Auth — the session-gate foundation for asmltr's identity plane (roadmap P1; docs/AUTH.md).
 *
 * Phase A only: local accounts (scrypt password, constant-time verify) + stateless HMAC-signed session
 * tokens + login rate-limiting. Everything here is ADDITIVE and OFF unless `ASMLTR_AUTH=on` — the gate
 * (`requireAuth`) is a no-op while disabled, so wiring it in can never lock out a live install. TOTP /
 * passkey / OIDC / forward-auth / OIDC-provider / vault-linkage are later phases that build on this.
 *
 * Sessions are stateless: `base64url(payload).base64url(HMAC-SHA256(payload, secret))`, payload =
 * `{sub, iat, exp, v}`. `v` is the account store's token version — bumping it revokes all sessions. The
 * signing secret is `ASMLTR_AUTH_SECRET`, else a generated `~/.asmltr/auth/secret` (persisted 0600) so
 * sessions survive restarts without editing `.env`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const AUTH_DIR = process.env.ASMLTR_AUTH_DIR || path.join(os.homedir(), '.asmltr', 'auth');
const ACCOUNTS = path.join(AUTH_DIR, 'accounts.json');
const SECRET_FILE = path.join(AUTH_DIR, 'secret');
const COOKIE = process.env.ASMLTR_AUTH_COOKIE || 'asmltr_session';
const SESSION_TTL = Number(process.env.ASMLTR_AUTH_TTL || 12 * 3600); // seconds
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

function enabled() { return /^(1|on|true|yes)$/i.test(process.env.ASMLTR_AUTH || ''); }
function ensureDir() { fs.mkdirSync(AUTH_DIR, { recursive: true }); }

// ── signing secret (env → persisted file → generate) ──────────────────────────
let _secret = null;
function secret() {
  if (_secret) return _secret;
  if (process.env.ASMLTR_AUTH_SECRET) return (_secret = Buffer.from(process.env.ASMLTR_AUTH_SECRET, 'utf8'));
  try { return (_secret = fs.readFileSync(SECRET_FILE)); } catch (_) { /* generate below */ }
  ensureDir();
  const s = crypto.randomBytes(48);
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return (_secret = s);
}

// ── account store ─────────────────────────────────────────────────────────────
function load() { try { return JSON.parse(fs.readFileSync(ACCOUNTS, 'utf8')); } catch (_) { return { users: {}, token_version: 1 }; } }
function save(d) { ensureDir(); fs.writeFileSync(ACCOUNTS, JSON.stringify(d, null, 2), { mode: 0o600 }); }

function hasAccount() { const d = load(); return Object.keys(d.users || {}).length > 0; }
function listUsers() { return Object.keys(load().users || {}); }

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(Buffer.from(password, 'utf8'), salt, SCRYPT.keylen, SCRYPT);
  return { salt: salt.toString('hex'), hash: hash.toString('hex'), algo: 'scrypt', params: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen } };
}

function createAccount(username, password) {
  if (!username || !password) throw new Error('username + password required');
  if (String(password).length < 8) throw new Error('password must be at least 8 characters');
  const d = load();
  if (d.users[username]) throw new Error('account already exists: ' + username);
  d.users[username] = { ...hashPassword(password), created_at: Date.now() };
  if (!d.token_version) d.token_version = 1;
  save(d);
  return { username };
}

function setPassword(username, password) {
  const d = load();
  if (!d.users[username]) throw new Error('no such account: ' + username);
  d.users[username] = { ...d.users[username], ...hashPassword(password), updated_at: Date.now() };
  save(d);
  return { username };
}

/** Constant-time password verify. Always does a scrypt to blunt user-enumeration timing. */
function verifyPassword(username, password) {
  const d = load();
  const u = d.users[username];
  const salt = Buffer.from((u && u.salt) || '00'.repeat(16), 'hex');
  const params = (u && u.params) || SCRYPT;
  const want = Buffer.from((u && u.hash) || '', 'hex');
  const got = crypto.scryptSync(Buffer.from(String(password), 'utf8'), salt, (u && u.params && u.params.keylen) || SCRYPT.keylen, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT.maxmem });
  return !!u && want.length === got.length && crypto.timingSafeEqual(want, got);
}

// ── sessions (stateless, HMAC-signed) ──────────────────────────────────────────
const b64u = (b) => Buffer.from(b).toString('base64url');
function sign(payloadB64) { return crypto.createHmac('sha256', secret()).update(payloadB64).digest('base64url'); }

function issueSession(username, ttl = SESSION_TTL) {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64u(JSON.stringify({ sub: username, iat: now, exp: now + ttl, v: load().token_version || 1 }));
  return payload + '.' + sign(payload);
}

/** Verify a token → { sub } or null. Constant-time signature check; honors expiry + token version. */
function verifySession(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  const expect = sign(payloadB64);
  const a = Buffer.from(sig || '', 'utf8'); const b = Buffer.from(expect, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p; try { p = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')); } catch (_) { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (!p.exp || p.exp < now) return null;
  if ((p.v || 1) !== (load().token_version || 1)) return null; // global revoke
  return { sub: p.sub };
}

/** Revoke every session (bump token version). */
function revokeAllSessions() { const d = load(); d.token_version = (d.token_version || 1) + 1; save(d); return d.token_version; }

// ── login rate-limiting (in-memory, per key) ───────────────────────────────────
const attempts = new Map(); // key -> { fails, until }
const MAX_FAILS = Number(process.env.ASMLTR_AUTH_MAX_FAILS || 8);
const LOCK_MS = Number(process.env.ASMLTR_AUTH_LOCK_MS || 15 * 60 * 1000);
function isLockedOut(key) { const a = attempts.get(key); return !!(a && a.until && a.until > Date.now()); }
function recordFail(key) { const a = attempts.get(key) || { fails: 0, until: 0 }; a.fails++; if (a.fails >= MAX_FAILS) { a.until = Date.now() + LOCK_MS; a.fails = 0; } attempts.set(key, a); }
function recordSuccess(key) { attempts.delete(key); }

// ── cookie helpers ──────────────────────────────────────────────────────────
function sessionCookie(token, { secure = true } = {}) {
  const attrs = [`${COOKIE}=${token}`, 'HttpOnly', 'Path=/', `Max-Age=${SESSION_TTL}`, 'SameSite=Lax'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}
function clearCookie() { return `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`; }
function tokenFromReq(req) {
  const auth = req.headers['authorization'];
  if (auth && /^Bearer /i.test(auth)) return auth.replace(/^Bearer /i, '').trim();
  const cookie = req.headers['cookie'] || '';
  const m = cookie.split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === COOKIE);
  return m ? decodeURIComponent(m.slice(1).join('=')) : null;
}

/** Express middleware. No-op while disabled; otherwise requires a valid session or 401. */
function requireAuth(req, res, next) {
  if (!enabled()) return next();
  const s = verifySession(tokenFromReq(req));
  if (!s) return res.status(401).json({ error: 'authentication required' });
  req.authUser = s.sub;
  next();
}

module.exports = {
  enabled, hasAccount, listUsers, createAccount, setPassword, verifyPassword,
  issueSession, verifySession, revokeAllSessions,
  isLockedOut, recordFail, recordSuccess,
  sessionCookie, clearCookie, tokenFromReq, requireAuth,
  COOKIE, SESSION_TTL,
};
