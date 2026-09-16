package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type SemVer struct {
	Major int
	Minor int
	Patch int
}

func (s SemVer) String() string {
	return fmt.Sprintf("%d.%d.%d", s.Major, s.Minor, s.Patch)
}

func parseSemVer(v string) (SemVer, error) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return SemVer{}, fmt.Errorf("invalid semver %q, expected X.Y.Z", v)
	}
	major, err := strconv.Atoi(parts[0])
	if err != nil {
		return SemVer{}, fmt.Errorf("invalid major version %q: %w", parts[0], err)
	}
	minor, err := strconv.Atoi(parts[1])
	if err != nil {
		return SemVer{}, fmt.Errorf("invalid minor version %q: %w", parts[1], err)
	}
	patch, err := strconv.Atoi(parts[2])
	if err != nil {
		return SemVer{}, fmt.Errorf("invalid patch version %q: %w", parts[2], err)
	}
	return SemVer{Major: major, Minor: minor, Patch: patch}, nil
}

func (s SemVer) Bump(part string) (SemVer, error) {
	switch strings.ToLower(part) {
	case "major":
		return SemVer{Major: s.Major + 1, Minor: 0, Patch: 0}, nil
	case "minor":
		return SemVer{Major: s.Major, Minor: s.Minor + 1, Patch: 0}, nil
	case "patch":
		return SemVer{Major: s.Major, Minor: s.Minor, Patch: s.Patch + 1}, nil
	default:
		return parseSemVer(part)
	}
}

func repoRoot() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	dir := wd
	for {
		if _, err := os.Stat(filepath.Join(dir, "VERSION")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", errors.New("could not locate repository root (missing VERSION file)")
}

func readCanonicalVersion(root string) (string, error) {
	data, err := os.ReadFile(filepath.Join(root, "VERSION"))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

func cmdStatus(root string) error {
	version, err := readCanonicalVersion(root)
	if err != nil {
		return fmt.Errorf("read canonical version: %w", err)
	}
	if _, err := parseSemVer(version); err != nil {
		return fmt.Errorf("canonical VERSION is invalid: %w", err)
	}
	fmt.Printf("Canonical release version: v%s\n", version)
	fmt.Println("Build metadata, package labels, installer metadata, and site labels are derived at build/runtime; edit VERSION only.")
	return nil
}

func cmdSync(root string, targetVersion string) error {
	version, err := readCanonicalVersion(root)
	if err != nil {
		return fmt.Errorf("read canonical version: %w", err)
	}
	if targetVersion != "" {
		sv, err := parseSemVer(targetVersion)
		if err != nil {
			return err
		}
		version = sv.String()
	}
	if _, err := parseSemVer(version); err != nil {
		return fmt.Errorf("canonical VERSION is invalid: %w", err)
	}
	path := filepath.Join(root, "VERSION")
	current, err := readCanonicalVersion(root)
	if err != nil {
		return fmt.Errorf("read canonical version: %w", err)
	}
	if current == version {
		fmt.Printf("VERSION already set to v%s.\n", version)
		return nil
	}
	if err := os.WriteFile(path, []byte(version+"\n"), 0644); err != nil {
		return fmt.Errorf("write VERSION: %w", err)
	}
	fmt.Printf("Updated VERSION to v%s. All other version values are derived during build or runtime.\n", version)
	return nil
}

func cmdBump(root string, bumpType string) (string, error) {
	current, err := readCanonicalVersion(root)
	if err != nil {
		return "", fmt.Errorf("read current version: %w", err)
	}
	semver, err := parseSemVer(current)
	if err != nil {
		return "", fmt.Errorf("parse current version %q: %w", current, err)
	}
	next, err := semver.Bump(bumpType)
	if err != nil {
		return "", fmt.Errorf("bump version: %w", err)
	}
	fmt.Printf("Bumping version: v%s -> v%s\n", semver, next)
	if err := cmdSync(root, next.String()); err != nil {
		return "", err
	}
	return next.String(), nil
}

func cmdRelease(root string, bumpType string) error {
	next, err := cmdBump(root, bumpType)
	if err != nil {
		return err
	}
	fmt.Printf("VERSION prepared for v%s. Build and publish explicitly; this command does not commit, tag, push, or delete releases.\n", next)
	return nil
}

func printHelp() {
	fmt.Println("RiftOps Version Manager")
	fmt.Println("Usage:")
	fmt.Println("  go run ./scripts/version-manager.go status              Show the canonical VERSION value")
	fmt.Println("  go run ./scripts/version-manager.go sync [version]      Set VERSION (compatibility alias; no other files are edited)")
	fmt.Println("  go run ./scripts/version-manager.go bump <patch|minor|major|version> Bump VERSION")
	fmt.Println("  go run ./scripts/version-manager.go release <patch|minor|major|version> Prepare VERSION only; no GitHub writes")
}

func main() {
	root, err := repoRoot()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	if len(os.Args) < 2 {
		printHelp()
		return
	}

	action := strings.ToLower(os.Args[1])
	switch action {
	case "status", "check":
		if err := cmdStatus(root); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
	case "sync":
		target := ""
		if len(os.Args) > 2 {
			target = os.Args[2]
		}
		if err := cmdSync(root, target); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
	case "bump":
		if len(os.Args) < 3 {
			fmt.Fprintln(os.Stderr, "Error: bump requires argument: patch, minor, major, or explicit version (e.g. 2.8.4)")
			os.Exit(1)
		}
		if _, err := cmdBump(root, os.Args[2]); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
	case "release":
		if len(os.Args) < 3 {
			fmt.Fprintln(os.Stderr, "Error: release requires argument: patch, minor, major, or explicit version (e.g. 2.8.4)")
			os.Exit(1)
		}
		if err := cmdRelease(root, os.Args[2]); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
	case "help", "--help", "-h":
		printHelp()
	default:
		fmt.Fprintf(os.Stderr, "Unknown action: %s\n\n", action)
		printHelp()
		os.Exit(1)
	}
}
