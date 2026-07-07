#!/usr/bin/env node
'use strict';
/**
 * asmltr — terminal client + TUI (plan §B9).
 *
 * Read-only commands (Phase 1) consume the live collector API. Runs host-local;
 * uses the control token from env when present. The `attach` cross-channel
 * takeover (claim → resume in tmux) lands with the control plane in Phase 4.
 *
 *   asmltr            live TUI dashboard (sessions + event log + cpu)
 *   asmltr ls         list active sessions
 *   asmltr brief      compact summary (the morning-brief JSON, rendered)
 *   asmltr events     recent events (--surface S --identity I --limit N)
 *   asmltr tail       live global event stream
 *   asmltr watch KEY  live event stream for one session
 *   asmltr system     current system metrics
 *   asmltr help
 */

const { spawnSync, execFileSync } = require('child_process');
const os = require('os');

const BASE = process.env.ASMLTR_COLLECTOR_BASE || 'http://127.0.0.1:3017';
const CORE_BASE = process.env.ASMLTR_CORE_BASE || 'http://127.0.0.1:3023';
const MANAGER_BASE = process.env.ASMLTR_MANAGER_BASE || 'http://127.0.0.1:3024';
const MANAGER_TOKEN = process.env.ASMLTR_MANAGER_TOKEN || '';
const TOKEN = process.env.ASMLTR_INSIGHTS_TOKEN || '';
const CONTROL_TOKEN = process.env.ASMLTR_INSIGHTS_CONTROL_TOKEN || '';
const authHeaders = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
const controlHeaders = CONTROL_TOKEN ? { Authorization: `Bearer ${CONTROL_TOKEN}` } : {};
const ACTOR = `cli:${os.userInfo().username}@${(process.env.SSH_TTY || process.env.STY || 'local').split('/').pop()}`;

// --- tiny ansi helpers -------------------------------------------------------
const A = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  grn: (s) => `\x1b[32m${s}\x1b[0m`,
  yel: (s) => `\x1b[33m${s}\x1b[0m`,
  cyn: (s) => `\x1b[36m${s}\x1b[0m`,
  mag: (s) => `\x1b[35m${s}\x1b[0m`,
};
const SURFACE_COLOR = {
  discord: A.mag, telegram: A.cyn, github: A.grn, mcp: A.yel,
  'eve-assistant-web': A.cyn, 'eve-assistant-native': A.cyn, 'claude-code': A.bold, core: A.bold, system: A.dim,
};
const paint = (surface, s) => (SURFACE_COLOR[surface] || ((x) => x))(s);

async function api(path) {
  const res = await fetch(BASE + path, { headers: authHeaders });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
  return res.json();
}
async function coreApi(path, method = 'GET', body) {
  const res = await fetch(CORE_BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `${res.status} — ${path}`);
  return j;
}
async function controlApi(path, method = 'POST', body) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...controlHeaders }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `${res.status} — ${path}`);
  return j;
}
const tmuxName = (key) => 'asmltr-' + key.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 60);
function tmuxHasSession(name) {
  try { execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' }); return true; } catch { return false; }
}

function ageOf(unixMs) {
  if (!unixMs) return '?';
  const s = Math.max(0, Math.floor((Date.now() - unixMs) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
function parsePayload(p) { try { return typeof p === 'string' ? JSON.parse(p) : (p || {}); } catch { return {}; } }
function pad(s, n) { s = String(s == null ? '' : s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }

// --- flag parsing (--key val) ------------------------------------------------
function flags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { f[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return f;
}

// --- commands ----------------------------------------------------------------
async function cmdLs() {
  const { sessions } = await api('/api/sessions?active=1');
  if (!sessions.length) return console.log(A.dim('no active sessions'));
  console.log(A.bold(pad('SURFACE', 10) + pad('KIND', 11) + pad('AGE', 6) + pad('IDLE', 6) + pad('TOK', 8) + pad('MUX', 7) + 'TASK / KEY'));
  for (const s of sessions) {
    const line = pad(s.surface, 10) + pad(s.kind, 11) + pad(ageOf(s.started_unix), 6) +
      pad(ageOf(s.last_activity_unix), 6) + pad(s.tokens_total || 0, 8) + pad(s.multiplexer || 'none', 7) +
      (s.task ? String(s.task).slice(0, 50) : s.session_id);
    console.log(paint(s.surface, line));
  }
  console.log(A.dim(`\n${sessions.length} active`));
}

async function cmdBrief() {
  const b = await api('/api/brief');
  console.log(A.bold('asmltr brief'));
  console.log(`  active sessions : ${A.grn(b.active_sessions)}`);
  console.log(`  tokens (24h)    : ${b.tokens_24h}`);
  const bys = b.tokens_by_surface_24h || {};
  for (const [surf, tok] of Object.entries(bys)) console.log(`    ${pad(surf, 22)} ${tok}`);
  if (b.sessions && b.sessions.length) {
    console.log(A.bold('\n  active:'));
    for (const s of b.sessions) console.log(`    ${paint(s.surface, pad(s.surface, 10))} ${A.dim(s.kind)} ${s.task ? String(s.task).slice(0, 60) : s.id}`);
  }
}

async function cmdEvents(f) {
  const qs = new URLSearchParams();
  if (f.surface) qs.set('surface', f.surface);
  if (f.identity) qs.set('identity', f.identity);
  if (f.session) qs.set('session', f.session);
  qs.set('limit', f.limit || '40');
  const { events } = await api('/api/events?' + qs.toString());
  for (const e of events.reverse()) printEvent(e);
  console.log(A.dim(`\n${events.length} events`));
}

function printEvent(e) {
  const t = new Date(e.ts).toISOString().slice(11, 19);
  const pl = parsePayload(e.payload);
  const detail = pl.text || pl.decision || pl.tool || (pl.chars != null ? `${pl.chars} chars` : '') || '';
  const tok = (e.tokens_in || e.tokens_out) ? A.dim(` ${e.tokens_in}/${e.tokens_out}`) : '';
  console.log(`${A.dim(t)} ${paint(e.surface, pad(e.surface, 9))} ${pad(e.event_type, 19)} ${A.dim(pad(e.identity || '-', 12))} ${String(detail).slice(0, 60)}${tok}`);
}

async function cmdSystem() {
  const { samples } = await api('/api/system?since=' + (Date.now() - 600000));
  if (!samples.length) return console.log(A.dim('no samples yet'));
  const s = samples[0];
  console.log(A.bold('system') + A.dim(`  (${ageOf(s.ts)} ago)`));
  console.log(`  cpu   : ${s.cpu_pct}%   load ${s.load1}/${s.load5}`);
  console.log(`  mem   : ${s.mem_used_mb}/${s.mem_total_mb} MB`);
  console.log(`  disk  : ${s.disk_used_pct}% used, ${s.disk_free_gb} GB free`);
}

async function liveStream(filterKey) {
  let io;
  try { io = require('socket.io-client'); }
  catch { console.error('socket.io-client not installed — run: cd ' + __dirname + ' && npm install'); process.exit(1); }
  console.log(A.dim(`connecting to ${BASE} …${filterKey ? ' (session ' + filterKey + ')' : ''}  [Ctrl-C to quit]`));
  const socket = io(BASE, { transports: ['websocket', 'polling'], auth: TOKEN ? { token: TOKEN } : {} });
  socket.on('connect', () => console.log(A.grn('connected')));
  socket.on('event', (e) => { if (!filterKey || e.session_id === filterKey) printEvent(e); });
  socket.on('disconnect', () => console.log(A.red('disconnected')));
}

// --- control / takeover ------------------------------------------------------
async function cmdAttach(key, f) {
  if (!key) throw new Error('usage: asmltr attach <conversation_key>');
  const claim = await coreApi('/v2/claim', 'POST', { conversation_key: key, by: ACTOR });
  console.log(A.grn('claimed') + A.dim(` — channel paused; engine=${claim.engine_session_id.slice(0, 8)} cwd=${claim.working_dir}`));
  const name = tmuxName(key);
  if (!tmuxHasSession(name)) {
    // Strip nested-Claude env so `claude` can spawn inside tmux.
    const env = { ...process.env, IS_SANDBOX: 'true' };
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
    const r = spawnSync('tmux', ['new-session', '-d', '-s', name, '-c', claim.working_dir, `claude --resume ${claim.engine_session_id}`], { env });
    if (r.status !== 0) { await coreApi('/v2/release', 'POST', { conversation_key: key }); throw new Error('tmux new-session failed: ' + (r.stderr || '')); }
    console.log(A.dim(`tmux session '${name}' created (claude --resume)`));
  }
  if (process.stdin.isTTY && process.stdout.isTTY) {
    spawnSync('tmux', ['attach', '-t', name], { stdio: 'inherit' });
    // Returned: either detached (session still alive) or claude exited (gone).
    if (tmuxHasSession(name)) {
      console.log(A.yel(`detached — session '${name}' still running. re-attach: asmltr attach ${key}  ·  end: asmltr release ${key}`));
      if (!f.keep) console.log(A.dim('(channel stays paused until you `asmltr release` or the session ends)'));
    } else {
      await coreApi('/v2/release', 'POST', { conversation_key: key });
      console.log(A.grn('session ended — channel released'));
    }
  } else {
    console.log(A.yel(`no TTY — session created. Attach with: `) + A.bold(`tmux attach -t ${name}`));
    console.log(A.dim(`when done: asmltr release ${key}`));
  }
}

async function cmdRelease(key) {
  if (!key) throw new Error('usage: asmltr release <conversation_key>');
  const name = tmuxName(key);
  if (tmuxHasSession(name)) { try { execFileSync('tmux', ['kill-session', '-t', name]); console.log(A.dim(`killed tmux '${name}'`)); } catch {} }
  await coreApi('/v2/release', 'POST', { conversation_key: key });
  console.log(A.grn('released — channel resumes'));
}

async function cmdSend(rest) {
  // asmltr send <channel> <target> <text…> — deliver a message OUT through any connector.
  const channel = rest[0], target = rest[1], text = rest.slice(2).join(' ');
  if (!channel || !target || !text) {
    throw new Error('usage: asmltr send <channel> <target> "<text>"\n' +
      '  e.g.  asmltr send telegram 123456 "heads up"   ·   asmltr send discord TD-TSD-main "shipping now"');
  }
  const headers = { 'Content-Type': 'application/json' };
  if (MANAGER_TOKEN) headers.Authorization = 'Bearer ' + MANAGER_TOKEN;
  const r = await fetch(MANAGER_BASE + '/send', { method: 'POST', headers, body: JSON.stringify({ channel, target, kind: 'text', text }) })
    .then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
  console.log(r.ok ? A.grn(`✓ sent to ${channel}:${target}${r.via ? ' (' + r.via + ')' : ''}`) : A.red('send failed: ' + (r.error || JSON.stringify(r))));
}
async function cmdKill(id, f) {
  if (!id) throw new Error('usage: asmltr kill <session_id> [--hard]');
  const r = await controlApi('/api/control/kill', 'POST', { session_id: id, hard: !!f.hard });
  console.log(r.ok ? A.grn(`killed ${id} (pid ${r.pid}, ${r.comm})`) : A.red('kill failed: ' + r.error));
}
async function cmdStop(id) {
  if (!id) throw new Error('usage: asmltr stop <session_id>');
  const r = await controlApi('/api/control/stop', 'POST', { session_id: id });
  console.log(r.ok ? A.grn(`SIGINT sent to ${id} (pid ${r.pid})`) : A.red('stop failed: ' + r.error));
}
async function cmdDiff(id) {
  if (!id) throw new Error('usage: asmltr diff <session_id>');
  const r = await fetch(BASE + '/api/control/diff?session_id=' + encodeURIComponent(id), { headers: controlHeaders }).then((x) => x.json());
  if (!r.ok) return console.log(A.red('diff: ' + r.error));
  console.log(A.dim(`# ${r.worktree}`)); console.log(r.diff || A.dim('(no changes)'));
}

function cmdHelp() {
  console.log(`${A.bold('asmltr')} — asmltr insights terminal client

  asmltr                 live TUI dashboard
  asmltr ls              list active sessions
  asmltr brief           compact summary
  asmltr events [..]     recent events  (--surface --identity --session --limit)
  asmltr tail            live global event stream
  asmltr watch <key>     live stream for one session
  asmltr system          current system metrics
  ${A.bold('cross-channel:')}
  asmltr send <ch> <target> "<text>"   deliver a message OUT through any connector
                                       (e.g. send telegram 123 "hi" · send discord alias "yo")
  ${A.bold('control / takeover:')}
  asmltr attach <key>    claim a channel session + resume it in tmux (attach/detach)
  asmltr release <key>   end a takeover; channel resumes
  asmltr kill <id>       SIGTERM an ephemeral session's pid (--hard = SIGKILL after grace)
  asmltr stop <id>       SIGINT an ephemeral session
  asmltr diff <id>       git diff of a session's worktree
  asmltr help

  collector: ${BASE}   core: ${CORE_BASE}   ${TOKEN ? '(token set)' : A.dim('(no token — dev mode)')}`);
}

// --- main --------------------------------------------------------------------
(async () => {
  const [, , cmd, ...rest] = process.argv;
  const f = flags(rest);
  try {
    switch (cmd) {
      case undefined:
      case 'top': return require('./tui').run(BASE, CORE_BASE, TOKEN, A, { base: MANAGER_BASE, token: MANAGER_TOKEN });
      case 'claude': { // launch an interactive claude session wrapped for monitoring + takeover
        const r = spawnSync(process.execPath, [require('path').join(__dirname, 'asmltr-claude.js'), ...rest], { stdio: 'inherit' });
        return process.exit(r.status || 0);
      }
      case 'ls': return await cmdLs();
      case 'brief': return await cmdBrief();
      case 'events': return await cmdEvents(f);
      case 'system': return await cmdSystem();
      case 'tail': return liveStream(null);
      case 'watch': return liveStream(rest[0]);
      case 'send': return await cmdSend(rest);
      case 'attach': return await cmdAttach(rest[0], f);
      case 'release': return await cmdRelease(rest[0]);
      case 'kill': return await cmdKill(rest[0], f);
      case 'stop': return await cmdStop(rest[0]);
      case 'diff': return await cmdDiff(rest[0]);
      case 'help': case '--help': case '-h': return cmdHelp();
      default: console.error(`unknown command: ${cmd}\n`); return cmdHelp();
    }
  } catch (err) {
    console.error(A.red('error: ') + err.message);
    if (/ECONNREFUSED|fetch failed/.test(err.message)) console.error(A.dim(`is the collector running? (${BASE})`));
    process.exit(1);
  }
})();
