'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Needles are joined at runtime so this test file does not itself contain them.
const FORBIDDEN = [
  ['techdirect', '.', 'io'].join(''),
  ['/', 'home', '/', 'adjutant'].join(''),
  ['/', 'home', '/', 'box'].join(''),
];

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT });
  return out.toString('utf8').split('\0').filter(Boolean);
}

test('docs/ivy.md has no Our-box section, emails, or home paths', () => {
  const ivy = fs.readFileSync(path.join(ROOT, 'docs/ivy.md'), 'utf8');
  assert.equal(/Our box only/i.test(ivy), false);
  assert.equal(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(ivy), false);
  assert.equal(/\/home\/[A-Za-z]/.test(ivy), false);
});

test('tracked files do not contain known install-specific leaks', () => {
  const hits = [];
  for (const rel of trackedFiles()) {
    const abs = path.join(ROOT, rel);
    let text;
    try {
      const buf = fs.readFileSync(abs);
      if (buf.includes(0)) continue;
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    const lower = text.toLowerCase();
    for (const needle of FORBIDDEN) {
      if (lower.includes(needle.toLowerCase())) hits.push(`${rel}: ${needle}`);
    }
  }
  assert.deepEqual(hits, []);
});
