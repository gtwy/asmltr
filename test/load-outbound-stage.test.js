'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { overlayStagePath, loadOutboundStage } = require('../shared/load-outbound-stage');

test('overlayStagePath prefers ASMLTR_OUTBOUND_STAGE then ~/.asmltr/ivy-local/overlay', () => {
  const prev = process.env.ASMLTR_OUTBOUND_STAGE;
  process.env.ASMLTR_OUTBOUND_STAGE = '/tmp/overlay-outbound-stage.js';
  assert.equal(overlayStagePath(), '/tmp/overlay-outbound-stage.js');
  delete process.env.ASMLTR_OUTBOUND_STAGE;
  assert.equal(overlayStagePath(), path.join(os.homedir(), '.asmltr', 'ivy-local', 'overlay', 'outbound-stage.js'));
  if (prev === undefined) delete process.env.ASMLTR_OUTBOUND_STAGE;
  else process.env.ASMLTR_OUTBOUND_STAGE = prev;
});

test('loadOutboundStage falls back to public stage when overlay missing', () => {
  const prev = process.env.ASMLTR_OUTBOUND_STAGE;
  process.env.ASMLTR_OUTBOUND_STAGE = path.join(os.tmpdir(), 'no-such-outbound-stage-' + Date.now() + '.js');
  const stage = loadOutboundStage();
  assert.equal(typeof stage.outboundFileAllowed, 'function');
  assert.equal(stage.outboundFileAllowed('/etc/passwd'), false);
  if (prev === undefined) delete process.env.ASMLTR_OUTBOUND_STAGE;
  else process.env.ASMLTR_OUTBOUND_STAGE = prev;
});

test('loadOutboundStage applies host wrap when overlay module is present', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-stage-'));
  after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });
  const overlay = path.join(tmp, 'outbound-stage.js');
  fs.writeFileSync(overlay, [
    "'use strict';",
    "function apply(_t, ctx) {",
    "  const stage = ctx.stage;",
    "  if (!stage || stage._testWrapped) return stage;",
    "  const orig = stage.outboundFileAllowed;",
    "  stage.outboundFileAllowed = function (p) {",
    "    if (String(p).includes('DENYME')) return false;",
    "    return orig(p);",
    "  };",
    "  stage._testWrapped = true;",
    "  return stage;",
    "}",
    "module.exports = { apply };",
    "",
  ].join('\n'));
  const prev = process.env.ASMLTR_OUTBOUND_STAGE;
  process.env.ASMLTR_OUTBOUND_STAGE = overlay;
  const stage = loadOutboundStage();
  assert.equal(stage._testWrapped, true);
  assert.equal(stage.outboundFileAllowed('/tmp/DENYME.bin'), false);
  if (prev === undefined) delete process.env.ASMLTR_OUTBOUND_STAGE;
  else process.env.ASMLTR_OUTBOUND_STAGE = prev;
});

test('discord telegram manager /out use loadOutboundStage', () => {
  const disc = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  const tele = fs.readFileSync(path.join(__dirname, '../connectors/types/telegram/index.js'), 'utf8');
  const mgr = fs.readFileSync(path.join(__dirname, '../connectors/manager/server.js'), 'utf8');
  assert.match(disc, /loadOutboundStage/);
  assert.match(tele, /loadOutboundStage/);
  assert.match(mgr, /loadOutboundStage/);
});
