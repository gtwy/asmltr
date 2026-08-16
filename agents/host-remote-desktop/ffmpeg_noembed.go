//go:build !embed_ffmpeg

package main

// Default build (no embed_ffmpeg tag): no ffmpeg is baked in, so the agent locates ffmpeg in its app
// dir or on PATH. This keeps plain `go build` fast and dependency-light for CI/cross-compile checks.
// Ship production artifacts with `-tags embed_ffmpeg` (see scripts/build-windows.sh) for the
// single-file, nothing-to-install drop.
var embeddedFFmpeg []byte
