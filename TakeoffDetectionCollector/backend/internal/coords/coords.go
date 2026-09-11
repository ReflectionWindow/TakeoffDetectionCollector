package coords

// ImportDPI is the raster DPI of the imported COCO dataset.
const ImportDPI = 75

// PtPerInch is the PDF user-space unit.
const PtPerInch = 72.0

// Px75ToPt converts a 75-DPI pixel length into PDF points.
func Px75ToPt(px float64) float64 {
	return px * PtPerInch / ImportDPI
}

// PtToPx75 converts PDF points back into 75-DPI pixels for COCO export.
func PtToPx75(pt float64) float64 {
	return pt * ImportDPI / PtPerInch
}

// BBoxPx75ToPt converts COCO [x, y, w, h] pixels into PDF-pt [x, y, w, h].
func BBoxPx75ToPt(bbox [4]float64) [4]float64 {
	return [4]float64{
		Px75ToPt(bbox[0]),
		Px75ToPt(bbox[1]),
		Px75ToPt(bbox[2]),
		Px75ToPt(bbox[3]),
	}
}

// BBoxPtToPx75 converts PDF-pt [x, y, w, h] back to 75-DPI COCO pixels.
func BBoxPtToPx75(bbox [4]float64) [4]float64 {
	return [4]float64{
		PtToPx75(bbox[0]),
		PtToPx75(bbox[1]),
		PtToPx75(bbox[2]),
		PtToPx75(bbox[3]),
	}
}

// PagePtFromPx75 returns page width/height in PDF points from a 75-DPI raster.
func PagePtFromPx75(widthPx, heightPx int) (wPt, hPt float64) {
	return Px75ToPt(float64(widthPx)), Px75ToPt(float64(heightPx))
}

// QuadFromBBox turns COCO [x, y, w, h] into a closed-open 4-vertex polygon.
func QuadFromBBox(bbox [4]float64) [][2]float64 {
	x, y, w, h := bbox[0], bbox[1], bbox[2], bbox[3]
	return [][2]float64{{x, y}, {x + w, y}, {x + w, y + h}, {x, y + h}}
}

// BBoxFromPoly is the axis-aligned [x, y, w, h] around a polygon.
func BBoxFromPoly(poly [][2]float64) [4]float64 {
	if len(poly) == 0 {
		return [4]float64{}
	}
	minX, minY, maxX, maxY := poly[0][0], poly[0][1], poly[0][0], poly[0][1]
	for _, p := range poly[1:] {
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
	return [4]float64{minX, minY, maxX - minX, maxY - minY}
}

// PolyPx75ToPt converts polygon vertices from 75-DPI pixels to PDF points.
func PolyPx75ToPt(poly [][2]float64) [][2]float64 {
	out := make([][2]float64, len(poly))
	for i, p := range poly {
		out[i] = [2]float64{Px75ToPt(p[0]), Px75ToPt(p[1])}
	}
	return out
}

// PolyPtToPx75 converts polygon vertices from PDF points to 75-DPI pixels.
func PolyPtToPx75(poly [][2]float64) [][2]float64 {
	out := make([][2]float64, len(poly))
	for i, p := range poly {
		out[i] = [2]float64{PtToPx75(p[0]), PtToPx75(p[1])}
	}
	return out
}

// NormalizePoly drops a duplicate closing vertex and rejects short rings.
func NormalizePoly(poly [][2]float64) [][2]float64 {
	if len(poly) >= 2 {
		a, b := poly[0], poly[len(poly)-1]
		if almost(a[0], b[0]) && almost(a[1], b[1]) {
			poly = poly[:len(poly)-1]
		}
	}
	if len(poly) < 3 {
		return nil
	}
	out := make([][2]float64, len(poly))
	copy(out, poly)
	return out
}

// FlatToPoly reads a COCO segmentation ring [x,y,x,y,...].
func FlatToPoly(flat []float64) [][2]float64 {
	if len(flat) < 6 {
		return nil
	}
	n := len(flat) / 2
	poly := make([][2]float64, 0, n)
	for i := 0; i+1 < len(flat); i += 2 {
		poly = append(poly, [2]float64{flat[i], flat[i+1]})
	}
	return NormalizePoly(poly)
}

// PolyToFlat writes a COCO segmentation ring, repeating the first vertex.
func PolyToFlat(poly [][2]float64) []float64 {
	if len(poly) < 3 {
		return nil
	}
	flat := make([]float64, 0, len(poly)*2+2)
	for _, p := range poly {
		flat = append(flat, p[0], p[1])
	}
	flat = append(flat, poly[0][0], poly[0][1])
	return flat
}

func almost(a, b float64) bool {
	d := a - b
	return d < 1e-6 && d > -1e-6
}

// SimilarPageSize is true when two page sizes describe the same sheet, including
// a 90° swap. Used so a MediaBox extract cannot replace the 75-DPI implied size
// with a letter default or a different crop.
func SimilarPageSize(aw, ah, bw, bh float64) bool {
	same := func(a, b float64) bool {
		if a <= 0 || b <= 0 {
			return false
		}
		r := a / b
		return r > 0.92 && r < 1.09
	}
	return (same(aw, bw) && same(ah, bh)) || (same(aw, bh) && same(ah, bw))
}

// FillBoxPolys derives missing polygon/bbox fields so annotations are always polygons.
func FillBoxPolys(polyPt, polyPx [][2]float64, bboxPt, bboxPx [4]float64) (pt, px [][2]float64, bPt, bPx [4]float64) {
	pt = NormalizePoly(polyPt)
	px = NormalizePoly(polyPx)
	if pt == nil && px != nil {
		pt = PolyPx75ToPt(px)
	}
	if px == nil && pt != nil {
		px = PolyPtToPx75(pt)
	}
	if pt == nil && bboxPt != [4]float64{} {
		pt = QuadFromBBox(bboxPt)
	}
	if px == nil && bboxPx != [4]float64{} {
		px = QuadFromBBox(bboxPx)
	}
	if pt == nil && bboxPx != [4]float64{} {
		pt = PolyPx75ToPt(QuadFromBBox(bboxPx))
	}
	if px == nil && bboxPt != [4]float64{} {
		px = PolyPtToPx75(QuadFromBBox(bboxPt))
	}
	if bboxPx != [4]float64{} {
		bPx = bboxPx
	} else if px != nil {
		bPx = BBoxFromPoly(px)
	}
	if bboxPt != [4]float64{} {
		bPt = bboxPt
	} else if bboxPx != [4]float64{} {
		bPt = BBoxPx75ToPt(bboxPx)
	} else if pt != nil {
		bPt = BBoxFromPoly(pt)
	}
	return pt, px, bPt, bPx
}
