#!/usr/bin/env bash
# Link the asmltr agent skill into the coding agent's skills dir so it can drive asmltr. Idempotent.
# Exit 0 = linked/already-correct, 75 = not applicable here (skip).
set -uo pipefail
REPO="${ASMLTR_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
SRC="$REPO/skills/asmltr"
[ -d "$SRC" ] || { echo "no skills/asmltr in repo — skip" >&2; exit 75; }

SKILLS_DIR="${ASMLTR_SKILLS_DIR:-$HOME/.claude/skills}"
DEST="$SKILLS_DIR/asmltr"

if [ -L "$DEST" ] && [ "$(readlink -f "$DEST")" = "$(readlink -f "$SRC")" ]; then echo "skill already linked"; exit 0; fi
if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then echo "$DEST exists and is not our symlink — leaving it" >&2; exit 75; fi
mkdir -p "$SKILLS_DIR" || { echo "cannot create $SKILLS_DIR — skip" >&2; exit 75; }
ln -sf "$SRC" "$DEST"
echo "linked $DEST -> $SRC"
