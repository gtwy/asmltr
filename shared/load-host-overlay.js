'use strict';
/**
 * Thin hook so a host overlay directory can wrap public modules.
 * Default: ~/.asmltr/ivy-local/overlay. Override: ASMLTR_OVERLAY_DIR.
 * Missing overlay is a no-op (public product). Does not invent connectors.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function overlayDir() {
  const env = String(process.env.ASMLTR_OVERLAY_DIR || '').trim();
  if (env) return env;
  return path.join(os.homedir(), '.asmltr', 'ivy-local', 'overlay');
}

function load(name) {
  const base = String(name || '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (!base) return null;
  const file = base.endsWith('.js') ? base : base + '.js';
  const p = path.join(overlayDir(), file);
  try {
    if (!fs.existsSync(p)) return null;
    return require(p);
  } catch (_) {
    return null;
  }
}

module.exports = { overlayDir, load };
