'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const scroll = require('../connectors/types/discord/guild-scrollback');
const { composeUserCatchUp } = require('../core/src/observe-catchup');
const { inbound } = require('../core/src/envelope');

function mem(guildId, channelId, messages) {
  return {
    servers: {
      [guildId]: {
        name: 'Example Guild',
        channels: {
          [channelId]: { name: 'general', messages },
        },
      },
    },
  };
}

function row(i, extras) {
  return {
    timestamp: extras && extras.timestamp || `2026-09-07T12:00:${String(i).padStart(2, '0')}.000Z`,
    author: (extras && extras.author) || 'pat',
    content: extras && extras.content != null ? extras.content : 'line ' + i,
    messageId: extras && extras.messageId || ('m' + i),
  };
}

test('last-N default is 30 and env ASMLTR_DISCORD_GUILD_SCROLLBACK is clamped', () => {
  assert.equal(scroll.DEFAULT_LIMIT, 30);
  assert.equal(scroll.scrollbackLimit({}), 30);
  assert.equal(scroll.scrollbackLimit({ ASMLTR_DISCORD_GUILD_SCROLLBACK: '20' }), 20);
  assert.equal(scroll.scrollbackLimit({ ASMLTR_DISCORD_GUILD_SCROLLBACK: '50' }), 50);
  assert.equal(scroll.scrollbackLimit({ ASMLTR_DISCORD_GUILD_SCROLLBACK: '999' }), scroll.LIMIT_MAX);
  assert.equal(scroll.scrollbackLimit({ ASMLTR_DISCORD_GUILD_SCROLLBACK: '0' }), 30);
  assert.equal(scroll.scrollbackLimit({ ASMLTR_DISCORD_GUILD_SCROLLBACK: 'nope' }), 30);
});

test('lastNFromMemory returns last-N and drops the triggering message', () => {
  const messages = [1, 2, 3, 4, 5].map((i) => row(i));
  const got = scroll.lastNFromMemory(mem('g1', 'c1', messages), 'g1', 'c1', 3, 'm5');
  assert.deepEqual(got.map((m) => m.messageId), ['m2', 'm3', 'm4']);
  assert.deepEqual(scroll.lastNFromMemory(mem('g1', 'c1', []), 'g1', 'c1', 30), []);
  assert.deepEqual(scroll.lastNFromMemory({}, 'g1', 'c1', 30), []);
});

test('needsDiscordFetch is true when memory is empty or stale, false when recent last-N exists', () => {
  const now = Date.parse('2026-09-07T18:00:00.000Z');
  assert.equal(scroll.needsDiscordFetch([], { now }), true);
  assert.equal(scroll.needsDiscordFetch([row(1)], { now, excludeMessageId: 'm1' }), true);

  const recent = [row(1), row(2, { timestamp: '2026-09-07T17:50:00.000Z' })];
  assert.equal(scroll.needsDiscordFetch(recent, { now, excludeMessageId: 'current' }), false);

  const stale = [row(1, { timestamp: '2026-09-06T10:00:00.000Z' })];
  assert.equal(scroll.needsDiscordFetch(stale, { now, staleMs: scroll.STALE_MS }), true);
});

test('formatGuildScrollback is catch-up context, not a search/dig cue', () => {
  const block = scroll.formatGuildScrollback([
    { author: 'ada', text: 'morning', messageId: 'a' },
    { author: 'bev', text: 'anyone around?', messageId: 'b' },
  ]);
  assert.match(block, /Recent channel scrollback/);
  assert.match(block, /- ada: morning/);
  assert.match(block, /- bev: anyone around\?/);
  assert.match(block, /\[End of channel scrollback\]/);
  assert.doesNotMatch(block, /search|dig|INDEX|asmltr_discord_search/i);
  assert.equal(scroll.formatGuildScrollback([]), '');
});

test('shouldAttachGuildScrollback is guild-only — DMs stay off', () => {
  assert.equal(scroll.shouldAttachGuildScrollback({
    guild: { id: 'g1' },
    channel: { id: 'c1', type: 0 },
  }), true);
  assert.equal(scroll.shouldAttachGuildScrollback({
    guild: null,
    channel: { id: 'dm1', type: 1 },
    author: { id: 'u1' },
  }), false);
  assert.equal(scroll.shouldAttachGuildScrollback({
    channel: { id: 'dm1', type: 1 },
  }), false);
});

test('loadGuildScrollback prefers memory.json and fetches only when empty/stale', async () => {
  const messages = [1, 2, 3].map((i) => row(i, { timestamp: '2026-09-07T17:00:00.000Z' }));
  let fetches = 0;
  const fromMem = await scroll.loadGuildScrollback({
    memory: mem('g1', 'c1', messages),
    guildId: 'g1',
    channelId: 'c1',
    excludeMessageId: 'm3',
    now: Date.parse('2026-09-07T17:10:00.000Z'),
    env: { ASMLTR_DISCORD_GUILD_SCROLLBACK: '30' },
    fetchMessages: async () => { fetches += 1; return [row(99)]; },
  });
  assert.equal(fetches, 0);
  assert.deepEqual(fromMem.map((m) => m.messageId), ['m1', 'm2']);
  assert.equal(fromMem[0].text, 'line 1');

  const fetched = await scroll.loadGuildScrollback({
    memory: mem('g1', 'c1', []),
    guildId: 'g1',
    channelId: 'c1',
    excludeMessageId: 'now',
    now: Date.parse('2026-09-07T17:10:00.000Z'),
    fetchMessages: async (limit, before) => {
      fetches += 1;
      assert.equal(limit, 30);
      assert.equal(before, undefined);
      return [
        row(7, { author: 'old', content: 'from discord', messageId: 'd7' }),
        row(8, { author: 'now', content: 'trigger', messageId: 'now' }),
      ];
    },
  });
  assert.equal(fetches, 1);
  assert.deepEqual(fetched.map((m) => m.messageId), ['d7']);
  assert.equal(fetched[0].text, 'from discord');
});

test('discordFetchOptions is a single page (optional before) — not a history dump', () => {
  assert.deepEqual(scroll.discordFetchOptions(30), { limit: 30 });
  assert.deepEqual(scroll.discordFetchOptions(30, '222222222222222222'), { limit: 30, before: '222222222222222222' });
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/guild-scrollback.js'), 'utf8');
  assert.doesNotMatch(src, /while\s*\(/);
  assert.doesNotMatch(src, /require\([^)]*discord-search/);
  assert.doesNotMatch(src, /runSearch/);
});

test('fromDiscordCollection is chronological author/text rows', () => {
  const col = {
    values() {
      return [
        { id: '2', createdTimestamp: 200, author: { username: 'b' }, content: 'second', cleanContent: 'second' },
        { id: '1', createdTimestamp: 100, author: { username: 'a' }, content: 'first', cleanContent: 'first' },
      ];
    },
  };
  const rows = scroll.fromDiscordCollection(col);
  assert.deepEqual(rows.map((m) => m.messageId), ['1', '2']);
  assert.equal(rows[0].author, 'a');
  assert.equal(rows[0].content, 'first');
});

test('composeUserCatchUp re-injects guild scrollback only on fresh public Discord resume', () => {
  const selfSent = '[self]\n';
  const observed = '[obs]\n';
  const guildScrollback = '[Recent channel scrollback]\n- pat: hi\n';
  assert.equal(composeUserCatchUp({
    selfSent, observed, guildScrollback, isNew: true, publicDiscord: true,
  }), selfSent + guildScrollback + observed);
  assert.equal(composeUserCatchUp({
    selfSent, observed, guildScrollback, isNew: false, publicDiscord: true,
  }), selfSent + observed);
  assert.equal(composeUserCatchUp({
    selfSent, observed, guildScrollback, isNew: true, publicDiscord: false,
  }), selfSent + observed);
  assert.equal(composeUserCatchUp({
    selfSent, observed, guildScrollback: '', isNew: true, publicDiscord: true,
  }), selfSent + observed);
});

test('envelope copies channel_scrollback; omitted stays empty', () => {
  const base = {
    channel: 'discord',
    conversation_key: 'discord:bot:channel:c1',
    sender: { raw_id: 'u1', raw_username: 'pat' },
    content: { text: 'hello' },
    public: true,
  };
  assert.equal(inbound(base).channel_scrollback, '');
  assert.equal(inbound({ ...base, channel_scrollback: '[Recent channel scrollback]\n- pat: hi\n' }).channel_scrollback,
    '[Recent channel scrollback]\n- pat: hi\n');
});

test('Discord guild handleMessage prepares channel_scrollback; DMs and search stay untouched', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.match(src, /guild-scrollback/);
  const handle = src.slice(src.indexOf('async function handleMessage'), src.indexOf('// OBSERVE —'));
  assert.match(handle, /shouldAttachGuildScrollback/);
  assert.match(handle, /loadGuildScrollback/);
  assert.match(handle, /channel_scrollback/);
  assert.doesNotMatch(handle, /discord-search/);
  assert.doesNotMatch(handle, /runSearch/);
  assert.doesNotMatch(handle, /asmltr_discord_search/);
  const get = src.slice(src.indexOf('function getRelevantContext'), src.indexOf('function shouldRespondTo'));
  assert.equal(get.includes('searchGlobalTimeline'), false);
  assert.equal(get.includes('slice(-'), false);
});

test('core catch-up uses composeUserCatchUp; DM PRIOR / recallForInject is unchanged', () => {
  const src = fs.readFileSync(path.join(__dirname, '../core/src/server.js'), 'utf8');
  assert.match(src, /composeUserCatchUp/);
  assert.match(src, /channel_scrollback/);
  const isNew = src.slice(src.indexOf('if (isNew) {'), src.indexOf('try {\n    const posted'));
  assert.match(isNew, /recallForInject/);
  assert.match(isNew, /PRIOR CONVERSATION/);
  assert.equal(isNew.includes('channel_scrollback'), false);
  assert.equal(isNew.includes('guildScrollback'), false);
  assert.equal(isNew.includes('composeUserCatchUp'), false);
});
