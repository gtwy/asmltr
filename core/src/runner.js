'use strict';
/**
 * asmltr-core — local Agent SDK runner (plan §A5).
 *
 * Wraps @anthropic-ai/claude-code query() (the LOCAL Agent SDK on the Max
 * subscription — NEVER an ANTHROPIC_API_KEY path). Runs one turn, maps the SDK
 * event stream into telemetry events + accumulated reply text, and captures the
 * SDK-assigned session id for resume.
 *
 * Modeled on the working production pattern in eve-assistant/claude-sdk-chat.js,
 * minus the terminal-output cleaning cruft (not needed off the structured stream).
 */

const { query } = require('@anthropic-ai/claude-agent-sdk'); // programmatic Agent SDK (the query() API
// moved here when @anthropic-ai/claude-code became CLI-only at 2.x). Bundles a current CLI runtime,
// so channel turns run the same modern models as the interactive terminal.

let _lastModel = null; // the model id the most recent turn actually ran on (surfaced in the GUI)

/**
 * Run one turn.
 * @param {object} args
 * @param {string} args.prompt          clean user message
 * @param {string} [args.systemPrompt]  appended system prompt (from resolver.buildSystemPrompt)
 * @param {string|null} [args.resume]   engine_session_id to resume, or null for new
 * @param {AbortController} [args.abortController]
 * @param {(evt:object)=>void} [args.onEvent]  per-SDK-event hook (for live streaming/telemetry)
 * @returns {Promise<{text:string, engineSessionId:string|null, tools:Array, usage:object, isError:boolean}>}
 */
async function runTurn({ prompt, systemPrompt, resume = null, cwd, abortController, onEvent, onDelta, onSegment, onTool, onThinking, images = [] }) {
  const options = {
    stream: true,
    // Full autonomy (the equivalent of --dangerously-skip-permissions): permissionMode bypass +
    // IS_SANDBOX=1 (set in server.js). The raw CLI flag is REJECTED as root on the modern CLI, so we
    // rely on bypassPermissions instead — verified to run tools with no prompts as root.
    permissionMode: 'bypassPermissions',
    // Surface full process insight: tool RESULTS arrive as `user` messages only with
    // includePartialMessages; thinking blocks appear when maxThinkingTokens > 0
    // (adaptive — trivial turns won't think, so overhead is self-limiting).
    includePartialMessages: true,
  };
  // Pin the model so channel turns match the terminal. Resolved via shared/runtime (GUI-set file →
  // ASMLTR_MODEL → 'opus'), so a dashboard change applies on the NEXT turn with no restart. An alias
  // (opus/sonnet) auto-tracks the latest of that tier; a full id pins exactly.
  const _model = require('../../shared/runtime').getModel();
  if (_model) options.model = _model;
  const thinkTokens = Number(process.env.ASMLTR_MAX_THINKING_TOKENS ?? 4000);
  if (thinkTokens > 0) options.maxThinkingTokens = thinkTokens;
  // Spawn cwd controls which CLAUDE.md hierarchy loads (ambient context) AND where
  // the session is stored for --resume. Neutral default (/root = the assistant identity)
  // avoids project-context bleed into general channel chat.
  if (cwd) options.cwd = cwd;
  // Append our system prompt via the SDK's dedicated option. (NOT extraArgs —
  // the SDK ignores extraArgs['append-system-prompt']; appendSystemPrompt is the
  // real option. This carries channel-awareness + trust authz + connector context.)
  if (systemPrompt) options.appendSystemPrompt = systemPrompt;
  if (abortController) options.abortController = abortController;
  if (resume) options.resume = resume;

  // Vision: when the turn carries images, pass the prompt as the SDK's streaming-
  // input form (one user message with text + image content blocks) instead of a
  // bare string. images: [{ media_type, data(base64) }]. The local Agent SDK
  // forwards these to the model as real image input (verified end-to-end).
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
  const segments = []; // each assistant text block in order (tools split them) — lets a
                       // public renderer separate intermediate narration from the final answer
  let engineSessionId = resume || null;
  const tools = [];
  let usage = { tokens_in: 0, tokens_out: 0, cost_usd: 0 };
  let isError = false;

  for await (const event of response) {
    if (abortController && abortController.signal.aborted) break;
    if (onEvent) { try { onEvent(event); } catch (_) { /* never let a telemetry hook break a turn */ } }
    // Incremental assistant TEXT tokens (includePartialMessages) → live streaming out.
    if (onDelta && event.type === 'stream_event' && event.event && event.event.type === 'content_block_delta'
        && event.event.delta && event.event.delta.type === 'text_delta' && event.event.delta.text) {
      try { onDelta(event.event.delta.text); } catch (_) {}
    }

    switch (event.type) {
      case 'system':
        if (event.session_id) engineSessionId = event.session_id;
        if (event.model) _lastModel = event.model; // the id our alias actually resolved to (for the GUI)
        break;
      case 'assistant':
        for (const c of event.message?.content || []) {
          // separate text blocks (they're split by tool calls) so a narration block
          // doesn't run straight into the next block ("…about.ops-hub is…")
          if (c.type === 'text' && c.text) {
            const seg = c.text.trim();
            segments.push(seg); text += (text && !text.endsWith('\n') ? '\n\n' : '') + c.text;
            // A COMPLETED assistant text block = one "step". Step consumers (Discord) post each
            // as it lands; the LAST block is the final answer. (Distinct from onDelta's tokens.)
            if (onSegment) { try { onSegment(seg); } catch (_) {} }
          } else if (c.type === 'tool_use') {
            tools.push({ id: c.id, name: c.name, input: c.input });
            if (onTool) { try { onTool({ name: c.name, input: c.input }); } catch (_) {} }
          } else if (c.type === 'thinking' && c.thinking && onThinking) {
            try { onThinking(c.thinking); } catch (_) {}
          }
        }
        break;
      case 'result':
        if (event.session_id) engineSessionId = event.session_id;
        isError = !!event.is_error;
        // Token/cost accounting — field names are defensive across SDK versions.
        if (event.usage) {
          usage.tokens_in = event.usage.input_tokens || event.usage.inputTokens || 0;
          usage.tokens_out = event.usage.output_tokens || event.usage.outputTokens || 0;
        }
        usage.cost_usd = event.total_cost_usd || event.cost_usd || 0; // ~0 on Max subscription
        if (typeof event.result === 'string' && !text) text = event.result;
        break;
      case 'error':
        isError = true;
        break;
      default:
        break;
    }
  }

  return { text: text.trim(), segments: segments.filter(Boolean), engineSessionId, tools, usage, isError };
}

/**
 * Generate a short session title from conversation text — a minimal, fast, no-tools,
 * no-resume SDK call on a cheap model (rides the same subscription; no API key). Used by
 * the collector to label session cards. Returns a cleaned ≤60-char Title Case string, or ''.
 */
async function generateTitle(text) {
  const model = process.env.ASMLTR_TITLE_MODEL || 'haiku';
  const prompt =
    'Give a concise 3-6 word title in Title Case that summarizes what the following conversation is about. ' +
    'Reply with ONLY the title — no quotes, no trailing punctuation, no preamble.\n\n---\n' +
    String(text || '').slice(0, 4000);
  // Mirror the known-good runTurn option set (stream + bypass perms), just on a cheap model.
  // A title is a single plain-text answer — no tools, no thinking needed.
  const options = {
    stream: true,
    permissionMode: 'bypassPermissions',
    model,
    maxTurns: 1,
  };
  let out = '';
  const response = await query({ prompt, options });
  for await (const ev of response) {
    if (ev.type === 'assistant') for (const c of ev.message?.content || []) if (c.type === 'text') out += c.text;
    else if (ev.type === 'result' && ev.result && !out) out += ev.result;
  }
  return out.replace(/["'`]+/g, '').replace(/\s+/g, ' ').trim().split('\n')[0].replace(/[.:;,\s]+$/, '').slice(0, 60);
}

/**
 * Generate a LIVE one-line status of what a session is currently DOING (present tense) from its
 * recent activity — the rolling counterpart to generateTitle (title = stable topic; status = what
 * it's doing now). Cheap haiku call. The collector shows it on the dashboard cards. Returns ≤80 chars.
 */
async function generateStatus(text) {
  const model = process.env.ASMLTR_STATUS_MODEL || process.env.ASMLTR_TITLE_MODEL || 'haiku';
  const prompt =
    'Give a concise 3-8 word phrase, starting with an -ing verb, that summarizes what the assistant is ' +
    'CURRENTLY working on in the following activity — e.g. "Debugging the email connector", "Testing the ' +
    'Discord streaming fix", "Waiting for user approval". This is a SUMMARY of past activity: do NOT ' +
    'continue the work, do NOT run any tools, do NOT use the word "I". Reply with ONLY the phrase — no ' +
    'preamble, no quotes, no trailing punctuation.\n\n---\n' +
    String(text || '').slice(0, 4000);
  const options = {
    stream: true, permissionMode: 'bypassPermissions',
    model, maxTurns: 1,
    // Override the agentic persona — otherwise the model reads the activity log as ITS task and
    // "continues" it in the first person ("I'll check…") instead of labeling it.
    appendSystemPrompt: 'You are ONLY a text-labeling function. You never take actions, never use tools, ' +
      'never speak in the first person, never continue or perform a task. You read a log of ANOTHER ' +
      'agent\'s activity and output a single short third-person label of what it is doing. Nothing else.',
  };
  let out = '';
  const response = await query({ prompt, options });
  for await (const ev of response) {
    if (ev.type === 'assistant') for (const c of ev.message?.content || []) if (c.type === 'text') out += c.text;
    else if (ev.type === 'result' && ev.result && !out) out += ev.result;
  }
  let s = out.replace(/["'`]+/g, '').replace(/\s+/g, ' ').trim().split('\n')[0].replace(/[.:;,\s]+$/, '');
  // Defensive: if a first-person continuation still leaks through, strip the lead-in.
  s = s.replace(/^(let me|i['’]?ll|i['’]?ve|i['’]?m|i am|i will|i need to|i should|i)\s+/i, '');
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (s.length > 80) s = s.slice(0, 80).replace(/\s+\S*$/, ''); // trim to a word boundary, not mid-word
  return s;
}

/**
 * The self-assessment reflector — proprioception's SLOW, considered voice (Phase 1b).
 *
 * Where generateStatus labels ONE part in a phrase, this reads the whole body at once (a digest of
 * all current parts + their structural links, parts enumerated [1],[2],…) and deduces:
 *   goal      — one honest sentence: what the whole seems to be working toward right now
 *   threads   — the distinct workstreams currently in flight
 *   flags     — tensions worth noticing (duplication, drift, two parts fighting the same file…)
 *   relations — meaning-level edges BETWEEN parts, referenced by the digest indices, so the caller
 *               can fold them onto the structural graph (feeds / duplicates / same-subject / loops-back)
 *
 * Non-influential by design: it is a MIRROR. It describes; it never instructs a part what to do.
 * Uses a capable model (this is the considered pass, run ~25 min apart, not the always-on skeleton).
 * Returns a parsed object or throws.
 */
async function generateSelfAssessment(digest) {
  const model = process.env.ASMLTR_ASSESSMENT_MODEL || process.env.ASMLTR_MODEL || 'opus';
  const prompt =
    'Below is a live snapshot of an AI assistant\'s PARTS — its concurrent working sessions ("limbs"), ' +
    'each numbered [n], with what it is doing and any structural links between them. You are that ' +
    'assistant\'s proprioception: a NEUTRAL inner observer of the WHOLE. Read the snapshot and reflect.\n\n' +
    'Reply with ONLY a JSON object, no preamble, no code fence, exactly this shape:\n' +
    '{\n' +
    '  "goal": "<one honest sentence naming the THROUGH-LINE the parts share — climb to whatever altitude ' +
    'makes them cohere: a specific shared aim if they have one, else the common subject, domain, or mode of ' +
    'work (e.g. \'advancing the platform on several fronts\', \'supporting the operator\'s current priorities\'). ' +
    'A single part\'s aim IS the goal. Only say \'no shared thread yet — the parts are genuinely unrelated\' ' +
    'when there is truly no common subject, domain, or direction.>",\n' +
    '  "threads": ["<short phrase per distinct workstream in flight>"],\n' +
    '  "flags": ["<short phrase per tension worth noticing: duplication, drift, two parts on the same file, a stuck part — [] if none>"],\n' +
    '  "relations": [{"a": <part number>, "b": <part number>, "rel": "feeds|duplicates|same-subject|loops-back"}]\n' +
    '}\n' +
    'Rules: deduce, do not instruct — this is a mirror, never advice. Reference parts only by their [n]. ' +
    'For the GOAL, actively look for the loosest honest through-line before concluding there is none — parts ' +
    'usually share a subject, a domain, a mode, or a direction of travel even when they look different on the ' +
    'surface; name that rather than giving up. "Unrelated" is a rare last resort, not a default. RELATIONS are ' +
    'stricter: never invent an edge between two parts that are genuinely unrelated. Keep threads/flags under 10 words each.\n\n---\n' +
    String(digest || '').slice(0, 8000);
  const options = {
    stream: true, permissionMode: 'bypassPermissions', model, maxTurns: 1,
    // Same guard as generateStatus: it must LABEL the body, not adopt the work as its own.
    appendSystemPrompt: 'You are ONLY a reflective analysis function observing another agent\'s parts. ' +
      'You never take actions, never use tools, never continue the work, never give instructions or ' +
      'advice. You output a single JSON object describing what you observe. Nothing else.',
  };
  let out = '';
  const response = await query({ prompt, options });
  for await (const ev of response) {
    if (ev.type === 'assistant') for (const c of ev.message?.content || []) if (c.type === 'text') out += c.text;
    else if (ev.type === 'result' && ev.result && !out) out += ev.result;
  }
  // Extract the first {...} block and parse defensively.
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('assessment: no JSON in model output');
  const parsed = JSON.parse(m[0]);
  return {
    goal: typeof parsed.goal === 'string' ? parsed.goal.trim().slice(0, 240) : '',
    threads: Array.isArray(parsed.threads) ? parsed.threads.filter((t) => typeof t === 'string').map((t) => t.trim().slice(0, 80)).slice(0, 12) : [],
    flags: Array.isArray(parsed.flags) ? parsed.flags.filter((t) => typeof t === 'string').map((t) => t.trim().slice(0, 100)).slice(0, 12) : [],
    relations: Array.isArray(parsed.relations)
      ? parsed.relations.filter((r) => r && Number.isFinite(+r.a) && Number.isFinite(+r.b) && typeof r.rel === 'string')
          .map((r) => ({ a: +r.a, b: +r.b, rel: r.rel.trim().slice(0, 24) })).slice(0, 40)
      : [],
  };
}

module.exports = { runTurn, generateTitle, generateStatus, generateSelfAssessment, getLastModel: () => _lastModel };
