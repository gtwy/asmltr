'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { engineForEnvelope, isDiscordTextIngress } = require('../shared/discord-engine-route');

test('Discord DM and guild text ingress are ACP (grok), never STANDARD', () => {
  assert.equal(isDiscordTextIngress({
    channel: 'discord',
    conversation_key: 'discord:bot:dm:111',
    public: false,
  }), true);
  assert.equal(engineForEnvelope({
    channel: 'discord',
    conversation_key: 'discord:bot:dm:111',
    public: false,
  }, { engine: 'claude' }), 'grok');

  assert.equal(isDiscordTextIngress({
    channel: 'discord',
    conversation_key: 'discord:bot:channel:222',
    public: true,
    context: { scope_id: 'guild:99' },
  }), true);
  assert.equal(engineForEnvelope({
    channel: 'discord',
    conversation_key: 'discord:bot:channel:222',
    public: true,
  }, { engine: 'claude' }), 'grok');
});

test('Discord voice stays off the ACP text route so STANDARD/voice can keep using it', () => {
  const voice = {
    channel: 'discord',
    conversation_key: 'discord-voice:bot:guild:99',
    channel_context: { voice: true },
    public: true,
  };
  assert.equal(isDiscordTextIngress(voice), false);
  assert.equal(engineForEnvelope(voice, { engine: 'claude' }), 'claude');
  assert.equal(engineForEnvelope(voice, {}), undefined);
});

test('email / github / schedule / mcp stay on caller engine (STANDARD default)', () => {
  for (const channel of ['email', 'github', 'mcp', 'assistant-web']) {
    const env = { channel, conversation_key: `${channel}:1`, public: false };
    assert.equal(isDiscordTextIngress(env), false, channel);
    assert.equal(engineForEnvelope(env, { engine: 'claude' }), 'claude', channel);
    assert.equal(engineForEnvelope(env, {}), undefined, channel);
  }
});

test('ASMLTR_DISCORD_ACP_ENGINE can override the ACP id; claude is refused', () => {
  const prev = process.env.ASMLTR_DISCORD_ACP_ENGINE;
  try {
    process.env.ASMLTR_DISCORD_ACP_ENGINE = 'grok';
    assert.equal(engineForEnvelope({ channel: 'discord', conversation_key: 'discord:bot:dm:1' }), 'grok');
    process.env.ASMLTR_DISCORD_ACP_ENGINE = 'claude';
    assert.equal(engineForEnvelope({ channel: 'discord', conversation_key: 'discord:bot:dm:1' }), 'grok');
  } finally {
    if (prev == null) delete process.env.ASMLTR_DISCORD_ACP_ENGINE;
    else process.env.ASMLTR_DISCORD_ACP_ENGINE = prev;
  }
});

test('core handle routes Discord text through engineForEnvelope; STANDARD adapter stays in tree', () => {
  const server = fs.readFileSync(path.join(__dirname, '../core/src/server.js'), 'utf8');
  assert.match(server, /discord-engine-route/);
  assert.match(server, /engineForEnvelope/);
  assert.equal(fs.existsSync(path.join(__dirname, '../core/src/engines/claude.js')), true);
  const discord = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.equal(/engine:\s*['"]claude['"]/.test(discord), false);
});
