package geom

import "testing"

func TestWalkRectAndFill(t *testing.T) {
	content := []byte("0 0 100 40 re S 10 10 m 20 10 l 20 20 l 10 20 l h f 5 5 m 5 5 l S")
	out := Vectors{PageWidthPt: 200, PageHeightPt: 200}
	walkContent(content, &out)
	if len(out.Segments.Rects) != 1 {
		t.Fatalf("rects=%d", len(out.Segments.Rects))
	}
	if len(out.Fills) == 0 {
		t.Fatal("expected fill outline")
	}
	if len(out.Points) == 0 {
		t.Fatal("expected isolated points from short segment")
	}
}
