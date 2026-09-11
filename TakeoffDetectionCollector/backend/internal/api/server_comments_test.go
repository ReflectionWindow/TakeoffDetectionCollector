package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/auth"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/config"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/storage"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/store"
)

func TestPageCommentsVisibleToOtherUsers(t *testing.T) {
	cfg := config.Config{
		CORSOrigins:        []string{"http://localhost:5173"},
		AllowedEmailDomain: "reflectionwindow.com",
		DevAuth:            true,
	}
	s := New(cfg, store.NewMemory(), storage.NewMemory())
	h := s.Handler()

	alice := auth.IssueDevToken(auth.User{
		ID:    "00000000-0000-0000-0000-0000000000aa",
		Email: "alice@reflectionwindow.com",
		Name:  "Alice",
	})
	bob := auth.IssueDevToken(auth.User{
		ID:    "00000000-0000-0000-0000-0000000000bb",
		Email: "bob@reflectionwindow.com",
		Name:  "Bob",
	})

	job, err := s.store.UpsertJob(context.Background(), store.Job{Slug: "sheet-a", Title: "Sheet A", Status: store.StatusCorrected})
	if err != nil {
		t.Fatal(err)
	}

	post := []byte(`{"body":"check this louver","annotation_id":"box-9"}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/jobs/"+job.ID+"/pages/0/comments", bytes.NewReader(post))
	req.Header.Set("Authorization", "Bearer "+alice)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("create %d %s", w.Code, w.Body.String())
	}
	var created struct {
		Comment store.PageComment `json:"comment"`
	}
	if err := json.NewDecoder(w.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if created.Comment.Body != "check this louver" || created.Comment.AnnotationID != "box-9" {
		t.Fatalf("created %#v", created.Comment)
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/jobs/"+job.ID+"/pages/0/comments", nil)
	req.Header.Set("Authorization", "Bearer "+bob)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("list %d %s", w.Code, w.Body.String())
	}
	var listed struct {
		Comments []store.PageComment `json:"comments"`
	}
	if err := json.NewDecoder(w.Body).Decode(&listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Comments) != 1 || listed.Comments[0].AuthorEmail != "alice@reflectionwindow.com" {
		t.Fatalf("bob should see alice's comment %#v", listed.Comments)
	}

	req = httptest.NewRequest(http.MethodDelete, "/v1/jobs/"+job.ID+"/pages/0/comments/"+created.Comment.ID, nil)
	req.Header.Set("Authorization", "Bearer "+bob)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("bob delete %d %s", w.Code, w.Body.String())
	}

	empty := []byte(`{"body":"   "}`)
	req = httptest.NewRequest(http.MethodPost, "/v1/jobs/"+job.ID+"/pages/0/comments", bytes.NewReader(empty))
	req.Header.Set("Authorization", "Bearer "+alice)
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 400 {
		t.Fatalf("empty %d %s", w.Code, w.Body.String())
	}
}
