package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
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

type FileSync struct {
	Path        string
	Description string
	Check       func(content string, version string) (bool, string)
	Update      func(content string, version string) string
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

func getTargetFiles(root string) []FileSync {
	return []FileSync{
		{
			Path:        filepath.Join(root, "VERSION"),
			Description: "Canonical VERSION file",
			Check: func(content string, version string) (bool, string) {
				current := strings.TrimSpace(content)
				return current == version, current
			},
			Update: func(_ string, version string) string {
				return version + "\n"
			},
		},
		{
			Path:        filepath.Join(root, "internal", "buildinfo", "buildinfo.go"),
			Description: "Go buildinfo package",
			Check: func(content string, version string) (bool, string) {
				re := regexp.MustCompile(`var Version = "([^"]+)"`)
				match := re.FindStringSubmatch(content)
				if len(match) > 1 {
					return match[1] == version, match[1]
				}
				return false, "not found"
			},
			Update: func(content string, version string) string {
				re := regexp.MustCompile(`var Version = "[^"]+"`)
				return re.ReplaceAllString(content, fmt.Sprintf(`var Version = "%s"`, version))
			},
		},
		{
			Path:        filepath.Join(root, "scripts", "installer.iss"),
			Description: "Inno Setup installer script",
			Check: func(content string, version string) (bool, string) {
				re := regexp.MustCompile(`#define AppVersion "([^"]+)"`)
				match := re.FindStringSubmatch(content)
				if len(match) > 1 {
					return match[1] == version, match[1]
				}
				return false, "not found"
			},
			Update: func(content string, version string) string {
				re := regexp.MustCompile(`#define AppVersion "[^"]+"`)
				return re.ReplaceAllString(content, fmt.Sprintf(`#define AppVersion "%s"`, version))
			},
		},
		{
			Path:        filepath.Join(root, "cmd", "riftops-ui", "frontend", "package.json"),
			Description: "Frontend package.json",
			Check: func(content string, version string) (bool, string) {
				var data map[string]any
				if err := json.Unmarshal([]byte(content), &data); err == nil {
					if v, ok := data["version"].(string); ok {
						return v == version, v
					}
				}
				return false, "not found"
			},
			Update: func(content string, version string) string {
				var data map[string]any
				if err := json.Unmarshal([]byte(content), &data); err != nil {
					return content
				}
				data["version"] = version
				buf := new(bytes.Buffer)
				enc := json.NewEncoder(buf)
				enc.SetEscapeHTML(false)
				enc.SetIndent("", "  ")
				if err := enc.Encode(data); err == nil {
					return buf.String()
				}
				return content
			},
		},
		{
			Path:        filepath.Join(root, "cmd", "riftops-ui", "frontend", "src", "components", "SettingsPage.tsx"),
			Description: "React UI SettingsPage fallback",
			Check: func(content string, version string) (bool, string) {
				re := regexp.MustCompile(`snapshot\.Version \|\| '([^']+)'`)
				match := re.FindStringSubmatch(content)
				if len(match) > 1 {
					return match[1] == version, match[1]
				}
				return false, "not found"
			},
			Update: func(content string, version string) string {
				re1 := regexp.MustCompile(`(res\.currentVersion \|\| snapshot\.Version \|\| ')[^']+(')`)
				content = re1.ReplaceAllString(content, fmt.Sprintf(`${1}%s${2}`, version))
				re2 := regexp.MustCompile(`(snapshot\.Version \? `+"`"+`v\${snapshot\.Version}`+"`"+` : ')[^']+(')`)
				content = re2.ReplaceAllString(content, fmt.Sprintf(`${1}%s${2}`, version))
				return content
			},
		},
		{
			Path:        filepath.Join(root, "docs", "index.html"),
			Description: "GitHub Pages landing site",
			Check: func(content string, version string) (bool, string) {
				re := regexp.MustCompile(`<span class="brand-version">v([^<]+)</span>`)
				match := re.FindStringSubmatch(content)
				if len(match) > 1 {
					return match[1] == version, match[1]
				}
				return false, "not found"
			},
			Update: func(content string, version string) string {
				re1 := regexp.MustCompile(`<span class="brand-version">v[^<]+</span>`)
				content = re1.ReplaceAllString(content, fmt.Sprintf(`<span class="brand-version">v%s</span>`, version))
				re2 := regexp.MustCompile(`(Download v)[0-9]+\.[0-9]+\.[0-9]+`)
				content = re2.ReplaceAllString(content, fmt.Sprintf(`${1}%s`, version))
				re3 := regexp.MustCompile(`(<span>v)[0-9]+\.[0-9]+\.[0-9]+(</span>)`)
				content = re3.ReplaceAllString(content, fmt.Sprintf(`${1}%s${2}`, version))
				return content
			},
		},
	}
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
	fmt.Printf("Canonical Version (VERSION): v%s\n\n", version)
	files := getTargetFiles(root)
	allSynced := true
	for _, f := range files {
		rel, _ := filepath.Rel(root, f.Path)
		data, err := os.ReadFile(f.Path)
		if err != nil {
			fmt.Printf("  [MISSING] %-55s (%s: %v)\n", rel, f.Description, err)
			allSynced = false
			continue
		}
		synced, current := f.Check(string(data), version)
		if synced {
			fmt.Printf("  [SYNCED]  %-55s (v%s)\n", rel, current)
		} else {
			fmt.Printf("  [OUTDATED]%-55s (found: v%s, want: v%s)\n", rel, current, version)
			allSynced = false
		}
	}
	fmt.Println()
	if allSynced {
		fmt.Println("All repository version files are fully synchronized.")
	} else {
		fmt.Println("Some files are out of sync. Run 'go run ./scripts/version-manager.go sync' to synchronize.")
	}
	return nil
}

func cmdSync(root string, targetVersion string) error {
	var version string
	if targetVersion != "" {
		sv, err := parseSemVer(targetVersion)
		if err != nil {
			return err
		}
		version = sv.String()
	} else {
		var err error
		version, err = readCanonicalVersion(root)
		if err != nil {
			return fmt.Errorf("read canonical version: %w", err)
		}
	}

	fmt.Printf("Synchronizing repository to v%s...\n", version)
	files := getTargetFiles(root)
	for _, f := range files {
		rel, _ := filepath.Rel(root, f.Path)
		content := ""
		data, err := os.ReadFile(f.Path)
		if err == nil {
			content = string(data)
		}
		updated := f.Update(content, version)
		if updated != content {
			if err := os.WriteFile(f.Path, []byte(updated), 0644); err != nil {
				return fmt.Errorf("write %s: %w", rel, err)
			}
			fmt.Printf("  Updated %s\n", rel)
		} else {
			fmt.Printf("  Already up-to-date: %s\n", rel)
		}
	}
	fmt.Printf("\nRepository version synchronized to v%s successfully.\n", version)
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

	fmt.Println("\nBuilding frontend assets...")
	npmCmd := exec.Command("npm", "run", "build")
	npmCmd.Dir = filepath.Join(root, "cmd", "riftops-ui", "frontend")
	npmCmd.Stdout = os.Stdout
	npmCmd.Stderr = os.Stderr
	if err := npmCmd.Run(); err != nil {
		return fmt.Errorf("npm run build failed: %w", err)
	}

	fmt.Println("\nRunning tests...")
	testCmd := exec.Command("go", "test", "./...")
	testCmd.Dir = root
	testCmd.Stdout = os.Stdout
	testCmd.Stderr = os.Stderr
	if err := testCmd.Run(); err != nil {
		return fmt.Errorf("go test failed: %w", err)
	}

	fmt.Println("\nCreating git commit and tag...")
	gitAdd := exec.Command("git", "add", ".")
	gitAdd.Dir = root
	if err := gitAdd.Run(); err != nil {
		return fmt.Errorf("git add failed: %w", err)
	}

	commitMsg := fmt.Sprintf("chore(release): bump version to %s", next)
	gitCommit := exec.Command("git", "commit", "-m", commitMsg)
	gitCommit.Dir = root
	gitCommit.Stdout = os.Stdout
	gitCommit.Stderr = os.Stderr
	if err := gitCommit.Run(); err != nil {
		return fmt.Errorf("git commit failed: %w", err)
	}

	tag := "v" + next
	tagMsg := fmt.Sprintf("Release %s", tag)
	gitTag := exec.Command("git", "tag", "-a", tag, "-m", tagMsg)
	gitTag.Dir = root
	gitTag.Stdout = os.Stdout
	gitTag.Stderr = os.Stderr
	if err := gitTag.Run(); err != nil {
		return fmt.Errorf("git tag failed: %w", err)
	}

	fmt.Printf("\nPushing commit and tag %s to GitHub...\n", tag)
	gitPush := exec.Command("git", "push", "origin", "main", "--tags")
	gitPush.Dir = root
	gitPush.Stdout = os.Stdout
	gitPush.Stderr = os.Stderr
	if err := gitPush.Run(); err != nil {
		return fmt.Errorf("git push failed: %w", err)
	}

	fmt.Printf("\nSuccessfully released and pushed %s to GitHub!\n", tag)
	return nil
}

func printHelp() {
	fmt.Println("RiftOps Version Manager")
	fmt.Println("Usage:")
	fmt.Println("  go run ./scripts/version-manager.go status              Show sync status across all files")
	fmt.Println("  go run ./scripts/version-manager.go sync [version]      Sync all files to VERSION (or given version)")
	fmt.Println("  go run ./scripts/version-manager.go bump <patch|minor|major|version> Bump version and sync files")
	fmt.Println("  go run ./scripts/version-manager.go release <patch|minor|major|version> Bump, build, test, commit, tag, & push")
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
