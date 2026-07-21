'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isStale, heartbeatHealth, staleThresholdMs, DEFAULT_STALE_MS } = require('../connectors/manager/health.js');

const THRESHOLD = 120000;
const NOW = 1_700_000_000_000; // fixed clock so the assertions never depend on Date.now()

test('a fresh heartbeat (age < threshold) is healthy', () => {
  const last = NOW - 30000; // 30s old, well under 120s
  assert.equal(isStale(last, NOW, THRESHOLD), false);
  const h = heartbeatHealth(last, NOW, THRESHOLD);
  assert.equal(h.heartbeat, 'alive');
  assert.equal(h.healthy, true);
  assert.equal(h.lastHeartbeatAgeMs, 30000);
});

test('an old heartbeat (age > threshold) is stale', () => {
  const last = NOW - 200000; // 200s old, past 120s
  assert.equal(isStale(last, NOW, THRESHOLD), true);
  const h = heartbeatHealth(last, NOW, THRESHOLD);
  assert.equal(h.heartbeat, 'stale');
  assert.equal(h.healthy, false);
  assert.equal(h.lastHeartbeatAgeMs, 200000);
});

test('a connector that never sent a heartbeat is unknown, not stale', () => {
  for (const never of [null, undefined, 0]) {
    assert.equal(isStale(never, NOW, THRESHOLD), false, `isStale(${never}) must be false`);
    const h = heartbeatHealth(never, NOW, THRESHOLD);
    assert.equal(h.heartbeat, 'unknown');
    assert.equal(h.healthy, null);
    assert.equal(h.lastHeartbeatAgeMs, null);
  }
});

test('the threshold boundary is not stale until age exceeds it', () => {
  const atThreshold = NOW - THRESHOLD; // age === threshold, not yet past
  assert.equal(isStale(atThreshold, NOW, THRESHOLD), false);
  const justPast = NOW - THRESHOLD - 1; // one ms past
  assert.equal(isStale(justPast, NOW, THRESHOLD), true);
});

test('staleThresholdMs reads ASMLTR_HEARTBEAT_STALE_MS, else defaults to 120000', () => {
  assert.equal(DEFAULT_STALE_MS, 120000);
  assert.equal(staleThresholdMs({ ASMLTR_HEARTBEAT_STALE_MS: '5000' }), 5000);
  assert.equal(staleThresholdMs({}), 120000);
  assert.equal(staleThresholdMs({ ASMLTR_HEARTBEAT_STALE_MS: 'nonsense' }), 120000);
  assert.equal(staleThresholdMs({ ASMLTR_HEARTBEAT_STALE_MS: '0' }), 120000); // 0 is not a valid window
});
