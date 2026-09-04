package coco

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/coords"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/store"
)

type File struct {
	Images      []Image      `json:"images"`
	Categories  []Category   `json:"categories"`
	Annotations []Annotation `json:"annotations"`
}

type Image struct {
	ID        int    `json:"id"`
	FileName  string `json:"file_name"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	PageIndex int    `json:"page_index"`
}

type Category struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

type Annotation struct {
	ID         int       `json:"id"`
	ImageID    int       `json:"image_id"`
	CategoryID int       `json:"category_id"`
	BBox       []float64 `json:"bbox"`
	Area       float64   `json:"area"`
	IsCrowd    int       `json:"iscrowd"`
	PageIndex  int       `json:"page_index"`
	PocClass   string    `json:"poc_class,omitempty"`
}

type JobImport struct {
	Slug   string
	Title  string
	Pages  []store.Page
	ByPage map[int][]store.Box
	Raw    []byte
}

func LoadFile(path string) (File, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return File{}, err
	}
	var f File
	if err := json.Unmarshal(data, &f); err != nil {
		return File{}, err
	}
	return f, nil
}

func Parse(data []byte, slug string) (JobImport, error) {
	var f File
	if err := json.Unmarshal(data, &f); err != nil {
		return JobImport{}, err
	}
	cat := map[int]string{}
	for _, c := range f.Categories {
		cat[c.ID] = c.Name
	}
	img := map[int]Image{}
	pages := map[int]store.Page{}
	for _, im := range f.Images {
		img[im.ID] = im
		wPt, hPt := coords.PagePtFromPx75(im.Width, im.Height)
		pages[im.PageIndex] = store.Page{
			PageIndex:  im.PageIndex,
			PDFPage:    im.PageIndex + 1,
			WidthPx75:  im.Width,
			HeightPx75: im.Height,
			WidthPt:    wPt,
			HeightPt:   hPt,
			RasterDPI:  coords.ImportDPI,
		}
	}
	byPage := map[int][]store.Box{}
	for _, a := range f.Annotations {
		if len(a.BBox) < 4 {
			continue
		}
		im, ok := img[a.ImageID]
		pageIndex := a.PageIndex
		if ok {
			pageIndex = im.PageIndex
		}
		class := a.PocClass
		if class == "" {
			class = cat[a.CategoryID]
		}
		bbox := [4]float64{a.BBox[0], a.BBox[1], a.BBox[2], a.BBox[3]}
		byPage[pageIndex] = append(byPage[pageIndex], store.Box{
			ID:       fmt.Sprintf("coco-%d", a.ID),
			Class:    class,
			Origin:   "imported",
			BBoxPx75: bbox,
			BBoxPt:   coords.BBoxPx75ToPt(bbox),
			Edited:   false,
			CocoID:   a.ID,
			Category: a.CategoryID,
		})
	}
	pageList := make([]store.Page, 0, len(pages))
	for _, p := range pages {
		pageList = append(pageList, p)
	}
	sort.Slice(pageList, func(i, j int) bool { return pageList[i].PageIndex < pageList[j].PageIndex })
	title := strings.ReplaceAll(slug, "_", " ")
	return JobImport{Slug: slug, Title: title, Pages: pageList, ByPage: byPage, Raw: data}, nil
}

func DiscoverJobs(root string) ([]string, error) {
	var out []string
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		p := filepath.Join(root, e.Name(), "coarse", "_annotations.coco.json")
		if _, err := os.Stat(p); err == nil {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out, nil
}

func LoadJobDir(root, slug string) (JobImport, error) {
	path := filepath.Join(root, slug, "coarse", "_annotations.coco.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return JobImport{}, err
	}
	return Parse(data, slug)
}

func Export(job store.Job, pages []store.Page, boxesByPage map[int][]store.Box) ([]byte, error) {
	cats := []Category{
		{ID: 1, Name: "PW"},
		{ID: 2, Name: "SF"},
		{ID: 3, Name: "WW"},
		{ID: 4, Name: "CW"},
		{ID: 5, Name: "SF/CW"},
		{ID: 6, Name: "LOUVER"},
		{ID: 7, Name: "METAL_PANEL"},
		{ID: 8, Name: "LOUVER_SOFT"},
		{ID: 9, Name: "METAL_PANEL_SOFT"},
	}
	catID := map[string]int{}
	for _, c := range cats {
		catID[c.Name] = c.ID
	}
	var images []Image
	var anns []Annotation
	annID := 1
	for _, p := range pages {
		images = append(images, Image{
			ID:        p.PageIndex + 1,
			FileName:  fmt.Sprintf("page_%04d.png", p.PageIndex),
			Width:     p.WidthPx75,
			Height:    p.HeightPx75,
			PageIndex: p.PageIndex,
		})
		for _, b := range boxesByPage[p.PageIndex] {
			px := b.BBoxPx75
			if b.Edited || (px[2] == 0 && px[3] == 0) {
				px = coords.BBoxPtToPx75(b.BBoxPt)
			}
			id := catID[b.Class]
			if id == 0 {
				id = 3
			}
			anns = append(anns, Annotation{
				ID:         annID,
				ImageID:    p.PageIndex + 1,
				CategoryID: id,
				BBox:       []float64{px[0], px[1], px[2], px[3]},
				Area:       px[2] * px[3],
				PageIndex:  p.PageIndex,
				PocClass:   b.Class,
			})
			annID++
		}
	}
	return json.MarshalIndent(File{Images: images, Categories: cats, Annotations: anns}, "", "  ")
}
