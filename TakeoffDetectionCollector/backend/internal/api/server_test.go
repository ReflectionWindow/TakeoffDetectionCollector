package api

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
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

	save := []byte(`{"boxes":[{"id":"n1","class":"CW","origin":"user","bbox_pt":[10,20,30,40],"bbox_px75":[0,0,0,0],"edited":true}],"note":"edit"}`)
	req = httptest.NewRequest(http.MethodPost, "/v1/jobs/"+jobID+"/pages/0/annotations", bytes.NewReader(save))
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("save %d %s", w.Code, w.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/jobs/"+jobID+"/export/coco", nil)
	req.Header.Set("Authorization", "Bearer "+auth.Token)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("export %d %s", w.Code, w.Body.String())
	}
}
