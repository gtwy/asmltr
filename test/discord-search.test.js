'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const search = require('../shared/discord-search');

function msg(id, extras) {
  const sid = String(id).length >= 17 ? String(id) : String(id).padStart(18, '5');
  return {
    id: sid,
    channel_id: '222222222222222222',
    content: extras && extras.content != null ? extras.content : 'hello ' + id,
    timestamp: '2026-09-01T12:00:00.000000+00:00',
    author: {
      id: (extras && extras.authorId) || '333333333333333333',
      username: (extras && extras.username) || 'pat',
      bot: !!(extras && extras.bot),
    },
  };
}

test('capAroundLimit clamps to 1..25 and defaults when empty', () => {
  assert.equal(search.AROUND_LIMIT_MAX, 25);
  assert.equal(search.capAroundLimit(3), 3);
  assert.equal(search.capAroundLimit(25), 25);
  assert.equal(search.capAroundLimit(99), 25);
  assert.equal(search.capAroundLimit(0), search.DEFAULT_AROUND_LIMIT);
  assert.equal(search.capAroundLimit(-4), search.DEFAULT_AROUND_LIMIT);
  assert.equal(search.capAroundLimit('nope'), search.DEFAULT_AROUND_LIMIT);
});

test('buildGuildSearchPath uses official search, not channel history dump', () => {
  const path = search.buildGuildSearchPath('111111111111111111', { content: 'padron 1964', limit: 5 });
  assert.match(path, /^\/guilds\/111111111111111111\/messages\/search\?/);
  assert.match(path, /content=padron/);
  assert.doesNotMatch(path, /\/channels\/.+\/messages\?/);
  assert.doesNotMatch(path, /limit=100/);
});

test('buildGuildSearchPath can prefer a channel_id filter without dumping that channel', () => {
  const path = search.buildGuildSearchPath('111111111111111111', {
    content: 'brisket',
    channelIds: ['444444444444444444'],
    limit: 25,
  });
  assert.match(path, /channel_id=444444444444444444/);
  assert.match(path, /limit=25/);
  assert.doesNotMatch(path, /\/channels\/444444444444444444\/messages/);
});

test('search limit is capped at 25', () => {
  const path = search.buildGuildSearchPath('111111111111111111', { content: 'x', limit: 99 });
  assert.match(path, /limit=25/);
});

test('buildAroundPath caps limit at 25', () => {
  assert.equal(
    search.buildAroundPath('222222222222222222', '555555555555555555', 8),
    '/channels/222222222222222222/messages?around=555555555555555555&limit=8',
  );
  assert.match(search.buildAroundPath('222222222222222222', '555555555555555555', 99), /limit=25/);
});

test('DM path is around/before on the DM channel — never guild search, never unbounded', () => {
  const around = search.buildDmMessagesPath({
    channelId: '666666666666666666',
    around: '777777777777777777',
    limit: 40,
  });
  assert.equal(around, '/channels/666666666666666666/messages?around=777777777777777777&limit=25');
  assert.doesNotMatch(around, /\/guilds\//);

  const before = search.buildDmMessagesPath({
    channelId: '666666666666666666',
    before: '777777777777777777',
    limit: 10,
  });
  assert.equal(before, '/channels/666666666666666666/messages?before=777777777777777777&limit=10');

  const latest = search.buildDmMessagesPath({ channelId: '666666666666666666', limit: 10 });
  assert.equal(latest, '/channels/666666666666666666/messages?limit=10');
  assert.doesNotMatch(latest, /limit=100/);
});

test('isIndexNotReady detects 202 / code 110000', () => {
  assert.equal(search.isIndexNotReady(202, {
    message: 'Index not yet available. Try again later',
    code: 110000,
    documents_indexed: 0,
    retry_after: 2,
  }), true);
  assert.equal(search.retryAfterMs({ retry_after: 2 }), 2000);
  assert.equal(search.retryAfterMs({ retry_after: 0 }), search.INDEX_RETRY_FALLBACK_MS);
  assert.equal(search.isIndexNotReady(200, { messages: [], total_results: 0 }), false);
});

test('flattenHits keeps bot and self messages (Corona must not skip those)', () => {
  const body = {
    total_results: 2,
    messages: [
      [msg('10', { content: 'ivy: the padron pairing', bot: true, username: 'Ivy', authorId: '888888888888888888' })],
      [msg('11', { content: 'human follow-up', bot: false, username: 'pat' })],
    ],
  };
  const hits = search.flattenHits(body);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].author.bot, true);
  assert.equal(hits[0].content.includes('padron'), true);
  assert.equal(hits[1].author.bot, false);
});

test('searchGuilds retries index-not-ready then returns hits + around context', async () => {
  const calls = [];
  const request = async (path) => {
    calls.push(path);
    if (path.startsWith('/guilds/111111111111111111/messages/search')) {
      if (calls.filter((p) => p.includes('/messages/search')).length === 1) {
        return {
          status: 202,
          body: { message: 'Index not yet available. Try again later', code: 110000, retry_after: 0 },
        };
      }
      return {
        status: 200,
        body: {
          total_results: 1,
          messages: [[msg('55', { content: 'bot recipe note', bot: true, username: 'Ivy' })]],
        },
      };
    }
    if (path.includes('/channels/222222222222222222/messages?around=')) {
      return {
        status: 200,
        body: [
          msg('54', { content: 'before' }),
          msg('55', { content: 'bot recipe note', bot: true, username: 'Ivy' }),
          msg('56', { content: 'after' }),
        ],
      };
    }
    throw new Error('unexpected path ' + path);
  };

  const sleeps = [];
  const out = await search.searchGuilds({
    request,
    guildIds: ['111111111111111111'],
    query: 'recipe',
    aroundLimit: 5,
    sleep: async (ms) => { sleeps.push(ms); },
  });

  assert.equal(out.ok, true);
  assert.equal(out.indexNotReady, false);
  assert.equal(sleeps[0], search.INDEX_RETRY_FALLBACK_MS);
  assert.equal(out.hits.length, 1);
  assert.equal(out.hits[0].message.author.bot, true);
  assert.equal(out.hits[0].context.length, 3);
  assert.ok(calls.some((p) => p.includes('/messages/search')));
  assert.ok(calls.some((p) => p.includes('around=' + msg('55').id)));
});

test('searchGuilds walks every guild id and does not filter bot hits', async () => {
  const seen = [];
  const request = async (path) => {
    seen.push(path);
    const gid = (path.match(/^\/guilds\/(\d+)/) || [])[1];
    if (gid) {
      return {
        status: 200,
        body: {
          total_results: 1,
          messages: [[msg(gid.slice(-2), { content: 'hit in ' + gid, bot: true, username: 'Ivy' })]],
        },
      };
    }
    return { status: 200, body: [] };
  };
  const out = await search.searchGuilds({
    request,
    guildIds: ['111111111111111111', '999999999999999999'],
    query: 'hit',
    aroundLimit: 3,
    sleep: async () => {},
  });
  assert.equal(out.ok, true);
  assert.equal(out.hits.length, 2);
  assert.equal(out.hits.every((h) => h.message.author.bot), true);
  assert.ok(seen.some((p) => p.startsWith('/guilds/111111111111111111/messages/search')));
  assert.ok(seen.some((p) => p.startsWith('/guilds/999999999999999999/messages/search')));
});

test('searchDm never calls guild search and never paginates a full dump', async () => {
  const seen = [];
  const request = async (path) => {
    seen.push(path);
    return {
      status: 200,
      body: [
        msg('1', { content: 'old' }),
        msg('2', { content: 'needle in a dm', bot: true, username: 'Ivy' }),
        msg('3', { content: 'newer' }),
      ],
    };
  };
  const out = await search.searchDm({
    request,
    channelId: '666666666666666666',
    query: 'needle',
    around: msg('2').id,
    limit: 99,
  });
  assert.equal(out.ok, true);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^\/channels\/666666666666666666\/messages\?around=555555555555555552&limit=25$/);
  assert.doesNotMatch(seen[0], /\/guilds\//);
  assert.equal(out.messages.some((m) => m.author.bot && m.content.includes('needle')), true);
});

test('foldAccents strips NFD marks so padrón becomes padron', () => {
  assert.equal(search.foldAccents('padrón'), 'padron');
  assert.equal(search.foldAccents('pilón añejo'), 'pilon anejo');
  assert.equal(search.foldAccents('CAFÉ'), 'CAFE');
  assert.equal(search.foldAccents('padron'), 'padron');
});

test('expandQueryVariants includes folded and common Spanish recombinations', () => {
  const padron = search.expandQueryVariants('padron');
  assert.ok(padron.includes('padron'));
  assert.ok(padron.includes('padrón'));
  assert.equal(padron[0], 'padron');

  const accented = search.expandQueryVariants('padrón');
  assert.ok(accented.includes('padrón'));
  assert.ok(accented.includes('padron'));

  const pilon = search.expandQueryVariants('pilon anejo');
  assert.ok(pilon.includes('pilon anejo'));
  assert.ok(pilon.includes('pilón añejo'));

  const mixed = search.expandQueryVariants('pilon añejo');
  assert.ok(mixed.includes('pilon anejo'));
  assert.ok(mixed.includes('pilón añejo'));
  assert.ok(mixed.includes('pilon añejo'));

  assert.deepEqual(search.expandQueryVariants('  pilon   anejo  '), search.expandQueryVariants('pilon anejo'));
  assert.deepEqual(search.expandQueryVariants(''), []);
  assert.deepEqual(search.expandQueryVariants('   '), []);
});

test('expandQueryVariants stays unique and bounded', () => {
  const variants = search.expandQueryVariants('pilon anejo');
  assert.equal(new Set(variants).size, variants.length);
  assert.ok(variants.length >= 2);
  assert.ok(variants.length <= 8);
});

test('mergeHitsByMessageId dedupes by id and round-robins groups', () => {
  const hit = (id, pool) => ({ message: { id: String(id).padStart(18, '5'), pool } });
  const a = [hit('10', 'plain'), hit('11', 'plain'), hit('12', 'plain')];
  const b = [hit('10', 'accent'), hit('20', 'accent'), hit('21', 'accent')];
  const merged = search.mergeHitsByMessageId([a, b]);
  const ids = merged.map((h) => h.message.id);
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5);
  assert.equal(merged[0].message.pool, 'plain');
  assert.ok(merged.some((h) => h.message.pool === 'accent' && h.message.id === hit('20').message.id));

  const manyA = Array.from({ length: 25 }, (_, i) => hit(String(100 + i), 'plain'));
  const manyB = Array.from({ length: 25 }, (_, i) => hit(String(200 + i), 'accent'));
  const capped = search.mergeHitsByMessageId([manyA, manyB], search.SEARCH_LIMIT_MAX);
  assert.equal(capped.length, search.SEARCH_LIMIT_MAX);
  assert.ok(capped.some((h) => h.message.pool === 'plain'));
  assert.ok(capped.some((h) => h.message.pool === 'accent'));
});

test('searchGuilds searches folded and accented variants then dedupes by message id', async () => {
  const seenContent = [];
  const request = async (path) => {
    if (path.includes('/messages/search')) {
      const content = new URL('https://x' + path).searchParams.get('content');
      seenContent.push(content);
      if (content === 'padron') {
        return { status: 200, body: { total_results: 1, messages: [[msg('10', { content: 'the padron box' })]] } };
      }
      if (content === 'padrón') {
        return { status: 200, body: { total_results: 1, messages: [[msg('20', { content: 'the padrón box' })]] } };
      }
      return { status: 200, body: { total_results: 0, messages: [] } };
    }
    if (path.includes('/messages?around=')) return { status: 200, body: [] };
    throw new Error('unexpected path ' + path);
  };
  const out = await search.searchGuilds({
    request,
    guildIds: ['111111111111111111'],
    query: 'padron',
    aroundLimit: 3,
    sleep: async () => {},
  });
  assert.equal(out.ok, true);
  assert.ok(seenContent.includes('padron'));
  assert.ok(seenContent.includes('padrón'));
  const ids = out.hits.map((h) => h.message.id).sort();
  assert.deepEqual(ids, [msg('10').id, msg('20').id].sort());
  assert.equal(out.total, 2);
});

test('searchDm folds accents so padron matches padrón in the capped window', async () => {
  const request = async () => ({
    status: 200,
    body: [
      msg('1', { content: 'old' }),
      msg('2', { content: 'the padrón pairing' }),
      msg('3', { content: 'newer' }),
    ],
  });
  const out = await search.searchDm({
    request,
    channelId: '666666666666666666',
    query: 'padron',
    around: msg('2').id,
    limit: 10,
  });
  assert.equal(out.ok, true);
  assert.equal(out.messages.length, 1);
  assert.match(out.messages[0].content, /padrón/);
});

test('formatHits keeps assistant posts in the printed context', () => {
  const text = search.formatHits([{
    guildId: '111111111111111111',
    message: msg('55', { content: 'ivy pairing note', bot: true, username: 'Ivy' }),
    context: [
      msg('54', { content: 'before' }),
      msg('55', { content: 'ivy pairing note', bot: true, username: 'Ivy' }),
      msg('56', { content: 'after' }),
    ],
  }]);
  assert.match(text, /Ivy/);
  assert.match(text, /ivy pairing note/);
  assert.match(text, /before/);
  assert.match(text, /after/);
  assert.doesNotMatch(text, /skipped bot/i);
});
