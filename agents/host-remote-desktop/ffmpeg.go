package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// ffmpegBinaryName is the on-disk name of the bundled/extracted ffmpeg for the target OS.
func ffmpegBinaryName() string {
	if runtime.GOOS == "windows" {
		return "ffmpeg.exe"
	}
	return "ffmpeg"
}

// ensureFFmpeg resolves a usable ffmpeg executable, in priority order:
//  1. cfg.FFmpegPath if set and it exists.
//  2. An ffmpeg embedded in this binary (embed_ffmpeg build tag) → extracted into AppDir on first run.
//     This is the "everything ships with the installer" path: nothing to install on the target box.
//  3. ffmpeg already sitting in AppDir.
//  4. ffmpeg found on PATH.
//
// It returns the absolute path to the executable.
func ensureFFmpeg(cfg Config) (string, error) {
	if cfg.FFmpegPath != "" {
		if fileExists(cfg.FFmpegPath) {
			return cfg.FFmpegPath, nil
		}
		return "", fmt.Errorf("ffmpeg_path %q does not exist", cfg.FFmpegPath)
	}

	name := ffmpegBinaryName()
	dst := filepath.Join(cfg.AppDir, name)

	// 2. embedded → extract (self-contained single-file drop)
	if len(embeddedFFmpeg) > 0 {
		if err := extractIfNeeded(dst, embeddedFFmpeg); err != nil {
			return "", fmt.Errorf("extract embedded ffmpeg: %w", err)
		}
		logf("using embedded ffmpeg extracted to %s (%d bytes)", dst, len(embeddedFFmpeg))
		return dst, nil
	}

	// 3. already in the app dir
	if fileExists(dst) {
		return dst, nil
	}

	// 4. on PATH
	if p, err := exec.LookPath(name); err == nil {
		return p, nil
	}
	// also try bare "ffmpeg" on non-windows dev boxes
	if name != "ffmpeg" {
		if p, err := exec.LookPath("ffmpeg"); err == nil {
			return p, nil
		}
	}

	return "", fmt.Errorf("ffmpeg not found: no embedded build (rebuild with -tags embed_ffmpeg), none in %s, none on PATH", cfg.AppDir)
}

// extractIfNeeded writes data to dst unless an identical file is already there (checked by SHA-256),
// and marks it executable. Concurrency-safe enough for first-run single-process extraction.
func extractIfNeeded(dst string, data []byte) error {
	want := sha256.Sum256(data)
	if existing, err := os.ReadFile(dst); err == nil {
		got := sha256.Sum256(existing)
		if hex.EncodeToString(got[:]) == hex.EncodeToString(want[:]) {
			return nil // already extracted, identical
		}
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, data, 0o755); err != nil {
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func fileExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && !fi.IsDir()
}
