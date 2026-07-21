#!/usr/bin/env node
'use strict';
/**
 * asmltr toolbelt — an MCP stdio server that exposes asmltr's cross-session tools to ANY reasoning
 * engine (Claude/Gemini/Codex). Historically the toolbelt was a bash CLI injected into the Claude
 * system prompt; as an MCP server it becomes real, structured tools every harness can call the same way.
 *
 * Zero dependencies: a minimal newline-delimited JSON-RPC 2.0 stdio loop (the MCP stdio framing).
 * Each tool shells out to `cli/asmltr.js <subcommand>` so the CLI stays the single source of truth.
 */
const { execFile } = require('child_process');
const path = require('path');
const readline = require('readline');

const CLI = path.join(__dirname, '..', 'cli', 'asmltr.js');
const NAME = process.env.ASSISTANT_NAME || 'asmltr';

// Tool definitions → (args) => argv for `node cli/asmltr.js …`. Keep names stable + engine-agnostic.
const TOOLS = [
  { name: 'asmltr_sessions', description: `List ${NAME}'s currently active sessions across all channels (id, surface, task, status).`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    argv: () => ['ls'] },
  { name: 'asmltr_send', description: 'Deliver a message OUT through any connector (discord, telegram, email, …) to a target.',
    inputSchema: { type: 'object', required: ['channel', 'target', 'text'],
      properties: { channel: { type: 'string', description: 'discord | telegram | email | …' }, target: { type: 'string', description: 'channel id / chat id / email address' }, text: { type: 'string' }, subject: { type: 'string', description: 'email subject (email only)' } },
      additionalProperties: false },
    argv: (a) => ['send', a.channel, a.target, a.text, ...(a.subject ? ['--subject', a.subject] : [])] },
  { name: 'asmltr_announce', description: `Post a non-coercive announcement other ${NAME} sessions see on their next turn (they decide what to do with it).`,
    inputSchema: { type: 'object', required: ['text'],
      properties: { text: { type: 'string' }, to: { type: 'string', description: 'optional target scope' }, urgent: { type: 'boolean' } },
      additionalProperties: false },
    argv: (a) => ['announce', a.text, ...(a.to ? ['--to', a.to] : []), ...(a.urgent ? ['--urgent'] : [])] },
  { name: 'asmltr_uploads', description: 'List recent files uploaded to the shared upload area across channels (newest first); optional search.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
    argv: (a) => ['uploads', ...(a.query ? [a.query] : [])] },
];
const BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, ''); // the CLI colorizes; the model wants plain text
function runCli(argv) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...argv], { timeout: 60000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } }, (err, stdout, stderr) => {
      if (err) resolve({ isError: true, text: stripAnsi(stderr || err.message || '').trim() || `exit ${err.code}` });
      else resolve({ isError: false, text: stripAnsi(stdout || '').trim() || '(no output)' });
    });
  });
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  if (msg.method === 'notifications/initialized' || msg.id === undefined) return; // notifications: no reply
  switch (msg.method) {
    case 'initialize':
      return ok(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: `${NAME}-toolbelt`, version: '1.0.0' } });
    case 'ping':
      return ok(msg.id, {});
    case 'tools/list':
      return ok(msg.id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const t = BY_NAME[(msg.params || {}).name];
      if (!t) return fail(msg.id, -32602, `unknown tool: ${(msg.params || {}).name}`);
      try {
        const r = await runCli(t.argv(msg.params.arguments || {}));
        return ok(msg.id, { content: [{ type: 'text', text: r.text }], isError: r.isError });
      } catch (e) { return ok(msg.id, { content: [{ type: 'text', text: e.message }], isError: true }); }
    }
    default:
      return fail(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => { const s = line.trim(); if (!s) return; let msg; try { msg = JSON.parse(s); } catch { return; } Promise.resolve(handle(msg)).catch(() => {}); });
rl.on('close', () => process.exit(0));
