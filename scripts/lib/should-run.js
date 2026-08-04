'use strict';
/**
 * Pure decisions for the updater's skip guards (scripts/update.js).
 *
 * Both take the changed-file set between the from-sha and target-sha
 * (`git diff --name-only <from> <target>`) and answer whether an expensive phase
 * still needs to run. Kept pure and dependency-free so they test without spawning
 * git or executing the updater's main().
 */

// True when the root or any workspace dependency manifest changed, so the root
// `npm ci` must run. Matches package.json / package-lock.json at any depth.
function depsChanged(changedFiles) {
  return (changedFiles || []).some((f) => /(^|\/)package(-lock)?\.json$/.test(f));
}

// True when the dashboard's build inputs changed, so the Docker image must be
// rebuilt. Matches anything under insights/dashboard/ or the base compose file.
function dashboardChanged(changedFiles) {
  return (changedFiles || []).some((f) => f.startsWith('insights/dashboard/') || f === 'insights/docker-compose.yml');
}

module.exports = { depsChanged, dashboardChanged };
