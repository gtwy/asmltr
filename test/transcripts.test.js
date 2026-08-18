'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-transcripts-'));
process.env.ASMLTR_SILOS_ROOT = tmp;

const transcripts = require('../shared/transcripts');
const silo = require('../shared/silo');

after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
});

test('safeKey strips colons so conversation_key is a filename', () => {
  assert.equal(transcripts.safeKey('assistant-web:local:owner'), 'assistant-web-local-owner');
  assert.equal(transcripts.safeKey(''), 'unknown');
});

test('appendTurn writes user+assistant into Self silo memory/transcripts and last-topics', () => {
  const ts = Date.UTC(2026, 7, 18, 18, 0, 0);
  const wrote = transcripts.appendTurn({
    conversationKey: 'assistant-web:local:owner',
    channel: 'assistant-web',
    userText: 'I like Laphroaig 10 and a 12-year refill sherry cask.',
    assistantText: 'Islay peat plus sherry is a solid pairing.',
    ts,
  });
  assert.equal(wrote.transcript, 'memory/transcripts/assistant-web-local-owner.md');
  assert.equal(wrote.lastTopics, 'memory/last-topics.md');

  const self = silo.ensureSelf();
  const md = fs.readFileSync(path.join(self.dir, wrote.transcript), 'utf8');
  assert.ok(md.includes('Laphroaig 10'));
  assert.ok(md.includes('Islay peat plus sherry'));
  assert.ok(md.includes('**user:**'));
  assert.ok(md.includes('**assistant:**'));
  assert.ok(md.includes('assistant-web:local:owner'));

  const topics = fs.readFileSync(path.join(self.dir, wrote.lastTopics), 'utf8');
  assert.ok(topics.startsWith('# Last topics'));
  assert.ok(topics.includes('Laphroaig 10'));
  assert.ok(topics.includes('assistant-web:local:owner'));
});

test('appendTurn appends a second turn and keeps newest topic first', () => {
  const ts = Date.UTC(2026, 7, 18, 18, 5, 0);
  transcripts.appendTurn({
    conversationKey: 'assistant-web:local:owner',
    userText: 'Also curious about Caol Ila.',
    assistantText: 'Lighter peat, good contrast.',
    ts,
  });
  const self = silo.ensureSelf();
  const md = fs.readFileSync(path.join(self.dir, 'memory/transcripts/assistant-web-local-owner.md'), 'utf8');
  assert.ok(md.includes('Laphroaig 10'));
  assert.ok(md.includes('Caol Ila'));
  const topics = fs.readFileSync(path.join(self.dir, 'memory/last-topics.md'), 'utf8');
  const lines = topics.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(lines[0].includes('Caol Ila'));
  assert.ok(lines.some((l) => l.includes('Laphroaig')));
});
