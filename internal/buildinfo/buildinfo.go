// Package buildinfo contains build metadata shared by RiftOps entry points.
package buildinfo

// DevelopmentVersion is used only when running from source. Release builds
// inject the single canonical VERSION value through -ldflags.
const DevelopmentVersion = "dev"

// Version is the human-visible release version used by the desktop and CLI
// apps. Release packaging overrides this value with -ldflags.
var Version = DevelopmentVersion
