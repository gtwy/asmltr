'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { listTools } = require('../mcp/toolbelt-server');
const { policyFor } = require('../shared/media-allow');
const { botRequest } = require('../shared/discord-search');

test('discord connector declares readable search and token-gates /read', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.match(src, /readable:\s*\{\s*ops:\s*\['search'\]\s*\}/);
  assert.match(src, /app\.post\('\/read',\s*requireConnectorToken/);
  assert.match(src, /shared\/discord-search/);
  assert.match(src, /runSearch/);
  assert.doesNotMatch(src, /author\.bot\s*&&\s*return/);
});

test('invite permission integer still includes READ_MESSAGE_HISTORY', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.match(src, /INVITE_PERMISSIONS = '3525696'/);
  const perms = 3525696;
  assert.equal(!!(perms & 65536), true); // READ_MESSAGE_HISTORY
});

test('public guild owner does not see asmltr_discord_search; owner DM does', () => {
  const owner = { bypass_moderation: true, user_key: 'owner' };
  const guild = listTools(policyFor({
    channel: 'discord', public: true,
    context: { scope_id: 'guild:g1' },
  }, owner).deny);
  assert.equal(guild.some((t) => t.name === 'asmltr_discord_search'), false);
  const dm = listTools(policyFor({
    channel: 'discord', public: false,
    context: { scope_id: 'dm:someone' },
  }, owner).deny);
  assert.equal(dm.some((t) => t.name === 'asmltr_discord_search'), true);
});

test('botRequest sends Bot token to the v10 API', async () => {
  const seen = [];
  const request = botRequest('test-token', async (url, init) => {
    seen.push({ url, init });
    return { status: 200, json: async () => ({ ok: true }) };
  });
  await request('/guilds/111111111111111111/messages/search?content=x');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://discord.com/api/v10/guilds/111111111111111111/messages/search?content=x');
  assert.equal(seen[0].init.headers.Authorization, 'Bot test-token');
});
