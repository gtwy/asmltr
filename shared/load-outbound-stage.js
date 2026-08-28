'use strict';
/**
 * Prefer a host overlay outbound-stage wrap when present, else public shared/outbound-stage.
 * Overlay path: ASMLTR_OUTBOUND_STAGE or ~/.asmltr/ivy-local/overlay/outbound-stage.js
 * Public file is staging + root allowlist. Host PATH GATE lives in the overlay wrap.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function overlayStagePath() {
  const env = String(process.env.ASMLTR_OUTBOUND_STAGE || '').trim();
  if (env) return env;
  return path.join(os.homedir(), '.asmltr', 'ivy-local', 'overlay', 'outbound-stage.js');
}

function loadOutboundStage() {
  const publicStage = require('./outbound-stage');
  const overlayPath = overlayStagePath();
  try {
    if (!overlayPath || !fs.existsSync(overlayPath)) return publicStage;
    const overlay = require(overlayPath);
    if (typeof overlay.apply === 'function') {
      const wrapped = overlay.apply(null, { stage: publicStage });
      return wrapped || publicStage;
    }
    return publicStage;
  } catch (_) {
    return publicStage;
  }
}

module.exports = { overlayStagePath, loadOutboundStage };
