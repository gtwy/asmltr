//go:build embed_ffmpeg

package main

// This file is only compiled when building with `-tags embed_ffmpeg`. The build script
// (scripts/fetch-ffmpeg.sh) downloads a static Windows ffmpeg (BtbN win64-gpl, which includes the
// ddagrab DXGI Desktop Duplication filter) into assets/ffmpeg.exe before the build. go:embed then
// bakes that binary into the .exe, so the shipped artifact is fully self-contained — nothing to
// install on the Windows box. On first run it is extracted next to the agent (see ensureFFmpeg).

import _ "embed"

//go:embed assets/ffmpeg.exe
var embeddedFFmpeg []byte
