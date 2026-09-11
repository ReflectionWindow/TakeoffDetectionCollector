package geom

import "testing"

func TestMatchClassContentsThenSubj(t *testing.T) {
	got, ok := MatchClass("CW\narea 12", "")
	if !ok || got != "CW" {
		t.Fatalf("contents %q %v", got, ok)
	}
	got, ok = MatchClass("not-a-class", "louver")
	if !ok || got != "LOUVER" {
		t.Fatalf("subj %q %v", got, ok)
	}
	if _, ok := MatchClass("NOPE", "also-no"); ok {
		t.Fatal("unknown should skip")
	}
	got, ok = MatchClass("SF/CW", "")
	if !ok || got != "SF/CW" {
		t.Fatalf("slash class %q", got)
	}
}

func TestExtractMarkupsPolygonSquareAndSkipUnknown(t *testing.T) {
	pdf := []byte(
		"%PDF-1.1\n" +
			"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
			"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
			"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Annots[4 0 R 5 0 R 6 0 R]>>endobj\n" +
			"4 0 obj<</Type/Annot/Subtype/Polygon/Contents(CW)/Vertices[100 100 200 100 200 200 100 200]>>endobj\n" +
			"5 0 obj<</Type/Annot/Subtype/Square/Subj(SF)/Rect[10 10 40 50]>>endobj\n" +
			"6 0 obj<</Type/Annot/Subtype/Polygon/Contents(NOPE)/Vertices[1 1 2 1 2 2]>>endobj\n" +
			"trailer<</Root 1 0 R>>\n%%EOF\n",
	)
	pages := ExtractMarkups(pdf)
	if len(pages) != 1 {
		t.Fatalf("pages=%d", len(pages))
	}
	if pages[0].WidthPt != 612 || pages[0].HeightPt != 792 {
		t.Fatalf("size %v x %v", pages[0].WidthPt, pages[0].HeightPt)
	}
	if len(pages[0].Markups) != 2 {
		t.Fatalf("markups=%d %#v", len(pages[0].Markups), pages[0].Markups)
	}
	cw := pages[0].Markups[0]
	if cw.Class != "CW" || len(cw.PolyPt) != 4 {
		t.Fatalf("cw %#v", cw)
	}
	// PDF (100,100) y-up → y-down 792-100=692
	if cw.PolyPt[0] != [2]float64{100, 692} || cw.PolyPt[2] != [2]float64{200, 592} {
		t.Fatalf("cw poly %#v", cw.PolyPt)
	}
	sf := pages[0].Markups[1]
	if sf.Class != "SF" || len(sf.PolyPt) != 4 {
		t.Fatalf("sf %#v", sf)
	}
	if sf.PolyPt[0] != [2]float64{10, 742} || sf.PolyPt[2] != [2]float64{40, 782} {
		t.Fatalf("sf poly %#v", sf.PolyPt)
	}
}
