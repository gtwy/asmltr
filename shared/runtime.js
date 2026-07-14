'use strict';
/**
 * Agent runtime introspection + control — the "keep the brain current" layer.
 *
 * The model a channel turn runs is gated by the installed Agent SDK (@anthropic-ai/claude-agent-sdk):
 * an old SDK caps you to old models (that's how the core sat on Opus 4.1 for months). So "keep the
 * model up to date" = keep the SDK up to date + use a model ALIAS that tracks the latest of its tier.
 *
 * This module exposes: the model selection (persisted so the GUI can change it without a restart),
 * the SDK version (installed + latest-on-npm), an SDK auto-update flag, and a detached updater.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const REPO = path.join(__dirname, '..');
const CORE_DIR = path.join(REPO, 'core');
const SDK_PKG = '@anthropic-ai/claude-agent-sdk';

function stateDir() {
  const d = process.env.ASMLTR_STATE_DIR || path.join(os.homedir(), '.asmltr');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}
const modelFile = () => path.join(stateDir(), 'model');
const sdkAutoFile = () => path.join(stateDir(), 'sdk-auto-update');

// Model selection: GUI-set file wins → ASMLTR_MODEL env → 'opus' (alias tracks the latest Opus).
// runner.js calls this every turn, so a GUI change applies on the NEXT turn with no restart.
function getModel() {
  try { const v = fs.readFileSync(modelFile(), 'utf8').trim(); if (v) return v; } catch (_) {}
  return process.env.ASMLTR_MODEL || 'opus';
}
function setModel(m) {
  const v = String(m || '').trim();
  try { if (v) fs.writeFileSync(modelFile(), v); else fs.unlinkSync(modelFile()); } catch (_) {}
  return getModel();
}

function isSdkAutoUpdate() { try { return fs.readFileSync(sdkAutoFile(), 'utf8').trim() === '1'; } catch (_) { return false; } }
function setSdkAutoUpdate(b) { try { fs.writeFileSync(sdkAutoFile(), b ? '1' : '0'); } catch (_) {} return isSdkAutoUpdate(); }

function sdkVersion() {
  try { return require(path.join(CORE_DIR, 'node_modules', SDK_PKG, 'package.json')).version; } catch (_) { return null; }
}

let _latest = { v: null, at: 0 };
async function latestSdkVersion({ fetch = true } = {}) {
  if (_latest.v && (!fetch || Date.now() - _latest.at < 3600000)) return _latest.v; // 1h cache
  try {
    const { stdout } = await execFileP('npm', ['view', SDK_PKG, 'version'], { timeout: 15000 });
    const v = stdout.trim();
    if (v) _latest = { v, at: Date.now() };
    return _latest.v;
  } catch (_) { return _latest.v; }
}

/** Update the SDK to latest + restart the core, detached so it survives the restart. */
function updateSdk() {
  const log = path.join(stateDir(), 'sdk-update.log');
  const script = `echo "[$(date)] updating ${SDK_PKG}"; cd ${CORE_DIR} && npm install ${SDK_PKG}@latest --legacy-peer-deps && pm2 restart asmltr-core; echo "[$(date)] done"`;
  const child = spawn('setsid', ['bash', '-c', `sleep 1; { ${script}; } >> ${log} 2>&1`], { detached: true, stdio: 'ignore' });
  child.unref();
  return { started: true, pid: child.pid || null, log };
}

async function status({ fetch = true } = {}) {
  const installed = sdkVersion();
  const latest = await latestSdkVersion({ fetch });
  return {
    sdk: { package: SDK_PKG, installed, latest, updateAvailable: !!(installed && latest && installed !== latest) },
    model: { configured: getModel() },
    autoUpdate: isSdkAutoUpdate(),
  };
}

module.exports = { getModel, setModel, isSdkAutoUpdate, setSdkAutoUpdate, sdkVersion, latestSdkVersion, updateSdk, status };
