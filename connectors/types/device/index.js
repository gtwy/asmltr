'use strict';
/**
 * asmltr connector type: device — a GENERIC device gateway for "oddball" assistant clients.
 *
 * This is the platform-agnostic base the `android` connector's gateway proved out, minus anything
 * OS-specific: a small HTTP + SSE + token surface that turns any device with a network stack (a Pi
 * kiosk, an ESP32, a desk buddy, a custom appliance) into a FIRST-CLASS asmltr channel. Its turns run
 * through the core like any other (identity/trust, moderation, sessions), so it shows up in `asmltr
 * map`/`ls`, is takeover-able, and `asmltr send device <id>` / announcements / steer / read-aloud push
 * straight to it. Platform-specific connectors (android, and iOS later) layer their own extras
 * (device-control RPC, app download, on-device wake models) on top of this same shape.
 *
 * Transport (no new deps — matches the core's SSE style, identical to android):
 *   • device→server:  POST /gw/turn   { token, device, name?, text, capabilities? } → reply streams over the SSE
 *   • server→device:  GET  /gw/stream?token=&device=&name=  → SSE: ready|delta|thinking|tool|tool_result|done|inject|speak|error
 *   • manager→device: POST /out       { target:<device>, text, kind? }  → inject (steer) or speak (read-aloud) frame
 *
 * Speech is PROXIED here (`/gw/transcribe` + `/gw/tts`) so a thin client needs no on-device speech
 * stack and no provider keys — post audio, get text; post text, get audio. Keys stay on the server.
 *
 * DEVICE CAPABILITIES: each turn MAY carry `capabilities` (screen dims, audio in/out, markdown). We
 * inject a one-line surface descriptor into the turn's `system_prompt_extra` ONLY when it changes from
 * the last turn on that conversation (first turn on a device, or a genuine capability change) — never
 * per-turn, since it almost never changes and the model retains it via conversation history.
 *
 * Auth: a device presents a token from the gitignored keys file (token → trust identity), exactly like
 * the android/openai connectors. conversation_key is `device:<instanceId>:device:<deviceId>` by
 * default, or `device:<instanceId>:identity:<identity>` when conversation_scope='identity' (all of a
 * user's devices share one continuous thread — "interface-agnostic" — while each stays a routable wire).
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const stt = require('../../../shared/speech/stt');
const tts = require('../../../shared/speech/tts');
const { auxUsage, estimateAudioSeconds } = require('../../../shared/usage');

const meta = {
  type: 'device',
  displayName: 'Assistant device (generic)',
  // Push channel: the manager /send router + announcements/steer/read-aloud reach a device via POST /out.
  outbound: { kinds: ['text'], target: { required: true, label: 'Device id' } },
  configSchema: {
    type: 'object',
    properties: {
      http_port: { type: 'integer', title: 'HTTP port (device gateway + /out)', default: 3028 },
      bind_host: { type: 'string', title: 'Bind address', default: '127.0.0.1' },
      keys_file: { type: 'string', title: 'Device tokens file (gitignored: token → trust identity)', default: '' },
      require_token: { type: 'boolean', title: 'Require a device token', default: true },
      surface_label: { type: 'string', title: 'What to call this surface in prompts (e.g. "desk buddy")', default: 'device' },
      conversation_scope: { type: 'string', enum: ['device', 'identity'], title: 'One thread per device, or one continuous thread per user across their devices', default: 'device' },
      default_capabilities: { type: 'object', title: 'Fallback capabilities when a turn omits them (e.g. {"audio_out":true,"screen":{"w":480,"h":800}})', default: {} },
    },
  },
};

function loadKeys(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j.keys) ? j.keys : []; } catch { return []; }
}

// A short, human-readable surface descriptor from a capabilities object. Returned as `system_prompt_extra`
// so the model adapts its output to what the device can actually do — injected only when it changes.
function capsDescriptor(caps, label) {
  const c = caps || {};
  const has = [];
  if (c.screen && c.screen.w && c.screen.h) has.push(`a ${c.screen.w}×${c.screen.h} screen`);
  else if (c.screen) has.push('a screen');
  if (c.audio_out) has.push('a speaker');
  if (c.audio_in) has.push('a microphone');
  if (!has.length) return '';
  let note = `DEVICE SURFACE — you are talking through "${label}", an assistant device with ${has.join(', ')}.`;
  if (c.audio_out && c.screen) note += ' Your reply is BOTH shown on the screen and read aloud, so keep it concise and naturally speakable — light on markdown, say symbols as words.';
  else if (c.audio_out) note += ' Your reply is READ ALOUD — write natural, speakable prose: no markdown/asterisks/backticks/bullets/tables/emoji, say symbols as words ("and" not "&"), keep it concise. The person is listening, not reading.';
  else if (c.screen) note += ' You can show formatted text and images.';
  return note;
}

async function start(ctx) {
  const cfg = ctx.config || {};
  const PORT = cfg.http_port || 3028;
  const BIND = cfg.bind_host || '127.0.0.1';
  const requireToken = cfg.require_token !== false;
  const keysFile = cfg.keys_file || path.join(__dirname, 'keys.json');
  const LABEL = cfg.surface_label || 'device';
  const SCOPE = cfg.conversation_scope === 'identity' ? 'identity' : 'device';
  const DEFAULT_CAPS = (cfg.default_capabilities && typeof cfg.default_capabilities === 'object') ? cfg.default_capabilities : {};

  const devices = new Map();     // deviceId → { res, name, identity, since }
  const lastCapsSig = new Map(); // conversation_key → last capabilities signature (for change-only injection)

  function keyEntry(token) { return loadKeys(keysFile).find((k) => k.key === token) || null; }
  function auth(token) {
    if (!requireToken) { const e = token && keyEntry(token); return { identity: (e && e.identity) || 'device-anon', username: (e && e.username) || 'device' }; }
    if (!token) return null;
    const e = keyEntry(token);
    return e ? { identity: e.identity, username: e.username || e.identity } : null;
  }
  const inst = ctx.instanceId ? `device:${ctx.instanceId}` : 'device';
  const convKey = (device, who) => SCOPE === 'identity' ? `${inst}:identity:${who.identity}` : `${inst}:device:${device}`;
  function pushSSE(device, obj) {
    const d = devices.get(device);
    if (!d) return false;
    try { d.res.write(`data: ${JSON.stringify(obj)}\n\n`); return true; } catch (_) { return false; }
  }

  const app = express();
  app.use(express.json({ limit: '16mb' })); // room for base64 audio on /gw/transcribe
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/health', (req, res) => res.json({ status: 'ok', type: 'device', instance: ctx.instanceId, label: LABEL, scope: SCOPE, devices: devices.size }));

  // --- server→device push channel (the device holds this open) --------------------------------------
  app.get('/gw/stream', (req, res) => {
    const who = auth(req.query.token);
    if (requireToken && !who) return res.status(401).json({ ok: false, error: 'invalid device token' });
    const device = String(req.query.device || '').trim();
    if (!device) return res.status(400).json({ ok: false, error: 'device id required' });
    const name = String(req.query.name || who.username || 'device');

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const prev = devices.get(device); if (prev && prev.res !== res) { try { prev.res.end(); } catch (_) {} }
    devices.set(device, { res, name, identity: who.identity, since: Date.now() });
    res.write(`data: ${JSON.stringify({ type: 'ready', device, conversation_key: convKey(device, who) })}\n\n`);
    ctx.emit({ event_type: 'control', session_id: convKey(device, who), identity: who.identity, payload: { action: 'device-connected', device } });
    try { ctx.heartbeat(); } catch (_) {}

    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) {} }, 25000); ka.unref && ka.unref();
    req.on('close', () => {
      clearInterval(ka);
      if (devices.get(device) && devices.get(device).res === res) devices.delete(device);
      ctx.emit({ event_type: 'control', session_id: convKey(device, who), identity: who.identity, payload: { action: 'device-disconnected', device } });
    });
  });

  // --- device→server: submit a turn, stream the reply back over the device's SSE ---------------------
  app.post('/gw/turn', async (req, res) => {
    const b = req.body || {};
    const who = auth(b.token);
    if (requireToken && !who) return res.status(401).json({ ok: false, error: 'invalid device token' });
    const device = String(b.device || '').trim();
    const text = typeof b.text === 'string' ? b.text : '';
    if (!device) return res.status(400).json({ ok: false, error: 'device id required' });
    if (!text.trim()) return res.status(400).json({ ok: false, error: 'text required' });
    const name = String(b.name || who.username || 'device');
    const convo = convKey(device, who);

    // Capabilities: turn-supplied, else the instance default. Inject the surface descriptor ONLY when it
    // changed from the last turn on this conversation (first turn, or a real change) — never per-turn.
    const caps = (b.capabilities && typeof b.capabilities === 'object') ? b.capabilities : DEFAULT_CAPS;
    const sig = JSON.stringify(caps || {});
    let sysExtra = '';
    if (sig !== (lastCapsSig.get(convo) || '')) { sysExtra = capsDescriptor(caps, LABEL); lastCapsSig.set(convo, sig); }

    ctx.emit({ event_type: 'inbound', session_id: convo, identity: who.identity, payload: { text: text.slice(0, 100000) } });
    const envelope = {
      channel: 'device',
      conversation_key: convo,
      message_id: String(b.message_id || Date.now()),
      sender: { raw_id: who.identity, raw_username: name },
      content: { text },
      delivery: 'sync',
      public: false, // 1:1 authed device; redaction still applies unless the identity is full-trust
      channel_context: { device, surface: LABEL, capabilities: caps },
      context: { scope_name: LABEL },
      capabilities: { max_message_chars: 100000, supports_markdown: !!(caps && caps.screen && !caps.audio_out), streaming: true, supports_attachments_out: false },
      ...(sysExtra ? { system_prompt_extra: sysExtra } : {}),
    };

    // Ack immediately (the reply streams over the SSE, not this POST response).
    res.json({ ok: true, conversation_key: convo, streaming: devices.has(device) });
    try {
      await ctx.core.handleStream(envelope, {
        onDelta: (t) => pushSSE(device, { type: 'delta', text: t }),
        onThinking: (t) => pushSSE(device, { type: 'thinking', text: t }),
        onToolCall: (t) => pushSSE(device, { type: 'tool', name: t.name, input: t.input }),
        onToolResult: (r) => pushSSE(device, { type: 'tool_result', output: r.output, is_error: r.is_error }),
      });
      pushSSE(device, { type: 'done', conversation_key: convo });
    } catch (e) {
      ctx.log(`device turn error (${device}): ${e.message}`);
      pushSSE(device, { type: 'error', error: e.message });
    }
    try { ctx.heartbeat(); } catch (_) {}
  });

  // Stop the in-flight turn for this device → core aborts by conversation_key.
  const CORE_ABORT = (process.env.ASMLTR_CORE_URL || 'http://127.0.0.1:3023/v2/handle').replace(/\/v2\/handle$/, '/v2/abort');
  app.post('/gw/abort', async (req, res) => {
    const b = req.body || {};
    const who = auth(b.token);
    if (requireToken && !who) return res.status(401).json({ ok: false, error: 'invalid device token' });
    const device = String(b.device || '').trim();
    if (!device) return res.status(400).json({ ok: false, error: 'device id required' });
    try { await fetch(CORE_ABORT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation_key: convKey(device, who) }) }); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Start a fresh conversation for this device/user (clear context).
  const CORE_FORGET = (process.env.ASMLTR_CORE_URL || 'http://127.0.0.1:3023/v2/handle').replace(/\/v2\/handle$/, '/v2/session/forget');
  app.post('/gw/forget', async (req, res) => {
    const b = req.body || {};
    const who = auth(b.token);
    if (requireToken && !who) return res.status(401).json({ ok: false, error: 'invalid device token' });
    const device = String(b.device || '').trim();
    if (!device) return res.status(400).json({ ok: false, error: 'device id required' });
    const key = convKey(device, who);
    try {
      const r = await fetch(CORE_FORGET, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation_key: key, by: 'device' }) });
      const j = await r.json().catch(() => ({}));
      lastCapsSig.delete(key);
      res.json({ ok: true, conversation_key: key, existed: !!j.existed });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // --- manager→device push: `asmltr send device <id>` / announcements / steer / read-aloud -----------
  // kind:'inject' (default) steers text into a turn; kind:'speak' asks the device to read the text ALOUD
  // WITHOUT running a turn (the notify read-aloud leg). '*'/empty target broadcasts to every device.
  app.post('/out', (req, res) => {
    const { target, text, kind, title, require_headphones } = req.body || {};
    const device = String(target || '').trim();
    if (kind === 'speak') {
      const frame = { type: 'speak', text: String(text || ''), title: title || null, require_headphones: !!require_headphones };
      let delivered = 0;
      if (!device || device === '*') { for (const id of devices.keys()) if (pushSSE(id, frame)) delivered++; }
      else if (pushSSE(device, frame)) delivered++;
      return res.json({ ok: delivered > 0, delivered, error: delivered ? undefined : 'no device connected' });
    }
    if (!device) return res.status(400).json({ ok: false, error: 'target device id required' });
    const delivered = pushSSE(device, { type: 'inject', text: String(text || '') });
    if (!delivered) return res.json({ ok: false, error: 'device not connected' });
    return res.json({ ok: true });
  });

  // Presence — is any device reachable right now? (used by the notify read-aloud ladder + GUI)
  app.get('/gw/presence', (req, res) => res.json({ ok: true, reachable: devices.size > 0, count: devices.size, devices: [...devices.keys()] }));

  // Let the core/GUI discover which devices are connected (for targeting).
  app.get('/gw/devices', (req, res) => res.json({ ok: true, devices: [...devices.entries()].map(([id, d]) => ({ id, name: d.name, since: d.since })) }));

  // --- session switcher: list/attach any asmltr session from the device (reads the open collector) ---
  const INSIGHTS_BASE = (process.env.ASMLTR_INSIGHTS_BASE || 'http://127.0.0.1:3017').replace(/\/+$/, '');
  const INSIGHTS_TOKEN = process.env.ASMLTR_INSIGHTS_TOKEN || '';
  async function collector(p) {
    const r = await fetch(INSIGHTS_BASE + p, { headers: INSIGHTS_TOKEN ? { Authorization: `Bearer ${INSIGHTS_TOKEN}` } : {} });
    if (!r.ok) throw new Error(`collector ${r.status}`);
    return r.json();
  }
  app.get('/gw/sessions', async (req, res) => {
    if (requireToken && !auth(req.query.token)) return res.status(401).json({ ok: false, error: 'invalid device token' });
    try {
      const j = await collector('/api/sessions?active=1');
      const secs = (n) => { n = Number(n) || 0; return n > 1e11 ? Math.round(n / 1000) : n; };
      const rows = (j.sessions || []).map((s) => ({
        key: s.session_id, surface: s.surface || 'core', title: (s.title || s.task || '').trim(),
        activity: (s.activity || '').trim(), identity: s.identity || '', updated: secs(s.last_activity_unix || s.updated_unix || s.started_unix || 0),
      })).filter((r) => r.key).sort((a, b) => b.updated - a.updated);
      res.json({ ok: true, sessions: rows });
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
  });

  // --- edge speech: STT + TTS proxied here so a thin client needs only its device token -------------
  app.post('/gw/transcribe', async (req, res) => {
    const b = req.body || {};
    if (requireToken && !auth(b.token)) return res.status(401).json({ ok: false, error: 'invalid device token' });
    try {
      const buf = Buffer.from(String(b.audio_base64 || ''), 'base64');
      if (!buf.length) return res.status(400).json({ ok: false, error: 'audio_base64 required' });
      const r = await stt.transcribe(buf, { mime: b.mime || 'audio/webm', filename: b.filename, language: b.language });
      const seconds = r.duration || estimateAudioSeconds(r.bytes, b.mime || 'audio/webm');
      ctx.emit(auxUsage({ surface: 'device', feature: 'stt', provider: 'openai', model: r.model, seconds }));
      res.json({ ok: true, text: r.text || '', model: r.model });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post('/gw/tts', async (req, res) => {
    const b = req.body || {};
    if (requireToken && !auth(b.token)) return res.status(401).json({ ok: false, error: 'invalid device token' });
    try {
      const text = String(b.text || '').trim();
      if (!text) return res.status(400).json({ ok: false, error: 'text required' });
      const r = await tts.synthesize(text, { voice: b.voice, model: b.model });
      const c = tts.config();
      ctx.emit(auxUsage({ surface: 'device', feature: 'tts', provider: c.provider, model: b.model || c.model, chars: text.length }));
      res.json({ ok: true, mime: r.mime, b64: Buffer.from(r.audio).toString('base64') });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  const httpServer = app.listen(PORT, BIND, () => ctx.log(`device gateway "${LABEL}" on ${BIND}:${PORT} (${requireToken ? 'token required' : 'OPEN'}, scope=${SCOPE})`));

  return {
    async stop() {
      for (const d of devices.values()) { try { d.res.end(); } catch (_) {} }
      devices.clear(); lastCapsSig.clear();
      await new Promise((r) => httpServer.close(() => r()));
    },
    health() { return { http_port: PORT, devices: devices.size }; },
  };
}

module.exports = { meta, start, capsDescriptor };
