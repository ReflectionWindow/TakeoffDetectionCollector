package main

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/config"
)

func main() {
	cfg := config.Load()
	if cfg.SupabaseDBURL == "" {
		fmt.Fprintln(os.Stderr, "SUPABASE_DB_URL is empty")
		os.Exit(2)
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
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer db.Close()

	root := "supabase/migrations"
	if _, err := os.Stat(root); err != nil {
		root = "../supabase/migrations"
	}
	files, err := filepath.Glob(filepath.Join(root, "*.sql"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if len(files) == 0 {
		fmt.Fprintln(os.Stderr, "no migration files found")
		os.Exit(1)
	}
	sort.Strings(files)
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if _, err := db.Exec(string(b)); err != nil {
			fmt.Fprintf(os.Stderr, "%s: %v\n", f, err)
			os.Exit(1)
		}
		fmt.Println("applied", filepath.Base(f))
	}
	var n int
	if err := db.QueryRow("select count(*) from jobs").Scan(&n); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println("jobs", n)
}
