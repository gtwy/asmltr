#!/usr/bin/env bash
# Link the asmltr CLI onto PATH so `asmltr ...` works everywhere. Idempotent.
# Exit 0 = linked/already-correct, 75 = not applicable here (skip, retry later).
set -uo pipefail
REPO="${ASMLTR_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
SRC="$REPO/cli/asmltr.js"
DEST="${ASMLTR_CLI_LINK:-/usr/local/bin/asmltr}"

[ -f "$SRC" ] || { echo "no cli/asmltr.js — skip" >&2; exit 75; }
chmod +x "$SRC" 2>/dev/null || true

if [ -L "$DEST" ] && [ "$(readlink -f "$DEST")" = "$(readlink -f "$SRC")" ]; then echo "cli already linked"; exit 0; fi
if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then echo "$DEST exists and is not our symlink — leaving it" >&2; exit 75; fi
dir="$(dirname "$DEST")"
[ -w "$dir" ] || { echo "$dir not writable (needs sudo) — skip" >&2; exit 75; }
ln -sf "$SRC" "$DEST"
echo "linked $DEST -> $SRC"
