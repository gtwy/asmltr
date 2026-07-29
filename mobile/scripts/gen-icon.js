#!/usr/bin/env node
'use strict';
/**
 * Generate the Android launcher icons (adaptive + legacy, all densities) from the robot-head logo,
 * recolored to the assistant's identity palette so the app icon matches the web GUI / favicon. Colors
 * come from ASMLTR_ICON_COLORS="#hex1,#hex2" or the identity `palette` facet; falls back to the brand
 * violet→magenta. Requires rsvg-convert + ImageMagick `convert`; if either is missing it no-ops and the
 * committed default icons stand. Run by build.sh before patch-android.js copies res/ into the project.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RES = path.join(ROOT, 'native', 'res');
const LOGO = path.join(ROOT, 'branding', 'logo.svg');
const BG = '#14141F';
const DENS = { mdpi: [48, 108], hdpi: [72, 162], xhdpi: [96, 216], xxhdpi: [144, 324], xxxhdpi: [192, 432] };

function have(bin) { try { execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; } catch { return false; } }
if (!have('rsvg-convert') || !have('convert')) { console.log('gen-icon: rsvg-convert/convert not found — keeping committed icons'); process.exit(0); }

// --- resolve the two gradient colors ---
function palette() {
  if (process.env.ASMLTR_ICON_COLORS) return process.env.ASMLTR_ICON_COLORS;
  try { const id = require(path.join(ROOT, '..', 'shared', 'identity')); const p = id.getFacet && id.getFacet('palette'); if (p) return String(p); } catch (_) {}
  return '';
}
const hexes = (palette().match(/#[0-9a-fA-F]{6}/g) || []);
const c1 = hexes[0] || '#8B5CF6';
const c2 = hexes[1] || hexes[0] || '#EC4899';

// --- themed SVG: swap the two gradient stops in logo.svg ---
let svg = fs.readFileSync(LOGO, 'utf8');
svg = svg.replace(/stop-color="#8B5CF6"/i, `stop-color="${c1}"`).replace(/stop-color="#EC4899"/i, `stop-color="${c2}"`);
const tmp = path.join(require('os').tmpdir(), 'asmltr-icon.svg');
fs.writeFileSync(tmp, svg);

const sh = (cmd) => execFileSync('sh', ['-c', cmd], { stdio: 'ignore' });
for (const [d, [L, F]] of Object.entries(DENS)) {
  const dir = path.join(RES, `mipmap-${d}`); fs.mkdirSync(dir, { recursive: true });
  const lg = Math.round(L * 0.6), fg = Math.round(F * 0.52);
  // legacy square (robot on dark bg) + round (same; launcher masks)
  sh(`rsvg-convert -w ${lg} -h ${lg} "${tmp}" -o /tmp/_lg.png`);
  sh(`convert -size ${L}x${L} xc:"${BG}" /tmp/_lg.png -gravity center -composite "${dir}/ic_launcher.png"`);
  fs.copyFileSync(path.join(dir, 'ic_launcher.png'), path.join(dir, 'ic_launcher_round.png'));
  // adaptive foreground (transparent, logo in the safe zone)
  sh(`rsvg-convert -w ${fg} -h ${fg} "${tmp}" -o /tmp/_fg.png`);
  sh(`convert /tmp/_fg.png -background none -gravity center -extent ${F}x${F} "${dir}/ic_launcher_foreground.png"`);
}
// keep the adaptive background color in sync (dark for gradient contrast). ONE definition only, in its
// own file (it overwrites Capacitor's ic_launcher_background.xml) — duplicating it fails mergeResources.
const valFile = path.join(RES, 'values', 'ic_launcher_background.xml');
try {
  let v = fs.readFileSync(valFile, 'utf8');
  v = v.replace(/<color name="ic_launcher_background">[^<]*<\/color>/, `<color name="ic_launcher_background">${BG}</color>`);
  fs.writeFileSync(valFile, v);
} catch (_) {}
console.log(`gen-icon: launcher icons themed ${c1} → ${c2}`);
