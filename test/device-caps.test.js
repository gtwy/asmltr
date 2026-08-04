'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { capsDescriptor, meta } = require('../connectors/types/device/index.js');

// The generic `device` connector injects a one-line surface descriptor (as system_prompt_extra) that
// tells the model what the device can do. These cover the pure descriptor builder; the change-ONLY
// injection (never per-turn) is exercised by the connector smoke test.

test('meta declares the generic device type', () => {
  assert.equal(meta.type, 'device');
  assert.equal(meta.configSchema.properties.conversation_scope.default, 'device');
});

test('a screen + speaker device gets dims and a both-shown-and-spoken note', () => {
  const d = capsDescriptor({ screen: { w: 480, h: 800 }, audio_out: true }, 'desk buddy');
  assert.match(d, /desk buddy/);
  assert.match(d, /480×800/);
  assert.match(d, /shown on the screen and read aloud/i);
});

test('an audio-only device gets speakable-prose guidance (no markdown)', () => {
  const d = capsDescriptor({ audio_out: true }, 'speaker');
  assert.match(d, /READ ALOUD/i);
  assert.match(d, /no markdown/i);
  assert.doesNotMatch(d, /screen/i);
});

test('a screen-only device is told it can show formatted output', () => {
  const d = capsDescriptor({ screen: { w: 1024, h: 600 } }, 'kiosk');
  assert.match(d, /show formatted/i);
  assert.doesNotMatch(d, /read aloud/i);
});

test('no declared capabilities → no descriptor (empty string)', () => {
  assert.equal(capsDescriptor({}, 'device'), '');
  assert.equal(capsDescriptor(null, 'device'), '');
});
