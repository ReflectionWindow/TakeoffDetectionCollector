package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/config"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/storage"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/store"
)

func TestHealthDevAuthImportAndVersion(t *testing.T) {
	cfg := config.Config{
		CORSOrigins:        []string{"http://localhost:5173"},
		AllowedEmailDomain: "reflectionwindow.com",
		DevAuth:            true,
	}
	s := New(cfg, store.NewMemory(), storage.NewMemory())
	h := s.Handler()

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("health %d", w.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/v1/auth/dev", nil)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("dev auth %d %s", w.Code, w.Body.String())
	}
	var auth struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(w.Body).Decode(&auth); err != nil || auth.Token == "" {
		t.Fatal(auth)
	}

	cocoJSON := []byte(`{"images":[{"id":1,"file_name":"page_0000.png","width":3600,"height":2700,"page_index":0}],"categories":[{"id":4,"name":"CW"}],"annotations":[{"id":1,"image_id":1,"category_id":4,"bbox":[100,200,30,40],"page_index":0,"poc_class":"CW"}]}`)
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, err := mw.CreateFormFile("file", "uih.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write(cocoJSON); err != nil {
		t.Fatal(err)
	}
	mw.Close()
	req = httptest.NewRequest(http.MethodPost, "/v1/imports/coco", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("import %d %s", w.Code, w.Body.String())
	}
	var imported struct {
		Jobs []store.Job `json:"jobs"`
	}
	if err := json.NewDecoder(w.Body).Decode(&imported); err != nil || len(imported.Jobs) != 1 {
		t.Fatalf("imported %+v %v", imported, err)
	}
	jobID := imported.Jobs[0].ID

	req = httptest.NewRequest(http.MethodGet, "/v1/jobs/"+jobID+"/pages/0/annotations", nil)
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("annotations %d %s", w.Code, w.Body.String())
	}

	save := []byte(`{"boxes":[{"id":"n1","class":"CW","origin":"user","polygon_pt":[[10,20],[40,20],[40,60],[10,60]],"bbox_pt":[10,20,30,40],"bbox_px75":[0,0,0,0],"edited":true}],"note":"edit"}`)
	req = httptest.NewRequest(http.MethodPost, "/v1/jobs/"+jobID+"/pages/0/annotations", bytes.NewReader(save))
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("save %d %s", w.Code, w.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/jobs/"+jobID+"/pages/0/annotations?version=0", nil)
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("annotations v0 %d %s", w.Code, w.Body.String())
	}
	var v0 struct {
		Payload store.AnnotationPayload `json:"payload"`
	}
	if err := json.NewDecoder(w.Body).Decode(&v0); err != nil {
		t.Fatal(err)
	}
	if v0.Payload.Version != 0 {
		t.Fatalf("v0 version %d", v0.Payload.Version)
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/jobs/"+jobID+"/export/coco", nil)
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("export %d %s", w.Code, w.Body.String())
	}

	dir := t.TempDir()
	pdf := []byte("%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n")
	if err := os.WriteFile(filepath.Join(dir, imported.Jobs[0].Slug+".pdf"), pdf, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "unmatched_job.pdf"), pdf, 0o644); err != nil {
		t.Fatal(err)
	}
	form := &bytes.Buffer{}
	mw = multipart.NewWriter(form)
	if err := mw.WriteField("dir", dir); err != nil {
		t.Fatal(err)
	}
	mw.Close()
	req = httptest.NewRequest(http.MethodPost, "/v1/imports/pdfs", form)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("pdf import %d %s", w.Code, w.Body.String())
	}
	var attached struct {
		Attached int `json:"attached"`
		Skipped  int `json:"skipped"`
	}
	if err := json.NewDecoder(w.Body).Decode(&attached); err != nil {
		t.Fatal(err)
	}
	if attached.Attached != 1 || attached.Skipped != 1 {
		t.Fatalf("attached=%d skipped=%d", attached.Attached, attached.Skipped)
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/jobs/"+jobID, nil)
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("job %d %s", w.Code, w.Body.String())
	}
	var got struct {
		Job store.Job `json:"job"`
	}
	if err := json.NewDecoder(w.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if !got.Job.HasPDF {
		t.Fatal("expected pdf attached")
	}
	if store.NormalizeStatus(got.Job.Status) != store.StatusOriginal {
		t.Fatalf("stage %s", got.Job.Status)
	}

	req = httptest.NewRequest(http.MethodPost, "/v1/jobs/"+jobID+"/claim", nil)
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("claim %d %s", w.Code, w.Body.String())
	}

	stageBody := []byte(`{"stage":"corrected"}`)
	req = httptest.NewRequest(http.MethodPost, "/v1/jobs/"+jobID+"/stage", bytes.NewReader(stageBody))
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("stage %d %s", w.Code, w.Body.String())
	}

	tagBody := []byte(`{"tags":[" Hospital ","QC","hospital"]}`)
	req = httptest.NewRequest(http.MethodPut, "/v1/jobs/"+jobID+"/tags", bytes.NewReader(tagBody))
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("set tags %d %s", w.Code, w.Body.String())
	}
	var tagged struct {
		Job store.Job `json:"job"`
	}
	if err := json.NewDecoder(w.Body).Decode(&tagged); err != nil {
		t.Fatal(err)
	}
	if len(tagged.Job.Tags) != 2 || tagged.Job.Tags[0] != "Hospital" || tagged.Job.Tags[1] != "QC" {
		t.Fatalf("job tags %#v", tagged.Job.Tags)
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/tags", nil)
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("list tags %d %s", w.Code, w.Body.String())
	}
	var catalog struct {
		Tags []store.Tag `json:"tags"`
	}
	if err := json.NewDecoder(w.Body).Decode(&catalog); err != nil {
		t.Fatal(err)
	}
	if len(catalog.Tags) != 2 {
		t.Fatalf("catalog %#v", catalog.Tags)
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/jobs/"+jobID, nil)
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("job after tags %d %s", w.Code, w.Body.String())
	}
	if err := json.NewDecoder(w.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got.Job.Tags) != 2 {
		t.Fatalf("get job tags %#v", got.Job.Tags)
	}
}

func TestHealthDBDown(t *testing.T) {
	cfg := config.Config{
		CORSOrigins: []string{"http://localhost:5173"},
		DevAuth:     true,
	}
	s := New(cfg, store.NewMemory(), storage.NewMemory())
	s.SetStoreHealth("postgres", func(context.Context) error { return errors.New("down") })
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("health %d body %s", w.Code, w.Body.String())
	}
}

func TestCORSAllowsVercelWildcard(t *testing.T) {
	h := New(config.Config{
		CORSOrigins: []string{"https://*.vercel.app"},
		DevAuth:     true,
	}, store.NewMemory(), storage.NewMemory()).Handler()

	req := httptest.NewRequest(http.MethodOptions, "/health", nil)
	req.Header.Set("Origin", "https://collector-abc123.vercel.app")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "https://collector-abc123.vercel.app" {
		t.Fatalf("allow origin %q", got)
	}

	req = httptest.NewRequest(http.MethodOptions, "/health", nil)
	req.Header.Set("Origin", "https://evil.example")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("unexpected origin %q", got)
	}
}

func TestOriginAllowed(t *testing.T) {
	allowed := []string{"https://app.vercel.app", "https://*.vercel.app"}
	if !originAllowed("https://app.vercel.app", allowed) {
		t.Fatal("exact")
	}
	if !originAllowed("https://foo-bar.vercel.app", allowed) {
		t.Fatal("wildcard")
	}
	if originAllowed("https://app.vercel.app.evil.com", allowed) {
		t.Fatal("suffix bypass")
	}
	if originAllowed("http://foo.vercel.app", allowed) {
		t.Fatal("scheme")
	}
}

func TestListJobsPagedAndDelete(t *testing.T) {
	cfg := config.Config{
		CORSOrigins:        []string{"http://localhost:5173"},
		AllowedEmailDomain: "reflectionwindow.com",
		DevAuth:            true,
	}
	mem := store.NewMemory()
	s := New(cfg, mem, storage.NewMemory())
	h := s.Handler()

	req := httptest.NewRequest(http.MethodPost, "/v1/auth/dev", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("dev auth %d %s", w.Code, w.Body.String())
	}
	var auth struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(w.Body).Decode(&auth); err != nil || auth.Token == "" {
		t.Fatal(auth)
	}

	ctx := req.Context()
	for _, slug := range []string{"alpha", "bravo", "charlie"} {
		if _, err := mem.UpsertJob(ctx, store.Job{Slug: slug, Title: slug, Status: store.StatusOriginal}); err != nil {
			t.Fatal(err)
		}
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/jobs?limit=2&offset=0", nil)
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("list %d %s", w.Code, w.Body.String())
	}
	var page store.JobList
	if err := json.NewDecoder(w.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 3 || len(page.Jobs) != 2 || page.Limit != 2 {
		t.Fatalf("page %#v", page)
	}

	delID := page.Jobs[0].ID
	req = httptest.NewRequest(http.MethodDelete, "/v1/jobs/"+delID, nil)
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("delete %d %s", w.Code, w.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/jobs?limit=25", nil)
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("list after %d %s", w.Code, w.Body.String())
	}
	if err := json.NewDecoder(w.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 2 {
		t.Fatalf("after delete %#v", page)
	}
}

func markupPDF() []byte {
	return []byte(
		"%PDF-1.1\n" +
			"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
			"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
			"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Annots[4 0 R 5 0 R]>>endobj\n" +
			"4 0 obj<</Type/Annot/Subtype/Polygon/Contents(CW)/Vertices[100 100 200 100 200 200 100 200]>>endobj\n" +
			"5 0 obj<</Type/Annot/Subtype/Polygon/Contents(NOPE)/Vertices[1 1 2 1 2 2]>>endobj\n" +
			"trailer<</Root 1 0 R>>\n%%EOF\n",
	)
}

func TestImportJobsProjectsAndSearch(t *testing.T) {
	cfg := config.Config{
		CORSOrigins:        []string{"http://localhost:5173"},
		AllowedEmailDomain: "reflectionwindow.com",
		DevAuth:            true,
	}
	s := New(cfg, store.NewMemory(), storage.NewMemory())
	h := s.Handler()

	req := httptest.NewRequest(http.MethodPost, "/v1/auth/dev", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("dev auth %d %s", w.Code, w.Body.String())
	}
	var auth struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(w.Body).Decode(&auth); err != nil || auth.Token == "" {
		t.Fatal(auth)
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/projects", nil)
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("projects %d %s", w.Code, w.Body.String())
	}
	var catalog struct {
		Projects     []store.Project `json:"projects"`
		RootJobCount int             `json:"root_job_count"`
	}
	if err := json.NewDecoder(w.Body).Decode(&catalog); err != nil {
		t.Fatal(err)
	}
	if len(catalog.Projects) != 2 {
		t.Fatalf("seeded projects %#v", catalog.Projects)
	}
	var chicago string
	for _, p := range catalog.Projects {
		if p.Slug == "chicago" {
			chicago = p.ID
		}
	}
	if chicago == "" {
		t.Fatal("chicago missing")
	}

	body := &bytes.Buffer{}
	mw := multipart.NewWriter(body)
	fw, err := mw.CreateFormFile("files", "UIH_ELEVATION.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write(markupPDF()); err != nil {
		t.Fatal(err)
	}
	if err := mw.WriteField("project_id", chicago); err != nil {
		t.Fatal(err)
	}
	mw.Close()
	req = httptest.NewRequest(http.MethodPost, "/v1/imports/jobs", body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("import jobs %d %s", w.Code, w.Body.String())
	}
	var imported struct {
		Imported int         `json:"imported"`
		Skipped  int         `json:"skipped"`
		Jobs     []store.Job `json:"jobs"`
	}
	if err := json.NewDecoder(w.Body).Decode(&imported); err != nil {
		t.Fatal(err)
	}
	if imported.Imported != 1 || len(imported.Jobs) != 1 {
		t.Fatalf("imported %#v", imported)
	}
	job := imported.Jobs[0]
	if job.ProjectID != chicago || job.Slug != "UIH_ELEVATION" || !job.HasPDF {
		t.Fatalf("job %#v", job)
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/jobs/"+job.ID+"/pages/0/annotations", nil)
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("annotations %d %s", w.Code, w.Body.String())
	}
	var payload struct {
		Payload store.AnnotationPayload `json:"payload"`
	}
	if err := json.NewDecoder(w.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Payload.Boxes) != 1 || payload.Payload.Boxes[0].Class != "CW" {
		t.Fatalf("boxes %#v", payload.Payload.Boxes)
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/jobs?q=UIH", nil)
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("search %d %s", w.Code, w.Body.String())
	}
	var list store.JobList
	if err := json.NewDecoder(w.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if list.Total != 1 || list.Jobs[0].ID != job.ID {
		t.Fatalf("search %#v", list)
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/jobs?project="+chicago, nil)
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("chicago list %d %s", w.Code, w.Body.String())
	}
	if err := json.NewDecoder(w.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if list.Total != 1 {
		t.Fatalf("chicago %#v", list)
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/jobs?project=root", nil)
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if err := json.NewDecoder(w.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if list.Total != 0 {
		t.Fatalf("root should be empty %#v", list)
	}

	dup := &bytes.Buffer{}
	mw = multipart.NewWriter(dup)
	fw, err = mw.CreateFormFile("files", "UIH_ELEVATION.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write(markupPDF()); err != nil {
		t.Fatal(err)
	}
	if err := mw.WriteField("project_id", chicago); err != nil {
		t.Fatal(err)
	}
	mw.Close()
	req = httptest.NewRequest(http.MethodPost, "/v1/imports/jobs", dup)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("dup import %d %s", w.Code, w.Body.String())
	}
	var again struct {
		Imported int              `json:"imported"`
		Skipped  int              `json:"skipped"`
		Errors   []jobImportError `json:"errors"`
	}
	if err := json.NewDecoder(w.Body).Decode(&again); err != nil {
		t.Fatal(err)
	}
	if again.Imported != 0 || again.Skipped != 1 || len(again.Errors) != 1 {
		t.Fatalf("dup %#v", again)
	}

	create := bytes.NewReader([]byte(`{"name":"Austin"}`))
	req = httptest.NewRequest(http.MethodPost, "/v1/projects", create)
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("create project %d %s", w.Code, w.Body.String())
	}
}

func TestImportCocoBlackouts(t *testing.T) {
	cfg := config.Config{
		CORSOrigins:        []string{"http://localhost:5173"},
		AllowedEmailDomain: "reflectionwindow.com",
		DevAuth:            true,
	}
	s := New(cfg, store.NewMemory(), storage.NewMemory())
	h := s.Handler()

	req := httptest.NewRequest(http.MethodPost, "/v1/auth/dev", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("dev auth %d %s", w.Code, w.Body.String())
	}
	var auth struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(w.Body).Decode(&auth); err != nil || auth.Token == "" {
		t.Fatal(auth)
	}

	cocoJSON := []byte(`{"images":[{"id":1,"file_name":"page_0002.png","width":1000,"height":500}],"categories":[{"id":1,"name":"CW"},{"id":2,"name":"blackout"}],"annotations":[{"id":1,"image_id":1,"category_id":1,"bbox":[10,20,30,40]},{"id":2,"image_id":1,"category_id":2,"bbox":[100,50,200,100]}]}`)
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, err := mw.CreateFormFile("file", "demo.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write(cocoJSON); err != nil {
		t.Fatal(err)
	}
	mw.Close()
	req = httptest.NewRequest(http.MethodPost, "/v1/imports/coco", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("import %d %s", w.Code, w.Body.String())
	}
	var imported struct {
		Jobs []store.Job `json:"jobs"`
	}
	if err := json.NewDecoder(w.Body).Decode(&imported); err != nil || len(imported.Jobs) != 1 {
		t.Fatalf("imported %+v %v", imported, err)
	}
	jobID := imported.Jobs[0].ID

	req = httptest.NewRequest(http.MethodGet, "/v1/jobs/"+jobID+"/pages/2/annotations", nil)
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("annotations %d %s", w.Code, w.Body.String())
	}
	var anns struct {
		Payload store.AnnotationPayload `json:"payload"`
	}
	if err := json.NewDecoder(w.Body).Decode(&anns); err != nil {
		t.Fatal(err)
	}
	if len(anns.Payload.Boxes) != 1 || anns.Payload.Boxes[0].Class != "CW" {
		t.Fatalf("boxes %+v", anns.Payload.Boxes)
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/jobs/"+jobID+"/pages/2/blackouts", nil)
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("blackouts %d %s", w.Code, w.Body.String())
	}
	var blk struct {
		Regions []struct {
			X1 float64 `json:"x1"`
			Y1 float64 `json:"y1"`
			X2 float64 `json:"x2"`
			Y2 float64 `json:"y2"`
		} `json:"regions"`
	}
	if err := json.NewDecoder(w.Body).Decode(&blk); err != nil {
		t.Fatal(err)
	}
	if len(blk.Regions) != 1 || blk.Regions[0].X1 != 0.1 || blk.Regions[0].Y1 != 0.1 || blk.Regions[0].X2 != 0.3 || blk.Regions[0].Y2 != 0.3 {
		t.Fatalf("regions %+v", blk.Regions)
	}
}
