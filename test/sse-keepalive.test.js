'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startSseKeepalive, keepaliveMs, DEFAULT_KEEPALIVE_MS } = require('../shared/sse-keepalive');

function sseServer({ keepalive }) {
  return http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ type: 'effort', effort: 'medium' }) + '\n\n');
    const stop = keepalive ? startSseKeepalive(res, 50) : () => {};
    // A silent turn longer than the client's idle-socket timeout.
    setTimeout(() => {
      stop();
      res.write('data: ' + JSON.stringify({ type: 'done', actions: [{ type: 'reply', text: 'late answer' }] }) + '\n\n');
      res.end();
    }, 600);
  });
}

async function runStream(keepalive) {
  const srv = sseServer({ keepalive });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const prev = process.env.ASMLTR_CORE_TIMEOUT_MS;
  process.env.ASMLTR_CORE_TIMEOUT_MS = '250';
  delete require.cache[require.resolve('../connectors/sdk')];
  const { makeCoreClient } = require('../connectors/sdk');
  const core = makeCoreClient('http://127.0.0.1:' + srv.address().port + '/v2/handle');
  if (prev == null) delete process.env.ASMLTR_CORE_TIMEOUT_MS; else process.env.ASMLTR_CORE_TIMEOUT_MS = prev;
  try {
    return await core.handleStream({ text: 'hi' }, {});
  } finally {
    srv.close();
  }
}

test('silent SSE turn past the SDK idle timeout is destroyed without keepalive', async () => {
  await assert.rejects(runStream(false), /timed out/);
});

test('keepalive comment frames keep a silent turn alive; client ignores them', async () => {
  const actions = await runStream(true);
  assert.deepEqual(actions, [{ type: 'reply', text: 'late answer' }]);
});

test('startSseKeepalive writes comment frames and stops cleanly', async () => {
  const writes = [];
  const res = { writableEnded: false, destroyed: false, write: (s) => { writes.push(s); return true; } };
  const stop = startSseKeepalive(res, 20);
  await new Promise((r) => setTimeout(r, 75));
  stop();
  const n = writes.length;
  assert.ok(n >= 2, 'keepalives written: ' + n);
  assert.ok(writes.every((w) => w === ': keepalive\n\n'));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(writes.length, n, 'no writes after stop');
  stop();
});

test('keepaliveMs: default 60s, env override, 0 disables', () => {
  assert.equal(DEFAULT_KEEPALIVE_MS, 60000);
  assert.equal(keepaliveMs(undefined), Number(process.env.ASMLTR_SSE_KEEPALIVE_MS || 60000));
  assert.equal(keepaliveMs(1500), 1500);
  assert.equal(keepaliveMs('bogus'), 60000);
  assert.equal(keepaliveMs(0), 0);
  const writes = [];
  const stop = startSseKeepalive({ write: (s) => writes.push(s) }, 0);
  stop();
  assert.equal(writes.length, 0);
});
