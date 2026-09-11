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

func boxWH(m [][]byte) (w, h float64, ok bool) {
	if len(m) != 5 {
		return 0, 0, false
	}
	x0, _ := strconv.ParseFloat(string(m[1]), 64)
	y0, _ := strconv.ParseFloat(string(m[2]), 64)
	x1, _ := strconv.ParseFloat(string(m[3]), 64)
	y1, _ := strconv.ParseFloat(string(m[4]), 64)
	w = math.Abs(x1 - x0)
	h = math.Abs(y1 - y0)
	return w, h, w > 0 && h > 0
}

func splitPages(pdf []byte) ([]pdfPage, error) {
	// Prefer explicit page objects; fall back to every stream if none found.
	objs := splitObjects(pdf)
	var pages []pdfPage
	for _, obj := range objs {
		if !pageObjRe.Match(obj) {
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

func inflateMaybe(raw []byte) []byte {
	raw = bytes.TrimRight(raw, "\r\n")
	r, err := zlib.NewReader(bytes.NewReader(raw))
	if err != nil {
		return raw
	}
	defer r.Close()
	data, err := io.ReadAll(r)
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
