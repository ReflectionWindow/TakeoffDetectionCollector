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

func TestSimilarPageSize(t *testing.T) {
	if !SimilarPageSize(3456, 2592, 3456, 2592) {
		t.Fatal("identical")
	}
	if !SimilarPageSize(3456, 2592, 2592, 3456) {
		t.Fatal("rotated")
	}
	if SimilarPageSize(3456, 2592, 612, 792) {
		t.Fatal("letter default must not replace a sheet")
	}
}

func TestPolyFromBBoxAndFlat(t *testing.T) {
	q := QuadFromBBox([4]float64{10, 20, 30, 40})
	if len(q) != 4 || q[2] != [2]float64{40, 60} {
		t.Fatalf("quad %#v", q)
	}
	flat := PolyToFlat(q)
	back := FlatToPoly(flat)
	if len(back) != 4 {
		t.Fatalf("flat round trip %v", back)
	}
	bb := BBoxFromPoly(q)
	if bb != [4]float64{10, 20, 30, 40} {
		t.Fatalf("bbox %v", bb)
	}
}
