'use strict';

function cloneArgv(full, dir) {
  return ['clone', '--quiet', '--depth', '1', `https://github.com/${full}.git`, dir];
}

function cloneGitEnv(pat, baseEnv) {
  const env = { ...(baseEnv || process.env), GIT_TERMINAL_PROMPT: '0' };
  if (pat) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${pat}`;
  }
  return env;
}

function githubIdentityPrompt({ name, acct, patKey, issueNumber, full }) {
  return `GITHUB IDENTITY (CRITICAL): on this repo you act ONLY as ${acct}. The host's default gh/git auth may be a DIFFERENT, unauthorized account — NEVER use it here. For ANY GitHub operation, authenticate as ${acct} using this connector's PAT from the secret store key '${patKey}' (do not print the token, do not put it on a command line, do not export a token into the environment or argv). If you cannot authenticate as ${acct}, do NOT fall back to another account — say so and stop.`;
}

module.exports = { cloneArgv, cloneGitEnv, githubIdentityPrompt };
