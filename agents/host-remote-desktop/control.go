package main

// controlMsg is the AUTHORITATIVE JSON wire schema for the `control` WebRTC data channel, matching the
// asmltr Android/web viewer client exactly. Viewers send these (as JSON strings) to drive the host's
// mouse and keyboard. The agent only acts on them when the broker stamped the session control:true
// (re-checked in webrtc.go); injection itself is platform-specific (input_windows.go via SendInput).
//
// The channel is PRE-NEGOTIATED: negotiated:true, id:0, ordered:true, label:"control" — the host
// creates it with the same settings; there is no ondatachannel handshake.
//
// Coordinates x,y are NORMALIZED [0,1] fractions of the remote screen. On Windows they map to absolute
// cursor coords for SendInput as x_abs = round(x*65535), y_abs = round(y*65535) over the virtual desktop.
//
// Message kinds (field "t"):
//
//	move   {"t":"move","x":0..1,"y":0..1}                                  pointer motion (absolute)
//	click  {"t":"click","x":0..1,"y":0..1,"button":"left|right|middle"}    move-then-press-release
//	down   {"t":"down","x":0..1,"y":0..1,"button":"left|right|middle"}     button press (button held)
//	up     {"t":"up","x":0..1,"y":0..1,"button":"left|right|middle"}       button release
//	scroll {"t":"scroll","dx":int,"dy":int}                                wheel px deltas; sign=direction
//	key    {"t":"key","code":"KeyA|Enter|Backspace|Space|Digit1|...","key":"a","down":true|false}
//	          `code` is a UI-Events code → mapped to a Windows virtual-key; `key` is the exact character
//	          (used for shifted symbols / unicode fallback). down:false emits KEYEVENTF_KEYUP.
//
// `button` defaults to "left" when omitted.
type controlMsg struct {
	T      string   `json:"t"`
	X      *float64 `json:"x,omitempty"`
	Y      *float64 `json:"y,omitempty"`
	DX     float64  `json:"dx,omitempty"`
	DY     float64  `json:"dy,omitempty"`
	Button string   `json:"button,omitempty"`
	Code   string   `json:"code,omitempty"`
	Key    string   `json:"key,omitempty"`
	Down   *bool    `json:"down,omitempty"`
}
