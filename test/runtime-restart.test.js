'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const runtime = require('../shared/runtime.js');

test('ASMLTR_SERVICES is exported as an array', () => {
  assert.ok(Array.isArray(runtime.ASMLTR_SERVICES));
});

test('ASMLTR_SERVICES lists all three PM2 services the SDK bump touches', () => {
  for (const svc of ['asmltr-core', 'asmltr-connector-manager', 'asmltr-insights-collector']) {
    assert.ok(runtime.ASMLTR_SERVICES.includes(svc), `missing ${svc}`);
  }
});

test('the SDK auto-update restart cycles more than core alone', () => {
  // The split-brain bug was a core-only restart; parity with the three services is the fix.
  assert.ok(runtime.ASMLTR_SERVICES.length >= 3);
});
