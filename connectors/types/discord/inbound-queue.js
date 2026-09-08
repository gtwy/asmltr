'use strict';
/**
 * FIFO inbound queue for guild ACP. No barges: messages wait in receive order.
 * After a turn, drain and decide whether a follow-up is still needed.
 */
function createInboundQueue() {
  const q = new Map();

  function list(cid) {
    const id = String(cid || '');
    if (!q.has(id)) q.set(id, []);
    return q.get(id);
  }

  function enqueue(cid, item) {
    list(cid).push(item);
    return list(cid).length;
  }

  function drain(cid) {
    const id = String(cid || '');
    const items = q.get(id) || [];
    q.delete(id);
    return items;
  }

  function peek(cid) {
    return list(cid).slice();
  }

  function size(cid) {
    return list(cid).length;
  }

  function clear(cid) {
    q.delete(String(cid || ''));
  }

  return { enqueue, drain, peek, size, clear };
}

function formatQueuedPrompt(items) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return '';
  if (rows.length === 1) return String(rows[0].text || '');
  const lines = rows.map((it, i) => {
    const who = it.author || 'someone';
    return `[${i + 1}/${rows.length} ${who}]: ${String(it.text || '')}`;
  });
  return 'QUEUED MESSAGES (receive order). Reply only if still needed and not already answered.\n' + lines.join('\n');
}

module.exports = { createInboundQueue, formatQueuedPrompt };
