package auth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestAllowedEmail(t *testing.T) {
	if !AllowedEmail("stephen@reflectionwindow.com", "reflectionwindow.com") {
		t.Fatal("company email should pass")
	}
	if AllowedEmail("someone@gmail.com", "reflectionwindow.com") {
		t.Fatal("other domain should fail")
	}
}

type stubConfig struct {
	domain  string
	secret  string
	dev     bool
	project string
}

func (c stubConfig) Domain() string     { return c.domain }
func (c stubConfig) JWTSecret() string  { return c.secret }
func (c stubConfig) DevAuth() bool      { return c.dev }
func (c stubConfig) ProjectURL() string { return c.project }

// Projects with asymmetric JWT signing keys sign access tokens with ES256, so
// the shared secret cannot verify them; the key comes from the project JWKS.
func TestFromRequestAcceptsES256TokenFromJWKS(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	const kid = "test-key-1"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth/v1/.well-known/jwks.json" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]any{{
			"kty": "EC",
			"crv": "P-256",
			"kid": kid,
			"use": "sig",
			"alg": "ES256",
			"x":   base64.RawURLEncoding.EncodeToString(key.X.Bytes()),
			"y":   base64.RawURLEncoding.EncodeToString(key.Y.Bytes()),
		}}})
	}))
	defer srv.Close()

	token := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{
		"sub":   "11111111-2222-3333-4444-555555555555",
		"email": "stephen@reflectionwindow.com",
		"name":  "Stephen",
		"exp":   time.Now().Add(time.Hour).Unix(),
	})
	token.Header["kid"] = kid
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}

	svc := &Service{cfg: stubConfig{domain: "reflectionwindow.com", project: srv.URL}}
	req := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+signed)

	user, err := svc.FromRequest(req)
	if err != nil {
		t.Fatalf("expected ES256 token to verify: %v", err)
	}
	if user.Email != "stephen@reflectionwindow.com" {
		t.Fatalf("unexpected email %q", user.Email)
	}
}

func TestFromRequestRejectsForeignDomainES256(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	const kid = "test-key-2"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]any{{
			"kty": "EC",
			"crv": "P-256",
			"kid": kid,
			"x":   base64.RawURLEncoding.EncodeToString(key.X.Bytes()),
			"y":   base64.RawURLEncoding.EncodeToString(key.Y.Bytes()),
		}}})
	}))
	defer srv.Close()

	token := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{
		"sub":   "11111111-2222-3333-4444-555555555555",
		"email": "outsider@gmail.com",
		"exp":   time.Now().Add(time.Hour).Unix(),
	})
	token.Header["kid"] = kid
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}

	svc := &Service{cfg: stubConfig{domain: "reflectionwindow.com", project: srv.URL}}
	req := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+signed)

	if _, err := svc.FromRequest(req); err != ErrDomain {
		t.Fatalf("expected ErrDomain, got %v", err)
	}
}

func TestIssueDevTokenLastsAWeek(t *testing.T) {
	raw := IssueDevToken(User{ID: "1", Email: "dev@reflectionwindow.com", Name: "Dev"})
	if _, ok := parseDevToken(raw); !ok {
		t.Fatal("token should parse")
	}
	var c devClaims
	if err := json.Unmarshal([]byte(raw[4:]), &c); err != nil {
		t.Fatal(err)
	}
	left := time.Until(time.Unix(c.Exp, 0))
	if left < 6*24*time.Hour || left > 8*24*time.Hour {
		t.Fatalf("exp in %v, want ~7d", left)
	}
}

func TestParseDevTokenRejectsExpired(t *testing.T) {
	b, _ := json.Marshal(devClaims{
		ID:    "1",
		Email: "dev@reflectionwindow.com",
		Name:  "Dev",
		Exp:   time.Now().Add(-time.Minute).Unix(),
	})
	if _, ok := parseDevToken("dev." + string(b)); ok {
		t.Fatal("expired token should be rejected")
	}
}

func TestIssueSessionTokenLastsAWeek(t *testing.T) {
	const secret = "test-secret-test-secret-test-secret"
	svc := &Service{cfg: stubConfig{domain: "reflectionwindow.com", secret: secret}}
	u := User{ID: "11111111-2222-3333-4444-555555555555", Email: "stephen@reflectionwindow.com", Name: "Stephen"}
	token, err := svc.IssueSessionToken(u)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	got, err := svc.FromRequest(req)
	if err != nil {
		t.Fatal(err)
	}
	if got != u {
		t.Fatalf("got %+v want %+v", got, u)
	}
	parsed, err := jwt.Parse(token, func(t *jwt.Token) (any, error) {
		return []byte(secret), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	exp, err := parsed.Claims.(jwt.MapClaims).GetExpirationTime()
	if err != nil {
		t.Fatal(err)
	}
	left := time.Until(exp.Time)
	if left < 6*24*time.Hour || left > 8*24*time.Hour {
		t.Fatalf("exp in %v, want ~7d", left)
	}
}

func TestIssueSessionTokenRequiresSecret(t *testing.T) {
	svc := &Service{cfg: stubConfig{domain: "reflectionwindow.com"}}
	if _, err := svc.IssueSessionToken(User{ID: "1", Email: "a@reflectionwindow.com"}); err == nil {
		t.Fatal("expected error without jwt secret")
	}
}
