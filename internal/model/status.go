package model

import (
	"fmt"
	"strings"
)

type Status string

const (
	StatusOnline  Status = "chat"
	StatusOffline Status = "offline"
	StatusMobile  Status = "mobile"
)

func ParseStatus(value string) (Status, error) {
	switch Status(strings.ToLower(strings.TrimSpace(value))) {
	case StatusOnline:
		return StatusOnline, nil
	case StatusOffline:
		return StatusOffline, nil
	case StatusMobile:
		return StatusMobile, nil
	default:
		return "", fmt.Errorf("unsupported status %q", value)
	}
}

func (s Status) Valid() bool {
	return s == StatusOnline || s == StatusOffline || s == StatusMobile
}
