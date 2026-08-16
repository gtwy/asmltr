package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"time"

	"github.com/pion/webrtc/v4/pkg/media"
	"github.com/pion/webrtc/v4/pkg/media/h264reader"
	"github.com/pion/webrtc/v4/pkg/media/oggreader"
)

// sampleWriter is the subset of *webrtc.TrackLocalStaticSample we need — lets us test/pipe without
// pulling the full track type in here.
type sampleWriter interface {
	WriteSample(media.Sample) error
}

// videoFFmpegArgs builds the ffmpeg command line that captures the desktop and emits a raw Annex-B
// H.264 elementary stream on stdout, tuned for low latency.
//
// ddagrab (default) uses DXGI Desktop Duplication (GPU) — the frames land in GPU memory, so we
// hwdownload them, convert to yuv420p, and encode with libx264. gdigrab is a software fallback for
// boxes where ddagrab is unavailable.
func videoFFmpegArgs(cfg Config) []string {
	fps := cfg.Framerate
	common := []string{
		"-hide_banner",
		"-loglevel", "warning",
	}
	var input []string
	switch strings.ToLower(cfg.CaptureBackend) {
	case "gdigrab":
		input = []string{
			"-f", "gdigrab",
			"-framerate", itoa(fps),
			"-i", "desktop",
		}
	default: // ddagrab (DXGI Desktop Duplication)
		// ddagrab is a lavfi source filter. output_idx selects the monitor; framerate caps the rate.
		input = []string{
			"-f", "lavfi",
			"-i", fmt.Sprintf("ddagrab=output_idx=%d:framerate=%d", cfg.OutputIndex, fps),
			// bring frames back from GPU and normalise pixel format for libx264
			"-vf", "hwdownload,format=bgra",
		}
	}
	encode := []string{
		"-c:v", "libx264",
		"-preset", "ultrafast",
		"-tune", "zerolatency",
		"-profile:v", "baseline",
		"-pix_fmt", "yuv420p",
		"-g", itoa(fps * 2), // keyframe every ~2s so late/reconnecting viewers recover quickly
		"-b:v", nonEmpty(cfg.VideoBitrate, "8M"),
		"-maxrate", nonEmpty(cfg.VideoBitrate, "8M"),
		"-bufsize", "1M",
		"-bf", "0", // no B-frames — lower latency, simpler packetization
		"-f", "h264",
		"pipe:1",
	}
	args := append([]string{}, common...)
	args = append(args, input...)
	args = append(args, encode...)
	return args
}

// audioFFmpegArgs builds the ffmpeg command line that captures system audio (dshow loopback device)
// and emits Opus-in-Ogg on stdout. Requires a loopback capture device name (cfg.AudioDevice).
func audioFFmpegArgs(cfg Config) []string {
	return []string{
		"-hide_banner",
		"-loglevel", "warning",
		"-f", "dshow",
		"-i", "audio=" + cfg.AudioDevice,
		"-c:a", "libopus",
		"-b:a", nonEmpty(cfg.AudioBitrate, "96k"),
		"-application", "lowdelay",
		"-frame_duration", "20",
		"-f", "ogg",
		"pipe:1",
	}
}

// captureVideo spawns ffmpeg for video and pumps its H.264 output into the track until ctx is done.
func captureVideo(ctx context.Context, cfg Config, ffmpegPath string, track sampleWriter) error {
	args := videoFFmpegArgs(cfg)
	logf("video ffmpeg: %s %s", ffmpegPath, strings.Join(args, " "))
	cmd := exec.CommandContext(ctx, ffmpegPath, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start video ffmpeg: %w", err)
	}
	go drainStderr("video", stderr)

	// each VCL NAL advances the RTP timestamp by one frame; SPS/PPS/SEI share the frame's timestamp.
	frameDur := time.Second / time.Duration(max(cfg.Framerate, 1))
	reader, err := h264reader.NewReader(bufio.NewReaderSize(stdout, 1<<16))
	if err != nil {
		_ = cmd.Process.Kill()
		return fmt.Errorf("h264 reader: %w", err)
	}
	for {
		if ctx.Err() != nil {
			break
		}
		nal, err := reader.NextNAL()
		if err != nil {
			if err == io.EOF {
				break
			}
			logf("video: read NAL: %v", err)
			break
		}
		dur := time.Duration(0)
		if isVCL(uint8(nal.UnitType)) {
			dur = frameDur
		}
		if err := track.WriteSample(media.Sample{Data: nal.Data, Duration: dur}); err != nil {
			logf("video: write sample: %v", err)
			break
		}
	}
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	return ctx.Err()
}

// captureAudio spawns ffmpeg for audio and pumps its Opus/Ogg output into the track until ctx is done.
func captureAudio(ctx context.Context, cfg Config, ffmpegPath string, track sampleWriter) error {
	if strings.TrimSpace(cfg.AudioDevice) == "" {
		return fmt.Errorf("audio requested but no audio_device configured (dshow loopback device name)")
	}
	args := audioFFmpegArgs(cfg)
	logf("audio ffmpeg: %s %s", ffmpegPath, strings.Join(args, " "))
	cmd := exec.CommandContext(ctx, ffmpegPath, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start audio ffmpeg: %w", err)
	}
	go drainStderr("audio", stderr)

	ogg, _, err := oggreader.NewWith(bufio.NewReaderSize(stdout, 1<<16))
	if err != nil {
		_ = cmd.Process.Kill()
		return fmt.Errorf("ogg reader: %w", err)
	}
	var lastGranule uint64
	for {
		if ctx.Err() != nil {
			break
		}
		page, header, err := ogg.ParseNextPage()
		if err != nil {
			if err == io.EOF {
				break
			}
			logf("audio: parse page: %v", err)
			break
		}
		// Opus runs at 48kHz; the granule delta gives the sample count for this page.
		sampleCount := header.GranulePosition - lastGranule
		lastGranule = header.GranulePosition
		dur := time.Duration(float64(sampleCount) / 48000.0 * float64(time.Second))
		if err := track.WriteSample(media.Sample{Data: page, Duration: dur}); err != nil {
			logf("audio: write sample: %v", err)
			break
		}
	}
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	return ctx.Err()
}

func drainStderr(tag string, r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line != "" {
			logf("ffmpeg[%s]: %s", tag, line)
		}
	}
}

// isVCL reports whether an H.264 NAL unit type carries coded picture data (advances a frame).
func isVCL(t uint8) bool { return t >= 1 && t <= 5 }

func itoa(n int) string { return fmt.Sprintf("%d", n) }

func nonEmpty(v, def string) string {
	if strings.TrimSpace(v) == "" {
		return def
	}
	return v
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
