'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('load-host-overlay missing dir is null; present module loads', () => {
  const prev = process.env.ASMLTR_OVERLAY_DIR;
  process.env.ASMLTR_OVERLAY_DIR = path.join(os.tmpdir(), 'no-ov-' + Date.now());
  delete require.cache[require.resolve('../shared/load-host-overlay')];
  const { load, overlayDir } = require('../shared/load-host-overlay');
  assert.equal(load('stop-starter-or-owner'), null);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-'));
  fs.writeFileSync(path.join(tmp, 'stop-starter-or-owner.js'), "module.exports = { wrapAbortAllow(m) { m.wrapped = true; return m; } };\n");
  process.env.ASMLTR_OVERLAY_DIR = tmp;
  delete require.cache[require.resolve('../shared/load-host-overlay')];
  const again = require('../shared/load-host-overlay');
  const ov = again.load('stop-starter-or-owner');
  assert.equal(typeof ov.wrapAbortAllow, 'function');
  if (prev === undefined) delete process.env.ASMLTR_OVERLAY_DIR;
  else process.env.ASMLTR_OVERLAY_DIR = prev;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('abort-allow and guild-post thin-hook overlay load', () => {
  const a = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/abort-allow.js'), 'utf8');
  const g = fs.readFileSync(path.join(__dirname, '../shared/guild-post.js'), 'utf8');
  const d = fs.readFileSync(path.join(__dirname, '../connectors/types/discord/index.js'), 'utf8');
  assert.match(a, /load-host-overlay/);
  assert.match(g, /guild-post-fence/);
  assert.match(d, /host-settings/);
  assert.match(d, /pii_gate/);
  assert.match(d, /thought_chips/);
  assert.match(d, /attachments/);
});
