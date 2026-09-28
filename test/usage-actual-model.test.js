'use strict';
// Usage log records the model a grok turn ACTUALLY ran (session current_model_id / streaming-json
// end modelUsage / ACP session/new), falling back to the configured model only when unknown.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-grok-model-args-'));
process.env.ASMLTR_GROK_PROMPT_DIR = promptDir;
const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-grok-home-'));
process.env.ASMLTR_PRICING_FILE = path.join(grokHome, 'no-pricing-override.json');
const gs = require('../shared/grok-session');
const { turnUsageModel } = require('../shared/usage');
const pricing = require('../shared/pricing');
const grok = require('../core/src/engines/grok');
after(() => {
  for (const d of [promptDir, grokHome]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

const ENV = { GROK_HOME: grokHome };
const SID = '01234567-89ab-7def-8123-456789abcdef';

function writeSummary(cwd, sid, body) {
  const dir = path.join(grokHome, 'sessions', encodeURIComponent(cwd), sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(body));
}

test('normalizeModelId strips the CLI -build variant only', () => {
  assert.equal(gs.normalizeModelId('grok-4.6-build'), 'grok-4.6');
  assert.equal(gs.normalizeModelId('grok-4.7'), 'grok-4.7');
  assert.equal(gs.normalizeModelId('grok-build'), 'grok-build');
  assert.equal(gs.normalizeModelId('  '), null);
  assert.equal(gs.normalizeModelId(null), null);
});

test('grokHome honors GROK_HOME, else ~/.grok', () => {
  assert.equal(gs.grokHome(ENV), grokHome);
  assert.equal(gs.grokHome({}), path.join(os.homedir(), '.grok'));
});

test('sessionModelId reads current_model_id under the session cwd', () => {
  writeSummary('/work/a', SID, { info: { id: SID, cwd: '/work/a' }, current_model_id: 'grok-4.7', reasoning_effort: 'xhigh' });
  assert.equal(gs.sessionModelId(SID, '/work/a', ENV), 'grok-4.7');
});

test('sessionModelId finds the session under another cwd folder when cwd is unknown or wrong', () => {
  const sid = '019a0e86-0000-7000-8000-000000000001';
  writeSummary('/work/b', sid, { current_model_id: 'grok-4.6' });
  assert.equal(gs.sessionModelId(sid, null, ENV), 'grok-4.6');
  assert.equal(gs.sessionModelId(sid, '/elsewhere', ENV), 'grok-4.6');
});

test('sessionModelId: unknown / malformed / traversal ids are null', () => {
  assert.equal(gs.sessionModelId('019a0e86-0000-7000-8000-00000000ffff', '/work/a', ENV), null);
  assert.equal(gs.sessionModelId('../../etc/passwd', '/work/a', ENV), null);
  assert.equal(gs.sessionModelId('', '/work/a', ENV), null);
  const sid = '019a0e86-0000-7000-8000-000000000002';
  const dir = path.join(grokHome, 'sessions', encodeURIComponent('/work/c'), sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), '{not json');
  assert.equal(gs.sessionModelId(sid, '/work/c', ENV), null);
});

test('modelFromEnd reads the streaming-json end modelUsage key', () => {
  const end = { type: 'end', stopReason: 'end_turn', sessionId: SID,
    usage: { input_tokens: 17099, output_tokens: 14 },
    modelUsage: { 'grok-4.6-build': { inputTokens: 17099, outputTokens: 14, modelCalls: 1 } } };
  assert.equal(gs.modelFromEnd(end), 'grok-4.6');
  assert.equal(gs.modelFromEnd({ type: 'end' }), null);
  const two = { modelUsage: { 'grok-4.5': { outputTokens: 3 }, 'grok-4.7-build': { outputTokens: 900 } } };
  assert.equal(gs.modelFromEnd(two), 'grok-4.7');
});

test('acpResultModelId: configOptions currentValue, models.currentModelId, currentModelId, modelId', () => {
  assert.equal(gs.acpResultModelId({ configOptions: [{ id: 'model', currentValue: 'grok-4.6' }], models: { currentModelId: 'grok-4.7' } }), 'grok-4.6');
  assert.equal(gs.acpResultModelId({ sessionId: 's', models: { currentModelId: 'grok-4.7' } }), 'grok-4.7');
  assert.equal(gs.acpResultModelId({ currentModelId: 'grok-4.7' }), 'grok-4.7');
  assert.equal(gs.acpResultModelId({ modelId: 'grok-4.6' }), 'grok-4.6');
  assert.equal(gs.acpResultModelId({ sessionId: 's' }), null);
  assert.equal(gs.acpResultModelId(null), null);
});

test('applyEvent: the streaming-json end event records the actual model on state', () => {
  const st = grok.newState(SID);
  assert.equal(st.model, null);
  grok.applyEvent({ type: 'text', data: 'ok' }, st);
  assert.equal(st.model, null);
  grok.applyEvent({ type: 'end', sessionId: SID, usage: { input_tokens: 10, output_tokens: 2 },
    modelUsage: { 'grok-4.6-build': { outputTokens: 2 } } }, st);
  assert.equal(st.model, 'grok-4.6');
  assert.equal(st.usage.tokens_in, 10);
});

test('runTurn result carries model: session current_model_id, then end modelUsage, then null', () => {
  const src = fs.readFileSync(path.join(__dirname, '../core/src/engines/grok.js'), 'utf8');
  const run = src.match(/async function runTurn\([\s\S]*?\n\}/);
  assert.ok(run, 'runTurn found');
  assert.match(run[0], /model: grokSession\.sessionModelId\(engineSessionId, cwd \|\| process\.cwd\(\)\) \|\| state\.model \|\| null/);
});

test('turnUsageModel: reported model wins; configured only as a flagged fallback', () => {
  assert.deepEqual(turnUsageModel({ model: 'grok-4.6' }, 'grok-4.7'), { model: 'grok-4.6', fallback: false });
  assert.deepEqual(turnUsageModel({ model: '' }, 'grok-4.7'), { model: 'grok-4.7', fallback: true });
  assert.deepEqual(turnUsageModel({}, 'grok-4.7'), { model: 'grok-4.7', fallback: true });
  assert.deepEqual(turnUsageModel(null, null), { model: null, fallback: true });
});

test('pricing follows the actual model, not the configured one', () => {
  const actual = turnUsageModel({ model: 'grok-3' }, 'grok-4.7').model;
  assert.equal(actual, 'grok-3');
  assert.equal(pricing.tokenCostUsd(actual, 1e6, 0), 3);
  assert.equal(pricing.tokenCostUsd('grok-4.7', 1e6, 0), 2);
});

test('core token-usage record uses turnUsageModel(result, configured) and flags model_fallback', () => {
  const src = fs.readFileSync(path.join(__dirname, '../core/src/server.js'), 'utf8');
  assert.match(src, /turnUsageModel\(result, configuredModel\)/);
  assert.match(src, /model_fallback: \(modelFallback && usedModel\) \? true : undefined/);
  assert.match(src, /tokenCostUsd\(usedModel, usage\.tokens_in, usage\.tokens_out\)/);
});
