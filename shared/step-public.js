'use strict';
/**
 * Public Discord step helpers. Grok thoughts stay off Discord; tool start
 * posts a short human chip (or a sanitized title when stream_tools is on).
 * Generic leak patterns only — no name denylist.
 */

const ACP_TYPE = /^(tool_call|tool_call_update|tool_use|function_call)$/i;

function looksLikePromptLeak(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  if (/CURRENT SPEAKER/i.test(s)) return true;
  if (/\bidentity\.md\b/i.test(s)) return true;
  if (/\bCLAUDE\.md\b/i.test(s)) return true;
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(s)) return true;
  if (/\/home\/[A-Za-z0-9._-]+/.test(s)) return true;
  return false;
}

function toolTitle(tool) {
  const raw = typeof tool === 'string'
    ? tool
    : (tool && (tool.name || tool.title || tool.kind)) || '';
  const s = String(raw || '').trim();
  if (!s || ACP_TYPE.test(s)) return '';
  if (/[\\/]/.test(s)) return '';
  const first = s.split(/[\s.:]+/)[0];
  return first.slice(0, 40);
}

function humanToolChip(tool) {
  const t = toolTitle(tool).toLowerCase();
  if (/^(read|read_file|readfile|cat|open)$/.test(t)) return 'Reading a file';
  if (/^(bash|shell|run|exec|command|sh)$/.test(t)) return 'Running a command';
  if (/(web|lookup|browse|fetch|http)/.test(t)) return 'Looking something up';
  if (/^(search|grep|glob|find|rg)$/.test(t)) return 'Searching';
  return 'Working';
}

/** Discord line to post, or '' to skip. streamTools true → 🔧 title; else human chip. */
function discordToolLine(streamTools, tool) {
  if (streamTools) {
    const title = toolTitle(tool);
    return `-# 🔧 \`${title || 'Working'}\``;
  }
  return `-# ${humanToolChip(tool)}`;
}

module.exports = { looksLikePromptLeak, toolTitle, humanToolChip, discordToolLine };
