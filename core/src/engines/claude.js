'use strict';
/**
 * Claude engine — the SDK-backed reasoning engine (the original web/channel runner).
 *
 * Wraps the LOCAL Agent SDK (`@anthropic-ai/claude-agent-sdk` query() API) on the Max
 * subscription (NEVER an API key). The SDK is required LAZILY (inside q()), so importing this
 * module — or booting the core — does NOT load the SDK. A Gemini-only / Codex-only install can
 * therefore run with the Claude SDK absent: this module is only touched when a Claude turn runs.
 *
 * Implements the engine contract: runTurn(opts) → { text, segments, engineSessionId, tools, usage,
 * isError } and complete({prompt,model,...}) → string. Behaviour is identical to the pre-refactor
 * runner.js (moved here verbatim).
 */
let _query = null;
function q() {
  if (!_query) _query = require('@anthropic-ai/claude-agent-sdk').query; // lazy: only when a Claude turn runs
  return _query;
}

const id = 'claude';
const cheapModel = process.env.ASMLTR_TITLE_MODEL || 'haiku';
let _lastModel = null; // the concrete model id the alias resolved to (surfaced to the GUI)

// Best-effort text summary of a tool_result's content (string | array of {type:'text',text} blocks).
function _resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && c.type === 'text' ? c.text : (typeof c === 'string' ? c : ''))).join(' ').trim();
  return '';
}

async function runTurn({ prompt, systemPrompt, resume = null, cwd, abortController, onEvent, onDelta, onSegment, onTool, onThinking, onSubagent, images = [] }) {
  const query = q();
  const options = {
    stream: true,
    permissionMode: 'bypassPermissions',
    includePartialMessages: true,
  };
  const _model = require('../../../shared/runtime').getModel();
  if (_model) options.model = _model;
  const thinkTokens = Number(process.env.ASMLTR_MAX_THINKING_TOKENS ?? 4000);
  if (thinkTokens > 0) options.maxThinkingTokens = thinkTokens;
  if (cwd) options.cwd = cwd;
  if (systemPrompt) options.systemPrompt = { type: 'preset', preset: 'claude_code', append: systemPrompt };
  if (abortController) options.abortController = abortController;
  if (resume) options.resume = resume;
  // MCP: provision the shared asmltr registry (incl. the built-in toolbelt) as SDK mcpServers.
  try { const m = require('../../../shared/mcp-registry').forClaude(); if (Object.keys(m).length) options.mcpServers = m; } catch (_) {}

  let queryPrompt = prompt;
  if (images && images.length) {
    const content = [{ type: 'text', text: prompt || '(no text)' }];
    for (const img of images) {
      if (img && img.data && img.media_type) {
        content.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
      }
    }
    if (content.length > 1) {
      queryPrompt = (async function* () {
        yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content } };
      })();
    }
  }

  const response = await query({ prompt: queryPrompt, options });

  let text = '';
  const segments = [];
  let engineSessionId = resume || null;
  const tools = [];
  let usage = { tokens_in: 0, tokens_out: 0, cost_usd: 0 };
  let isError = false;
  // Sub-agent (Task tool) lifecycle: a `Task` tool_use spawns a sub-agent (it runs and dies WITH this
  // turn); its matching tool_result is where it finishes. Surface start/stop via onSubagent so a UI can
  // show a live "sub-agents for this turn" panel. View-only — the SDK exposes no per-sub-agent kill.
  const subagents = new Map(); // tool_use_id → { name }

  for await (const event of response) {
    if (abortController && abortController.signal.aborted) break;
    if (onEvent) { try { onEvent(event); } catch (_) {} }
    if (onDelta && event.type === 'stream_event' && event.event && event.event.type === 'content_block_delta'
        && event.event.delta && event.event.delta.type === 'text_delta' && event.event.delta.text) {
      try { onDelta(event.event.delta.text); } catch (_) {}
    }

    switch (event.type) {
      case 'system':
        if (event.session_id) engineSessionId = event.session_id;
        if (event.model) _lastModel = event.model;
        break;
      case 'assistant':
        for (const c of event.message?.content || []) {
          if (c.type === 'text' && c.text) {
            const seg = c.text.trim();
            segments.push(seg); text += (text && !text.endsWith('\n') ? '\n\n' : '') + c.text;
            if (onSegment) { try { onSegment(seg); } catch (_) {} }
          } else if (c.type === 'tool_use') {
            tools.push({ id: c.id, name: c.name, input: c.input });
            if (onTool) { try { onTool({ name: c.name, input: c.input }); } catch (_) {} }
            if (c.name === 'Task') { // spawns a sub-agent
              const nm = (c.input && (c.input.description || c.input.subagent_type)) || 'sub-agent';
              subagents.set(c.id, { name: nm });
              if (onSubagent) { try { onSubagent({ id: c.id, name: nm, status: 'running', summary: (c.input && c.input.description) || '' }); } catch (_) {} }
            }
          } else if (c.type === 'thinking' && c.thinking && onThinking) {
            try { onThinking(c.thinking); } catch (_) {}
          }
        }
        break;
      case 'user':
        // a sub-agent (Task) finishing shows up as the tool_result for its tool_use id
        for (const c of event.message?.content || []) {
          if (c && c.type === 'tool_result' && subagents.has(c.tool_use_id)) {
            const sa = subagents.get(c.tool_use_id); subagents.delete(c.tool_use_id);
            if (onSubagent) { try { onSubagent({ id: c.tool_use_id, name: sa.name, status: 'stopped', summary: _resultText(c.content).slice(0, 400) }); } catch (_) {} }
          }
        }
        break;
      case 'result':
        if (event.session_id) engineSessionId = event.session_id;
        isError = !!event.is_error;
        if (event.usage) {
          const u = event.usage;
          // Full input = new uncached input PLUS cached context (read + creation). On a resumed session
          // most of the prompt is a cache READ, so counting only input_tokens massively undercounts the
          // real context (you'd see tokens_in≈2 next to tokens_out≈10k). Sum all input components.
          const inNew = u.input_tokens || u.inputTokens || 0;
          const inCacheRead = u.cache_read_input_tokens || u.cacheReadInputTokens || 0;
          const inCacheWrite = u.cache_creation_input_tokens || u.cacheCreationInputTokens || 0;
          usage.tokens_in = inNew + inCacheRead + inCacheWrite;
          usage.tokens_out = u.output_tokens || u.outputTokens || 0;
        }
        usage.cost_usd = event.total_cost_usd || event.cost_usd || 0;
        if (typeof event.result === 'string' && !text) text = event.result;
        break;
      case 'error':
        isError = true;
        break;
      default:
        break;
    }
  }

  // any sub-agents still open when the turn ends die with it — report them stopped so the UI closes them out
  if (onSubagent) for (const [tid, sa] of subagents) { try { onSubagent({ id: tid, name: sa.name, status: 'stopped', summary: '' }); } catch (_) {} }

  return { text: text.trim(), segments: segments.filter(Boolean), engineSessionId, tools, usage, isError };
}

/**
 * One-shot completion for the auxiliary labelers (title/status/self-assessment). No tools, no
 * resume, cheap model. Returns the raw assistant text (caller post-processes).
 */
async function complete({ prompt, model, appendSystemPrompt = null, maxTurns = 1 }) {
  const query = q();
  const options = { stream: true, permissionMode: 'bypassPermissions', model, maxTurns };
  if (appendSystemPrompt) options.systemPrompt = { type: 'preset', preset: 'claude_code', append: appendSystemPrompt };
  let out = '';
  const response = await query({ prompt, options });
  for await (const ev of response) {
    if (ev.type === 'assistant') for (const c of ev.message?.content || []) if (c.type === 'text') out += c.text;
    else if (ev.type === 'result' && ev.result && !out) out += ev.result;
  }
  return out;
}

module.exports = { id, cheapModel, runTurn, complete, getLastModel: () => _lastModel };
