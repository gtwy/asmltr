package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"

	"github.com/pion/webrtc/v4"
)

// iceConfigResponse is the payload from GET /rd/ice-config: STUN urls (always) plus short-lived TURN
// creds (only when the broker has TURN enabled). We configure Pion for full ICE; direct hole-punching
// via STUN is the default path and TURN is used only if the config returns a relay server.
type iceConfigResponse struct {
	OK          bool `json:"ok"`
	TurnEnabled bool `json:"turn_enabled"`
	IceServers  []struct {
		URLs       json.RawMessage `json:"urls"` // string or []string
		Username   string          `json:"username,omitempty"`
		Credential string          `json:"credential,omitempty"`
	} `json:"iceServers"`
}

// Agent owns the Pion side: it fetches ICE config, answers offer_requests by building offers, relays
// SDP/ICE through the signaling client, publishes captured tracks, and routes the control channel.
type Agent struct {
	cfg        Config
	sig        *Signaling
	ffmpegPath string
	api        *webrtc.API
	ctx        context.Context

	mu       sync.Mutex
	sessions map[string]*rtcSession
}

type rtcSession struct {
	id      string
	control bool
	pc      *webrtc.PeerConnection
	cancel  context.CancelFunc
	started int32 // atomic: capture launched once
}

// NewAgent resolves ffmpeg, builds a Pion API with H.264+Opus registered, and returns a ready Agent.
func NewAgent(cfg Config) (*Agent, error) {
	ffmpegPath, err := ensureFFmpeg(cfg)
	if err != nil {
		return nil, err
	}
	m := &webrtc.MediaEngine{}
	if err := m.RegisterDefaultCodecs(); err != nil {
		return nil, fmt.Errorf("register codecs: %w", err)
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(m))
	a := &Agent{
		cfg:        cfg,
		ffmpegPath: ffmpegPath,
		api:        api,
		sessions:   make(map[string]*rtcSession),
	}
	a.sig = NewSignaling(cfg, a.onSignal)
	return a, nil
}

// Run holds the signaling stream open (blocking) until ctx is cancelled.
func (a *Agent) Run(ctx context.Context) error {
	a.ctx = ctx
	return a.sig.Run(ctx)
}

// fetchICEServers pulls a fresh ICE config from the broker (fresh TURN creds per session when on).
func (a *Agent) fetchICEServers(ctx context.Context) ([]webrtc.ICEServer, error) {
	q := url.Values{}
	q.Set("token", a.cfg.Token)
	reqURL := a.cfg.baseURL() + "/rd/ice-config?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("GET /rd/ice-config: %s: %s", resp.Status, string(b))
	}
	var body iceConfigResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, err
	}
	var servers []webrtc.ICEServer
	for _, s := range body.IceServers {
		urls := parseURLs(s.URLs)
		if len(urls) == 0 {
			continue
		}
		srv := webrtc.ICEServer{URLs: urls}
		if s.Username != "" || s.Credential != "" {
			srv.Username = s.Username
			srv.Credential = s.Credential
		}
		servers = append(servers, srv)
	}
	if len(servers) == 0 {
		// direct-or-nothing is valid, but a STUN server is normally needed to discover srflx addrs.
		logf("warning: broker returned no ICE servers; relying on host candidates only")
	}
	return servers, nil
}

// parseURLs handles the `urls` field being either a JSON string or an array of strings.
func parseURLs(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var arr []string
	if err := json.Unmarshal(raw, &arr); err == nil {
		return arr
	}
	var one string
	if err := json.Unmarshal(raw, &one); err == nil && one != "" {
		return []string{one}
	}
	return nil
}

// onSignal dispatches every inbound broker message.
func (a *Agent) onSignal(msg signalMsg) {
	switch msg.Type {
	case "ready":
		// registration ack; nothing to do
	case "offer_request":
		go a.handleOfferRequest(msg)
	case "sdp":
		a.handleRemoteSDP(msg)
	case "ice":
		a.handleRemoteICE(msg)
	case "bye":
		a.teardown(msg.SessionID, "broker bye")
	default:
		logf("signaling: ignoring message type %q", msg.Type)
	}
}

// handleOfferRequest builds a PeerConnection for a new session, adds tracks (and the control channel
// if — and only if — the broker stamped control:true), creates an offer, and relays it to the viewer.
func (a *Agent) handleOfferRequest(msg signalMsg) {
	sessionID := msg.SessionID
	if sessionID == "" {
		logf("offer_request without session_id; ignoring")
		return
	}
	// Defense in depth: honour the control grant the BROKER stamped, and never more than our own caps.
	controlGranted := msg.Control && a.cfg.Control
	logf("offer_request session=%s control(server=%v effective=%v)", sessionID, msg.Control, controlGranted)

	iceServers, err := a.fetchICEServers(a.ctx)
	if err != nil {
		logf("session %s: fetch ICE config: %v", sessionID, err)
		return
	}

	pc, err := a.api.NewPeerConnection(webrtc.Configuration{ICEServers: iceServers})
	if err != nil {
		logf("session %s: new PeerConnection: %v", sessionID, err)
		return
	}

	sessCtx, cancel := context.WithCancel(a.ctx)
	sess := &rtcSession{id: sessionID, control: controlGranted, pc: pc, cancel: cancel}
	a.mu.Lock()
	a.sessions[sessionID] = sess
	a.mu.Unlock()

	// --- media tracks ---
	videoTrack, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264}, "video", "asmltr-rd")
	if err != nil {
		logf("session %s: video track: %v", sessionID, err)
		a.teardown(sessionID, "track error")
		return
	}
	if _, err := pc.AddTrack(videoTrack); err != nil {
		logf("session %s: add video track: %v", sessionID, err)
		a.teardown(sessionID, "track error")
		return
	}
	var audioTrack *webrtc.TrackLocalStaticSample
	if a.cfg.Audio {
		audioTrack, err = webrtc.NewTrackLocalStaticSample(
			webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus}, "audio", "asmltr-rd")
		if err != nil {
			logf("session %s: audio track: %v (continuing video-only)", sessionID, err)
			audioTrack = nil
		} else if _, err := pc.AddTrack(audioTrack); err != nil {
			logf("session %s: add audio track: %v (continuing video-only)", sessionID, err)
			audioTrack = nil
		}
	}

	// --- control data channel (only when control granted) ---
	// PRE-NEGOTIATED to match the viewer client exactly: negotiated:true, id:0, ordered:true,
	// label:"control". Both peers create the channel with the same id; there is no ondatachannel
	// handshake. It exists only when the broker stamped this session with a control grant.
	if controlGranted {
		neg := true
		ordered := true
		zero := uint16(0)
		dc, err := pc.CreateDataChannel("control", &webrtc.DataChannelInit{
			Negotiated: &neg,
			ID:         &zero,
			Ordered:    &ordered,
		})
		if err != nil {
			logf("session %s: create control channel: %v", sessionID, err)
		} else {
			a.wireControlChannel(sess, dc)
		}
	}

	// --- ICE trickle: relay local candidates to the viewer via the broker ---
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return // end of candidates
		}
		if err := a.sig.sendICE(a.ctx, sessionID, c.ToJSON()); err != nil {
			logf("session %s: send ICE: %v", sessionID, err)
		}
	})

	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		logf("session %s: connection state %s", sessionID, s.String())
		switch s {
		case webrtc.PeerConnectionStateConnected:
			a.startCapture(sess, sessCtx, videoTrack, audioTrack)
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed, webrtc.PeerConnectionStateDisconnected:
			a.teardown(sessionID, "connection "+s.String())
		}
	})

	// --- create + relay the offer ---
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		logf("session %s: create offer: %v", sessionID, err)
		a.teardown(sessionID, "offer error")
		return
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		logf("session %s: set local description: %v", sessionID, err)
		a.teardown(sessionID, "offer error")
		return
	}
	if err := a.sig.sendSDP(a.ctx, sessionID, offer); err != nil {
		logf("session %s: send offer: %v", sessionID, err)
		a.teardown(sessionID, "offer send error")
		return
	}
}

// startCapture launches the ffmpeg capture goroutines exactly once per session (on first connect).
func (a *Agent) startCapture(sess *rtcSession, ctx context.Context, video, audio *webrtc.TrackLocalStaticSample) {
	if !atomic.CompareAndSwapInt32(&sess.started, 0, 1) {
		return
	}
	logf("session %s: starting capture", sess.id)
	go func() {
		if err := captureVideo(ctx, a.cfg, a.ffmpegPath, video); err != nil && ctx.Err() == nil {
			logf("session %s: video capture ended: %v", sess.id, err)
		}
	}()
	if audio != nil {
		go func() {
			if err := captureAudio(ctx, a.cfg, a.ffmpegPath, audio); err != nil && ctx.Err() == nil {
				logf("session %s: audio capture ended: %v", sess.id, err)
			}
		}()
	}
}

// wireControlChannel attaches the input-injection handler to a control data channel. Injection is
// gated on the session's control grant (re-checked here — defense in depth per docs/REMOTE-DESKTOP.md).
func (a *Agent) wireControlChannel(sess *rtcSession, dc *webrtc.DataChannel) {
	dc.OnOpen(func() { logf("session %s: control channel open (grant=%v)", sess.id, sess.control) })
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if !sess.control {
			logf("session %s: REFUSING control message — session has no control grant", sess.id)
			return
		}
		var cm controlMsg
		if err := json.Unmarshal(m.Data, &cm); err != nil {
			logf("session %s: bad control message: %v", sess.id, err)
			return
		}
		if err := injectControl(&cm); err != nil {
			logf("session %s: inject %q: %v", sess.id, cm.T, err)
		}
	})
}

func (a *Agent) handleRemoteSDP(msg signalMsg) {
	a.mu.Lock()
	sess := a.sessions[msg.SessionID]
	a.mu.Unlock()
	if sess == nil {
		logf("sdp for unknown session %s", msg.SessionID)
		return
	}
	var desc webrtc.SessionDescription
	if err := json.Unmarshal(msg.SDP, &desc); err != nil {
		logf("session %s: parse remote sdp: %v", msg.SessionID, err)
		return
	}
	if err := sess.pc.SetRemoteDescription(desc); err != nil {
		logf("session %s: set remote description: %v", msg.SessionID, err)
	}
}

func (a *Agent) handleRemoteICE(msg signalMsg) {
	a.mu.Lock()
	sess := a.sessions[msg.SessionID]
	a.mu.Unlock()
	if sess == nil {
		logf("ice for unknown session %s", msg.SessionID)
		return
	}
	var init webrtc.ICECandidateInit
	if err := json.Unmarshal(msg.Candidate, &init); err != nil {
		logf("session %s: parse remote ice: %v", msg.SessionID, err)
		return
	}
	if err := sess.pc.AddICECandidate(init); err != nil {
		logf("session %s: add ice candidate: %v", msg.SessionID, err)
	}
}

// teardown closes a session's PeerConnection, stops its capture, and notifies the broker.
func (a *Agent) teardown(sessionID, reason string) {
	a.mu.Lock()
	sess := a.sessions[sessionID]
	if sess != nil {
		delete(a.sessions, sessionID)
	}
	a.mu.Unlock()
	if sess == nil {
		return
	}
	logf("session %s: teardown (%s)", sessionID, reason)
	if sess.cancel != nil {
		sess.cancel()
	}
	if sess.pc != nil {
		_ = sess.pc.Close()
	}
	// best-effort bye so the viewer is torn down too
	if a.ctx != nil {
		_ = a.sig.sendBye(context.Background(), sessionID, reason)
	}
}
