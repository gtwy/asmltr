'use strict';
/**
 * asmltr connector manager — supervisor. One OS process per ENABLED instance
 * (isolation). Restarts on crash with backoff; keeps a per-instance log ring.
 */

const path = require('path');
const { spawn } = require('child_process');

const RUNTIME = path.join(__dirname, '..', 'runtime', 'run-instance.js');
const MAX_RESTARTS = 5;          // within the window before we give up
const RESTART_WINDOW_MS = 60000;
const LOG_RING = 200;

function makeSupervisor(env) {
  const procs = new Map(); // id -> { child, status, restarts, restartTimes[], startedAt, lastExit, logs[] }

  function logLine(rec, line) {
    rec.logs.push(`${new Date().toISOString()} ${line}`);
    if (rec.logs.length > LOG_RING) rec.logs.shift();
  }

  function spawnInstance(instance) {
    if (procs.has(instance.id) && procs.get(instance.id).status === 'running') return;
    const rec = procs.get(instance.id) || { restarts: 0, restartTimes: [], logs: [] };
    rec.instance = instance;
    rec.status = 'starting';
    procs.set(instance.id, rec);

    const child = spawn('node', [RUNTIME], {
      env: {
        ...env,
        ASMLTR_CONNECTOR_TYPE: instance.type,
        ASMLTR_CONNECTOR_ID: instance.id,
        ASMLTR_CONNECTOR_NAME: instance.name,
        ASMLTR_CONNECTOR_CONFIG: JSON.stringify(instance.config || {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    rec.child = child;
    rec.status = 'running';
    rec.startedAt = Date.now();
    rec.pid = child.pid;

    child.stdout.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => logLine(rec, l)));
    child.stderr.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => logLine(rec, '[err] ' + l)));

    child.on('exit', (code, sig) => {
      rec.lastExit = { code, sig, at: Date.now() };
      rec.child = null;
      if (rec.intentionalStop) { rec.status = 'stopped'; return; }
      // crash → backoff restart
      const now = Date.now();
      rec.restartTimes = rec.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS);
      if (rec.restartTimes.length >= MAX_RESTARTS) {
        rec.status = 'failed';
        logLine(rec, `gave up after ${MAX_RESTARTS} restarts in ${RESTART_WINDOW_MS / 1000}s`);
        return;
      }
      rec.restartTimes.push(now);
      rec.restarts++;
      rec.status = 'restarting';
      const delay = Math.min(1000 * 2 ** rec.restartTimes.length, 15000);
      logLine(rec, `exited (code=${code} sig=${sig}); restart in ${delay}ms`);
      setTimeout(() => { if (!rec.intentionalStop) spawnInstance(rec.instance); }, delay);
    });

    logLine(rec, `spawned pid ${child.pid}`);
  }

  // SIGTERM, then SIGKILL any child that hasn't exited within the grace window — so a
  // hung connector can never survive a stop/restart as a stale-code orphan.
  function killChild(child, graceMs = 4000) {
    let exited = false;
    child.once('exit', () => { exited = true; });
    try { child.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => { if (!exited) { try { child.kill('SIGKILL'); } catch (_) {} } }, graceMs).unref();
  }

  function stopInstance(id) {
    const rec = procs.get(id);
    if (!rec || !rec.child) { if (rec) rec.status = 'stopped'; return false; }
    rec.intentionalStop = true;
    killChild(rec.child);
    return true;
  }

  function restartInstance(instance) {
    const rec = procs.get(instance.id);
    if (rec && rec.child) {
      rec.intentionalStop = true;
      rec.child.once('exit', () => { rec.intentionalStop = false; rec.restartTimes = []; spawnInstance(instance); });
      killChild(rec.child);
    } else {
      spawnInstance(instance);
    }
  }

  function status(id) {
    const rec = procs.get(id);
    if (!rec) return { status: 'stopped', restarts: 0 };
    return { status: rec.status, pid: rec.child ? rec.pid : null, restarts: rec.restarts, startedAt: rec.startedAt, lastExit: rec.lastExit };
  }
  function logs(id) { const rec = procs.get(id); return rec ? rec.logs.slice() : []; }
  function stopAll() { for (const id of procs.keys()) stopInstance(id); }

  return { spawnInstance, stopInstance, restartInstance, status, logs, stopAll };
}

module.exports = { makeSupervisor };
