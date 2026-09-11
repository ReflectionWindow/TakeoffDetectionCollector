package main

import (
	"context"
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
	storeKind := "memory"
	var dbHealth func(context.Context) error

	if cfg.SupabaseDBURL != "" {
		db := openDatabase(cfg)
		st = store.NewPostgres(db, blob)
		storeKind = "postgres"
		dbHealth = db.PingContext
		go keepAlive(db, cfg.DBKeepAlive)
		log.Printf("store=postgres pool(open=%d idle=%d life=%s)", cfg.DBMaxOpenConns, cfg.DBMaxIdleConns, cfg.DBConnMaxLifetime)
	} else {
		log.Printf("store=memory (set SUPABASE_DB_URL when ready)")
	}

	srv := api.New(cfg, st, blob)
	srv.SetStoreHealth(storeKind, dbHealth)

	addr := ":" + cfg.Port
	log.Printf("collector listening on %s (dev_auth=%v)", addr, cfg.DevAuth)
	s := &http.Server{
		Addr:              addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 15 * time.Second,
		ReadTimeout:       15 * time.Minute,
		WriteTimeout:      15 * time.Minute,
		IdleTimeout:       2 * time.Minute,
	}
	log.Fatal(s.ListenAndServe())
}

// openDatabase opens a pooled connection to Postgres and blocks until the
// database answers, so a slow-starting database does not crash the service.
// Annotation payloads live in object storage, but every revision, page, and
// job row flows through this pool, so the pool is tuned to hold connections
// open for the life of the process instead of reconnecting on each request.
func openDatabase(cfg config.Config) *sql.DB {
	db, err := sql.Open("pgx", cfg.SupabaseDBURL)
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	db.SetMaxOpenConns(cfg.DBMaxOpenConns)
	db.SetMaxIdleConns(cfg.DBMaxIdleConns)
	db.SetConnMaxLifetime(cfg.DBConnMaxLifetime)
	db.SetConnMaxIdleTime(cfg.DBConnMaxIdleTime)

	deadline := time.Now().Add(30 * time.Second)
	for attempt := 1; ; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := db.PingContext(ctx)
		cancel()
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			log.Fatalf("database unreachable after retries: %v", err)
		}
		wait := time.Duration(attempt) * 500 * time.Millisecond
		if wait > 3*time.Second {
			wait = 3 * time.Second
		}
		log.Printf("waiting for database (attempt %d): %v", attempt, err)
		time.Sleep(wait)
	}
	return db
}

// keepAlive pings the pool on an interval so idle connections stay warm and a
// dropped connection is discovered proactively rather than on the next request.
func keepAlive(db *sql.DB, every time.Duration) {
	if every <= 0 {
		return
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for range ticker.C {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		if err := db.PingContext(ctx); err != nil {
			log.Printf("database keepalive ping failed: %v", err)
		}
		cancel()
	}
}
