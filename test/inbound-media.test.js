'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asmltr-genref-'));
process.env.ASMLTR_GEN_REF = tmp;
const inbound = require('../shared/inbound-media');
const grok = require('../core/src/engines/grok');

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('payload'),
]);

test('classify accepts png magic and refuses scripts/html/elf', () => {
  assert.equal(inbound.classify(PNG, 'image/png', 'pic.png').kind, 'image');
  assert.equal(inbound.classify(Buffer.from('#!/bin/bash\necho hi\n'), 'text/plain', 'x.sh').kind, null);
  assert.equal(inbound.classify(Buffer.from('<script>alert(1)</script>'), 'text/html', 'x.html').kind, null);
  assert.equal(inbound.classify(Buffer.from('PNG but js'), 'application/javascript', 'x.js').kind, null);
  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(inbound.classify(elf, 'application/octet-stream', 'a.bin').kind, null);
  assert.equal(inbound.classify(PNG, 'application/javascript', 'x.js').kind, null);
});

test('saveRef writes 0644 under gen-ref and never +x', () => {
  const r = inbound.saveRef(PNG, { name: 'Shot.PNG', mime: 'image/png' });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'image');
  assert.ok(r.path.startsWith(tmp));
  const mode = fs.statSync(r.path).mode & 0o777;
  assert.equal(mode & 0o111, 0);
});

test('saveRef refuses non-media', () => {
  const r = inbound.saveRef(Buffer.from('echo pwned'), { name: 'pwn.sh', mime: 'text/x-shellscript' });
  assert.equal(r.ok, false);
});

test('grok prompt gets CHANNEL MEDIA paths for image_edit, not as bash', () => {
  const pic = path.join(tmp, 'ref.png');
  fs.writeFileSync(pic, PNG);
  const args = grok.buildArgs({
    prompt: 'make it night',
    mediaFiles: [{ kind: 'image', path: pic, name: 'ref.png' }],
  });
  const p = args[args.indexOf('-p') + 1];
  assert.match(p, /CHANNEL MEDIA/);
  assert.ok(p.includes(pic));
  assert.match(p, /LOOK at these files/);
  assert.match(p, /not gen-only/);
  assert.match(p, /Do not execute/);
});
