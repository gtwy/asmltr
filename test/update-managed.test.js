'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const UPDATE_SRC = fs.readFileSync(path.join(__dirname, '../shared/update.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(__dirname, '../insights/dashboard/src/App.vue'), 'utf8');
const SETTINGS_SRC = fs.readFileSync(path.join(__dirname, '../insights/dashboard/src/views/Settings.vue'), 'utf8');

test('getUpdateStatus edge target uses update-ref, not origin/main', () => {
  assert.match(UPDATE_SRC, /resolveEdgeTarget/);
  assert.match(UPDATE_SRC, /fetchOriginArgv/);
  assert.doesNotMatch(UPDATE_SRC, /rev-parse',\s*'origin\/main'/);
  assert.doesNotMatch(UPDATE_SRC, /fetch',\s*'--quiet',\s*'--tags',\s*'origin',\s*'main'/);
});

test('dashboard hides the behind banner and Update button when managed', () => {
  assert.match(APP_SRC, /upd\.available && !upd\.managed/);
  assert.match(SETTINGS_SRC, /upd\.managed/);
  assert.match(SETTINGS_SRC, /not updating in place/);
});

test('managed status is never available and spawn refuses', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-managed-'));
  const file = path.join(dir, 'managed');
  fs.writeFileSync(file, 'ivy\n');
  const prev = process.env.ASMLTR_MANAGED_FILE;
  process.env.ASMLTR_MANAGED_FILE = file;
  try {
    delete require.cache[require.resolve('../shared/version')];
    delete require.cache[require.resolve('../shared/update')];
    const { getUpdateStatus, spawnUpdateSession, setAutoUpdate, isAutoUpdate } = require('../shared/update');
    const s = await getUpdateStatus({ fetch: true });
    assert.equal(s.available, false);
    assert.equal(s.managed, true);
    assert.equal(s.manager, 'ivy');
    assert.equal(s.behind, 0);
    const r = spawnUpdateSession({ by: 'test' });
    assert.equal(r.managed, true);
    assert.equal(r.manager, 'ivy');
    assert.equal(r.pid, undefined);
    assert.equal(setAutoUpdate(true), false);
    assert.equal(isAutoUpdate(), false);
  } finally {
    if (prev === undefined) delete process.env.ASMLTR_MANAGED_FILE;
    else process.env.ASMLTR_MANAGED_FILE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
