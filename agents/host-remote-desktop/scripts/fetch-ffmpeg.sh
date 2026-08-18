#!/usr/bin/env bash
# Fetch a static Windows ffmpeg (BtbN win64-gpl — includes the ddagrab DXGI Desktop Duplication
# filter) into assets/ffmpeg.exe so it can be embedded into the agent binary via go:embed
# (-tags embed_ffmpeg). Run this once before a self-contained build; the result is NOT committed.
#
# Override the source with FFMPEG_URL=... (e.g. to pin a specific dated release for reproducibility).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
assets="$here/assets"
mkdir -p "$assets"

url="${FFMPEG_URL:-https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "[fetch-ffmpeg] downloading $url"
curl -fsSL -o "$tmp/ffmpeg.zip" "$url"

echo "[fetch-ffmpeg] extracting ffmpeg.exe"
# The zip lays out <build>/bin/ffmpeg.exe — pull just that file out.
inner="$(unzip -Z1 "$tmp/ffmpeg.zip" | grep -E '/bin/ffmpeg\.exe$' | head -n1)"
if [[ -z "$inner" ]]; then
  echo "[fetch-ffmpeg] ERROR: ffmpeg.exe not found in archive" >&2
  exit 1
fi
unzip -p "$tmp/ffmpeg.zip" "$inner" > "$assets/ffmpeg.exe"

sz="$(wc -c < "$assets/ffmpeg.exe")"
echo "[fetch-ffmpeg] wrote $assets/ffmpeg.exe ($sz bytes)"
echo "[fetch-ffmpeg] verifying ddagrab filter is present..."
if command -v file >/dev/null 2>&1; then file "$assets/ffmpeg.exe"; fi
echo "[fetch-ffmpeg] done. Build the self-contained exe with: scripts/build-windows.sh"
