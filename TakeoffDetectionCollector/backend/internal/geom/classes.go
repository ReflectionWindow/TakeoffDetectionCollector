package geom

import (
	"sort"
	"strings"
	"unicode"
)

var KnownClasses = []string{
	"PW", "SF", "WW", "CW", "SF/CW", "LOUVER", "METAL_PANEL", "LOUVER_SOFT", "METAL_PANEL_SOFT",
}

// genericTools are Bluebeam's built-in tool names, not takeoff classes.
var genericTools = map[string]bool{
	"AREA MEASUREMENT":          true,
	"COUNT MEASUREMENT":         true,
	"LENGTH MEASUREMENT":        true,
	"POLYLENGTH MEASUREMENT":    true,
	"TEXT BOX":                  true,
	"RECTANGLE":                 true,
	"RECTANGLE SKETCH TO SCALE": true,
	"POLYGON":                   true,
	"LEGEND":                    true,
	"CALLOUT":                   true,
	"IMAGE":                     true,
	"LINE":                      true,
	"ARROW":                     true,
	"STAMP":                     true,
	"POPUP":                     true,
}

// classPhrases maps words estimators actually write in /Contents and /Subj.
// Longer phrases win so "punched window wall" is WW, not PW.
var classPhrases = []struct {
	phrase string
	class  string
}{
	{"PUNCHED WINDOW WALL", "WW"},
	{"PUNCH WINDOW WALL", "WW"},
	{"PUNCHED WINDOW", "PW"},
	{"PUNCH WINDOW", "PW"},
	{"WINDOW WALL", "WW"},
	{"CURTAIN WALL", "CW"},
	{"CLEAR WALL", "CW"},
	{"CLEARWALL", "CW"},
	{"STORE FRONT", "SF"},
	{"STOREFRONT", "SF"},
	{"METAL PANEL", "METAL_PANEL"},
	{"MEGA PANEL", "METAL_PANEL"},
	{"METAL SEC", "METAL_PANEL"},
	{"GLAZED IN MP", "METAL_PANEL"},
	{"HOPPER WINDOW", "PW"},
	{"HOPPER VENT", "PW"},
	{"AWNING VENT", "PW"},
	{"CASEMENT VENT", "PW"},
	{"OPERABLE VENT", "PW"},
	{"VENT HOPPER", "PW"},
	{"VENT AWNING", "PW"},
	{"VENT CASEMENT", "PW"},
	{"SF / CW", "SF/CW"},
	{"SF CW", "SF/CW"},
	{"LOUVRE", "LOUVER"},
	{"LOUVER", "LOUVER"},
	{"M PANEL", "METAL_PANEL"},
	{"CASEMENT", "PW"},
}

var tokenClass = map[string]string{
	"PW":               "PW",
	"SF":               "SF",
	"WW":               "WW",
	"CW":               "CW",
	"SFD":              "SF",
	"MP":               "METAL_PANEL",
	"LOUVER":           "LOUVER",
	"LOUVRE":           "LOUVER",
	"METAL_PANEL":      "METAL_PANEL",
	"LOUVER_SOFT":      "LOUVER_SOFT",
	"METAL_PANEL_SOFT": "METAL_PANEL_SOFT",
}

func init() {
	sort.SliceStable(classPhrases, func(i, j int) bool {
		return len(classPhrases[i].phrase) > len(classPhrases[j].phrase)
	})
}

func MatchClass(contents, subj string) (string, bool) {
	for _, raw := range []string{contents, subj} {
		if class, ok := matchOne(raw); ok {
			return class, true
		}
	}
	return "", false
}

func matchOne(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", false
	}
	for _, line := range splitLines(raw) {
		if line == "" || genericTools[strings.ToUpper(line)] {
			continue
		}
		for _, name := range KnownClasses {
			if strings.EqualFold(name, line) {
				return name, true
			}
		}
		if class, ok := matchLabel(line); ok {
			return class, true
		}
	}
	return "", false
}

func matchLabel(line string) (string, bool) {
	norm := normalizeLabel(line)
	if norm == "" || genericTools[norm] {
		return "", false
	}
	for _, p := range classPhrases {
		if strings.Contains(norm, p.phrase) {
			return p.class, true
		}
	}
	for _, tok := range strings.Fields(norm) {
		if class, ok := tokenClass[tok]; ok {
			return class, true
		}
		trimmed := strings.TrimRight(tok, "0123456789")
		if trimmed != tok && trimmed != "" {
			if class, ok := tokenClass[trimmed]; ok {
				return class, true
			}
		}
	}
	return "", false
}

func normalizeLabel(s string) string {
	s = strings.ToUpper(s)
	var b strings.Builder
	b.Grow(len(s))
	prevSpace := true
	for _, r := range s {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
			prevSpace = false
		case r == '/':
			if !prevSpace {
				b.WriteByte(' ')
			}
			b.WriteByte('/')
			b.WriteByte(' ')
			prevSpace = true
		default:
			if !prevSpace {
				b.WriteByte(' ')
				prevSpace = true
			}
		}
	}
	return strings.TrimSpace(b.String())
}

func ClassID(name string) int {
	for i, c := range KnownClasses {
		if c == name {
			return i + 1
		}
	}
	return 0
}

func splitLines(raw string) []string {
	raw = strings.ReplaceAll(raw, "\r\n", "\n")
	raw = strings.ReplaceAll(raw, "\r", "\n")
	return strings.Split(raw, "\n")
}
