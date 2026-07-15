#!/usr/bin/env bash
# Provision the `<assistant-name>` shell shim (ASSISTANT_NAME → `asmltr claude`). Conflict-checked +
# idempotent inside the CLI. Best-effort: a non-zero here is non-fatal to the overall setup/update.
# Exit 0 = provisioned, 75 = skipped/not-applicable (retry next update).
set -uo pipefail
REPO="${ASMLTR_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
command -v node >/dev/null 2>&1 || { echo "no node — skip" >&2; exit 75; }
[ -f "$REPO/cli/asmltr.js" ] || { echo "no cli — skip" >&2; exit 75; }

if node "$REPO/cli/asmltr.js" provision-alias >/dev/null 2>&1; then
  echo "assistant alias provisioned"
  exit 0
fi
echo "provision-alias not applicable (no ASSISTANT_NAME / conflict) — skip" >&2
exit 75
