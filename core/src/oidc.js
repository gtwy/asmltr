'use strict';
/**
 * OIDC provider (roadmap P1 phase F) — asmltr issues OAuth2/OIDC tokens so other apps can SSO against it.
 * Built on the standard `oidc-provider` (panva), NOT hand-rolled. Accounts map to asmltr's local users;
 * login/consent reuse the existing asmltr session (interactions in core/src/server.js). Keys + the client
 * registry persist under ~/.asmltr/oidc. OFF unless ASMLTR_OIDC=on.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Provider } = require('oidc-provider');
const auth = require('../../shared/auth');

const OIDC_DIR = process.env.ASMLTR_OIDC_DIR || path.join(os.homedir(), '.asmltr', 'oidc');
const KEYS_FILE = path.join(OIDC_DIR, 'keys.json');
const CLIENTS_FILE = path.join(OIDC_DIR, 'clients.json');

const enabled = () => /^(1|on|true|yes)$/i.test(process.env.ASMLTR_OIDC || '');
function issuer() {
  return process.env.ASMLTR_OIDC_ISSUER
    || (process.env.ASMLTR_AUTH_ORIGIN ? process.env.ASMLTR_AUTH_ORIGIN.replace(/\/+$/, '') + '/oidc' : 'http://localhost:' + (process.env.ASMLTR_CORE_PORT || 3023) + '/oidc');
}
function ensureDir() { fs.mkdirSync(OIDC_DIR, { recursive: true }); }

// Signing keys (RS256) + cookie keys — generated + persisted once (wrapped blobs stay verifiable across restarts).
function loadKeys() {
  try { return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch (_) { /* generate */ }
  ensureDir();
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = privateKey.export({ format: 'jwk' });
  jwk.use = 'sig'; jwk.alg = 'RS256'; jwk.kid = crypto.randomBytes(8).toString('hex');
  const keys = { jwks: { keys: [jwk] }, cookieKeys: [crypto.randomBytes(32).toString('hex'), crypto.randomBytes(32).toString('hex')] };
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

// ── client registry (file-backed; static at boot — adding a client needs a core restart to take effect) ──
function loadClients() { try { return JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8')); } catch (_) { return []; } }
function saveClients(c) { ensureDir(); fs.writeFileSync(CLIENTS_FILE, JSON.stringify(c, null, 2), { mode: 0o600 }); }
function listClients() { return loadClients().map((c) => ({ client_id: c.client_id, client_name: c.client_name, redirect_uris: c.redirect_uris, grant_types: c.grant_types })); }
function addClient({ client_name, redirect_uris, public: isPublic }) {
  const c = loadClients();
  const client_id = 'asmltr_' + crypto.randomBytes(6).toString('hex');
  const client = {
    client_id, client_name: client_name || client_id,
    redirect_uris: Array.isArray(redirect_uris) ? redirect_uris : [redirect_uris].filter(Boolean),
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    token_endpoint_auth_method: isPublic ? 'none' : 'client_secret_basic',
  };
  if (!isPublic) client.client_secret = crypto.randomBytes(32).toString('base64url');
  c.push(client); saveClients(c);
  return client; // client_secret shown once
}
function removeClient(id) { const c = loadClients(); const n = c.filter((x) => x.client_id !== id); saveClients(n); return n.length < c.length; }

let _provider = null;
function getProvider() {
  if (_provider) return _provider;
  const keys = loadKeys();
  const provider = new Provider(issuer(), {
    clients: loadClients(),
    jwks: keys.jwks,
    cookies: { keys: keys.cookieKeys },
    findAccount: async (ctx, id) => (auth.accountExists(id)
      ? { accountId: id, claims: async () => ({ sub: id, preferred_username: id }) }
      : undefined),
    claims: { openid: ['sub'], profile: ['preferred_username'] },
    features: {
      devInteractions: { enabled: false },
      rpInitiatedLogout: { enabled: true },
    },
    pkce: { required: () => false }, // confidential clients don't need PKCE; public clients still should
    interactions: { url: (ctx, interaction) => `/oidc/interaction/${interaction.uid}` },
    ttl: { AccessToken: 3600, IdToken: 3600, RefreshToken: 14 * 86400, Session: 12 * 3600, Interaction: 600, Grant: 14 * 86400 },
  });
  provider.proxy = true; // behind Traefik + nginx (trust X-Forwarded-*)
  _provider = provider;
  return provider;
}

module.exports = { enabled, issuer, getProvider, listClients, addClient, removeClient, OIDC_DIR };
