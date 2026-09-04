package main

import (
	"database/sql"
	"log"
	"net/http"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/api"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/config"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/storage"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/store"
)

func main() {
	cfg := config.Load()
	blob, err := storage.Open(cfg)
	if err != nil {
		log.Fatal(err)
	}
	var st store.Store = store.NewMemory()
	if cfg.SupabaseDBURL != "" {
		db, err := sql.Open("pgx", cfg.SupabaseDBURL)
		if err != nil {
			log.Fatal(err)
		}
		db.SetMaxOpenConns(16)
		st = store.NewPostgres(db, blob)
		log.Printf("store=postgres")
	} else {
		log.Printf("store=memory (set SUPABASE_DB_URL when ready)")
	}
	srv := api.New(cfg, st, blob)
	addr := ":" + cfg.Port
	log.Printf("collector listening on %s (dev_auth=%v)", addr, cfg.DevAuth)
	s := &http.Server{
		Addr:              addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 15 * time.Second,
	}
	log.Fatal(s.ListenAndServe())
}
