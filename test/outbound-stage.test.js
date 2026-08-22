'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-stage-'));
process.env.ASMLTR_ATTACH_STAGE = tmp;
const stage = require('../shared/outbound-stage');

function touchSrc(name, body) {
  const p = path.join(tmp, 'src-' + name);
  fs.writeFileSync(p, body || 'x');
  return p;
}

test('sanitizeFilename: lowercase, no spaces, one period', () => {
  assert.equal(stage.sanitizeFilename('My Photo.PNG'), 'my-photo.png');
  assert.equal(stage.sanitizeFilename('a b  c.JPG'), 'a-b-c.jpg');
  assert.equal(stage.sanitizeFilename('foo.bar.baz.png'), 'foo-bar-baz.png');
  assert.equal(stage.sanitizeFilename('OK_File-1.WebP'), 'ok_file-1.webp');
  assert.equal(stage.sanitizeFilename('***'), 'file.bin');
});

test('uniqueName does not overwrite an existing staged file', () => {
  const a = stage.stageFile(touchSrc('a.png', 'aaa'), { name: 'shot.png' });
  const b = stage.stageFile(touchSrc('b.png', 'bbb'), { name: 'shot.png' });
  assert.equal(a.name, 'shot.png');
  assert.equal(b.name, 'shot-2.png');
  assert.notEqual(a.path, b.path);
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'aaa');
  assert.equal(fs.readFileSync(b.path, 'utf8'), 'bbb');
});

test('will not delete until posted; deletes after markPosted', () => {
  const rec = stage.stageFile(touchSrc('keep.bin', 'keep'), { name: 'keep.bin' });
  const blocked = stage.removePostedFile(rec.name);
  assert.equal(blocked.ok, false);
  assert.ok(fs.existsSync(rec.path));
  stage.markPosted(rec.name, { messageId: 'm1' });
  const gone = stage.removePostedFile(rec.name);
  assert.equal(gone.ok, true);
  assert.equal(fs.existsSync(rec.path), false);
});

test('listUnposted skips posted rows; retry candidate stays until post', () => {
  const rec = stage.stageFile(touchSrc('wait.mp4', 'vid'), { name: 'wait.mp4' });
  assert.ok(stage.listUnposted().some((r) => r.name === 'wait.mp4'));
  stage.markPosted('wait.mp4', { messageId: 'm2' });
  assert.equal(stage.listUnposted().some((r) => r.name === 'wait.mp4'), false);
  assert.ok(fs.existsSync(rec.path), 'bytes remain until removePostedFile');
});

test('gc removes files older than a day and leaves fresh ones', () => {
  const rec = stage.stageFile(touchSrc('old.txt', 'old'), { name: 'old.txt' });
  const idxPath = path.join(tmp, 'index.json');
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  idx.items['old.txt'].created_at = Date.now() - (25 * 60 * 60 * 1000);
  fs.writeFileSync(idxPath, JSON.stringify(idx));
  const fresh = stage.stageFile(touchSrc('new.txt', 'new'), { name: 'new.txt' });
  const r = stage.gc(24 * 60 * 60 * 1000);
  assert.ok(r.removed.includes('old.txt'));
  assert.equal(fs.existsSync(rec.path), false);
  assert.ok(fs.existsSync(fresh.path));
});
