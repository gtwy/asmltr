'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { countHumans, roomInstructions, shouldForceTurn } = require('../connectors/types/discord/live-room');

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
  assert.match(s, /target of the comment/);
  assert.match(s, /Do not jump in whenever there is a pause/);
  assert.match(s, /stay out/i);
  assert.doesNotMatch(s, /Stay silent unless/);
  assert.doesNotMatch(s, /Err on talking too much/);
});
test('wasNotForHer is session skip not mute', () => {
  const { wasNotForHer, roomSkipNote } = require('../connectors/types/discord/live-room');
  assert.equal(wasNotForHer("that wasn't for you"), true);
  assert.equal(wasNotForHer('not you ivy'), true);
  assert.equal(wasNotForHer('hold on'), true);
  assert.equal(wasNotForHer('stop'), true);
  assert.equal(wasNotForHer('how are you doing'), false);
  assert.match(roomSkipNote(), /Answer the next turn/);
});

test("shouldForceTurn 1:1 when her mouth is idle", () => {
  assert.equal(shouldForceTurn({ humans: 1, herMouth: false }), true);
  assert.equal(shouldForceTurn({ humans: 0, herMouth: false }), true);
  assert.equal(shouldForceTurn({ humans: 1, herMouth: true }), false);
  assert.equal(shouldForceTurn({ humans: 2, herMouth: false }), false);
});
test("isGroupAddressee named or latch, not other humans", () => {
  const { isGroupAddressee } = require('../connectors/types/discord/live-room');
  assert.equal(isGroupAddressee({ humans: 1, named: false, speakerId: 'a' }), true);
  assert.equal(isGroupAddressee({ humans: 2, named: false, speakerId: 'james' }), true);
  assert.equal(isGroupAddressee({ humans: 2, named: false, speakerId: 'james', lastSpeakerId: 'james' }), true);
  assert.equal(isGroupAddressee({ humans: 2, named: false, speakerId: 'derek', lastSpeakerId: 'james', lastAnsweredId: 'james' }), false);
  assert.equal(isGroupAddressee({ humans: 2, named: true, speakerId: 'derek', lastSpeakerId: 'james', lastAnsweredId: 'james' }), true);
  assert.equal(isGroupAddressee({ humans: 2, named: false, speakerId: 'james', lastAnsweredId: 'james', lastSpeakerId: 'derek' }), true);
});

test('countHumansNow cache miss must not return 1 (group would become 1:1)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  const fn = src.slice(src.indexOf('function countHumansNow'), src.indexOf('function liveRoomLine'));
  assert.match(fn, /never fake 1:1/);
  assert.equal(/return 1/.test(fn), false);
  assert.match(fn, /return 2/);
  // countHumans itself still returns 0 on empty; shouldForceTurn(0) is 1:1, so Now must not pass 0/1 on miss.
  assert.equal(shouldForceTurn({ humans: 0, herMouth: false }), true);
  assert.equal(shouldForceTurn({ humans: 1, herMouth: false }), true);
  assert.equal(shouldForceTurn({ humans: 2, herMouth: false }), false);
});
