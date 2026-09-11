package geom

import (
	"bytes"
	"regexp"
	"strconv"
	"strings"
)

type Markup struct {
	Class  string
	PolyPt [][2]float64
}

type PageMarkups struct {
	PageIndex int
	WidthPt   float64
	HeightPt  float64
	Markups   []Markup
}

type pdfObject struct {
	num  int
	data []byte
}

var (
	objHeadRe         = regexp.MustCompile(`(\d+)\s+\d+\s+obj`)
	subtypeRe         = regexp.MustCompile(`/Subtype\s*/([A-Za-z]+)`)
	verticesRe        = regexp.MustCompile(`/Vertices\s*\[([^\]]*)\]`)
	annotRefRe        = regexp.MustCompile(`(\d+)\s+\d+\s+R`)
	pageAnnotsArrayRe = regexp.MustCompile(`/Annots\s*\[([^\]]*)\]`)
	pageAnnotsObjRe   = regexp.MustCompile(`/Annots\s+(\d+)\s+\d+\s+R`)
	numberRe          = regexp.MustCompile(`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`)
)

func ExtractMarkups(pdf []byte) []PageMarkups {
	ordered, byNum := indexObjects(pdf)
	var out []PageMarkups
	for _, obj := range ordered {
		if !pageObjRe.Match(obj.data) {
			continue
		}
		w, h := 0.0, 0.0
		if m := cropBoxRe.FindSubmatch(obj.data); len(m) == 5 {
			w, h, _ = boxWH(m)
		} else if m := mediaBoxRe.FindSubmatch(obj.data); len(m) == 5 {
			w, h, _ = boxWH(m)
		}
		userH := h
		if rot := rotateRe.FindSubmatch(obj.data); len(rot) == 2 {
			r, _ := strconv.Atoi(string(rot[1]))
			r = ((r % 360) + 360) % 360
			if r == 90 || r == 270 {
				w, h = h, w
			}
		}
		if userH == 0 {
			userH = h
		}
		annots := pageAnnotObjects(obj.data, byNum)
		var markups []Markup
		for _, raw := range annots {
			if m, ok := parseMarkup(raw, userH); ok {
				markups = append(markups, m)
			}
		}
		out = append(out, PageMarkups{
			PageIndex: len(out),
			WidthPt:   w,
			HeightPt:  h,
			Markups:   markups,
		})
	}
	return out
}

func indexObjects(pdf []byte) ([]pdfObject, map[int][]byte) {
	parts := splitObjects(pdf)
	byNum := map[int][]byte{}
	ordered := make([]pdfObject, 0, len(parts))
	for _, p := range parts {
		m := objHeadRe.FindSubmatch(p)
		if m == nil {
			continue
		}
		n, _ := strconv.Atoi(string(m[1]))
		byNum[n] = p
		ordered = append(ordered, pdfObject{num: n, data: p})
	}
	return ordered, byNum
}

func pageAnnotObjects(page []byte, byNum map[int][]byte) [][]byte {
	var refs []int
	if m := pageAnnotsArrayRe.FindSubmatch(page); len(m) == 2 {
		refs = annotRefs(m[1])
	} else if m := pageAnnotsObjRe.FindSubmatch(page); len(m) == 2 {
		n, _ := strconv.Atoi(string(m[1]))
		if arr, ok := byNum[n]; ok {
			refs = annotRefs(arr)
		}
	}
	out := make([][]byte, 0, len(refs))
	for _, n := range refs {
		if raw, ok := byNum[n]; ok {
			out = append(out, raw)
		}
	}
	return out
}

func annotRefs(raw []byte) []int {
	ms := annotRefRe.FindAllSubmatch(raw, -1)
	out := make([]int, 0, len(ms))
	for _, m := range ms {
		n, _ := strconv.Atoi(string(m[1]))
		out = append(out, n)
	}
	return out
}

func parseMarkup(obj []byte, pageHeight float64) (Markup, bool) {
	sub := ""
	if m := subtypeRe.FindSubmatch(obj); len(m) == 2 {
		sub = string(m[1])
	}
	class, ok := MatchClass(dictString(obj, "/Contents"), dictString(obj, "/Subj"))
	if !ok {
		return Markup{}, false
	}
	poly := markupPoly(obj, sub, pageHeight)
	if len(poly) < 3 {
		return Markup{}, false
	}
	return Markup{Class: class, PolyPt: poly}, true
}

func markupPoly(obj []byte, subtype string, pageHeight float64) [][2]float64 {
	switch subtype {
	case "Polygon", "PolyLine":
		if verts := parseVertices(obj, pageHeight); len(verts) >= 3 {
			return verts
		}
		return rectPoly(obj, pageHeight)
	case "Square", "Circle":
		return rectPoly(obj, pageHeight)
	default:
		return nil
	}
}

func parseVertices(obj []byte, pageHeight float64) [][2]float64 {
	m := verticesRe.FindSubmatch(obj)
	if len(m) != 2 {
		return nil
	}
	nums := numberRe.FindAllString(string(m[1]), -1)
	if len(nums) < 6 {
		return nil
	}
	out := make([][2]float64, 0, len(nums)/2)
	for i := 0; i+1 < len(nums); i += 2 {
		x, _ := strconv.ParseFloat(nums[i], 64)
		y, _ := strconv.ParseFloat(nums[i+1], 64)
		out = append(out, [2]float64{x, flipY(y, pageHeight)})
	}
	return dropClose(out)
}

func rectPoly(obj []byte, pageHeight float64) [][2]float64 {
	m := mediaBoxRe.FindSubmatch(bytes.Replace(obj, []byte("/Rect"), []byte("/MediaBox"), 1))
	if len(m) != 5 {
		rectRe := regexp.MustCompile(`/Rect\s*\[\s*([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s*\]`)
		m = rectRe.FindSubmatch(obj)
	}
	if len(m) != 5 {
		return nil
	}
	x0, _ := strconv.ParseFloat(string(m[1]), 64)
	y0, _ := strconv.ParseFloat(string(m[2]), 64)
	x1, _ := strconv.ParseFloat(string(m[3]), 64)
	y1, _ := strconv.ParseFloat(string(m[4]), 64)
	minX, maxX := x0, x1
	if x1 < minX {
		minX, maxX = x1, x0
	}
	minY, maxY := y0, y1
	if y1 < minY {
		minY, maxY = y1, y0
	}
	top := flipY(maxY, pageHeight)
	h := maxY - minY
	return [][2]float64{
		{minX, top},
		{maxX, top},
		{maxX, top + h},
		{minX, top + h},
	}
}

func flipY(y, pageHeight float64) float64 {
	if pageHeight <= 0 {
		return y
	}
	return pageHeight - y
}

func dropClose(poly [][2]float64) [][2]float64 {
	if len(poly) >= 2 {
		a, b := poly[0], poly[len(poly)-1]
		if almostEq(a[0], b[0]) && almostEq(a[1], b[1]) {
			poly = poly[:len(poly)-1]
		}
	}
	if len(poly) < 3 {
		return nil
	}
	return poly
}

func almostEq(a, b float64) bool {
	d := a - b
	return d < 1e-6 && d > -1e-6
}

func dictString(obj []byte, key string) string {
	idx := bytes.Index(obj, []byte(key))
	if idx < 0 {
		return ""
	}
	rest := bytes.TrimSpace(obj[idx+len(key):])
	if len(rest) == 0 {
		return ""
	}
	switch rest[0] {
	case '(':
		return parsePDFLiteral(rest)
	case '<':
		if len(rest) > 1 && rest[1] == '<' {
			return ""
		}
		return parsePDFHexString(rest)
	default:
		return ""
	}
}

func parsePDFLiteral(rest []byte) string {
	if len(rest) == 0 || rest[0] != '(' {
		return ""
	}
	var b strings.Builder
	depth := 0
	esc := false
	for i := 0; i < len(rest); i++ {
		c := rest[i]
		if esc {
			switch c {
			case 'n':
				b.WriteByte('\n')
			case 'r':
				b.WriteByte('\r')
			case 't':
				b.WriteByte('\t')
			case 'b':
				b.WriteByte('\b')
			case '(':
				b.WriteByte('(')
			case ')':
				b.WriteByte(')')
			case '\\':
				b.WriteByte('\\')
			default:
				b.WriteByte(c)
			}
			esc = false
			continue
		}
		if c == '\\' {
			esc = true
			continue
		}
		if c == '(' {
			if depth > 0 {
				b.WriteByte(c)
			}
			depth++
			continue
		}
		if c == ')' {
			depth--
			if depth == 0 {
				return b.String()
			}
			b.WriteByte(c)
			continue
		}
		if depth > 0 {
			b.WriteByte(c)
		}
	}
	return b.String()
}

func parsePDFHexString(rest []byte) string {
	end := bytes.IndexByte(rest, '>')
	if end < 1 {
		return ""
	}
	hex := bytes.Map(func(r rune) rune {
		if r == ' ' || r == '\n' || r == '\r' || r == '\t' {
			return -1
		}
		return r
	}, rest[1:end])
	if len(hex)%2 == 1 {
		hex = append(hex, '0')
	}
	out := make([]byte, 0, len(hex)/2)
	for i := 0; i+1 < len(hex); i += 2 {
		v, err := strconv.ParseUint(string(hex[i:i+2]), 16, 8)
		if err != nil {
			return ""
		}
		out = append(out, byte(v))
	}
	if len(out) >= 2 && out[0] == 0xfe && out[1] == 0xff {
		var runes []rune
		for i := 2; i+1 < len(out); i += 2 {
			runes = append(runes, rune(out[i])<<8|rune(out[i+1]))
		}
		return string(runes)
	}
	return string(out)
}
