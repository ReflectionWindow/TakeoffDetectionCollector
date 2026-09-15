// Command import-objstm-jobs uploads leftover Bluebeam PDFs whose page
// dictionaries live in compressed object streams (the generic importer used
// to report "no pages in pdf" for these).
//
//	go run ./cmd/import-objstm-jobs \
//	  --dir /path/to/bluebeam_markups \
//	  --coco /path/to/review \
//	  --project "Bad Jobs"
package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/api"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/coco"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/config"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/geom"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/storage"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/store"
)

func main() {
	dir := flag.String("dir", "", "folder of {slug}.pdf files")
	project := flag.String("project", "Bad Jobs", "project name (created if missing)")
	cocoDir := flag.String("coco", "", "optional Roboflow export root to fill opening boxes and blackouts")
	dryRun := flag.Bool("dry-run", false, "print leftovers without writing")
	flag.Parse()
	if *dir == "" {
		flag.Usage()
		os.Exit(2)
	}

	cfg := config.Load()
	if cfg.SupabaseDBURL == "" {
		log.Fatal("SUPABASE_DB_URL is empty")
	}
	url := cfg.SupabaseDBURL
	if !strings.Contains(url, "sslmode=") {
		if strings.Contains(url, "?") {
			url += "&sslmode=require"
		} else {
			url += "?sslmode=require"
		}
	}
	db, err := sql.Open("pgx", url)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		log.Fatalf("database: %v", err)
	}

	blob, err := storage.Open(cfg)
	if err != nil {
		log.Fatal(err)
	}
	st := store.NewPostgres(db, blob)
	srv := api.New(cfg, st, blob)
	ctx := context.Background()

	name, slug, err := store.NormalizeProjectName(*project)
	if err != nil {
		log.Fatal(err)
	}
	p, err := st.GetProjectBySlug(ctx, slug)
	if err != nil {
		if *dryRun {
			log.Printf("would create project %q (slug %s)", name, slug)
		} else {
			p, err = st.CreateProject(ctx, name)
			if err != nil {
				log.Fatal(err)
			}
			log.Printf("created project %s id=%s", p.Name, p.ID)
		}
	} else {
		log.Printf("using project %s id=%s", p.Name, p.ID)
	}
	projectID := p.ID

	existing, err := existingJobs(ctx, db)
	if err != nil {
		log.Fatal(err)
	}

	entries, err := os.ReadDir(*dir)
	if err != nil {
		log.Fatal(err)
	}

	var imported, skipped, failed, filled int
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		fname := e.Name()
		if !strings.HasSuffix(strings.ToLower(fname), ".pdf") {
			continue
		}
		jobSlug := strings.TrimSuffix(fname, filepath.Ext(fname))
		if jobID, ok := existing[jobSlug]; ok {
			log.Printf("skip %s: already a job %s", jobSlug, jobID)
			skipped++
			continue
		}
		path := filepath.Join(*dir, fname)
		data, err := os.ReadFile(path)
		if err != nil {
			log.Printf("read %s: %v", jobSlug, err)
			failed++
			continue
		}
		nPages := geom.PageCount(data)
		nMarkups := 0
		for _, pg := range geom.ExtractMarkups(data) {
			nMarkups += len(pg.Markups)
		}
		if nPages == 0 {
			log.Printf("still no pages %s (%d bytes)", jobSlug, len(data))
			failed++
			continue
		}
		log.Printf("leftover %s pages=%d markups=%d bytes=%d", jobSlug, nPages, nMarkups, len(data))
		if *dryRun {
			imported++
			continue
		}
		job, err := srv.ImportBluebeamJob(ctx, projectID, jobSlug, data)
		if err != nil {
			log.Printf("import %s: %v", jobSlug, err)
			failed++
			continue
		}
		existing[jobSlug] = job.ID
		log.Printf("imported %s id=%s pages=%d", jobSlug, job.ID, job.PageCount)
		imported++
		if *cocoDir == "" || coco.AnnotationFile(*cocoDir, jobSlug) == "" {
			continue
		}
		nBoxes, nBlk, err := fillFromCoco(ctx, st, *cocoDir, jobSlug, job.ID)
		if err != nil {
			log.Printf("coco %s: %v", jobSlug, err)
			failed++
			continue
		}
		if nBoxes > 0 || nBlk > 0 {
			log.Printf("coco %s boxes=%d blackout_pages=%d", jobSlug, nBoxes, nBlk)
			filled++
		}
	}
	fmt.Printf("imported=%d skipped=%d coco_filled=%d failed=%d dry_run=%v\n", imported, skipped, filled, failed, *dryRun)
}

func fillFromCoco(ctx context.Context, st store.Store, cocoDir, slug, jobID string) (boxes, blackoutPages int, err error) {
	imp, err := coco.LoadJobDir(cocoDir, slug)
	if err != nil {
		return 0, 0, err
	}
	for page, rs := range imp.Blackouts {
		if len(rs) == 0 {
			continue
		}
		blackoutPages++
		existing, err := st.GetBlackouts(ctx, jobID, page)
		if err != nil {
			return boxes, blackoutPages, err
		}
		if len(existing) > 0 {
			continue
		}
		if err := st.SaveBlackouts(ctx, jobID, page, rs); err != nil {
			return boxes, blackoutPages, err
		}
	}
	for page, pageBoxes := range imp.ByPage {
		if len(pageBoxes) == 0 {
			continue
		}
		boxes += len(pageBoxes)
		version := 0
		if latest, _, err := st.LatestRevision(ctx, jobID, page); err == nil && latest.Version > 0 {
			continue
		}
		payload := store.AnnotationPayload{JobID: jobID, PageIndex: page, Version: version, Boxes: pageBoxes}
		revKey := fmt.Sprintf("annotations/%s/p%d/v%d.json", jobID, page, version)
		if err := st.SaveRevision(ctx, store.Revision{
			JobID:      jobID,
			PageIndex:  page,
			Version:    version,
			StorageKey: revKey,
			Note:       "imported coco",
			CreatedAt:  time.Now().UTC(),
		}, payload); err != nil {
			return boxes, blackoutPages, err
		}
	}
	return boxes, blackoutPages, nil
}

func existingJobs(ctx context.Context, db *sql.DB) (map[string]string, error) {
	rows, err := db.QueryContext(ctx, `select slug, id::text from jobs`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var slug, id string
		if err := rows.Scan(&slug, &id); err != nil {
			return nil, err
		}
		out[slug] = id
	}
	return out, rows.Err()
}
