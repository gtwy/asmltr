'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const grok = require('../core/src/engines/grok');
const { policyFor, denyToolsEnv, parseDenyEnv, exitIfDenied } = require('../shared/media-allow');

const voiceKey = 'discord-voice:gaia:guild:1';

function toolsOf(args) {
  const i = args.indexOf('--tools');
  return i >= 0 ? args[i + 1] : undefined;
}

test('voice denyAll / voice envelope empties grok tools (tools:[])', () => {
  const viaFlag = grok.buildArgs({ prompt: 'can you hear me', denyAll: true, channel: 'discord', conversationKey: voiceKey });
  const viaKey = grok.buildArgs({ prompt: 'access my calendar and implement the fix', channel: 'discord', conversationKey: voiceKey });
  const viaCtx = grok.buildArgs({ prompt: 'look up the Padron', channel: 'discord', channel_context: { voice: true } });
  for (const [label, args] of [['flag', viaFlag], ['key', viaKey], ['ctx', viaCtx]]) {
    assert.ok(args.includes('--tools'), label + ' --tools');
    assert.equal(toolsOf(args), '', label + ' empty allowlist');
    assert.ok(args.includes('--disable-web-search'), label);
    assert.ok(args.includes('--no-subagents'), label);
    assert.ok(args.includes('MCPTool'), label + ' MCP deny');
    const i = args.indexOf('--disallowed-tools');
    assert.ok(i >= 0, label + ' disallowed');
    assert.match(args[i + 1], /web_search/);
    assert.equal(args[args.indexOf('--effort') + 1], 'low', label + ' effort');
  }
});

test('discord text buildArgs does not empty tools', () => {
  process.env.ASMLTR_GROK_EFFORT = 'medium';
  try {
    const args = grok.buildArgs({ prompt: 'ok thanks', channel: 'discord' });
    assert.equal(args.includes('--tools'), false);
    assert.equal(args.includes('--disable-web-search'), false);
    assert.equal(args.includes('MCPTool'), false);
    assert.equal(args[args.indexOf('--effort') + 1], 'medium');
  } finally {
    delete process.env.ASMLTR_GROK_EFFORT;
  }
});

test('voice turn tool list is empty and invoke is refused', () => {
  const env = {
    channel: 'discord',
    conversation_key: voiceKey,
    channel_context: { voice: true, guildId: '1' },
  };
  const pol = policyFor(env, { bypass_moderation: true, user_key: 'owner' });
  assert.equal(pol.deny.all, true);
  const parsed = parseDenyEnv(denyToolsEnv(pol.deny));
  assert.equal(parsed.shell, true);
  assert.equal(parsed.send, true);
  assert.equal(parsed.streams, true);
  assert.equal(parsed.write, true);

  const prev = process.env.ASMLTR_DENY_TOOLS;
  process.env.ASMLTR_DENY_TOOLS = denyToolsEnv(pol.deny);
  const realExit = process.exit;
  let code;
  process.exit = (c) => { code = c; throw new Error('exited'); };
  try {
    try { exitIfDenied('shell'); assert.fail('shell should refuse'); } catch (e) { assert.equal(e.message, 'exited'); }
    assert.equal(code, 2);
    try { exitIfDenied('send'); assert.fail('send should refuse'); } catch (e) { assert.equal(e.message, 'exited'); }
    assert.equal(code, 2);
  } finally {
    process.exit = realExit;
    if (prev === undefined) delete process.env.ASMLTR_DENY_TOOLS;
    else process.env.ASMLTR_DENY_TOOLS = prev;
  }
});
