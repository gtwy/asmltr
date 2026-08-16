package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Config is the full runtime configuration for the host agent. It is resolved from (lowest → highest
// precedence): built-in defaults → JSON config file → environment variables (ASMLTR_RD_* / RD_*) →
// command-line flags. No host/URL/secret is ever hardcoded; everything below is overridable.
type Config struct {
	// Signaling / identity
	BrokerURL string `json:"broker_url"` // base URL of the asmltr remote-desktop broker, e.g. https://asmltr.example.com
	Token     string `json:"token"`      // peer token (matches an entry in the broker keys.json)
	HostID    string `json:"host_id"`    // stable id this machine registers under
	Name      string `json:"name"`       // human-friendly display name shown to viewers

	// Capabilities we advertise on connect
	Audio   bool `json:"audio"`   // publish a system-audio track
	Control bool `json:"control"` // accept the control data channel (mouse/keyboard injection)

	// Capture / encode tuning
	CaptureBackend string `json:"capture_backend"` // "ddagrab" (DXGI, default) or "gdigrab" (fallback)
	OutputIndex    int    `json:"output_index"`    // monitor index for ddagrab (0 = primary)
	Framerate      int    `json:"framerate"`       // target capture framerate
	VideoBitrate   string `json:"video_bitrate"`   // e.g. "8M"
	AudioDevice    string `json:"audio_device"`    // dshow device name for loopback, e.g. "virtual-audio-capturer"
	AudioBitrate   string `json:"audio_bitrate"`   // e.g. "96k"

	// Local paths
	AppDir     string `json:"app_dir"`     // working/drop dir (ffmpeg extracted here); default: dir of the exe
	FFmpegPath string `json:"ffmpeg_path"` // explicit ffmpeg path; empty = auto (embedded → app dir → PATH)

	// Misc
	Verbose bool `json:"verbose"`
}

func defaultConfig() Config {
	return Config{
		CaptureBackend: "ddagrab",
		OutputIndex:    0,
		Framerate:      30,
		VideoBitrate:   "8M",
		AudioBitrate:   "96k",
		Control:        false,
		Audio:          false,
	}
}

func envAny(keys ...string) (string, bool) {
	for _, k := range keys {
		if v, ok := os.LookupEnv(k); ok {
			return v, true
		}
	}
	return "", false
}

func envBool(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// LoadConfig resolves configuration from all sources in precedence order.
func LoadConfig(args []string) (Config, error) {
	cfg := defaultConfig()

	// --- flags (parsed first so we can find -config, but applied last) ---
	fs := flag.NewFlagSet("host-remote-desktop", flag.ContinueOnError)
	var (
		fConfig  = fs.String("config", "", "path to JSON config file (optional)")
		fBroker  = fs.String("broker", "", "broker base URL (overrides config/env)")
		fToken   = fs.String("token", "", "peer token")
		fHostID  = fs.String("host-id", "", "host id to register under")
		fName    = fs.String("name", "", "display name")
		fAudio   = fs.String("audio", "", "publish system audio (true/false)")
		fControl = fs.String("control", "", "accept control data channel (true/false)")
		fBackend = fs.String("capture", "", "capture backend: ddagrab|gdigrab")
		fFps     = fs.Int("fps", 0, "capture framerate")
		fVbr     = fs.String("vbitrate", "", "video bitrate, e.g. 8M")
		fADev    = fs.String("audio-device", "", "dshow loopback device name")
		fAppDir  = fs.String("app-dir", "", "working dir (ffmpeg extracted here)")
		fFFmpeg  = fs.String("ffmpeg", "", "explicit ffmpeg path")
		fVerbose = fs.Bool("verbose", false, "verbose logging")
	)
	if err := fs.Parse(args); err != nil {
		return cfg, err
	}

	// --- config file ---
	cfgPath := *fConfig
	if cfgPath == "" {
		if v, ok := envAny("ASMLTR_RD_CONFIG", "RD_CONFIG"); ok {
			cfgPath = v
		}
	}
	if cfgPath != "" {
		b, err := os.ReadFile(cfgPath)
		if err != nil {
			return cfg, fmt.Errorf("read config %s: %w", cfgPath, err)
		}
		if err := json.Unmarshal(b, &cfg); err != nil {
			return cfg, fmt.Errorf("parse config %s: %w", cfgPath, err)
		}
	}

	// --- environment ---
	if v, ok := envAny("ASMLTR_RD_BROKER", "RD_BROKER"); ok {
		cfg.BrokerURL = v
	}
	if v, ok := envAny("ASMLTR_RD_TOKEN", "RD_TOKEN"); ok {
		cfg.Token = v
	}
	if v, ok := envAny("ASMLTR_RD_HOST_ID", "RD_HOST_ID"); ok {
		cfg.HostID = v
	}
	if v, ok := envAny("ASMLTR_RD_NAME", "RD_NAME"); ok {
		cfg.Name = v
	}
	if v, ok := envAny("ASMLTR_RD_AUDIO", "RD_AUDIO"); ok {
		cfg.Audio = envBool(v)
	}
	if v, ok := envAny("ASMLTR_RD_CONTROL", "RD_CONTROL"); ok {
		cfg.Control = envBool(v)
	}
	if v, ok := envAny("ASMLTR_RD_CAPTURE", "RD_CAPTURE"); ok {
		cfg.CaptureBackend = v
	}
	if v, ok := envAny("ASMLTR_RD_FPS", "RD_FPS"); ok {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.Framerate = n
		}
	}
	if v, ok := envAny("ASMLTR_RD_VBITRATE", "RD_VBITRATE"); ok {
		cfg.VideoBitrate = v
	}
	if v, ok := envAny("ASMLTR_RD_AUDIO_DEVICE", "RD_AUDIO_DEVICE"); ok {
		cfg.AudioDevice = v
	}
	if v, ok := envAny("ASMLTR_RD_APP_DIR", "RD_APP_DIR"); ok {
		cfg.AppDir = v
	}
	if v, ok := envAny("ASMLTR_RD_FFMPEG", "RD_FFMPEG"); ok {
		cfg.FFmpegPath = v
	}

	// --- flags (highest precedence) ---
	if *fBroker != "" {
		cfg.BrokerURL = *fBroker
	}
	if *fToken != "" {
		cfg.Token = *fToken
	}
	if *fHostID != "" {
		cfg.HostID = *fHostID
	}
	if *fName != "" {
		cfg.Name = *fName
	}
	if *fAudio != "" {
		cfg.Audio = envBool(*fAudio)
	}
	if *fControl != "" {
		cfg.Control = envBool(*fControl)
	}
	if *fBackend != "" {
		cfg.CaptureBackend = *fBackend
	}
	if *fFps != 0 {
		cfg.Framerate = *fFps
	}
	if *fVbr != "" {
		cfg.VideoBitrate = *fVbr
	}
	if *fADev != "" {
		cfg.AudioDevice = *fADev
	}
	if *fAppDir != "" {
		cfg.AppDir = *fAppDir
	}
	if *fFFmpeg != "" {
		cfg.FFmpegPath = *fFFmpeg
	}
	if *fVerbose {
		cfg.Verbose = true
	}

	// --- derive / validate ---
	if cfg.AppDir == "" {
		if exe, err := os.Executable(); err == nil {
			cfg.AppDir = filepath.Dir(exe)
		} else {
			cfg.AppDir = "."
		}
	}
	if cfg.HostID == "" {
		if h, err := os.Hostname(); err == nil {
			cfg.HostID = h
		} else {
			cfg.HostID = "host"
		}
	}
	if cfg.Name == "" {
		cfg.Name = cfg.HostID
	}
	if cfg.Framerate <= 0 {
		cfg.Framerate = 30
	}
	if cfg.CaptureBackend == "" {
		cfg.CaptureBackend = "ddagrab"
	}

	return cfg, cfg.validate()
}

func (c Config) validate() error {
	if strings.TrimSpace(c.BrokerURL) == "" {
		return fmt.Errorf("broker URL is required (set broker_url in config, ASMLTR_RD_BROKER, or -broker)")
	}
	if !strings.HasPrefix(c.BrokerURL, "http://") && !strings.HasPrefix(c.BrokerURL, "https://") {
		return fmt.Errorf("broker URL must start with http:// or https://")
	}
	return nil
}

// baseURL returns the broker base with any trailing slash trimmed.
func (c Config) baseURL() string { return strings.TrimRight(c.BrokerURL, "/") }
