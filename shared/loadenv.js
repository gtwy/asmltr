'use strict';
/**
 * Zero-dependency .env loader. Reads $ASMLTR_ENV_FILE (or <repo-root>/.env) and
 * populates any key NOT already present in process.env (so real env / PM2 env win).
 * Require this FIRST in every entrypoint: `require('../../shared/loadenv');`
 * Idempotent and silent if no file exists.
 */
const fs = require('fs');
const path = require('path');

const file = process.env.ASMLTR_ENV_FILE || path.join(__dirname, '..', '.env');
try {
  const txt = fs.readFileSync(file, 'utf8');
  for (let line of txt.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
} catch (_) { /* no .env — fine, rely on real environment */ }

module.exports = {};
