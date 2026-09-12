'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stripLeadingLetterPlan } = require('../connectors/types/email/letter-plan');
const { letterBodyFromReply } = require('../connectors/types/email/reply-gate');
const { buildMailContent } = require('../connectors/types/email');

const MARKAY_PLAN = 'That gear panel is the iPhone Outlook app — it never shows the full settings. I’ll send her the Safari path and a direct rules link so she can skip hunting for the missing line.';
const MARKAY_LETTER = [
  'Hi Markay,',
  '',
  'You are in the right place for the iPhone app — and that is why the line is missing.',
].join('\n');

test('Hi Name after a plan is the mailed body (Markay)', () => {
  const out = stripLeadingLetterPlan(MARKAY_PLAN + '\n\n' + MARKAY_LETTER);
  assert.equal(out.startsWith('Hi Markay,'), true, out.slice(0, 80));
  assert.equal(out.includes('I’ll send'), false);
  assert.equal(out.includes('gear panel'), false);
  assert.ok(out.includes('right place'));
});

test('Dear Name after a plan is the mailed body', () => {
  const out = stripLeadingLetterPlan(
    'Working through the photos.\n\nDear Alex,\n\nThe invoice is attached.',
  );
  assert.equal(out, 'Dear Alex,\n\nThe invoice is attached.');
});

test('Photo-is / I’ll-send scratch drops when a letter follows, even without a greeting', () => {
  const plan = 'Photo is two CyberPower PR2200LCDRT2U units. OEM cartridge is RB1290X4F — I’ll send the Amazon links and flag that you need two, one per unit.';
  const letter = "You're right — those are CyberPower. The model is PR2200LCDRT2U.";
  const out = stripLeadingLetterPlan(plan + '\n\n' + letter);
  assert.equal(out.startsWith("You're right"), true, out.slice(0, 80));
  assert.equal(out.includes('I’ll send'), false);
  assert.equal(out.includes('Photo is'), false);
});

test('do not cut on a bare name line (the 2deacfd false positive)', () => {
  const letter = "You're right — those are CyberPower.";
  const greeted = 'James,\n\n' + letter;
  assert.equal(stripLeadingLetterPlan(greeted), greeted);
  const withStore = letter + '\n\nAmazon,\nthen the cart.';
  assert.equal(stripLeadingLetterPlan(withStore), withStore);
});

test('one-paragraph I’ll-send letters stay', () => {
  assert.equal(
    stripLeadingLetterPlan("I'll send the invoice tomorrow."),
    "I'll send the invoice tomorrow.",
  );
  const signed = "I'll send the invoice tomorrow.\n\nSincerely,\nIvy";
  assert.equal(stripLeadingLetterPlan(signed), signed);
});

test('letter that already starts at the greeting stays', () => {
  assert.equal(stripLeadingLetterPlan(MARKAY_LETTER), MARKAY_LETTER);
  const withSend = 'Hi James,\n\nI’ll send the invoice tomorrow.';
  assert.equal(stripLeadingLetterPlan(withSend), withSend);
});

test('reply-gate and buildMailContent both strip the plan', () => {
  const glued = MARKAY_PLAN + '\n\n' + MARKAY_LETTER + '\n\n[[NO_REPLY]]';
  const fromGate = letterBodyFromReply(glued);
  assert.equal(fromGate.startsWith('Hi Markay,'), true, fromGate.slice(0, 80));
  assert.equal(fromGate.includes('[[NO_REPLY]]'), false);
  const mailed = buildMailContent(MARKAY_PLAN + '\n\n' + MARKAY_LETTER, '\n\n—\nGaia');
  assert.equal(mailed.text.startsWith('Hi Markay,'), true, mailed.text.slice(0, 80));
  assert.equal(mailed.text.includes('gear panel'), false);
  assert.match(mailed.text, /—\nGaia/);
  assert.ok(mailed.html);
  assert.doesNotMatch(mailed.html, /gear panel/);
});
