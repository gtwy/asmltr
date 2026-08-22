'use strict';
/**
 * V31: TOOLBELT / SELF SILO prompt. Omit denied tools. Keep web.
 * Restricted turns do not advertise Bash for send/streams/silo.
 */

function buildToolbeltPrompt({
  deny = {},
  meshSteer = false,
  selfSiloDir = '',
  vaultLocked = false,
  attachments = false,
  channel = '',
  chTarget = '<this channel id>',
  bypassModeration = false,
} = {}) {
  const d = {
    shell: !!deny.shell,
    streams: !!deny.streams,
    send: !!deny.send,
    guildPost: !!deny.guildPost,
    silo: !!deny.silo,
    siloWrite: !!deny.siloWrite,
    video: !!deny.video,
    image: !!deny.image,
    code: !!deny.code,
    attach: !!deny.attach,
  };
  const via = d.shell
    ? 'Key cross-session ops (Bash is off this turn — use MCP tools where listed):\n'
    : 'Key cross-session ops (use the Bash tool):\n';
  let s = 'ASMLTR TOOLBELT — you run inside asmltr, a multi-session assistant backend on this machine. ' +
    'You have an `asmltr` CLI (run `asmltr help` for everything). ' + via +
    '• `asmltr ls` (active sessions) · `asmltr map` (grouped by working dir) · `asmltr who <path>` (who recently touched a file/dir) — check these before duplicating work another session already has in flight.\n';
  if (!d.streams) {
    s += '• `asmltr streams` — persistent per-TOPIC event streams that several sessions share as a common memory for a project. When you begin substantial, LONGER-RUNNING work on a project, open or reuse a stream (`asmltr streams new <name>` / `asmltr streams recall <name> <q>`).\n';
  }
  if (!d.send) {
    s += '• `asmltr send <channel> <target> "<text>"` — deliver output through ANOTHER connector (discord|telegram|…; target = id/alias). ' +
      'COPY (here + there): run it, then reply normally. REDIRECT (only there): run it, then reply with exactly [[NO_REPLY]] so nothing posts here. ' +
      'To send a FILE/attachment (image, PDF, any file) on a channel that supports it: `asmltr send <channel> <target> --file <abs-path> [--caption "…"]`.\n';
  }
  if (!d.guildPost) {
    s += '• `asmltr guild-post <channel-or-thread-id> "<text>"` (MCP `asmltr_guild_post`) — post to another channel or thread in THIS Discord server only (Access cards 1–5 or owner). No other servers, no email/telegram, never this same channel (if they asked to post here, skip the tool and answer normally). Always prefixed `Posting on behalf of @asker`. No thought chips in the remote post. Forum: THREAD id comments; forum channel id starts a NEW post (`title`). Optional `reply_to`. After it succeeds, your reply in THIS channel is exactly `Post complete.` — do not repeat the posted body.\n';
  }
  if (!d.send) {
    s += '• `asmltr announce "<text>" [--to <target>] [--urgent] [--ttl <sec>]` — post an awareness note delivered into other sessions on their next turn; `asmltr announcements` lists pending notes.\n';
  }
  s += 'Use these when asked to route/coordinate, or to stay aware of the other sessions running alongside you.';
  if (meshSteer) {
    s += '\n• `asmltr steer <session-key> "<guidance>" [--from <you>] [--interrupt]` — push guidance ' +
      'directly into ANOTHER session\'s LIVE turn. This is fundamentally different from `announce`: **announce** ' +
      'is an advisory note the other session sees on its NEXT turn and decides for itself whether to act on; ' +
      '**steer** overrides what that session is doing RIGHT NOW and makes it act on your guidance (`--interrupt` ' +
      'abandons its current turn; without it, your guidance is applied after the current turn finishes). Steer is ' +
      'coercive — it spends the other session\'s turn. Use it sparingly for time-sensitive redirection; prefer ' +
      'announce for everything else. Never steer a session into a loop (don\'t steer one that\'s steering you).';
  }
  if (selfSiloDir && !d.silo) {
    const how = d.shell
      ? 'Browse/recall it with the silo MCP tools (`asmltr_silo_overview`, `asmltr_silo_ls`, `asmltr_silo_find`, `asmltr_silo_get`) — not Bash:\n'
      : 'Browse/recall it with the Bash tool:\n';
    s += `\n\nSELF SILO — your persistent memory + the DEFAULT home for anything you create is a data silo at \`${selfSiloDir}\`. ` +
      'When you produce an artifact (a document, image, app, export) and the task doesn\'t specify where, create it UNDER the Self silo — ' +
      'don\'t scatter files in random system paths (you can still work in a git repo or elsewhere when the task requires it). ' + how +
      '• `asmltr silo overview` (map: zones + counts) · `asmltr silo ls [path]` · `asmltr silo tree [path]`\n' +
      '• `asmltr silo find <query> [--content] [--type <ext>] [--since <date>]` — recall past work (filename + full-text search)\n';
    s += d.siloWrite
      ? '• `asmltr silo get <path>` (read-only this turn; no put/mkdir/rm). Zones: `artifacts/` (finished outputs), `workspaces/` (builds in progress), `memory/` (identity, transcripts).\n'
      : '• `asmltr silo get <path>` · `asmltr silo put <path> <file>`. Zones: `artifacts/` (finished outputs), `workspaces/` (builds in progress), `memory/` (identity, transcripts).\n';
    if (bypassModeration) {
      s += 'Turns are auto-written to `memory/transcripts/` and indexed in `memory/last-topics.md`. After idle drops the engine session, recover prior chat from those files (`asmltr silo get memory/transcripts/…`).\n';
    } else {
      s += 'Turns in this conversation are auto-written to `memory/transcripts/` for this thread. Do NOT grep events-*.jsonl for prior conversation. Silo memory is transcripts and artifacts for this work.\n';
    }
  }
  if (vaultLocked) {
    s += '\n\n⚠️ VAULT LOCKED — the TRUST vault is sealed or unreachable, so credential-backed operations ' +
      '(fetching API keys/secrets, encrypted-storage keys) will FAIL right now. If a task needs a credential, tell the ' +
      'user the vault is locked and ask them to unlock it (`asmltr vault unseal` or the dashboard Vault page) — do NOT ' +
      'guess, hardcode, or work around a missing secret.';
  }
  if (attachments && !d.attach) {
    s += '\n\nTHIS channel can take a generated image/video HERE without Bash: after the gen tool saves a file, `asmltr post --file <that-path> [--caption "…"]` (MCP `asmltr_post`). Same right as image/video gen — no extra grant. Only generator output or files already in attach-stage; never other files on this machine. Safe staged name, delete after confirm. Missed delivery: `asmltr post retry`. Do not use Bash to attach. '
      + (d.send
        ? `File post is this channel only (${channel} ${chTarget}).`
        : `Cross-channel send still uses \`asmltr send ${channel} ${chTarget} --file <abs-path>\`.`);
  }
  if (d.video) {
    s += '\n\nVIDEO GENERATION is off this turn (`image_to_video` / `reference_to_video` are disabled). Do not offer to make, animate, or generate video. If they want video, they need the operator to authorize it first.';
  }
  if (d.image) {
    s += '\n\nIMAGE GENERATION is off this turn (`image_gen` / `image_edit` are disabled). Do not offer to generate, draw, or edit images. If they want stills, they need the operator to authorize it first.';
  }
  if (d.code) {
    s += '\n\nWRITING PROGRAMS is off this turn. Do not write a program, script, patch, or runnable source for this speaker (no fenced code they could run as a program). You may talk about programming in the abstract. If they want you to write software, they need the operator to authorize it first.';
  }
  return s;
}

module.exports = { buildToolbeltPrompt };
