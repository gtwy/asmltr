// Command host-remote-desktop is the native host agent for asmltr's custom WebRTC remote-desktop
// capability (see docs/REMOTE-DESKTOP.md). It dials OUT to the asmltr signaling broker (SSE
// /rd/stream + POST /rd/msg), answers offer_requests with a Pion WebRTC offer, publishes the real
// desktop (ffmpeg ddagrab/gdigrab → H.264) and optional system audio (Opus) as media tracks over a
// hole-punched peer-to-peer connection, and injects mouse/keyboard input received on a trust-gated
// `control` data channel via user32!SendInput. Single self-contained binary; ffmpeg is bundled
// (go:embed with the embed_ffmpeg build tag) or located in the app dir / PATH.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
)

var logger = log.New(os.Stderr, "", log.LstdFlags|log.Lmicroseconds)

func logf(format string, args ...any) { logger.Printf(format, args...) }

func main() {
	cfg, err := LoadConfig(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "config error:", err)
		fmt.Fprintln(os.Stderr, "run with -h for flags; broker URL + token are required.")
		os.Exit(2)
	}

	logf("asmltr host-remote-desktop starting")
	logf("broker=%s host_id=%s name=%q audio=%v control=%v capture=%s app_dir=%s",
		cfg.baseURL(), cfg.HostID, cfg.Name, cfg.Audio, cfg.Control, cfg.CaptureBackend, cfg.AppDir)

	agent, err := NewAgent(cfg)
	if err != nil {
		fmt.Fprintln(os.Stderr, "startup error:", err)
		os.Exit(1)
	}
	logf("ffmpeg resolved to %s", agent.ffmpegPath)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := agent.Run(ctx); err != nil && err != context.Canceled {
		logf("agent exited: %v", err)
		os.Exit(1)
	}
	logf("shutdown complete")
}
