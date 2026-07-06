#!/usr/bin/env node
'use strict';
/**
 * claude-tailer — streams one interactive `claude` session's transcript into the asmltr
 * collector as events, so the dashboard shows its live conversation/tool history.
 *
 *   node claude-tailer.js <session_id> <cwd> <tmux_target> <launchTsMs>
 *
 * Spawned detached by `asmltr claude`. It discovers the session's ~/.claude/projects
 * jsonl (newest transcript created after launch), tails it, maps each turn to an event
 * (inbound / thinking / tool / tool_result / outbound), and POSTs to the collector
 * /ingest. It exits when the tmux session goes away (emitting session-end).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
try { require('../../shared/loadenv'); } catch (_) {}

const [SESSION_ID, CWD, TMUX_TARGET, LAUNCH_TS_S] = process.argv.slice(2);
const LAUNCH_TS = Number(LAUNCH_TS_S) || Date.now();
const BASE = process.env.ASMLTR_COLLECTOR_BASE || 'http://127.0.0.1:3017';
const TOKEN = process.env.ASMLTR_INSIGHTS_TOKEN || '';
const IDENTITY = process.env.ASMLTR_CLI_IDENTITY || (os.userInfo().username || 'cli');
const TRACKER = process.env.ASMLTR_CLI_TRACKER_PATH || path.join(os.homedir(), '.asmltr', 'cli-sessions.json');
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

let toolCount = 0;

async function ingest(events) {
  if (!events.length) return;
  try {
    await fetch(BASE + '/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) },
      body: JSON.stringify(events),
    });
  } catch (_) { /* collector may be down; drop */ }
}
function ev(event_type, payload) {
  return { v: 1, surface: 'claude-code', session_id: SESSION_ID, identity: IDENTITY, event_type, cost_usd: 0, payload, source: 'cli-tailer' };
}
function tmuxAlive() { return spawnSync('tmux', ['has-session', '-t', TMUX_TARGET], { stdio: 'ignore' }).status === 0; }
function touchTracker(patch) {
  try {
    const t = JSON.parse(fs.readFileSync(TRACKER, 'utf8'));
    const s = t.sessions.find((x) => x.session_id === SESSION_ID);
    if (s) { Object.assign(s, patch); fs.writeFileSync(TRACKER, JSON.stringify(t)); }
  } catch (_) {}
}

// Map one transcript JSON line to zero or more events.
function lineToEvents(line) {
  let o; try { o = JSON.parse(line); } catch { return []; }
  const out = [];
  const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '');
  if (o.type === 'user' && o.message) {
    const c = o.message.content;
    if (typeof c === 'string') { if (c.trim()) out.push(ev('inbound', { text: c })); }
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text' && b.text) out.push(ev('inbound', { text: b.text }));
        else if (b.type === 'tool_result') out.push(ev('tool_result', { output: typeof b.content === 'string' ? b.content : JSON.stringify(b.content), is_error: !!b.is_error }));
      }
    }
  } else if (o.type === 'assistant' && o.message) {
    const c = o.message.content;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text' && b.text) out.push(ev('outbound', { text: b.text }));
        else if (b.type === 'thinking' && b.thinking) out.push(ev('thinking', { text: b.thinking }));
        else if (b.type === 'tool_use') { toolCount++; out.push(ev('tool', { tool: b.name, input: b.input })); }
      }
    } else if (typeof c === 'string' && c.trim()) out.push(ev('outbound', { text: c }));
    const u = o.message.usage;
    if (u && (u.input_tokens || u.output_tokens)) out.push({ ...ev('token-usage', { tools: toolCount }), tokens_in: u.input_tokens || 0, tokens_out: u.output_tokens || 0 });
  }
  return out;
}

function findTranscript() {
  let best = null, bestM = 0;
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS).map((d) => path.join(PROJECTS, d)); } catch { return null; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const fp = path.join(d, f);
      let m; try { m = fs.statSync(fp).mtimeMs; } catch { continue; }
      if (m >= LAUNCH_TS - 5000 && m > bestM) { bestM = m; best = fp; }
    }
  }
  return best;
}

async function main() {
  await ingest([ev('session-start', { cwd: CWD })]);
  // 1. discover the transcript (poll up to ~45s)
  let file = null;
  for (let i = 0; i < 60 && !file; i++) {
    file = findTranscript();
    if (!file) { if (!tmuxAlive()) return; await sleep(750); }
  }
  if (!file) { touchTracker({ status: 'ended' }); return; }

  // 2. tail it
  let offset = 0, buf = '';
  let gone = 0;
  for (;;) {
    let size = 0; try { size = fs.statSync(file).size; } catch {}
    if (size > offset) {
      const fd = fs.openSync(file, 'r');
      const len = size - offset;
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, offset);
      fs.closeSync(fd);
      offset = size;
      buf += b.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop(); // keep partial
      const events = [];
      for (const ln of lines) { if (ln.trim()) events.push(...lineToEvents(ln)); }
      if (events.length) {
        await ingest(events);
        touchTracker({ last_activity_unix: Math.floor(Date.now() / 1000), tool_count: toolCount });
      }
    }
    if (!tmuxAlive()) { if (++gone >= 2) break; } else gone = 0;
    await sleep(800);
  }
  await ingest([ev('session-end', {})]);
  touchTracker({ status: 'ended', last_activity_unix: Math.floor(Date.now() / 1000) });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
main().catch(() => {});
