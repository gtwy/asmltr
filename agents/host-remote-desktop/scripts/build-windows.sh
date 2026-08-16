#!/usr/bin/env bash
# Build the self-contained Windows agent: host-remote-desktop.exe with ffmpeg embedded.
#
#   scripts/build-windows.sh            → fetch ffmpeg if missing, then build with it embedded
#   EMBED=0 scripts/build-windows.sh    → build WITHOUT embedding (agent locates ffmpeg on PATH/app dir)
#
# The embedded build is a single-file drop: copy the .exe to the Windows box and run it — nothing
# else to install. Cross-compiles from Linux/macOS (no CGO; SendInput is called via syscall).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

out="host-remote-desktop.exe"
export GOOS=windows GOARCH=amd64 CGO_ENABLED=0

if [[ "${EMBED:-1}" == "1" ]]; then
  if [[ ! -f assets/ffmpeg.exe ]]; then
    echo "[build] assets/ffmpeg.exe missing — fetching..."
    scripts/fetch-ffmpeg.sh
  fi
  echo "[build] building $out WITH embedded ffmpeg ($(wc -c < assets/ffmpeg.exe) bytes)"
  go build -tags embed_ffmpeg -ldflags "-s -w" -o "$out" .
else
  echo "[build] building $out WITHOUT embedded ffmpeg (locate at runtime)"
  go build -ldflags "-s -w" -o "$out" .
fi

echo "[build] done: $here/$out ($(wc -c < "$out") bytes)"
