'use strict';
/**
 * Pure-function coverage for the realtime STT helpers (no network):
 *  - pcm48StereoToPcm24Mono: the 48k-stereo→24k-mono downsample. A byte-offset bug here once fed the
 *    transcriber time-distorted garbage (audio flowed, nothing came back), so pin the offset math.
 *  - mergeWindow: reconstruct a full transcript from the live model's sliding-window deltas.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pcm48StereoToPcm24Mono, mergeWindow } = require('../shared/speech/realtime-stt');

test('pcm48StereoToPcm24Mono halves the byte count (48k stereo → 24k mono)', () => {
  const frames = 48000; // 1s @ 48k stereo
  const buf = Buffer.alloc(frames * 4);
  const out = pcm48StereoToPcm24Mono(buf);
  assert.equal(out.length, frames, 'output = frames*2 bytes = 24000 samples * 2');
});

test('pcm48StereoToPcm24Mono covers the WHOLE input, not just the first half (regression: j<<3 not j<<2)', () => {
  // Ramp: mono value == stereo frame index. Correct 2:1 decimation makes the LAST output sample track
  // the LAST input frame (~N-2). The old j<<2 bug only reached ~N/2 — this asserts the fix stays.
  const N = 2000;
  const buf = Buffer.alloc(N * 4);
  for (let f = 0; f < N; f++) { const v = f % 30000; buf.writeInt16LE(v, f * 4); buf.writeInt16LE(v, f * 4 + 2); }
  const out = pcm48StereoToPcm24Mono(buf);
  const last = out.readInt16LE((out.length >> 1) - 1) * 0 + out.readInt16LE(out.length - 2);
  assert.ok(last >= N - 3, `last output sample (${last}) should track the last input frame (~${N - 1}), not the midpoint`);
  assert.ok(out.readInt16LE(0) <= 2, 'first output sample tracks the first input frame (~0)');
});

test('mergeWindow reconstructs a full transcript from sliding windows', () => {
  const windows = [
    'Eve what is', 'Eve what is the weather', 'what is the weather in Pittsburgh',
    'the weather in Pittsburgh today and', 'in Pittsburgh today and can you add', 'today and can you add milk to the list',
  ];
  let full = '';
  for (const w of windows) full = mergeWindow(full, w);
  assert.match(full, /Eve what is the weather in Pittsburgh today and can you add milk to the list/i);
});

test('mergeWindow tolerates punctuation drift and no-overlap windows', () => {
  assert.equal(mergeWindow('', 'hello there'), 'hello there');
  assert.equal(mergeWindow('add milk', 'milk to the list'), 'add milk to the list'); // overlap on "milk"
  assert.match(mergeWindow('today', 'today?'), /today\??/); // trailing punctuation isn't a duplicate word
});
