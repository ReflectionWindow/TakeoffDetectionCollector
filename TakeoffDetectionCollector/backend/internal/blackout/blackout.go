package blackout

// Region is a normalized [0,1] page-fraction rectangle (top-left, y-down).
type Region struct {
	X1 float64 `json:"x1"`
	Y1 float64 `json:"y1"`
	X2 float64 `json:"x2"`
	Y2 float64 `json:"y2"`
}

func Normalize(x1, y1, x2, y2, width, height float64) (Region, bool) {
	if !(width > 0 && height > 0) {
		return Region{}, false
	}
	if x2 < x1 {
		x1, x2 = x2, x1
	}
	if y2 < y1 {
		y1, y2 = y2, y1
	}
	r := Region{
		X1: clamp01(x1 / width),
		Y1: clamp01(y1 / height),
		X2: clamp01(x2 / width),
		Y2: clamp01(y2 / height),
	}
	if !(r.X2 > r.X1 && r.Y2 > r.Y1) {
		return Region{}, false
	}
	return r, true
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}
