package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// signalMsg is a message received on the SSE stream from the broker, or posted back to /rd/msg.
// The broker relays `sdp` and `ice` verbatim between the two peers of a session; `offer_request`
// asks this host to produce an offer; `bye` tears a session down; `ready` is the initial ack.
type signalMsg struct {
	Type      string          `json:"type"`
	HostID    string          `json:"host_id,omitempty"`
	SessionID string          `json:"session_id,omitempty"`
	Control   bool            `json:"control,omitempty"`
	SDP       json.RawMessage `json:"sdp,omitempty"`       // {type,sdp} RTCSessionDescription
	Candidate json.RawMessage `json:"candidate,omitempty"` // {candidate,sdpMid,sdpMLineIndex}
	Reason    string          `json:"reason,omitempty"`
}

// Signaling holds the outbound connection to the broker: a long-lived SSE stream for inbound
// messages plus POST /rd/msg for outbound. It never listens for inbound connections.
type Signaling struct {
	cfg    Config
	client *http.Client
	// handler is invoked for every inbound broker message (offer_request/sdp/ice/bye/ready).
	handler func(signalMsg)
}

func NewSignaling(cfg Config, handler func(signalMsg)) *Signaling {
	return &Signaling{
		cfg:     cfg,
		client:  &http.Client{}, // no global timeout: the SSE GET is intentionally long-lived
		handler: handler,
	}
}

// post sends a signaling message to POST /rd/msg. The broker authenticates via the token in the body.
func (s *Signaling) post(ctx context.Context, payload map[string]any) error {
	payload["token"] = s.cfg.Token
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.baseURL()+"/rd/msg", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	c := &http.Client{Timeout: 15 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("POST /rd/msg %s: %s: %s", payload["type"], resp.Status, strings.TrimSpace(string(b)))
	}
	// drain so the connection can be reused
	io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	return nil
}

// sendSDP relays a local description (offer/answer) to the other peer via the broker.
func (s *Signaling) sendSDP(ctx context.Context, sessionID string, sdp any) error {
	return s.post(ctx, map[string]any{"type": "sdp", "session_id": sessionID, "sdp": sdp})
}

// sendICE relays a local ICE candidate to the other peer via the broker.
func (s *Signaling) sendICE(ctx context.Context, sessionID string, candidate any) error {
	return s.post(ctx, map[string]any{"type": "ice", "session_id": sessionID, "candidate": candidate})
}

// sendBye asks the broker to tear a session down on both peers.
func (s *Signaling) sendBye(ctx context.Context, sessionID, reason string) error {
	return s.post(ctx, map[string]any{"type": "bye", "session_id": sessionID, "reason": reason})
}

// streamURL builds the SSE GET URL registering this machine as a host with its advertised caps.
func (s *Signaling) streamURL() string {
	q := url.Values{}
	q.Set("token", s.cfg.Token)
	q.Set("role", "host")
	q.Set("host_id", s.cfg.HostID)
	q.Set("name", s.cfg.Name)
	if s.cfg.Audio {
		q.Set("audio", "1")
	}
	if s.cfg.Control {
		q.Set("control", "1")
	}
	return s.cfg.baseURL() + "/rd/stream?" + q.Encode()
}

// Run holds the SSE stream open, dispatching every inbound message to the handler. It reconnects with
// backoff until ctx is cancelled. Registration is implicit: connecting with role=host registers us.
func (s *Signaling) Run(ctx context.Context) error {
	backoff := time.Second
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		err := s.streamOnce(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			logf("signaling stream ended: %v (reconnecting in %s)", err, backoff)
		} else {
			logf("signaling stream closed by broker (reconnecting in %s)", backoff)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

// streamOnce opens one SSE connection and reads events until it closes or errors.
func (s *Signaling) streamOnce(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.streamURL(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("GET /rd/stream: %s: %s", resp.Status, strings.TrimSpace(string(b)))
	}
	logf("registered with broker as host_id=%q name=%q (audio=%v control=%v)", s.cfg.HostID, s.cfg.Name, s.cfg.Audio, s.cfg.Control)

	// SSE parser: accumulate `data:` lines until a blank line, then dispatch.
	reader := bufio.NewReaderSize(resp.Body, 1<<16)
	var dataBuf strings.Builder
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			// end of event
			if dataBuf.Len() > 0 {
				s.dispatch(dataBuf.String())
				dataBuf.Reset()
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue // comment / keepalive
		}
		if strings.HasPrefix(line, "data:") {
			payload := strings.TrimPrefix(line, "data:")
			payload = strings.TrimPrefix(payload, " ")
			if dataBuf.Len() > 0 {
				dataBuf.WriteByte('\n')
			}
			dataBuf.WriteString(payload)
		}
		// other SSE fields (event:, id:, retry:) are ignored — the broker only sends data.
	}
}

func (s *Signaling) dispatch(data string) {
	var msg signalMsg
	if err := json.Unmarshal([]byte(data), &msg); err != nil {
		logf("signaling: bad message %q: %v", truncate(data, 120), err)
		return
	}
	if s.handler != nil {
		s.handler(msg)
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
