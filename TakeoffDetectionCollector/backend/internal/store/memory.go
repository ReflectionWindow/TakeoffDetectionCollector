package store

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/blackout"
)

type Memory struct {
	mu        sync.RWMutex
	jobs      map[string]Job
	bySlug    map[string]string
	pages     map[string]Page
	revisions map[string][]Revision
	payloads  map[string]AnnotationPayload
	blackouts map[string][]blackout.Region
	docs      map[string]string
}

func NewMemory() *Memory {
	return &Memory{
		jobs:      map[string]Job{},
		bySlug:    map[string]string{},
		pages:     map[string]Page{},
		revisions: map[string][]Revision{},
		payloads:  map[string]AnnotationPayload{},
		blackouts: map[string][]blackout.Region{},
		docs:      map[string]string{},
	}
}

func pageKey(jobID string, page int) string {
	return fmt.Sprintf("%s:%d", jobID, page)
}

func revKey(jobID string, page, version int) string {
	return fmt.Sprintf("%s:%d:%d", jobID, page, version)
}

func (m *Memory) EnsureUser(_ context.Context, _, _, _ string) error { return nil }

func (m *Memory) UpsertJob(_ context.Context, job Job) (Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if job.ID == "" {
		job.ID = fmt.Sprintf("job_%d", len(m.jobs)+1)
	}
	now := time.Now().UTC()
	if existing, ok := m.jobs[job.ID]; ok {
		job.CreatedAt = existing.CreatedAt
	} else if job.CreatedAt.IsZero() {
		job.CreatedAt = now
	}
	job.UpdatedAt = now
	m.jobs[job.ID] = job
	m.bySlug[job.Slug] = job.ID
	return job, nil
}

func (m *Memory) GetJob(_ context.Context, id string) (Job, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	job, ok := m.jobs[id]
	if !ok {
		return Job{}, fmt.Errorf("job not found")
	}
	return m.withCounts(job), nil
}

func (m *Memory) GetJobBySlug(_ context.Context, slug string) (Job, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	id, ok := m.bySlug[slug]
	if !ok {
		return Job{}, fmt.Errorf("job not found")
	}
	return m.withCounts(m.jobs[id]), nil
}

func (m *Memory) ListJobs(_ context.Context) ([]Job, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Job, 0, len(m.jobs))
	for _, j := range m.jobs {
		out = append(out, m.withCounts(j))
	}
	return out, nil
}

func (m *Memory) UpdateJob(_ context.Context, job Job) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.jobs[job.ID]; !ok {
		return fmt.Errorf("job not found")
	}
	job.UpdatedAt = time.Now().UTC()
	m.jobs[job.ID] = job
	return nil
}

func (m *Memory) withCounts(job Job) Job {
	n := 0
	boxes := 0
	for key, p := range m.pages {
		if p.JobID != job.ID {
			continue
		}
		n++
		_ = key
		if revs := m.revisions[pageKey(job.ID, p.PageIndex)]; len(revs) > 0 {
			latest := revs[len(revs)-1]
			if payload, ok := m.payloads[revKey(job.ID, p.PageIndex, latest.Version)]; ok {
				boxes += len(payload.Boxes)
			}
		}
	}
	job.PageCount = n
	job.BoxCount = boxes
	_, job.HasPDF = m.docs[job.ID]
	if job.HasPDF && (job.Status == StatusImported || job.Status == StatusAwaitingPDF) {
		job.Status = StatusReady
	}
	if !job.HasPDF && job.Status == StatusImported {
		job.Status = StatusAwaitingPDF
	}
	return job
}

func (m *Memory) UpsertPage(_ context.Context, page Page) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pages[pageKey(page.JobID, page.PageIndex)] = page
	return nil
}

func (m *Memory) ListPages(_ context.Context, jobID string) ([]Page, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []Page
	for _, p := range m.pages {
		if p.JobID == jobID {
			if key, ok := m.docs[jobID]; ok {
				p.PDFKey = key
			}
			out = append(out, p)
		}
	}
	return out, nil
}

func (m *Memory) GetPage(_ context.Context, jobID string, pageIndex int) (Page, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	p, ok := m.pages[pageKey(jobID, pageIndex)]
	if !ok {
		return Page{}, fmt.Errorf("page not found")
	}
	if key, ok := m.docs[jobID]; ok {
		p.PDFKey = key
	}
	return p, nil
}

func (m *Memory) SetDocument(_ context.Context, jobID, storageKey, sha256 string, pageCount int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	_ = sha256
	_ = pageCount
	m.docs[jobID] = storageKey
	if job, ok := m.jobs[jobID]; ok {
		job.Status = StatusReady
		job.UpdatedAt = time.Now().UTC()
		m.jobs[jobID] = job
	}
	return nil
}

func (m *Memory) SaveRevision(_ context.Context, rev Revision, payload AnnotationPayload) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := pageKey(rev.JobID, rev.PageIndex)
	m.revisions[key] = append(m.revisions[key], rev)
	m.payloads[revKey(rev.JobID, rev.PageIndex, rev.Version)] = payload
	return nil
}

func (m *Memory) LatestRevision(_ context.Context, jobID string, pageIndex int) (Revision, AnnotationPayload, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	revs := m.revisions[pageKey(jobID, pageIndex)]
	if len(revs) == 0 {
		return Revision{}, AnnotationPayload{}, fmt.Errorf("no revisions")
	}
	rev := revs[len(revs)-1]
	return rev, m.payloads[revKey(jobID, pageIndex, rev.Version)], nil
}

func (m *Memory) GetRevision(_ context.Context, jobID string, pageIndex, version int) (Revision, AnnotationPayload, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	payload, ok := m.payloads[revKey(jobID, pageIndex, version)]
	if !ok {
		return Revision{}, AnnotationPayload{}, fmt.Errorf("revision not found")
	}
	for _, r := range m.revisions[pageKey(jobID, pageIndex)] {
		if r.Version == version {
			return r, payload, nil
		}
	}
	return Revision{JobID: jobID, PageIndex: pageIndex, Version: version}, payload, nil
}

func (m *Memory) ListRevisions(_ context.Context, jobID string, pageIndex int) ([]Revision, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	revs := append([]Revision{}, m.revisions[pageKey(jobID, pageIndex)]...)
	return revs, nil
}

func (m *Memory) SaveBlackouts(_ context.Context, jobID string, page int, regions []blackout.Region) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.blackouts[pageKey(jobID, page)] = append([]blackout.Region{}, regions...)
	return nil
}

func (m *Memory) GetBlackouts(_ context.Context, jobID string, page int) ([]blackout.Region, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return append([]blackout.Region{}, m.blackouts[pageKey(jobID, page)]...), nil
}
