'use strict';
/**
 * asmltr connector type: TELEGRAM (thin adapter — the eve-messaging replacement).
 *
 * Transport stays here (it's HOW Telegram works): polling, photo download,
 * sendMessage/Photo/Document, and the :3008 HTTP endpoints that outbound helper scripts and
 * asmltr-core's block-alert depend on. Everything else
 * (sessions, identity, moderation, system prompt) is the core's job: we just
 * build an envelope and render the reply.
 *
 * conversation_key = telegram:<instanceId>:user:<userId>
 *
 * NOTE: only ONE poller may hold a bot token at a time — register this DISABLED
 * and enable it only after stopping the old eve-messaging bot (the cutover).
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const meta = {
  type: 'telegram',
  displayName: 'Telegram',
  supportsMultiple: true,
  capabilities: { max_message_chars: 4000, supports_markdown: true, supports_code_blocks: true, supports_attachments_out: true },
  credentialKeys: ['bot_token_bws_key'],
  identifierFormats: [{ surface: 'telegram', label: 'Telegram username', placeholder: 'username' }],
  // Unified outbound capability (manager /send → this instance /out).
  outbound: { kinds: ['text', 'photo', 'document'], target: { required: false, label: 'Chat id (default: configured chat)' } },
  configSchema: {
    type: 'object',
    required: ['bot_token_bws_key'],
    properties: {
      bot_token_bws_key: { type: 'string', title: 'Bot token (Bitwarden secret key)' },
      allowed_chat_ids: { type: 'array', title: 'Allowed chat IDs', items: { type: 'integer' },
        description: 'Empty = learn the first chat that messages (single-user bots)' },
      http_port: { type: 'integer', title: 'Outbound HTTP port', default: 3008 },
      photo_dir: { type: 'string', title: 'Photo save dir', default: '', description: 'Where incoming photos are saved. Empty = ~/.asmltr/telegram-photos' },
    },
  },
};

async function start(ctx) {
  const cfg = ctx.config;
  const token = (await ctx.secrets.get(cfg.bot_token_bws_key)) || cfg.bot_token;
  if (!token) throw new Error(`no bot token (bws key '${cfg.bot_token_bws_key}')`);
  const photoDir = cfg.photo_dir || path.join(require('os').homedir(), '.asmltr', 'telegram-photos');
  const allowed = new Set(cfg.allowed_chat_ids || []);
  let learnedChat = null;

  const bot = new TelegramBot(token, { polling: true });

  function authorized(chatId) {
    if (allowed.size === 0) { if (!learnedChat) learnedChat = chatId; return chatId === learnedChat; }
    return allowed.has(chatId);
  }

  bot.on('message', async (msg) => {
    if (msg.from && msg.from.is_bot) return;
    const chatId = msg.chat.id;
    const userId = (msg.from && (msg.from.username || msg.from.id)) || String(chatId);
    if (!authorized(chatId)) { bot.sendMessage(chatId, '🔒 Access denied.'); return; }

    const attachments = [];
    let text = msg.text || msg.caption || '';

    // photo transport: download → base64 image attachment (native vision; the model
    // SEES it) AND keep a host-file copy in the temp-photos dir other tools reference.
    // Telegram always re-encodes photos to JPEG. Largest preview = msg.photo[last].
    if (msg.photo && msg.photo.length) {
      try {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const file = await bot.getFile(fileId);
        const buf = Buffer.from(await (await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`)).arrayBuffer());
        const fileName = `photo_${Date.now()}.jpg`;
        const localPath = path.join(photoDir, fileName);
        try { fs.mkdirSync(photoDir, { recursive: true }); fs.writeFileSync(localPath, buf); } catch (_) {}
        if (buf.length <= 5 * 1024 * 1024) {
          // canonical vision shape — matches the core/runner contract (type/media_type/data)
          attachments.push({ type: 'image', media_type: 'image/jpeg', data: buf.toString('base64'), name: fileName, path: localPath });
          ctx.log(`photo: ${buf.length}b -> vision + ${localPath}`);
        } else {
          // too big to inline — fall back to the Read-the-file hint
          text = `${text}\n\n[Attached image saved at ${localPath} — read it with the Read tool if relevant.]`;
          ctx.log(`photo too large for inline vision (${buf.length}b); saved ${localPath}`);
        }
      } catch (e) { ctx.log(`photo download failed: ${e.message}`); }
    }
    if (!text.trim() && !attachments.length) return;

    try {
      bot.sendChatAction(chatId, 'typing').catch(() => {});
      const actions = await ctx.core.handle({
        channel: 'telegram',
        conversation_key: `telegram:${ctx.instanceId}:user:${userId}`,
        message_id: String(msg.message_id),
        sender: { raw_id: String(userId), raw_username: msg.from && msg.from.username },
        content: { text, attachments },
        delivery: 'sync',
        capabilities: meta.capabilities,
        public: false, // 1:1 DM with the authorized user; redaction still applies if they're not full-trust
        channel_context: { chatId },
      });
      for (const a of actions) {
        if (a.type === 'reply') await sendChunked(bot, chatId, a.text);
        else if (a.type === 'status') await bot.sendMessage(chatId, `_${a.text}_`, { parse_mode: 'Markdown' }).catch(() => {});
        // notify/suppress: not surfaced to the user
      }
    } catch (e) {
      ctx.log(`handle failed: ${e.message}`);
      bot.sendMessage(chatId, `⚠️ ${e.message}`).catch(() => {});
    }
  });

  bot.on('polling_error', (e) => ctx.log(`polling_error: ${e.code || e.message}`));

  // --- outbound HTTP endpoints (transport other tools depend on) -------------
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const target = () => (allowed.size ? [...allowed][0] : learnedChat);
  app.get('/health', (req, res) => res.json({ status: 'healthy', type: 'telegram', instance: ctx.instanceId }));
  app.post('/send', async (req, res) => {
    try { const m = await bot.sendMessage(target(), req.body.message, req.body.options || {}); res.json({ ok: true, messageId: m.message_id }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post('/send-photo', async (req, res) => {
    try { const m = await bot.sendPhoto(target(), req.body.photoPath, { caption: req.body.caption || '' }); res.json({ ok: true, messageId: m.message_id }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post('/send-document', async (req, res) => {
    try { const m = await bot.sendDocument(target(), req.body.documentPath, { caption: req.body.caption || '' }); res.json({ ok: true, messageId: m.message_id }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // Unified outbound endpoint (the manager /send router calls this).
  app.post('/out', async (req, res) => {
    try {
      const { kind = 'text', target: tg, text, path: filePath, caption } = req.body || {};
      const to = tg || target();
      let m;
      if (kind === 'photo') m = await bot.sendPhoto(to, filePath, { caption: caption || '' });
      else if (kind === 'document') m = await bot.sendDocument(to, filePath, { caption: caption || '' });
      else m = await bot.sendMessage(to, text);
      res.json({ ok: true, messageId: m.message_id });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  const httpServer = app.listen(cfg.http_port || 3008, '127.0.0.1', () => ctx.log(`outbound HTTP on :${cfg.http_port || 3008}`));

  ctx.log('telegram connector started (polling)');
  return {
    async stop() { try { await bot.stopPolling(); } catch (_) {} try { httpServer.close(); } catch (_) {} },
    health() { return { polling: true, http_port: cfg.http_port || 3008 }; },
  };
}

async function sendChunked(bot, chatId, textRaw) {
  const text = String(textRaw || '');
  const MAX = 3900;
  if (text.length <= MAX) { await bot.sendMessage(chatId, text).catch(async () => { await bot.sendMessage(chatId, text, {}); }); return; }
  for (let i = 0; i < text.length; i += MAX) await bot.sendMessage(chatId, text.slice(i, i + MAX)).catch(() => {});
}

module.exports = { meta, start };
