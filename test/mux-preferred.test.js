'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { preferred } = require('../shared/mux.js');

// preferred() is the pure env-to-preference parse (no availability shell-out): screen is the default,
// tmux only when ASMLTR_MULTIPLEXER explicitly asks for it.
test('preferred() defaults to screen and treats tmux as opt-in', () => {
  assert.equal(preferred(undefined), 'screen');   // unset → screen
  assert.equal(preferred(''), 'screen');          // empty → screen
  assert.equal(preferred('tmux'), 'tmux');         // explicit tmux
  assert.equal(preferred('TMUX'), 'tmux');         // case-insensitive
  assert.equal(preferred('screen'), 'screen');     // explicit screen
  assert.equal(preferred('garbage'), 'screen');    // unknown → screen
});
