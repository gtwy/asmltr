#!/usr/bin/env node
'use strict';
/**
 * Backfill pre-existing `screen` Claude sessions into asmltr's tracker so they appear in the
 * dashboard as claude-code sessions.
 *
 * Context: sessions started OUTSIDE `asmltr claude` (e.g. an older launcher that ran `claude` inside
 * a detached screen) aren't registered with the collector, so the dashboard never sees them. The
 * collector already mirrors a screen-oriented tracker file (env ASMLTR_TRACKER_PATH, defaults to
 * multiplexer:'screen'); this script scans live screen sockets, finds the ones running a claude
 * process, and writes/merges an entry per session into that tracker file. The collector's reconcile
 * loop then mirrors them in — and its liveness check flips each to 'ended' automatically once the
 * underlying process exits. Safe to re-run (merges by session_id).
 *
 * Usage:  node scripts/backfill-screen-sessions.js [tracker-path]
 *   tracker-path defaults to $ASMLTR_TRACKER_PATH, else ~/.asmltr/screen-sessions.json
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OUT = process.argv[2] || process.env.ASMLTR_TRACKER_PATH || path.join(process.env.HOME || '/root', '.asmltr', 'screen-sessions.json');
const IDENTITY = process.env.ASMLTR_TRACKER_IDENTITY || 'root';

function sh(cmd) { try { return execSync(cmd, { encoding: 'utf8' }); } catch { return ''; } }

// 1) live screen sockets → { pid, name, full }.  `screen -ls` lines look like: "\t15396.claude-main\t(date)\t(Attached)"
const screens = [];
for (const line of sh('screen -ls').split('\n')) {
  const m = line.match(/\s(\d+)\.(\S+)\s/);
  if (m) screens.push({ pid: Number(m[1]), name: m[2], full: `${m[1]}.${m[2]}` });
}

// 2) build the full process tree once (pid -> children) to find each screen's claude descendant
const rows = sh('ps -eo pid=,ppid=,comm=').trim().split('\n').map((l) => {
  const t = l.trim().split(/\s+/);
  return { pid: Number(t[0]), ppid: Number(t[1]), comm: t.slice(2).join(' ') };
});
const childrenOf = {};
for (const r of rows) (childrenOf[r.ppid] = childrenOf[r.ppid] || []).push(r);
function claudePidUnder(pid) {
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop();
    for (const c of (childrenOf[p] || [])) {
      if (c.comm === 'claude' || c.comm === 'node') return c.pid; // the interactive claude (or node shim)
      stack.push(c.pid);
    }
  }
  return null;
}
function startUnix(pid) { const s = sh(`ps -o lstart= -p ${pid}`).trim(); const t = s ? Date.parse(s) : NaN; return Number.isNaN(t) ? null : Math.floor(t / 1000); }
function cwdOf(pid) { try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; } }

// 3) one tracker entry per screen session that is actually running claude (skip asmltr's own wrapper)
const found = [];
for (const s of screens) {
  if (/^asmltr-cli-/.test(s.name)) continue; // already tracked via the asmltr claude wrapper
  const cpid = claudePidUnder(s.pid);
  if (!cpid) continue;                        // not a claude session
  const started = startUnix(cpid) || startUnix(s.pid);
  found.push({
    session_id: s.name, // the full screen session name — same id the claude-code hook derives from $STY, so they unify
    surface: 'claude-code',
    kind: 'ephemeral',
    identity: IDENTITY,
    pid: cpid,
    current_pid: cpid,
    working_dir: cwdOf(cpid),
    cwd: cwdOf(cpid),
    task: `claude — ${s.name}`,
    multiplexer: 'screen',
    tmux_target: s.full,        // `screen -x <full>` attaches
    started_unix: started,
    last_activity_unix: started,
    tool_count: 0,
    status: 'active',
  });
}

// 4) merge into the tracker file (don't clobber unrelated entries), keyed by session_id
let existing = [];
try { const j = JSON.parse(fs.readFileSync(OUT, 'utf8')); if (Array.isArray(j.sessions)) existing = j.sessions; } catch (_) {}
const byId = new Map(existing.map((e) => [String(e.session_id), e]));
for (const e of found) byId.set(String(e.session_id), e);
const sessions = [...byId.values()];

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ sessions, generated_at: new Date().toISOString() }, null, 2));

console.log(`Backfilled ${found.length} live screen claude session(s) → ${OUT}`);
for (const e of found) console.log(`  • ${e.session_id.padEnd(16)} pid ${String(e.pid).padEnd(8)} ${e.tmux_target}  (${e.working_dir || '?'})`);
if (!found.length) console.log('  (no non-asmltr screen sessions running claude were found)');
