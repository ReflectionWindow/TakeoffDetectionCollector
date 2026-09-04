package storage

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/config"
)

type Blob interface {
	Put(key string, data []byte, contentType string) error
	Get(key string) ([]byte, error)
	Exists(key string) bool
}

type Memory struct {
	mu   sync.RWMutex
	data map[string][]byte
}

func NewMemory() *Memory {
	return &Memory{data: map[string][]byte{}}
}

func (m *Memory) Put(key string, data []byte, _ string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := append([]byte{}, data...)
	m.data[key] = cp
	return nil
}

func (m *Memory) Get(key string) ([]byte, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	data, ok := m.data[key]
	if !ok {
		return nil, fmt.Errorf("missing %s", key)
	}
	return append([]byte{}, data...), nil
}

func (m *Memory) Exists(key string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.data[key]
	return ok
}

type Disk struct {
	root string
}

func NewDisk(root string) (*Disk, error) {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	return &Disk{root: root}, nil
}

func (d *Disk) path(key string) string {
	clean := filepath.Clean("/" + key)
	return filepath.Join(d.root, clean)
}

func (d *Disk) Put(key string, data []byte, _ string) error {
	p := d.path(key)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, data, 0o644)
}

func (d *Disk) Get(key string) ([]byte, error) {
	return os.ReadFile(d.path(key))
}

func (d *Disk) Exists(key string) bool {
	_, err := os.Stat(d.path(key))
	return err == nil
}

// Supabase talks to Storage REST when service-role is configured.
type Supabase struct {
	base   string
	key    string
	client *http.Client
	local  Blob
}

func NewSupabase(cfg config.Config, fallback Blob) Blob {
	if cfg.SupabaseURL == "" || cfg.SupabaseServiceRole == "" {
		return fallback
	}
	return &Supabase{
		base:   strings.TrimRight(cfg.SupabaseURL, "/") + "/storage/v1/object",
		key:    cfg.SupabaseServiceRole,
		client: &http.Client{},
		local:  fallback,
	}
}

func (s *Supabase) Put(key string, data []byte, contentType string) error {
	_ = s.local.Put(key, data, contentType)
	bucket, object := splitKey(key)
	url := s.base + "/" + bucket + "/" + object
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return err
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	req.Header.Set("Authorization", "Bearer "+s.key)
	req.Header.Set("apikey", s.key)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("x-upsert", "true")
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("storage put %s: %s %s", key, resp.Status, body)
	}
	return nil
}

func (s *Supabase) Get(key string) ([]byte, error) {
	if data, err := s.local.Get(key); err == nil {
		return data, nil
	}
	bucket, object := splitKey(key)
	url := s.base + "/" + bucket + "/" + object
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+s.key)
	req.Header.Set("apikey", s.key)
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("storage get %s: %s", key, resp.Status)
	}
	return io.ReadAll(resp.Body)
}

func (s *Supabase) Exists(key string) bool {
	if s.local.Exists(key) {
		return true
	}
	_, err := s.Get(key)
	return err == nil
}

func splitKey(key string) (bucket, object string) {
	key = strings.TrimPrefix(key, "/")
	i := strings.IndexByte(key, '/')
	if i < 0 {
		return key, ""
	}
	return key[:i], key[i+1:]
}

func SHA256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func Open(cfg config.Config) (Blob, error) {
	disk, err := NewDisk(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	return NewSupabase(cfg, disk), nil
}
