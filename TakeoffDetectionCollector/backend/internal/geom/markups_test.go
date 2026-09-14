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

func TestMatchClassAbstractLabels(t *testing.T) {
	cases := []struct {
		contents, subj, want string
	}{
		{"RWW 7000 - PUNCHED WINDOW", "Area Measurement", "PW"},
		{"RWW 7000 - PUNCHED WINDOW WALL", "Area Measurement", "WW"},
		{"KAWNEER OR EQUAL - STOREFRONT", "Area Measurement", "SF"},
		{"RWW 9500 - WINDOW WALL", "", "WW"},
		{"310", "PUNCH WINDOW", "PW"},
		{"Awning Vent\n798", "Hopper Vent", "PW"},
		{"RWW 7000XL - CW", "", "CW"},
		{"SFD - SINGLE", "", "SF"},
		{"KAWNEER CLEARWALL", "", "CW"},
		{"Metal Panel", "", "METAL_PANEL"},
		{"RWW - 7000 PW", "", "PW"},
		{"SEC-MP", "", "METAL_PANEL"},
		{"KAWNEER - STOREFRONT", "", "SF"},
		{"", "Area Measurement", ""},
		{"7'-4\"", "Rectangle", ""},
	}
	for _, c := range cases {
		got, ok := MatchClass(c.contents, c.subj)
		if c.want == "" {
			if ok {
				t.Fatalf("%q / %q: got %q, want skip", c.contents, c.subj, got)
			}
			continue
		}
		if !ok || got != c.want {
			t.Fatalf("%q / %q: got %q %v want %s", c.contents, c.subj, got, ok, c.want)
		}
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
	if sf.PolyPt[0] != [2]float64{10, 782} || sf.PolyPt[2] != [2]float64{40, 742} {
		t.Fatalf("sf poly %#v", sf.PolyPt)
	}
}

func TestExtractMarkupsRotate90MatchesPdfjs(t *testing.T) {
	pdf := []byte(
		"%PDF-1.1\n" +
			"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
			"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
			"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 3024 2160]/Rotate 90/Annots[4 0 R]>>endobj\n" +
			"4 0 obj<</Type/Annot/Subtype/Polygon/Contents(PW)/Vertices[2536.912 861.2381 2536.912 1021.917 2635.926 1021.922 2635.925 861.2424]>>endobj\n" +
			"trailer<</Root 1 0 R>>\n%%EOF\n",
	)
	pages := ExtractMarkups(pdf)
	if len(pages) != 1 || pages[0].WidthPt != 2160 || pages[0].HeightPt != 3024 {
		t.Fatalf("page %#v", pages)
	}
	if len(pages[0].Markups) != 1 {
		t.Fatalf("markups %#v", pages[0].Markups)
	}
	poly := pages[0].Markups[0].PolyPt
	// pdf.js 90°: (x,y) → (y, x). Bluebeam's 0.005pt wobble is squared up.
	if poly[0] != [2]float64{861.2381, 2536.912} || poly[1] != [2]float64{1021.922, 2536.912} {
		t.Fatalf("poly %#v", poly)
	}
	if poly[2] != [2]float64{1021.922, 2635.926} || poly[3] != [2]float64{861.2381, 2635.926} {
		t.Fatalf("poly %#v", poly)
	}
}
