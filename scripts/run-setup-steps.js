'use strict';
/**
 * asmltr setup-step runner — the deterministic, self-healing replacement for "have the agent re-read
 * INSTALL-WITH-AGENT.md and run whatever new steps it finds".
 *
 * `setup.d/` holds numbered, idempotent steps (NNN-name.sh | NNN-name.js). Each step is run at most
 * once per install (tracked in an applied-ledger); adding a newly-required install step → every
 * install, however bespoke, picks it up on its next update. Steps MUST be idempotent (check-then-act)
 * because a step can be re-run with --force and because the ledger can be wiped.
 *
 * Step exit codes: 0 = applied (recorded), 75 (EX_TEMPFAIL) = "not applicable here, skip without
 * recording as done" (so it's retried next time), anything else = failed (logged, NOT recorded, does
 * not abort the run — setup is best-effort environment wiring; the updater does not roll back on it).
 *
 * Usage: node scripts/run-setup-steps.js [--dry-run] [--force] [--json]
 * Programmatic: require('./run-setup-steps').runSetupSteps({ dryRun, force, log })
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const STEPS_DIR = path.join(REPO, 'setup.d');
const LEDGER = process.env.ASMLTR_SETUP_LEDGER || path.join(os.homedir(), '.asmltr', 'applied-steps.json');
const SKIP = 75; // EX_TEMPFAIL — "not applicable, don't record, retry later"

function readLedger() { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')) || {}; } catch (_) { return {}; } }
function writeLedger(l) { try { fs.mkdirSync(path.dirname(LEDGER), { recursive: true }); fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2)); } catch (_) {} }

function listSteps() {
  let files = [];
  try { files = fs.readdirSync(STEPS_DIR); } catch (_) { return []; }
  return files
    .filter((f) => /^\d+.*\.(sh|js)$/.test(f) && !f.startsWith('.'))
    .sort(); // numeric prefix → lexical sort is correct for zero-padded ids
}

function runOne(file) {
  const full = path.join(STEPS_DIR, file);
  const isJs = file.endsWith('.js');
  const cmd = isJs ? process.execPath : 'bash';
  const r = spawnSync(cmd, [full], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ASMLTR_REPO: REPO },
    timeout: 120000,
  });
  const out = (r.stdout ? r.stdout.toString() : '') + (r.stderr ? r.stderr.toString() : '');
  return { code: r.status == null ? 1 : r.status, out: out.trim() };
}

function runSetupSteps({ dryRun = false, force = false, log = () => {} } = {}) {
  const ledger = readLedger();
  const steps = listSteps();
  const result = { total: steps.length, applied: [], skipped: [], failed: [], alreadyDone: [] };
  for (const file of steps) {
    if (!force && ledger[file] && ledger[file].ok) { result.alreadyDone.push(file); continue; }
    if (dryRun) { log(`would run: ${file}`); result.applied.push(file); continue; }
    const { code, out } = runOne(file);
    if (code === 0) {
      ledger[file] = { ok: true, at: Date.now() };
      result.applied.push(file);
      log(`✓ ${file}${out ? ' — ' + out.split('\n').pop() : ''}`);
    } else if (code === SKIP) {
      result.skipped.push(file);
      log(`· ${file} — not applicable here (skip)`);
    } else {
      result.failed.push({ file, code, out });
      log(`✗ ${file} (exit ${code})${out ? ' — ' + out.split('\n').pop() : ''}`);
    }
  }
  if (!dryRun) writeLedger(ledger);
  return result;
}

module.exports = { runSetupSteps, LEDGER, STEPS_DIR };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opts = { dryRun: argv.includes('--dry-run'), force: argv.includes('--force') };
  const res = runSetupSteps({ ...opts, log: (m) => console.error(m) });
  if (argv.includes('--json')) console.log(JSON.stringify(res, null, 2));
  else console.error(`setup: ${res.applied.length} applied, ${res.alreadyDone.length} already done, ${res.skipped.length} skipped, ${res.failed.length} failed`);
  process.exit(res.failed.length ? 1 : 0);
}
