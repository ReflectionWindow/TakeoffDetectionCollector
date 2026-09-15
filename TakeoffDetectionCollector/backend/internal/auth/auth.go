package auth

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
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

// SessionTTL is how long a collector login lasts after Microsoft or Dev sign-in.
// Microsoft access tokens are ~1h and the frontend then drops the Supabase
// refresh session, so we mint our own token for this window.
const SessionTTL = 7 * 24 * time.Hour

type User struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

type Service struct {
	cfg  ConfigView
	jwks *jwks
}

type ConfigView interface {
	Domain() string
	JWTSecret() string
	DevAuth() bool
}

// ProjectURLView is implemented by configs that know the Supabase project URL,
// which is where asymmetric (ES256/RS256) signing keys are published.
type ProjectURLView interface {
	ProjectURL() string
}

type cfgAdapter struct{ c config.Config }

func (a cfgAdapter) Domain() string     { return a.c.AllowedEmailDomain }
func (a cfgAdapter) JWTSecret() string  { return a.c.SupabaseJWTSecret }
func (a cfgAdapter) DevAuth() bool      { return a.c.DevAuth }
func (a cfgAdapter) ProjectURL() string { return a.c.SupabaseURL }

func New(c config.Config) *Service {
	return &Service{cfg: cfgAdapter{c}, jwks: newJWKS(c.SupabaseURL)}
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
	return s.FromToken(bearer(r.Header.Get("Authorization")))
}

func (s *Service) FromToken(raw string) (User, error) {
	raw = strings.TrimSpace(raw)
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
	if s.cfg.JWTSecret() == "" && s.signingKeys() == nil {
		return User{}, ErrUnauthorized
	}
	return s.parseSupabase(raw)
}

const unloadTokenMaxBytes = 16 << 10

// FromUnloadBody reads a bearer token from a text/plain body so tab-close
// can release a claim via sendBeacon without a CORS preflight.
func (s *Service) FromUnloadBody(r *http.Request) (User, error) {
	ct := strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Type")))
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = strings.TrimSpace(ct[:i])
	}
	if ct != "" && ct != "text/plain" {
		return User{}, ErrUnauthorized
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, unloadTokenMaxBytes))
	if err != nil {
		return User{}, ErrUnauthorized
	}
	raw := strings.TrimSpace(string(body))
	if t := bearer(raw); t != "" {
		raw = t
	}
	return s.FromToken(raw)
}

// signingKeys returns the JWKS client, lazily built when the config knows the
// project URL but the service was constructed without one (e.g. in tests).
func (s *Service) signingKeys() *jwks {
	if s.jwks != nil {
		return s.jwks
	}
	if v, ok := s.cfg.(ProjectURLView); ok {
		s.jwks = newJWKS(v.ProjectURL())
	}
	return s.jwks
}

// verificationKey picks the key for the token's algorithm: the legacy shared
// secret for HS256, or the project's published JWKS key for ES256/RS256.
func (s *Service) verificationKey(t *jwt.Token) (any, error) {
	switch t.Method.(type) {
	case *jwt.SigningMethodHMAC:
		secret := s.cfg.JWTSecret()
		if secret == "" {
			return nil, fmt.Errorf("no jwt secret configured")
		}
		return []byte(secret), nil
	case *jwt.SigningMethodECDSA, *jwt.SigningMethodRSA:
		kid, _ := t.Header["kid"].(string)
		if kid == "" {
			return nil, fmt.Errorf("token has no kid")
		}
		return s.signingKeys().keyByID(kid)
	default:
		return nil, fmt.Errorf("unexpected signing method %s", t.Method.Alg())
	}
}

func (s *Service) parseSupabase(token string) (User, error) {
	claims := jwt.MapClaims{}
	parsed, err := jwt.ParseWithClaims(token, claims, s.verificationKey)
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
		Exp:   time.Now().Add(SessionTTL).Unix(),
	})
	return "dev." + string(b)
}

// IssueSessionToken mints an HS256 collector JWT valid for SessionTTL. Used
// after a short-lived Supabase access token has already been verified.
func (s *Service) IssueSessionToken(u User) (string, error) {
	secret := s.cfg.JWTSecret()
	if secret == "" {
		return "", fmt.Errorf("no jwt secret configured")
	}
	now := time.Now()
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub":   u.ID,
		"email": u.Email,
		"name":  u.Name,
		"iat":   now.Unix(),
		"exp":   now.Add(SessionTTL).Unix(),
	})
	return t.SignedString([]byte(secret))
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
