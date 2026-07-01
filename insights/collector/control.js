'use strict';
/**
 * asmltr-insights — control plane (plan §B6). Privileged: SIGTERMs host pids and
 * restarts daemons, so it is gated harder than reads (control token + ideally an
 * admins group at the edge) and every action is audited.
 *
 * Ephemeral sessions (claude -p / interactive) → signal the pid (verified to be
 * a claude/node process first). Persistent daemons (bots/proxy) → NOT a pid kill;
 * docker/pm2 restart from a tight allowlist.
 */

const fs = require('fs');
const { execFile } = require('child_process');

const PM2_DAEMONS = new Set(['eve-query-proxy', 'asmltr-core', 'asmltr-insights-collector']);
const DOCKER_DAEMONS = new Set(['eve-discord-bot', 'eve-messaging']);

function procComm(pid) {
  try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return null; }
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

function makeControl(db) {
  const audit = (a) => db.db.prepare(
    'INSERT INTO control_audit (ts, actor, action, target, result, detail) VALUES (?,?,?,?,?,?)'
  ).run(Date.now(), a.actor || 'unknown', a.action, String(a.target), a.result, a.detail || null);

  const getSession = (id) => db.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(id);

  function kill(session_id, actor, hard) {
    const row = getSession(session_id);
    if (!row) { audit({ actor, action: 'kill', target: session_id, result: 'failure', detail: 'no such session' }); return { ok: false, error: 'no such session' }; }
    if (row.kind === 'persistent') { audit({ actor, action: 'kill', target: session_id, result: 'denied', detail: 'persistent → use restart-daemon' }); return { ok: false, error: 'persistent daemon — use restart-daemon' }; }
    const pid = row.pid;
    const comm = procComm(pid);
    if (!pid || !comm) {
      // No live process (stale, or a core conversation record) — "kill" = forget it.
      db.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(session_id);
      audit({ actor, action: 'kill', target: session_id, result: 'success', detail: 'no live process — forgotten (removed from tracking)' });
      return { ok: true, forgotten: true, message: 'no live process; removed from tracking' };
    }
    if (!/claude|node/.test(comm)) {
      audit({ actor, action: 'kill', target: session_id, result: 'denied', detail: `pid ${pid} comm='${comm}' not claude/node` });
      return { ok: false, error: `refusing: pid ${pid} is '${comm}', not a claude/node process` };
    }
    try { process.kill(pid, 'SIGTERM'); } catch (e) { audit({ actor, action: 'kill', target: session_id, result: 'failure', detail: e.message }); return { ok: false, error: e.message }; }
    // grace then SIGKILL if requested and still alive
    if (hard) setTimeout(() => { if (pidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} } }, 5000);
    audit({ actor, action: 'kill', target: session_id, result: 'success', detail: `SIGTERM pid ${pid} (${comm})` });
    return { ok: true, pid, comm };
  }

  function stop(session_id, actor) {
    const row = getSession(session_id);
    if (!row || !row.pid || !pidAlive(row.pid)) { audit({ actor, action: 'stop', target: session_id, result: 'failure', detail: 'pid not alive' }); return { ok: false, error: 'pid not alive' }; }
    const comm = procComm(row.pid);
    if (!comm || !/claude|node/.test(comm)) { audit({ actor, action: 'stop', target: session_id, result: 'denied', detail: `comm='${comm}'` }); return { ok: false, error: `refusing: pid is '${comm}'` }; }
    try { process.kill(row.pid, 'SIGINT'); } catch (e) { return { ok: false, error: e.message }; }
    audit({ actor, action: 'stop', target: session_id, result: 'success', detail: `SIGINT pid ${row.pid}` });
    return { ok: true, pid: row.pid };
  }

  function diff(session_id, cb) {
    const row = getSession(session_id);
    const wt = row && (row.worktree || row.working_dir);
    if (!wt) return cb(null, { ok: false, error: 'session has no worktree' });
    execFile('git', ['-C', wt, 'diff'], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return cb(null, { ok: false, error: err.message });
      cb(null, { ok: true, worktree: wt, diff: stdout });
    });
  }

  function restartDaemon(target, actor, cb) {
    let cmd, args;
    if (PM2_DAEMONS.has(target)) { cmd = 'pm2'; args = ['restart', target]; }
    else if (DOCKER_DAEMONS.has(target)) { cmd = 'docker'; args = ['restart', target]; }
    else { audit({ actor, action: 'restart-daemon', target, result: 'denied', detail: 'not in allowlist' }); return cb(null, { ok: false, error: 'daemon not in allowlist' }); }
    execFile(cmd, args, (err, stdout, stderr) => {
      const ok = !err;
      audit({ actor, action: 'restart-daemon', target, result: ok ? 'success' : 'failure', detail: ok ? `${cmd} ${args.join(' ')}` : (stderr || err.message) });
      cb(null, ok ? { ok: true, target } : { ok: false, error: stderr || err.message });
    });
  }

  const recentAudit = (limit = 50) => db.db.prepare('SELECT * FROM control_audit ORDER BY ts DESC LIMIT ?').all(limit);

  return { kill, stop, diff, restartDaemon, recentAudit };
}

module.exports = { makeControl };
