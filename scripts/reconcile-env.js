'use strict';
/**
 * Reconcile .env against .env.example — surface config keys that were ADDED to .env.example SINCE the
 * last update (not every optional key), as COMMENTED placeholders appended to .env, so a newly
 * introduced option is visible to the operator instead of silently missing. Never changes/uncomments
 * existing values. Recurring: the updater runs this every update.
 *
 * How "new since last update" works: a baseline snapshot of example keys lives in
 * ~/.asmltr/env-example-keys.json. First run establishes the baseline SILENTLY (an existing install
 * was already configured against the current example — nothing to offer). Later runs diff the current
 * example keys against the baseline and only surface the genuinely-new ones the live .env lacks.
 *
 * Usage: node scripts/reconcile-env.js           → mutate .env with new keys, advance the baseline
 *        node scripts/reconcile-env.js --check    → report new keys (exit 1 if any), no mutation
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = process.env.ASMLTR_REPO || path.join(__dirname, '..');
const envPath = path.join(REPO, '.env');
const examplePath = path.join(REPO, '.env.example');
const STATE = process.env.ASMLTR_ENV_KEYS_STATE || path.join(os.homedir(), '.asmltr', 'env-example-keys.json');
const check = process.argv.includes('--check');

const keyOf = (line) => { const m = /^\s*#?\s*([A-Za-z_][A-Za-z0-9_]*)=/.exec(line); return m ? m[1] : null; };
const readState = () => { try { return new Set(JSON.parse(fs.readFileSync(STATE, 'utf8'))); } catch (_) { return null; } };
const writeState = (keys) => { try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify([...keys])); } catch (_) {} };

function main() {
  if (!fs.existsSync(examplePath)) { console.error('no .env.example — nothing to reconcile'); return 0; }

  // key → its canonical example line
  const exampleLines = fs.readFileSync(examplePath, 'utf8').split('\n');
  const lineFor = new Map();
  const currentKeys = new Set();
  for (const line of exampleLines) { const k = keyOf(line); if (k && !currentKeys.has(k)) { currentKeys.add(k); lineFor.set(k, line.trim()); } }

  const baseline = readState();
  if (baseline === null) {
    if (!check) writeState(currentKeys);
    console.error(`established .env.example baseline (${currentKeys.size} keys) — no changes`);
    return 0;
  }

  const newKeys = [...currentKeys].filter((k) => !baseline.has(k));
  const haveInEnv = fs.existsSync(envPath)
    ? new Set(fs.readFileSync(envPath, 'utf8').split('\n').map(keyOf).filter(Boolean))
    : new Set();
  const toAdd = newKeys.filter((k) => !haveInEnv.has(k));

  if (check) {
    if (toAdd.length) { console.error(`new .env.example key(s) since last update: ${toAdd.join(', ')}`); return 1; }
    console.error('no new .env.example keys since last update'); return 0;
  }

  if (toAdd.length && fs.existsSync(envPath)) {
    const stamp = new Date().toISOString().slice(0, 10);
    const block = toAdd.map((k) => { const l = lineFor.get(k); return /^\s*#/.test(l) ? l : '# ' + l; });
    fs.appendFileSync(envPath, `\n# --- new keys from .env.example (${stamp}); review + fill if needed ---\n${block.join('\n')}\n`);
    console.error(`added ${toAdd.length} new key(s) to .env (commented): ${toAdd.join(', ')}`);
  } else {
    console.error(toAdd.length ? 'new keys detected but no .env to write' : 'no new keys since last update');
  }
  writeState(currentKeys); // advance baseline so these aren't re-offered
  return 0;
}

process.exit(main());
