//go:build !windows

package main

import (
	"fmt"
	"runtime"
)

// Non-Windows stub so the agent still cross/locally compiles for development on Linux/macOS. Actual
// input injection only exists on Windows (SendInput). On other platforms control messages are refused.
func injectControl(m *controlMsg) error {
	return fmt.Errorf("input injection is only supported on Windows (got control %q on %s)", m.T, runtime.GOOS)
}
