'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isMultiUserRoom, ownerTopicsAllowed, envelopeScope, broadcastAudience, resolveAnnounceScope } = require('../shared/conversation-scope');
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

test('work announcements never reach rooms; targeted work notes do not either', () => {
  const room = 'discord:inst-1:channel:1101';
  const dm = 'discord:inst-1:dm:2101';
  sessions.addAnnouncement({ text: 'owner work note', target: '*', from_session: 'cli:local' });
  sessions.addAnnouncement({ text: 'to discord', target: 'surface:discord', from_session: 'cli:local' });
  sessions.addAnnouncement({ text: 'to this room', target: room, from_session: 'cli:local' });
  const inRoom = sessions.drainAnnouncements(room, 'discord', 'someone', { audience: 'guild' }).map((a) => a.text);
  assert.deepEqual(inRoom, [], 'no work-scope note lands in a room, broadcast or targeted');
  const legacyRoom = sessions.drainAnnouncements('discord:inst-1:channel:1102', 'discord', 'x', { room: true }).map((a) => a.text);
  assert.deepEqual(legacyRoom, [], 'legacy { room: true } callers read guild scope only');
  const inDm = sessions.drainAnnouncements(dm, 'discord', 'owner', { audience: 'work' }).map((a) => a.text);
  assert.ok(inDm.includes('owner work note'), 'the owner DM gets the work broadcast');
  assert.ok(inDm.includes('to discord'));
  assert.ok(!inDm.includes('to this room'));
});

test('guild announcements move room to room and never reach work surfaces', () => {
  const everyone = 'discord:inst-2:channel:3001';
  const other = 'discord:inst-2:channel:3002';
  const r = sessions.addAnnouncement({ text: 'said in everyone', target: '*', scope: 'guild', origin_key: everyone, from_session: 'cli:agent' });
  assert.equal(r.scope, 'guild');
  const there = sessions.drainAnnouncements(other, 'discord', 'someone', { audience: 'guild' });
  assert.deepEqual(there.map((a) => a.text), ['said in everyone']);
  assert.equal(there[0].origin_key, everyone, 'the reader can see which room it came from');
  const self = sessions.drainAnnouncements(everyone, 'discord', 'someone', { audience: 'guild' }).map((a) => a.text);
  assert.ok(!self.includes('said in everyone'), 'not echoed back to its own room');
  for (const [key, ch] of [['discord:inst-2:dm:4001', 'discord'], ['email:inst-3:thread:abc', 'email'], ['mcp:inst-4:user:owner', 'mcp']]) {
    const got = sessions.drainAnnouncements(key, ch, 'owner', { audience: 'work' }).map((a) => a.text);
    assert.ok(!got.includes('said in everyone'), 'guild note stays out of ' + ch);
  }
  const none = sessions.drainAnnouncements('discord:inst-2:dm:4002', 'discord', 'stranger', { audience: null });
  assert.deepEqual(none, [], 'a null audience reads nothing');
  assert.ok(sessions.listAnnouncements({ scope: 'guild' }).every((a) => a.scope === 'guild'));
  assert.ok(sessions.listAnnouncements({ scope: 'work' }).every((a) => a.scope === 'work'));
});

test('broadcastAudience: owner DM, email, owner/listed MCP are work; rooms are guild; the rest read none', () => {
  const env = { ASMLTR_WORK_BROADCAST_PRINCIPALS: 'owner,helper-bot' };
  assert.equal(broadcastAudience({ ownerTrust: true, channel: 'discord', conversationKey: DM, env }), 'work');
  assert.equal(broadcastAudience({ ownerTrust: false, channel: 'discord', conversationKey: DM, env }), null, 'someone else\'s DM');
  assert.equal(broadcastAudience({ ownerTrust: true, channel: 'discord', conversationKey: GUILD, env }), 'guild', 'owner in a room is still a room');
  assert.equal(broadcastAudience({ ownerTrust: false, channel: 'discord', conversationKey: GUILD, env }), 'guild');
  assert.equal(broadcastAudience({ ownerTrust: true, channel: 'discord', conversationKey: DM, public: true, env }), 'guild');
  assert.equal(broadcastAudience({ ownerTrust: false, channel: 'email', conversationKey: 'email:i:thread:1', env }), 'work');
  assert.equal(broadcastAudience({ ownerTrust: false, userKey: 'helper-bot', channel: 'mcp', conversationKey: 'mcp:i:user:helper-bot', env }), 'work');
  assert.equal(broadcastAudience({ ownerTrust: true, userKey: 'owner', channel: 'mcp', conversationKey: 'mcp:i:user:owner', env }), 'work');
  assert.equal(broadcastAudience({ ownerTrust: false, userKey: 'other-client', channel: 'mcp', conversationKey: 'mcp:i:user:other', env }), null, 'non-owner MCP');
  assert.equal(broadcastAudience({ ownerTrust: true, channel: 'github', conversationKey: 'github:i:issue:1', env }), null);
  assert.equal(broadcastAudience({ ownerTrust: true, channel: 'schedule', conversationKey: 'schedule:i:job:1', env }), null);
  assert.equal(broadcastAudience({ ownerTrust: false, userKey: 'helper-bot', channel: 'mcp', conversationKey: 'mcp:i:user:x', env: {} }), null, 'default list is owner only');
});

test('resolveAnnounceScope: rooms post guild, private origins post work, no crossing', () => {
  assert.deepEqual(resolveAnnounceScope({ originKey: GUILD }), { scope: 'guild' });
  assert.deepEqual(resolveAnnounceScope({ originKey: GUILD, requested: 'guild' }), { scope: 'guild' });
  assert.ok(resolveAnnounceScope({ originKey: GUILD, requested: 'work' }).error, 'a room cannot write work');
  assert.deepEqual(resolveAnnounceScope({ originKey: DM }), { scope: 'work' });
  assert.ok(resolveAnnounceScope({ originKey: DM, requested: 'guild' }).error, 'a private session cannot write guild');
  assert.ok(resolveAnnounceScope({ originKey: 'email:i:thread:1', requested: 'guild' }).error);
  assert.deepEqual(resolveAnnounceScope({}), { scope: 'work' });
  assert.deepEqual(resolveAnnounceScope({ requested: 'guild' }), { scope: 'guild' }, 'operator terminal may choose');
  assert.ok(resolveAnnounceScope({ requested: 'everyone' }).error);
});

test('migration: announcements written before the split stay work-only', () => {
  const { spawnSync } = require('child_process');
  const Database = require('better-sqlite3');
  const dbPath = path.join(tmp, 'legacy.db');
  const old = new Database(dbPath);
  old.exec(`CREATE TABLE announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL DEFAULT '*', text TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal', from_session TEXT, created_at INTEGER NOT NULL, expires_at INTEGER)`);
  old.prepare('INSERT INTO announcements (target, text, created_at) VALUES (?, ?, ?)').run('*', 'legacy broadcast', Date.now());
  old.close();
  const script = `
    const s = require(${JSON.stringify(path.join(__dirname, '..', 'core', 'src', 'sessions'))});
    const room = s.drainAnnouncements('discord:i:channel:9', 'discord', 'x', { audience: 'guild' }).map((a) => a.text);
    const dm = s.drainAnnouncements('discord:i:dm:9', 'discord', 'owner', { audience: 'work' }).map((a) => a.text);
    const rows = s.listAnnouncements();
    process.stdout.write(JSON.stringify({ room, dm, scopes: rows.map((r) => r.scope) }));`;
  const out = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, ASMLTR_CORE_DB: dbPath }, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const r = JSON.parse(out.stdout);
  assert.deepEqual(r.scopes, ['work']);
  assert.deepEqual(r.room, []);
  assert.deepEqual(r.dm, ['legacy broadcast']);
});

test('freshSessionHandoff: full prompt handed over only when core sent the volatile tail', () => {
  assert.deepEqual(freshSessionHandoff({ reuseStable: false, fullPrompt: 'FULL' }), {});
  assert.deepEqual(freshSessionHandoff({ reuseStable: true, fullPrompt: '## IDENTITY\nYou are X.' }),
    { stableReused: true, fullSystemPrompt: '## IDENTITY\nYou are X.' });
});
