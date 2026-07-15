#!/usr/bin/env node
'use strict';
/**
 * One-time backfill: give a TITLE + overview to already-running claude-code sessions that predate
 * the hook connector (so they never fired UserPromptSubmit and have no content to title from).
 *
 * The ongoing mechanism is the claude-code hook (connectors/types/claude-code/) — new sessions get
 * titled automatically. But a session already open when the hook was installed can't retroactively
 * fire it, and there's no reliable pane→transcript mapping. What we CAN read reliably is the live
 * pane itself: `screen hardcopy` / `tmux capture-pane`. So for each active mux-backed claude-code
 * session, snapshot its visible conversation and run it through the same title/overview generators
 * every connector uses. Titles are set UNLOCKED so a later hook event can still update them.
 *
 * Usage: node scripts/backfill-claude-titles.js [--force]   (--force retitles even if titled)
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dbmod = require('../insights/collector/db');

const CORE = process.env.ASMLTR_CORE_BASE || 'http://127.0.0.1:3023';
const FORCE = process.argv.includes('--force');

function capture(row) {
  const t = row.tmux_target;
  if (!t) return '';
  try {
    if (row.multiplexer === 'screen') {
      const f = path.join(os.tmpdir(), `asmltr-title-${String(t).replace(/[^\w.-]/g, '_')}.txt`);
      execFileSync('screen', ['-S', t, '-X', 'hardcopy', f], { timeout: 4000 });
      // screen writes the file async via its daemon — give it a beat
      execFileSync('sleep', ['0.3']);
      const c = fs.readFileSync(f, 'utf8'); fs.unlinkSync(f); return c;
    }
    if (row.multiplexer === 'tmux') {
      return execFileSync('tmux', ['capture-pane', '-t', t, '-p'], { encoding: 'utf8', timeout: 4000 });
    }
  } catch (_) {}
  return '';
}

// Keep the conversation, drop the claude UI chrome (input box, status bar, token counts, borders).
function clean(raw) {
  return String(raw || '').split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim())
    .filter((l) => !/bypass permissions|shift\+tab|\/clear to save|esc to interrupt|auto-update|Crunched for|Baked for|^\s*[─━│╭╮╰╯]/i.test(l))
    .join('\n').slice(-3500);
}

async function post(pathname, text) {
  const r = await fetch(CORE + pathname, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error(`${pathname} -> ${r.status}`);
  return r.json();
}

(async () => {
  const rows = dbmod.q.activeSessions.all().filter((s) =>
    s.surface === 'claude-code' && s.tmux_target && (s.multiplexer === 'screen' || s.multiplexer === 'tmux'));
  console.log(`${rows.length} active mux-backed claude-code session(s)`);
  let titled = 0;
  for (const row of rows) {
    if (row.title && !FORCE) { console.log(`  · ${row.session_id} — already titled (${JSON.stringify(row.title)})`); continue; }
    const text = clean(capture(row));
    if (text.length < 40) { console.log(`  · ${row.session_id} — pane empty/too short, skipped`); continue; }
    try {
      const { title } = await post('/v2/title', text);
      if (title) { dbmod.setTitle(row.session_id, title); titled++; }
      const { status } = await post('/v2/status', text).catch(() => ({}));
      if (status) dbmod.setActivity(row.session_id, status);
      console.log(`  ✓ ${row.session_id} → ${JSON.stringify(title)}${status ? '  ·  ' + JSON.stringify(status) : ''}`);
    } catch (e) { console.log(`  ✗ ${row.session_id} — ${e.message}`); }
  }
  console.log(`titled ${titled} session(s)`);
})();
