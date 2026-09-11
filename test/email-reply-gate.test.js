'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { emailReplyGateDecision, letterBodyFromReply } = require('../connectors/types/email/reply-gate');
const { stripNoReplySentinel } = require('../shared/silence');

test('letter-only sentinel strips to empty', () => {
  assert.equal(letterBodyFromReply('[[NO_REPLY]]'), '');
  assert.equal(letterBodyFromReply('  [[NO_REPLY]]  \n'), '');
  assert.equal(stripNoReplySentinel('[[NO_REPLY]]'), '');
});

test('letter plus last-line sentinel is the letter', () => {
  const body = 'Hi James,\n\nSightline 0.5 hrs on 9/8.\n\n[[NO_REPLY]]';
  assert.equal(letterBodyFromReply(body), 'Hi James,\n\nSightline 0.5 hrs on 9/8.');
});

test('gate mails a letter-shaped reply', () => {
  const d = emailReplyGateDecision({ replyText: 'Hi Jareth,\n\nMon 14 Sep 16:30–18:30.' });
  assert.equal(d.action, 'mail');
  assert.match(d.text, /Jareth/);
});

test('gate skips already-out, always_draft, ops, empty', () => {
  assert.equal(emailReplyGateDecision({
    replyText: 'Hi', alreadyOut: true,
  }).reason, 'already-out');
  assert.equal(emailReplyGateDecision({
    replyText: 'Hi', sendPolicy: 'always_draft',
  }).reason, 'always_draft');
  assert.equal(emailReplyGateDecision({
    replyText: 'Hi Microsoft', opsHit: { id: 'microsoft-invoice-declined', reply_to_sender: false },
  }).reason, 'ops-noreply');
  assert.equal(emailReplyGateDecision({
    replyText: '[[NO_REPLY]]',
  }).reason, 'no-letter');
  assert.equal(emailReplyGateDecision({
    replyText: '',
  }).reason, 'no-letter');
});

test('CC-only with a letter still mails (spoken to)', () => {
  const d = emailReplyGateDecision({
    replyText: 'Tim, I restarted AD Sync.\n\n[[NO_REPLY]]',
    ccOnly: true,
  });
  assert.equal(d.action, 'mail');
  assert.match(d.text, /restarted AD Sync/);
});

test('connector extra uses ivy-context paths and no silo memory/ops', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/email/index.js'), 'utf8');
  assert.match(src, /A letter-shaped reply is mailed on this thread/);
  assert.match(src, /Flow: medium\/email-threads\.md/);
  assert.match(src, /Full flowchart: workflows\/calendar\.md/);
  assert.match(src, /workflows\/ops-desk\.md/);
  assert.match(src, /workflows\/ops-desk\/out-of-office\.md/);
  assert.doesNotMatch(src, /memory\/ops\//);
  assert.doesNotMatch(src, /assistant text is NOT mailed/);
  assert.doesNotMatch(src, /write the letter as your reply \(greeting first\) and end with \[\[NO_REPLY\]\]/);
  assert.doesNotMatch(src, /Then reply with exactly \[\[NO_REPLY\]\]\./);
  assert.match(src, /Do not put \[\[NO_REPLY\]\] on a letter/);
  assert.match(src, /If you are the only To/);
  assert.match(src, /emailReplyGateDecision/);
  assert.match(src, /reply-gate mailed/);
});
