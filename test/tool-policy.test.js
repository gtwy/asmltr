'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { policyFor, denyToolsEnv } = require('../shared/tool-policy');
const { buildToolbeltPrompt } = require('../shared/toolbelt-prompt');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-tool-policy-'));
const allowFile = path.join(tmp, 'tool-policy.json');
fs.writeFileSync(allowFile, JSON.stringify({
  siloAllow: { guilds: ['guild-allow-1'], channels: [] },
}));
process.env.ASMLTR_TOOL_POLICY_FILE = allowFile;

test('public discord denies shell/streams/send/silo', () => {
  const p = policyFor({
    channel: 'discord', public: true,
    context: { scope_id: 'guild:other-guild' },
    channel_context: { channelId: 'ch1' },
  }, { bypass_moderation: false });
  assert.equal(p.restricted, true);
  assert.deepEqual(p.deny, { shell: true, streams: true, send: true, silo: true, write: true, siloWrite: true });
});

test('allowlisted guild keeps silo, still denies shell/streams/send', () => {
  const p = policyFor({
    channel: 'discord', public: true,
    context: { scope_id: 'guild:guild-allow-1' },
    channel_context: { channelId: 'ch1' },
  }, { bypass_moderation: false });
  assert.deepEqual(p.deny, { shell: true, streams: true, send: true, silo: false, write: true, siloWrite: true });
});

test('discord DM + bypass_moderation denies nothing', () => {
  const p = policyFor({
    channel: 'discord', public: false,
    context: { scope_id: 'dm:someone' },
  }, { bypass_moderation: true });
  assert.equal(p.restricted, false);
  assert.deepEqual(p.deny, { shell: false, streams: false, send: false, silo: false, write: false, siloWrite: false });
});

test('discord DM without bypass is restricted', () => {
  const p = policyFor({
    channel: 'discord', public: false,
    context: { scope_id: 'dm:stranger' },
  }, { bypass_moderation: false });
  assert.equal(p.restricted, true);
  assert.equal(p.deny.shell, true);
  assert.equal(p.deny.send, true);
});

test('email and mcp deny nothing', () => {
  for (const ch of ['email', 'mcp', 'core', 'assistant-web']) {
    const p = policyFor({ channel: ch, public: false }, { bypass_moderation: false });
    assert.equal(p.restricted, false, ch);
    assert.deepEqual(p.deny, { shell: false, streams: false, send: false, silo: false, write: false, siloWrite: false }, ch);
  }
});

test('restricted prompt omits send/streams/silo/bash-silo', () => {
  const text = buildToolbeltPrompt({
    deny: { shell: true, streams: true, send: true, silo: true },
    selfSiloDir: '/tmp/self',
    attachments: true,
    channel: 'discord',
    chTarget: 'ch1',
  });
  assert.equal(text.includes('asmltr send'), false);
  assert.equal(text.includes('asmltr streams'), false);
  assert.equal(text.includes('asmltr announce'), false);
  assert.equal(text.includes('SELF SILO'), false);
  assert.equal(text.includes('asmltr silo'), false);
  assert.equal(/use the Bash tool/.test(text), false);
  assert.ok(text.includes('asmltr ls'));
});

test('allowlisted silo + no bash advertises silo MCP not Bash silo', () => {
  const text = buildToolbeltPrompt({
    deny: { shell: true, streams: true, send: true, silo: false, siloWrite: true },
    selfSiloDir: '/tmp/self',
  });
  assert.ok(text.includes('SELF SILO'));
  assert.ok(text.includes('asmltr_silo_find'));
  assert.equal(text.includes('use the Bash tool'), false);
  assert.equal(text.includes('asmltr send'), false);
  assert.equal(text.includes('asmltr streams'), false);
  assert.equal(text.includes('asmltr announce'), false);
  assert.equal(text.includes('asmltr silo put'), false);
  assert.equal(text.includes('NaN'), false);
  assert.ok(text.includes('asmltr silo get'));
});

test('silo prompt has no NaN; put only when siloWrite is allowed', () => {
  const owner = buildToolbeltPrompt({ deny: {}, selfSiloDir: '/tmp/self', bypassModeration: true });
  assert.equal(owner.includes('NaN'), false);
  assert.ok(owner.includes('asmltr silo put'));
  const ro = buildToolbeltPrompt({
    deny: { siloWrite: true },
    selfSiloDir: '/tmp/self',
  });
  assert.equal(ro.includes('NaN'), false);
  assert.equal(ro.includes('asmltr silo put'), false);
});

test('denyToolsEnv lists denied kinds', () => {
  assert.equal(denyToolsEnv({ shell: true, streams: true, send: true, silo: true, write: true, siloWrite: true }), 'shell,streams,send,silo,write,siloWrite');
  assert.equal(denyToolsEnv({ shell: true, streams: true, send: true, silo: false, write: true, siloWrite: true }), 'shell,streams,send,write,siloWrite');
});
