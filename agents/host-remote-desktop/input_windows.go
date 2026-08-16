//go:build windows

package main

import (
	"fmt"
	"strings"
	"syscall"
	"unsafe"
)

// Input injection on Windows via user32!SendInput. We call it through syscall/LazyDLL so the agent
// stays pure-Go and CGO-free (GOOS=windows GOARCH=amd64 go build produces a self-contained .exe).
//
// The INPUT structure on amd64 is 40 bytes: a DWORD `type`, 4 bytes of padding to 8-byte-align the
// union, then the 32-byte union (MOUSEINPUT is the largest member). We lay it out explicitly and use
// unsafe to write the mouse/keyboard variant into the union bytes.

var (
	modUser32     = syscall.NewLazyDLL("user32.dll")
	procSendInput = modUser32.NewProc("SendInput")
)

const (
	inputMouse    = 0
	inputKeyboard = 1

	mouseeventfMove        = 0x0001
	mouseeventfLeftDown    = 0x0002
	mouseeventfLeftUp      = 0x0004
	mouseeventfRightDown   = 0x0008
	mouseeventfRightUp     = 0x0010
	mouseeventfMiddleDown  = 0x0020
	mouseeventfMiddleUp    = 0x0040
	mouseeventfWheel       = 0x0800
	mouseeventfHWheel      = 0x1000
	mouseeventfAbsolute    = 0x8000
	mouseeventfVirtualDesk = 0x4000

	keyeventfExtended = 0x0001
	keyeventfKeyUp    = 0x0002
	keyeventfUnicode  = 0x0004
)

// input is the amd64 layout of the Win32 INPUT structure (40 bytes total).
type input struct {
	typ uint32
	_   uint32   // padding to 8-byte alignment of the union
	u   [32]byte // MOUSEINPUT / KEYBDINPUT union (MOUSEINPUT is largest)
}

type mouseInput struct {
	dx          int32
	dy          int32
	mouseData   uint32
	dwFlags     uint32
	time        uint32
	dwExtraInfo uintptr
}

type kbdInput struct {
	wVk         uint16
	wScan       uint16
	dwFlags     uint32
	time        uint32
	dwExtraInfo uintptr
}

func mkMouse(mi mouseInput) input {
	var in input
	in.typ = inputMouse
	*(*mouseInput)(unsafe.Pointer(&in.u[0])) = mi
	return in
}

func mkKey(ki kbdInput) input {
	var in input
	in.typ = inputKeyboard
	*(*kbdInput)(unsafe.Pointer(&in.u[0])) = ki
	return in
}

func sendInputs(inputs []input) error {
	if len(inputs) == 0 {
		return nil
	}
	n, _, err := procSendInput.Call(
		uintptr(len(inputs)),
		uintptr(unsafe.Pointer(&inputs[0])),
		unsafe.Sizeof(inputs[0]),
	)
	if int(n) != len(inputs) {
		return fmt.Errorf("SendInput injected %d/%d events: %v", n, len(inputs), err)
	}
	return nil
}

// injectControl applies one control-channel message to the local mouse/keyboard.
func injectControl(m *controlMsg) error {
	switch strings.ToLower(m.T) {
	case "move":
		return doMove(m)
	case "click":
		return doButton(m, "click")
	case "down":
		return doButton(m, "down")
	case "up":
		return doButton(m, "up")
	case "scroll":
		return doScroll(m)
	case "key":
		return doKey(m)
	default:
		return fmt.Errorf("unknown control type %q", m.T)
	}
}

// absMove builds a MOUSEINPUT that positions the cursor at normalized (x,y) over the virtual desktop.
func absMove(x, y float64) input {
	return mkMouse(mouseInput{
		dx:      int32(clamp01(x)*65535.0 + 0.5),
		dy:      int32(clamp01(y)*65535.0 + 0.5),
		dwFlags: mouseeventfMove | mouseeventfAbsolute | mouseeventfVirtualDesk,
	})
}

func doMove(m *controlMsg) error {
	if m.X == nil || m.Y == nil {
		return nil
	}
	return sendInputs([]input{absMove(*m.X, *m.Y)})
}

// doButton handles click/down/up. It optionally moves to (x,y) first, in the same SendInput batch.
func doButton(m *controlMsg, kind string) error {
	down, up, ok := buttonFlags(m.Button)
	if !ok {
		return fmt.Errorf("unknown mouse button %q", m.Button)
	}
	var inputs []input
	if m.X != nil && m.Y != nil {
		inputs = append(inputs, absMove(*m.X, *m.Y))
	}
	switch kind {
	case "down":
		inputs = append(inputs, mkMouse(mouseInput{dwFlags: down}))
	case "up":
		inputs = append(inputs, mkMouse(mouseInput{dwFlags: up}))
	default: // click
		inputs = append(inputs,
			mkMouse(mouseInput{dwFlags: down}),
			mkMouse(mouseInput{dwFlags: up}),
		)
	}
	return sendInputs(inputs)
}

// buttonFlags returns the down/up MOUSEEVENTF flags for a button name (defaults to left).
func buttonFlags(button string) (down, up uint32, ok bool) {
	switch strings.ToLower(button) {
	case "", "left":
		return mouseeventfLeftDown, mouseeventfLeftUp, true
	case "right":
		return mouseeventfRightDown, mouseeventfRightUp, true
	case "middle":
		return mouseeventfMiddleDown, mouseeventfMiddleUp, true
	}
	return 0, 0, false
}

// doScroll emits vertical/horizontal wheel events. dy>0 scrolls up/away (SendInput convention).
func doScroll(m *controlMsg) error {
	var inputs []input
	if m.DY != 0 {
		inputs = append(inputs, mkMouse(mouseInput{
			mouseData: uint32(int32(m.DY)),
			dwFlags:   mouseeventfWheel,
		}))
	}
	if m.DX != 0 {
		inputs = append(inputs, mkMouse(mouseInput{
			mouseData: uint32(int32(m.DX)),
			dwFlags:   mouseeventfHWheel,
		}))
	}
	return sendInputs(inputs)
}

// doKey injects a key event. It maps the UI-Events `code` to a Windows virtual-key and emits a down or
// up (KEYEVENTF_KEYUP when down:false). If the code is unmapped it falls back to typing `key` as
// unicode (down-edge only), which covers shifted symbols and layout-specific characters.
func doKey(m *controlMsg) error {
	isDown := m.Down == nil || *m.Down // default to a press if unspecified
	if vk, extended, ok := codeToVK(m.Code); ok {
		flags := uint32(0)
		if extended {
			flags |= keyeventfExtended
		}
		if !isDown {
			flags |= keyeventfKeyUp
		}
		return sendInputs([]input{mkKey(kbdInput{wVk: vk, dwFlags: flags})})
	}
	// fallback: unicode. Only act on the down edge to avoid double entry.
	if isDown && m.Key != "" {
		return typeUnicode(m.Key)
	}
	if m.Key == "" && m.Code == "" {
		return fmt.Errorf("key message with neither code nor key")
	}
	return nil
}

// typeUnicode injects arbitrary text via KEYEVENTF_UNICODE (layout-independent).
func typeUnicode(text string) error {
	var inputs []input
	for _, r := range text {
		if r > 0xFFFF { // surrogate pair for runes beyond the BMP
			r -= 0x10000
			hi := uint16(0xD800 + (r >> 10))
			lo := uint16(0xDC00 + (r & 0x3FF))
			for _, u := range []uint16{hi, lo} {
				inputs = append(inputs,
					mkKey(kbdInput{wScan: u, dwFlags: keyeventfUnicode}),
					mkKey(kbdInput{wScan: u, dwFlags: keyeventfUnicode | keyeventfKeyUp}),
				)
			}
			continue
		}
		u := uint16(r)
		inputs = append(inputs,
			mkKey(kbdInput{wScan: u, dwFlags: keyeventfUnicode}),
			mkKey(kbdInput{wScan: u, dwFlags: keyeventfUnicode | keyeventfKeyUp}),
		)
	}
	return sendInputs(inputs)
}

// codeToVK maps a DOM UI-Events `code` to a Windows virtual-key code, plus whether it needs the
// KEYEVENTF_EXTENDEDKEY flag (nav cluster, right-hand modifiers, numpad enter/divide, etc.).
func codeToVK(code string) (vk uint16, extended bool, ok bool) {
	// Letters: KeyA..KeyZ → 0x41..0x5A
	if len(code) == 4 && strings.HasPrefix(code, "Key") {
		c := code[3]
		if c >= 'A' && c <= 'Z' {
			return uint16(c), false, true
		}
	}
	// Digits: Digit0..Digit9 → 0x30..0x39
	if len(code) == 6 && strings.HasPrefix(code, "Digit") {
		c := code[5]
		if c >= '0' && c <= '9' {
			return uint16(c), false, true
		}
	}
	// Numpad digits: Numpad0..Numpad9 → 0x60..0x69
	if len(code) == 7 && strings.HasPrefix(code, "Numpad") {
		c := code[6]
		if c >= '0' && c <= '9' {
			return uint16(0x60 + (c - '0')), false, true
		}
	}
	// Function keys: F1..F24 → 0x70..0x87
	if len(code) >= 2 && code[0] == 'F' {
		if n := atoiSafe(code[1:]); n >= 1 && n <= 24 {
			return uint16(0x70 + (n - 1)), false, true
		}
	}
	if e, found := namedCodeVK[code]; found {
		return e.vk, e.ext, true
	}
	return 0, false, false
}

// namedCodeVK maps non-alphanumeric UI-Events codes to Windows virtual-key codes (+extended flag).
var namedCodeVK = map[string]struct {
	vk  uint16
	ext bool
}{
	"Enter":          {0x0D, false},
	"NumpadEnter":    {0x0D, true},
	"Escape":         {0x1B, false},
	"Backspace":      {0x08, false},
	"Tab":            {0x09, false},
	"Space":          {0x20, false},
	"Minus":          {0xBD, false},
	"Equal":          {0xBB, false},
	"BracketLeft":    {0xDB, false},
	"BracketRight":   {0xDD, false},
	"Backslash":      {0xDC, false},
	"Semicolon":      {0xBA, false},
	"Quote":          {0xDE, false},
	"Backquote":      {0xC0, false},
	"Comma":          {0xBC, false},
	"Period":         {0xBE, false},
	"Slash":          {0xBF, false},
	"CapsLock":       {0x14, false},
	"NumLock":        {0x90, false},
	"ScrollLock":     {0x91, false},
	"PrintScreen":    {0x2C, true},
	"Pause":          {0x13, false},
	"Insert":         {0x2D, true},
	"Delete":         {0x2E, true},
	"Home":           {0x24, true},
	"End":            {0x23, true},
	"PageUp":         {0x21, true},
	"PageDown":       {0x22, true},
	"ArrowLeft":      {0x25, true},
	"ArrowUp":        {0x26, true},
	"ArrowRight":     {0x27, true},
	"ArrowDown":      {0x28, true},
	"ControlLeft":    {0xA2, false},
	"ControlRight":   {0xA3, true},
	"ShiftLeft":      {0xA0, false},
	"ShiftRight":     {0xA1, false},
	"AltLeft":        {0xA4, false},
	"AltRight":       {0xA5, true},
	"MetaLeft":       {0x5B, true},
	"MetaRight":      {0x5C, true},
	"ContextMenu":    {0x5D, true},
	"NumpadAdd":      {0x6B, false},
	"NumpadSubtract": {0x6D, false},
	"NumpadMultiply": {0x6A, false},
	"NumpadDivide":   {0x6F, true},
	"NumpadDecimal":  {0x6E, false},
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func atoiSafe(s string) int {
	if s == "" {
		return -1
	}
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return -1
		}
		n = n*10 + int(c-'0')
	}
	return n
}
