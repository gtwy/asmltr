'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const ALLOWED_EMAIL_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'users.noreply.github.com',
  'microsoft.com',
  'other.com',
  'notmicrosoft.com',
]);
const PRIVATE_HOST_RE = /\b(?:[a-z0-9-]+\.)+example\.invalid\b/gi;
const HOME_RE = /\/home\/[A-Za-z][A-Za-z0-9._-]*/g;
const HOME_ALLOW = new Set([
  '/home/someone',
  '/home/user',
  '/home/you',
  '/home/operator',
  '/home/foo',
  '/home/bar',
  '/home/recents',
]);

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT });
  return out.toString('utf8').split('\0').filter(Boolean);
}

function emailDomain(addr) {
  const at = addr.lastIndexOf('@');
  return at === -1 ? '' : addr.slice(at + 1).toLowerCase();
}

function emailDomainAllowed(dom) {
  if (ALLOWED_EMAIL_DOMAINS.has(dom)) return true;
  if (dom.endsWith('.onmicrosoft.com')) return true;
  for (const allow of ALLOWED_EMAIL_DOMAINS) {
    if (dom.endsWith('.' + allow)) return true;
  }
  return false;
}

test('docs/ivy.md has no Our-box section, emails, or home paths', () => {
  const ivy = fs.readFileSync(path.join(ROOT, 'docs/ivy.md'), 'utf8');
  assert.equal(/Our box only/i.test(ivy), false);
  assert.equal(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(ivy), false);
  assert.equal(/\/home\/[A-Za-z]/.test(ivy), false);
});

test('tracked files do not contain install-specific hosts, emails, or home paths', () => {
  const hits = [];
  for (const rel of trackedFiles()) {
    const abs = path.join(ROOT, rel);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      continue;
    }
    if (buf.includes(0)) continue;
    let text;
    try {
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    const base = rel.split('/').pop();
    if (PRIVATE_HOST_RE.test(text)) hits.push(rel + ': private-host');
    PRIVATE_HOST_RE.lastIndex = 0;
    if (base !== 'package-lock.json') {
      for (const m of text.matchAll(EMAIL_RE)) {
        const dom = emailDomain(m[0]);
        if (!emailDomainAllowed(dom)) hits.push(rel + ': email-domain');
      }
    }
    for (const m of text.matchAll(HOME_RE)) {
      if (!HOME_ALLOW.has(m[0])) hits.push(rel + ': home-path');
    }
  }
  assert.deepEqual(hits, []);
});
