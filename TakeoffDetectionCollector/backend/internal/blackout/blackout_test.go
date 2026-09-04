package blackout

import "testing"

func TestNormalize(t *testing.T) {
	r, ok := Normalize(100, 50, 300, 200, 1000, 500)
	if !ok {
		t.Fatal("expected region")
	}
	if r.X1 != 0.1 || r.Y1 != 0.1 || r.X2 != 0.3 || r.Y2 != 0.4 {
		t.Fatalf("got %+v", r)
	}
}
