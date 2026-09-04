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
