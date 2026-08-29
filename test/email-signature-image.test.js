'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  SIG_IMAGE_CID,
  signatureImageAttachment,
  withSignatureImage,
} = require('../connectors/types/email');

test('missing signature_image path attaches nothing', () => {
  assert.equal(signatureImageAttachment(''), null);
  assert.equal(signatureImageAttachment('/no/such/file.png'), null);
  assert.equal(withSignatureImage(undefined, ''), undefined);
});

test('existing PNG becomes an inline cid part and does not duplicate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-img-'));
  const png = path.join(dir, 'sig.png');
  fs.writeFileSync(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const one = signatureImageAttachment(png);
  assert.equal(one.cid, SIG_IMAGE_CID);
  assert.equal(one.contentDisposition, 'inline');
  assert.equal(one.contentType, 'image/png');
  assert.equal(one.path, png);
  const withFile = withSignatureImage([{ path: '/tmp/invoice.pdf', filename: 'invoice.pdf' }], png);
  assert.equal(withFile.length, 2);
  assert.equal(withFile[1].cid, SIG_IMAGE_CID);
  const twice = withSignatureImage(withFile, png);
  assert.equal(twice.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
