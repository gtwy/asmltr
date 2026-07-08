#!/usr/bin/env node
'use strict';
require('../../shared/loadenv'); // load <repo>/.env before anything reads config
/**
 * asmltr connector manager — registry + supervisor + management API (the plane
 * the dashboard "Integrations" page drives). Host/PM2, bind 127.0.0.1.
 *
 *   GET  /types                       available connector types (+ configSchema)
 *   GET  /instances                   instances + live status
 *   POST /instances                   create (validate vs type schema) [+ start if enabled]
 *   GET  /instances/:id               detail + recent logs
 *   PATCH /instances/:id              update config/name/enabled (restart if running)
 *   DELETE /instances/:id             stop + remove
 *   POST /instances/:id/{start,stop,restart}
 *   GET  /instances/:id/logs
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const registry = require('./registry');
const { makeSupervisor } = require('./supervisor');

const PORT = Number(process.env.ASMLTR_MANAGER_PORT || 3024);
const HOST = '127.0.0.1';
const TOKEN = process.env.ASMLTR_MANAGER_TOKEN || '';

const childEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  ASMLTR_CORE_URL: process.env.ASMLTR_CORE_URL || 'http://127.0.0.1:3023/v2/handle',
  ASMLTR_COLLECTOR_URL: process.env.ASMLTR_COLLECTOR_URL || 'http://127.0.0.1:3017/ingest',
  ASMLTR_INSIGHTS_TOKEN: process.env.ASMLTR_INSIGHTS_TOKEN || '',
};
const supervisor = makeSupervisor(childEnv);

// --- discover type plugins ---------------------------------------------------
const TYPES_DIR = path.join(__dirname, '..', 'types');
function loadTypes() {
  const out = {};
  for (const t of fs.readdirSync(TYPES_DIR)) {
    try {
      const mod = require(path.join(TYPES_DIR, t));
      if (mod && mod.meta) out[mod.meta.type] = mod.meta;
    } catch (e) { console.error(`[manager] type '${t}' failed to load:`, e.message); }
  }
  return out;
}
const TYPES = loadTypes();

function validateConfig(typeMeta, config) {
  const req = (typeMeta.configSchema && typeMeta.configSchema.required) || [];
  const missing = req.filter((k) => config[k] === undefined || config[k] === null || config[k] === '');
  return missing.length ? `missing required config: ${missing.join(', ')}` : null;
}

const app = express();
app.use(express.json({ limit: '2mb' }));
function requireToken(req, res, next) {
  if (!TOKEN) return next();
  if ((req.get('authorization') || '') === `Bearer ${TOKEN}`) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'asmltr-connector-manager', types: Object.keys(TYPES) }));
app.get('/types', requireToken, (req, res) => res.json({ types: Object.values(TYPES) }));

app.get('/instances', requireToken, (req, res) => {
  res.json({ instances: registry.list().map((i) => ({ ...i, runtime: supervisor.status(i.id) })) });
});
app.get('/instances/:id', requireToken, (req, res) => {
  const i = registry.get(req.params.id);
  if (!i) return res.status(404).json({ error: 'not found' });
  res.json({ ...i, runtime: supervisor.status(i.id), logs: supervisor.logs(i.id) });
});
app.get('/instances/:id/logs', requireToken, (req, res) => res.json({ logs: supervisor.logs(req.params.id) }));

app.post('/instances', requireToken, (req, res) => {
  const { type, name, config = {}, enabled = false } = req.body || {};
  if (!TYPES[type]) return res.status(400).json({ error: `unknown type '${type}'` });
  const bad = validateConfig(TYPES[type], config);
  if (bad) return res.status(400).json({ error: bad });
  const inst = registry.create({ type, name, config, enabled });
  if (inst.enabled) supervisor.spawnInstance(inst);
  res.json(inst);
});

app.patch('/instances/:id', requireToken, (req, res) => {
  const cur = registry.get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  if (req.body.config) {
    const bad = validateConfig(TYPES[cur.type], req.body.config);
    if (bad) return res.status(400).json({ error: bad });
  }
  const next = registry.update(req.params.id, req.body);
  // apply runtime change
  if (next.enabled) supervisor.restartInstance(next);
  else supervisor.stopInstance(next.id);
  res.json(next);
});

app.post('/instances/:id/start', requireToken, (req, res) => {
  const i = registry.get(req.params.id); if (!i) return res.status(404).json({ error: 'not found' });
  registry.update(i.id, { enabled: true }); supervisor.spawnInstance({ ...i, enabled: true }); res.json({ ok: true });
});
app.post('/instances/:id/stop', requireToken, (req, res) => {
  const i = registry.get(req.params.id); if (!i) return res.status(404).json({ error: 'not found' });
  registry.update(i.id, { enabled: false }); supervisor.stopInstance(i.id); res.json({ ok: true });
});
app.post('/instances/:id/restart', requireToken, (req, res) => {
  const i = registry.get(req.params.id); if (!i) return res.status(404).json({ error: 'not found' });
  supervisor.restartInstance(i); res.json({ ok: true });
});
// --- per-channel enable/disable: proxy to the connector's own /channels endpoint (no restart).
// Lets the TUI/GUI see every channel a connector can reach and toggle whether it relays to core.
async function proxyChannels(id, method, body) {
  const inst = registry.get(id);
  if (!inst) return { status: 404, json: { ok: false, error: 'not found' } };
  const port = inst.config && inst.config.http_port;
  if (!port) return { status: 400, json: { ok: false, error: `instance '${inst.name}' has no http_port` } };
  try {
    const r = await fetch(`http://127.0.0.1:${port}/channels`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, json: { instance_id: id, type: inst.type, name: inst.name, ...j } };
  } catch (e) { return { status: 502, json: { ok: false, error: `connector unreachable: ${e.message}` } }; }
}
app.get('/instances/:id/channels', requireToken, async (req, res) => { const r = await proxyChannels(req.params.id, 'GET'); res.status(r.status).json(r.json); });
app.post('/instances/:id/channels', requireToken, async (req, res) => { const r = await proxyChannels(req.params.id, 'POST', req.body || {}); res.status(r.status).json(r.json); });

app.delete('/instances/:id', requireToken, (req, res) => {
  supervisor.stopInstance(req.params.id);
  registry.remove(req.params.id);
  res.json({ ok: true });
});

// --- unified outbound: route a message OUT through a connector instance --------
// POST /send { channel|instance_id, target, kind?, text?, path?, caption? }
async function deliver({ channel, instance_id, target, kind = 'text', text, path: filePath, caption, subject, ref }) {
  const inst = instance_id ? registry.get(instance_id)
    : channel ? (registry.list().find((i) => i.type === channel && i.enabled) || registry.list().find((i) => i.type === channel))
    : null;
  if (!inst) return { ok: false, status: 404, error: 'no connector instance for that channel/instance_id' };
  const meta = TYPES[inst.type];
  if (!meta || !meta.outbound) return { ok: false, status: 400, error: `type '${inst.type}' has no outbound capability` };
  const port = inst.config && inst.config.http_port;
  if (!port) return { ok: false, status: 400, error: `instance '${inst.name}' has no http_port` };
  try {
    const r = await fetch(`http://127.0.0.1:${port}/out`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, target, text, path: filePath, caption, subject, ref }) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.ok ? 200 : 502, via: `${inst.type}:${inst.name}`, ...j };
  } catch (e) { return { ok: false, status: 502, error: `connector unreachable: ${e.message}` }; }
}
app.post('/send', requireToken, async (req, res) => { const r = await deliver(req.body || {}); res.status(r.status).json(r); });

// --- deferred announcements: queued now, delivered AFTER the next (re)start once the target
// connector reconnects. Lets an agent that just triggered its OWN update (over a channel)
// confirm completion in-channel, even though the restart killed the turn that issued it.
// POST /announce { channel|instance_id, target, text }
const ANNOUNCE_FILE = path.join(__dirname, 'data', 'announcements.json');
app.post('/announce', requireToken, (req, res) => {
  const { channel, instance_id, target, text } = req.body || {};
  if (!text || (!channel && !instance_id)) return res.status(400).json({ error: 'need text + channel or instance_id' });
  let queue = [];
  try { queue = JSON.parse(fs.readFileSync(ANNOUNCE_FILE, 'utf8')); } catch (_) {}
  if (!Array.isArray(queue)) queue = [];
  queue.push({ channel, instance_id, target, kind: 'text', text });
  try { fs.mkdirSync(path.dirname(ANNOUNCE_FILE), { recursive: true }); fs.writeFileSync(ANNOUNCE_FILE, JSON.stringify(queue)); }
  catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true, queued: queue.length });
});
async function drainAnnouncements() {
  let queue;
  try { queue = JSON.parse(fs.readFileSync(ANNOUNCE_FILE, 'utf8')); } catch (_) { return; }
  if (!Array.isArray(queue) || !queue.length) return;
  try { fs.writeFileSync(ANNOUNCE_FILE, '[]'); } catch (_) {} // clear first so a crash-loop can't re-spam
  for (const a of queue) {
    let sent = false;
    for (let i = 0; i < 6 && !sent; i++) { const r = await deliver(a).catch(() => ({ ok: false })); sent = !!r.ok; if (!sent) await new Promise((res) => setTimeout(res, 3000)); }
    console.log(`[manager] announcement ${sent ? 'delivered' : 'FAILED'}: ${String(a.text || '').slice(0, 60)}`);
  }
}
// list outbound-capable destinations (for the skill / dashboard)
app.get('/send/targets', requireToken, (req, res) => {
  const dests = registry.list().filter((i) => TYPES[i.type] && TYPES[i.type].outbound)
    .map((i) => ({ instance_id: i.id, channel: i.type, name: i.name, enabled: i.enabled, outbound: TYPES[i.type].outbound }));
  res.json({ targets: dests });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`asmltr-connector-manager on http://${HOST}:${PORT} — types: ${Object.keys(TYPES).join(', ')}`);
  if (!TOKEN) console.warn('[manager] ASMLTR_MANAGER_TOKEN unset — auth disabled (dev)');
  // boot: supervise enabled instances
  for (const inst of registry.list()) {
    if (inst.enabled) { console.log(`[manager] starting enabled instance ${inst.type}:${inst.name}`); supervisor.spawnInstance(inst); }
  }
  // deliver any announcement queued before a restart, once the connectors have reconnected
  setTimeout(drainAnnouncements, Number(process.env.ASMLTR_ANNOUNCE_DELAY_MS || 12000));
});

process.on('SIGTERM', () => { supervisor.stopAll(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); });

module.exports = { app };
