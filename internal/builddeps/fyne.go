//go:build tools

// Package builddeps pins packaging dependencies that are inspected by release
// tooling but are not imported by the RiftOps runtime.
package builddeps

import (
	_ "fyne.io/fyne/v2/app"
	_ "fyne.io/fyne/v2/widget"
)
