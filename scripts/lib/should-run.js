'use strict';
/**
 * Pure decisions for the updater's skip guards (scripts/update.js).
 *
 * Both take the changed-file set between the from-sha and target-sha
 * (`git diff --name-only <from> <target>`) and answer whether an expensive phase
 * still needs to run. Kept pure and dependency-free so they test without spawning
 * git or executing the updater's main().
 */

// The root `package-lock.json` is the single hoisted lockfile `npm ci` installs from, so a change to
// it means the installed tree changed. Also trigger on the root or a real workspace `package.json`
// (the workspaces declared in the root manifest: core, connectors, cli, insights/collector). A
// non-workspace manifest like `mobile/package.json` (a separately-built Capacitor app) does NOT feed
// the root install, so it is ignored & no longer forces a needless full rebuild.
const ROOT_INSTALL_MANIFESTS = new Set([
  'package.json',
  'package-lock.json',
  'core/package.json',
  'connectors/package.json',
  'cli/package.json',
  'insights/collector/package.json',
]);
function depsChanged(changedFiles) {
  return (changedFiles || []).some((f) => ROOT_INSTALL_MANIFESTS.has(f));
}

// True when the dashboard's build inputs changed, so the Docker image must be
// rebuilt. Matches anything under insights/dashboard/ or the base compose file.
function dashboardChanged(changedFiles) {
  return (changedFiles || []).some((f) => f.startsWith('insights/dashboard/') || f === 'insights/docker-compose.yml');
}

module.exports = { depsChanged, dashboardChanged };
