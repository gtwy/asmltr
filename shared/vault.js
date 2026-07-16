'use strict';
/**
 * asmltr → TRUST Protocol vault client.
 *
 * The vault (github.com/jarethmt/trust-protocol) is a separate service that stores credentials
 * AES-256-GCM-encrypted and hands out values only to trusted agents via single-use proxy-value tokens.
 * asmltr registers itself as a SACRED agent; the trusted core uses this client to store/fetch its own
 * secrets and to mint/fetch per-silo content-encryption keys for EncryptedStorage.
 *
 * The vault's OWN access keys are bootstrap secrets (chicken-and-egg — they can't live in the vault),
 * so they come from the environment (seeded from a bootstrap store at install):
 *   ASMLTR_VAULT_URL        (default http://127.0.0.1:9500/v1)
 *   ASMLTR_VAULT_ADMIN_KEY  (store/delete credentials + agent management)
 *   ASMLTR_VAULT_AGENT_KEY  (SACRED agent key — proxy-value retrieval)
 *
 * NOTE (candidate TRUST enhancement): proxy-value tokens are single-use/60s — ideal for proxying an
 * API call, heavier for a content key needed on every file op. This client caches fetched keys in
 * memory per name so the token dance runs once per key per process. A future KMS-style wrap/unwrap
 * primitive in TRUST (vault wraps/unwraps a data key; master key never leaves) would be cleaner still.
 */
const crypto = require('crypto');

function cfg() {
  return {
    url: (process.env.ASMLTR_VAULT_URL || 'http://127.0.0.1:9500/v1').replace(/\/+$/, ''),
    adminKey: process.env.ASMLTR_VAULT_ADMIN_KEY || '',
    agentKey: process.env.ASMLTR_VAULT_AGENT_KEY || '',
  };
}

async function _json(res, ctx) {
  if (!res.ok) { let body = ''; try { body = await res.text(); } catch (_) {} throw new Error(`vault ${ctx}: HTTP ${res.status} ${body.slice(0, 200)}`); }
  return res.status === 204 ? null : res.json();
}

/** Is the vault reachable + unsealed? -> { ok, sealed } (never throws). */
async function health() {
  try { const r = await fetch(cfg().url + '/health'); const d = await r.json(); return { ok: d.status === 'ok', sealed: !!d.sealed }; }
  catch (e) { return { ok: false, sealed: null, error: e.message }; }
}

/** Store a credential (admin). `data` is an object; `minTrust` gates who may retrieve it. */
async function storeSecret(name, data, { minTrust = 'SACRED', allowedDomains = [] } = {}) {
  const c = cfg();
  const r = await fetch(c.url + '/credentials', {
    method: 'POST', headers: { 'X-Admin-Key': c.adminKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, credential_data: data, minimum_trust: minTrust, allowed_domains: allowedDomains }),
  });
  return _json(r, `store ${name}`);
}

async function deleteSecret(name) {
  const c = cfg();
  const r = await fetch(c.url + '/credentials/' + encodeURIComponent(name), { method: 'DELETE', headers: { 'X-Admin-Key': c.adminKey } });
  if (r.status !== 204 && r.status !== 404) return _json(r, `delete ${name}`);
}

/** Retrieve a credential's value object (SACRED agent, via single-use proxy-value token). */
async function getSecret(name, purpose = 'asmltr core access') {
  const c = cfg();
  const t = await _json(await fetch(c.url + '/credentials/' + encodeURIComponent(name) + '/proxy-value', {
    method: 'POST', headers: { 'X-Agent-Key': c.agentKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose }),
  }), `proxy-value ${name}`);
  const ex = await _json(await fetch(c.url + '/credentials/proxy-value/' + encodeURIComponent(t.token_id) + '/exchange', {
    headers: { 'X-Agent-Key': c.agentKey },
  }), `exchange ${name}`);
  return ex.value; // the stored credential_data object
}

/** List credential metadata (admin; names + tiers, never values). */
async function listSecrets() {
  const c = cfg();
  return _json(await fetch(c.url + '/credentials', { headers: { 'X-Admin-Key': c.adminKey } }), 'list');
}

// ---- content keys for EncryptedStorage ------------------------------------------------------------
const _keyCache = new Map(); // name -> Buffer (in-memory, per process; see note above)

/** Mint a fresh 256-bit content key, store it in the vault (SACRED), and return the raw Buffer. */
async function mintContentKey(name) {
  const key = crypto.randomBytes(32);
  await storeSecret(name, { value: key.toString('base64'), kind: 'content-key', alg: 'aes-256-gcm' }, { minTrust: 'SACRED' });
  _keyCache.set(name, key);
  return key;
}

/** Fetch a content key by name -> Buffer (cached per process). Throws if absent. */
async function getContentKey(name) {
  if (_keyCache.has(name)) return _keyCache.get(name);
  const v = await getSecret(name, 'silo content encryption');
  const b64 = v && (v.value || v); // tolerate {value} or raw
  if (!b64 || typeof b64 !== 'string') throw new Error(`vault: no content key '${name}'`);
  const key = Buffer.from(b64, 'base64');
  _keyCache.set(name, key);
  return key;
}

module.exports = { health, storeSecret, deleteSecret, getSecret, listSecrets, mintContentKey, getContentKey };
