'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = path.join(os.tmpdir(), `asmltr-notify-test-${process.pid}.json`);
process.env.ASMLTR_NOTIFY_FILE = TMP;

// A mock connector-manager /send: android speak is controllable; text always succeeds. Records calls.
let androidDelivers = false;
const calls = [];
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d)).on('end', () => {
    const body = JSON.parse(b || '{}');
    calls.push(body);
    let out;
    if (body.kind === 'speak') out = androidDelivers ? { ok: true, delivered: 1 } : { ok: false, delivered: 0, error: 'no device' };
    else out = { ok: true, status: 200 };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
  });
});

test.before(() => new Promise((r) => srv.listen(0, '127.0.0.1', () => { process.env.ASMLTR_MANAGER_URL = 'http://127.0.0.1:' + srv.address().port; r(); })));
test.after(() => { srv.close(); try { fs.unlinkSync(TMP); } catch (_) {} });

function notify() { delete require.cache[require.resolve('../shared/notify')]; return require('../shared/notify'); }

test('ladder falls through android → text when no device, and delivers via text', async () => {
  const n = notify();
  n.setConfig({ text_fallback: { channel: 'telegram', target: 'me' }, quiet_hours: { start: 0, end: 0 } });
  androidDelivers = false; calls.length = 0;
  const r = await n.notify({ text: 'brief', title: 'Morning' });
  assert.equal(r.delivered, true);
  assert.equal(r.via, 'text');
  assert.equal(r.steps[0].step, 'android');
  assert.equal(r.steps[0].ok, false);
  // the text step prefixes the title
  const textCall = calls.find((c) => c.kind === 'text');
  assert.match(textCall.text, /Morning/);
});

test('android wins when a device is reachable (text never attempted)', async () => {
  const n = notify();
  n.setConfig({ text_fallback: { channel: 'telegram', target: 'me' }, quiet_hours: { start: 0, end: 0 } });
  androidDelivers = true; calls.length = 0;
  const r = await n.notify({ text: 'hi' });
  assert.equal(r.delivered, true);
  assert.equal(r.via, 'android');
  assert.equal(calls.filter((c) => c.kind === 'text').length, 0);
});

test('quiet hours suppress the spoken step but text still goes', async () => {
  const n = notify();
  n.setConfig({ text_fallback: { channel: 'telegram', target: 'me' }, quiet_hours: { start: 0, end: 24 } });
  androidDelivers = true; calls.length = 0;
  const r = await n.notify({ text: 'late one' }); // not forced → quiet hours apply
  assert.equal(r.steps[0].skipped, 'quiet-hours');
  assert.equal(calls.filter((c) => c.kind === 'speak').length, 0);
  assert.equal(r.via, 'text');
  // force overrides quiet hours → android is attempted again
  calls.length = 0;
  const r2 = await n.notify({ text: 'urgent', force: true });
  assert.equal(r2.via, 'android');
});

test('undelivered when no step is reachable', async () => {
  const n = notify();
  n.setConfig({ text_fallback: null, quiet_hours: { start: 0, end: 0 } });
  androidDelivers = false;
  const r = await n.notify({ text: 'nowhere' });
  assert.equal(r.delivered, false);
  assert.equal(r.via, null);
});

test('inQuietHours handles the overnight wrap', () => {
  const n = notify();
  const at = (h) => new Date(2026, 0, 1, h, 0, 0);
  const cfg = { quiet_hours: { start: 23, end: 8 } };
  assert.equal(n.inQuietHours(cfg, at(2)), true);   // 2am inside 23→8
  assert.equal(n.inQuietHours(cfg, at(23)), true);  // 23:00 start inclusive
  assert.equal(n.inQuietHours(cfg, at(8)), false);  // 8am end exclusive
  assert.equal(n.inQuietHours(cfg, at(12)), false); // midday outside
});
