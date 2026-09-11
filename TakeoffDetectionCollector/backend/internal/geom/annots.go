package geom

import (
	"bytes"
	"regexp"
)

var (
	annotsArrayRe = regexp.MustCompile(`/Annots\s*\[[^\[\]]*\]`)
	annotsRefRe   = regexp.MustCompile(`/Annots\s+\d+\s+\d+\s+R`)
)

// StripAnnots removes PDF annotation dictionaries from page objects so Bluebeam
// markups are not drawn. Content-stream linework (the vector drawing) is kept.
func StripAnnots(pdf []byte) []byte {
	if len(pdf) == 0 {
		return pdf
	}
	out := annotsArrayRe.ReplaceAll(pdf, nil)
	out = annotsRefRe.ReplaceAll(out, nil)
	if !bytes.HasPrefix(bytes.TrimSpace(out), []byte("%PDF")) {
		return pdf
	}
	return out
}
