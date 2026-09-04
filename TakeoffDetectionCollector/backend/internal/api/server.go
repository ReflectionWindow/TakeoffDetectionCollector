package api

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/auth"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/blackout"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/coco"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/config"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/coords"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/geom"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/pool"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/storage"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/store"
)

type Server struct {
	cfg       config.Config
	auth      *auth.Service
	store     store.Store
	blob      storage.Blob
	pool      *pool.Pool
	storeKind string
	dbPing    func(context.Context) error
}

// SetStoreHealth records which store backs the server and, for Postgres, a
// ping function so /health can report live database connectivity to the
// frontend.
func (s *Server) SetStoreHealth(kind string, ping func(context.Context) error) {
	s.storeKind = kind
	s.dbPing = ping
}

func New(cfg config.Config, st store.Store, blob storage.Blob) *Server {
	return &Server{
		cfg:       cfg,
		auth:      auth.New(cfg),
		store:     st,
		blob:      blob,
		pool:      pool.New(8),
		storeKind: "memory",
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("GET /v1/me", s.withAuth(s.me))
	mux.HandleFunc("POST /v1/auth/dev", s.authDev)
	mux.HandleFunc("POST /v1/auth/supabase", s.authSupabase)
	mux.HandleFunc("GET /v1/jobs", s.withAuth(s.listJobs))
	mux.HandleFunc("GET /v1/jobs/{id}", s.withAuth(s.getJob))
	mux.HandleFunc("POST /v1/imports/coco", s.withAuth(s.importCoco))
	mux.HandleFunc("POST /v1/jobs/{id}/pdf", s.withAuth(s.attachPDF))
	mux.HandleFunc("GET /v1/jobs/{id}/pdf", s.withAuth(s.getPDF))
	mux.HandleFunc("GET /v1/jobs/{id}/pages/{n}/annotations", s.withAuth(s.getAnnotations))
	mux.HandleFunc("POST /v1/jobs/{id}/pages/{n}/annotations", s.withAuth(s.saveAnnotations))
	mux.HandleFunc("GET /v1/jobs/{id}/pages/{n}/revisions", s.withAuth(s.listRevisions))
	mux.HandleFunc("POST /v1/jobs/{id}/pages/{n}/revert", s.withAuth(s.revertAnnotations))
	mux.HandleFunc("GET /v1/jobs/{id}/pages/{n}/vectors", s.withAuth(s.getVectors))
	mux.HandleFunc("PUT /v1/jobs/{id}/pages/{n}/blackouts", s.withAuth(s.putBlackouts))
	mux.HandleFunc("GET /v1/jobs/{id}/pages/{n}/blackouts", s.withAuth(s.getBlackouts))
	mux.HandleFunc("GET /v1/jobs/{id}/export/coco", s.withAuth(s.exportCoco))
	return s.cors(mux)
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	resp := map[string]any{
		"ok":       true,
		"dev_auth": s.auth.DevEnabled(),
		"domain":   s.cfg.AllowedEmailDomain,
		"store":    s.storeKind,
	}
	if s.dbPing != nil {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := s.dbPing(ctx); err != nil {
			resp["ok"] = false
			resp["db_ok"] = false
			resp["db_error"] = err.Error()
		} else {
			resp["db_ok"] = true
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) me(w http.ResponseWriter, r *http.Request, u auth.User) {
	writeJSON(w, http.StatusOK, map[string]any{"user": u, "dev_auth": s.auth.DevEnabled()})
}

func (s *Server) authDev(w http.ResponseWriter, r *http.Request) {
	if !s.auth.DevEnabled() {
		http.Error(w, "dev auth disabled", http.StatusForbidden)
		return
	}
	u := s.auth.DevUser()
	writeJSON(w, http.StatusOK, map[string]any{"token": auth.IssueDevToken(u), "user": u})
}

func (s *Server) authSupabase(w http.ResponseWriter, r *http.Request) {
	u, err := s.auth.FromRequest(r)
	if err == auth.ErrDomain {
		http.Error(w, "email domain not allowed", http.StatusForbidden)
		return
	}
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": bearerOf(r), "user": u})
}

func (s *Server) listJobs(w http.ResponseWriter, r *http.Request, _ auth.User) {
	jobs, err := s.store.ListJobs(r.Context())
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	sort.Slice(jobs, func(i, j int) bool { return jobs[i].Slug < jobs[j].Slug })
	writeJSON(w, 200, map[string]any{"jobs": jobs})
}

func (s *Server) getJob(w http.ResponseWriter, r *http.Request, _ auth.User) {
	job, err := s.store.GetJob(r.Context(), r.PathValue("id"))
	if err != nil {
		http.Error(w, err.Error(), 404)
		return
	}
	pages, err := s.store.ListPages(r.Context(), job.ID)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	sort.Slice(pages, func(i, j int) bool { return pages[i].PageIndex < pages[j].PageIndex })
	writeJSON(w, 200, map[string]any{"job": job, "pages": pages})
}

func (s *Server) importCoco(w http.ResponseWriter, r *http.Request, u auth.User) {
	ctx := r.Context()
	if err := s.store.EnsureUser(ctx, u.ID, u.Email, u.Name); err != nil {
		log.Printf("ensure user: %v", err)
	}
	var jobs []coco.JobImport
	if dir := r.FormValue("dir"); dir != "" {
		slugs, err := coco.DiscoverJobs(dir)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		for _, slug := range slugs {
			imp, err := coco.LoadJobDir(dir, slug)
			if err != nil {
				log.Printf("import skip %s: %v", slug, err)
				continue
			}
			jobs = append(jobs, imp)
		}
	} else {
		if err := r.ParseMultipartForm(512 << 20); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		file, hdr, err := r.FormFile("file")
		if err != nil {
			http.Error(w, "file or dir required", 400)
			return
		}
		defer file.Close()
		data, err := io.ReadAll(file)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if strings.HasSuffix(strings.ToLower(hdr.Filename), ".json") {
			imp, err := coco.Parse(data, strings.TrimSuffix(hdr.Filename, filepath.Ext(hdr.Filename)))
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			jobs = append(jobs, imp)
		} else {
			imps, err := unzipCoco(data)
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			jobs = append(jobs, imps...)
		}
	}

	imported := make([]store.Job, len(jobs))
	s.pool.Do(len(jobs), func(i int) {
		j, err := s.persistImport(ctx, jobs[i], u)
		if err != nil {
			log.Printf("persist %s: %v", jobs[i].Slug, err)
			return
		}
		imported[i] = j
	})
	out := make([]store.Job, 0, len(imported))
	for _, j := range imported {
		if j.ID != "" {
			out = append(out, j)
		}
	}
	writeJSON(w, 200, map[string]any{"imported": len(out), "jobs": out})
}

func (s *Server) persistImport(ctx context.Context, imp coco.JobImport, u auth.User) (store.Job, error) {
	existing, err := s.store.GetJobBySlug(ctx, imp.Slug)
	job := store.Job{
		Slug:   imp.Slug,
		Title:  imp.Title,
		Status: store.StatusAwaitingPDF,
	}
	if err == nil {
		job.ID = existing.ID
	}
	job, err = s.store.UpsertJob(ctx, job)
	if err != nil {
		return store.Job{}, err
	}
	key := fmt.Sprintf("coco/%s/_annotations.coco.json", job.ID)
	_ = s.blob.Put(key, imp.Raw, "application/json")
	job.SourceCocoKey = key
	_ = s.store.UpdateJob(ctx, job)
	for _, p := range imp.Pages {
		p.JobID = job.ID
		if err := s.store.UpsertPage(ctx, p); err != nil {
			return store.Job{}, err
		}
		boxes := imp.ByPage[p.PageIndex]
		if boxes == nil {
			boxes = []store.Box{}
		}
		payload := store.AnnotationPayload{JobID: job.ID, PageIndex: p.PageIndex, Version: 0, Boxes: boxes}
		revKey := fmt.Sprintf("annotations/%s/p%d/v0.json", job.ID, p.PageIndex)
		data, _ := json.Marshal(payload)
		_ = s.blob.Put(revKey, data, "application/json")
		if err := s.store.SaveRevision(ctx, store.Revision{
			JobID:      job.ID,
			PageIndex:  p.PageIndex,
			Version:    0,
			AuthorID:   u.ID,
			StorageKey: revKey,
			Note:       "imported coco",
			CreatedAt:  time.Now().UTC(),
		}, payload); err != nil {
			return store.Job{}, err
		}
	}
	return s.store.GetJob(ctx, job.ID)
}

func unzipCoco(data []byte) ([]coco.JobImport, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, err
	}
	var out []coco.JobImport
	for _, f := range zr.File {
		name := filepath.ToSlash(f.Name)
		if !strings.HasSuffix(name, "coarse/_annotations.coco.json") && !strings.HasSuffix(name, "_annotations.coco.json") {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			continue
		}
		raw, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			continue
		}
		parts := strings.Split(strings.Trim(name, "/"), "/")
		slug := "job"
		for i, p := range parts {
			if p == "coarse" && i > 0 {
				slug = parts[i-1]
				break
			}
		}
		imp, err := coco.Parse(raw, slug)
		if err != nil {
			continue
		}
		out = append(out, imp)
	}
	return out, nil
}

func (s *Server) attachPDF(w http.ResponseWriter, r *http.Request, _ auth.User) {
	job, err := s.store.GetJob(r.Context(), r.PathValue("id"))
	if err != nil {
		http.Error(w, err.Error(), 404)
		return
	}
	if err := r.ParseMultipartForm(256 << 20); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	file, _, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "file required", 400)
		return
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if len(data) < 5 || string(data[:4]) != "%PDF" {
		http.Error(w, "not a pdf", 400)
		return
	}
	sum := storage.SHA256Hex(data)
	key := fmt.Sprintf("pdfs/%s/%s.pdf", job.ID, sum)
	if err := s.blob.Put(key, data, "application/pdf"); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	n := geom.PageCount(data)
	if n == 0 {
		n = 1
	}
	if err := s.store.SetDocument(r.Context(), job.ID, key, sum, n); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	pages, _ := s.store.ListPages(r.Context(), job.ID)
	s.pool.Do(len(pages), func(i int) {
		p := pages[i]
		vec, err := geom.ExtractPage(data, p.PageIndex)
		if err != nil {
			log.Printf("extract %s p%d: %v", job.ID, p.PageIndex, err)
			return
		}
		if vec.PageWidthPt > 0 {
			p.WidthPt = vec.PageWidthPt
			p.HeightPt = vec.PageHeightPt
		}
		vk := fmt.Sprintf("vectors/%s/p%d.json", job.ID, p.PageIndex)
		raw, _ := json.Marshal(vec)
		_ = s.blob.Put(vk, raw, "application/json")
		p.VectorsKey = vk
		p.PDFKey = key
		_ = s.store.UpsertPage(r.Context(), p)
	})
	job.Status = store.StatusReady
	_ = s.store.UpdateJob(r.Context(), job)
	writeJSON(w, 200, map[string]any{"ok": true, "page_count": n, "sha256": sum})
}

func (s *Server) getPDF(w http.ResponseWriter, r *http.Request, _ auth.User) {
	pages, err := s.store.ListPages(r.Context(), r.PathValue("id"))
	if err != nil || len(pages) == 0 {
		http.Error(w, "no pdf", 404)
		return
	}
	key := pages[0].PDFKey
	if key == "" {
		http.Error(w, "no pdf", 404)
		return
	}
	data, err := s.blob.Get(key)
	if err != nil {
		http.Error(w, err.Error(), 404)
		return
	}
	w.Header().Set("Content-Type", "application/pdf")
	w.Write(data)
}

func (s *Server) getAnnotations(w http.ResponseWriter, r *http.Request, _ auth.User) {
	jobID := r.PathValue("id")
	n, _ := strconv.Atoi(r.PathValue("n"))
	rev, payload, err := s.store.LatestRevision(r.Context(), jobID, n)
	if err != nil {
		http.Error(w, err.Error(), 404)
		return
	}
	writeJSON(w, 200, map[string]any{"revision": rev, "payload": payload})
}

type saveBody struct {
	Boxes []store.Box `json:"boxes"`
	Note  string      `json:"note"`
}

func (s *Server) saveAnnotations(w http.ResponseWriter, r *http.Request, u auth.User) {
	jobID := r.PathValue("id")
	n, _ := strconv.Atoi(r.PathValue("n"))
	var body saveBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if err := s.store.EnsureUser(r.Context(), u.ID, u.Email, u.Name); err != nil {
		log.Printf("ensure user: %v", err)
	}
	parent := 0
	if rev, _, err := s.store.LatestRevision(r.Context(), jobID, n); err == nil {
		parent = rev.Version
	}
	version := parent + 1
	if parent == 0 {
		if _, _, err := s.store.GetRevision(r.Context(), jobID, n, 0); err != nil {
			version = 0
		}
	}
	if _, _, err := s.store.LatestRevision(r.Context(), jobID, n); err == nil {
		version = parent + 1
	}
	for i := range body.Boxes {
		if body.Boxes[i].BBoxPt == [4]float64{} && body.Boxes[i].BBoxPx75 != [4]float64{} {
			body.Boxes[i].BBoxPt = coords.BBoxPx75ToPt(body.Boxes[i].BBoxPx75)
		}
		if body.Boxes[i].Origin == "" {
			body.Boxes[i].Origin = "user"
		}
	}
	payload := store.AnnotationPayload{JobID: jobID, PageIndex: n, Version: version, Boxes: body.Boxes}
	key := fmt.Sprintf("annotations/%s/p%d/v%d.json", jobID, n, version)
	raw, _ := json.Marshal(payload)
	if err := s.blob.Put(key, raw, "application/json"); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	pv := parent
	rev := store.Revision{
		JobID:         jobID,
		PageIndex:     n,
		Version:       version,
		ParentVersion: &pv,
		AuthorID:      u.ID,
		StorageKey:    key,
		Note:          body.Note,
		CreatedAt:     time.Now().UTC(),
	}
	if err := s.store.SaveRevision(r.Context(), rev, payload); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if job, err := s.store.GetJob(r.Context(), jobID); err == nil {
		job.Status = store.StatusCleaning
		_ = s.store.UpdateJob(r.Context(), job)
	}
	writeJSON(w, 200, map[string]any{"revision": rev, "payload": payload})
}

func (s *Server) listRevisions(w http.ResponseWriter, r *http.Request, _ auth.User) {
	jobID := r.PathValue("id")
	n, _ := strconv.Atoi(r.PathValue("n"))
	revs, err := s.store.ListRevisions(r.Context(), jobID, n)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, 200, map[string]any{"revisions": revs})
}

type revertBody struct {
	Version int `json:"version"`
}

func (s *Server) revertAnnotations(w http.ResponseWriter, r *http.Request, u auth.User) {
	jobID := r.PathValue("id")
	n, _ := strconv.Atoi(r.PathValue("n"))
	var body revertBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if err := s.store.EnsureUser(r.Context(), u.ID, u.Email, u.Name); err != nil {
		log.Printf("ensure user: %v", err)
	}
	_, old, err := s.store.GetRevision(r.Context(), jobID, n, body.Version)
	if err != nil {
		http.Error(w, err.Error(), 404)
		return
	}
	latest, _, err := s.store.LatestRevision(r.Context(), jobID, n)
	next := 1
	if err == nil {
		next = latest.Version + 1
	}
	payload := old
	payload.Version = next
	key := fmt.Sprintf("annotations/%s/p%d/v%d.json", jobID, n, next)
	raw, _ := json.Marshal(payload)
	_ = s.blob.Put(key, raw, "application/json")
	pv := body.Version
	rev := store.Revision{
		JobID: jobID, PageIndex: n, Version: next, ParentVersion: &pv,
		AuthorID: u.ID, StorageKey: key, Note: fmt.Sprintf("revert to v%d", body.Version),
		CreatedAt: time.Now().UTC(),
	}
	if err := s.store.SaveRevision(r.Context(), rev, payload); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, 200, map[string]any{"revision": rev, "payload": payload})
}

func (s *Server) getVectors(w http.ResponseWriter, r *http.Request, _ auth.User) {
	jobID := r.PathValue("id")
	n, _ := strconv.Atoi(r.PathValue("n"))
	page, err := s.store.GetPage(r.Context(), jobID, n)
	if err != nil {
		http.Error(w, err.Error(), 404)
		return
	}
	var vec geom.Vectors
	if page.VectorsKey != "" {
		if raw, err := s.blob.Get(page.VectorsKey); err == nil {
			_ = json.Unmarshal(raw, &vec)
		}
	}
	if vec.PageWidthPt == 0 && page.PDFKey != "" {
		if pdf, err := s.blob.Get(page.PDFKey); err == nil {
			vec, _ = geom.ExtractPage(pdf, n)
			vk := fmt.Sprintf("vectors/%s/p%d.json", jobID, n)
			raw, _ := json.Marshal(vec)
			_ = s.blob.Put(vk, raw, "application/json")
			page.VectorsKey = vk
			if vec.PageWidthPt > 0 {
				page.WidthPt = vec.PageWidthPt
				page.HeightPt = vec.PageHeightPt
			}
			_ = s.store.UpsertPage(r.Context(), page)
		}
	}
	if vec.PageWidthPt == 0 {
		vec.PageWidthPt = page.WidthPt
		vec.PageHeightPt = page.HeightPt
		vec.Empty = true
	}
	writeJSON(w, 200, map[string]any{
		"job_id":          jobID,
		"page_index":      n,
		"pdf_page":        page.PDFPage,
		"pdf_available":   page.PDFKey != "",
		"coord_space":     "pt",
		"page_width_pt":   vec.PageWidthPt,
		"page_height_pt":  vec.PageHeightPt,
		"image_width_px":  page.WidthPx75,
		"image_height_px": page.HeightPx75,
		"rotation":        vec.Rotation,
		"empty":           vec.Empty,
		"extract_version": geom.ExtractVersion,
		"segments":        vec.Segments,
		"fills":           vec.Fills,
		"points":          vec.Points,
		"dim_texts":       []any{},
		"stats":           vec.Stats,
	})
}

func (s *Server) putBlackouts(w http.ResponseWriter, r *http.Request, _ auth.User) {
	jobID := r.PathValue("id")
	n, _ := strconv.Atoi(r.PathValue("n"))
	var body struct {
		Regions []blackout.Region `json:"regions"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if err := s.store.SaveBlackouts(r.Context(), jobID, n, body.Regions); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, 200, map[string]any{"regions": body.Regions})
}

func (s *Server) getBlackouts(w http.ResponseWriter, r *http.Request, _ auth.User) {
	jobID := r.PathValue("id")
	n, _ := strconv.Atoi(r.PathValue("n"))
	regions, err := s.store.GetBlackouts(r.Context(), jobID, n)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, 200, map[string]any{"page": n + 1, "regions": regions})
}

func (s *Server) exportCoco(w http.ResponseWriter, r *http.Request, _ auth.User) {
	job, err := s.store.GetJob(r.Context(), r.PathValue("id"))
	if err != nil {
		http.Error(w, err.Error(), 404)
		return
	}
	pages, err := s.store.ListPages(r.Context(), job.ID)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	sort.Slice(pages, func(i, j int) bool { return pages[i].PageIndex < pages[j].PageIndex })
	byPage := map[int][]store.Box{}
	for _, p := range pages {
		if _, payload, err := s.store.LatestRevision(r.Context(), job.ID, p.PageIndex); err == nil {
			byPage[p.PageIndex] = payload.Boxes
		}
	}
	data, err := coco.Export(job, pages, byPage)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.coco.json"`, job.Slug))
	w.Write(data)
}

func (s *Server) withAuth(fn func(http.ResponseWriter, *http.Request, auth.User)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, err := s.auth.FromRequest(r)
		if err == auth.ErrDomain {
			http.Error(w, "email domain not allowed", http.StatusForbidden)
			return
		}
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		fn(w, r, u)
	}
}

func (s *Server) cors(next http.Handler) http.Handler {
	allowed := map[string]bool{}
	for _, o := range s.cfg.CORSOrigins {
		allowed[o] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if allowed[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func bearerOf(r *http.Request) string {
	h := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}
