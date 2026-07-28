#!/usr/bin/env node
'use strict';
/**
 * Native-addon ABI preflight. Node major upgrades change NODE_MODULE_VERSION (e.g. Node 20 = 115,
 * Node 24 = 137), so addons built for the old ABI fail to load until rebuilt. This checks the
 * addons the services actually load and fails fast with a clear remediation, instead of a cryptic
 * "bindings file not found" / "compiled against a different Node.js version" crash-loop under PM2.
 *
 * Run standalone (`npm run check:native`) or from a deploy step after the Node version changes.
 */
const path = require('path');

// addon → workspace dir it's installed under (the service that requires it)
const NATIVE = [
  { name: 'better-sqlite3', from: 'core' }, // core + collector: sessions, drafts, trust store, events
];

const ABI_ERR = /NODE_MODULE_VERSION|different Node\.js version|Could not locate the bindings|\.node['"]?$|was compiled against/i;
const broken = [];
for (const { name, from } of NATIVE) {
  try {
    require(require.resolve(name, { paths: [path.join(__dirname, '..', from)] }));
  } catch (e) {
    const first = String(e.message).split('\n')[0];
    if (ABI_ERR.test(e.message)) broken.push({ name, from, first });
    else broken.push({ name, from, first: first + ' (unexpected — may be a missing install)' });
  }
}

if (broken.length) {
  console.error(`\n[preflight] native addon load FAILED under Node ${process.version} (MODULE_VERSION ${process.versions.modules}):`);
  for (const b of broken) console.error(`  - ${b.name} (${b.from}/): ${b.first}`);
  console.error('\n  Fix: rebuild native modules for this Node, then restart the services:');
  console.error('    npm rebuild            # or: npm ci   (from the repo root)');
  console.error('    pm2 restart asmltr-core asmltr-connector-manager asmltr-insights-collector\n');
  process.exit(1);
}
console.log(`[preflight] native addons OK under Node ${process.version} (MODULE_VERSION ${process.versions.modules}).`);
