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

func TestPageSizePrefersCropBoxAndRotation(t *testing.T) {
	pdf := []byte("%PDF-1.1\n3 0 obj<</Type/Page/MediaBox[0 0 2736 1872]/CropBox[0 0 2592 1728]/Rotate 90>>endobj\n%%EOF\n")
	pages, err := splitPages(pdf)
	if err != nil || len(pages) != 1 {
		t.Fatalf("pages=%d err=%v", len(pages), err)
	}
	// CropBox 2592×1728, rotated 90 → 1728×2592.
	if pages[0].w != 1728 || pages[0].h != 2592 {
		t.Fatalf("size %v x %v", pages[0].w, pages[0].h)
	}
}
