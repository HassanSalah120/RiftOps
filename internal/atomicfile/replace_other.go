//go:build !windows

package atomicfile

import "os"

func Replace(source, destination string) error { return os.Rename(source, destination) }
