'use strict';
/**
 * asmltr connector type: android — a device gateway for the native mobile assistant.
 *
 * Unlike telegram/discord (server-side adapters that reach a platform's API), the "platform" here is
 * OUR OWN app on a phone. Each installed device holds a long-lived SSE stream to this connector and
 * POSTs turns to it. That makes the phone a FIRST-CLASS channel: its turns run through the core like
 * any other (trust, moderation, sessions), so the interoception agent sees the device session, the web
 * GUI can claim/take it over, and `asmltr send android <device> …` / announcements / steer push straight
 * to the phone over its SSE. Voice I/O (STT in, TTS out) stays on the device using the core's `/v2`
 * speech endpoints — this connector is the conversation channel, audio is edge-local.
 *
 * Transport (no new deps — matches the core's SSE style):
 *   • device→server:  POST /gw/turn   { token, device, name?, text }  → streamed reply over the SSE
 *   • server→device:  GET  /gw/stream?token=&device=&name=            → SSE: ready|delta|done|inject|error
 *   • manager→device: POST /out       { target:<device>, text }        → an `inject` frame (routing/steer)
 *
 * Auth: a device presents a token from the gitignored keys file (token → trust identity), exactly like
 * the openai connector. conversation_key = `android:<instanceId>:device:<deviceId>` (stable per install
 * → the core session resumes, and the card is takeover-able).
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
// Speech is proxied through this connector so the phone has ONE token-authed surface (no separate
// core-auth for /v2/transcribe + /v2/tts). Same shared modules the core /v2 speech endpoints use.
const stt = require('../../../shared/speech/stt');
const tts = require('../../../shared/speech/tts');
const identity = require('../../../shared/identity'); // for /gw/theme (signature palette + agent name)

const meta = {
  type: 'android',
  displayName: 'Android assistant',
  // Push channel: the manager /send router + announcements/steer reach a device via POST /out.
  outbound: { kinds: ['text'], target: { required: true, label: 'Device id' } },
  configSchema: {
    type: 'object',
    properties: {
      http_port: { type: 'integer', title: 'HTTP port (device gateway + /out)', default: 3027 },
      bind_host: { type: 'string', title: 'Bind address', default: '127.0.0.1' },
      keys_file: { type: 'string', title: 'Device tokens file (gitignored: token → trust identity)', default: '' },
      require_token: { type: 'boolean', title: 'Require a device token', default: true },
    },
  },
};

function loadKeys(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j.keys) ? j.keys : []; } catch { return []; }
}

async function start(ctx) {
  const cfg = ctx.config || {};
  const PORT = cfg.http_port || 3027;
  const BIND = cfg.bind_host || '127.0.0.1';
  const requireToken = cfg.require_token !== false;
  const keysFile = cfg.keys_file || path.join(__dirname, 'keys.json');

  // deviceId → { res, name, identity, since }. One live SSE per device (a reconnect replaces it).
  const devices = new Map();
  // Separate PERSISTENT control link, held by the phone's native foreground service (not the WebView).
  // This is what lets any agent session actuate the phone even when the overlay/app is closed — the chat
  // stream (devices) is ephemeral UI; this one stays connected in the background.
  const controlDevices = new Map(); // deviceId → { res, name, since }
  function pushControl(device, obj) {
    const d = controlDevices.get(device);
    if (!d) return false;
    try { d.res.write(`data: ${JSON.stringify(obj)}\n\n`); return true; } catch (_) { return false; }
  }

  function keyEntry(token) { return loadKeys(keysFile).find((k) => k.key === token) || null; }
  // Resolve a device's caller identity from its token. Returns null when a token is required but invalid.
  function auth(token) {
    if (!requireToken) { const e = token && keyEntry(token); return { identity: (e && e.identity) || 'android-anon', username: (e && e.username) || 'android' }; }
    if (!token) return null;
    const e = keyEntry(token);
    return e ? { identity: e.identity, username: e.username || e.identity } : null;
  }
  const convKey = (device) => `android:${ctx.instanceId}:device:${device}`;
  function pushSSE(device, obj) {
    const d = devices.get(device);
    if (!d) return false;
    try { d.res.write(`data: ${JSON.stringify(obj)}\n\n`); return true; } catch (_) { return false; }
  }

  const app = express();
  app.use(express.json({ limit: '16mb' })); // room for base64 audio on /gw/transcribe
  // The mobile WebView is a different origin (capacitor://localhost). These endpoints are token-authed,
  // so a permissive CORS policy is fine and required for fetch()/EventSource from the app.
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/health', (req, res) => res.json({ status: 'ok', type: 'android', instance: ctx.instanceId, devices: devices.size }));

  // --- server→device push channel (the phone holds this open) ---------------------------------------
  app.get('/gw/stream', (req, res) => {
    const who = auth(req.query.token);
    if (requireToken && !who) return res.status(401).json({ ok: false, error: 'invalid device token' });
    const device = String(req.query.device || '').trim();
    if (!device) return res.status(400).json({ ok: false, error: 'device id required' });
    const name = String(req.query.name || who.username || 'android');

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    // Replace any stale stream for this device (reconnect).
    const prev = devices.get(device); if (prev && prev.res !== res) { try { prev.res.end(); } catch (_) {} }
    devices.set(device, { res, name, identity: who.identity, since: Date.now() });
    res.write(`data: ${JSON.stringify({ type: 'ready', device, conversation_key: convKey(device) })}\n\n`);
    ctx.emit({ event_type: 'control', session_id: convKey(device), identity: who.identity, payload: { action: 'device-connected', device } });
    try { ctx.heartbeat(); } catch (_) {}

    // keep-alive comments so proxies don't drop the idle stream
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) {} }, 25000); ka.unref && ka.unref();
    req.on('close', () => {
      clearInterval(ka);
      if (devices.get(device) && devices.get(device).res === res) devices.delete(device);
      ctx.emit({ event_type: 'control', session_id: convKey(device), identity: who.identity, payload: { action: 'device-disconnected', device } });
    });
  });

  // --- session switcher: list/attach ANY asmltr session from the overlay (like the web GUI) ----------
  // The connector reads the collector (localhost, open) for the reconciled session list + per-session
  // history, so the phone can browse every channel's sessions, load one, and direct its next turn at it.
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
      // last_activity_unix etc. are stored in MILLISECONDS despite the name → normalize to seconds so
      // the app's "x ago" is correct (else everything reads "just now").
      const secs = (n) => { n = Number(n) || 0; return n > 1e11 ? Math.round(n / 1000) : n; };
      const rows = (j.sessions || []).map((s) => ({
        key: s.session_id, surface: s.surface || 'core',
        title: (s.title || s.task || '').trim(), task: (s.task || '').trim(),
        status: s.status || '', identity: s.identity || '', tools: s.tool_count || 0,
        updated: secs(s.last_activity_unix || s.updated_unix || s.started_unix || 0),
      })).filter((r) => r.key).sort((a, b) => b.updated - a.updated);
      res.json({ ok: true, sessions: rows });
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
  });
  app.get('/gw/history', async (req, res) => {
    if (requireToken && !auth(req.query.token)) return res.status(401).json({ ok: false, error: 'invalid device token' });
    const key = String(req.query.key || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'key required' });
    try {
      const j = await collector(`/api/events?session=${encodeURIComponent(key)}&limit=${Math.min(parseInt(req.query.limit, 10) || 300, 1000)}`);
      const items = [];
      for (const e of (j.events || [])) {
        let p = {}; try { p = typeof e.payload === 'string' ? JSON.parse(e.payload) : (e.payload || {}); } catch (_) {}
        switch (e.event_type) {
          case 'inbound': items.push({ kind: 'user', text: p.text || '', ts: e.ts }); break;
          case 'outbound': items.push({ kind: 'assistant', text: p.text || '', ts: e.ts }); break;
          case 'thinking': items.push({ kind: 'thinking', text: p.text || '', ts: e.ts }); break;
          case 'tool': items.push({ kind: 'tool', name: p.tool || p.name || 'tool', input: p.input, ts: e.ts }); break;
          case 'tool_result': items.push({ kind: 'tool_result', output: p.output || '', is_error: !!p.is_error, ts: e.ts }); break;
          default: break; // session-start/end/control → skip
        }
      }
      res.json({ ok: true, key, items });
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
  });

  // Start a fresh conversation for this device (clear context): forget the core session so the next turn
  // re-injects a clean system prompt (identity/trust/history reset). Surfaced by the overlay's "New session".
  const CORE_FORGET = (process.env.ASMLTR_CORE_URL || 'http://127.0.0.1:3023/v2/handle').replace(/\/v2\/handle$/, '/v2/session/forget');
  app.post('/gw/forget', async (req, res) => {
    const b = req.body || {};
    if (requireToken && !auth(b.token)) return res.status(401).json({ ok: false, error: 'invalid device token' });
    const device = String(b.device || '').trim();
    if (!device) return res.status(400).json({ ok: false, error: 'device id required' });
    const key = convKey(device);
    try {
      const r = await fetch(CORE_FORGET, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation_key: key, by: 'android-device' }) });
      const j = await r.json().catch(() => ({}));
      res.json({ ok: true, conversation_key: key, existed: !!j.existed });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // --- persistent control link: the native foreground service holds this open 24/7 -------------------
  // Same auth as the chat stream, but a SEPARATE registry so it doesn't get replaced when the overlay's
  // chat stream (re)connects. Device_rpc frames are pushed here so phone control works with no UI open.
  app.get('/gw/control', (req, res) => {
    const who = auth(req.query.token);
    if (requireToken && !who) return res.status(401).json({ ok: false, error: 'invalid device token' });
    const device = String(req.query.device || '').trim();
    if (!device) return res.status(400).json({ ok: false, error: 'device id required' });
    const name = String(req.query.name || who.username || 'android');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const prev = controlDevices.get(device); if (prev && prev.res !== res) { try { prev.res.end(); } catch (_) {} }
    controlDevices.set(device, { res, name, since: Date.now() });
    res.write(`data: ${JSON.stringify({ type: 'ready', device, control: true })}\n\n`);
    ctx.emit({ event_type: 'control', session_id: convKey(device), identity: who.identity, payload: { action: 'control-connected', device } });
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) {} }, 25000); ka.unref && ka.unref();
    req.on('close', () => {
      clearInterval(ka);
      if (controlDevices.get(device) && controlDevices.get(device).res === res) controlDevices.delete(device);
      ctx.emit({ event_type: 'control', session_id: convKey(device), identity: who.identity, payload: { action: 'control-disconnected', device } });
    });
  });

  // --- device→server: submit a turn, stream the reply back over the device's SSE --------------------
  app.post('/gw/turn', async (req, res) => {
    const b = req.body || {};
    const who = auth(b.token);
    if (requireToken && !who) return res.status(401).json({ ok: false, error: 'invalid device token' });
    const device = String(b.device || '').trim();
    const text = typeof b.text === 'string' ? b.text : '';
    if (!device) return res.status(400).json({ ok: false, error: 'device id required' });
    if (!text.trim()) return res.status(400).json({ ok: false, error: 'text required' });
    const name = String(b.name || who.username || 'android');
    // Optionally DIRECT this turn at another session (the overlay session switcher): run on its
    // conversation_key + channel so it continues THAT conversation; the reply still streams to this phone.
    const targetKey = String(b.target_key || '').trim();
    const targetSurface = String(b.target_surface || '').trim();
    const convo = targetKey || convKey(device);
    const channel = targetKey ? (targetSurface || (convo.includes(':') ? convo.split(':')[0] : 'core')) : 'android';

    ctx.emit({ event_type: 'inbound', session_id: convo, identity: who.identity, payload: { text: text.slice(0, 200) } });
    const envelope = {
      channel,
      conversation_key: convo,
      message_id: String(Date.now()),
      sender: { raw_id: who.identity, raw_username: name },
      content: { text },
      delivery: 'sync',
      public: false, // 1:1 authed device; redaction still applies unless the identity is full-trust
      channel_context: { device },
      context: { scope_name: targetKey ? `Session ${convo}` : 'Android assistant' },
      capabilities: { max_message_chars: 100000, supports_markdown: false, streaming: true, supports_attachments_out: false },
    };

    // Ack immediately (the reply streams over the SSE, not this POST response).
    res.json({ ok: true, conversation_key: convo, streaming: devices.has(device) });
    try {
      await ctx.core.handleStream(envelope, {
        onDelta: (t) => pushSSE(device, { type: 'delta', text: t }),                                 // streamed reply text
        onThinking: (t) => pushSSE(device, { type: 'thinking', text: t }),                           // reasoning steps
        onToolCall: (t) => pushSSE(device, { type: 'tool', name: t.name, input: t.input }),          // tool call + args
        onToolResult: (r) => pushSSE(device, { type: 'tool_result', output: r.output, is_error: r.is_error }), // its output
      });
      pushSSE(device, { type: 'done', conversation_key: convo });
    } catch (e) {
      ctx.log(`android turn error (${device}): ${e.message}`);
      pushSSE(device, { type: 'error', error: e.message });
    }
    try { ctx.heartbeat(); } catch (_) {}
  });

  // Stop the in-flight turn for this device (the overlay Stop button) → core aborts by conversation_key.
  const CORE_ABORT = (process.env.ASMLTR_CORE_URL || 'http://127.0.0.1:3023/v2/handle').replace(/\/v2\/handle$/, '/v2/abort');
  app.post('/gw/abort', async (req, res) => {
    const b = req.body || {};
    if (requireToken && !auth(b.token)) return res.status(401).json({ ok: false, error: 'invalid device token' });
    const device = String(b.device || '').trim();
    if (!device) return res.status(400).json({ ok: false, error: 'device id required' });
    try { await fetch(CORE_ABORT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation_key: convKey(device) }) }); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // --- #77 device control: core→device RPC round-trip -----------------------------------------------
  // The core's `asmltr-device` MCP tool POSTs /gw/rpc; we push a `device_rpc` frame to the phone, the
  // app runs it via the AsmltrDevice bridge and POSTs /gw/rpc-result, and we resolve the original POST
  // with the device's result. Lets the assistant actually actuate the phone (volume, launch apps, …).
  const pendingRpc = new Map(); // id → { resolve, timer }
  let rpcSeq = 0;
  // Prefer the persistent control link (works with no UI open); fall back to the chat stream (PWA/web).
  function pickTarget(requested) {
    const pick = (map) => {
      if (requested) return map.has(requested) ? requested : null;
      let best = null, bestSince = -1;
      for (const [id, d] of map) if (d.since > bestSince) { best = id; bestSince = d.since; }
      return best;
    };
    const c = pick(controlDevices); if (c) return { device: c, push: pushControl };
    const d = pick(devices); if (d) return { device: d, push: pushSSE };
    return null;
  }
  app.post('/gw/rpc', (req, res) => {
    const b = req.body || {};
    const tgt = pickTarget(b.device ? String(b.device).trim() : '');
    if (!tgt) return res.status(404).json({ ok: false, error: 'no connected device' });
    const tool = String(b.tool || '').trim();
    if (!tool) return res.status(400).json({ ok: false, error: 'tool required' });
    const id = `rpc${++rpcSeq}-${Date.now()}`;
    const timeoutMs = Math.min(Math.max(parseInt(b.timeout_ms, 10) || 20000, 1000), 60000);
    const timer = setTimeout(() => {
      if (pendingRpc.has(id)) { pendingRpc.delete(id); res.status(504).json({ ok: false, error: 'device did not respond in time' }); }
    }, timeoutMs);
    if (timer.unref) timer.unref();
    pendingRpc.set(id, { resolve: (result) => { clearTimeout(timer); res.json({ ok: true, device: tgt.device, result }); }, timer });
    const delivered = tgt.push(tgt.device, { type: 'device_rpc', id, tool, args: b.args || {} });
    if (!delivered) { clearTimeout(timer); pendingRpc.delete(id); return res.status(502).json({ ok: false, error: 'device push failed' }); }
  });
  app.post('/gw/rpc-result', (req, res) => {
    const b = req.body || {};
    if (requireToken && !auth(b.token)) return res.status(401).json({ ok: false, error: 'invalid device token' });
    const id = String(b.id || '');
    const p = pendingRpc.get(id);
    if (!p) return res.json({ ok: false, error: 'unknown or expired rpc id' });
    pendingRpc.delete(id);
    p.resolve(b.result != null ? b.result : { ok: false, error: 'no result' });
    res.json({ ok: true });
  });
  // Let the core discover which devices can be actuated (for the MCP tool's device targeting).
  app.get('/gw/devices', (req, res) => {
    res.json({ ok: true,
      devices: [...devices.entries()].map(([id, d]) => ({ id, name: d.name, since: d.since })),
      control: [...controlDevices.entries()].map(([id, d]) => ({ id, name: d.name, since: d.since })) });
  });

  // --- manager→device push: `asmltr send android <device>` / announcements / steer ------------------
  app.post('/out', (req, res) => {
    const { target, text } = req.body || {};
    const device = String(target || '').trim();
    if (!device) return res.status(400).json({ ok: false, error: 'target device id required' });
    const delivered = pushSSE(device, { type: 'inject', text: String(text || '') });
    if (!delivered) return res.json({ ok: false, error: 'device not connected', conversation_key: convKey(device) });
    return res.json({ ok: true, conversation_key: convKey(device) });
  });

  // --- edge speech: STT + TTS proxied here so the phone needs only its device token ----------------
  app.post('/gw/transcribe', async (req, res) => {
    const b = req.body || {};
    if (requireToken && !auth(b.token)) return res.status(401).json({ ok: false, error: 'invalid device token' });
    try {
      const buf = Buffer.from(String(b.audio_base64 || ''), 'base64');
      if (!buf.length) return res.status(400).json({ ok: false, error: 'audio_base64 required' });
      const r = await stt.transcribe(buf, { mime: b.mime || 'audio/webm', filename: b.filename, language: b.language });
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
      res.json({ ok: true, mime: r.mime, b64: Buffer.from(r.audio).toString('base64') });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // --- APK download: open (the app isn't a secret; the device token gates the API, not the binary) ---
  // Default: the built debug APK; override with ASMLTR_ANDROID_APK. Install straight from the instance:
  // https://<host>/app/gw/download
  const APK = process.env.ASMLTR_ANDROID_APK || path.join(__dirname, '..', '..', '..', 'mobile', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  const APK_VER = path.join(__dirname, '..', '..', '..', 'mobile', 'app-version.json');
  app.get('/gw/app', (req, res) => {
    let v = {}; try { v = JSON.parse(fs.readFileSync(APK_VER, 'utf8')); } catch (_) {}
    res.json({ available: fs.existsSync(APK), download: '/app/gw/download', filename: 'asmltr.apk', versionCode: v.versionCode || 0, versionName: v.versionName || '' });
  });
  // Branding + the global voice/VAD tuning (from core /v2/voice/config), so the app themes itself AND
  // applies the shared end-of-speech / mic-sensitivity settings edited in the web GUI / TUI.
  const CORE_VOICE = (process.env.ASMLTR_CORE_URL || 'http://127.0.0.1:3023/v2/handle').replace(/\/v2\/handle$/, '/v2/voice/config');
  app.get('/gw/theme', async (req, res) => {
    let palette = '', name = '';
    try { palette = identity.getFacet('palette') || ''; } catch (_) {}
    try { name = identity.name() || ''; } catch (_) {}
    let stt = null;
    try { const r = await fetch(CORE_VOICE); if (r.ok) { const j = await r.json(); stt = j.stt || null; } } catch (_) {}
    const vad = stt ? { endpoint_ms: stt.vad_endpoint_ms, start_ms: stt.vad_start_ms, sensitivity: stt.vad_sensitivity } : null;
    const wake = stt ? { enabled: !!stt.wake_enabled, phrase: stt.wake_phrase || '', sensitivity: stt.wake_sensitivity } : null;
    res.json({ palette, agentName: name, vad, wake });
  });

  // Wake word (Porcupine): the app fetches its config + the runtime access key here, and downloads the
  // keyword model (.ppn) for the configured phrase. Models live in a gitignored keywords/ dir (licensed
  // binaries generated at console.picovoice.ai, named <phrase-slug>.ppn). No model → wake stays inert.
  const KW_DIR = process.env.ASMLTR_ANDROID_KEYWORDS || path.join(__dirname, 'keywords');
  const phraseSlug = (p) => String(p || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  app.get('/gw/wake', async (req, res) => {
    if (requireToken && !auth(req.query.token)) return res.status(401).json({ ok: false, error: 'invalid device token' });
    let stt = null;
    try { const r = await fetch(CORE_VOICE); if (r.ok) { const j = await r.json(); stt = j.stt || null; } } catch (_) {}
    const phrase = (stt && stt.wake_phrase) || `hey ${process.env.ASSISTANT_NAME || 'assistant'}`;
    const slug = phraseSlug(phrase);
    let accessKey = ''; try { accessKey = (await ctx.secrets.get('porcupine_access_key')) || ''; } catch (_) {}
    const hasModel = (() => { try { return fs.existsSync(path.join(KW_DIR, slug + '.ppn')); } catch (_) { return false; } })();
    res.json({ ok: true, enabled: !!(stt && stt.wake_enabled), phrase, slug,
      sensitivity: (stt && stt.wake_sensitivity != null) ? stt.wake_sensitivity : 50,
      access_key: accessKey, has_model: hasModel });
  });
  app.get('/gw/wake-model', (req, res) => {
    if (requireToken && !auth(req.query.token)) return res.status(401).json({ ok: false, error: 'invalid device token' });
    const slug = phraseSlug(req.query.phrase || req.query.slug);
    const f = path.join(KW_DIR, slug + '.ppn');
    if (!slug || !fs.existsSync(f)) return res.status(404).json({ ok: false, error: 'no keyword model for that phrase — generate one at console.picovoice.ai' });
    res.setHeader('Content-Type', 'application/octet-stream');
    fs.createReadStream(f).pipe(res);
  });
  app.get('/gw/download', (req, res) => {
    if (!fs.existsSync(APK)) return res.status(404).json({ ok: false, error: 'APK not built yet' });
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="asmltr.apk"');
    fs.createReadStream(APK).pipe(res);
  });

  const httpServer = app.listen(PORT, BIND, () => ctx.log(`android device gateway on ${BIND}:${PORT} (${requireToken ? 'token required' : 'OPEN'})`));

  return {
    async stop() {
      for (const d of devices.values()) { try { d.res.end(); } catch (_) {} }
      for (const d of controlDevices.values()) { try { d.res.end(); } catch (_) {} }
      devices.clear(); controlDevices.clear();
      await new Promise((r) => httpServer.close(() => r()));
    },
    health() { return { http_port: PORT, devices: devices.size, control: controlDevices.size }; },
  };
}

module.exports = { meta, start };
