// Package buildinfo contains build metadata shared by RiftOps entry points.
package buildinfo

// Version is the human-visible release version used by the desktop and CLI apps.
//
// Release packaging overrides this value with -ldflags so the executable's
// runtime version always matches the version shown in its release metadata.
var Version = "2.8.1"
