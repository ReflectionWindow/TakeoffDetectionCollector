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
	Delete(key string) error
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

func (m *Memory) Delete(key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.data, key)
	return nil
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

func (d *Disk) Delete(key string) error {
	err := os.Remove(d.path(key))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// Supabase talks to Storage REST when service-role is configured.
type Supabase struct {
	base   string
	key    string
	client *http.Client
	local  Blob
}

var requiredBuckets = []string{"pdfs", "coco", "annotations", "rasters", "vectors"}

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

func (s *Supabase) bucketAPI() string {
	return strings.TrimSuffix(s.base, "/object") + "/bucket"
}

func (s *Supabase) EnsureBuckets() error {
	for _, name := range requiredBuckets {
		payload := []byte(`{"id":"` + name + `","name":"` + name + `","public":false}`)
		req, err := http.NewRequest(http.MethodPost, s.bucketAPI(), bytes.NewReader(payload))
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+s.key)
		req.Header.Set("apikey", s.key)
		req.Header.Set("Content-Type", "application/json")
		resp, err := s.client.Do(req)
		if err != nil {
			return fmt.Errorf("create bucket %s: %w", name, err)
		}
		respBody, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusCreated || resp.StatusCode == http.StatusConflict {
			continue
		}
		msg := strings.ToLower(string(respBody))
		if strings.Contains(msg, "already exist") || strings.Contains(msg, "duplicate") {
			continue
		}
		return fmt.Errorf("create bucket %s: %s %s", name, resp.Status, respBody)
	}
	return nil
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

func (s *Supabase) Delete(key string) error {
	_ = s.local.Delete(key)
	bucket, object := splitKey(key)
	if bucket == "" || object == "" {
		return nil
	}
	url := s.base + "/" + bucket + "/" + object
	req, err := http.NewRequest(http.MethodDelete, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+s.key)
	req.Header.Set("apikey", s.key)
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 && resp.StatusCode != http.StatusNotFound {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("storage delete %s: %s %s", key, resp.Status, body)
	}
	return nil
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
	blob := NewSupabase(cfg, disk)
	if s, ok := blob.(*Supabase); ok {
		if err := s.EnsureBuckets(); err != nil {
			return nil, err
		}
	}
	return blob, nil
}
