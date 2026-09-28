'use strict';
/**
 * POSIX single-quoting for a value interpolated into a /bin/sh or bash line.
 *
 * Single quotes are the only shell quoting with no special characters inside, so `$`, backticks,
 * `"`, `\`, `!` and newlines all reach the program literally; an embedded `'` becomes `'\''`.
 * Wrapping a value in "…" by hand is NOT safe (`$`, backticks, `"` and `\` stay live), and a line
 * that a shell will parse must never have quotes stripped back off it: only the shell can undo
 * shell quoting. When no shell is needed at all, prefer spawn/execFile with an argv array.
 */
function shQuote(value) {
  return "'" + String(value == null ? '' : value).replace(/'/g, "'\\''") + "'";
}

module.exports = { shQuote };
