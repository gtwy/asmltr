'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-effort-'));
const nextFile = path.join(tmp, 'next-effort');
process.env.ASMLTR_GROK_NEXT_EFFORT_FILE = nextFile;
process.env.ASMLTR_CORE_DB = path.join(tmp, 'sess.db');
delete process.env.ASMLTR_GROK_EFFORT;

const grok = require('../core/src/engines/grok');
const sessions = require('../core/src/sessions');

const noGit = path.join(tmp, 'nogit');
const gitCwd = path.join(tmp, 'gitproj');
fs.mkdirSync(noGit, { recursive: true });
fs.mkdirSync(path.join(gitCwd, '.git'), { recursive: true });

after(() => {
  try { sessions.db.close(); } catch (_) {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  delete process.env.ASMLTR_GROK_EFFORT;
  delete process.env.ASMLTR_GROK_NEXT_EFFORT_FILE;
});

function effortOf(args) {
  const i = args.indexOf('--effort');
  assert.ok(i >= 0, 'buildArgs must include --effort');
  return args[i + 1];
}

test('buildArgs includes --effort high by default', () => {
  delete process.env.ASMLTR_GROK_EFFORT;
  const args = grok.buildArgs({ prompt: 'What is 2+2?', cwd: noGit });
  assert.equal(effortOf(args), 'high');
});

test('ASMLTR_GROK_EFFORT overrides baseline', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    const args = grok.buildArgs({ prompt: 'What is 2+2?', cwd: noGit });
    assert.equal(effortOf(args), 'medium');
    process.env.ASMLTR_GROK_EFFORT = 'low';
    assert.equal(effortOf(grok.buildArgs({ prompt: 'hello', cwd: noGit })), 'low');
    process.env.ASMLTR_GROK_EFFORT = 'xhigh';
    assert.equal(effortOf(grok.buildArgs({ prompt: 'hello', cwd: noGit })), 'xhigh');
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('auto-xhigh on implement/fix/refactor/debug prompts (word-boundary)', () => {
  delete process.env.ASMLTR_GROK_EFFORT;
  for (const p of [
    'Please implement a helper',
    'Can you fix the typo',
    'Refactor this module',
    'debug the crash',
    'IMPLEMENT the feature',
    'please Fix it',
  ]) {
    assert.equal(effortOf(grok.buildArgs({ prompt: p, cwd: noGit })), 'xhigh', p);
  }
  // not word-boundary matches
  assert.equal(effortOf(grok.buildArgs({ prompt: 'prefix the title', cwd: noGit })), 'high');
  assert.equal(effortOf(grok.buildArgs({ prompt: 'the fixture is ready', cwd: noGit })), 'high');
  assert.equal(effortOf(grok.buildArgs({ prompt: 'debugging notes only?', cwd: noGit })), 'high');
});

test('auto-xhigh when cwd is a git repo (temp dir with .git)', () => {
  delete process.env.ASMLTR_GROK_EFFORT;
  const args = grok.buildArgs({ prompt: 'What is 2+2?', cwd: gitCwd });
  assert.equal(effortOf(args), 'xhigh');
});

test('NOT xhigh for a simple question when cwd is not a git repo', () => {
  delete process.env.ASMLTR_GROK_EFFORT;
  const args = grok.buildArgs({ prompt: 'What is 2+2? Reply with just the number.', cwd: noGit });
  assert.equal(effortOf(args), 'high');
  // missing cwd must not fall back to process.cwd() (the clone is a git repo)
  assert.equal(effortOf(grok.buildArgs({ prompt: 'What is 2+2?' })), 'high');
});

test('HOME is never treated as a project git repo', () => {
  delete process.env.ASMLTR_GROK_EFFORT;
  assert.equal(grok.isProjectGitRepo(os.homedir()), false);
  assert.equal(effortOf(grok.buildArgs({ prompt: 'hello', cwd: os.homedir() })), 'high');
});

test('next-turn file: xhigh once then reset to high', () => {
  delete process.env.ASMLTR_GROK_EFFORT;
  fs.writeFileSync(nextFile, 'xhigh\n');
  assert.equal(grok.effortForTurn({ prompt: 'What is 2+2?', cwd: noGit }), 'xhigh');
  assert.equal(fs.existsSync(nextFile), false, 'next-effort file is consumed once');
  assert.equal(grok.effortForTurn({ prompt: 'What is 2+2?', cwd: noGit }), 'high');
});

test('next-turn session flag: xhigh once then reset to high', () => {
  delete process.env.ASMLTR_GROK_EFFORT;
  const key = 'assistant-web:local:effort-test';
  sessions.ensure(key, 'assistant-web', 'idle:45', noGit);
  assert.equal(sessions.setNextEffort(key, 'xhigh'), true);
  assert.equal(sessions.get(key).next_effort, 'xhigh');
  assert.equal(grok.effortForTurn({ prompt: 'What is 2+2?', cwd: noGit, conversationKey: key }), 'xhigh');
  assert.equal(sessions.get(key).next_effort, null);
  assert.equal(sessions.consumeNextEffort(key), null);
  assert.equal(grok.effortForTurn({ prompt: 'What is 2+2?', cwd: noGit, conversationKey: key }), 'high');
  sessions.remove(key);
});

test('complete() skips auto-xhigh', () => {
  delete process.env.ASMLTR_GROK_EFFORT;
  const args = grok.buildArgs({ prompt: 'implement a title', complete: true, cwd: gitCwd });
  assert.equal(effortOf(args), 'high');
});
