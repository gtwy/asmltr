'use strict';
/**
 * asmltr device registry — the control plane for MACHINES (docs/DEVICE-REGISTRY.md).
 *
 * asmltr already has registries for SERVICES it talks to over an API (connector instances,
 * integrations, MCP servers). This is the missing one: the machines it DRIVES, and the devices that
 * drive it. Same row for both directions — a workstation reachable by screen and shell, and a phone
 * that holds an assistant session, are both `devices`; `device_transports` is what differs.
 *
 *   devices            : one row per machine, durable whether or not it is powered on
 *   device_transports  : how to reach it (rd | ssh | adb | device-gw | serial | http) + a VAULT KEY
 *   device_enrollments : one-time codes that let a machine claim its own credential
 *
 * Deliberately NOT a second identity store: `owner_principal_id` and every future grant key on
 * `principals.id` from the trust store, and this module reuses that store's database handle so the
 * two are literally one file. Same argument as the cast.
 *
 * SECRET HANDLING — the invariant this module exists to enforce:
 *   • the credential VALUE lives only in the TRUST vault, under `credential_ref`
 *   • the database holds only `token_hash` (SHA-256), enough to VERIFY a presented token, never to
 *     reproduce it. A registry read cannot leak a working credential.
 *   • one-time enrollment codes are stored hashed too, for the same reason.
 */
const crypto = require('crypto');
const { db } = require('../trust/store');

db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    kind               TEXT NOT NULL DEFAULT 'workstation',  -- workstation|phone|sbc|appliance|printer|other
    platform           TEXT,                                 -- windows|macos|linux|android|…
    owner_principal_id TEXT REFERENCES principals(id) ON DELETE SET NULL,
    tags               TEXT NOT NULL DEFAULT '[]',
    notes              TEXT,
    status             TEXT NOT NULL DEFAULT 'active',       -- active|retired
    last_seen_at       INTEGER,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS device_transports (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id      TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    transport      TEXT NOT NULL,
    address        TEXT,
    params         TEXT NOT NULL DEFAULT '{}',
    credential_ref TEXT,                                     -- vault key name — NEVER a value
    token_hash     TEXT,                                     -- SHA-256 of the issued credential
    enabled        INTEGER NOT NULL DEFAULT 1,
    revoked_at     INTEGER,
    verified_at    INTEGER,
    last_seen_at   INTEGER,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    UNIQUE(device_id, transport)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_dt_token ON device_transports(token_hash) WHERE token_hash IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_dt_device ON device_transports(device_id);
  CREATE TABLE IF NOT EXISTS device_enrollments (
    code_hash   TEXT PRIMARY KEY,
    device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    transport   TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    redeemed_at INTEGER,
    created_at  INTEGER NOT NULL
  );
`);

const now = () => Date.now();
const J = (s, d) => { try { return JSON.parse(s || ''); } catch { return d; } };
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const TRANSPORTS = ['rd', 'ssh', 'adb', 'device-gw', 'serial', 'http'];
const KINDS = ['workstation', 'phone', 'sbc', 'appliance', 'printer', 'other'];

function slug(name) {
  return String(name || 'device').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'device';
}

/** Transport row → API shape. `credential_ref` is a NAME; the value never leaves the vault. */
function shapeTransport(t) {
  return {
    id: t.id, transport: t.transport, address: t.address, params: J(t.params, {}),
    credential_ref: t.credential_ref, enrolled: !!t.token_hash,
    enabled: !!t.enabled && !t.revoked_at, revoked_at: t.revoked_at,
    verified_at: t.verified_at, last_seen_at: t.last_seen_at,
  };
}
function shape(d) {
  if (!d) return null;
  return {
    ...d, tags: J(d.tags, []),
    transports: db.prepare('SELECT * FROM device_transports WHERE device_id=? ORDER BY transport').all(d.id).map(shapeTransport),
  };
}

const devices = {
  list: ({ transport, status } = {}) => {
    let rows = db.prepare('SELECT * FROM devices ORDER BY name').all();
    if (status) rows = rows.filter((r) => r.status === status);
    let out = rows.map(shape);
    if (transport) out = out.filter((d) => d.transports.some((t) => t.transport === transport && t.enabled));
    return out;
  },
  get: (id) => shape(db.prepare('SELECT * FROM devices WHERE id=?').get(id)),
  create: ({ id, name, kind = 'workstation', platform = null, owner_principal_id = null, tags = [], notes = '' }) => {
    if (!name) throw new Error('name is required');
    if (!KINDS.includes(kind)) throw new Error(`kind must be one of: ${KINDS.join(', ')}`);
    const did = id || `${slug(name)}-${crypto.randomUUID().slice(0, 4)}`;
    if (devices.get(did)) throw new Error(`device ${did} already exists`);
    db.prepare(`INSERT INTO devices (id,name,kind,platform,owner_principal_id,tags,notes,status,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?, 'active', ?,?)`)
      .run(did, name, kind, platform, owner_principal_id, JSON.stringify(tags || []), notes || '', now(), now());
    return devices.get(did);
  },
  update: (id, f = {}) => {
    const d = db.prepare('SELECT * FROM devices WHERE id=?').get(id);
    if (!d) return null;
    if (f.kind && !KINDS.includes(f.kind)) throw new Error(`kind must be one of: ${KINDS.join(', ')}`);
    db.prepare('UPDATE devices SET name=?, kind=?, platform=?, owner_principal_id=?, tags=?, notes=?, status=?, updated_at=? WHERE id=?')
      .run(f.name ?? d.name, f.kind ?? d.kind, f.platform ?? d.platform,
        f.owner_principal_id !== undefined ? f.owner_principal_id : d.owner_principal_id,
        JSON.stringify(f.tags ?? J(d.tags, [])), f.notes ?? d.notes, f.status ?? d.status, now(), id);
    return devices.get(id);
  },
  remove: (id) => db.prepare('DELETE FROM devices WHERE id=?').run(id).changes > 0,
  touch: (id) => { db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(now(), id); },
};

const transports = {
  get: (deviceId, transport) => {
    const t = db.prepare('SELECT * FROM device_transports WHERE device_id=? AND transport=?').get(deviceId, transport);
    return t ? shapeTransport(t) : null;
  },
  /** Add/replace how a device is reached. Never accepts a secret VALUE — only a vault key name. */
  upsert: (deviceId, { transport, address = null, params = {}, credential_ref = null, enabled = true }) => {
    if (!devices.get(deviceId)) throw new Error(`unknown device: ${deviceId}`);
    if (!TRANSPORTS.includes(transport)) throw new Error(`transport must be one of: ${TRANSPORTS.join(', ')}`);
    db.prepare(`INSERT INTO device_transports (device_id,transport,address,params,credential_ref,enabled,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT(device_id,transport) DO UPDATE SET address=excluded.address, params=excluded.params,
                  credential_ref=COALESCE(excluded.credential_ref, device_transports.credential_ref),
                  enabled=excluded.enabled, updated_at=excluded.updated_at`)
      .run(deviceId, transport, address, JSON.stringify(params || {}), credential_ref, enabled ? 1 : 0, now(), now());
    return transports.get(deviceId, transport);
  },
  remove: (deviceId, transport) => db.prepare('DELETE FROM device_transports WHERE device_id=? AND transport=?').run(deviceId, transport).changes > 0,
  /** Bind an issued credential to a transport: store only its HASH + the vault key that holds it. */
  bindCredential: (deviceId, transport, token, credentialRef) => {
    db.prepare('UPDATE device_transports SET token_hash=?, credential_ref=?, revoked_at=NULL, enabled=1, verified_at=?, updated_at=? WHERE device_id=? AND transport=?')
      .run(sha(token), credentialRef, now(), now(), deviceId, transport);
    return transports.get(deviceId, transport);
  },
  /** Revoke one transport (or every transport of a device when `transport` is omitted). */
  revoke: (deviceId, transport = null) => {
    const sql = transport
      ? 'UPDATE device_transports SET revoked_at=?, enabled=0, token_hash=NULL, updated_at=? WHERE device_id=? AND transport=?'
      : 'UPDATE device_transports SET revoked_at=?, enabled=0, token_hash=NULL, updated_at=? WHERE device_id=?';
    const args = transport ? [now(), now(), deviceId, transport] : [now(), now(), deviceId];
    return db.prepare(sql).run(...args).changes;
  },
  touch: (deviceId, transport) => {
    db.prepare('UPDATE device_transports SET last_seen_at=? WHERE device_id=? AND transport=?').run(now(), deviceId, transport);
    devices.touch(deviceId);
  },
};

/**
 * Verify a presented device credential. THE HOT PATH: the remote-desktop broker calls this on every
 * signaling message, so it must stay a single indexed lookup with no vault round-trip — which is
 * exactly why the hash lives in this table. Returns null for unknown/revoked/retired (default-deny).
 */
function authenticate(token, transport = null) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM device_transports WHERE token_hash=?').get(sha(token));
  if (!row || row.revoked_at || !row.enabled) return null;
  if (transport && row.transport !== transport) return null;
  const d = db.prepare('SELECT * FROM devices WHERE id=?').get(row.device_id);
  if (!d || d.status !== 'active') return null;
  return {
    device_id: d.id, name: d.name, kind: d.kind,
    transport: row.transport,
    owner_principal_id: d.owner_principal_id || null,
    credential_ref: row.credential_ref,
  };
}

/** One-time enrollment codes — stored hashed, single-use, short-lived. */
const enrollments = {
  create: (deviceId, transport, ttlMs = 15 * 60 * 1000) => {
    if (!devices.get(deviceId)) throw new Error(`unknown device: ${deviceId}`);
    if (!TRANSPORTS.includes(transport)) throw new Error(`transport must be one of: ${TRANSPORTS.join(', ')}`);
    const code = crypto.randomBytes(24).toString('base64url');
    db.prepare('INSERT INTO device_enrollments (code_hash,device_id,transport,expires_at,created_at) VALUES (?,?,?,?,?)')
      .run(sha(code), deviceId, transport, now() + ttlMs, now());
    return { code, device_id: deviceId, transport, expires_at: now() + ttlMs };
  },
  /** Consume a code. Single-use even under concurrency: the UPDATE only wins once. */
  consume: (code) => {
    if (!code) return null;
    const h = sha(code);
    const row = db.prepare('SELECT * FROM device_enrollments WHERE code_hash=?').get(h);
    if (!row || row.redeemed_at || row.expires_at < now()) return null;
    const won = db.prepare('UPDATE device_enrollments SET redeemed_at=? WHERE code_hash=? AND redeemed_at IS NULL').run(now(), h).changes;
    if (!won) return null;
    return { device_id: row.device_id, transport: row.transport };
  },
  purgeExpired: () => db.prepare('DELETE FROM device_enrollments WHERE expires_at < ? AND redeemed_at IS NULL').run(now()).changes,
};

module.exports = { devices, transports, enrollments, authenticate, TRANSPORTS, KINDS, sha, db };
