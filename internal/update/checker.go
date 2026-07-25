package update

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const DefaultLatestReleaseURL = "https://api.github.com/repos/HassanSalah120/RiftOps/releases/latest"

type Release struct {
	Version string
	URL     string
	Name    string
}

type Checker struct {
	URL    string
	Client *http.Client
}

func (c Checker) Latest(ctx context.Context) (Release, error) {
	endpoint := c.URL
	if endpoint == "" {
		endpoint = DefaultLatestReleaseURL
	}
	client := c.Client
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return Release{}, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", "RiftOps")
	response, err := client.Do(request)
	if err != nil {
		return Release{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return Release{}, fmt.Errorf("release service returned %s", response.Status)
	}
	var payload struct {
		Tag  string `json:"tag_name"`
		URL  string `json:"html_url"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return Release{}, err
	}
	if _, err := parseVersion(payload.Tag); err != nil {
		return Release{}, err
	}
	return Release{Version: payload.Tag, URL: payload.URL, Name: payload.Name}, nil
}

func IsNewer(current, candidate string) (bool, error) {
	currentVersion, err := parseVersion(current)
	if err != nil {
		return false, err
	}
	candidateVersion, err := parseVersion(candidate)
	if err != nil {
		return false, err
	}
	return candidateVersion.compare(currentVersion) > 0, nil
}

type semanticVersion struct {
	core       [3]int
	prerelease []string
}

func parseVersion(value string) (semanticVersion, error) {
	var result semanticVersion
	value = strings.TrimPrefix(strings.TrimSpace(value), "v")
	value = strings.SplitN(value, "+", 2)[0]
	versionAndPrerelease := strings.SplitN(value, "-", 2)
	parts := strings.Split(versionAndPrerelease[0], ".")
	if len(parts) != 3 {
		return result, fmt.Errorf("invalid semantic version %q", value)
	}
	for i, part := range parts {
		parsed, err := strconv.Atoi(part)
		if err != nil || parsed < 0 || (len(part) > 1 && part[0] == '0') {
			return result, fmt.Errorf("invalid semantic version %q", value)
		}
		result.core[i] = parsed
	}
	if len(versionAndPrerelease) == 2 {
		if versionAndPrerelease[1] == "" {
			return result, fmt.Errorf("invalid semantic version %q", value)
		}
		result.prerelease = strings.Split(versionAndPrerelease[1], ".")
		for _, identifier := range result.prerelease {
			if !validPrereleaseIdentifier(identifier) {
				return semanticVersion{}, fmt.Errorf("invalid semantic version %q", value)
			}
		}
	}
	return result, nil
}

func (v semanticVersion) compare(other semanticVersion) int {
	for index := range v.core {
		if v.core[index] < other.core[index] {
			return -1
		}
		if v.core[index] > other.core[index] {
			return 1
		}
	}
	if len(v.prerelease) == 0 && len(other.prerelease) == 0 {
		return 0
	}
	if len(v.prerelease) == 0 {
		return 1
	}
	if len(other.prerelease) == 0 {
		return -1
	}
	for index := 0; index < len(v.prerelease) && index < len(other.prerelease); index++ {
		left, right := v.prerelease[index], other.prerelease[index]
		if left == right {
			continue
		}
		leftNumber, leftErr := strconv.Atoi(left)
		rightNumber, rightErr := strconv.Atoi(right)
		switch {
		case leftErr == nil && rightErr == nil:
			if leftNumber < rightNumber {
				return -1
			}
			return 1
		case leftErr == nil:
			return -1
		case rightErr == nil:
			return 1
		case left < right:
			return -1
		default:
			return 1
		}
	}
	if len(v.prerelease) < len(other.prerelease) {
		return -1
	}
	if len(v.prerelease) > len(other.prerelease) {
		return 1
	}
	return 0
}

func validPrereleaseIdentifier(value string) bool {
	if value == "" {
		return false
	}
	if _, err := strconv.Atoi(value); err == nil && len(value) > 1 && value[0] == '0' {
		return false
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') &&
			(character < '0' || character > '9') && character != '-' {
			return false
		}
	}
	return true
}
