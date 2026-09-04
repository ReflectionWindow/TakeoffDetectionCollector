package auth

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/config"
)

var (
	ErrUnauthorized = errors.New("unauthorized")
	ErrDomain       = errors.New("email domain not allowed")
)

type User struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

type Service struct {
	cfg ConfigView
}

type ConfigView interface {
	Domain() string
	JWTSecret() string
	DevAuth() bool
}

type cfgAdapter struct{ c config.Config }

func (a cfgAdapter) Domain() string    { return a.c.AllowedEmailDomain }
func (a cfgAdapter) JWTSecret() string { return a.c.SupabaseJWTSecret }
func (a cfgAdapter) DevAuth() bool     { return a.c.DevAuth }

func New(c config.Config) *Service {
	return &Service{cfg: cfgAdapter{c}}
}

func (s *Service) DevEnabled() bool { return s.cfg.DevAuth() }

func (s *Service) DevUser() User {
	return User{
		ID:    "00000000-0000-0000-0000-000000000001",
		Email: "dev@" + s.cfg.Domain(),
		Name:  "Dev",
	}
}

func (s *Service) FromRequest(r *http.Request) (User, error) {
	raw := bearer(r.Header.Get("Authorization"))
	if raw == "" {
		return User{}, ErrUnauthorized
	}
	if s.cfg.DevAuth() {
		if raw == "dev" {
			return s.DevUser(), nil
		}
		// Accept a tiny unsigned JSON blob from /v1/auth/dev.
		if u, ok := parseDevToken(raw); ok {
			return u, nil
		}
	}
	if s.cfg.JWTSecret() == "" {
		return User{}, ErrUnauthorized
	}
	return s.parseSupabase(raw)
}

func (s *Service) parseSupabase(token string) (User, error) {
	claims := jwt.MapClaims{}
	parsed, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method")
		}
		return []byte(s.cfg.JWTSecret()), nil
	})
	if err != nil || !parsed.Valid {
		return User{}, ErrUnauthorized
	}
	email, _ := claims["email"].(string)
	sub, _ := claims["sub"].(string)
	name, _ := claims["name"].(string)
	if email == "" {
		if app, ok := claims["app_metadata"].(map[string]any); ok {
			email, _ = app["email"].(string)
		}
	}
	if user, ok := claims["user_metadata"].(map[string]any); ok && name == "" {
		name, _ = user["full_name"].(string)
		if name == "" {
			name, _ = user["name"].(string)
		}
	}
	email = strings.ToLower(strings.TrimSpace(email))
	if sub == "" || email == "" {
		return User{}, ErrUnauthorized
	}
	if !AllowedEmail(email, s.cfg.Domain()) {
		return User{}, ErrDomain
	}
	if name == "" {
		name = strings.Split(email, "@")[0]
	}
	return User{ID: sub, Email: email, Name: name}, nil
}

func AllowedEmail(email, domain string) bool {
	email = strings.ToLower(strings.TrimSpace(email))
	domain = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(domain), "@"))
	return strings.HasSuffix(email, "@"+domain)
}

func bearer(h string) string {
	h = strings.TrimSpace(h)
	if len(h) < 8 || !strings.EqualFold(h[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(h[7:])
}

type devClaims struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
	Exp   int64  `json:"exp"`
}

func IssueDevToken(u User) string {
	b, _ := json.Marshal(devClaims{
		ID:    u.ID,
		Email: u.Email,
		Name:  u.Name,
		Exp:   time.Now().Add(12 * time.Hour).Unix(),
	})
	return "dev." + string(b)
}

func parseDevToken(raw string) (User, bool) {
	if !strings.HasPrefix(raw, "dev.") {
		return User{}, false
	}
	var c devClaims
	if err := json.Unmarshal([]byte(raw[4:]), &c); err != nil {
		return User{}, false
	}
	if c.Exp > 0 && time.Now().Unix() > c.Exp {
		return User{}, false
	}
	if c.ID == "" || c.Email == "" {
		return User{}, false
	}
	return User{ID: c.ID, Email: c.Email, Name: c.Name}, true
}
