'use strict';
/**
 * asmltr-insights — session reconciler (plan §B3).
 *
 * /tmp/eve-sessions-enhanced.json stays the SOURCE OF TRUTH for Claude Code
 * session liveness (driven by the existing hooks, read by the morning brief).
 * We MIRROR it into the sessions table — never write back — and apply a
 * LIVENESS CORRECTION: if a row says status=active but its pid is dead, we
 * record it as ended. That's what makes the dashboard's instance count honest
 * (the file is known to carry stale-active entries).
 */

const fs = require('fs');

// Optional integration: a host session-tracker JSON to mirror. Unset → skipped.
const TRACKER_PATH = process.env.ASMLTR_TRACKER_PATH || '';

/** Is this pid alive? signal 0 = existence check. */
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; } // EPERM => exists but not ours
}

/** Run one reconcile pass. Returns the number of rows upserted. */
function reconcileOnce(db) {
  let raw;
  try { raw = fs.readFileSync(TRACKER_PATH, 'utf8'); }
  catch (_) { return 0; } // tracker file absent → nothing to mirror yet
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (_) { return 0; }

  const list = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  let n = 0;
  for (const s of list) {
    const pid = s.current_pid || s.pid || null;
    let status = s.status || 'active';
    // LIVENESS CORRECTION
    if (status === 'active' && !pidAlive(pid)) status = 'ended';

    db.reconcileUpsert({
      sid: String(s.session_id),
      surface: 'claude-code',
      kind: 'ephemeral',
      pid: pid || null,
      identity: 'eve',
      context: s.context || null,
      working_dir: s.working_dir || null,
      task: s.task || null,
      status,
      started_unix: s.started_unix ? s.started_unix * (s.started_unix < 1e12 ? 1000 : 1) : null,
      last_activity_unix: s.last_activity_unix ? s.last_activity_unix * (s.last_activity_unix < 1e12 ? 1000 : 1) : null,
      tool_count: s.tool_count || 0,
      multiplexer: 'screen', // CC sessions live in screen (tracked via $STY)
      now: Date.now(),
    });
    n++;
  }
  return n;
}

/** Start periodic reconciliation. Returns a stop() function. */
function start(db, intervalMs, onPass) {
  const tick = () => {
    try {
      const n = reconcileOnce(db);
      if (onPass) onPass(n);
    } catch (err) {
      console.error('[reconcile] pass failed:', err.message);
    }
  };
  tick();
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}

module.exports = { reconcileOnce, start, pidAlive, TRACKER_PATH };
