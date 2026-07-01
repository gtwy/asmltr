'use strict';
/**
 * Pluggable secret provider for asmltr.
 *
 * A "key" is a logical secret name (e.g. `openai_api_key`, `discord_bot_token`).
 * Resolution order (first hit wins), cached:
 *
 *   1. Environment: process.env[key], then process.env[UPPER_SNAKE(key)]
 *      → the portable, 12-factor default. Put secrets in the environment / a .env file.
 *
 *   2. Secrets file: JSON `{ "<key>": "<value>" }` at $ASMLTR_SECRETS_FILE.
 *
 *   3. Command provider: $ASMLTR_SECRET_CMD, a shell template run per key.
 *      `{key}` in the template is replaced with the (validated) key; if absent, the
 *      key is appended as an argument. stdout (trimmed) is the value.
 *      Example — Bitwarden Secrets Manager:
 *        ASMLTR_SECRET_CMD='python3 -c "import sys;sys.path.insert(0,\"/opt/scripts\");from get_secret import get_secret;print(get_secret(sys.argv[1]))" {key}'
 *
 * Returns null when a key cannot be resolved. Never throws.
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const execFileP = promisify(execFile);

const cache = new Map();
let fileSecrets;

function loadFileSecrets() {
  if (fileSecrets !== undefined) return fileSecrets;
  fileSecrets = null;
  const p = process.env.ASMLTR_SECRETS_FILE;
  if (p) { try { fileSecrets = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { fileSecrets = null; } }
  return fileSecrets;
}

async function get(key) {
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);
  let val = null;

  // 1) environment (exact, then UPPER_SNAKE)
  const upper = String(key).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  if (process.env[key]) val = process.env[key];
  else if (process.env[upper]) val = process.env[upper];

  // 2) secrets file
  if (val == null) { const f = loadFileSecrets(); if (f && f[key] != null) val = String(f[key]); }

  // 3) command provider (e.g. Bitwarden) — only for well-formed keys
  if (val == null && process.env.ASMLTR_SECRET_CMD && /^[A-Za-z0-9_.-]+$/.test(key)) {
    try {
      const tmpl = process.env.ASMLTR_SECRET_CMD;
      const cmd = tmpl.includes('{key}') ? tmpl.replace(/\{key\}/g, key) : `${tmpl} ${key}`;
      const { stdout } = await execFileP('sh', ['-c', cmd]);
      const out = stdout.trim();
      if (out) val = out;
    } catch (_) { /* leave null */ }
  }

  cache.set(key, val);
  return val;
}

module.exports = { get, clearCache: () => cache.clear() };
