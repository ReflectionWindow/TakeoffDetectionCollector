package config

import (
	"os"
	"strconv"
	"strings"
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
}

func Load() Config {
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
		DevAuth:             jwt == "",
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
