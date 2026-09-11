package geom

import "strings"

var KnownClasses = []string{
	"PW", "SF", "WW", "CW", "SF/CW", "LOUVER", "METAL_PANEL", "LOUVER_SOFT", "METAL_PANEL_SOFT",
}

func MatchClass(contents, subj string) (string, bool) {
	for _, raw := range []string{contents, subj} {
		line := firstLine(raw)
		if line == "" {
			continue
		}
		for _, name := range KnownClasses {
			if strings.EqualFold(name, line) {
				return name, true
			}
		}
	}
	return "", false
}

func ClassID(name string) int {
	for i, c := range KnownClasses {
		if c == name {
			return i + 1
		}
	}
	return 0
}

func firstLine(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if i := strings.IndexAny(raw, "\r\n"); i >= 0 {
		raw = raw[:i]
	}
	return strings.TrimSpace(raw)
}
