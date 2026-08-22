'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prefaceOnBehalf, sameGuild, forumTitle, isForumChannel, destGuildId } = require('../shared/guild-post');
const { policyFor } = require('../shared/tool-policy');
const fs = require('fs');
const path = require('path');

test('preface tags asker then two blank lines then body', () => {
  const r = prefaceOnBehalf('999000111222333002', '1½ inch addendum');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'posting on behalf of <@999000111222333002>\n\n\n1½ inch addendum');
  const dup = prefaceOnBehalf('1', 'posting on behalf of <@99>\n\nhello');
  assert.equal(dup.text.startsWith('posting on behalf of <@1>\n\n\n'), true);
  assert.equal(dup.text.includes('<@99>'), false);
  assert.equal(prefaceOnBehalf('', 'hi').ok, false);
  assert.equal(prefaceOnBehalf('1', '  ').ok, false);
});

test('sameGuild: this server only', () => {
  assert.equal(sameGuild('aaa', 'aaa').ok, true);
  assert.equal(sameGuild('aaa', 'bbb').ok, false);
  assert.match(sameGuild('aaa', 'bbb').error, /off server/);
  assert.equal(sameGuild('', 'aaa').ok, false);
  assert.equal(sameGuild('aaa', '').ok, false);
});

test('forum parent vs thread', () => {
  assert.equal(isForumChannel({ type: 15 }), true);
  assert.equal(isForumChannel({ type: 0, isThread: () => false }), false);
  assert.equal(isForumChannel({ type: 11, isThread: () => true }), false);
  assert.equal(forumTitle('Steak 666', 'body'), 'Steak 666');
  assert.equal(forumTitle('', 'First line\nrest').length <= 100, true);
  assert.equal(destGuildId({ guildId: 'g1' }), 'g1');
  assert.equal(destGuildId({ guild: { id: 'g2' } }), 'g2');
});

test('public guild keeps send denied but guildPost allowed', () => {
  const p = policyFor({
    channel: 'discord', public: true,
    context: { scope_id: 'guild:g1' },
    channel_context: { channelId: 'ch1' },
  }, { bypass_moderation: false });
  assert.equal(p.deny.send, true);
  assert.equal(p.deny.guildPost, false);
});

test('discord /out handles guild_post and forum threads', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.match(src, /kind === 'guild_post'/);
  assert.match(src, /isForumChannel/);
  assert.match(src, /threads\.create/);
  assert.match(src, /messageReference/);
  const cli = fs.readFileSync(path.join(__dirname, '../cli/asmltr.js'), 'utf8');
  assert.match(cli, /cmdGuildPost/);
  const belt = fs.readFileSync(path.join(__dirname, '../mcp/toolbelt-server.js'), 'utf8');
  assert.match(belt, /asmltr_guild_post/);
  assert.match(belt, /deny: 'guildPost'/);
});
