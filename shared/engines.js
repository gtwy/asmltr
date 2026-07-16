'use strict';
/**
 * Reasoning engines — the registry of pluggable agentic backends (harnesses) asmltr can run
 * (roadmap: docs/REASONING-ENGINES.md). Each engine wraps a CLI harness (Claude Code, Gemini CLI,
 * Codex CLI). This module owns:
 *   • the static registry of KNOWN engines (id, label, how to resolve the binary),
 *   • binary resolution + installed-detection (so the GUI/CLI can show what's actually available),
 *   • the persisted config: which engine is the DEFAULT + per-engine settings (`~/.asmltr/engines.json`).
 *
 * Capabilities + the live tool inventory are DERIVED at runtime from each harness's handshake (see the
 * engine adapters in core/src/engines/) — this file only carries the static, install-level facts.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const expand = (p) => (p && p.startsWith('~') ? path.join(HOME, p.slice(1)) : p);

// Static registry — the harnesses asmltr knows how to launch. `binPaths` are fallbacks beyond $PATH.
const ENGINES = {
  claude: { id: 'claude', label: 'Claude', bin: 'claude', binEnv: 'ASMLTR_CLAUDE_BIN', install: 'npm i -g @anthropic-ai/claude-code',
    binPaths: ['/usr/local/bin/claude', '/usr/bin/claude', '~/.claude/local/claude', '~/.local/bin/claude'] },
  gemini: { id: 'gemini', label: 'Gemini', bin: 'gemini', binEnv: 'ASMLTR_GEMINI_BIN', install: 'npm i -g @google/gemini-cli',
    binPaths: ['/usr/local/bin/gemini', '/usr/bin/gemini', '~/.local/bin/gemini'] },
  codex: { id: 'codex', label: 'Codex', bin: 'codex', binEnv: 'ASMLTR_CODEX_BIN', install: 'npm i -g @openai/codex',
    binPaths: ['/usr/local/bin/codex', '/usr/bin/codex', '~/.local/bin/codex'] },
};

const isExecFile = (p) => { try { const st = fs.statSync(p); return st.isFile() && (st.mode & 0o111) !== 0; } catch { return false; } };

/** Resolve an engine's real executable: $<binEnv> → $PATH → known install locations. null if absent. */
function resolveBin(id) {
  const e = ENGINES[id];
  if (!e) return null;
  const envBin = process.env[e.binEnv];
  if (envBin) return isExecFile(envBin) ? envBin : null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && isExecFile(path.join(dir, e.bin))) return path.join(dir, e.bin);
  }
  for (const c of e.binPaths.map(expand)) if (isExecFile(c)) return c;
  return null;
}
function installed(id) { return !!resolveBin(id); }
function version(id) { const bin = resolveBin(id); if (!bin) return null; try { return execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0]; } catch { return null; } }

// ── persisted config (default engine + per-engine settings) ────────────────────
function file() { return process.env.ASMLTR_ENGINES_FILE || path.join(HOME, '.asmltr', 'engines.json'); }
function load() { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return { default: 'claude', engines: {} }; } }
function save(d) { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(d, null, 2)); }

function known(id) { return !!ENGINES[id]; }
function getDefault() { const d = load().default; return known(d) ? d : 'claude'; }
function setDefault(id) { if (!known(id)) throw new Error('unknown engine: ' + id); const d = load(); d.default = id; save(d); return id; }
function config(id) { return (load().engines || {})[id] || {}; }
function setConfig(id, patch) { if (!known(id)) throw new Error('unknown engine: ' + id); const d = load(); d.engines = d.engines || {}; d.engines[id] = { ...(d.engines[id] || {}), ...patch }; save(d); return d.engines[id]; }

/** One row per known engine — the static facts the GUI/CLI need (capabilities are derived elsewhere). */
function list() {
  const def = getDefault();
  return Object.values(ENGINES).map((e) => ({
    id: e.id, label: e.label, install: e.install,
    installed: installed(e.id), version: version(e.id),
    isDefault: e.id === def,
    enabled: config(e.id).enabled !== false, // enabled unless explicitly disabled
    config: config(e.id),
  }));
}

module.exports = { ENGINES, resolveBin, installed, version, known, getDefault, setDefault, config, setConfig, list };
