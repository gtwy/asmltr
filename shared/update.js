'use strict';
/**
 * asmltr self-update awareness — is a newer version available on origin/main?
 *
 * Read-only detection (git fetch + compare) plus the persisted auto-update flag. The actual
 * update is performed by a spawned AGENT SESSION running UPDATE-WITH-AGENT.md (see
 * scripts/run-update-session.js) — never from here; this module only *senses* and stores intent.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const REPO = path.join(__dirname, '..'); // shared/ lives at the repo root
const AUTO_FLAG = process.env.ASMLTR_AUTOUPDATE_FILE || path.join(os.homedir(), '.asmltr', 'auto-update');

const git = async (...args) => (await execFileP('git', ['-C', REPO, ...args], { timeout: 60000 })).stdout.trim();

/** Fetch origin and report how far behind origin/main we are, with a short changelog. Never throws. */
async function getUpdateStatus({ fetch = true } = {}) {
  try {
    if (fetch) { try { await git('fetch', '--quiet', 'origin', 'main'); } catch (_) {} }
    const head = await git('rev-parse', 'HEAD');
    let remote = head, behind = 0, changelog = [];
    try { remote = await git('rev-parse', 'origin/main'); } catch (_) {}
    if (remote !== head) {
      behind = Number(await git('rev-list', '--count', 'HEAD..origin/main')) || 0;
      if (behind) changelog = (await git('log', '--oneline', '--no-decorate', '-20', 'HEAD..origin/main')).split('\n').filter(Boolean);
    }
    return { ok: true, behind, available: behind > 0, head: head.slice(0, 7), remote: remote.slice(0, 7), changelog, checked_at: Date.now() };
  } catch (e) {
    return { ok: false, behind: 0, available: false, error: e.message, checked_at: Date.now() };
  }
}

/** Auto-update on/off — a file flag (survives restarts, checkable even if a DB is wedged). */
function isAutoUpdate() { try { return fs.existsSync(AUTO_FLAG); } catch { return false; } }
function setAutoUpdate(on) {
  try {
    fs.mkdirSync(path.dirname(AUTO_FLAG), { recursive: true });
    if (on) fs.writeFileSync(AUTO_FLAG, `enabled ${new Date().toISOString()}\n`);
    else if (fs.existsSync(AUTO_FLAG)) fs.unlinkSync(AUTO_FLAG);
    return isAutoUpdate();
  } catch { return isAutoUpdate(); }
}

/** Spawn the DETACHED update session (runs UPDATE-WITH-AGENT.md via the local SDK). Returns its pid. */
function spawnUpdateSession() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'run-update-session.js')], {
    cwd: REPO, detached: true, stdio: 'ignore', env: process.env,
  });
  child.unref();
  return { pid: child.pid, started_at: Date.now() };
}

module.exports = { getUpdateStatus, isAutoUpdate, setAutoUpdate, spawnUpdateSession, REPO, AUTO_FLAG };
