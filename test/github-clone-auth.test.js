'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cloneArgv, cloneGitEnv, githubIdentityPrompt } = require('../connectors/types/github/clone-auth');

test('clone argv has no PAT', () => {
  const args = cloneArgv('acme/repo', '/tmp/acme__repo');
  const joined = args.join(' ');
  assert.equal(joined.includes('x-access-token'), false);
  assert.equal(joined.includes('ghs_'), false);
  assert.equal(joined.includes('@github.com'), false);
  assert.ok(args.includes('https://github.com/acme/repo.git'));
});

test('identity prompt has no PAT placeholder or GH_TOKEN=', () => {
  const p = githubIdentityPrompt({ acct: '@bot', patKey: 'my_pat_key', issueNumber: 1, full: 'acme/repo' });
  assert.equal(p.includes('GH_TOKEN='), false);
  assert.equal(p.includes('<pat>'), false);
  assert.match(p, /my_pat_key/);
});

test('clone env carries Authorization, not argv', () => {
  const env = cloneGitEnv('secret-pat-value', {});
  assert.equal(env.GIT_CONFIG_VALUE_0.includes('secret-pat-value'), true);
  assert.equal(cloneArgv('a/b', '/x').join(' ').includes('secret-pat-value'), false);
});
