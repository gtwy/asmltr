'use strict';
/**
 * asmltr connector type: remote-desktop — the SIGNALING BROKER + control plane for the custom WebRTC
 * remote-desktop capability (see docs/REMOTE-DESKTOP.md). It is NOT the media path: it introduces a
 * source (a host agent) to a viewer (the app), relays their SDP/ICE so ICE can hole-punch a DIRECT
 * peer-to-peer connection, hands out STUN (+ optional TURN-fallback) config, and enforces per-host
 * view/control trust grants. Media flows peer-to-peer; the broker never sees it.
 *
 * Transport mirrors the android connector's proven gateway (no new deps): each peer holds an outbound
 * SSE stream (GET /rd/stream) and POSTs signaling messages (POST /rd/msg). Token-authed via the same
 * gitignored keys file convention. conversation-less: this is infra signaling, not a chat channel.
 *
 *   host agent → GET /rd/stream?token=&role=host&host_id=&name=   (holds the stream; receives offers/ice)
 *   viewer     → GET /rd/stream?token=&role=viewer&client_id=     (holds the stream; receives answers/ice)
 *   any        → POST /rd/msg { token, type, ... }                (register/list/connect/sdp/ice/bye)
 *   any        → GET /rd/ice-config?token=                        (STUN urls + short-lived TURN creds if on)
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const meta = {
  type: 'remote-desktop',
  displayName: 'Remote desktop (WebRTC signaling)',
  // Not a send target — signaling infra. Kept minimal so the manager doesn't offer it as an outbound channel.
  outbound: { kinds: [], target: { required: false } },
  configSchema: {
    type: 'object',
    properties: {
      http_port: { type: 'integer', title: 'HTTP port (signaling)', default: 3028 },
      bind_host: { type: 'string', title: 'Bind address', default: '127.0.0.1' },
      keys_file: { type: 'string', title: 'Peer tokens file (gitignored: token → trust identity)', default: '' },
      require_token: { type: 'boolean', title: 'Require a peer token', default: true },
      // NAT traversal: STUN is always on (own service preferred; public fallback list). TURN is an
      // explicit last-resort for symmetric-NAT-on-both-ends only; OFF by default = direct-or-nothing.
      stun_urls: { type: 'array', title: 'STUN urls', items: { type: 'string' },
        default: ['stun:stun.l.google.com:19302'] },
      turn_enabled: { type: 'boolean', title: 'Enable TURN fallback (relays media through server)', default: false },
      turn_url: { type: 'string', title: 'TURN url', default: '' },
      turn_secret_key: { type: 'string', title: 'TURN shared-secret vault key (coturn REST auth)', default: '' },
    },
  },
};

function loadKeys(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j.keys) ? j.keys : []; } catch { return []; }
}

async function start(ctx) {
  const cfg = ctx.config || {};
  const PORT = cfg.http_port || 3028;
  const BIND = cfg.bind_host || '127.0.0.1';
  const requireToken = cfg.require_token !== false;
  const keysFile = cfg.keys_file || path.join(__dirname, 'keys.json');

  const hosts = new Map();    // host_id → { res, name, identity, caps, since }
  const viewers = new Map();  // client_id → { res, identity, since }
  const sessions = new Map(); // session_id → { host_id, client_id, control, identity, since }

  const keyEntry = (token) => loadKeys(keysFile).find((k) => k.key === token) || null;
  function auth(token) {
    if (!requireToken) { const e = token && keyEntry(token); return { identity: (e && e.identity) || 'rd-anon' }; }
    if (!token) return null;
    const e = keyEntry(token);
    return e ? { identity: e.identity } : null;
  }
  const push = (map, id, obj) => { const d = map.get(id); if (!d) return false; try { d.res.write(`data: ${JSON.stringify(obj)}\n\n`); return true; } catch (_) { return false; } };

  // Trust: view + control are SEPARATE grants, resolved against the caller's trust identity (default-deny).
  // The connector SDK exposes trust resolution as ctx.core.resolve(envelope) → POST /trust/resolve, which
  // returns { user_key, display_name, trust_tier, permissions, bypass_moderation, is_default, revoked, ... }.
  // We resolve the keys.json identity on THIS connector's own surface ('remote-desktop') so grants can be
  // scoped to remote-desktop specifically. Rules (default-deny for unknown/revoked):
  //   view    = a KNOWN, non-revoked principal at trust_tier >= 1 (or full trust).
  //   control = FULL TRUST only (bypass_moderation) — remote keyboard/mouse is the highest-power capability.
  async function grants(identity) {
    try {
      const r = await ctx.core.resolve({ channel: 'remote-desktop', sender: { raw_id: identity } });
      const tier = Number(r && r.trust_tier) || 0;
      const bypass = !!(r && r.bypass_moderation);
      const known = !!(r && !r.is_default && !r.revoked); // is_default = no matching principal
      return {
        view: known && (bypass || tier >= 1),
        control: bypass, // full-trust identity ONLY
        tier,
        user_key: (r && r.user_key) || identity,
        display_name: (r && r.display_name) || identity,
      };
    } catch (_) {
      return { view: false, control: false, tier: 0, user_key: identity, display_name: identity }; // fail closed
    }
  }

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // ICE config: STUN always; TURN only if explicitly enabled (short-lived coturn REST creds).
  app.get('/rd/ice-config', async (req, res) => {
    if (requireToken && !auth(req.query.token)) return res.status(401).json({ ok: false, error: 'invalid token' });
    const iceServers = [{ urls: cfg.stun_urls && cfg.stun_urls.length ? cfg.stun_urls : ['stun:stun.l.google.com:19302'] }];
    if (cfg.turn_enabled && cfg.turn_url) {
      try {
        const secret = cfg.turn_secret_key ? await ctx.secrets.get(cfg.turn_secret_key) : '';
        const ttl = 600; const username = `${Math.floor(Date.now() / 1000) + ttl}`;
        const credential = crypto.createHmac('sha1', secret || '').update(username).digest('base64');
        iceServers.push({ urls: [cfg.turn_url], username, credential });
      } catch (_) {}
    }
    res.json({ ok: true, iceServers, turn_enabled: !!cfg.turn_enabled });
  });

  // Persistent SSE stream per peer (host or viewer).
  app.get('/rd/stream', (req, res) => {
    const who = auth(req.query.token);
    if (requireToken && !who) return res.status(401).end();
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders && res.flushHeaders();
    const role = String(req.query.role || '');
    if (role === 'host') {
      const id = String(req.query.host_id || who.identity);
      const prev = hosts.get(id); if (prev && prev.res !== res) { try { prev.res.end(); } catch (_) {} }
      const caps = { video: true, audio: req.query.audio === '1', control: req.query.control === '1' };
      hosts.set(id, { res, name: String(req.query.name || id), identity: who.identity, caps, since: Date.now() });
      res.write(`data: ${JSON.stringify({ type: 'ready', host_id: id })}\n\n`);
      ctx.emit({ surface: 'assistant-native', event_type: 'control', session_id: `rd:host:${id}`, identity: who.identity, payload: { action: 'host-online', host_id: id } });
      req.on('close', () => { if (hosts.get(id) && hosts.get(id).res === res) hosts.delete(id); });
    } else {
      const id = String(req.query.client_id || who.identity);
      const prev = viewers.get(id); if (prev && prev.res !== res) { try { prev.res.end(); } catch (_) {} }
      viewers.set(id, { res, identity: who.identity, since: Date.now() });
      res.write(`data: ${JSON.stringify({ type: 'ready', client_id: id })}\n\n`);
      req.on('close', () => { if (viewers.get(id) && viewers.get(id).res === res) viewers.delete(id); });
    }
  });

  // All signaling messages. SDP/ICE are relayed VERBATIM between the two peers of a session only.
  app.post('/rd/msg', async (req, res) => {
    const b = req.body || {};
    const who = auth(b.token);
    if (requireToken && !who) return res.status(401).json({ ok: false, error: 'invalid token' });
    const type = String(b.type || '');
    try {
      if (type === 'list') {
        const g = await grants(who.identity);
        if (!g.view) return res.json({ ok: true, hosts: [] });
        return res.json({ ok: true, hosts: [...hosts.entries()].map(([id, h]) => ({ host_id: id, name: h.name, caps: h.caps, online: true })) });
      }
      if (type === 'connect') {
        const hostId = String(b.host_id || '');
        const host = hosts.get(hostId);
        if (!host) return res.status(404).json({ ok: false, error: 'host offline' });
        const g = await grants(who.identity);
        if (!g.view) return res.status(403).json({ ok: false, error: 'no view grant for remote desktop (default-deny)' });
        const wantControl = !!(b.want && b.want.control);
        if (wantControl && !g.control) return res.status(403).json({ ok: false, error: 'no control grant (view-only)' });
        const sessionId = crypto.randomBytes(9).toString('base64url');
        const clientId = String(b.client_id || who.identity);
        sessions.set(sessionId, { host_id: hostId, client_id: clientId, control: wantControl && g.control, identity: who.identity, since: Date.now() });
        // Ask the host to make an offer for this session (control flag stamped by the broker → agent re-checks it).
        push(hosts, hostId, { type: 'offer_request', session_id: sessionId, control: wantControl && g.control });
        ctx.emit({ surface: 'assistant-native', event_type: 'control', session_id: `rd:sess:${sessionId}`, identity: who.identity, payload: { action: 'session-open', host_id: hostId, control: wantControl && g.control } });
        return res.json({ ok: true, session_id: sessionId, control: wantControl && g.control });
      }
      if (type === 'sdp' || type === 'ice') {
        const s = sessions.get(String(b.session_id || ''));
        if (!s) return res.status(404).json({ ok: false, error: 'unknown session' });
        // Relay to the OTHER peer of this session only. Direction is decided by the sender's declared
        // `role` ('host' | 'viewer') — NOT by trust identity, because a host agent and the owner's phone
        // legitimately share ONE identity ('owner'), which made identity-based direction misroute. role is
        // authoritative; it can't escalate anything (both peers are inside one already-authorized session).
        const role = String(b.role || '');
        let target = null; // 'viewer' | 'host'  (the OTHER peer)
        if (role === 'host') target = 'viewer';
        else if (role === 'viewer') target = 'host';
        else {
          // Fallback for a role-less sender: infer only when identities are unambiguous.
          const hostIdent = hosts.get(s.host_id) && hosts.get(s.host_id).identity;
          const viewerIdent = viewers.get(s.client_id) && viewers.get(s.client_id).identity;
          if (hostIdent && viewerIdent && hostIdent !== viewerIdent) {
            target = who.identity === hostIdent ? 'viewer' : 'host';
          } else {
            return res.status(400).json({ ok: false, error: "sdp/ice requires role: 'host' | 'viewer'" });
          }
        }
        const frame = { type, session_id: b.session_id, sdp: b.sdp, candidate: b.candidate };
        const delivered = target === 'viewer' ? push(viewers, s.client_id, frame) : push(hosts, s.host_id, frame);
        return res.json({ ok: delivered });
      }
      if (type === 'bye') {
        const s = sessions.get(String(b.session_id || ''));
        if (s) {
          push(hosts, s.host_id, { type: 'bye', session_id: b.session_id });
          push(viewers, s.client_id, { type: 'bye', session_id: b.session_id });
          sessions.delete(String(b.session_id));
          ctx.emit({ surface: 'assistant-native', event_type: 'control', session_id: `rd:sess:${b.session_id}`, identity: who.identity, payload: { action: 'session-close' } });
        }
        return res.json({ ok: true });
      }
      return res.status(400).json({ ok: false, error: `unknown message type: ${type}` });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/rd/health', (_req, res) => res.json({ ok: true, hosts: hosts.size, viewers: viewers.size, sessions: sessions.size }));

  const server = app.listen(PORT, BIND, () => ctx.log(`remote-desktop signaling broker on ${BIND}:${PORT}`));
  return { async stop() { try { server.close(); } catch (_) {} } };
}

module.exports = { meta, start };
