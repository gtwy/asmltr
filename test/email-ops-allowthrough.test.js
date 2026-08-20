'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isAutomatedSender, matchOpsAllowThrough, domainMatches } = require('../connectors/types/email/index.js');

const ENTRA = [{
  id: 'entra-sync-stopped',
  from_domains: ['microsoft.com'],
  all_keywords: ['Synchronization', 'Entra ID'],
  noreply_ok: true,
  reply_to_sender: false,
}];

test('noreply/microsoft security is automated', () => {
  assert.equal(isAutomatedSender('mssecurity-noreply@microsoft.com'), true);
  assert.equal(isAutomatedSender('person@example.com'), false);
});

test('domain match is @domain or a subdomain, not a suffix of the local part', () => {
  assert.equal(domainMatches('mssecurity-noreply@microsoft.com', 'microsoft.com'), true);
  assert.equal(domainMatches('alerts@notify.microsoft.com', 'microsoft.com'), true);
  assert.equal(domainMatches('evil@notmicrosoft.com', 'microsoft.com'), false);
});

test('Entra sync matcher hits the sample Microsoft alert', () => {
  const hit = matchOpsAllowThrough(
    'mssecurity-noreply@microsoft.com',
    'riggletruckingcom.onmicrosoft.com: Synchronization has stopped for at least 24 hours. – You have an important alert from Microsoft Entra ID',
    'Synchronization to Microsoft Entra ID appears to have been stopped',
    ENTRA,
  );
  assert.ok(hit);
  assert.equal(hit.id, 'entra-sync-stopped');
});

test('Entra matcher does not fire without both keywords', () => {
  assert.equal(matchOpsAllowThrough(
    'mssecurity-noreply@microsoft.com',
    'Something else from Microsoft Entra ID',
    'no sync word here',
    ENTRA,
  ), null);
});

test('Entra matcher does not fire from a non-Microsoft sender', () => {
  assert.equal(matchOpsAllowThrough(
    'person@example.com',
    'Synchronization has stopped — Microsoft Entra ID',
    'Synchronization to Microsoft Entra ID stopped',
    ENTRA,
  ), null);
});
