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
 * Two complementary uses:
 *   • CREDENTIALS (use-but-never-see): API keys the agent never touches — the vault proxies the call.
 *     store/getSecret below (getSecret is the SACRED raw-fetch, for the trusted core only).
 *   • KMS (envelope encryption): data keys the runtime MUST use to encrypt its own data at rest
 *     (silos, backups, local DBs). generate/wrap/unwrap. The KMS MASTER key never leaves the vault;
 *     asmltr holds only a WRAPPED blob at rest + the plaintext data key transiently, in the runtime
 *     crypto layer — NEVER surfaced to the model's context, and zeroed after use (EncryptedStorage).
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

// ---- KMS: envelope encryption for data keys (EncryptedStorage) ------------------------------------
// The vault's master key never leaves the server. asmltr stores only the WRAPPED blob (next to the
// data, e.g. in a silo's .silo/) and unwraps on demand. Plaintext data keys are NOT cached here — the
// caller (EncryptedStorage) holds one transiently and zeroes it after use.

async function _kms(path, body) {
  const c = cfg();
  return _json(await fetch(c.url + '/kms/' + path, {
    method: 'POST', headers: { 'X-Agent-Key': c.agentKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), `kms ${path}`);
}

/** Generate a fresh data key -> { key: Buffer, wrapped: base64 }. Use the key, store the wrapped blob. */
async function generateDataKey(bytes = 32) {
  const r = await _kms('generate', { bytes });
  return { key: Buffer.from(r.plaintext, 'base64'), wrapped: r.wrapped };
}

/** Wrap a raw data key (Buffer) -> wrapped base64 blob. */
async function wrapKey(key) { return (await _kms('wrap', { plaintext: Buffer.from(key).toString('base64') })).wrapped; }

/** Unwrap a wrapped blob (base64) -> data key Buffer. */
async function unwrapKey(wrapped) { return Buffer.from((await _kms('unwrap', { wrapped })).plaintext, 'base64'); }

module.exports = { health, storeSecret, deleteSecret, getSecret, listSecrets, generateDataKey, wrapKey, unwrapKey };
