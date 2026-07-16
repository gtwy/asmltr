'use strict';
/**
 * WebAuthn passkeys (roadmap P1 phase C) — passwordless, phishing-resistant login + a strong factor.
 * Crypto via @simplewebauthn/server; the credential store lives in shared/auth.js (so connectors don't
 * pull this dep). Challenges are short-lived, held in memory per-user.
 *
 * RP binding: passkeys are tied to a domain. `rpID` + `origin` come from env
 * (ASMLTR_AUTH_RP_ID / ASMLTR_AUTH_ORIGIN) or are derived from the request's Origin header, so it works
 * on Eve's box (asmltr.eve.thoughtspacedesigns.com) without extra config.
 */
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const auth = require('../../shared/auth');

const rpName = () => process.env.ASSISTANT_NAME || 'asmltr';
function rp(reqOrigin) {
  const origin = process.env.ASMLTR_AUTH_ORIGIN || reqOrigin || '';
  let rpID = process.env.ASMLTR_AUTH_RP_ID;
  if (!rpID && origin) { try { rpID = new URL(origin).hostname; } catch (_) { /* leave undefined */ } }
  return { origin, rpID: rpID || 'localhost' };
}

// challenge stores: username -> { challenge, exp }
const CHALLENGE_TTL = 5 * 60 * 1000;
const regCh = new Map();
const authCh = new Map();
const put = (m, k, v) => m.set(k, { challenge: v, exp: Date.now() + CHALLENGE_TTL });
const take = (m, k) => { const e = m.get(k); m.delete(k); return e && e.exp > Date.now() ? e.challenge : null; };

const toB64 = (u8) => Buffer.from(u8).toString('base64url');
const fromB64 = (s) => Buffer.from(s, 'base64url');

// ── registration (session-gated: username = the logged-in user) ────────────────
async function registerOptions(username, reqOrigin) {
  const { rpID } = rp(reqOrigin);
  const existing = auth.listPasskeys(username);
  const options = await generateRegistrationOptions({
    rpName: rpName(), rpID,
    userName: username,
    userID: Buffer.from(username, 'utf8'),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  put(regCh, username, options.challenge);
  return options;
}

async function registerVerify(username, response, reqOrigin, label) {
  const { origin, rpID } = rp(reqOrigin);
  const expectedChallenge = take(regCh, username);
  if (!expectedChallenge) throw new Error('no pending registration (challenge expired)');
  const { verified, registrationInfo } = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID });
  if (!verified || !registrationInfo) throw new Error('passkey registration did not verify');
  const c = registrationInfo.credential; // { id, publicKey (Uint8Array), counter, transports }
  auth.addPasskey(username, { id: c.id, publicKey: toB64(c.publicKey), counter: c.counter || 0, transports: c.transports || [], name: label || 'passkey', added_at: Date.now() });
  return { verified: true, id: c.id };
}

// ── authentication (passwordless — a passkey is strong MFA on its own) ──────────
async function loginOptions(username, reqOrigin) {
  const { rpID } = rp(reqOrigin);
  const creds = auth.listPasskeys(username);
  if (!creds.length) throw new Error('no passkeys registered for this account');
  const options = await generateAuthenticationOptions({ rpID, allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })), userVerification: 'preferred' });
  put(authCh, username, options.challenge);
  return options;
}

async function loginVerify(username, response, reqOrigin) {
  const { origin, rpID } = rp(reqOrigin);
  const expectedChallenge = take(authCh, username);
  if (!expectedChallenge) throw new Error('no pending login (challenge expired)');
  const cred = auth.listPasskeys(username).find((c) => c.id === response.id || c.id === response.rawId);
  if (!cred) throw new Error('unknown passkey');
  const { verified, authenticationInfo } = await verifyAuthenticationResponse({
    response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID,
    credential: { id: cred.id, publicKey: fromB64(cred.publicKey), counter: cred.counter || 0, transports: cred.transports },
  });
  if (!verified) throw new Error('passkey login did not verify');
  auth.updatePasskeyCounter(username, cred.id, authenticationInfo.newCounter);
  return { verified: true };
}

module.exports = { registerOptions, registerVerify, loginOptions, loginVerify };
