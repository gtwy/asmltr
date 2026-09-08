'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyGuildInbound, createGuildAcpSessions, wantsCaretLookup, isBareMention,
  isStopCmd, SLEEP_EMOJI, STATE,
} = require('../connectors/types/discord/guild-acp-session');

test('SLEEP: only a real bot ping wakes; bare name and chatter are ignored', () => {
  assert.deepEqual(classifyGuildInbound({
    isGuild: true, muted: false, mentionsBot: false, text: 'hey assistant', awake: false,
  }), { action: 'ignore' });
  assert.deepEqual(classifyGuildInbound({
    isGuild: true, muted: false, mentionsBot: true, text: '<@99> hello', awake: false,
  }), { action: 'wake' });
  assert.deepEqual(classifyGuildInbound({
    isGuild: true, muted: false, mentionsBot: true, text: '<@99>', awake: false,
  }), { action: 'wake' });
});

test('mute is deaf — even a ping does not wake here (caller drops muted first)', () => {
  assert.deepEqual(classifyGuildInbound({
    isGuild: true, muted: true, mentionsBot: true, text: '<@99> hello', awake: false,
  }), { action: 'ignore' });
});

test('AWAKE: bare re-ping does not spawn; other messages follow or queue', () => {
  assert.deepEqual(classifyGuildInbound({
    isGuild: true, mentionsBot: true, text: '<@99>', awake: true, processing: false,
  }), { action: 'ignore-reping' });
  assert.deepEqual(classifyGuildInbound({
    isGuild: true, mentionsBot: false, text: 'and then what?', awake: true, processing: false,
  }), { action: 'follow' });
  assert.deepEqual(classifyGuildInbound({
    isGuild: true, mentionsBot: false, text: 'hold on', awake: true, processing: true,
  }), { action: 'queue' });
});

test('stop: hard-kill while processing; gentle sleep while idle-awake; ignore if already asleep', () => {
  assert.deepEqual(classifyGuildInbound({
    mentionsBot: true, text: '<@99> stop', awake: true, processing: true,
  }), { action: 'hard-stop' });
  assert.deepEqual(classifyGuildInbound({
    mentionsBot: true, text: '<@99> stop', awake: true, processing: false,
  }), { action: 'gentle-sleep' });
  assert.deepEqual(classifyGuildInbound({
    mentionsBot: true, text: '<@99> abort', awake: false, processing: false,
  }), { action: 'ignore' });
  assert.equal(isStopCmd('<@99> halt'), true);
  assert.equal(isStopCmd('<@99> please stop later'), false);
});

test('caret lookup is any ^ in the text, not only a lone caret', () => {
  assert.equal(wantsCaretLookup('^'), true);
  assert.equal(wantsCaretLookup('^^'), true);
  assert.equal(wantsCaretLookup('what was ^ that photo'), true);
  assert.equal(wantsCaretLookup('look ^ up the still from earlier'), true);
  assert.equal(wantsCaretLookup('hello'), false);
  assert.equal(isBareMention('<@99>   '), true);
  assert.equal(isBareMention('<@99> hi'), false);
});

test('auto gentle sleep after 10 minutes with nothing worth a reply; posts sleep emoji', () => {
  let t = 1_000;
  const s = createGuildAcpSessions({ now: () => t, sleepAfterMs: 10 * 60 * 1000 });
  s.wake('ch1', '111', t);
  assert.equal(s.isAwake('ch1'), true);
  assert.equal(s.shouldAutoSleep('ch1', t + (10 * 60 * 1000) - 1), false);
  assert.equal(s.shouldAutoSleep('ch1', t + (10 * 60 * 1000)), true);
  s.noteReply('ch1', t + 1000);
  assert.equal(s.shouldAutoSleep('ch1', t + 1000 + (10 * 60 * 1000) - 1), false);
  s.sleep('ch1');
  assert.equal(s.isAwake('ch1'), false);
  assert.equal(s.get('ch1').state, STATE.SLEEP);
  assert.equal(SLEEP_EMOJI, '😴');
});

test('new sessions default SLEEP; DMs are not this machine', () => {
  const s = createGuildAcpSessions();
  assert.equal(s.isAwake('never-seen'), false);
  assert.deepEqual(classifyGuildInbound({ isGuild: false, mentionsBot: false }), { action: 'dm' });
});
