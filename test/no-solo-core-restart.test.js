'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Guards the invariant behind PR #33's split-brain fix: an SDK bump rewrites on-disk code that
// asmltr-core, asmltr-connector-manager, & asmltr-insights-collector all import, so any restart that
// names asmltr-core must name the other two as well. shared/runtime.js used to run
// `pm2 restart asmltr-core` alone, advancing core onto the new sha while the manager & collector kept
// running the old one. Every other restart site already lists all three; this test keeps it that way.

const REPO = path.join(__dirname, '..');
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'test', 'site']);
const SOURCE_EXT = new Set(['.js', '.sh']);

// A restart command names all three services, or is built from a variable/constant (e.g.
// `${ASMLTR_SERVICES.join(' ')}`) that carries no literal `asmltr-core`. Only the first form can
// drift into a core-only restart, so that is what this test checks.
const REQUIRED = ['asmltr-connector-manager', 'asmltr-insights-collector'];

// Match `pm2 restart` and capture the argument text up to end of line or the first shell/string
// boundary: `;`, `&&`, `>`, a double quote, or a backtick. A single quote is not a boundary because
// `.join(' ')` sits inside one, and comment prose that merely mentions "pm2 restart" without listing
// services leaves `asmltr-core` out of the captured args, so it never trips the assertion.
const RESTART_RE = /pm2 restart([^;&>"`\n]*)/g;

// Comments are prose, never an executable restart, so strip them before scanning. A backtick-quoted
// mention like `` `pm2 restart asmltr-core` `` inside a // comment names core alone by design and must
// not be flagged. This removes JS block/line comments (keeping the // in a `://` URL) and shell #
// comments; a real restart command carries no comment marker before it, so detection is unaffected.
function stripComments(line, ext) {
  if (ext === '.sh') return line.replace(/(^|\s)#.*$/, '$1');
  return line.replace(/\/\*.*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/, '$1');
}

function listSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      out.push(...listSourceFiles(path.join(dir, entry.name)));
    } else if (entry.isFile() && SOURCE_EXT.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

test('no pm2 restart names asmltr-core without the manager & collector', () => {
  const violations = [];
  for (const file of listSourceFiles(REPO)) {
    const ext = path.extname(file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((rawLine, i) => {
      const line = stripComments(rawLine, ext);
      RESTART_RE.lastIndex = 0;
      let m;
      while ((m = RESTART_RE.exec(line)) !== null) {
        const args = m[1];
        if (!args.includes('asmltr-core')) continue; // variable-built or prose mention: not a solo-core risk
        const missing = REQUIRED.filter((svc) => !args.includes(svc));
        if (missing.length) {
          const rel = path.relative(REPO, file);
          violations.push(`${rel}:${i + 1} restarts asmltr-core but omits ${missing.join(' & ')}`);
        }
      }
    });
  }
  assert.deepEqual(
    violations,
    [],
    `pm2 restart of asmltr-core must also cycle the manager & collector:\n  ${violations.join('\n  ')}`
  );
});
