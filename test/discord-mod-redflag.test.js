'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { shouldNotifyModBlock } = require('../core/src/mod-redflag');

test('high-risk blocks still notify; awake guild ACP notifies on any deny', () => {
  const awake = {
    channel: 'discord', public: true,
    channel_context: { acpAwake: true, channelId: 'ch1' },
  };
  assert.equal(shouldNotifyModBlock(awake, { allowed: false, riskLevel: 3 }), true);
  assert.equal(shouldNotifyModBlock({
    channel: 'discord', public: true, channel_context: { acpAwake: false },
  }, { allowed: false, riskLevel: 3 }), false);
  assert.equal(shouldNotifyModBlock({
    channel: 'email', public: false,
  }, { allowed: false, riskLevel: 8 }), true);
  assert.equal(shouldNotifyModBlock(awake, { allowed: true, riskLevel: 9 }), false);
});

test('core uses shouldNotifyModBlock instead of a bare risk>=7 check', () => {
  const src = fs.readFileSync(path.join(__dirname, '../core/src/server.js'), 'utf8');
  assert.match(src, /shouldNotifyModBlock/);
  assert.match(src, /mod-redflag/);
});
