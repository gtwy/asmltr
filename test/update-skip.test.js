'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { depsChanged, dashboardChanged } = require('../scripts/lib/should-run.js');

// The updater skips `npm ci` and the dashboard docker build when the changed-file set between the
// from-sha and target-sha touches nothing relevant. These cover the decision that drives the skip.

test('a docs-only change skips both phases', () => {
  const files = ['README.md', 'docs/cli.md', 'docs/reference/config.md'];
  assert.equal(depsChanged(files), false);
  assert.equal(dashboardChanged(files), false);
});

test('an empty change set skips both phases', () => {
  assert.equal(depsChanged([]), false);
  assert.equal(dashboardChanged([]), false);
});

test('a root package-lock.json change forces the install', () => {
  assert.equal(depsChanged(['package-lock.json']), true);
});

test('a workspace package.json change forces the install', () => {
  assert.equal(depsChanged(['core/package.json']), true);
  assert.equal(depsChanged(['insights/collector/package.json']), true);
});

test('a non-workspace manifest (mobile) does NOT force the install', () => {
  // mobile is a separately-built Capacitor app, not a root workspace, so its manifest
  // does not feed the root `npm ci` and must not trigger a rebuild.
  assert.equal(depsChanged(['mobile/package.json']), false);
  assert.equal(depsChanged(['mobile/package.json', 'mobile/package-lock.json']), false);
});

test('a change under insights/dashboard forces the docker rebuild', () => {
  assert.equal(dashboardChanged(['insights/dashboard/src/App.vue']), true);
});

test('a compose-file change forces the docker rebuild', () => {
  assert.equal(dashboardChanged(['insights/docker-compose.yml']), true);
});
