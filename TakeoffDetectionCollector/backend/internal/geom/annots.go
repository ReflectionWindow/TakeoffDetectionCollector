package geom

import (
	"bytes"
	"regexp"
)

var (
	annotsArrayRe = regexp.MustCompile(`/Annots\s*\[[^\[\]]*\]`)
	annotsRefRe   = regexp.MustCompile(`/Annots\s+\d+\s+\d+\s+R`)
)

func blankMatch(m []byte) []byte {
	out := make([]byte, len(m))
	for i := range out {
		out[i] = ' '
	}
	return out
}

// StripAnnots blanks PDF annotation dictionaries on page objects so Bluebeam
// markups are not drawn. Replacements keep the original byte length so the
// xref table stays valid. Content-stream linework is kept.
func StripAnnots(pdf []byte) []byte {
	if len(pdf) == 0 {
		return pdf
	}
	out := annotsArrayRe.ReplaceAllFunc(pdf, blankMatch)
	out = annotsRefRe.ReplaceAllFunc(out, blankMatch)
	if !bytes.HasPrefix(bytes.TrimSpace(out), []byte("%PDF")) {
		return pdf
	}
	return EnsureXRef(out)
}
