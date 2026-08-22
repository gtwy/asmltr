'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  mentionsImageKind, parseImageGenVerdict, classifyImageGenAsk, buildImageGenClassifyPrompt,
} = require('../shared/image-gen-ask');

test('mentionsImageKind: kind list only, not verb+kind', () => {
  assert.equal(mentionsImageKind('Please generate an image of a corgi'), true);
  assert.equal(mentionsImageKind('can you make a new picture'), true);
  assert.equal(mentionsImageKind('I liked the picture you made yesterday'), true);
  assert.equal(mentionsImageKind('I attached an image, please generate a report'), true);
  assert.equal(mentionsImageKind('take the picture you made of Steve yesterday as a puppet in the cape and sit him on the bench in the arboretum photo you made a few lines above'), true);
  assert.equal(mentionsImageKind('generate a report'), false);
  assert.equal(mentionsImageKind('make a list'), false);
  assert.equal(mentionsImageKind('ok thanks'), false);
  assert.equal(mentionsImageKind('state of the art'), false);
  assert.equal(mentionsImageKind('the art of cooking'), false);
  assert.equal(mentionsImageKind(''), false);
});

test('parseImageGenVerdict: YES/NO on first line, fail closed', () => {
  assert.equal(parseImageGenVerdict('YES'), true);
  assert.equal(parseImageGenVerdict('yes'), true);
  assert.equal(parseImageGenVerdict('**YES**'), true);
  assert.equal(parseImageGenVerdict('NO'), false);
  assert.equal(parseImageGenVerdict('no they just mentioned a photo'), false);
  assert.equal(parseImageGenVerdict('maybe an image'), false);
  assert.equal(parseImageGenVerdict(''), false);
  assert.equal(parseImageGenVerdict('I think so'), false);
});

test('classifyImageGenAsk: kind gate then completeFn; fail closed', async () => {
  let called = 0;
  assert.equal(await classifyImageGenAsk('ok thanks', async () => { called += 1; return 'YES'; }), false);
  assert.equal(called, 0);
  assert.equal(await classifyImageGenAsk('make a new picture', async () => 'YES'), true);
  assert.equal(await classifyImageGenAsk('I liked the picture', async () => 'NO'), false);
  assert.equal(await classifyImageGenAsk('a photo of Steve', async () => { throw new Error('boom'); }), false);
  assert.equal(await classifyImageGenAsk('a photo', null), false);
  const prompt = buildImageGenClassifyPrompt('sit him on the bench in the arboretum photo');
  assert.match(prompt, /ONLY YES or NO/);
  assert.match(prompt, /arboretum photo/);
});
