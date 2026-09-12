'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  matchThreadMute,
  matchThreadMuteOutbound,
  canonSubject,
  threadIdFromKey,
  loadThreadMutes,
} = require('../connectors/types/email/thread-mute');
const { createOutboundGate } = require('../connectors/types/email/index.js');

const OWNER = 'james@techdirect.io';
const SELF = 'ivy@gtwy.net';
const CUST = 'mharlan@brs.bz';
const CONV = 'email:cee16628-6e88-4ff5-b7db-e65d8fe9d978:thread:ff1d7dd0e3ebe0dc';

const MARKAY = {
  id: 'markay-outlook-rules',
  addrs: [CUST],
  subjects: ['Checking your Outlook inbox rules'],
  thread_ids: ['ff1d7dd0e3ebe0dc'],
};

test('canonSubject strips Re:/Fwd:', () => {
  assert.equal(canonSubject('Re: Checking your Outlook inbox rules'), 'checking your outlook inbox rules');
  assert.equal(canonSubject('FWD: Re: Photo of screen'), 'photo of screen');
});

test('threadIdFromKey reads the hash suffix', () => {
  assert.equal(threadIdFromKey(CONV), 'ff1d7dd0e3ebe0dc');
});

test('customer inbound on a closed subject skips the turn', () => {
  const h = matchThreadMute({
    mutes: [MARKAY],
    fromAddr: CUST,
    subject: 'Re: Checking your Outlook inbox rules',
    ownerAddr: OWNER,
    selfAddr: SELF,
  });
  assert.ok(h);
  assert.equal(h.skipInbound, true);
});

test('owner inbound on a closed subject still gets a turn', () => {
  const h = matchThreadMute({
    mutes: [MARKAY],
    fromAddr: OWNER,
    subject: 'Re: Checking your Outlook inbox rules',
    ownerAddr: OWNER,
    selfAddr: SELF,
  });
  assert.ok(h);
  assert.equal(h.skipInbound, false);
  assert.equal(h.closed, true);
});

test('same customer, different subject, is not skipped when subjects are set', () => {
  const h = matchThreadMute({
    mutes: [MARKAY],
    fromAddr: CUST,
    subject: 'Invoice question',
    ownerAddr: OWNER,
    selfAddr: SELF,
  });
  assert.equal(h, null);
});

test('addrs-only mutes every subject from that person', () => {
  const h = matchThreadMute({
    mutes: [{ id: 'all-markay', addrs: [CUST] }],
    fromAddr: CUST,
    subject: 'Anything',
    ownerAddr: OWNER,
    selfAddr: SELF,
  });
  assert.equal(h && h.skipInbound, true);
});

test('thread_id match skips even if subject drifted', () => {
  const h = matchThreadMute({
    mutes: [{ id: 'tid', thread_ids: ['ff1d7dd0e3ebe0dc'], addrs: [CUST] }],
    fromAddr: CUST,
    subject: 'Photo of screen',
    convKey: CONV,
    ownerAddr: OWNER,
    selfAddr: SELF,
  });
  assert.equal(h && h.skipInbound, true);
});

test('outbound reply-all to the customer is skipped', () => {
  const h = matchThreadMuteOutbound(
    { to: CUST, cc: OWNER, subject: 'Re: Checking your Outlook inbox rules' },
    { mutes: [MARKAY], ownerAddr: OWNER, selfAddr: SELF },
  );
  assert.equal(h && h.skipOutbound, true);
});

test('outbound to the owner only is not skipped', () => {
  const h = matchThreadMuteOutbound(
    { to: OWNER, subject: 'Re: Checking your Outlook inbox rules' },
    { mutes: [MARKAY], ownerAddr: OWNER, selfAddr: SELF },
  );
  assert.equal(h, null);
});

test('enabled:false is ignored', () => {
  const h = matchThreadMute({
    mutes: [{ ...MARKAY, enabled: false }],
    fromAddr: CUST,
    subject: 'Re: Checking your Outlook inbox rules',
    ownerAddr: OWNER,
    selfAddr: SELF,
  });
  assert.equal(h, null);
});

test('missing mute file is empty, not a throw', () => {
  assert.deepEqual(loadThreadMutes('/no/such/email-thread-mute.json'), []);
});

test('loadThreadMutes reads ivy-context shape', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-mute-'));
  const f = path.join(dir, 'mute.json');
  fs.writeFileSync(f, JSON.stringify({ mutes: [MARKAY] }));
  const list = loadThreadMutes(f);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'markay-outlook-rules');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createOutboundGate prepare skips SMTP to a muted customer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-mute-'));
  const f = path.join(dir, 'mute.json');
  fs.writeFileSync(f, JSON.stringify({ mutes: [MARKAY] }));
  const prev = process.env.ASMLTR_EMAIL_THREAD_MUTE;
  process.env.ASMLTR_EMAIL_THREAD_MUTE = f;
  try {
    const g = createOutboundGate({ ownerAddr: OWNER, selfAddr: SELF });
    const skipped = g.prepare({
      to: CUST,
      cc: OWNER,
      subject: 'Re: Checking your Outlook inbox rules',
      text: 'Hi Markay,\n\nNope.',
    });
    assert.equal(skipped.skip, true);
    assert.match(skipped.reason, /thread-mute/);
    const staff = g.prepare({
      to: OWNER,
      subject: 'Re: Checking your Outlook inbox rules',
      text: 'Sidebar only.',
    });
    assert.equal(staff.skip, false);
  } finally {
    if (prev == null) delete process.env.ASMLTR_EMAIL_THREAD_MUTE;
    else process.env.ASMLTR_EMAIL_THREAD_MUTE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
