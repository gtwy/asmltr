'use strict';
/**
 * asmltr UPDATE SESSION — a standalone agent run that self-updates by following UPDATE-WITH-AGENT.md.
 *
 * Spawned DETACHED (its own process, not asmltr-core) so it SURVIVES the restart it triggers and can
 * verify + roll back. It hands the restart step to scripts/restart-with-rollback.sh (health-check +
 * auto-rollback). It is MONITORABLE (emits events to the collector under a `self-update:<ts>` session,
 * so it appears on the dashboard with a live transcript) and STOPPABLE (polls a kill file that the
 * dashboard Stop button / `POST /v2/abort` writes). It always tears itself down (explicit exit +
 * watchdog) so no update session is ever left hanging.
 */
require('../shared/loadenv');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { query } = require('@anthropic-ai/claude-code');
const { buildEvent } = require('../shared/events');

const REPO = path.join(__dirname, '..');
const KEY = 'self-update:' + Date.now();
const KILL = path.join(os.homedir(), '.asmltr', 'self-update.kill');
const LOG = process.env.ASMLTR_UPDATE_LOG || path.join(os.homedir(), '.asmltr', 'update.log');
const COLLECTOR = process.env.ASMLTR_COLLECTOR_BASE || 'http://127.0.0.1:3017';
const ITOKEN = process.env.ASMLTR_INSIGHTS_TOKEN || '';
const MAX_MS = Math.max(120000, Number(process.env.ASMLTR_UPDATE_MAX_MS || 25 * 60 * 1000));

function log(m) { try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`); } catch (_) {} }
function emit(partial) {
  try {
    const evt = buildEvent({ surface: 'core', source: 'core', session_id: KEY, identity: 'self-update', ...partial });
    const h = { 'Content-Type': 'application/json' }; if (ITOKEN) h.Authorization = 'Bearer ' + ITOKEN;
    fetch(COLLECTOR + '/ingest', { method: 'POST', headers: h, body: JSON.stringify(evt) }).catch(() => {});
  } catch (_) {}
}
function cleanup() { try { if (fs.existsSync(KILL)) fs.unlinkSync(KILL); } catch (_) {} }
function done(code, note) { emit({ event_type: 'session-end', payload: { note } }); cleanup(); log(`update session ${note || 'ended'} (exit ${code})`); process.exit(code); }

async function main() {
  cleanup(); // clear any stale kill flag from a prior run
  const rollback = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD']).toString().trim();
  const doc = fs.readFileSync(path.join(REPO, 'UPDATE-WITH-AGENT.md'), 'utf8');
  log(`update session ${KEY} starting; rollback point = ${rollback.slice(0, 7)}`);

  const ac = new AbortController();
  const killPoll = setInterval(() => { if (fs.existsSync(KILL)) { log('kill requested — aborting update session'); emit({ event_type: 'control', payload: { action: 'aborting' } }); try { ac.abort(); } catch (_) {} } }, 1500);
  const watchdog = setTimeout(() => { log(`watchdog (${Math.round(MAX_MS / 60000)}m) — aborting update session`); try { ac.abort(); } catch (_) {} }, MAX_MS);
  killPoll.unref?.(); watchdog.unref?.();

  emit({ event_type: 'session-start', payload: { channel: 'core', task: 'self-update', working_dir: REPO } });
  emit({ event_type: 'inbound', payload: { text: `Self-update from ${rollback.slice(0, 7)}: pull origin/main, reconcile config, backfill install steps, then restart via restart-with-rollback.sh (auto-rollback on failure).` } });

  const prompt =
    `You are the asmltr UPDATE SESSION, running as your own detached process in ${REPO}. Perform a self-update NOW by following the procedure below exactly.\n` +
    `Pre-update commit (rollback point): ${rollback}\n\n` +
    `CRITICAL — for the restart step, do NOT restart the services yourself. Instead run this and wait for it:\n` +
    `    bash ${path.join(REPO, 'scripts', 'restart-with-rollback.sh')} ${rollback}\n` +
    `It restarts the services detached, health-checks them, and AUTO-ROLLS-BACK to ${rollback} if unhealthy. Report its exit result.\n` +
    `Also do the idempotent install-doc backfills (step 3b): re-link the asmltr skill and ensure the CLI is on PATH.\n\n` +
    `================ UPDATE-WITH-AGENT.md ================\n${doc}`;
  const options = { stream: true, permissionMode: 'bypassPermissions', extraArgs: { 'dangerously-skip-permissions': true }, cwd: REPO, abortController: ac, includePartialMessages: true };

  const response = await query({ prompt, options });
  for await (const ev of response) {
    if (ac.signal.aborted) break;
    if (ev.type === 'assistant') for (const c of ev.message?.content || []) {
      if (c.type === 'text' && c.text) emit({ event_type: 'outbound', payload: { text: c.text.slice(0, 2000) } });
      else if (c.type === 'tool_use') emit({ event_type: 'tool', payload: { tool: c.name, input: JSON.stringify(c.input || {}).slice(0, 2000) } });
      else if (c.type === 'thinking' && c.thinking) emit({ event_type: 'thinking', payload: { text: c.thinking.slice(0, 1500) } });
    } else if (ev.type === 'user') for (const c of ev.message?.content || []) {
      if (c.type === 'tool_result') emit({ event_type: 'tool_result', payload: { output: String(typeof c.content === 'object' ? JSON.stringify(c.content) : c.content).slice(0, 4000) } });
    }
  }
  clearInterval(killPoll); clearTimeout(watchdog);
  done(ac.signal.aborted ? 2 : 0, ac.signal.aborted ? 'aborted' : 'finished');
}
main().catch((e) => { log(`update session ERROR: ${e.message}`); done(1, 'error: ' + e.message); });
// Hard safety net: never let the process linger past the watchdog window even if something wedges.
setTimeout(() => { log('hard exit (safety timeout)'); cleanup(); process.exit(1); }, MAX_MS + 60000).unref?.();
