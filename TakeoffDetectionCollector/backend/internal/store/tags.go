package store

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

const (
	MaxTagLen     = 40
	MaxTagsPerJob = 24
)

type Tag struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func NormalizeTagName(raw string) (string, error) {
	name := strings.Join(strings.Fields(raw), " ")
	if name == "" {
		return "", fmt.Errorf("tag name is empty")
	}
	if utf8.RuneCountInString(name) > MaxTagLen {
		return "", fmt.Errorf("tag name must be %d characters or fewer", MaxTagLen)
	}
	if strings.ContainsAny(name, "\x00") {
		return "", fmt.Errorf("tag name is invalid")
	}
	return name, nil
}

func NormalizeTagNames(raw []string) ([]string, error) {
	if len(raw) > MaxTagsPerJob {
		return nil, fmt.Errorf("a job can have at most %d tags", MaxTagsPerJob)
	}
	out := make([]string, 0, len(raw))
	seen := map[string]struct{}{}
	for _, item := range raw {
		name, err := NormalizeTagName(item)
		if err != nil {
			return nil, err
		}
		key := strings.ToLower(name)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, name)
	}
	if len(out) > MaxTagsPerJob {
		return nil, fmt.Errorf("a job can have at most %d tags", MaxTagsPerJob)
	}
	return out, nil
}
