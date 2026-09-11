package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Port                string
	CORSOrigins         []string
	AllowedEmailDomain  string
	SupabaseURL         string
	SupabaseAnonKey     string
	SupabaseJWTSecret   string
	SupabaseServiceRole string
	SupabaseDBURL       string
	DataDir             string
	DevAuth             bool

	// Database pool tuning. Every job/page/revision row flows through this
	// pool, so connections are held open for the process lifetime.
	DBMaxOpenConns    int
	DBMaxIdleConns    int
	DBConnMaxLifetime time.Duration
	DBConnMaxIdleTime time.Duration
	DBKeepAlive       time.Duration

	IngestWorkers int
	ClaimTTL      time.Duration
}

func Load() Config {
	loadDotEnv()
	cors := splitCSV(env("CORS_ORIGINS", "http://localhost:5173,http://localhost:4173"))
	jwt := strings.TrimSpace(os.Getenv("SUPABASE_JWT_SECRET"))
	db := strings.TrimSpace(os.Getenv("SUPABASE_DB_URL"))
	return Config{
		Port:                env("PORT", "8080"),
		CORSOrigins:         cors,
		AllowedEmailDomain:  strings.TrimPrefix(env("ALLOWED_EMAIL_DOMAIN", "reflectionwindow.com"), "@"),
		SupabaseURL:         strings.TrimRight(strings.TrimSpace(os.Getenv("SUPABASE_URL")), "/"),
		SupabaseAnonKey:     strings.TrimSpace(os.Getenv("SUPABASE_ANON_KEY")),
		SupabaseJWTSecret:   jwt,
		SupabaseServiceRole: strings.TrimSpace(os.Getenv("SUPABASE_SERVICE_ROLE_KEY")),
		SupabaseDBURL:       db,
		DataDir:             env("DATA_DIR", "./data"),
		// JWT unset => Dev sign-in. DEV_AUTH=true keeps it on next to Supabase.
		DevAuth: jwt == "" || truthy(os.Getenv("DEV_AUTH")),

		DBMaxOpenConns:    IntEnv("DB_MAX_OPEN_CONNS", 16),
		DBMaxIdleConns:    IntEnv("DB_MAX_IDLE_CONNS", 8),
		DBConnMaxLifetime: DurationEnv("DB_CONN_MAX_LIFETIME", time.Hour),
		DBConnMaxIdleTime: DurationEnv("DB_CONN_MAX_IDLE_TIME", 30*time.Minute),
		DBKeepAlive:       DurationEnv("DB_KEEPALIVE", time.Minute),

		IngestWorkers: IntEnv("INGEST_WORKERS", 16),
		ClaimTTL:      DurationEnv("CLAIM_TTL", 24*time.Hour),
	}
}

func loadDotEnv() {
	for _, path := range []string{".env", "backend/.env", "TakeoffDetectionCollector/backend/.env"} {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			key, val, ok := strings.Cut(line, "=")
			if !ok {
				continue
			}
			key = strings.TrimSpace(key)
			if key == "" {
				continue
			}
			if _, exists := os.LookupEnv(key); exists {
				continue
			}
			os.Setenv(key, strings.TrimSpace(val))
		}
		return
	}
}

func truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func IntEnv(key string, fallback int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

// DurationEnv reads a Go duration string (e.g. "1h", "30m", "500ms"). A bare
// integer is treated as seconds for convenience.
func DurationEnv(key string, fallback time.Duration) time.Duration {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	if d, err := time.ParseDuration(v); err == nil {
		return d
	}
	if n, err := strconv.Atoi(v); err == nil {
		return time.Duration(n) * time.Second
	}
	return fallback
}
