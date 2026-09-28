'use strict';
// The IMAP watcher drains a FETCH before running any other command on the connection.
// imapflow queues commands behind a running FETCH, so a flag/persist step inside the fetch
// loop deadlocked until the socket timeout and later mail waited (2026-09-28).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const email = require('../connectors/types/email');

function fakeImap(uids) {
  const calls = [];
  let open = false;
  return {
    calls,
    fetch(range, opts) {
      calls.push(['fetch', range.uid, !!(opts && opts.source)]);
      return (async function* () {
        open = true;
        try {
          for (const uid of uids) yield { uid, source: Buffer.from('msg ' + uid) };
        } finally { open = false; }
      }());
    },
    async messageFlagsAdd() {
      if (open) throw new Error('IMAP command issued while FETCH iterator is open (deadlock)');
      calls.push(['flags']);
      return true;
    },
    isOpen: () => open,
  };
}

test('drainFetchBatch returns uids above lastUid in order, with the fetch closed', async () => {
  const imap = fakeImap([2489, 2487, 2488]);
  const batch = await email.drainFetchBatch(imap, 2488, 2512, 2487);
  assert.deepEqual(batch.map((m) => m.uid), [2488, 2489]);
  assert.equal(String(batch[0].source), 'msg 2488');
  assert.equal(imap.isOpen(), false, 'FETCH iterator finished before return');
  assert.deepEqual(imap.calls[0], ['fetch', '2488:2512', true]);
  await imap.messageFlagsAdd({ uid: 2488 }, ['\\Seen'], { uid: true }); // allowed now
});

test('drainFetchBatch: the empty-window tip (uid <= lastUid) is skipped', async () => {
  const batch = await email.drainFetchBatch(fakeImap([2487]), 2488, 2512, 2487);
  assert.deepEqual(batch, []);
});

test('fetchNew processes, flags and persists only after the FETCH is drained', () => {
  const src = fs.readFileSync(path.join(__dirname, '../connectors/types/email/index.js'), 'utf8');
  const fn = src.match(/async function fetchNew\(\) \{[\s\S]*?\n  \}\n/);
  assert.ok(fn, 'fetchNew found');
  const body = fn[0];
  assert.ok(!/for await \(const msg of imap\.fetch/.test(body), 'no IMAP fetch loop inside fetchNew');
  const drain = body.indexOf('drainFetchBatch(imap, startUid, endUid, lastUid)');
  const flags = body.indexOf('imap.messageFlagsAdd(');
  const persist = body.indexOf('persistLastUid(');
  assert.ok(drain > 0 && flags > drain && persist > flags, 'drain -> flag -> persist order');
});
