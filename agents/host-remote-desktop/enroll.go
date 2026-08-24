package main

// Device enrollment (see docs/DEVICE-REGISTRY.md).
//
// A host used to be handed a peer token that a human pasted into the broker's keys.json and into
// this agent's config — a long-lived secret sitting in plaintext on two machines, revocable only by
// editing a file. Instead the machine now CLAIMS its credential: an operator mints a single-use,
// short-lived enrollment code, the agent redeems it exactly once, and the issued token is written
// beside the binary with owner-only permissions. The authoritative copy lives in the asmltr vault,
// and revoking it there kills this agent's access immediately.
//
// Enrollment is a one-time step: once the credential file exists, the agent uses it and never calls
// the enroll endpoint again.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// credentialFile is where an enrolled token is persisted, relative to the agent's app dir.
const credentialFile = "credential.json"

type storedCredential struct {
	Token    string `json:"token"`
	DeviceID string `json:"device_id"`
	Name     string `json:"name"`
	IssuedAt int64  `json:"issued_at"`
}

func credentialPath(appDir string) string { return filepath.Join(appDir, credentialFile) }

// loadStoredCredential reads a previously enrolled token. A missing file is not an error — it just
// means this machine has not enrolled yet.
func loadStoredCredential(appDir string) (storedCredential, bool) {
	var c storedCredential
	b, err := os.ReadFile(credentialPath(appDir))
	if err != nil {
		return c, false
	}
	if err := json.Unmarshal(b, &c); err != nil || strings.TrimSpace(c.Token) == "" {
		return c, false
	}
	return c, true
}

// saveStoredCredential writes the issued token owner-only. On Windows the permission bits are
// largely advisory, so the meaningful protection there is the file's location (the agent's own
// app dir) plus the fact that the credential is revocable centrally.
func saveStoredCredential(appDir string, c storedCredential) error {
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(credentialPath(appDir), b, 0o600)
}

// redeemEnrollment exchanges a one-time code for this device's credential. The agent talks only to
// the broker — the asmltr core is not publicly reachable — so the broker proxies the redemption.
func redeemEnrollment(brokerURL, code string) (storedCredential, error) {
	var out storedCredential
	body, _ := json.Marshal(map[string]string{"code": strings.TrimSpace(code)})
	req, err := http.NewRequest("POST", strings.TrimRight(brokerURL, "/")+"/rd/enroll", bytes.NewReader(body))
	if err != nil {
		return out, err
	}
	req.Header.Set("Content-Type", "application/json")

	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return out, fmt.Errorf("reach broker: %w", err)
	}
	defer res.Body.Close()

	var payload struct {
		OK       bool   `json:"ok"`
		Token    string `json:"token"`
		DeviceID string `json:"device_id"`
		Name     string `json:"name"`
		Error    string `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return out, fmt.Errorf("broker returned an unreadable response (HTTP %d)", res.StatusCode)
	}
	if res.StatusCode != http.StatusOK || !payload.OK || payload.Token == "" {
		msg := payload.Error
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", res.StatusCode)
		}
		return out, fmt.Errorf("enrollment refused: %s", msg)
	}
	return storedCredential{
		Token:    payload.Token,
		DeviceID: payload.DeviceID,
		Name:     payload.Name,
		IssuedAt: time.Now().Unix(),
	}, nil
}
