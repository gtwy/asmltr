'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { screenEnv } = require('../shared/mux.js');

// screen 4.x mangles an app's SGR mouse reports so they leak into the session as text (issue #89).
// screen sessions therefore launch the claude engine with mouse disabled, which also restores the
// terminal's native wheel-scrollback. These cover the pure env-building decision behind that.

test('screenEnv disables claude mouse by default', () => {
  assert.equal(screenEnv({}).CLAUDE_CODE_DISABLE_MOUSE, '1');
});

test('screenEnv preserves the base environment', () => {
  const e = screenEnv({ PATH: '/usr/bin', ASSISTANT_NAME: 'Thor' });
  assert.equal(e.PATH, '/usr/bin');
  assert.equal(e.ASSISTANT_NAME, 'Thor');
  assert.equal(e.CLAUDE_CODE_DISABLE_MOUSE, '1');
});

test('screenEnv honors an explicit CLAUDE_CODE_DISABLE_MOUSE (opt back in to mouse)', () => {
  assert.equal(screenEnv({ CLAUDE_CODE_DISABLE_MOUSE: '0' }).CLAUDE_CODE_DISABLE_MOUSE, '0');
});
