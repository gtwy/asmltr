'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const pricing = require('../shared/pricing');
const { auxUsage, estimateAudioSeconds } = require('../shared/usage');

// --- pricing table: token / tts / stt math -----------------------------------------------------------
test('tokenCostUsd prices input+output at per-1M rates', () => {
  // opus = {in:15, out:75} per 1M → 1000 in + 500 out = 1000*15/1e6 + 500*75/1e6 = 0.015 + 0.0375
  assert.equal(pricing.tokenCostUsd('claude-opus-4-8', 1000, 500), 0.0525);
});

test('tokenCostUsd longest-prefix matches model families and date suffixes', () => {
  // gpt-4o-mini must beat gpt-4o (longer prefix), and a date suffix still resolves to the base.
  assert.equal(pricing.tokenCostUsd('gpt-4o-mini-2026-01-01', 1_000_000, 0), 0.15);
  assert.equal(pricing.tokenCostUsd('gpt-4o', 1_000_000, 0), 2.5);
});

test('tokenCostUsd returns 0 for an unknown model (never throws)', () => {
  assert.equal(pricing.tokenCostUsd('totally-made-up-model', 1000, 1000), 0);
});

test('ttsCostUsd prices per 1k chars; eleven_* falls back to the elevenlabs rate', () => {
  assert.equal(pricing.ttsCostUsd('tts-1', 1000), 0.015);
  assert.equal(pricing.ttsCostUsd('eleven_turbo_v2_5', 1000), 0.15);
  // an unknown eleven_* model resolves to the generic elevenlabs fallback (0.24/1k)
  assert.equal(pricing.ttsCostUsd('eleven_some_future_model', 1000), 0.24);
});

test('sttCostUsd prices per minute of audio', () => {
  // gpt-4o-transcribe = $0.006/min → 60s = $0.006
  assert.equal(pricing.sttCostUsd('gpt-4o-transcribe', 60), 0.006);
  assert.ok(Math.abs(pricing.sttCostUsd('gpt-4o-transcribe', 30) - 0.003) < 1e-9);
});

// --- auxUsage: builds a priced token-usage event partial ---------------------------------------------
test('auxUsage(tts) prices by chars, marks billed, carries feature/provider payload', () => {
  const e = auxUsage({ surface: 'assistant-web', identity: 'jareth', feature: 'tts', provider: 'elevenlabs', model: 'eleven_turbo_v2_5', chars: 1200 });
  assert.equal(e.event_type, 'token-usage');
  assert.equal(e.surface, 'assistant-web');
  assert.equal(e.tokens_in, 0);            // char features do NOT pollute token totals
  assert.equal(e.cost_usd, 0.18);          // 1200/1000 * 0.15
  assert.equal(e.billed_cost_usd, 0.18);   // metered → billed by default
  assert.equal(e.payload.feature, 'tts');
  assert.equal(e.payload.units, 'chars');
  assert.equal(e.payload.count, 1200);
  assert.equal(e.payload.aux, true);
});

test('auxUsage(stt) prices by seconds', () => {
  const e = auxUsage({ surface: 'discord', feature: 'stt', provider: 'openai', model: 'gpt-4o-transcribe', seconds: 42 });
  assert.equal(e.payload.units, 'seconds');
  assert.ok(Math.abs(e.cost_usd - (42 / 60 * 0.006)) < 1e-9);
});

test('auxUsage(token feature) sets token counts and prices them', () => {
  const e = auxUsage({ surface: 'discord', feature: 'moderation', provider: 'openai', model: 'gpt-4o-mini', tokens_in: 800, tokens_out: 40 });
  assert.equal(e.tokens_in, 800);
  assert.equal(e.tokens_out, 40);
  assert.equal(e.payload.units, 'tokens');
  assert.ok(Math.abs(e.cost_usd - ((800 * 0.15 + 40 * 0.6) / 1e6)) < 1e-12);
});

test('auxUsage billed:false zeroes the billed amount but keeps equivalent value', () => {
  const e = auxUsage({ surface: 'core', feature: 'label', model: 'claude-haiku', tokens_in: 100, tokens_out: 100, billed: false });
  assert.ok(e.cost_usd > 0);
  assert.equal(e.billed_cost_usd, 0);
  assert.equal(e.payload.billed, false);
});

// --- estimateAudioSeconds: byte-length fallback for STT duration -------------------------------------
test('estimateAudioSeconds scales with byte length and container', () => {
  // opus/webm default ~32kbps = 4000 bytes/sec → 40000 bytes ≈ 10s
  assert.ok(Math.abs(estimateAudioSeconds(40000, 'audio/webm') - 10) < 0.01);
  // wav PCM (16kHz*16bit mono = 32000 B/s) → same bytes is far shorter
  assert.ok(estimateAudioSeconds(40000, 'audio/wav') < estimateAudioSeconds(40000, 'audio/webm'));
  assert.equal(estimateAudioSeconds(0, 'audio/webm'), 0);
});
