'use strict';
/**
 * OIDC / OAuth2 client (roadmap P1 phase D) — let people sign into asmltr via an external provider
 * (GitHub, Google) mapped to a LOCAL account. OFF by default: a provider is enabled only when its
 * client id + secret are set (`ASMLTR_OIDC_<PROVIDER>_ID` / `_SECRET`), so no config = no external login.
 *
 * Security model (default-deny): external login only succeeds for an identity a user has LINKED to their
 * account (Settings → Security → Connect). Unlinked identities are rejected — you can't create or hijack
 * an account by signing in with a random Google/GitHub. Linking happens while already logged in.
 */
const crypto = require('crypto');

const PROVIDERS = {
  github: {
    label: 'GitHub',
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    async identity(accessToken) {
      const h = { Authorization: 'Bearer ' + accessToken, 'User-Agent': 'asmltr', Accept: 'application/vnd.github+json' };
      const u = await (await fetch('https://api.github.com/user', { headers: h })).json();
      let email = u.email;
      if (!email) { const emails = await (await fetch('https://api.github.com/user/emails', { headers: h })).json(); const p = (emails || []).find((e) => e.primary && e.verified) || (emails || []).find((e) => e.verified); email = p && p.email; }
      return { subject: String(u.id), email: email || null, name: u.login };
    },
  },
  google: {
    label: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    async identity(accessToken) {
      const info = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + accessToken } })).json();
      return { subject: info.sub, email: info.email_verified ? info.email : null, name: info.name };
    },
  },
};

function cfg(provider) {
  const P = PROVIDERS[provider];
  if (!P) return null;
  const id = process.env['ASMLTR_OIDC_' + provider.toUpperCase() + '_ID'];
  const secret = process.env['ASMLTR_OIDC_' + provider.toUpperCase() + '_SECRET'];
  return id && secret ? { ...P, id, secret } : null;
}
function enabledProviders() { return Object.keys(PROVIDERS).filter((p) => cfg(p)).map((p) => ({ id: p, label: PROVIDERS[p].label })); }

// CSRF state — short-lived one-time nonces.
const states = new Map();
function newState() { const s = crypto.randomBytes(16).toString('hex'); states.set(s, Date.now() + 10 * 60 * 1000); return s; }
function checkState(s) { const exp = states.get(s); states.delete(s); return !!(exp && exp > Date.now()); }

function origin() { return (process.env.ASMLTR_AUTH_ORIGIN || '').replace(/\/+$/, ''); }
function redirectUri(provider) { return origin() + '/v2/auth/external/' + provider + '/callback'; }

function authorizeUrl(provider) {
  const c = cfg(provider); if (!c) throw new Error('provider not enabled');
  const params = new URLSearchParams({ client_id: c.id, redirect_uri: redirectUri(provider), scope: c.scope, response_type: 'code', state: newState() });
  if (provider === 'google') { params.set('access_type', 'online'); params.set('prompt', 'select_account'); }
  return c.authorize + '?' + params.toString();
}

async function exchange(provider, code) {
  const c = cfg(provider); if (!c) throw new Error('provider not enabled');
  const body = new URLSearchParams({ client_id: c.id, client_secret: c.secret, code, redirect_uri: redirectUri(provider), grant_type: 'authorization_code' });
  const r = await fetch(c.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error('token exchange failed');
  return c.identity(j.access_token);
}

module.exports = { enabledProviders, authorizeUrl, exchange, checkState };
