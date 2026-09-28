'use strict';
// Shell-quoting regression tests. Every path that turns a value into a shell line must survive the
// quote shapes the grok agent emitted on 28 Sep 2026 (single-quoted, \" inside double, heredoc,
// '"' joins, $vars, pipe alternation, python -c), plus paths with shell metacharacters.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Isolate every store the core opens BEFORE requiring it.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-shq-'));
process.env.HOME = TMP;
process.env.ASMLTR_CORE_DB = path.join(TMP, 'core.db');
process.env.ASMLTR_TRUST_DB = path.join(TMP, 'trust.db');

const { shQuote } = require('../shared/shell-quote');

// Packed lines exactly as grok sends them (quoting shapes from the day's journal, paths generic).
const PACKED = [
  `/bin/bash -lc 'which sh; ls -l "$(command -v sh)"'`,
  `/bin/bash -lc "python3 -c 'import sys; print(\\"py\\", sys.version_info[0])' ; echo ok"`,
  `/bin/bash -lc "python3 - << 'PY'\nimport json\np = \\"/tmp/a b/x.db\\"\nprint(p, json.dumps({\\"id\\": 1}))\nPY"`,
  `/bin/bash -lc "printf 'ii libjpeg-turbo8 2\\\\nii zlib1g 1\\\\n' | awk '/libjpeg|jpeg-progs|libturbo/{print "'$2}'"'"`,
  `/bin/bash -lc "echo '---'; echo \\"===== "'$f ====="'`,
];
const METAS = [
  "plain", "a b", "it's", "\"dq\"", "$HOME", "`id`", "back\\slash", "new\nline", "bang!", "'", "''", "",
  "a'\"'\"'b", "semi; echo injected", "$(echo injected)",
];

const shEcho = (quoted) => execFileSync('/bin/sh', ['-c', 'printf %s ' + quoted], { encoding: 'utf8' });

test('shQuote round-trips every metacharacter and every packed grok line through sh', () => {
  for (const v of [...METAS, ...PACKED]) assert.equal(shEcho(shQuote(v)), v, JSON.stringify(v));
  assert.equal(shQuote("it's"), "'it'\\''s'");
});

test('scheduler runShell: script_path with shell metacharacters runs that file, nothing else', async () => {
  const { runShell } = require('../core/src/scheduler');
  const dir = path.join(TMP, `sch "q" $HOME \`id\` it's`);
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'job $1.sh');
  fs.writeFileSync(script, '#!/bin/sh\necho sched-script-ok\n', { mode: 0o755 });
  const r = await runShell({ script_path: script, timeout_s: 20, cwd: TMP });
  assert.equal(r.status, 'ok', r.output);
  assert.match(r.output, /sched-script-ok/);
  assert.doesNotMatch(r.output, /uid=/);
});

test('scheduler runShell: command is a shell line and reaches sh verbatim (packed grok shapes)', async () => {
  const { runShell } = require('../core/src/scheduler');
  const cases = [
    [PACKED[1], /py 3\nok/],
    [PACKED[2], /\/tmp\/a b\/x\.db \{"id": 1\}/],
    [PACKED[3], /^libjpeg-turbo8$/m],
  ];
  for (const [command, want] of cases) {
    const r = await runShell({ command, timeout_s: 20, cwd: TMP });
    assert.equal(r.status, 'ok', command + '\n' + r.output);
    assert.match(r.output, want, r.output);
  }
});

test('identity contextBlocks: context.d file names with metacharacters still run', () => {
  const identity = require('../shared/identity');
  const dir = path.join(TMP, 'context.d');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `10 ctx $HOME "q" it's.sh`), '#!/bin/sh\necho ctx-file-ok\n', { mode: 0o755 });
  const prev = process.env.ASMLTR_CONTEXT_DIR;
  process.env.ASMLTR_CONTEXT_DIR = dir;
  try { assert.ok(identity.contextBlocks(TMP).includes('ctx-file-ok')); }
  finally { if (prev == null) delete process.env.ASMLTR_CONTEXT_DIR; else process.env.ASMLTR_CONTEXT_DIR = prev; }
});

test('alias which: a name is looked up literally, never executed', () => {
  const alias = require('../shared/alias');
  assert.match(String(alias.which('sh')), /\/sh$/);
  const hit = alias.which('sh; echo injected');
  assert.ok(!hit || !/injected/.test(hit), String(hit));
});
