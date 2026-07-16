'use strict';
/**
 * Integrations registry — configured links to third-party services (storage today; more later).
 * Unlike connectors, integrations are NOT supervised processes — just config + a driver loaded on
 * demand. Config is stored as JSON; secret-bearing fields are stored as *_ref (a vault key name) and
 * resolved from the TRUST vault (via shared/secrets.js) only at open time — never persisted in the clear.
 *
 * Convention: any config field ending in `_ref` holds a vault key name; on open it resolves to the
 * field without the suffix (e.g. `password_ref: "nextcloud_eve_account"` → `password: <secret>`).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const secrets = require('../shared/secrets');
const storage = require('../shared/storage');

function file() { return process.env.ASMLTR_INTEGRATIONS_FILE || path.join(os.homedir(), '.asmltr', 'integrations.json'); }
function load() { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch (_) { return {}; } }
function save(d) { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(d, null, 2)); }
function id() { return 'int_' + Math.random().toString(36).slice(2, 10); }

function list() { return Object.values(load()); }               // configs only — *_ref are key names, not secrets
function get(iid) { return load()[iid] || null; }
function create({ type, name, config = {} }) { const d = load(); const it = { id: id(), type, name, config, created_at: Date.now() }; d[it.id] = it; save(d); return it; }
function update(iid, patch) { const d = load(); if (!d[iid]) return null; d[iid] = { ...d[iid], ...patch, id: iid, updated_at: Date.now() }; save(d); return d[iid]; }
function remove(iid) { const d = load(); if (!d[iid]) return false; delete d[iid]; save(d); return true; }

// require the driver module so it self-registers with shared/storage
function loadDriver(type) { if (type === 'local') return; try { require('./types/' + type); } catch (e) { throw new Error(`no driver for integration type '${type}': ${e.message}`); } }

async function resolveConfig(config) {
  const out = {};
  for (const [k, v] of Object.entries(config || {})) {
    if (k.endsWith('_ref') && typeof v === 'string') out[k.slice(0, -4)] = await secrets.get(v); // vault → value
    else out[k] = v;
  }
  return out;
}

/** Open a live storage handle for a storage integration (driver loaded, creds resolved from the vault). */
async function openStorage(iid) {
  const it = get(iid);
  if (!it) throw new Error('integration not found: ' + iid);
  loadDriver(it.type);
  return storage.getStorage({ type: it.type, config: await resolveConfig(it.config) });
}

/** Connectivity test — open + a cheap list. { ok } or { ok:false, error }. */
async function test(iid) {
  try { const s = await openStorage(iid); await s.list('', { recursive: false }); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { list, get, create, update, remove, openStorage, test, resolveConfig };
