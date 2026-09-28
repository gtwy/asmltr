'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isMultiUserRoom, ownerTopicsAllowed, envelopeScope } = require('../shared/conversation-scope');
const { freshSessionHandoff } = require('../core/src/prompt-parts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-scope-'));
process.env.ASMLTR_CORE_DB = path.join(tmp, 't.db');
const sessions = require('../core/src/sessions');
after(() => {
  try { sessions.db.close(); } catch (_) {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
});

const GUILD = 'discord:inst-1:channel:1001';
const DM = 'discord:inst-1:dm:2002';

test('multi-user rooms: guild channel key, guild scope, public flag, group/room kinds', () => {
  assert.equal(isMultiUserRoom({ conversationKey: GUILD }), true);
  assert.equal(isMultiUserRoom({ conversationKey: 'x:inst:thread:1', scopeId: 'guild:9' }), true);
  assert.equal(isMultiUserRoom({ conversationKey: DM, public: true }), true);
  assert.equal(isMultiUserRoom({ conversationKey: 'chat:inst:group:5' }), true);
  assert.equal(isMultiUserRoom({ conversationKey: 'chat:inst:room:5' }), true);
});

test('private 1:1 conversations are not rooms', () => {
  assert.equal(isMultiUserRoom({ conversationKey: DM, scopeId: 'dm:2002' }), false);
  assert.equal(isMultiUserRoom({ conversationKey: 'telegram:inst:user:7' }), false);
  assert.equal(isMultiUserRoom({ conversationKey: 'email:inst:thread:abc' }), false);
  assert.equal(isMultiUserRoom({}), false);
});

test('owner last-topics: owner trust in a private 1:1 only', () => {
  assert.equal(ownerTopicsAllowed({ ownerTrust: true, channel: 'discord', conversationKey: DM, scopeId: 'dm:2002' }), true);
  assert.equal(ownerTopicsAllowed({ ownerTrust: true, channel: 'telegram', conversationKey: 'telegram:inst:user:7' }), true);
});

test('owner last-topics never reach a guild room, even when the owner is speaking', () => {
  assert.equal(ownerTopicsAllowed({ ownerTrust: true, channel: 'discord', conversationKey: GUILD, scopeId: 'guild:9' }), false);
  assert.equal(ownerTopicsAllowed({ ownerTrust: true, channel: 'discord', conversationKey: DM, public: true }), false);
});

test('owner last-topics never reach email threads, GitHub issues or MCP callers', () => {
  assert.equal(ownerTopicsAllowed({ ownerTrust: true, channel: 'email', conversationKey: 'email:inst:thread:abc' }), false);
  assert.equal(ownerTopicsAllowed({ ownerTrust: true, channel: 'github', conversationKey: 'github:inst:repo:o/r:issue:1' }), false);
  assert.equal(ownerTopicsAllowed({ ownerTrust: true, channel: 'mcp', conversationKey: 'mcp:mcp:user:someone' }), false);
});

test('non-owner principals never get owner last-topics', () => {
  assert.equal(ownerTopicsAllowed({ ownerTrust: false, channel: 'discord', conversationKey: DM }), false);
});

test('envelopeScope reads key, channel, public and scope_id from an envelope', () => {
  assert.deepEqual(envelopeScope({ conversation_key: GUILD, channel: 'discord', public: true, context: { scope_id: 'guild:9' } }),
    { conversationKey: GUILD, channel: 'discord', public: true, scopeId: 'guild:9' });
  assert.deepEqual(envelopeScope({}), { conversationKey: undefined, channel: undefined, public: false, scopeId: undefined });
});

test('broadcast announcements skip multi-user rooms; targeted ones still land', () => {
  sessions.addAnnouncement({ text: 'owner work note', target: '*', from_session: 'cli:local' });
  sessions.addAnnouncement({ text: 'to discord', target: 'surface:discord', from_session: 'cli:local' });
  sessions.addAnnouncement({ text: 'to this room', target: GUILD, from_session: 'cli:local' });
  const room = sessions.drainAnnouncements(GUILD, 'discord', 'someone', { room: true }).map((a) => a.text);
  assert.deepEqual(room.sort(), ['to discord', 'to this room'].sort());
  const dm = sessions.drainAnnouncements(DM, 'discord', 'owner').map((a) => a.text);
  assert.ok(dm.includes('owner work note'), 'a private session still gets the broadcast');
  assert.ok(dm.includes('to discord'));
  assert.ok(!dm.includes('to this room'));
});

test('freshSessionHandoff: full prompt handed over only when core sent the volatile tail', () => {
  assert.deepEqual(freshSessionHandoff({ reuseStable: false, fullPrompt: 'FULL' }), {});
  assert.deepEqual(freshSessionHandoff({ reuseStable: true, fullPrompt: '## IDENTITY\nYou are X.' }),
    { stableReused: true, fullSystemPrompt: '## IDENTITY\nYou are X.' });
});
