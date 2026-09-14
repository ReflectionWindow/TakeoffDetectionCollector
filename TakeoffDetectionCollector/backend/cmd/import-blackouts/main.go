// Command import-blackouts loads Roboflow COCO exports and writes the
// "blackout" class into page_blackouts so correctors do not redraw covers.
//
//	go run ./cmd/import-blackouts --dir /path/to/review
package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/blackout"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/coco"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/config"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/store"
)

func main() {
	dir := flag.String("dir", "", "Roboflow export root ({slug}/train/_annotations.coco.json)")
	dryRun := flag.Bool("dry-run", false, "print matches without writing")
	force := flag.Bool("force", false, "overwrite pages that already have blackouts")
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

	slugs, err := coco.DiscoverJobs(*dir)
	if err != nil {
		log.Fatal(err)
	}

	ctx := context.Background()
	pg := store.NewPostgres(db, nil)
	var jobs, pages, regions, skipped, missing, noBlackouts int
	for _, slug := range slugs {
		imp, err := coco.LoadJobDir(*dir, slug)
		if err != nil {
			log.Printf("skip %s: %v", slug, err)
			continue
		}
		nRegions := 0
		for _, rs := range imp.Blackouts {
			nRegions += len(rs)
		}
		if nRegions == 0 {
			noBlackouts++
			continue
		}
		ids, err := jobIDsBySlug(ctx, db, slug)
		if err != nil {
			log.Fatalf("lookup %s: %v", slug, err)
		}
		if len(ids) == 0 {
			log.Printf("missing job slug=%s (%d blackout regions)", slug, nRegions)
			missing++
			continue
		}
		jobs++
		for _, id := range ids {
			for page, rs := range imp.Blackouts {
				if len(rs) == 0 {
					continue
				}
				existing, err := pg.GetBlackouts(ctx, id, page)
				if err != nil {
					log.Fatalf("get %s page %d: %v", slug, page, err)
				}
				if len(existing) > 0 && !*force {
					log.Printf("skip %s page %d: already has %d regions", slug, page, len(existing))
					skipped++
					continue
				}
				if !*dryRun {
					if err := pg.SaveBlackouts(ctx, id, page, copyRegions(rs)); err != nil {
						log.Fatalf("save %s page %d: %v", slug, page, err)
					}
				}
				pages++
				regions += len(rs)
				verb := "wrote"
				if *dryRun {
					verb = "would write"
				}
				log.Printf("%s %s page %d (%d regions)", verb, slug, page, len(rs))
			}
		}
	}
	fmt.Printf("jobs=%d pages=%d regions=%d skipped=%d missing=%d unlabeled=%d dry_run=%v\n",
		jobs, pages, regions, skipped, missing, noBlackouts, *dryRun)
}

func jobIDsBySlug(ctx context.Context, db *sql.DB, slug string) ([]string, error) {
	ids, err := lookupSlug(ctx, db, slug)
	if err != nil || len(ids) > 0 {
		return ids, err
	}
	if alt, ok := slugAliases[slug]; ok {
		return lookupSlug(ctx, db, alt)
	}
	if stripped := strings.ReplaceAll(slug, "_tower_", "_"); stripped != slug {
		return lookupSlug(ctx, db, stripped)
	}
	return nil, nil
}

var slugAliases = map[string]string{
	"firefly_park_hotel_office_tower_frisco_tx": "firefly_park_hotel_office_frisco_tx",
}

func lookupSlug(ctx context.Context, db *sql.DB, slug string) ([]string, error) {
	rows, err := db.QueryContext(ctx, `select id::text from jobs where slug=$1`, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func copyRegions(rs []blackout.Region) []blackout.Region {
	out := make([]blackout.Region, len(rs))
	copy(out, rs)
	return out
}
