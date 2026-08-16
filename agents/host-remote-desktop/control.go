package main

// controlMsg is the JSON wire schema for the `control` WebRTC data channel. Viewers send these to
// drive the host's mouse and keyboard. The agent only acts on them when the broker stamped the
// session control:true (see webrtc.go); injection itself is platform-specific (input_windows.go).
//
// Message kinds (field "t"):
//
//	move   — pointer motion.
//	          absolute: {"t":"move","x":0.42,"y":0.87}   x,y normalized 0..1 over the virtual desktop
//	          relative: {"t":"move","dx":12,"dy":-4}     pixel deltas
//	mouse  — button event. {"t":"mouse","button":"left|right|middle|x1|x2","action":"down|up|click"}
//	          may carry x,y to move-then-act in one message.
//	scroll — wheel. {"t":"scroll","dy":120,"dx":0}       dy>0 = up/away, standard 120 per notch; dx = horizontal
//	key    — key event. {"t":"key","action":"down|up|press","key":"a"}  OR  {"t":"key","code":"Enter"}
//	          OR explicit virtual-key: {"t":"key","vk":13,"action":"press"}
//	          "press" = down+up. "code" accepts named keys (Enter, Backspace, Tab, Escape, Delete,
//	          ArrowLeft/Right/Up/Down, Home, End, PageUp, PageDown, Space, F1..F12, and modifiers
//	          Shift/Control/Alt/Meta). "key" is a single character typed with correct shift state.
//	text   — unicode text entry. {"t":"text","text":"hello world"}  injected via KEYEVENTF_UNICODE.
type controlMsg struct {
	T      string   `json:"t"`
	X      *float64 `json:"x,omitempty"`
	Y      *float64 `json:"y,omitempty"`
	DX     float64  `json:"dx,omitempty"`
	DY     float64  `json:"dy,omitempty"`
	Button string   `json:"button,omitempty"`
	Action string   `json:"action,omitempty"`
	Key    string   `json:"key,omitempty"`
	Code   string   `json:"code,omitempty"`
	VK     int      `json:"vk,omitempty"`
	Text   string   `json:"text,omitempty"`
}
