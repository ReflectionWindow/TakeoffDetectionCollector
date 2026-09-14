// Command import-bluebeam creates collector jobs from marked-up elevation PDFs.
//
//	go run ./cmd/import-bluebeam --dir /path/to/bluebeam_markups
//	go run ./cmd/import-bluebeam --dir /path/to/bluebeam_markups --slugs slug_a,slug_b
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
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/storage"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/store"
)

func main() {
	dir := flag.String("dir", "", "folder of {slug}.pdf files")
	only := flag.String("slugs", "", "comma-separated slugs (default: every PDF whose slug is not in the database)")
	project := flag.String("project", "", "project name (created if missing). default Manila")
	cocoDir := flag.String("coco", "", "optional Roboflow export root to fill opening boxes and blackouts")
	replaceBoxes := flag.Bool("replace-boxes", false, "write COCO boxes as a new latest revision (undo auto-snap)")
	dryRun := flag.Bool("dry-run", false, "print matches without writing")
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

	projectID := ""
	if *project != "" {
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
		projectID = p.ID
	} else if p, err := st.GetProjectBySlug(ctx, store.ProjectManilaSlug); err == nil {
		projectID = p.ID
	}

	want := map[string]struct{}{}
	if *only != "" {
		for _, s := range strings.Split(*only, ",") {
			s = strings.TrimSpace(s)
			if s != "" {
				want[s] = struct{}{}
			}
		}
	}

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
		name := e.Name()
		if !strings.HasSuffix(strings.ToLower(name), ".pdf") {
			continue
		}
		slug := strings.TrimSuffix(name, filepath.Ext(name))
		if len(want) > 0 {
			if _, ok := want[slug]; !ok {
				continue
			}
		}
		jobID, exists := existing[slug]
		created := false
		if !exists {
			path := filepath.Join(*dir, name)
			if *dryRun {
				info, _ := e.Info()
				log.Printf("would import %s (%d bytes)", slug, info.Size())
				imported++
				created = true
			} else {
				data, err := os.ReadFile(path)
				if err != nil {
					log.Printf("read %s: %v", slug, err)
					failed++
					continue
				}
				job, err := srv.ImportBluebeamJob(ctx, projectID, slug, data)
				if err != nil {
					log.Printf("import %s: %v", slug, err)
					failed++
					continue
				}
				jobID = job.ID
				existing[slug] = jobID
				log.Printf("imported %s id=%s pages=%d", slug, job.ID, job.PageCount)
				imported++
				created = true
			}
		} else {
			log.Printf("skip pdf %s: already a job", slug)
			skipped++
		}
		if *cocoDir == "" || (!created && !*replaceBoxes) {
			continue
		}
		if jobID == "" && !*dryRun {
			continue
		}
		if coco.AnnotationFile(*cocoDir, slug) == "" {
			continue
		}
		nBoxes, nBlk, err := fillFromCoco(ctx, st, *cocoDir, slug, jobID, *dryRun, *replaceBoxes)
		if err != nil {
			log.Printf("coco %s: %v", slug, err)
			failed++
			continue
		}
		if nBoxes > 0 || nBlk > 0 {
			log.Printf("coco %s boxes=%d blackout_pages=%d", slug, nBoxes, nBlk)
			filled++
		}
	}
	for slug := range want {
		if _, ok := existing[slug]; ok {
			continue
		}
		if _, err := os.Stat(filepath.Join(*dir, slug+".pdf")); err != nil {
			log.Printf("missing pdf %s", slug)
			failed++
		}
	}
	fmt.Printf("imported=%d skipped=%d coco_filled=%d failed=%d dry_run=%v\n", imported, skipped, filled, failed, *dryRun)
}

func fillFromCoco(ctx context.Context, st store.Store, cocoDir, slug, jobID string, dryRun, replaceBoxes bool) (boxes, blackoutPages int, err error) {
	imp, err := coco.LoadJobDir(cocoDir, slug)
	if err != nil {
		return 0, 0, err
	}
	for page, rs := range imp.Blackouts {
		if len(rs) == 0 {
			continue
		}
		blackoutPages++
		if dryRun {
			continue
		}
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
		if dryRun {
			continue
		}
		version := 0
		var parent *int
		if latest, _, err := st.LatestRevision(ctx, jobID, page); err == nil {
			if replaceBoxes {
				n := latest.Version + 1
				version = n
				pv := latest.Version
				parent = &pv
			} else if latest.Version > 0 {
				continue
			}
		}
		payload := store.AnnotationPayload{JobID: jobID, PageIndex: page, Version: version, Boxes: pageBoxes}
		revKey := fmt.Sprintf("annotations/%s/p%d/v%d.json", jobID, page, version)
		if err := st.SaveRevision(ctx, store.Revision{
			JobID:         jobID,
			PageIndex:     page,
			Version:       version,
			ParentVersion: parent,
			StorageKey:    revKey,
			Note:          "imported coco",
			CreatedAt:     time.Now().UTC(),
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
