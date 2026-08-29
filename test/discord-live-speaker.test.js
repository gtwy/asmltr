'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  cacheKey, createLiveSpeakerCache, membersToPrime, voiceMemberDelta, applyFromCache,
} = require('../connectors/types/discord/live-speaker');

test('cache keyed by guildId+userId; same user different guilds are distinct', () => {
  const c = createLiveSpeakerCache();
  assert.deepEqual(cacheKey('g1', 'u1'), { guildId: 'g1', userId: 'u1' });
  c.set('g1', 'u1', { instructions: 'i1', tools: [{ name: 'asmltr_map' }] });
  c.set('g1', 'u2', { instructions: 'i2', tools: [] });
  c.set('g2', 'u1', { instructions: 'i3', tools: [{ name: 'asmltr_sessions' }] });
  assert.equal(c.get('g1', 'u1').instructions, 'i1');
  assert.equal(c.get('g1', 'u2').instructions, 'i2');
  assert.equal(c.get('g2', 'u1').instructions, 'i3');
  assert.equal(c.get('g1', 'u1').tools[0].name, 'asmltr_map');
  assert.equal(c.size(), 3);
  assert.equal(c.has('g1', 'u1'), true);
  assert.equal(c.has('g1', 'nope'), false);
});

test('prime existing members skips Ivy (client.user.id); drop on leave', () => {
  const ivyId = 'bot-ivy';
  const members = new Map([
    [ivyId, { id: ivyId, displayName: 'Ivy', user: { username: 'ivy' } }],
    ['42', { id: '42', displayName: 'James', user: { username: 'james' } }],
    ['99', { id: '99', displayName: 'Guest', user: { username: 'guest' } }],
  ]);
  const primed = membersToPrime({ members }, ivyId);
  assert.deepEqual(primed.map((m) => m.userId).sort(), ['42', '99']);
  assert.ok(!primed.some((m) => m.userId === ivyId));
  assert.equal(primed.find((m) => m.userId === '42').name, 'James');

  const ivyJoin = voiceMemberDelta({
    oldChannelId: '', newChannelId: 'vc1', ivyChannelId: 'vc1',
    userId: ivyId, selfUserId: ivyId,
  });
  assert.equal(ivyJoin.action, 'prime-channel');
  assert.equal(ivyJoin.dropGuildFirst, false);

  const otherJoin = voiceMemberDelta({
    oldChannelId: '', newChannelId: 'vc1', ivyChannelId: 'vc1',
    userId: '42', selfUserId: ivyId,
  });
  assert.deepEqual(otherJoin, { action: 'prime', userId: '42' });

  const otherLeave = voiceMemberDelta({
    oldChannelId: 'vc1', newChannelId: '', ivyChannelId: 'vc1',
    userId: '42', selfUserId: ivyId,
  });
  assert.deepEqual(otherLeave, { action: 'drop', userId: '42' });

  const ivyLeave = voiceMemberDelta({
    oldChannelId: 'vc1', newChannelId: '', ivyChannelId: 'vc1',
    userId: ivyId, selfUserId: ivyId,
  });
  assert.deepEqual(ivyLeave, { action: 'drop-guild' });

  const mute = voiceMemberDelta({
    oldChannelId: 'vc1', newChannelId: 'vc1', ivyChannelId: 'vc1',
    userId: '42', selfUserId: ivyId,
  });
  assert.equal(mute.action, null);

  const c = createLiveSpeakerCache();
  c.set('g1', '42', { instructions: 'j', tools: [] });
  c.set('g1', '99', { instructions: 'g', tools: [] });
  c.drop('g1', '42');
  assert.equal(c.has('g1', '42'), false);
  assert.equal(c.has('g1', '99'), true);
  c.dropGuild('g1');
  assert.equal(c.has('g1', '99'), false);
  assert.equal(c.size(), 0);
});

test('untrusted cached as tools []; missing cache → tools [] (do not block mouth)', () => {
  const c = createLiveSpeakerCache();
  const updates = [];
  const conv = { update(u) { updates.push(u); } };

  c.set('g1', 'guest', { instructions: 'untrusted-instr', tools: [] });
  let r = applyFromCache({ cache: c, guildId: 'g1', userId: 'guest', conv, fallbackInstructions: 'fallback' });
  assert.equal(r.ok, true);
  assert.equal(r.missing, false);
  assert.deepEqual(r.tools, []);
  assert.deepEqual(updates[0], { instructions: 'untrusted-instr', tools: [] });

  r = applyFromCache({ cache: c, guildId: 'g1', userId: 'never-primed', conv, fallbackInstructions: 'fallback' });
  assert.equal(r.ok, true);
  assert.equal(r.missing, true);
  assert.deepEqual(r.tools, []);
  assert.deepEqual(updates[1], { instructions: 'fallback', tools: [] });

  r = applyFromCache({ cache: c, guildId: 'g1', userId: '', conv, fallbackInstructions: 'fallback' });
  assert.equal(r.missing, true);
  assert.deepEqual(r.tools, []);
});

test('index: prime on join of existing members; drop on leave; flip applies cache only', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.match(src, /createLiveSpeakerCache/);
  assert.match(src, /async function primeLiveMember/);
  assert.match(src, /function applyLiveSpeaker/);
  assert.match(src, /voiceStateUpdate/);
  assert.match(src, /membersToPrime/);
  assert.match(src, /voiceMemberDelta/);
  assert.match(src, /primeVoiceChannelMembers/);
  assert.match(src, /liveSpeakerCache\.dropGuild/);
  assert.match(src, /liveSpeakerCache\.drop\(/);

  const prime = src.slice(src.indexOf('async function primeLiveMember'), src.indexOf('function applyLiveSpeaker'));
  assert.match(prime, /ctx\.core\.resolve/);
  assert.match(prime, /recallForInject/);
  assert.match(prime, /toolsForSpeaker/);
  assert.match(prime, /client\.user\.id/);

  const apply = src.slice(src.indexOf('function applyLiveSpeaker'), src.indexOf('function bindLiveSpeaker'));
  assert.doesNotMatch(apply, /ctx\.core\.resolve/);
  assert.doesNotMatch(apply, /recallForInject/);
  assert.match(apply, /liveSpeakerCache.get/);
  assert.match(apply, /liveRoomLine/);

  const handle = src.slice(src.indexOf('async function handleVoiceUtterance'), src.indexOf('async function engineKeys'));
  const live = handle.slice(handle.indexOf('if (converseSessions.has(guildId))'), handle.indexOf('if (voiceBusy.has(guildId))'));
  assert.match(live, /applyLiveSpeaker\(/);
  assert.doesNotMatch(live, /ctx\.core\.resolve/);
  assert.doesNotMatch(live, /recallForInject/);
  assert.doesNotMatch(live, /primeLiveMember/);
  assert.doesNotMatch(live, /bindLiveSpeaker/);

  const pcm = src.slice(src.indexOf('onPcm24: conv'), src.indexOf('onBargeIn:'));
  assert.match(pcm, /applyLiveSpeaker\(/);
  assert.doesNotMatch(pcm, /ctx\.core\.resolve/);
  assert.doesNotMatch(pcm, /recallForInject/);
  assert.doesNotMatch(pcm, /primeLiveMember/);
  assert.doesNotMatch(pcm, /bindLiveSpeaker/);
});
