'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMailContent,
  subjectHasTestWord,
  formatQuoteAttr,
} = require('../connectors/types/email');

const SIG = '\n\n\nIvy Hedera 🔶🌿\nAI Assistant to Example Owner\n\n[Example Co](https://example.com) can build an AI assistant like this for your team.\n';
const QUOTE = {
  fromName: 'Example Owner',
  fromAddr: 'owner@example.com',
  date: '2026-08-26T19:22:00.000Z', // 15:22 EDT
  text: 'Please look at *_domainkey* and *foo* in this inbound.',
};

test('subjectHasTestWord is a word, case-insensitive, ok in a longer subject', () => {
  assert.equal(subjectHasTestWord('James Test'), true);
  assert.equal(subjectHasTestWord('Re: JAMES TEST'), true);
  assert.equal(subjectHasTestWord('Test quote 1'), true);
  assert.equal(subjectHasTestWord('Contest'), false);
  assert.equal(subjectHasTestWord('Latest'), false);
  assert.equal(subjectHasTestWord('testing'), false);
  assert.equal(subjectHasTestWord('Re: Rhino ticket'), false);
});

test('no Test in subject → body-only, no gmail_quote', () => {
  const c = buildMailContent('Hello **world**', SIG, { subject: 'Re: Rhino', quote: QUOTE });
  assert.equal(c.text.includes('Hello **world**'), true);
  assert.doesNotMatch(c.text, /^>/m);
  assert.doesNotMatch(c.html, /gmail_quote/);
  assert.match(c.html, /<strong>world<\/strong>/);
});

test('Test subject with last inbound → quote after conversion, markdown not applied to inbound', () => {
  const c = buildMailContent('A loaf on the sill.\n', SIG, { subject: 'Re: James Test', quote: QUOTE });
  assert.match(c.html, /gmail_quote/);
  assert.match(c.html, /gmail_attr/);
  const above = c.html.slice(0, c.html.indexOf('gmail_quote'));
  assert.match(above, /loaf/);
  assert.match(above, /font-weight:bold;color:#555/);
  assert.match(c.html, /\*_domainkey\*/);
  assert.doesNotMatch(c.html.slice(c.html.indexOf('gmail_quote')), /<em>foo<\/em>/);
  assert.doesNotMatch(c.html.slice(c.html.indexOf('gmail_quote')), /<strong>/);
  assert.match(c.text, /> Please look at \*_domainkey\*/);
  const sigAt = c.text.indexOf('Ivy Hedera');
  const gtAt = c.text.indexOf('\n>');
  assert.ok(sigAt > 0 && gtAt > sigAt);
  assert.match(c.html, /On .* at \d{1,2}:\d{2} (AM|PM)/);
  assert.match(formatQuoteAttr(QUOTE), /Example Owner <owner@example\.io>/);
});

test('Test subject without stored inbound text → no quote', () => {
  const c = buildMailContent('Hi', SIG, { subject: 'Test', quote: null });
  assert.doesNotMatch(c.html, /gmail_quote/);
});

test('attachments stay off buildMailContent', () => {
  const c = buildMailContent('Hi', SIG, { subject: 'Test', quote: QUOTE });
  assert.equal(c.attachments, undefined);
});
