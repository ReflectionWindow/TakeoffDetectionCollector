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

func TestParseBlackoutsAndPageFileName(t *testing.T) {
	raw := []byte(`{
	  "images":[
	    {"id":0,"file_name":"page_0005.png","width":1000,"height":500},
	    {"id":1,"file_name":"data_v2_coco_job_coarse_images_page_0001.png","width":2000,"height":1000}
	  ],
	  "categories":[{"id":1,"name":"CW"},{"id":4,"name":"blackout"}],
	  "annotations":[
	    {"id":1,"image_id":0,"category_id":1,"bbox":[100,50,20,10]},
	    {"id":2,"image_id":0,"category_id":4,"bbox":[100,50,300,150]},
	    {"id":3,"image_id":1,"category_id":4,"bbox":[0,0,1000,200]}
	  ]
	}`)
	imp, err := Parse(raw, "demo")
	if err != nil {
		t.Fatal(err)
	}
	if len(imp.Pages) != 2 {
		t.Fatalf("pages=%d", len(imp.Pages))
	}
	if len(imp.ByPage[5]) != 1 || imp.ByPage[5][0].Class != "CW" {
		t.Fatalf("opening boxes %+v", imp.ByPage)
	}
	if len(imp.ByPage[1]) != 0 {
		t.Fatalf("blackout leaked into boxes %+v", imp.ByPage[1])
	}
	r5 := imp.Blackouts[5]
	if len(r5) != 1 || r5[0].X1 != 0.1 || r5[0].Y1 != 0.1 || r5[0].X2 != 0.4 || r5[0].Y2 != 0.4 {
		t.Fatalf("page 5 blackouts %+v", r5)
	}
	r1 := imp.Blackouts[1]
	if len(r1) != 1 || r1[0].X1 != 0 || r1[0].Y1 != 0 || r1[0].X2 != 0.5 || r1[0].Y2 != 0.2 {
		t.Fatalf("page 1 blackouts %+v", r1)
	}
}

func TestSlugFromAnnotPath(t *testing.T) {
	got := SlugFromAnnotPath("review/verve_south_miami/train/_annotations.coco.json")
	if got != "verve_south_miami" {
		t.Fatal(got)
	}
	got = SlugFromAnnotPath("coco/uih/coarse/_annotations.coco.json")
	if got != "uih" {
		t.Fatal(got)
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
