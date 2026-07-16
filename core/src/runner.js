'use strict';
/**
 * Runner — the engine-agnostic turn dispatcher.
 *
 * Historically this file WAS the Claude SDK runner. It is now a thin façade: it routes a turn to the
 * configured reasoning engine (claude | gemini | codex — see core/src/engines/) and keeps the same
 * public surface the pipeline already calls (runTurn / generateTitle / generateStatus /
 * generateSelfAssessment / getLastModel). No reasoning-engine SDK is imported here, so the core boots
 * and runs on ANY single engine — a Gemini-only or Codex-only install never loads the Claude SDK.
 *
 * The Claude behaviour is unchanged: with the default engine = claude, turns run exactly as before.
 */
const engineReg = require('../../shared/engines');
const engines = require('./engines');

/** Which engine runs this turn: opts.engine → the configured default. */
function engineFor(opts) { return (opts && opts.engine) || engineReg.getDefault(); }

/** Run one turn on the selected engine. Returns { text, segments, engineSessionId, tools, usage, isError }. */
async function runTurn(opts) {
  return engines.resolve(engineFor(opts)).runTurn(opts);
}

// The auxiliary labelers below run on the DEFAULT engine's cheap model and DESCRIBE activity — they
// never take actions. The prompt engineering is engine-agnostic; only the one-shot call is delegated
// to engine.complete(). They degrade gracefully (return '' / rethrow) if the engine can't be reached.

async function generateTitle(text) {
  const eng = engines.resolve();
  const model = process.env.ASMLTR_TITLE_MODEL || eng.cheapModel;
  const prompt =
    'Give a concise 3-6 word title in Title Case that summarizes what the following conversation is about. ' +
    'Reply with ONLY the title — no quotes, no trailing punctuation, no preamble.\n\n---\n' +
    String(text || '').slice(0, 4000);
  try {
    const out = await eng.complete({ prompt, model, maxTurns: 1 });
    return out.replace(/["'`]+/g, '').replace(/\s+/g, ' ').trim().split('\n')[0].replace(/[.:;,\s]+$/, '').slice(0, 60);
  } catch (_) { return ''; }
}

async function generateStatus(text) {
  const eng = engines.resolve();
  const model = process.env.ASMLTR_STATUS_MODEL || process.env.ASMLTR_TITLE_MODEL || eng.cheapModel;
  const prompt =
    'Give a concise 3-8 word phrase, starting with an -ing verb, that summarizes what the assistant is ' +
    'CURRENTLY working on in the following activity — e.g. "Debugging the email connector", "Testing the ' +
    'Discord streaming fix", "Waiting for user approval". This is a SUMMARY of past activity: do NOT ' +
    'continue the work, do NOT run any tools, do NOT use the word "I". Reply with ONLY the phrase — no ' +
    'preamble, no quotes, no trailing punctuation.\n\n---\n' +
    String(text || '').slice(0, 4000);
  const appendSystemPrompt =
    'You are ONLY a text-labeling function. You never take actions, never use tools, ' +
    'never speak in the first person, never continue or perform a task. You read a log of ANOTHER ' +
    'agent\'s activity and output a single short third-person label of what it is doing. Nothing else.';
  try {
    const out = await eng.complete({ prompt, model, maxTurns: 1, appendSystemPrompt });
    let s = out.replace(/["'`]+/g, '').replace(/\s+/g, ' ').trim().split('\n')[0].replace(/[.:;,\s]+$/, '');
    s = s.replace(/^(let me|i['’]?ll|i['’]?ve|i['’]?m|i am|i will|i need to|i should|i)\s+/i, '');
    s = s.charAt(0).toUpperCase() + s.slice(1);
    if (s.length > 80) s = s.slice(0, 80).replace(/\s+\S*$/, '');
    return s;
  } catch (_) { return ''; }
}

async function generateSelfAssessment(digest) {
  const eng = engines.resolve();
  const model = process.env.ASMLTR_ASSESSMENT_MODEL || engineReg.modelFor(engineReg.getDefault()) || eng.cheapModel;
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
  const appendSystemPrompt =
    'You are ONLY a reflective analysis function observing another agent\'s parts. ' +
    'You never take actions, never use tools, never continue the work, never give instructions or ' +
    'advice. You output a single JSON object describing what you observe. Nothing else.';
  const out = await eng.complete({ prompt, model, maxTurns: 1, appendSystemPrompt });
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

// getLastModel surfaces the concrete model id for the GUI — from whichever engine is default.
function getLastModel() { try { return engines.resolve().getLastModel(); } catch (_) { return null; } }

module.exports = { runTurn, generateTitle, generateStatus, generateSelfAssessment, getLastModel };
