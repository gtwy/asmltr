#!/usr/bin/env node
'use strict';
require('../../shared/loadenv'); // load <repo>/.env before anything reads config
/**
 * asmltr-insights — collector server (plan §B1).
 *
 * POST /ingest         producers post shared-contract events (bearer-gated)
 * GET  /api/sessions   reconciled live sessions (the honest instance list)
 * GET  /api/events     filtered event feed
 * GET  /api/usage      hourly usage rollup (tokens + attribution)
 * GET  /api/system     system metric samples
 * GET  /api/notifications
 * GET  /api/brief      compact summary (the morning-brief JSON)
 * GET  /health
 * socket.io broadcasts: 'event', 'system-sample', 'sessions-changed'
 *
 * Host/PM2, bind 127.0.0.1:3017. Control routes (kill/resume/attach) land in
 * Phase 4 with stronger (Authelia group + control-token) gating.
 */

const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const dbmod = require('./db');
const reconcile = require('./reconcile');
const sampler = require('./sampler');
const tailer = require('./tailer');
const { makeControl } = require('./control');
const { buildEvent } = require('../../shared/events');

const PORT = Number(process.env.ASMLTR_INSIGHTS_PORT || 3017);
const HOST = '127.0.0.1';
const TOKEN = process.env.ASMLTR_INSIGHTS_TOKEN || '';
const CONTROL_TOKEN = process.env.ASMLTR_INSIGHTS_CONTROL_TOKEN || '';
const RECONCILE_MS = Number(process.env.ASMLTR_RECONCILE_MS || 15000);
const SAMPLE_MS = Number(process.env.ASMLTR_SAMPLE_MS || 30000);
const TAIL_MS = Number(process.env.ASMLTR_TAIL_MS || 5000);
const ENABLE_TAILER = process.env.ASMLTR_ENABLE_TAILER !== '0';

const app = express();
app.use(express.json({ limit: '5mb' }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// --- auth: read + ingest require the service bearer (Authelia Remote-User layer
//     is added at the Traefik edge when the dashboard lands; control routes get
//     the stronger group+control-token gate in Phase 4). ----------------------
function requireToken(req, res, next) {
  if (!TOKEN) return next(); // dev mode: warned at boot
  const auth = req.get('authorization') || '';
  if (auth === `Bearer ${TOKEN}`) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// Control routes need a STRONGER gate than reads (they SIGTERM host pids /
// restart daemons): control token + (at the edge) an admins group. Actor is the
// Authelia-forwarded Remote-User when present, else the CLI identity.
const control = makeControl(dbmod);
function requireControl(req, res, next) {
  const actor = req.get('x-remote-user') || req.get('remote-user') || req.query.actor || 'cli';
  if (CONTROL_TOKEN) {
    const auth = req.get('authorization') || '';
    if (auth !== `Bearer ${CONTROL_TOKEN}`) return res.status(403).json({ error: 'control: forbidden' });
  }
  req.actor = actor;
  next();
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'asmltr-insights-collector' }));

// --- session titles ----------------------------------------------------------
// Label each session card with a short generated title. On the FIRST inbound for a
// session (and every ASMLTR_TITLE_REFRESH_TURNS after) we ask the core to summarize the
// conversation into a title (a cheap, no-tools SDK call). Gen is serialized (one at a
// time) so it never floods; titles aren't urgent.
const CORE_BASE = process.env.ASMLTR_CORE_BASE || 'http://127.0.0.1:3023';
const TITLE_EVERY = Math.max(1, Number(process.env.ASMLTR_TITLE_REFRESH_TURNS || 15));
const _inboundCounts = new Map(); // session_id -> inbound events seen this process
let _titleChain = Promise.resolve();
function payloadText(e) { try { const p = typeof e.payload === 'string' ? JSON.parse(e.payload) : (e.payload || {}); return p.text || ''; } catch { return ''; } }
function recentConvo(sid) {
  try {
    const rows = dbmod.db.prepare("SELECT event_type, payload FROM events WHERE session_id=? AND event_type IN ('inbound','outbound') ORDER BY ts DESC LIMIT 12").all(sid);
    return rows.reverse().map((r) => { let p = {}; try { p = JSON.parse(r.payload); } catch {} const t = String(p.text || '').slice(0, 300); return t ? `${r.event_type === 'inbound' ? 'User' : 'Assistant'}: ${t}` : ''; }).filter(Boolean).join('\n');
  } catch { return ''; }
}
function queueTitle(session_id, text) {
  if (!text) return;
  _titleChain = _titleChain.then(async () => {
    try {
      const r = await fetch(CORE_BASE + '/v2/title', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      if (!r.ok) return;
      const j = await r.json();
      if (j && j.title) { dbmod.setTitle(session_id, j.title); io.emit('sessions-changed', {}); }
    } catch (_) {}
  }).catch(() => {});
}
function maybeTitle(e) {
  if (!e || e.event_type !== 'inbound' || !e.session_id || e.surface === 'system') return;
  const sid = e.session_id;
  const n = (_inboundCounts.get(sid) || 0) + 1;
  _inboundCounts.set(sid, n);
  if (!dbmod.getTitle(sid)) queueTitle(sid, payloadText(e));             // first inbound → title it now
  else if (n % TITLE_EVERY === 0) queueTitle(sid, recentConvo(sid) || payloadText(e)); // periodic refresh
}

// --- ingest ------------------------------------------------------------------
app.post('/ingest', requireToken, (req, res) => {
  const body = req.body;
  const list = Array.isArray(body) ? body : [body];
  let ok = 0;
  for (const e of list) {
    try {
      const stored = dbmod.ingestEvent(e);
      io.emit('event', stored);
      maybeTitle(stored);
      ok++;
    } catch (err) {
      return res.status(400).json({ error: err.message, ingested: ok });
    }
  }
  res.json({ ingested: ok });
});

// --- read API ----------------------------------------------------------------
app.get('/api/sessions', requireToken, (req, res) => {
  const rows = req.query.active === '1' ? dbmod.q.activeSessions.all() : dbmod.q.sessions.all({ limit: Number(req.query.limit) || 200 });
  res.json({ sessions: rows, count: rows.length });
});
app.get('/api/events', requireToken, (req, res) => {
  const rows = dbmod.q.events.all({
    surface: req.query.surface || null,
    identity: req.query.identity || null,
    session: req.query.session || null,
    since: Number(req.query.since) || 0,
    limit: Math.min(Number(req.query.limit) || 100, 1000),
  });
  res.json({ events: rows, count: rows.length });
});
app.get('/api/usage', requireToken, (req, res) => {
  const since = Number(req.query.since) || Date.now() - 24 * 3600000;
  res.json({ usage: dbmod.q.usage.all({ since }) });
});
app.get('/api/system', requireToken, (req, res) => {
  const since = Number(req.query.since) || Date.now() - 3600000;
  res.json({ samples: dbmod.q.system.all({ since, limit: Math.min(Number(req.query.limit) || 500, 5000) }) });
});
app.get('/api/notifications', requireToken, (req, res) => {
  res.json({ notifications: dbmod.q.notifications.all({ limit: Number(req.query.limit) || 100 }) });
});

// --- brief: compact summary (replaces stdout-only morning brief data) --------
app.get('/api/brief', requireToken, (req, res) => {
  const active = dbmod.q.activeSessions.all();
  const since = Math.floor((Date.now() - 24 * 3600000) / 3600000) * 3600000;
  const usage = dbmod.q.usage.all({ since });
  const bySurface = {};
  let tokens = 0;
  for (const u of usage) {
    bySurface[u.surface] = (bySurface[u.surface] || 0) + u.tokens_in + u.tokens_out;
    tokens += u.tokens_in + u.tokens_out;
  }
  res.json({
    ts: Date.now(),
    active_sessions: active.length,
    sessions: active.map((s) => ({ id: s.session_id, surface: s.surface, kind: s.kind, task: s.task, context: s.context })),
    tokens_24h: tokens,
    tokens_by_surface_24h: bySurface,
  });
});

// --- control plane (privileged) ----------------------------------------------
app.post('/api/control/kill', requireControl, (req, res) => {
  const r = control.kill(req.body.session_id, req.actor, req.body.hard === true);
  io.emit('control', { action: 'kill', target: req.body.session_id, ok: r.ok });
  res.status(r.ok ? 200 : 400).json(r);
});
app.post('/api/control/stop', requireControl, (req, res) => {
  const r = control.stop(req.body.session_id, req.actor);
  io.emit('control', { action: 'stop', target: req.body.session_id, ok: r.ok });
  res.status(r.ok ? 200 : 400).json(r);
});
// inject into a tmux-backed `asmltr claude` session (steer / interrupt)
app.post('/api/control/send-keys', requireControl, (req, res) => {
  const { session_id, text, keys, enter } = req.body || {};
  const r = control.sendKeys(session_id, { text, keys, enter }, req.actor);
  io.emit('control', { action: 'send-keys', target: session_id, ok: r.ok });
  res.status(r.ok ? 200 : 400).json(r);
});
app.get('/api/control/diff', requireControl, (req, res) => {
  control.diff(req.query.session_id, (_e, r) => res.status(r.ok ? 200 : 400).json(r));
});
app.post('/api/control/restart-daemon', requireControl, (req, res) => {
  control.restartDaemon(req.body.target, req.actor, (_e, r) => {
    io.emit('control', { action: 'restart-daemon', target: req.body.target, ok: r.ok });
    res.status(r.ok ? 200 : 400).json(r);
  });
});
app.get('/api/control/audit', requireToken, (req, res) => res.json({ audit: control.recentAudit(Number(req.query.limit) || 50) }));

server.listen(PORT, HOST, () => {
  console.log(`asmltr-insights-collector on http://${HOST}:${PORT}`);
  if (!TOKEN) console.warn('[collector] WARNING: ASMLTR_INSIGHTS_TOKEN unset — auth disabled (dev mode)');

  reconcile.start(dbmod, RECONCILE_MS, (n) => io.emit('sessions-changed', { count: n }));
  sampler.start(dbmod, SAMPLE_MS, (s) => io.emit('system-sample', s));
  if (ENABLE_TAILER) {
    tailer.start(dbmod, TAIL_MS, (n) => console.log(`[tailer] ingested ${n} events from proxy logs`));
    console.log('[collector] JSONL tailer active (proxy logs → events)');
  }
});

module.exports = { app, server };
