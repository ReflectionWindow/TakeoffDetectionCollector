package coco

import (
	"testing"

	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/coords"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/store"
)

func TestParseAndExport(t *testing.T) {
	raw := []byte(`{
	  "images":[{"id":1,"file_name":"page_0000.png","width":3600,"height":2700,"page_index":0}],
	  "categories":[{"id":4,"name":"CW"}],
	  "annotations":[{"id":1,"image_id":1,"category_id":4,"bbox":[100,200,30,40],"page_index":0,"poc_class":"CW"}]
	}`)
	imp, err := Parse(raw, "uih")
	if err != nil {
		t.Fatal(err)
	}
	if len(imp.Pages) != 1 || len(imp.ByPage[0]) != 1 {
		t.Fatalf("pages=%d boxes=%d", len(imp.Pages), len(imp.ByPage[0]))
	}
	box := imp.ByPage[0][0]
	if box.Class != "CW" || box.Origin != "imported" {
		t.Fatalf("box %+v", box)
	}
	want := coords.BBoxPx75ToPt([4]float64{100, 200, 30, 40})
	if box.BBoxPt != want {
		t.Fatalf("pt %v want %v", box.BBoxPt, want)
	}
	if len(box.PolygonPt) != 4 || len(box.PolygonPx75) != 4 {
		t.Fatalf("polygon pt=%d px=%d", len(box.PolygonPt), len(box.PolygonPx75))
	}
	out, err := Export(store.Job{ID: "1", Slug: "uih"}, imp.Pages, imp.ByPage)
	if err != nil {
		t.Fatal(err)
	}
	back, err := Parse(out, "uih")
	if err != nil {
		t.Fatal(err)
	}
	if back.ByPage[0][0].Class != "CW" {
		t.Fatal(back.ByPage[0][0])
	}
	if len(back.ByPage[0][0].PolygonPx75) < 3 {
		t.Fatal("export dropped polygon")
	}
}

func TestParseSegmentation(t *testing.T) {
	raw := []byte(`{
	  "images":[{"id":1,"file_name":"page_0000.png","width":3600,"height":2700,"page_index":0}],
	  "categories":[{"id":4,"name":"CW"}],
	  "annotations":[{"id":1,"image_id":1,"category_id":4,"bbox":[100,200,30,40],"segmentation":[[100,200,140,205,128,240,100,238,100,200]],"page_index":0,"poc_class":"CW"}]
	}`)
	imp, err := Parse(raw, "uih")
	if err != nil {
		t.Fatal(err)
	}
	poly := imp.ByPage[0][0].PolygonPx75
	if len(poly) != 4 {
		t.Fatalf("want 4 verts after dropping close, got %d %#v", len(poly), poly)
	}
	if poly[0] != [2]float64{100, 200} || poly[2] != [2]float64{128, 240} {
		t.Fatalf("verts %#v", poly)
	}
}
