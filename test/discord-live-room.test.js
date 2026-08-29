'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { countHumans, roomInstructions } = require('../connectors/types/discord/live-room');

function ch(members) {
  return { members: { values: () => members[Symbol.iterator] ? members : members } };
}

test('countHumans skips Ivy and bots', () => {
  const members = [
    { id: 'ivy', user: { id: 'ivy', bot: true } },
    { id: 'james', user: { id: 'james', bot: false } },
    { id: 'otherbot', user: { id: 'otherbot', bot: true } },
  ];
  assert.equal(countHumans({ members: { values: () => members } }, 'ivy'), 1);
});

test('countHumans two humans', () => {
  const members = [
    { id: 'ivy', user: { id: 'ivy', bot: true } },
    { id: 'james', user: { id: 'james', bot: false } },
    { id: 'jess', user: { id: 'jess', bot: false } },
  ];
  assert.equal(countHumans({ members: { values: () => members } }, 'ivy'), 2);
});

test('countHumans empty / missing is 0', () => {
  assert.equal(countHumans(null, 'ivy'), 0);
  assert.equal(countHumans({}, 'ivy'), 0);
});

test('roomInstructions 1:1 always answer', () => {
  const s = roomInstructions(1);
  assert.match(s, /1:1/);
  assert.match(s, /Every utterance is for you/);
  assert.match(s, /Always answer/);
  assert.doesNotMatch(s, /Stay silent/);
  assert.equal(roomInstructions(0), s);
  assert.equal(roomInstructions(undefined), s);
});

test('roomInstructions group lean-in when welcome', () => {
  const s = roomInstructions(2);
  assert.match(s, /group voice call/);
  assert.match(s, /Lean in when welcome/);
  assert.match(s, /Do not wait for your name/);
  assert.match(s, /question in the air/);
  assert.doesNotMatch(s, /Stay silent unless/);
  assert.doesNotMatch(s, /addressed by name/);
});
