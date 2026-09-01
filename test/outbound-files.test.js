'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectOutboundFiles, attachmentsFromPaths, MAX_TOTAL_BYTES } = require('../shared/outbound-files');

test('collectOutboundFiles uniques files then path', () => {
  assert.deepEqual(collectOutboundFiles({
    files: ['/a.pdf', '/b.txt', '/a.pdf'],
    path: '/a.pdf',
  }), ['/a.pdf', '/b.txt']);
  assert.deepEqual(collectOutboundFiles({ path: '/only.pdf' }), ['/only.pdf']);
  assert.deepEqual(collectOutboundFiles({}), []);
  assert.deepEqual(collectOutboundFiles({ files: ['', null, ' /x '] }), ['/x']);
});

test('attachmentsFromPaths caps 25MB total and maps basename', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-outfiles-'));
  const a = path.join(dir, 'a.pdf');
  const b = path.join(dir, 'b.txt');
  fs.writeFileSync(a, Buffer.alloc(100, 1));
  fs.writeFileSync(b, Buffer.alloc(50, 2));
  const atts = attachmentsFromPaths([a, b]);
  assert.equal(atts.length, 2);
  assert.equal(atts[0].filename, 'a.pdf');
  assert.equal(atts[1].filename, 'b.txt');
  assert.equal(atts[0].path, a);

  const big = path.join(dir, 'big.bin');
  fs.writeFileSync(big, Buffer.alloc(MAX_TOTAL_BYTES - 10, 3));
  const over = path.join(dir, 'over.bin');
  fs.writeFileSync(over, Buffer.alloc(20, 4));
  assert.throws(() => attachmentsFromPaths([big, over]), (e) => e.code === 'ATTACH_TOO_LARGE');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('attachmentsFromPaths missing file', () => {
  assert.throws(() => attachmentsFromPaths(['/no/such/asmltr-attach-xyz']), (e) => e.code === 'ENOENT');
});
