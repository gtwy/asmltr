'use strict';
/**
 * asmltr connector type: OpenAI-compatible REST API.
 *
 * Exposes `POST /v1/chat/completions` + `GET /v1/models` so ANY OpenAI-compatible client
 * (the openai SDKs, LibreChat, an OpenRouter-style router, etc.) can point at an asmltr
 * install and be answered by the local Agent SDK through the core — with asmltr's trust +
 * moderation applied like any other channel. No API key is used for execution; the SDK
 * rides the subscription. The Bearer key here is asmltr's OWN inbound auth, not a provider key.
 *
 * Auth: `Authorization: Bearer <key>`. Keys map to a trust identity in a gitignored keys
 * file (so moderation/trust apply per caller). conversation_key groups a chat (by identity +
 * its first user message) so multi-turn conversations resume the same core session and show
 * as ONE card on the dashboard.
 *
 * Session model: this is a STATEFUL chat endpoint — the core session holds history and
 * resumes, so each request only forwards the latest user message (a new conversation, or the
 * first request the connector sees for a key, forwards the whole thing). Most chat clients
 * (append-to-history then re-send) work naturally; the resent history is ignored past the
 * latest turn.
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const NAME = process.env.ASSISTANT_NAME || 'assistant';

const meta = {
  type: 'openai',
  displayName: 'OpenAI-compatible API',
  outbound: false, // request/response — no push channel to /out
  configSchema: {
    type: 'object',
    properties: {
      port: { type: 'integer', title: 'HTTP port', default: 3025 },
      bind_host: { type: 'string', title: 'Bind address', default: '127.0.0.1' },
      model_name: { type: 'string', title: 'Advertised model id (what /v1/models returns)', default: 'asmltr' },
      keys_file: { type: 'string', title: 'API keys file (gitignored: key → trust identity)', default: '' },
      require_key: { type: 'boolean', title: 'Require a Bearer API key', default: true },
    },
  },
};

function loadKeys(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j.keys) ? j.keys : []; } catch { return []; }
}
function contentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c && typeof c.text === 'string').map((c) => c.text).join('\n');
  return '';
}
function splitChunks(s, n) { const out = []; s = String(s || ''); for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out.length ? out : ['']; }
function oaiErr(message, code) { return { error: { message, type: code === 'invalid_api_key' ? 'invalid_request_error' : (code || 'server_error'), code: code || null } }; }

async function start(ctx) {
  const cfg = ctx.config || {};
  const PORT = cfg.port || 3025;
  const BIND = cfg.bind_host || '127.0.0.1';
  const MODEL = cfg.model_name || 'asmltr';
  const requireKey = cfg.require_key !== false;
  const keysFile = cfg.keys_file || path.join(__dirname, 'keys.json');
  const seenKeys = new Set(); // conversation_keys we've already forwarded a turn for (this process)

  function keyEntry(token) { return loadKeys(keysFile).find((k) => k.key === token) || null; }
  function auth(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    const token = m ? m[1].trim() : null;
    if (!requireKey) { const e = token && keyEntry(token); return { identity: (e && e.identity) || 'openai-anon', username: (e && e.username) || 'openai' }; }
    if (!token) return null;
    const e = keyEntry(token);
    return e ? { identity: e.identity, username: e.username || e.identity } : null;
  }

  const app = express();
  app.use(express.json({ limit: '8mb' }));

  app.get('/health', (req, res) => res.json({ status: 'ok', type: 'openai', instance: ctx.instanceId, model: MODEL }));

  app.get('/v1/models', (req, res) => {
    if (requireKey && !auth(req)) return res.status(401).json(oaiErr('Invalid API key.', 'invalid_api_key'));
    res.json({ object: 'list', data: [{ id: MODEL, object: 'model', created: 0, owned_by: 'asmltr' }] });
  });

  app.post('/v1/chat/completions', async (req, res) => {
    const who = auth(req);
    if (requireKey && !who) return res.status(401).json(oaiErr('Invalid API key.', 'invalid_api_key'));
    const identity = (who && who.identity) || 'openai-anon';
    const username = (who && who.username) || identity;

    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const userMsgs = messages.filter((m) => m.role === 'user');
    const lastUser = contentText(userMsgs[userMsgs.length - 1] && userMsgs[userMsgs.length - 1].content);
    if (!lastUser) return res.status(400).json(oaiErr('messages must include a user message with content', 'invalid_request_error'));

    const systemText = messages.filter((m) => m.role === 'system').map((m) => contentText(m.content)).filter(Boolean).join('\n\n');
    const firstUser = contentText(userMsgs[0] && userMsgs[0].content) || lastUser;
    const seed = crypto.createHash('sha1').update(identity + '|' + firstUser).digest('hex').slice(0, 16);
    const convKey = `openai:${ctx.instanceId}:${seed}`;

    // First time we see this conversation → forward the full transcript (so any pre-existing
    // history the client sent is included). After that, the core session resumes → latest only.
    let prompt = lastUser;
    if (!seenKeys.has(convKey) && messages.length > 1) {
      prompt = messages.filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${contentText(m.content)}`).filter((l) => l.length > 6).join('\n\n');
    }
    seenKeys.add(convKey);

    ctx.emit({ event_type: 'inbound', session_id: convKey, identity, payload: { text: lastUser.slice(0, 200) } });

    const envelope = {
      channel: 'openai',
      conversation_key: convKey,
      message_id: String(Date.now()),
      sender: { raw_id: identity, raw_username: username },
      content: { text: prompt },
      delivery: 'sync',
      public: false, // 1:1 authed caller; redaction still applies unless the identity is full-trust
      channel_context: {},
      context: { scope_name: 'OpenAI API' },
      system_prompt_extra: systemText || undefined,
    };
    const id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
    const created = Math.floor(Date.now() / 1000);

    if (body.stream) {
      // TRUE token streaming — forward the core's live SSE deltas as OpenAI chat.completion chunks
      // (low first-token latency; enables realtime voice front-ends like ElevenLabs Custom LLM).
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const send = (delta, finish) => { try { res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish || null }] }) + '\n\n'); } catch (_) {} };
      send({ role: 'assistant' });
      try {
        await ctx.core.handleStream(envelope, (text) => send({ content: text }));
      } catch (e) {
        ctx.log('openai stream error: ' + e.message);
      }
      send({}, 'stop');
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    let replyText = '';
    try {
      const actions = await ctx.core.handle(envelope);
      const reply = (actions || []).find((a) => a.type === 'reply');
      replyText = reply ? reply.text : '';
    } catch (e) {
      ctx.log('openai handle error: ' + e.message);
      return res.status(500).json(oaiErr('backend error: ' + e.message, 'server_error'));
    }
    res.json({
      id, object: 'chat.completion', created, model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: replyText }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  });

  const httpServer = app.listen(PORT, BIND, () => ctx.log(`openai-compatible API on ${BIND}:${PORT} (model=${MODEL}, ${requireKey ? 'auth required' : 'OPEN'})`));

  return {
    async stop() { await new Promise((r) => httpServer.close(() => r())); },
    health() { return { port: PORT, model: MODEL }; },
  };
}

module.exports = { meta, start };
