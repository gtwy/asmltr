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
app.delete('/instances/:id', requireToken, (req, res) => {
  supervisor.stopInstance(req.params.id);
  registry.remove(req.params.id);
  res.json({ ok: true });
});

// --- unified outbound: route a message OUT through a connector instance --------
// POST /send { channel|instance_id, target, kind?, text?, path?, caption? }
app.post('/send', requireToken, async (req, res) => {
  const { channel, instance_id, target, kind = 'text', text, path: filePath, caption } = req.body || {};
  let inst = instance_id ? registry.get(instance_id)
    : channel ? (registry.list().find((i) => i.type === channel && i.enabled) || registry.list().find((i) => i.type === channel))
    : null;
  if (!inst) return res.status(404).json({ error: 'no connector instance for that channel/instance_id' });
  const meta = TYPES[inst.type];
  if (!meta || !meta.outbound) return res.status(400).json({ error: `type '${inst.type}' has no outbound capability` });
  const port = inst.config && inst.config.http_port;
  if (!port) return res.status(400).json({ error: `instance '${inst.name}' has no http_port` });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/out`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, target, text, path: filePath, caption }) });
    const j = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : 502).json({ ...j, via: `${inst.type}:${inst.name}` });
  } catch (e) { return res.status(502).json({ error: `connector unreachable: ${e.message}` }); }
});
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
});

process.on('SIGTERM', () => { supervisor.stopAll(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); });

module.exports = { app };
