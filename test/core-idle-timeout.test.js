'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const coreTimeout = require('../connectors/types/discord/core-timeout');

// SSE server: one effort frame, then silence for `silentMs`, then done. `die` destroys the socket
// mid-silence instead (a core that crashed mid-turn).
function sseServer({ silentMs, die = false }) {
  return http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ type: 'effort', effort: 'medium' }) + '\n\n');
    setTimeout(() => {
      if (die) { res.socket.destroy(); return; }
      res.write('data: ' + JSON.stringify({ type: 'done', actions: [{ type: 'reply', text: 'late answer' }] }) + '\n\n');
      res.end();
    }, silentMs);
  });
}

// /v2/handle-style server: headers only when the turn finishes (or never, when it dies).
function handleServer({ silentMs, die = false }) {
  return http.createServer((req, res) => {
    req.resume();
    setTimeout(() => {
      if (die) { req.socket.destroy(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ actions: [{ type: 'reply', text: 'late answer' }] }));
    }, silentMs);
  });
}

async function withClient(srv, envMs, fn) {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const prev = process.env.ASMLTR_CORE_TIMEOUT_MS;
  process.env.ASMLTR_CORE_TIMEOUT_MS = String(envMs);
  delete require.cache[require.resolve('../connectors/sdk')];
  const { makeCoreClient } = require('../connectors/sdk');
  const core = makeCoreClient('http://127.0.0.1:' + srv.address().port + '/v2/handle');
  if (prev == null) delete process.env.ASMLTR_CORE_TIMEOUT_MS; else process.env.ASMLTR_CORE_TIMEOUT_MS = prev;
  try { return await fn(core); } finally { srv.closeAllConnections && srv.closeAllConnections(); srv.close(); }
}

const REPLY = [{ type: 'reply', text: 'late answer' }];

test('handleStream: idleTimeoutMs 0 waits out silence past the SDK default', async () => {
  const actions = await withClient(sseServer({ silentMs: 400 }), 100, (core) => core.handleStream({ text: 'hi' }, {}, { idleTimeoutMs: 0 }));
  assert.deepEqual(actions, REPLY);
});

test('handleStream: omitted opts keeps the SDK default idle timeout', async () => {
  await assert.rejects(withClient(sseServer({ silentMs: 400 }), 100, (core) => core.handleStream({ text: 'hi' }, {})), /timed out/);
});

test('handleStream: per-call idleTimeoutMs overrides the SDK default both ways', async () => {
  const longer = await withClient(sseServer({ silentMs: 300 }), 100, (core) => core.handleStream({ text: 'hi' }, {}, { idleTimeoutMs: 1000 }));
  assert.deepEqual(longer, REPLY);
  await assert.rejects(withClient(sseServer({ silentMs: 400 }), 5000, (core) => core.handleStream({ text: 'hi' }, {}, { idleTimeoutMs: 100 })), /timed out/);
});

test('handleStream: idleTimeoutMs 0 still rejects when the core dies mid-turn', async () => {
  await assert.rejects(
    withClient(sseServer({ silentMs: 100, die: true }), 60000, (core) => core.handleStream({ text: 'hi' }, {}, { idleTimeoutMs: 0 })),
    /closed the connection|aborted|socket hang up|ECONNRESET/,
  );
});

test('handle: idleTimeoutMs 0 waits out silence; a dead core still rejects', async () => {
  const actions = await withClient(handleServer({ silentMs: 400 }), 100, (core) => core.handle({ text: 'hi' }, { idleTimeoutMs: 0 }));
  assert.deepEqual(actions, REPLY);
  await assert.rejects(
    withClient(handleServer({ silentMs: 100, die: true }), 60000, (core) => core.handle({ text: 'hi' }, { idleTimeoutMs: 0 })),
    /socket hang up|ECONNRESET|closed the connection/,
  );
  await assert.rejects(withClient(handleServer({ silentMs: 400 }), 100, (core) => core.handle({ text: 'hi' })), /timed out/);
});

test('discord core-timeout: owner DM none, guild 30 min, other SDK default', () => {
  const { coreRequestOpts, coreOptsForMessage, guildCoreTimeoutMs, isOwnerDm, GUILD_CORE_TIMEOUT_MS } = coreTimeout;
  assert.equal(GUILD_CORE_TIMEOUT_MS, 30 * 60 * 1000);
  assert.deepEqual(coreRequestOpts({ ownerDm: true }, {}), { idleTimeoutMs: 0 });
  assert.deepEqual(coreRequestOpts({ guild: true }, {}), { idleTimeoutMs: 30 * 60 * 1000 });
  assert.deepEqual(coreRequestOpts({}, {}), {});
  assert.equal(guildCoreTimeoutMs({ ASMLTR_DISCORD_GUILD_CORE_TIMEOUT_MS: '120000' }), 120000);
  assert.equal(guildCoreTimeoutMs({ ASMLTR_DISCORD_GUILD_CORE_TIMEOUT_MS: '0' }), 0);
  assert.equal(guildCoreTimeoutMs({ ASMLTR_DISCORD_GUILD_CORE_TIMEOUT_MS: 'bogus' }), 30 * 60 * 1000);
  assert.equal(guildCoreTimeoutMs({ ASMLTR_DISCORD_GUILD_CORE_TIMEOUT_MS: '' }), 30 * 60 * 1000);

  const owner = '111';
  const dm = { channel: { type: 1 }, author: { id: '111' } };
  const legacyDm = { channel: { type: 'DM' }, author: { id: '111' } };
  const otherDm = { channel: { type: 1 }, author: { id: '222' } };
  const guild = { guild: { id: '9' }, channel: { type: 0 }, author: { id: '111' } };
  assert.equal(isOwnerDm(dm, owner), true);
  assert.equal(isOwnerDm(legacyDm, owner), true);
  assert.equal(isOwnerDm(otherDm, owner), false);
  assert.equal(isOwnerDm(guild, owner), false, 'owner in a guild channel is not the DM');
  assert.equal(isOwnerDm(dm, ''), false, 'no configured owner');
  assert.deepEqual(coreOptsForMessage(dm, owner, {}), { idleTimeoutMs: 0 });
  assert.deepEqual(coreOptsForMessage(guild, owner, {}), { idleTimeoutMs: 30 * 60 * 1000 });
  assert.deepEqual(coreOptsForMessage(otherDm, owner, {}), {});
});

test('discord connector passes the per-surface opts on every turn call', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'connectors', 'types', 'discord', 'index.js'), 'utf8');
  assert.match(src, /const coreOpts = coreTimeout\.coreOptsForMessage\(message, dmUser\);/);
  assert.match(src, /\}, coreOpts\);\n\s+stopBeat\(\);/, 'text streaming turn');
  assert.match(src, /ctx\.core\.handle\(envelope, coreOpts\)/, 'text non-streaming turn');
  assert.match(src, /flush\(false\); \}, coreTimeout\.coreRequestOpts\(\{ guild: true \}\)\)/, 'voice turn');
});
