'use strict';
/**
 * asmltr TUI dashboard (plan §B9) — blessed-contrib cockpit.
 * Dashboard: active sessions table + CPU line + global event log.
 * Press ENTER on a selected session → live WATCH view for that session
 * (its own event stream); ESC returns to the dashboard.
 */

function run(BASE, CORE_BASE, TOKEN, A) {
  let blessed, contrib, io;
  try {
    blessed = require('blessed');
    contrib = require('blessed-contrib');
    io = require('socket.io-client');
  } catch (e) {
    console.error('TUI deps missing — run: cd ' + __dirname + ' && npm install');
    process.exit(1);
  }
  const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
  const CONTROL_TOKEN = process.env.ASMLTR_INSIGHTS_CONTROL_TOKEN || '';
  function ctlHeaders() { const h = { 'Content-Type': 'application/json' }; const tk = CONTROL_TOKEN || TOKEN; if (tk) h.Authorization = 'Bearer ' + tk; return h; }

  // alacritty's terminfo carries label caps (e.g. plab_norm) that blessed's
  // terminfo compiler mis-parses and dumps to stderr as "Error on alacritty.<cap>".
  // xterm-256color renders this dashboard identically and compiles clean, so map
  // alacritty onto it; every other TERM is left untouched.
  const term = /alacritty/.test(process.env.TERM || '') ? 'xterm-256color' : undefined;
  const screen = blessed.screen({ smartCSR: true, title: 'asmltr', terminal: term });
  const grid = new contrib.grid({ rows: 12, cols: 12, screen });

  const sessTable = grid.set(0, 0, 8, 8, contrib.table, {
    keys: true, label: ' active sessions  (↑↓ select · ENTER watch · k kill · q quit) ', interactive: true,
    columnSpacing: 2, columnWidth: [14, 11, 6, 7, 8, 6],
    border: { type: 'line' }, fg: 'white', selectedFg: 'black', selectedBg: 'magenta',
  });
  const cpuLine = grid.set(0, 8, 8, 4, contrib.line, {
    label: ' cpu % ', showLegend: false, wholeNumbersOnly: false,
    border: { type: 'line' }, style: { line: 'magenta', text: 'white', baseline: 'black' },
  });
  const log = grid.set(8, 0, 4, 12, contrib.log, {
    label: ' event stream (all) ', border: { type: 'line' }, fg: 'green', bufferLength: 200,
    tags: true, // render {color-fg} markup as color instead of literal text
  });

  // --- WATCH overlay (full-screen, hidden until ENTER on a session) ---
  const watchBox = blessed.log({
    parent: screen, hidden: true, top: 0, left: 0, width: '100%', height: '100%',
    label: ' watch ', border: { type: 'line' }, style: { border: { fg: 'magenta' } },
    fg: 'white', tags: true, scrollable: true, scrollback: 5000,
    wrap: true, keys: true, mouse: true, scrollbar: { ch: ' ', style: { bg: 'magenta' } },
  });
  let watchSessionId = null;
  let sessionIds = [];
  const cpuSeries = { title: 'cpu', x: [], y: [] };

  // confirm dialog for kill (destructive)
  const question = blessed.question({
    parent: screen, hidden: true, border: 'line', height: 'shrink', width: 'half',
    top: 'center', left: 'center', label: ' confirm kill ', tags: true, keys: true,
    style: { border: { fg: 'red' } },
  });

  // steer input — type a message that gets injected into the watched session (the reply
  // routes back out to its origin channel via /v2/inject). Shown at the bottom on `i`.
  const steerInput = blessed.textbox({
    parent: screen, hidden: true, bottom: 0, left: 0, width: '100%', height: 3,
    border: { type: 'line' }, label: ' steer — type a message, ENTER to send · ESC cancel ',
    style: { border: { fg: 'cyan' } }, inputOnFocus: true, keys: true, mouse: true,
  });

  function ageOf(ms) {
    if (!ms) return '?'; const s = Math.floor((Date.now() - ms) / 1000);
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
  }
  function fmtEvent(e, wide) {
    const t = new Date(e.ts).toISOString().slice(11, 19);
    let pl = {}; try { pl = typeof e.payload === 'string' ? JSON.parse(e.payload) : (e.payload || {}); } catch {}
    // narrow (global log): one line per event — collapse whitespace, clip to 80.
    // wide (watch view): show the FULL output — preserve newlines, generous cap so
    // long tool results are readable (scroll the watch box with ↑↓/PgUp/PgDn).
    const cap = wide ? 20000 : 80;
    const clip = (s) => {
      let str = String(s == null ? '' : s);
      if (!wide) str = str.replace(/\s+/g, ' ');
      else str = str.replace(/\t/g, '  '); // keep newlines; tabs → spaces for alignment
      return str.length > cap ? str.slice(0, cap) + `\n{gray-fg}… (+${str.length - cap} more chars truncated){/}` : str;
    };
    let line;
    switch (e.event_type) {
      case 'inbound': line = `{green-fg}▶ in{/}  ${clip(pl.text)}`; break;
      case 'thinking': line = `{yellow-fg}💭 think{/} {gray-fg}${clip(pl.text)}{/}`; break;
      case 'tool': line = `{magenta-fg}🔧 ${pl.tool}{/}  ${clip(pl.input)}`; break;
      case 'tool_result': line = `${pl.is_error ? '{red-fg}📥 err{/}' : '{cyan-fg}📥 out{/}'}  ${clip(pl.output)}`; break;
      case 'outbound': line = `{green-fg}◀ out{/}  ${pl.text ? clip(pl.text) : (pl.chars != null ? pl.chars + ' chars' : '')}`; break;
      case 'token-usage': line = `{gray-fg}∑ tokens ${e.tokens_in}/${e.tokens_out}${pl.tools != null ? ' · ' + pl.tools + ' tools' : ''}{/}`; break;
      case 'moderation_decision': line = `{blue-fg}🛡 ${pl.decision}{/}${pl.riskLevel != null ? ' (' + pl.riskLevel + ')' : ''}`; break;
      case 'control': line = `{red-fg}⚙ ${pl.action}{/}`; break;
      case 'session-start': line = `{gray-fg}● session start{/}`; break;
      default: line = `${e.event_type} ${clip(pl.text || pl.decision || pl.action || '')}`;
    }
    return `{gray-fg}${t}{/} {cyan-fg}${e.surface}{/} ${line}`;
  }

  async function refreshSessions() {
    try {
      const res = await fetch(BASE + '/api/sessions?active=1', { headers });
      const { sessions } = await res.json();
      sessionIds = sessions.map((s) => s.session_id);
      sessTable.setData({
        headers: ['session', 'kind', 'age', 'idle', 'tok', 'mux'],
        data: sessions.map((s) => [String(s.session_id).slice(0, 14), s.kind, ageOf(s.started_unix), ageOf(s.last_activity_unix), String(s.tokens_total || 0), s.multiplexer || '-']),
      });
      sessTable.setLabel(` active sessions (${sessions.length})  (↑↓ select · ENTER watch · k kill · q quit) `);
      if (!watchSessionId) screen.render();
    } catch (e) { log.log('{red-fg}sessions fetch failed: ' + e.message + '{/red-fg}'); }
  }

  async function seedCpu() {
    try {
      const res = await fetch(BASE + '/api/system?since=' + (Date.now() - 1800000), { headers });
      const { samples } = await res.json();
      for (const s of samples.reverse().slice(-30)) { cpuSeries.x.push(new Date(s.ts).toISOString().slice(11, 19)); cpuSeries.y.push(s.cpu_pct || 0); }
      cpuLine.setData([cpuSeries]); if (!watchSessionId) screen.render();
    } catch (e) { /* ignore */ }
  }

  async function openWatch(sessionId) {
    if (!sessionId || watchSessionId === sessionId) return; // guard double-fire (select + enter)
    watchSessionId = sessionId;
    watchBox.setLabel(` watch: ${sessionId}  (↑↓ scroll · i steer · k stop turn · ESC back) `);
    watchBox.setContent('');
    watchBox.show(); watchBox.focus();
    screen.render();
    try { // seed recent history for this session
      const res = await fetch(BASE + '/api/events?limit=60&session=' + encodeURIComponent(sessionId), { headers });
      const { events } = await res.json();
      for (const e of events.reverse()) watchBox.log(fmtEvent(e, true));
    } catch (e) { watchBox.log('{red-fg}history fetch failed: ' + e.message + '{/red-fg}'); }
    screen.render();
  }
  function closeWatch() { watchSessionId = null; watchBox.hide(); sessTable.focus(); screen.render(); }

  function killSelected() {
    const id = sessionIds[sessTable.rows.selected];
    if (!id) return;
    question.ask(`Kill session "${id}"?  (SIGTERM the process)`, async (err, ok) => {
      sessTable.focus();
      if (!ok) { screen.render(); return; }
      log.log(`{yellow-fg}⏹ killing ${id}…{/yellow-fg}`); screen.render();
      try {
        const r = await fetch(BASE + '/api/control/kill', { method: 'POST', headers: ctlHeaders(), body: JSON.stringify({ session_id: id }) });
        const j = await r.json();
        log.log(j.ok ? (j.forgotten ? `{gray-fg}✘ forgot ${id} (no live process — removed){/gray-fg}` : `{red-fg}⏹ killed ${id} (pid ${j.pid}, ${j.comm}){/red-fg}`) : `{yellow-fg}⏹ ${j.error}{/yellow-fg}`);
      } catch (e) { log.log(`{red-fg}kill failed: ${e.message}{/red-fg}`); }
      refreshSessions(); screen.render();
    });
  }

  const socket = io(BASE, { transports: ['websocket', 'polling'], auth: TOKEN ? { token: TOKEN } : {} });
  socket.on('connect', () => log.log('{cyan-fg}connected to collector{/cyan-fg}'));
  socket.on('disconnect', () => log.log('{red-fg}disconnected{/red-fg}'));
  socket.on('event', (e) => {
    log.log(fmtEvent(e));
    if (watchSessionId && e.session_id === watchSessionId) { watchBox.log(fmtEvent(e, true)); screen.render(); }
    else if (!watchSessionId) screen.render();
  });
  socket.on('system-sample', (s) => {
    cpuSeries.x.push(new Date(s.ts).toISOString().slice(11, 19)); cpuSeries.y.push(s.cpu_pct || 0);
    if (cpuSeries.x.length > 40) { cpuSeries.x.shift(); cpuSeries.y.shift(); }
    cpuLine.setData([cpuSeries]); if (!watchSessionId) screen.render();
  });

  // ENTER on a selected session → watch it
  sessTable.rows.on('select', (_item, index) => openWatch(sessionIds[index]));
  sessTable.rows.key(['enter'], () => openWatch(sessionIds[sessTable.rows.selected]));
  sessTable.rows.key(['k', 'x'], killSelected); // kill the selected session (with confirm)
  watchBox.key(['escape'], closeWatch);
  watchBox.key(['k'], async () => { // stop the watched session's in-flight turn (session survives)
    if (!watchSessionId) return;
    watchBox.log('{red-fg}⏹ stopping in-flight turn…{/red-fg}'); screen.render();
    try {
      const r = await fetch(CORE_BASE + '/v2/abort', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation_key: watchSessionId }) });
      const j = await r.json();
      watchBox.log(j.ok ? '{red-fg}⏹ stopped (session still resumable){/red-fg}' : `{yellow-fg}⏹ ${j.error || 'nothing in flight'}{/yellow-fg}`);
    } catch (e) { watchBox.log('{red-fg}stop failed: ' + e.message + '{/red-fg}'); }
    screen.render();
  });
  watchBox.key(['i'], () => { // open the steer input for the watched session
    if (!watchSessionId) return;
    steerInput.clearValue(); steerInput.show(); steerInput.focus(); screen.render();
  });
  steerInput.key(['escape'], () => { steerInput.hide(); watchBox.focus(); screen.render(); });
  steerInput.on('submit', async (value) => {
    const text = String(value || '').trim();
    steerInput.hide(); watchBox.focus(); screen.render();
    if (!text || !watchSessionId) return;
    watchBox.log(`{cyan-fg}✎ steering: ${text}{/cyan-fg}`); screen.render();
    try {
      const r = await fetch(CORE_BASE + '/v2/inject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation_key: watchSessionId, text, by: 'tui' }) });
      const j = await r.json();
      if (j.ok) watchBox.log(`{green-fg}◀ steered reply${j.delivered ? ' {gray-fg}(sent to channel){/gray-fg}' : (j.deliverErr ? ' {yellow-fg}[not delivered: ' + j.deliverErr + ']{/yellow-fg}' : '')}{/green-fg}: ${String(j.reply || '').slice(0, 400)}`);
      else watchBox.log(`{red-fg}steer failed: ${j.error}{/red-fg}`);
    } catch (e) { watchBox.log(`{red-fg}steer failed: ${e.message}{/red-fg}`); }
    screen.render();
  });
  screen.key(['q', 'C-c'], () => { socket.close(); process.exit(0); });
  screen.key(['escape'], () => { if (!watchSessionId) { socket.close(); process.exit(0); } });

  refreshSessions(); seedCpu();
  const timer = setInterval(refreshSessions, 2500);
  screen.on('destroy', () => clearInterval(timer));
  sessTable.focus();
  screen.render();
}

module.exports = { run };
