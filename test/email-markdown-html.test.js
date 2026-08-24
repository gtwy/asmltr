'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  escapeHtml,
  stripDiscordChrome,
  markdownToHtml,
  wrapEmailHtml,
  emailHtmlFromMarkdown,
  buildMailContent,
} = require('../connectors/types/email');

test('bold italic headings render as tags', () => {
  const h = markdownToHtml('# Hello\n\n## Sub\n\n### Small\n\nThis is **bold** and *italic* and __also bold__ and _also italic_.');
  assert.match(h, /<h1[^>]*>Hello<\/h1>/);
  assert.match(h, /<h2[^>]*>Sub<\/h2>/);
  assert.match(h, /<h3[^>]*>Small<\/h3>/);
  assert.match(h, /<strong>bold<\/strong>/);
  assert.match(h, /<em>italic<\/em>/);
  assert.match(h, /<strong>also bold<\/strong>/);
  assert.match(h, /<em>also italic<\/em>/);
});

test('raw script is escaped, not a tag', () => {
  const h = markdownToHtml('Hello <script>alert(1)</script>');
  assert.doesNotMatch(h, /<script>/i);
  assert.match(h, /&lt;script&gt;/);
});

test('javascript URL is not an href', () => {
  const h = markdownToHtml('Click [here](javascript:alert(1)) please');
  assert.doesNotMatch(h, /href\s*=/i);
  assert.doesNotMatch(h, /javascript/i);
  assert.match(h, /here/);
});

test('http links become underlined anchors', () => {
  const h = markdownToHtml('See [docs](https://example.com/path)');
  assert.match(h, /<a href="https:\/\/example.com\/path"[^>]*>docs<\/a>/);
  assert.match(h, /text-decoration:underline/);
});

test('Discord -# line is stripped', () => {
  const stripped = stripDiscordChrome('-# Working\nHello\n-# Still working\nWorld 💭 done');
  assert.doesNotMatch(stripped, /Working/);
  assert.doesNotMatch(stripped, /Still working/);
  assert.doesNotMatch(stripped, /💭/);
  assert.match(stripped, /Hello/);
  assert.match(stripped, /World/);
  const html = emailHtmlFromMarkdown('-# Working\nDear reader\n');
  assert.doesNotMatch(html, /Working/);
  assert.match(html, /Dear reader/);
});

test('(paid link) and Associate sentence get small italic', () => {
  const h = markdownToHtml('Buy this (paid link). As an Amazon Associate I earn from qualifying purchases.');
  assert.match(h, /font-size:12px;font-style:italic;color:#555/);
  assert.match(h, /<span style="font-size:12px;font-style:italic;color:#555;">\(paid link\)<\/span>/);
  assert.match(h, /<span style="font-size:12px;font-style:italic;color:#555;">As an Amazon Associate I earn from qualifying purchases\.<\/span>/);
});

test('emailHtmlFromMarkdown returns a full html document with a body', () => {
  const doc = emailHtmlFromMarkdown('Hi **there**');
  assert.match(doc, /<!DOCTYPE html>/i);
  assert.match(doc, /<html[\s>]/i);
  assert.match(doc, /<body[\s>]/i);
  assert.match(doc, /<\/body>/i);
  assert.match(doc, /Georgia/);
  assert.match(doc, /<strong>there<\/strong>/);
});

test('buildMailContent returns multipart text plus html', () => {
  const c = buildMailContent('Hello **world**', '\n\n—\nIvy');
  assert.equal(c.text, 'Hello **world**\n\n—\nIvy');
  assert.ok(c.html);
  assert.match(c.html, /<strong>world<\/strong>/);
  assert.match(c.html, /<html/i);
  assert.match(c.html, /<body/i);
});

test('escapeHtml and wrapEmailHtml helpers', () => {
  assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  const doc = wrapEmailHtml('<p>z</p>');
  assert.match(doc, /<html[\s>]/i);
  assert.match(doc, /<body[^>]*>/);
  assert.match(doc, /<p>z<\/p>/);
  assert.doesNotMatch(doc, /<script/i);
});

test('lists blockquotes code and hard breaks', () => {
  const h = markdownToHtml('Line one\nLine two\n\n- apples\n- pears\n\n1. first\n2. second\n\n> quoted\n\nUse `code` and:\n\n```\nconst x = 1;\n```\n');
  assert.match(h, /Line one<br>Line two/);
  assert.match(h, /<ul[^>]*>/);
  assert.match(h, /<li[^>]*>apples<\/li>/);
  assert.match(h, /<ol[^>]*>/);
  assert.match(h, /<li[^>]*>first<\/li>/);
  assert.match(h, /<blockquote[^>]*>quoted<\/blockquote>/);
  assert.match(h, /<code[^>]*>code<\/code>/);
  assert.match(h, /<pre[^>]*>[\s\S]*const x = 1;/);
});
