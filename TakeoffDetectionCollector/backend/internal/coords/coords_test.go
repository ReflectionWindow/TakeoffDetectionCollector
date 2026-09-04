package coords

import "testing"

func TestRoundTrip(t *testing.T) {
	in := [4]float64{2864.22, 1234.4, 32.41, 342.15}
	pt := BBoxPx75ToPt(in)
	back := BBoxPtToPx75(pt)
	for i := range in {
		if diff := back[i] - in[i]; diff > 1e-9 || diff < -1e-9 {
			t.Fatalf("round trip %d: got %v want %v", i, back[i], in[i])
		}
	}
}

func TestPageSize(t *testing.T) {
	w, h := PagePtFromPx75(3600, 2700)
	if w != 3456 || h != 2592 {
		t.Fatalf("page pt = %v x %v", w, h)
	}
}
