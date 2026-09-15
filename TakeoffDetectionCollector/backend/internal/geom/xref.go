package geom

import (
	"bytes"
	"fmt"
	"regexp"
	"strconv"
)

var (
	startXRefRe = regexp.MustCompile(`startxref\s+(\d+)`)
	rootRefRe   = regexp.MustCompile(`/Root\s+(\d+)\s+(\d+)\s+R`)
	objLineRe   = regexp.MustCompile(`(?m)(?:^|[\r\n])(\d+) (\d+) obj`)
)

// EnsureXRef appends a classic xref table when the existing startxref pointer
// is stale. StripAnnots used to delete bytes, which shifted every later object
// and forced pdf.js to scan the whole file ("Indexing all PDF objects").
func EnsureXRef(pdf []byte) []byte {
	if xrefStartValid(pdf) {
		return pdf
	}
	fixed, err := appendClassicXRef(pdf)
	if err != nil {
		return pdf
	}
	return fixed
}

func parseStartXRef(pdf []byte) (int, bool) {
	ms := startXRefRe.FindAllSubmatch(pdf, -1)
	if len(ms) == 0 {
		return 0, false
	}
	off, err := strconv.Atoi(string(ms[len(ms)-1][1]))
	if err != nil || off < 0 {
		return 0, false
	}
	return off, true
}

func xrefStartValid(pdf []byte) bool {
	off, ok := parseStartXRef(pdf)
	if !ok || off >= len(pdf) {
		return false
	}
	rest := bytes.TrimLeft(pdf[off:], "\r\n\t ")
	if bytes.HasPrefix(rest, []byte("xref")) {
		return true
	}
	if loc := objHeadRe.FindIndex(rest); loc != nil && loc[0] == 0 {
		return true
	}
	return false
}

func lastRoot(pdf []byte) (id, gen int, ok bool) {
	ms := rootRefRe.FindAllSubmatch(pdf, -1)
	if len(ms) == 0 {
		return 0, 0, false
	}
	m := ms[len(ms)-1]
	id, err1 := strconv.Atoi(string(m[1]))
	gen, err2 := strconv.Atoi(string(m[2]))
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return id, gen, true
}

func streamBodies(pdf []byte) [][2]int {
	var out [][2]int
	for i := 0; i < len(pdf); {
		j := bytes.Index(pdf[i:], []byte("stream"))
		if j < 0 {
			break
		}
		at := i + j
		if at >= 3 && string(pdf[at-3:at+6]) == "endstream" {
			i = at + 6
			continue
		}
		start := at + 6
		if start < len(pdf) && pdf[start] == '\r' {
			start++
		}
		if start < len(pdf) && pdf[start] == '\n' {
			start++
		}
		k := bytes.Index(pdf[start:], []byte("endstream"))
		if k < 0 {
			out = append(out, [2]int{start, len(pdf)})
			break
		}
		end := start + k
		out = append(out, [2]int{start, end})
		i = end + 9
	}
	return out
}

func inRanges(pos int, rs [][2]int) bool {
	for _, r := range rs {
		if pos >= r[0] && pos < r[1] {
			return true
		}
	}
	return false
}

type xrefObj struct {
	off, gen int
}

func objectOffsets(pdf []byte) map[int]xrefObj {
	bodies := streamBodies(pdf)
	out := map[int]xrefObj{}
	for _, m := range objLineRe.FindAllSubmatchIndex(pdf, -1) {
		idStart := m[2]
		if inRanges(idStart, bodies) {
			continue
		}
		id, err1 := strconv.Atoi(string(pdf[m[2]:m[3]]))
		gen, err2 := strconv.Atoi(string(pdf[m[4]:m[5]]))
		if err1 != nil || err2 != nil || id < 0 {
			continue
		}
		out[id] = xrefObj{off: idStart, gen: gen}
	}
	return out
}

func appendClassicXRef(pdf []byte) ([]byte, error) {
	root, rootGen, ok := lastRoot(pdf)
	if !ok {
		return nil, fmt.Errorf("no /Root")
	}
	offs := objectOffsets(pdf)
	if len(offs) == 0 {
		return nil, fmt.Errorf("no objects")
	}
	maxID := root
	for id := range offs {
		if id > maxID {
			maxID = id
		}
	}
	size := maxID + 1
	var b bytes.Buffer
	b.Grow(len(pdf) + 64 + 20*size)
	b.Write(pdf)
	if n := len(pdf); n == 0 || (pdf[n-1] != '\n' && pdf[n-1] != '\r') {
		b.WriteByte('\n')
	}
	xrefAt := b.Len()
	fmt.Fprintf(&b, "xref\n0 %d\n", size)
	b.WriteString("0000000000 65535 f \n")
	for id := 1; id < size; id++ {
		if o, ok := offs[id]; ok {
			fmt.Fprintf(&b, "%010d %05d n \n", o.off, o.gen)
		} else {
			b.WriteString("0000000000 65535 f \n")
		}
	}
	fmt.Fprintf(&b, "trailer\n<< /Size %d /Root %d %d R >>\nstartxref\n%d\n%%%%EOF\n", size, root, rootGen, xrefAt)
	return b.Bytes(), nil
}
