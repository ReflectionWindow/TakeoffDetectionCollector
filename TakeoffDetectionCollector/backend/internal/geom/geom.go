package geom

import (
	"bytes"
	"compress/zlib"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
)

const ExtractVersion = "collector-1"

type Vectors struct {
	PageWidthPt  float64     `json:"page_width_pt"`
	PageHeightPt float64     `json:"page_height_pt"`
	Rotation     int         `json:"rotation"`
	Empty        bool        `json:"empty"`
	Segments     Segments    `json:"segments"`
	Fills        [][]float64 `json:"fills"`
	Points       [][]float64 `json:"points"`
	Stats        Stats       `json:"stats"`
}

type Segments struct {
	Lines  [][]float64 `json:"lines"`
	Rects  [][]float64 `json:"rects"`
	Quads  [][]float64 `json:"quads"`
	Curves [][]float64 `json:"curves"`
}

type Stats struct {
	RawPathCount         int  `json:"raw_path_count"`
	ReturnedSegmentCount int  `json:"returned_segment_count"`
	Truncated            bool `json:"truncated"`
	DroppedShort         int  `json:"dropped_short"`
	DroppedFillOnly      int  `json:"dropped_fill_only"`
	DroppedHatch         int  `json:"dropped_hatch"`
	DroppedOutside       int  `json:"dropped_outside"`
	CurvesAsChords       int  `json:"curves_as_chords"`
	FillCount            int  `json:"fill_count"`
	PointCount           int  `json:"point_count"`
}

const (
	minLen       = 0.4
	maxSegments  = 12000
	pageFillFrac = 0.25
	skinnyThick  = 16.0
)

// ExtractPage walks PDF content streams for one 0-based page.
func ExtractPage(pdf []byte, pageIndex int) (Vectors, error) {
	pages, err := splitPages(pdf)
	if err != nil {
		return Vectors{}, err
	}
	if pageIndex < 0 || pageIndex >= len(pages) {
		return Vectors{Empty: true}, nil
	}
	p := pages[pageIndex]
	out := Vectors{PageWidthPt: p.w, PageHeightPt: p.h}
	walkContent(p.content, &out)
	out.Stats.ReturnedSegmentCount = len(out.Segments.Lines) + len(out.Segments.Rects) + len(out.Segments.Quads) + len(out.Segments.Curves)
	out.Stats.FillCount = len(out.Fills)
	out.Stats.PointCount = len(out.Points)
	out.Empty = out.Stats.ReturnedSegmentCount == 0 && out.Stats.FillCount == 0 && out.Stats.PointCount == 0
	return out, nil
}

func PageCount(pdf []byte) int {
	pages, err := splitPages(pdf)
	if err != nil {
		return 0
	}
	return len(pages)
}

type pdfPage struct {
	w, h    float64
	content []byte
}

var (
	mediaBoxRe = regexp.MustCompile(`/MediaBox\s*\[\s*([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s*\]`)
	cropBoxRe  = regexp.MustCompile(`/CropBox\s*\[\s*([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s*\]`)
	rotateRe   = regexp.MustCompile(`/Rotate\s+(-?\d+)`)
	streamRe   = regexp.MustCompile(`(?s)stream\r?\n(.*?)endstream`)
	pageObjRe  = regexp.MustCompile(`/Type\s*/Page[^s]`)
)

func isPageObject(obj []byte) bool {
	if bytes.Contains(obj, []byte("/ObjStm")) {
		return false
	}
	return pageObjRe.Match(obj)
}

type pageBox struct {
	x0, y0, x1, y1 float64
}

func boxFromMatch(m [][]byte) (pageBox, bool) {
	if len(m) != 5 {
		return pageBox{}, false
	}
	x0, _ := strconv.ParseFloat(string(m[1]), 64)
	y0, _ := strconv.ParseFloat(string(m[2]), 64)
	x1, _ := strconv.ParseFloat(string(m[3]), 64)
	y1, _ := strconv.ParseFloat(string(m[4]), 64)
	if x1 == x0 || y1 == y0 {
		return pageBox{}, false
	}
	return pageBox{x0: x0, y0: y0, x1: x1, y1: y1}, true
}

func boxWH(m [][]byte) (w, h float64, ok bool) {
	b, ok := boxFromMatch(m)
	if !ok {
		return 0, 0, false
	}
	return math.Abs(b.x1 - b.x0), math.Abs(b.y1 - b.y0), true
}

func pageBoxFromObj(obj []byte) (pageBox, int, bool) {
	var b pageBox
	ok := false
	if m := cropBoxRe.FindSubmatch(obj); len(m) == 5 {
		b, ok = boxFromMatch(m)
	}
	if !ok {
		if m := mediaBoxRe.FindSubmatch(obj); len(m) == 5 {
			b, ok = boxFromMatch(m)
		}
	}
	if !ok {
		return pageBox{}, 0, false
	}
	rot := 0
	if m := rotateRe.FindSubmatch(obj); len(m) == 2 {
		rot, _ = strconv.Atoi(string(m[1]))
		rot = ((rot % 360) + 360) % 360
	}
	return b, rot, true
}

func (b pageBox) viewportSize(rotate int) (w, h float64) {
	w, h = math.Abs(b.x1-b.x0), math.Abs(b.y1-b.y0)
	if rotate == 90 || rotate == 270 {
		return h, w
	}
	return w, h
}

// toViewport maps a PDF user-space point onto the pdf.js canvas at scale 1
// (CropBox/MediaBox origin, /Rotate, and the canvas Y-flip).
func (b pageBox) toViewport(x, y float64, rotate int) (float64, float64) {
	xMin, yMin, xMax, yMax := b.x0, b.y0, b.x1, b.y1
	if xMax < xMin {
		xMin, xMax = xMax, xMin
	}
	if yMax < yMin {
		yMin, yMax = yMax, yMin
	}
	centerX := (xMax + xMin) / 2
	centerY := (yMax + yMin) / 2
	rotate = ((rotate % 360) + 360) % 360
	var rotateA, rotateB, rotateC, rotateD float64
	switch rotate {
	case 180:
		rotateA, rotateB, rotateC, rotateD = -1, 0, 0, 1
	case 90:
		rotateA, rotateB, rotateC, rotateD = 0, 1, 1, 0
	case 270:
		rotateA, rotateB, rotateC, rotateD = 0, -1, -1, 0
	default:
		rotateA, rotateB, rotateC, rotateD = 1, 0, 0, -1
	}
	var offsetCanvasX, offsetCanvasY float64
	if rotateA == 0 {
		offsetCanvasX = math.Abs(centerY - yMin)
		offsetCanvasY = math.Abs(centerX - xMin)
	} else {
		offsetCanvasX = math.Abs(centerX - xMin)
		offsetCanvasY = math.Abs(centerY - yMin)
	}
	tx := offsetCanvasX - rotateA*centerX - rotateC*centerY
	ty := offsetCanvasY - rotateB*centerX - rotateD*centerY
	return rotateA*x + rotateC*y + tx, rotateB*x + rotateD*y + ty
}

func splitPages(pdf []byte) ([]pdfPage, error) {
	// Prefer explicit page objects; fall back to every stream if none found.
	objs := allPDFObjects(pdf)
	var pages []pdfPage
	for _, obj := range objs {
		if !isPageObject(obj) {
			continue
		}
		w, h := 0.0, 0.0
		if m := cropBoxRe.FindSubmatch(obj); len(m) == 5 {
			w, h, _ = boxWH(m)
		} else if m := mediaBoxRe.FindSubmatch(obj); len(m) == 5 {
			w, h, _ = boxWH(m)
		}
		if rot := rotateRe.FindSubmatch(obj); len(rot) == 2 {
			r, _ := strconv.Atoi(string(rot[1]))
			r = ((r % 360) + 360) % 360
			if r == 90 || r == 270 {
				w, h = h, w
			}
		}
		var content []byte
		for _, sm := range streamRe.FindAllSubmatch(obj, -1) {
			content = append(content, inflateMaybe(sm[1])...)
			content = append(content, '\n')
		}
		pages = append(pages, pdfPage{w: w, h: h, content: content})
	}
	if len(pages) > 0 {
		return pages, nil
	}
	// Flattened / single-object drawings: treat each inflated stream as a page.
	m := cropBoxRe.FindSubmatch(pdf)
	if len(m) != 5 {
		m = mediaBoxRe.FindSubmatch(pdf)
	}
	if len(m) == 5 {
		w, h, ok := boxWH(m)
		if !ok {
			return nil, nil
		}
		var all []byte
		for _, sm := range streamRe.FindAllSubmatch(pdf, -1) {
			all = append(all, inflateMaybe(sm[1])...)
			all = append(all, '\n')
		}
		if len(all) > 0 {
			return []pdfPage{{w: w, h: h, content: all}}, nil
		}
	}
	return nil, nil
}

func splitObjects(pdf []byte) [][]byte {
	parts := bytes.Split(pdf, []byte("endobj"))
	out := make([][]byte, 0, len(parts))
	for _, p := range parts {
		out = append(out, p)
	}
	return out
}

func allPDFObjects(pdf []byte) [][]byte {
	objs := splitObjects(pdf)
	extra := objectsFromPDFObjStms(pdf)
	if len(extra) == 0 {
		return objs
	}
	return append(objs, extra...)
}

var (
	pdfNRe     = regexp.MustCompile(`/N\s+(\d+)`)
	pdfFirstRe = regexp.MustCompile(`/First\s+(\d+)`)
	pdfLenRe   = regexp.MustCompile(`/Length\s+(\d+)`)
)

func pdfDictInt(obj []byte, re *regexp.Regexp) int {
	m := re.FindSubmatch(obj)
	if len(m) != 2 {
		return 0
	}
	n, _ := strconv.Atoi(string(m[1]))
	return n
}

func streamPayload(obj []byte) []byte {
	i := bytes.Index(obj, []byte("stream"))
	if i < 0 {
		return nil
	}
	rest := obj[i+6:]
	if len(rest) > 0 && rest[0] == '\r' {
		rest = rest[1:]
	}
	if len(rest) > 0 && rest[0] == '\n' {
		rest = rest[1:]
	}
	if n := pdfDictInt(obj, pdfLenRe); n > 0 && n <= len(rest) {
		return rest[:n]
	}
	if j := bytes.Index(rest, []byte("endstream")); j >= 0 {
		return bytes.TrimRight(rest[:j], "\r\n")
	}
	return rest
}

func lastObjHeaderBefore(pdf []byte, pos int) int {
	start := 0
	if pos > 8192 {
		start = pos - 8192
	}
	locs := objHeadRe.FindAllIndex(pdf[start:pos], -1)
	if len(locs) == 0 {
		return -1
	}
	return start + locs[len(locs)-1][0]
}

// objectsFromPDFObjStms walks the raw file for /ObjStm dictionaries so page
// objects survive even when "endobj" appears inside compressed stream bytes.
func objectsFromPDFObjStms(pdf []byte) [][]byte {
	var out [][]byte
	offset := 0
	for {
		rel := bytes.Index(pdf[offset:], []byte("/ObjStm"))
		if rel < 0 {
			break
		}
		abs := offset + rel
		objStart := lastObjHeaderBefore(pdf, abs)
		if objStart < 0 {
			offset = abs + 7
			continue
		}
		streamAt := bytes.Index(pdf[abs:], []byte("stream"))
		if streamAt < 0 {
			offset = abs + 7
			continue
		}
		streamAt += abs
		length := pdfDictInt(pdf[objStart:streamAt], pdfLenRe)
		end := streamAt + 8 + length + 32
		if length <= 0 {
			if es := bytes.Index(pdf[streamAt:], []byte("endstream")); es >= 0 {
				end = streamAt + es + 9
			} else {
				end = len(pdf)
			}
		}
		if end > len(pdf) {
			end = len(pdf)
		}
		out = append(out, objectsFromObjStm(pdf[objStart:end])...)
		offset = end
		if offset <= abs {
			offset = abs + 7
		}
	}
	return out
}

// objectsFromObjStm unpacks a compressed object stream into synthetic
// "N 0 obj ... endobj" buffers so page dictionaries stored only in /ObjStm
// are visible to the rest of the regex parser.
func objectsFromObjStm(obj []byte) [][]byte {
	if !bytes.Contains(obj, []byte("/ObjStm")) {
		return nil
	}
	n := pdfDictInt(obj, pdfNRe)
	first := pdfDictInt(obj, pdfFirstRe)
	body := inflateMaybe(streamPayload(obj))
	if n <= 0 || first <= 0 || first > len(body) {
		return nil
	}
	fields := strings.Fields(string(body[:first]))
	type pair struct{ id, off int }
	pairs := make([]pair, 0, n)
	for i := 0; i+1 < len(fields) && len(pairs) < n; i += 2 {
		id, err1 := strconv.Atoi(fields[i])
		off, err2 := strconv.Atoi(fields[i+1])
		if err1 != nil || err2 != nil {
			continue
		}
		pairs = append(pairs, pair{id, off})
	}
	out := make([][]byte, 0, len(pairs))
	for i, p := range pairs {
		start := first + p.off
		end := len(body)
		if i+1 < len(pairs) {
			end = first + pairs[i+1].off
		}
		if start < first || start > len(body) || start > end {
			continue
		}
		if end > len(body) {
			end = len(body)
		}
		chunk := bytes.TrimSpace(body[start:end])
		if len(chunk) == 0 {
			continue
		}
		wrapped := make([]byte, 0, 16+len(chunk)+8)
		wrapped = append(wrapped, []byte(strconv.Itoa(p.id)+" 0 obj\n")...)
		wrapped = append(wrapped, chunk...)
		wrapped = append(wrapped, []byte("\nendobj")...)
		out = append(out, wrapped)
	}
	return out
}

func inflateMaybe(raw []byte) []byte {
	raw = bytes.TrimRight(raw, "\r\n")
	r, err := zlib.NewReader(bytes.NewReader(raw))
	if err != nil {
		return raw
	}
	defer r.Close()
	data, err := io.ReadAll(r)
	if len(data) > 0 {
		return data
	}
	if err != nil {
		return raw
	}
	return data
}

func walkContent(content []byte, out *Vectors) {
	toks := tokenize(string(content))
	var nums []float64
	var path [][2]float64
	cx, cy := 0.0, 0.0
	sx, sy := 0.0, 0.0
	started := false

	flushStroke := func() {
		if len(path) < 2 {
			if len(path) == 1 {
				addPoint(out, path[0][0], path[0][1])
			}
			path = path[:0]
			started = false
			return
		}
		out.Stats.RawPathCount++
		for i := 1; i < len(path); i++ {
			addLine(out, path[i-1][0], path[i-1][1], path[i][0], path[i][1])
		}
		path = path[:0]
		started = false
	}
	flushFill := func() {
		if len(path) < 2 {
			path = path[:0]
			started = false
			return
		}
		out.Stats.RawPathCount++
		poly := make([]float64, 0, len(path)*2)
		minX, minY := path[0][0], path[0][1]
		maxX, maxY := minX, minY
		for _, p := range path {
			poly = append(poly, q(p[0]), q(p[1]))
			if p[0] < minX {
				minX = p[0]
			}
			if p[1] < minY {
				minY = p[1]
			}
			if p[0] > maxX {
				maxX = p[0]
			}
			if p[1] > maxY {
				maxY = p[1]
			}
		}
		w, h := maxX-minX, maxY-minY
		area := w * h
		pageArea := out.PageWidthPt * out.PageHeightPt
		skinny := (w > 0 && h > 0) && (math.Min(w, h) <= skinnyThick)
		if pageArea > 0 && area > pageFillFrac*pageArea && !skinny {
			out.Stats.DroppedFillOnly++
		} else {
			out.Fills = append(out.Fills, poly)
			for i := 1; i < len(path); i++ {
				addLine(out, path[i-1][0], path[i-1][1], path[i][0], path[i][1])
			}
			if len(path) >= 3 {
				addLine(out, path[len(path)-1][0], path[len(path)-1][1], path[0][0], path[0][1])
			}
		}
		path = path[:0]
		started = false
	}

	for _, tok := range toks {
		if v, ok := parseNum(tok); ok {
			nums = append(nums, v)
			continue
		}
		switch tok {
		case "m":
			if len(nums) >= 2 {
				cx, cy = nums[len(nums)-2], nums[len(nums)-1]
				sx, sy = cx, cy
				path = append(path[:0], [2]float64{cx, cy})
				started = true
			}
			nums = nums[:0]
		case "l":
			if len(nums) >= 2 {
				cx, cy = nums[len(nums)-2], nums[len(nums)-1]
				path = append(path, [2]float64{cx, cy})
			}
			nums = nums[:0]
		case "c":
			if len(nums) >= 6 {
				x1, y1 := nums[len(nums)-6], nums[len(nums)-5]
				x2, y2 := nums[len(nums)-4], nums[len(nums)-3]
				x3, y3 := nums[len(nums)-2], nums[len(nums)-1]
				addCurve(out, cx, cy, x3, y3)
				addPoint(out, x1, y1)
				addPoint(out, x2, y2)
				cx, cy = x3, y3
				path = append(path, [2]float64{cx, cy})
			}
			nums = nums[:0]
		case "v", "y":
			if len(nums) >= 4 {
				x3, y3 := nums[len(nums)-2], nums[len(nums)-1]
				addCurve(out, cx, cy, x3, y3)
				cx, cy = x3, y3
				path = append(path, [2]float64{cx, cy})
			}
			nums = nums[:0]
		case "h":
			if started {
				path = append(path, [2]float64{sx, sy})
				cx, cy = sx, sy
			}
			nums = nums[:0]
		case "re":
			if len(nums) >= 4 {
				x, y, w, h := nums[len(nums)-4], nums[len(nums)-3], nums[len(nums)-2], nums[len(nums)-1]
				addRect(out, x, y, x+w, y+h)
			}
			nums = nums[:0]
		case "S", "s":
			flushStroke()
			nums = nums[:0]
		case "f", "F", "f*", "B", "B*", "b", "b*":
			flushFill()
			nums = nums[:0]
		case "n":
			path = path[:0]
			started = false
			nums = nums[:0]
		default:
			if isOp(tok) {
				nums = nums[:0]
			}
		}
	}
}

func addLine(out *Vectors, x1, y1, x2, y2 float64) {
	if capped(out) {
		return
	}
	if !intersects(x1, y1, x2, y2, out.PageWidthPt, out.PageHeightPt) {
		out.Stats.DroppedOutside++
		return
	}
	if math.Hypot(x2-x1, y2-y1) < minLen {
		out.Stats.DroppedShort++
		addPoint(out, x1, y1)
		addPoint(out, x2, y2)
		return
	}
	out.Segments.Lines = append(out.Segments.Lines, []float64{q(x1), q(y1), q(x2), q(y2)})
}

func addRect(out *Vectors, x0, y0, x1, y1 float64) {
	if x1 < x0 {
		x0, x1 = x1, x0
	}
	if y1 < y0 {
		y0, y1 = y1, y0
	}
	w, h := x1-x0, y1-y0
	if w < minLen && h < minLen {
		out.Stats.DroppedShort++
		addPoint(out, x0, y0)
		return
	}
	if capped(out) {
		return
	}
	out.Segments.Rects = append(out.Segments.Rects, []float64{q(x0), q(y0), q(x1), q(y1)})
}

func addCurve(out *Vectors, x1, y1, x2, y2 float64) {
	out.Stats.CurvesAsChords++
	addLine(out, x1, y1, x2, y2)
}

func addPoint(out *Vectors, x, y float64) {
	if x < -2 || y < -2 || x > out.PageWidthPt+2 || y > out.PageHeightPt+2 {
		return
	}
	out.Points = append(out.Points, []float64{q(x), q(y)})
}

func capped(out *Vectors) bool {
	n := len(out.Segments.Lines) + len(out.Segments.Rects) + len(out.Segments.Quads) + len(out.Segments.Curves)
	if n >= maxSegments {
		out.Stats.Truncated = true
		return true
	}
	return false
}

func intersects(x1, y1, x2, y2, w, h float64) bool {
	minX, maxX := math.Min(x1, x2), math.Max(x1, x2)
	minY, maxY := math.Min(y1, y2), math.Max(y1, y2)
	return !(maxX < 0 || maxY < 0 || minX > w || minY > h)
}

func q(v float64) float64 {
	return math.Round(v*100) / 100
}

func tokenize(s string) []string {
	var out []string
	i := 0
	for i < len(s) {
		c := s[i]
		if c == '%' {
			if j := strings.IndexByte(s[i:], '\n'); j >= 0 {
				i += j + 1
			} else {
				break
			}
			continue
		}
		if c == '(' {
			i++
			for i < len(s) {
				if s[i] == '\\' {
					i += 2
					continue
				}
				if s[i] == ')' {
					i++
					break
				}
				i++
			}
			continue
		}
		if c == '<' {
			if j := strings.IndexByte(s[i:], '>'); j >= 0 {
				i += j + 1
			} else {
				break
			}
			continue
		}
		if c == '[' {
			i++
			continue
		}
		if c == ']' {
			i++
			continue
		}
		if isSpace(c) {
			i++
			continue
		}
		j := i + 1
		for j < len(s) && !isSpace(s[j]) && s[j] != '[' && s[j] != ']' && s[j] != '(' && s[j] != '<' && s[j] != '%' {
			j++
		}
		out = append(out, s[i:j])
		i = j
	}
	return out
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\n' || c == '\r' || c == '\t' || c == '\f' || c == 0
}

func parseNum(s string) (float64, bool) {
	if s == "" {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	return v, err == nil
}

func isOp(s string) bool {
	if s == "" {
		return false
	}
	c := s[0]
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '\'' || c == '"'
}
