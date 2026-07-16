'use strict';
/**
 * asmltr storage substrate — the backend-agnostic interface that both DATA SILOS and BACKUPS ride on.
 *
 * A **storage integration** implements this driver contract. The built-in `local` driver (disk) is
 * always available and needs no config — silos are local-first. Remote drivers (s3/b2/spaces/dropbox/
 * gdrive/webdav/sftp) live under `integrations/types/<type>/` and register themselves here; their
 * credentials resolve via `shared/secrets.js` (→ the TRUST vault once P2 lands), never hardcoded.
 *
 * Contract — paths are POSIX-style and silo-relative; each driver maps them onto its backend:
 *   put(path, data)              -> { path, size, etag? }        // data: Buffer | string
 *   get(path)                    -> Buffer
 *   stat(path)                   -> { path, size, mtime, type } | null   // type: 'file' | 'dir'
 *   list(prefix, { recursive })  -> [{ path, size, mtime, type }]
 *   remove(path)                 -> void
 *   move(from, to)               -> void
 *   mkdir(path)                  -> void                          // no-op on object stores
 *   mint(path, { verb, ttl })    -> { url|null, headers?, expires_at? }   // DATA-PLANE capability
 *
 * `mint()` is the control-plane→data-plane handoff: it returns a short-lived, scoped capability (an
 * S3/WebDAV presigned URL, etc.) so a peer transfers bytes DIRECT to the backend, owner out of the
 * path. The `local` driver returns { url: null } (access is direct filesystem, no presigning).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto'); // Node's crypto (the global `crypto` is Web Crypto — no randomBytes)

// normalize + confine a silo-relative path to a base dir (no traversal escapes)
function safeJoin(base, rel) {
  const p = path.resolve(base, '.' + path.posix.sep + String(rel || '').replace(/\\/g, '/'));
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error(`path escapes storage root: ${rel}`);
  return p;
}

/** Built-in local-disk driver. `root` is the backend's base directory. */
class LocalStorage {
  constructor({ root } = {}) {
    this.root = path.resolve(root || path.join(os.homedir(), '.asmltr', 'storage'));
    fs.mkdirSync(this.root, { recursive: true });
  }
  _abs(rel) { return safeJoin(this.root, rel); }
  async put(rel, data) {
    const abs = this._abs(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    const st = fs.statSync(abs);
    return { path: String(rel), size: st.size };
  }
  async get(rel) { return fs.readFileSync(this._abs(rel)); }
  async stat(rel) {
    try { const st = fs.statSync(this._abs(rel)); return { path: String(rel), size: st.size, mtime: st.mtimeMs, type: st.isDirectory() ? 'dir' : 'file' }; }
    catch (_) { return null; }
  }
  async list(prefix = '', { recursive = false } = {}) {
    const base = this._abs(prefix);
    const out = [];
    const walk = (dir, relBase) => {
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        const rel = path.posix.join(relBase, e.name);
        const st = fs.statSync(abs);
        out.push({ path: rel, size: st.size, mtime: st.mtimeMs, type: e.isDirectory() ? 'dir' : 'file' });
        if (recursive && e.isDirectory()) walk(abs, rel);
      }
    };
    walk(base, String(prefix || ''));
    return out;
  }
  async remove(rel) { fs.rmSync(this._abs(rel), { recursive: true, force: true }); }
  async move(from, to) {
    const dst = this._abs(to);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(this._abs(from), dst);
  }
  async mkdir(rel) { fs.mkdirSync(this._abs(rel), { recursive: true }); }
  // Local access is direct filesystem — no presigning. Silo code reads the disk path directly.
  async mint(rel /*, opts */) { return { url: null, path: this._abs(rel) }; }
}

/**
 * Composable encryption-at-rest wrapper over ANY driver. `put` seals, `get` opens; the backend (and
 * anyone browsing it, e.g. Nextcloud's web UI) sees only ciphertext. Per-silo 32-byte key comes from
 * the vault (shared/vault.js). Layout per object: 'ASE1' | iv(12) | gcmTag(16) | ciphertext.
 * Chosen per-silo via the manifest `encryption` field; `none` silos just use the raw driver.
 */
class EncryptedStorage {
  constructor(inner, key) {
    if (!inner) throw new Error('EncryptedStorage: inner driver required');
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('EncryptedStorage: 32-byte key required');
    this.inner = inner; this.key = key;
  }
  _seal(buf) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(buf), c.final()]);
    return Buffer.concat([Buffer.from('ASE1'), iv, c.getAuthTag(), ct]);
  }
  _open(buf) {
    if (buf.length < 32 || buf.slice(0, 4).toString('latin1') !== 'ASE1') throw new Error('EncryptedStorage: not an encrypted object (bad magic)');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, buf.slice(4, 16));
    d.setAuthTag(buf.slice(16, 32));
    return Buffer.concat([d.update(buf.slice(32)), d.final()]);
  }
  async put(rel, data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const r = await this.inner.put(rel, this._seal(buf));
    return { ...r, size: buf.length }; // report PLAINTEXT size
  }
  async get(rel) { return this._open(await this.inner.get(rel)); }
  async stat(rel) { return this.inner.stat(rel); }       // size reflects ciphertext (+~32B) — acceptable
  async list(prefix, opts) { return this.inner.list(prefix, opts); }
  async remove(rel) { return this.inner.remove(rel); }
  async move(a, b) { return this.inner.move(a, b); }
  async mkdir(rel) { return this.inner.mkdir(rel); }
  async mint(rel, opts) { return this.inner.mint(rel, opts); }
}

/** Wrap a driver with encryption-at-rest. */
function encrypted(inner, key) { return new EncryptedStorage(inner, key); }

// Driver registry. `local` is built in; remote drivers register themselves on require.
const DRIVERS = { local: (cfg) => new LocalStorage(cfg) };

/** Register a storage driver type (called by integration drivers). factory(config) -> driver. */
function registerDriver(type, factory) { DRIVERS[type] = factory; }

/** Instantiate a storage driver for an integration ({ type, config }). Throws on unknown type. */
function getStorage({ type = 'local', config = {} } = {}) {
  const make = DRIVERS[type];
  if (!make) throw new Error(`unknown storage driver '${type}' (have: ${Object.keys(DRIVERS).join(', ')})`);
  return make(config);
}

module.exports = { getStorage, registerDriver, LocalStorage, EncryptedStorage, encrypted, safeJoin };
