'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isAutomatedSender, matchOpsAllowThrough, domainMatches } = require('../connectors/types/email/index.js');

const ENTRA = [{
  id: 'entra-sync-stopped',
  from_domains: ['example.com'],
  all_keywords: ['Synchronization', 'Entra ID'],
  noreply_ok: true,
  reply_to_sender: false,
}];

test('noreply sender is automated', () => {
  assert.equal(isAutomatedSender('alerts-noreply@example.com'), true);
  assert.equal(isAutomatedSender('person@example.com'), false);
});

test('domain match is @domain or a subdomain, not a suffix of the local part', () => {
  assert.equal(domainMatches('alerts-noreply@example.com', 'example.com'), true);
  assert.equal(domainMatches('alerts@notify.example.com', 'example.com'), true);
  assert.equal(domainMatches('evil@notexample.com', 'example.com'), false);
});

test('Entra sync matcher hits the sample Microsoft alert', () => {
  const hit = matchOpsAllowThrough(
    'alerts-noreply@example.com',
    'contoso.onmicrosoft.com: Synchronization has stopped for at least 24 hours. – You have an important alert from Microsoft Entra ID',
    'Synchronization to Microsoft Entra ID appears to have been stopped',
    ENTRA,
  );
  assert.ok(hit);
  assert.equal(hit.id, 'entra-sync-stopped');
});

test('Entra matcher does not fire without both keywords', () => {
  assert.equal(matchOpsAllowThrough(
    'alerts-noreply@example.com',
    'Something else from Microsoft Entra ID',
    'no sync word here',
    ENTRA,
  ), null);
});

test('Entra matcher does not fire from a non-matching sender', () => {
  assert.equal(matchOpsAllowThrough(
    'person@other.com',
    'Synchronization has stopped — Microsoft Entra ID',
    'Synchronization to Microsoft Entra ID stopped',
    ENTRA,
  ), null);
});
