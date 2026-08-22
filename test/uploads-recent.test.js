'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-uploads-'));
process.env.ASMLTR_UPLOADS_DIR = dir;
const uploads = require('../shared/uploads');

test('recentSummary lists THIS conversation only; CLI list stays global', () => {
  const a = uploads.save({
    channel: 'discord', buffer: Buffer.from('aaa'), filename: 'king.jpg',
    caption: 'ivy what is this from', sender: 'wx412',
    conversationKey: 'discord:i:channel:asmltr', kind: 'image',
  });
  uploads.save({
    channel: 'discord', buffer: Buffer.from('bbb'), filename: 'other.jpg',
    caption: 'ivy what is this from', sender: 'wx412',
    conversationKey: 'discord:i:channel:everyone', kind: 'image',
  });
  const mine = uploads.recentSummary(6, { conversationKey: 'discord:i:channel:asmltr' });
  assert.match(mine, /king\.jpg/);
  assert.equal(mine.includes('other.jpg'), false);
  const all = uploads.recentSummary(6);
  assert.match(all, /king\.jpg/);
  assert.match(all, /other\.jpg/);
  const listed = uploads.list({ conversationKey: 'discord:i:channel:asmltr' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].filename, a.filename);
});
