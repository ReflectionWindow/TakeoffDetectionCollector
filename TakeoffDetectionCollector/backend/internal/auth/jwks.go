package auth

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Supabase projects created with asymmetric JWT signing keys sign access
// tokens with ES256 (or RS256) instead of the legacy HS256 shared secret, so
// the shared secret alone cannot verify them. Keys are published as a JWKS and
// rotate, so they are fetched on demand and cached by key id.
type jwks struct {
	url    string
	client *http.Client

	mu       sync.RWMutex
	keys     map[string]crypto.PublicKey
	fetched  time.Time
	minRetry time.Duration
	ttl      time.Duration
}

func newJWKS(projectURL string) *jwks {
	projectURL = strings.TrimRight(strings.TrimSpace(projectURL), "/")
	if projectURL == "" {
		return nil
	}
	return &jwks{
		url:      projectURL + "/auth/v1/.well-known/jwks.json",
		client:   &http.Client{Timeout: 10 * time.Second},
		keys:     map[string]crypto.PublicKey{},
		minRetry: time.Minute,
		ttl:      time.Hour,
	}
}

func (j *jwks) keyByID(kid string) (crypto.PublicKey, error) {
	if j == nil {
		return nil, fmt.Errorf("jwks not configured")
	}
	j.mu.RLock()
	key, ok := j.keys[kid]
	stale := time.Since(j.fetched) > j.ttl
	lastFetch := j.fetched
	j.mu.RUnlock()
	if ok && !stale {
		return key, nil
	}
	// An unknown kid means the signing key rotated. Refetch, but not on every
	// request if the key is genuinely unknown.
	if !ok && !stale && time.Since(lastFetch) < j.minRetry {
		return nil, fmt.Errorf("unknown signing key %q", kid)
	}
	if err := j.refresh(); err != nil {
		if ok {
			return key, nil
		}
		return nil, err
	}
	j.mu.RLock()
	key, ok = j.keys[kid]
	j.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("unknown signing key %q", kid)
	}
	return key, nil
}

func (j *jwks) refresh() error {
	resp, err := j.client.Get(j.url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("jwks %s: %s", j.url, resp.Status)
	}
	var doc struct {
		Keys []struct {
			Kty string `json:"kty"`
			Kid string `json:"kid"`
			Crv string `json:"crv"`
			X   string `json:"x"`
			Y   string `json:"y"`
			N   string `json:"n"`
			E   string `json:"e"`
		} `json:"keys"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return err
	}
	keys := make(map[string]crypto.PublicKey, len(doc.Keys))
	for _, k := range doc.Keys {
		if k.Kid == "" {
			continue
		}
		switch k.Kty {
		case "EC":
			pub, err := ecPublicKey(k.Crv, k.X, k.Y)
			if err != nil {
				continue
			}
			keys[k.Kid] = pub
		case "RSA":
			pub, err := rsaPublicKey(k.N, k.E)
			if err != nil {
				continue
			}
			keys[k.Kid] = pub
		}
	}
	if len(keys) == 0 {
		return fmt.Errorf("jwks %s: no usable keys", j.url)
	}
	j.mu.Lock()
	j.keys = keys
	j.fetched = time.Now()
	j.mu.Unlock()
	return nil
}

func ecPublicKey(crv, x, y string) (*ecdsa.PublicKey, error) {
	var curve elliptic.Curve
	switch crv {
	case "P-256":
		curve = elliptic.P256()
	case "P-384":
		curve = elliptic.P384()
	case "P-521":
		curve = elliptic.P521()
	default:
		return nil, fmt.Errorf("unsupported curve %q", crv)
	}
	xb, err := base64.RawURLEncoding.DecodeString(x)
	if err != nil {
		return nil, err
	}
	yb, err := base64.RawURLEncoding.DecodeString(y)
	if err != nil {
		return nil, err
	}
	return &ecdsa.PublicKey{
		Curve: curve,
		X:     new(big.Int).SetBytes(xb),
		Y:     new(big.Int).SetBytes(yb),
	}, nil
}

func rsaPublicKey(n, e string) (*rsa.PublicKey, error) {
	nb, err := base64.RawURLEncoding.DecodeString(n)
	if err != nil {
		return nil, err
	}
	eb, err := base64.RawURLEncoding.DecodeString(e)
	if err != nil {
		return nil, err
	}
	exp := new(big.Int).SetBytes(eb)
	if !exp.IsInt64() {
		return nil, fmt.Errorf("rsa exponent too large")
	}
	return &rsa.PublicKey{N: new(big.Int).SetBytes(nb), E: int(exp.Int64())}, nil
}
