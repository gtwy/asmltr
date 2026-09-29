'use strict';
// Agent profile for grok launches: plain built-in `grok-build` (not the CLI default grok-build-plan)
// on headless (`--agent`) and interactive launches. A profile name, never confused with the -m model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const engines = require('../shared/engines');
const grok = require('../core/src/engines/grok');
const cliEngine = require('../cli/asmltr-engine');

function withEnginesFile(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-agentprof-'));
  const file = path.join(dir, 'engines.json');
  if (content) fs.writeFileSync(file, JSON.stringify(content));
  const prevFile = process.env.ASMLTR_ENGINES_FILE;
  const prevEnv = process.env.ASMLTR_GROK_AGENT_PROFILE;
  process.env.ASMLTR_ENGINES_FILE = file;
  delete process.env.ASMLTR_GROK_AGENT_PROFILE;
  try { return fn(); } finally {
    if (prevFile == null) delete process.env.ASMLTR_ENGINES_FILE; else process.env.ASMLTR_ENGINES_FILE = prevFile;
    if (prevEnv == null) delete process.env.ASMLTR_GROK_AGENT_PROFILE; else process.env.ASMLTR_GROK_AGENT_PROFILE = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function cleanup(args) { if (args && args.visionPromptFile) { try { fs.unlinkSync(args.visionPromptFile); } catch (_) {} } }

test('agentProfileFor(grok) defaults to the plain grok-build profile; other engines have none', () => {
  withEnginesFile(null, () => {
    assert.equal(engines.agentProfileFor('grok'), 'grok-build');
    assert.equal(engines.agentProfileFor('claude'), null);
    assert.equal(engines.agentProfileFor('codex'), null);
    assert.equal(engines.agentProfileFor('nope'), null);
  });
});

test('agentProfileFor: engines.json agent_profile and env override; "" / "default" pass nothing', () => {
  withEnginesFile({ engines: { grok: { agent_profile: 'grok-build-ask-user' } } }, () => {
    assert.equal(engines.agentProfileFor('grok'), 'grok-build-ask-user');
    process.env.ASMLTR_GROK_AGENT_PROFILE = 'custom';
    assert.equal(engines.agentProfileFor('grok'), 'custom');
    process.env.ASMLTR_GROK_AGENT_PROFILE = 'default';
    assert.equal(engines.agentProfileFor('grok'), null);
  });
  withEnginesFile({ engines: { grok: { agent_profile: '' } } }, () => {
    assert.equal(engines.agentProfileFor('grok'), null);
  });
});

test('headless buildArgs passes --agent grok-build next to --always-approve; model stays on -m', () => {
  withEnginesFile({ engines: { grok: { model: 'grok-4.7' } } }, () => {
    const args = grok.buildArgs({ prompt: 'hello' });
    try {
      const i = args.indexOf('--agent');
      assert.ok(i >= 0, 'headless grok gets --agent');
      assert.equal(args[i + 1], 'grok-build');
      assert.ok(args.includes('--always-approve'), 'always-approve unchanged');
      assert.equal(args.filter((a) => a === '--agent').length, 1);
      assert.equal(args[args.indexOf('-m') + 1], 'grok-4.7', 'model id is separate from the profile');
      assert.notEqual(args[args.indexOf('-m') + 1], 'grok-build');
      assert.equal(args[0], '--no-auto-update', 'auto-update flag untouched');
    } finally { cleanup(args); }
  });
});

test('headless buildArgs covers title/complete, resume and denyAll turns too', () => {
  withEnginesFile(null, () => {
    const runs = [
      grok.buildArgs({ prompt: 'title me', complete: true, model: 'grok-3' }),
      grok.buildArgs({ prompt: 'next', resume: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }),
      grok.buildArgs({ prompt: 'voice', denyAll: true }),
    ];
    try {
      for (const a of runs) assert.equal(a[a.indexOf('--agent') + 1], 'grok-build');
    } finally { runs.forEach(cleanup); }
  });
});

test('headless buildArgs: opts.agentProfile "" or null omits --agent; a name overrides', () => {
  withEnginesFile(null, () => {
    const none = grok.buildArgs({ prompt: 'x', agentProfile: '' });
    const nul = grok.buildArgs({ prompt: 'x', agentProfile: null });
    const other = grok.buildArgs({ prompt: 'x', agentProfile: 'grok-build-plan' });
    try {
      assert.equal(none.includes('--agent'), false);
      assert.equal(nul.includes('--agent'), false);
      assert.equal(other[other.indexOf('--agent') + 1], 'grok-build-plan');
    } finally { [none, nul, other].forEach(cleanup); }
  });
});

test('interactive `asmltr grok` adds --agent grok-build unless the caller picked a profile or plan mode', () => {
  withEnginesFile({ engines: { grok: { model: 'grok-4.7' } } }, () => {
    const p = cliEngine.profile('grok', '/tmp', []);
    assert.deepEqual(p.args.slice(0, 3), ['--always-approve', '--agent', 'grok-build']);
    assert.equal(p.args[p.args.indexOf('-m') + 1], 'grok-4.7');
    for (const flag of [['--agent', 'x'], ['--agent=x'], ['--plan'], ['--no-plan'], ['--agent-profile', '/p.md']]) {
      assert.equal(cliEngine.profile('grok', '/tmp', flag).args.includes('--agent'), false, flag.join(' '));
    }
    assert.equal(cliEngine.profile('claude', '/tmp', []).args.includes('--agent'), false);
  });
});
