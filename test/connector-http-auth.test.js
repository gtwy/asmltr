'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { managerAuthHeaders, requireConnectorToken } = require('../shared/connector-http-auth');

function mockRes() {
  const r = { statusCode: 200, body: null };
  r.status = (n) => { r.statusCode = n; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

test('managerAuthHeaders attaches Bearer when token is set', () => {
  const prev = process.env.ASMLTR_MANAGER_TOKEN;
  process.env.ASMLTR_MANAGER_TOKEN = 'unit-test-token';
  try {
    const h = managerAuthHeaders();
    assert.equal(h['Content-Type'], 'application/json');
    assert.equal(h.Authorization, 'Bearer unit-test-token');
  } finally {
    if (prev == null) delete process.env.ASMLTR_MANAGER_TOKEN;
    else process.env.ASMLTR_MANAGER_TOKEN = prev;
  }
});

test('requireConnectorToken is 401 without token or without header', () => {
  const prev = process.env.ASMLTR_MANAGER_TOKEN;
  delete process.env.ASMLTR_MANAGER_TOKEN;
  try {
    const res = mockRes();
    let next = false;
    requireConnectorToken({ get: () => '' }, res, () => { next = true; });
    assert.equal(next, false);
    assert.equal(res.statusCode, 401);
  } finally {
    if (prev == null) delete process.env.ASMLTR_MANAGER_TOKEN;
    else process.env.ASMLTR_MANAGER_TOKEN = prev;
  }
});

test('requireConnectorToken allows matching Bearer', () => {
  const prev = process.env.ASMLTR_MANAGER_TOKEN;
  process.env.ASMLTR_MANAGER_TOKEN = 'unit-test-token';
  try {
    const res = mockRes();
    let next = false;
    requireConnectorToken({ get: (k) => k.toLowerCase() === 'authorization' ? 'Bearer unit-test-token' : '' }, res, () => { next = true; });
    assert.equal(next, true);
    assert.equal(res.statusCode, 200);
  } finally {
    if (prev == null) delete process.env.ASMLTR_MANAGER_TOKEN;
    else process.env.ASMLTR_MANAGER_TOKEN = prev;
  }
});
