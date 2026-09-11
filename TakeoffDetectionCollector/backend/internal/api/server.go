package api

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path"
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
	workers := cfg.IngestWorkers
	if workers < 1 {
		workers = 16
	}
	return &Server{
		cfg:       cfg,
		auth:      auth.New(cfg),
		store:     st,
		blob:      blob,
		pool:      pool.New(workers),
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
	mux.HandleFunc("POST /v1/jobs/next", s.withAuth(s.claimNext))
	mux.HandleFunc("GET /v1/projects", s.withAuth(s.listProjects))
	mux.HandleFunc("POST /v1/projects", s.withAuth(s.createProject))
	mux.HandleFunc("GET /v1/jobs/{id}", s.withAuth(s.getJob))
	mux.HandleFunc("DELETE /v1/jobs/{id}", s.withAuth(s.deleteJob))
	mux.HandleFunc("POST /v1/jobs/{id}/claim", s.withAuth(s.claimJob))
	mux.HandleFunc("POST /v1/jobs/{id}/heartbeat", s.withAuth(s.heartbeatJob))
	mux.HandleFunc("POST /v1/jobs/{id}/release", s.withAuth(s.releaseJob))
	mux.HandleFunc("POST /v1/jobs/{id}/stage", s.withAuth(s.setStage))
	mux.HandleFunc("GET /v1/tags", s.withAuth(s.listTags))
	mux.HandleFunc("PUT /v1/jobs/{id}/tags", s.withAuth(s.setJobTags))
	mux.HandleFunc("POST /v1/imports/coco", s.withAuth(s.importCoco))
	mux.HandleFunc("POST /v1/imports/pdfs", s.withAuth(s.importPDFs))
	mux.HandleFunc("POST /v1/imports/jobs", s.withAuth(s.importJobs))
	mux.HandleFunc("POST /v1/jobs/{id}/pdf", s.withAuth(s.attachPDF))
	mux.HandleFunc("GET /v1/jobs/{id}/pdf", s.withAuth(s.getPDF))
	mux.HandleFunc("GET /v1/jobs/{id}/pages/{n}/annotations", s.withAuth(s.getAnnotations))
	mux.HandleFunc("POST /v1/jobs/{id}/pages/{n}/annotations", s.withAuth(s.saveAnnotations))
	mux.HandleFunc("GET /v1/jobs/{id}/pages/{n}/revisions", s.withAuth(s.listRevisions))
	mux.HandleFunc("POST /v1/jobs/{id}/pages/{n}/revert", s.withAuth(s.revertAnnotations))
	mux.HandleFunc("GET /v1/jobs/{id}/pages/{n}/vectors", s.withAuth(s.getVectors))
	mux.HandleFunc("PUT /v1/jobs/{id}/pages/{n}/blackouts", s.withAuth(s.putBlackouts))
	mux.HandleFunc("GET /v1/jobs/{id}/pages/{n}/blackouts", s.withAuth(s.getBlackouts))
	mux.HandleFunc("GET /v1/jobs/{id}/pages/{n}/comments", s.withAuth(s.listComments))
	mux.HandleFunc("POST /v1/jobs/{id}/pages/{n}/comments", s.withAuth(s.createComment))
	mux.HandleFunc("DELETE /v1/jobs/{id}/pages/{n}/comments/{cid}", s.withAuth(s.deleteComment))
	mux.HandleFunc("GET /v1/jobs/{id}/export/coco", s.withAuth(s.exportCoco))
	return s.cors(mux)
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	ok := true
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
			ok = false
			resp["ok"] = false
			resp["db_ok"] = false
			resp["db_error"] = err.Error()
		} else {
			resp["db_ok"] = true
		}
	}
	status := http.StatusOK
	if !ok {
		status = http.StatusServiceUnavailable
	}
	writeJSON(w, status, resp)
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
	token, err := s.auth.IssueSessionToken(u)
	if err != nil {
		token = bearerOf(r)
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "user": u})
}

func (s *Server) listJobs(w http.ResponseWriter, r *http.Request, _ auth.User) {
	q := store.JobListQuery{
		Stage:   store.JobStatus(r.URL.Query().Get("stage")),
		Tags:    r.URL.Query()["tag"],
		Q:       r.URL.Query().Get("q"),
		Project: r.URL.Query().Get("project"),
		Limit:   atoiDefault(r.URL.Query().Get("limit"), store.DefaultJobPageSize),
		Offset:  atoiDefault(r.URL.Query().Get("offset"), 0),
	}
	list, err := s.store.ListJobs(r.Context(), q)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, 200, list)
}

func (s *Server) deleteJob(w http.ResponseWriter, r *http.Request, _ auth.User) {
	id := r.PathValue("id")
	keys, err := s.store.DeleteJob(r.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			http.Error(w, err.Error(), 404)
			return
		}
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	s.purgeJobBlobs(keys)
}

func (s *Server) purgeJobBlobs(keys []string) {
	if len(keys) == 0 || s.blob == nil {
		return
	}
	go func() {
		for _, key := range keys {
			if err := s.blob.Delete(key); err != nil {
				log.Printf("purge blob %s: %v", key, err)
			}
		}
	}()
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
	projectID := s.defaultImportProjectID(ctx)
	existing, err := s.store.GetJobBySlug(ctx, projectID, imp.Slug)
	job := store.Job{
		Slug:      imp.Slug,
		Title:     imp.Title,
		Status:    store.StatusOriginal,
		ProjectID: projectID,
	}
	if err == nil {
		job.ID = existing.ID
		job.Status = store.NormalizeStatus(existing.Status)
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

type pdfAttachResult struct {
	Job       store.Job `json:"job"`
	Slug      string    `json:"slug"`
	PageCount int       `json:"page_count"`
	SHA256    string    `json:"sha256"`
}

func slugFromPDFName(name string) string {
	base := filepath.Base(filepath.ToSlash(name))
	return strings.TrimSuffix(base, filepath.Ext(base))
}

func (s *Server) importPDFs(w http.ResponseWriter, r *http.Request, _ auth.User) {
	ctx := r.Context()
	type pending struct {
		slug string
		data []byte
	}
	var files []pending

	if dir := r.FormValue("dir"); dir != "" {
		entries, err := os.ReadDir(dir)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			name := e.Name()
			if !strings.HasSuffix(strings.ToLower(name), ".pdf") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				log.Printf("pdf read %s: %v", name, err)
				continue
			}
			files = append(files, pending{slug: slugFromPDFName(name), data: data})
		}
	} else {
		if err := r.ParseMultipartForm(512 << 20); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if r.MultipartForm == nil {
			http.Error(w, "dir or files required", 400)
			return
		}
		for _, hdrs := range r.MultipartForm.File {
			for _, hdr := range hdrs {
				f, err := hdr.Open()
				if err != nil {
					continue
				}
				data, err := io.ReadAll(f)
				f.Close()
				if err != nil {
					continue
				}
				files = append(files, pending{slug: slugFromPDFName(hdr.Filename), data: data})
			}
		}
	}

	type outcome struct {
		res  pdfAttachResult
		err  error
		skip string
	}
	out := make([]outcome, len(files))
	s.pool.Do(len(files), func(i int) {
		f := files[i]
		job, err := s.store.GetJobBySlug(ctx, s.defaultImportProjectID(ctx), f.slug)
		if err != nil {
			out[i].skip = "no matching job"
			return
		}
		res, err := s.attachPDFBytes(ctx, job, f.data)
		if err != nil {
			out[i].err = err
			return
		}
		out[i].res = res
	})

	attached := make([]pdfAttachResult, 0, len(out))
	skipped := 0
	for i, o := range out {
		if o.err != nil {
			log.Printf("pdf attach %s: %v", files[i].slug, o.err)
			skipped++
			continue
		}
		if o.skip != "" {
			skipped++
			continue
		}
		if o.res.Job.ID != "" {
			attached = append(attached, o.res)
		}
	}
	writeJSON(w, 200, map[string]any{"attached": len(attached), "skipped": skipped, "jobs": attached})
}

func (s *Server) defaultImportProjectID(ctx context.Context) string {
	p, err := s.store.GetProjectBySlug(ctx, store.ProjectManilaSlug)
	if err != nil {
		return ""
	}
	return p.ID
}

func (s *Server) resolveProjectID(ctx context.Context, raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.EqualFold(raw, store.ProjectScopeRoot) {
		return "", nil
	}
	if _, err := s.store.GetProject(ctx, raw); err != nil {
		return "", fmt.Errorf("project not found")
	}
	return raw, nil
}

type jobImportError struct {
	Slug  string `json:"slug"`
	Error string `json:"error"`
}

func (s *Server) importJobs(w http.ResponseWriter, r *http.Request, u auth.User) {
	ctx := r.Context()
	if err := s.store.EnsureUser(ctx, u.ID, u.Email, u.Name); err != nil {
		log.Printf("ensure user: %v", err)
	}
	if err := r.ParseMultipartForm(512 << 20); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	projectID, err := s.resolveProjectID(ctx, r.FormValue("project_id"))
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	type pending struct {
		slug string
		data []byte
	}
	var files []pending
	if r.MultipartForm != nil {
		for _, hdrs := range r.MultipartForm.File {
			for _, hdr := range hdrs {
				if hdr.Filename != "" && !strings.HasSuffix(strings.ToLower(hdr.Filename), ".pdf") {
					continue
				}
				f, err := hdr.Open()
				if err != nil {
					continue
				}
				data, err := io.ReadAll(f)
				f.Close()
				if err != nil || len(data) == 0 {
					continue
				}
				files = append(files, pending{slug: slugFromPDFName(hdr.Filename), data: data})
			}
		}
	}
	if len(files) == 0 {
		http.Error(w, "pdf files required", 400)
		return
	}

	imported := make([]store.Job, 0, len(files))
	errs := make([]jobImportError, 0)
	for _, f := range files {
		job, err := s.persistBluebeamJob(ctx, u, projectID, f.slug, f.data)
		if err != nil {
			errs = append(errs, jobImportError{Slug: f.slug, Error: err.Error()})
			continue
		}
		imported = append(imported, job)
	}
	writeJSON(w, 200, map[string]any{
		"imported": len(imported),
		"skipped":  len(errs),
		"jobs":     imported,
		"errors":   errs,
	})
}

func (s *Server) persistBluebeamJob(ctx context.Context, u auth.User, projectID, slug string, data []byte) (store.Job, error) {
	if len(data) < 5 || string(data[:4]) != "%PDF" {
		return store.Job{}, fmt.Errorf("not a pdf")
	}
	if slug == "" {
		return store.Job{}, fmt.Errorf("job name is empty")
	}
	if _, err := s.store.GetJobBySlug(ctx, projectID, slug); err == nil {
		return store.Job{}, fmt.Errorf("job slug already exists")
	}
	pages := geom.ExtractMarkups(data)
	if len(pages) == 0 {
		n := geom.PageCount(data)
		for i := 0; i < n; i++ {
			vec, _ := geom.ExtractPage(data, i)
			pages = append(pages, geom.PageMarkups{PageIndex: i, WidthPt: vec.PageWidthPt, HeightPt: vec.PageHeightPt})
		}
	}
	if len(pages) == 0 {
		return store.Job{}, fmt.Errorf("no pages in pdf")
	}
	title := strings.ReplaceAll(slug, "_", " ")
	job, err := s.store.UpsertJob(ctx, store.Job{
		Slug:      slug,
		Title:     title,
		Status:    store.StatusOriginal,
		ProjectID: projectID,
	})
	if err != nil {
		return store.Job{}, err
	}
	for _, pg := range pages {
		wPx := int(math.Round(coords.PtToPx75(pg.WidthPt)))
		hPx := int(math.Round(coords.PtToPx75(pg.HeightPt)))
		if wPx < 1 {
			wPx = 1
		}
		if hPx < 1 {
			hPx = 1
		}
		page := store.Page{
			JobID:      job.ID,
			PageIndex:  pg.PageIndex,
			PDFPage:    pg.PageIndex + 1,
			WidthPx75:  wPx,
			HeightPx75: hPx,
			WidthPt:    pg.WidthPt,
			HeightPt:   pg.HeightPt,
			RasterDPI:  coords.ImportDPI,
		}
		if err := s.store.UpsertPage(ctx, page); err != nil {
			return store.Job{}, err
		}
		boxes := boxesFromMarkups(pg.PageIndex, pg.Markups)
		payload := store.AnnotationPayload{JobID: job.ID, PageIndex: pg.PageIndex, Version: 0, Boxes: boxes}
		revKey := fmt.Sprintf("annotations/%s/p%d/v0.json", job.ID, pg.PageIndex)
		raw, _ := json.Marshal(payload)
		_ = s.blob.Put(revKey, raw, "application/json")
		if err := s.store.SaveRevision(ctx, store.Revision{
			JobID:      job.ID,
			PageIndex:  pg.PageIndex,
			Version:    0,
			AuthorID:   u.ID,
			StorageKey: revKey,
			Note:       "imported bluebeam",
			CreatedAt:  time.Now().UTC(),
		}, payload); err != nil {
			return store.Job{}, err
		}
	}
	if _, err := s.attachPDFBytes(ctx, job, data); err != nil {
		return store.Job{}, err
	}
	return s.store.GetJob(ctx, job.ID)
}

func boxesFromMarkups(pageIndex int, markups []geom.Markup) []store.Box {
	out := make([]store.Box, 0, len(markups))
	for i, m := range markups {
		pt, px, bPt, bPx := coords.FillBoxPolys(m.PolyPt, nil, [4]float64{}, [4]float64{})
		if pt == nil {
			continue
		}
		out = append(out, store.Box{
			ID:          fmt.Sprintf("markup-%d-%d", pageIndex, i),
			Class:       m.Class,
			Origin:      "imported",
			PolygonPt:   pt,
			PolygonPx75: px,
			BBoxPt:      bPt,
			BBoxPx75:    bPx,
			Category:    geom.ClassID(m.Class),
		})
	}
	return out
}

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request, _ auth.User) {
	projects, rootCount, err := s.store.ListProjects(r.Context())
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if projects == nil {
		projects = []store.Project{}
	}
	writeJSON(w, 200, map[string]any{"projects": projects, "root_job_count": rootCount})
}

func (s *Server) createProject(w http.ResponseWriter, r *http.Request, _ auth.User) {
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	proj, err := s.store.CreateProject(r.Context(), body.Name)
	if err != nil {
		status := 400
		if strings.Contains(err.Error(), "already exists") {
			status = http.StatusConflict
		}
		http.Error(w, err.Error(), status)
		return
	}
	writeJSON(w, 200, map[string]any{"project": proj})
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
	res, err := s.attachPDFBytes(r.Context(), job, data)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "page_count": res.PageCount, "sha256": res.SHA256})
}

func (s *Server) attachPDFBytes(ctx context.Context, job store.Job, data []byte) (pdfAttachResult, error) {
	if len(data) < 5 || string(data[:4]) != "%PDF" {
		return pdfAttachResult{}, fmt.Errorf("not a pdf")
	}
	data = geom.StripAnnots(data)
	sum := storage.SHA256Hex(data)
	key := fmt.Sprintf("pdfs/%s/%s.pdf", job.ID, sum)
	if err := s.blob.Put(key, data, "application/pdf"); err != nil {
		return pdfAttachResult{}, err
	}
	n := geom.PageCount(data)
	if n == 0 {
		n = 1
	}
	if err := s.store.SetDocument(ctx, job.ID, key, sum, n); err != nil {
		return pdfAttachResult{}, err
	}
	pages, _ := s.store.ListPages(ctx, job.ID)
	s.pool.Do(len(pages), func(i int) {
		p := pages[i]
		vec, err := geom.ExtractPage(data, p.PageIndex)
		if err != nil {
			log.Printf("extract %s p%d: %v", job.ID, p.PageIndex, err)
			return
		}
		if vec.PageWidthPt > 0 && coords.SimilarPageSize(p.WidthPt, p.HeightPt, vec.PageWidthPt, vec.PageHeightPt) {
			p.WidthPt = vec.PageWidthPt
			p.HeightPt = vec.PageHeightPt
		}
		vk := fmt.Sprintf("vectors/%s/p%d.json", job.ID, p.PageIndex)
		raw, _ := json.Marshal(vec)
		_ = s.blob.Put(vk, raw, "application/json")
		p.VectorsKey = vk
		p.PDFKey = key
		_ = s.store.UpsertPage(ctx, p)
	})
	job.Status = store.NormalizeStatus(job.Status)
	if err := s.store.UpdateJob(ctx, job); err != nil {
		return pdfAttachResult{}, err
	}
	fresh, err := s.store.GetJob(ctx, job.ID)
	if err != nil {
		fresh = job
		fresh.HasPDF = true
	}
	return pdfAttachResult{Job: fresh, Slug: job.Slug, PageCount: n, SHA256: sum}, nil
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
	// Sheet PDFs run to several MB and the storage key embeds the content hash,
	// so a revalidating client can be answered with a 304 instead of the body.
	etag := `"` + path.Base(strings.TrimSuffix(key, ".pdf")) + `"`
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
	if match := r.Header.Get("If-None-Match"); match != "" && strings.Contains(match, etag) {
		w.WriteHeader(http.StatusNotModified)
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
	if _, err := s.requireClaim(r.Context(), jobID, u); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
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
		pt, px, bPt, bPx := coords.FillBoxPolys(body.Boxes[i].PolygonPt, body.Boxes[i].PolygonPx75, body.Boxes[i].BBoxPt, body.Boxes[i].BBoxPx75)
		body.Boxes[i].PolygonPt = pt
		body.Boxes[i].PolygonPx75 = px
		body.Boxes[i].BBoxPt = bPt
		body.Boxes[i].BBoxPx75 = bPx
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
			if vec.PageWidthPt > 0 && coords.SimilarPageSize(page.WidthPt, page.HeightPt, vec.PageWidthPt, vec.PageHeightPt) {
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

func (s *Server) claimTTL() time.Duration {
	if s.cfg.ClaimTTL > 0 {
		return s.cfg.ClaimTTL
	}
	return store.DefaultClaimTTL
}

func (s *Server) requireClaim(ctx context.Context, jobID string, u auth.User) (store.Job, error) {
	job, err := s.store.GetJob(ctx, jobID)
	if err != nil {
		return store.Job{}, err
	}
	if store.NormalizeStatus(job.Status) == store.StatusComplete {
		return job, fmt.Errorf("job is complete")
	}
	return s.takeClaim(ctx, job, u)
}

func (s *Server) requireHolder(ctx context.Context, jobID string, u auth.User) (store.Job, error) {
	job, err := s.store.GetJob(ctx, jobID)
	if err != nil {
		return store.Job{}, err
	}
	return s.takeClaim(ctx, job, u)
}

func (s *Server) takeClaim(ctx context.Context, job store.Job, u auth.User) (store.Job, error) {
	now := time.Now().UTC()
	if job.HeldBy(u.ID, now) {
		return s.store.HeartbeatJob(ctx, job.ID, u.ID, s.claimTTL())
	}
	if !job.ClaimableBy(u.ID, now) {
		who := job.ClaimedEmail
		if who == "" {
			who = "another user"
		}
		return job, fmt.Errorf("claimed by %s", who)
	}
	if err := s.store.EnsureUser(ctx, u.ID, u.Email, u.Name); err != nil {
		log.Printf("ensure user: %v", err)
	}
	return s.store.ClaimJob(ctx, job.ID, u.ID, u.Email, s.claimTTL())
}

func (s *Server) claimJob(w http.ResponseWriter, r *http.Request, u auth.User) {
	if err := s.store.EnsureUser(r.Context(), u.ID, u.Email, u.Name); err != nil {
		log.Printf("ensure user: %v", err)
	}
	job, err := s.store.ClaimJob(r.Context(), r.PathValue("id"), u.ID, u.Email, s.claimTTL())
	if err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	writeJSON(w, 200, map[string]any{"job": job})
}

func (s *Server) heartbeatJob(w http.ResponseWriter, r *http.Request, u auth.User) {
	job, err := s.store.HeartbeatJob(r.Context(), r.PathValue("id"), u.ID, s.claimTTL())
	if err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	writeJSON(w, 200, map[string]any{"job": job})
}

func (s *Server) releaseJob(w http.ResponseWriter, r *http.Request, u auth.User) {
	job, err := s.store.ReleaseJob(r.Context(), r.PathValue("id"), u.ID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	writeJSON(w, 200, map[string]any{"job": job})
}

func (s *Server) claimNext(w http.ResponseWriter, r *http.Request, u auth.User) {
	stage := store.StatusOriginal
	if r.URL.Query().Get("stage") == string(store.StatusCorrected) {
		stage = store.StatusCorrected
	}
	if err := s.store.EnsureUser(r.Context(), u.ID, u.Email, u.Name); err != nil {
		log.Printf("ensure user: %v", err)
	}
	job, err := s.store.ClaimNext(r.Context(), u.ID, u.Email, stage, s.claimTTL(), r.URL.Query().Get("project"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	writeJSON(w, 200, map[string]any{"job": job})
}

func (s *Server) setStage(w http.ResponseWriter, r *http.Request, u auth.User) {
	var body struct {
		Stage store.JobStatus `json:"stage"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if err := s.store.EnsureUser(r.Context(), u.ID, u.Email, u.Name); err != nil {
		log.Printf("ensure user: %v", err)
	}
	if _, err := s.requireHolder(r.Context(), r.PathValue("id"), u); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	job, err := s.store.SetStage(r.Context(), r.PathValue("id"), u.ID, u.Email, body.Stage)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	writeJSON(w, 200, map[string]any{"job": job})
}

func (s *Server) listTags(w http.ResponseWriter, r *http.Request, _ auth.User) {
	tags, err := s.store.ListTags(r.Context())
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if tags == nil {
		tags = []store.Tag{}
	}
	writeJSON(w, 200, map[string]any{"tags": tags})
}

func (s *Server) listComments(w http.ResponseWriter, r *http.Request, _ auth.User) {
	jobID := r.PathValue("id")
	n, _ := strconv.Atoi(r.PathValue("n"))
	comments, err := s.store.ListPageComments(r.Context(), jobID, n)
	if err != nil {
		status := 500
		if strings.Contains(err.Error(), "not found") {
			status = 404
		}
		http.Error(w, err.Error(), status)
		return
	}
	if comments == nil {
		comments = []store.PageComment{}
	}
	writeJSON(w, 200, map[string]any{"comments": comments})
}

func (s *Server) createComment(w http.ResponseWriter, r *http.Request, u auth.User) {
	jobID := r.PathValue("id")
	n, _ := strconv.Atoi(r.PathValue("n"))
	var body struct {
		Body         string `json:"body"`
		AnnotationID string `json:"annotation_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if err := s.store.EnsureUser(r.Context(), u.ID, u.Email, u.Name); err != nil {
		log.Printf("ensure user: %v", err)
		http.Error(w, err.Error(), 500)
		return
	}
	comment, err := s.store.CreatePageComment(r.Context(), store.PageComment{
		JobID:        jobID,
		PageIndex:    n,
		AuthorID:     u.ID,
		AuthorEmail:  u.Email,
		AuthorName:   u.Name,
		Body:         body.Body,
		AnnotationID: body.AnnotationID,
	})
	if err != nil {
		msg := err.Error()
		status := 400
		if strings.Contains(msg, "not found") {
			status = 404
		}
		http.Error(w, msg, status)
		return
	}
	writeJSON(w, 200, map[string]any{"comment": comment})
}

func (s *Server) deleteComment(w http.ResponseWriter, r *http.Request, u auth.User) {
	err := s.store.DeletePageComment(r.Context(), r.PathValue("id"), r.PathValue("cid"), u.ID)
	if err != nil {
		msg := err.Error()
		status := 400
		switch {
		case strings.Contains(msg, "not found"):
			status = 404
		case strings.Contains(msg, "not the author"):
			status = http.StatusForbidden
		}
		http.Error(w, msg, status)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) setJobTags(w http.ResponseWriter, r *http.Request, _ auth.User) {
	var body struct {
		Tags []string `json:"tags"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if body.Tags == nil {
		body.Tags = []string{}
	}
	job, err := s.store.SetJobTags(r.Context(), r.PathValue("id"), body.Tags)
	if err != nil {
		msg := err.Error()
		status := 400
		if strings.Contains(msg, "not found") {
			status = 404
		}
		http.Error(w, msg, status)
		return
	}
	writeJSON(w, 200, map[string]any{"job": job})
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
	allowed := s.cfg.CORSOrigins
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if originAllowed(origin, allowed) {
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

func originAllowed(origin string, allowed []string) bool {
	if origin == "" {
		return false
	}
	for _, o := range allowed {
		if o == origin || wildcardOrigin(o, origin) {
			return true
		}
	}
	return false
}

// wildcardOrigin matches a single * in a CORS origin, e.g.
// https://*.vercel.app against https://collector-abc.vercel.app.
func wildcardOrigin(pattern, origin string) bool {
	prefix, suffix, ok := strings.Cut(pattern, "*")
	if !ok || prefix == "" {
		return false
	}
	if !strings.HasPrefix(origin, prefix) || !strings.HasSuffix(origin, suffix) {
		return false
	}
	mid := strings.TrimPrefix(origin, prefix)
	mid = strings.TrimSuffix(mid, suffix)
	return mid != "" && !strings.ContainsAny(mid, "/:@")
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func atoiDefault(raw string, fallback int) int {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return n
}

func bearerOf(r *http.Request) string {
	h := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}
