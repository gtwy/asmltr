'use strict';
/**
 * Terminal-multiplexer abstraction for interactive `asmltr claude` sessions — tmux OR screen.
 *
 * Why both: screen keeps program output in the terminal's MAIN buffer (default `altscreen off`), so
 * the native mouse wheel scrolls history the way people expect; tmux owns the alternate screen and
 * "hijacks" the wheel (you need copy-mode). Operators who prefer screen set ASMLTR_MULTIPLEXER=screen.
 *
 * Per-session ops (send-keys, alive, attach hint) dispatch on the multiplexer RECORDED for that
 * session, so a session created under one still works after the config default changes.
 */
const { execFile, execFileSync, spawnSync } = require('child_process');

function available(bin) {
  try { execFileSync(bin, bin === 'screen' ? ['-v'] : ['-V'], { stdio: 'ignore' }); return true; }
  catch (e) { return bin === 'screen' && e.status === 1; } // `screen -v` prints version but exits 1
}
/** The configured multiplexer (ASMLTR_MULTIPLEXER=screen|tmux, default tmux), falling back to whatever's installed. */
function current() {
  const want = (process.env.ASMLTR_MULTIPLEXER || 'tmux').toLowerCase() === 'screen' ? 'screen' : 'tmux';
  if (available(want)) return want;
  const other = want === 'screen' ? 'tmux' : 'screen';
  return available(other) ? other : want; // let the caller report the missing one
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const tmux = {
  spawnDetached: (name, cwd, argv) => spawnSync('tmux', ['new-session', '-d', '-s', name, '-c', cwd, ...argv], { stdio: 'inherit' }).status === 0,
  attach: (name) => spawnSync('tmux', ['attach', '-t', name], { stdio: 'inherit' }),
  alive: (name) => spawnSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' }).status === 0,
  pid: (name) => { const r = spawnSync('tmux', ['list-panes', '-t', name, '-F', '#{pane_pid}'], { encoding: 'utf8' }); return Number((r.stdout || '').trim().split('\n')[0]) || null; },
  attachCmd: (name) => `tmux attach -t ${name}`,
  detachHint: 'Ctrl-b d',
  sendText: (name, text, enter, cb) => execFile('tmux', ['send-keys', '-t', name, '-l', '--', String(text)], (e) => { if (!e && enter) execFile('tmux', ['send-keys', '-t', name, 'Enter'], cb || (() => {})); else if (cb) cb(e); }),
  sendKey: (name, key, cb) => execFile('tmux', ['send-keys', '-t', name, key], cb || (() => {})),
};

const KEY = { Escape: '\x1b', Enter: '\r', Tab: '\t' }; // literal sequences for screen's `stuff`
const screen = {
  spawnDetached: (name, cwd, argv) => spawnSync('screen', ['-dmS', name, ...argv], { cwd, stdio: 'inherit' }).status === 0,
  attach: (name) => spawnSync('screen', ['-x', name], { stdio: 'inherit' }),
  alive: (name) => { const r = spawnSync('screen', ['-ls', name], { encoding: 'utf8' }); return new RegExp('\\d+\\.' + esc(name) + '\\b').test(r.stdout || ''); },
  pid: (name) => { const r = spawnSync('screen', ['-ls', name], { encoding: 'utf8' }); const m = (r.stdout || '').match(new RegExp('(\\d+)\\.' + esc(name) + '\\b')); return m ? Number(m[1]) : null; },
  attachCmd: (name) => `screen -x ${name}`,
  detachHint: 'Ctrl-a d',
  sendText: (name, text, enter, cb) => execFile('screen', ['-S', name, '-X', 'stuff', String(text) + (enter ? '\r' : '')], cb || (() => {})),
  sendKey: (name, key, cb) => execFile('screen', ['-S', name, '-X', 'stuff', KEY[key] || key], cb || (() => {})),
};

const providers = { tmux, screen };
function provider(name) { return providers[name] || tmux; }

module.exports = { current, available, provider, tmux, screen };
