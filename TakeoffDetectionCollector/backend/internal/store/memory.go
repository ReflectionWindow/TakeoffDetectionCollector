package store

import (
	"context"
	"crypto/rand"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/blackout"
)

type Memory struct {
	mu        sync.RWMutex
	jobs      map[string]Job
	bySlug    map[string]string
	projects  map[string]Project
	pages     map[string]Page
	revisions map[string][]Revision
	payloads  map[string]AnnotationPayload
	blackouts map[string][]blackout.Region
	docs      map[string]string
	tags      map[string]Tag
	comments  map[string]PageComment
}

func NewMemory() *Memory {
	now := time.Now().UTC()
	return &Memory{
		jobs:   map[string]Job{},
		bySlug: map[string]string{},
		projects: map[string]Project{
			ProjectManilaID:  {ID: ProjectManilaID, Slug: ProjectManilaSlug, Name: "Manila", CreatedAt: now},
			ProjectChicagoID: {ID: ProjectChicagoID, Slug: ProjectChicagoSlug, Name: "Chicago", CreatedAt: now},
		},
		pages:     map[string]Page{},
		revisions: map[string][]Revision{},
		payloads:  map[string]AnnotationPayload{},
		blackouts: map[string][]blackout.Region{},
		docs:      map[string]string{},
		tags:      map[string]Tag{},
		comments:  map[string]PageComment{},
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
		if job.Tags == nil {
			job.Tags = copyTags(existing.Tags)
		}
		if job.ProjectID == "" {
			job.ProjectID = existing.ProjectID
		}
		oldKey := slugKey(existing.ProjectID, existing.Slug)
		if oldKey != slugKey(job.ProjectID, job.Slug) {
			delete(m.bySlug, oldKey)
		}
	} else if job.CreatedAt.IsZero() {
		job.CreatedAt = now
	}
	key := slugKey(job.ProjectID, job.Slug)
	if id, ok := m.bySlug[key]; ok && id != job.ID {
		return Job{}, fmt.Errorf("job slug already exists")
	}
	if job.Tags == nil {
		job.Tags = []string{}
	}
	if p, ok := m.projects[job.ProjectID]; ok {
		job.ProjectName = p.Name
	} else if job.ProjectID == "" {
		job.ProjectName = ""
	}
	job.UpdatedAt = now
	m.jobs[job.ID] = job
	m.bySlug[key] = job.ID
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

func (m *Memory) GetJobBySlug(_ context.Context, projectID, slug string) (Job, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	id, ok := m.bySlug[slugKey(projectID, slug)]
	if !ok {
		return Job{}, fmt.Errorf("job not found")
	}
	return m.withCounts(m.jobs[id]), nil
}

func (m *Memory) ListJobs(_ context.Context, q JobListQuery) (JobList, error) {
	q = q.Normalized()
	m.mu.RLock()
	defer m.mu.RUnlock()
	all := make([]Job, 0, len(m.jobs))
	for _, j := range m.jobs {
		all = append(all, m.withCounts(j))
	}
	sort.Slice(all, func(i, j int) bool { return all[i].Slug < all[j].Slug })

	var counts StageCounts
	tagN := map[string]int{}
	tagName := map[string]string{}
	matched := make([]Job, 0, len(all))
	for _, job := range all {
		st := NormalizeStatus(job.Status)
		if jobMatchesSearch(job, q) && jobMatchesTags(job, q.Tags) {
			counts.All++
			switch st {
			case StatusCorrected:
				counts.Corrected++
			case StatusComplete:
				counts.Complete++
			default:
				counts.Original++
			}
		}
		if jobMatchesSearch(job, q) && (q.Stage == "" || st == q.Stage) {
			seen := map[string]struct{}{}
			for _, name := range job.Tags {
				key := strings.ToLower(name)
				if _, ok := seen[key]; ok {
					continue
				}
				seen[key] = struct{}{}
				tagN[key]++
				if _, ok := tagName[key]; !ok {
					tagName[key] = name
				}
			}
		}
		if jobMatchesList(job, q) {
			matched = append(matched, job)
		}
	}
	total := len(matched)
	if q.Offset > total {
		q.Offset = total
	}
	end := q.Offset + q.Limit
	if end > total {
		end = total
	}
	page := matched[q.Offset:end]
	tagCounts := make([]TagCount, 0, len(tagN))
	for key, n := range tagN {
		tagCounts = append(tagCounts, TagCount{Name: tagName[key], Count: n})
	}
	sort.Slice(tagCounts, func(i, j int) bool {
		return strings.ToLower(tagCounts[i].Name) < strings.ToLower(tagCounts[j].Name)
	})
	return JobList{Jobs: page, Total: total, Limit: q.Limit, Offset: q.Offset, Counts: counts, TagCounts: tagCounts}, nil
}

func (m *Memory) DeleteJob(_ context.Context, id string) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	job, ok := m.jobs[id]
	if !ok {
		return nil, fmt.Errorf("job not found")
	}
	delete(m.jobs, id)
	delete(m.bySlug, slugKey(job.ProjectID, job.Slug))
	delete(m.docs, id)
	for key, p := range m.pages {
		if p.JobID == id {
			delete(m.pages, key)
			delete(m.revisions, pageKey(id, p.PageIndex))
			delete(m.blackouts, pageKey(id, p.PageIndex))
		}
	}
	for key := range m.payloads {
		if strings.HasPrefix(key, id+":") {
			delete(m.payloads, key)
		}
	}
	for cid, c := range m.comments {
		if c.JobID == id {
			delete(m.comments, cid)
		}
	}
	m.pruneUnusedTagsLocked()
	return nil, nil
}

func (m *Memory) UpdateJob(_ context.Context, job Job) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	existing, ok := m.jobs[job.ID]
	if !ok {
		return fmt.Errorf("job not found")
	}
	if job.Tags == nil {
		job.Tags = copyTags(existing.Tags)
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
	job.Status = NormalizeStatus(job.Status)
	job.Tags = copyTags(job.Tags)
	if p, ok := m.projects[job.ProjectID]; ok {
		job.ProjectName = p.Name
	} else {
		job.ProjectName = ""
	}
	return job
}

func copyTags(in []string) []string {
	if len(in) == 0 {
		return []string{}
	}
	out := make([]string, len(in))
	copy(out, in)
	return out
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
		job.Status = NormalizeStatus(job.Status)
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

func (m *Memory) takeJobLocked(id string) (Job, error) {
	job, ok := m.jobs[id]
	if !ok {
		return Job{}, fmt.Errorf("job not found")
	}
	return job, nil
}

func (m *Memory) putClaim(job Job, userID, email string, ttl time.Duration) Job {
	exp := time.Now().UTC().Add(ttl)
	job.ClaimedBy = userID
	job.ClaimedEmail = email
	job.ClaimExpiresAt = &exp
	job.UpdatedAt = time.Now().UTC()
	m.jobs[job.ID] = job
	return m.withCounts(job)
}

func (m *Memory) ClaimJob(_ context.Context, jobID, userID, email string, ttl time.Duration) (Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	job, err := m.takeJobLocked(jobID)
	if err != nil {
		return Job{}, err
	}
	job = m.withCounts(job)
	if !job.ClaimableBy(userID, time.Now().UTC()) {
		return Job{}, fmt.Errorf("job claimed by %s", job.ClaimedEmail)
	}
	return m.putClaim(job, userID, email, ttl), nil
}

func (m *Memory) HeartbeatJob(_ context.Context, jobID, userID string, ttl time.Duration) (Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	job, err := m.takeJobLocked(jobID)
	if err != nil {
		return Job{}, err
	}
	job = m.withCounts(job)
	if !job.HeldBy(userID, time.Now().UTC()) {
		return Job{}, fmt.Errorf("not the claimant")
	}
	return m.putClaim(job, userID, job.ClaimedEmail, ttl), nil
}

func (m *Memory) ReleaseJob(_ context.Context, jobID, userID string) (Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	job, err := m.takeJobLocked(jobID)
	if err != nil {
		return Job{}, err
	}
	job = m.withCounts(job)
	if job.ClaimedBy != "" && job.ClaimedBy != userID && job.ClaimActive(time.Now().UTC()) {
		return Job{}, fmt.Errorf("not the claimant")
	}
	now := time.Now().UTC()
	job.ClaimExpiresAt = &now
	job.UpdatedAt = now
	m.jobs[job.ID] = job
	return m.withCounts(job), nil
}

func (m *Memory) ClaimNext(_ context.Context, userID, email string, stage JobStatus, ttl time.Duration, project string) (Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now().UTC()
	stage = NormalizeStatus(stage)
	project = NormalizeProjectScope(project)
	var pick *Job
	for _, raw := range m.jobs {
		job := m.withCounts(raw)
		if NormalizeStatus(job.Status) != stage || !job.HasPDF {
			continue
		}
		if !jobMatchesProject(job, project) {
			continue
		}
		if !job.ClaimableBy(userID, now) {
			continue
		}
		if pick == nil || job.UpdatedAt.Before(pick.UpdatedAt) {
			copy := job
			pick = &copy
		}
	}
	if pick == nil {
		return Job{}, fmt.Errorf("no available job")
	}
	return m.putClaim(*pick, userID, email, ttl), nil
}

func (m *Memory) SetStage(_ context.Context, jobID, userID, email string, stage JobStatus) (Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	job, err := m.takeJobLocked(jobID)
	if err != nil {
		return Job{}, err
	}
	job = m.withCounts(job)
	if err := ValidateStage(job, userID, stage); err != nil {
		return Job{}, err
	}
	job.Status = NormalizeStatus(stage)
	switch job.Status {
	case StatusCorrected:
		job.CorrectedBy = userID
		job.CorrectedEmail = email
		job.VerifiedBy = ""
		job.VerifiedEmail = ""
	case StatusOriginal:
		job.CorrectedBy = ""
		job.CorrectedEmail = ""
		job.VerifiedBy = ""
		job.VerifiedEmail = ""
	case StatusComplete:
		job.VerifiedBy = userID
		job.VerifiedEmail = email
	}
	job.UpdatedAt = time.Now().UTC()
	m.jobs[job.ID] = job
	return m.withCounts(job), nil
}

func (m *Memory) ListProjects(_ context.Context) ([]Project, int, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	rootCount := 0
	counts := map[string]int{}
	for _, job := range m.jobs {
		if job.ProjectID == "" {
			rootCount++
			continue
		}
		counts[job.ProjectID]++
	}
	out := make([]Project, 0, len(m.projects))
	for _, p := range m.projects {
		p.JobCount = counts[p.ID]
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		li, lj := strings.ToLower(out[i].Name), strings.ToLower(out[j].Name)
		if li == lj {
			return out[i].Slug < out[j].Slug
		}
		return li < lj
	})
	return out, rootCount, nil
}

func (m *Memory) CreateProject(_ context.Context, name string) (Project, error) {
	name, slug, err := NormalizeProjectName(name)
	if err != nil {
		return Project{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, p := range m.projects {
		if p.Slug == slug {
			return Project{}, fmt.Errorf("project already exists")
		}
	}
	p := Project{
		ID:        newCommentID(),
		Slug:      slug,
		Name:      name,
		CreatedAt: time.Now().UTC(),
	}
	m.projects[p.ID] = p
	return p, nil
}

func (m *Memory) GetProject(_ context.Context, id string) (Project, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	p, ok := m.projects[id]
	if !ok {
		return Project{}, fmt.Errorf("project not found")
	}
	return p, nil
}

func (m *Memory) GetProjectBySlug(_ context.Context, slug string) (Project, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	slug = strings.ToLower(strings.TrimSpace(slug))
	for _, p := range m.projects {
		if p.Slug == slug {
			return p, nil
		}
	}
	return Project{}, fmt.Errorf("project not found")
}

func (m *Memory) ListTags(_ context.Context) ([]Tag, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Tag, 0, len(m.tags))
	for _, tag := range m.tags {
		out = append(out, tag)
	}
	sort.Slice(out, func(i, j int) bool {
		li, lj := strings.ToLower(out[i].Name), strings.ToLower(out[j].Name)
		if li == lj {
			return out[i].Name < out[j].Name
		}
		return li < lj
	})
	return out, nil
}

func (m *Memory) SetJobTags(_ context.Context, jobID string, names []string) (Job, error) {
	normalized, err := NormalizeTagNames(names)
	if err != nil {
		return Job{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	job, err := m.takeJobLocked(jobID)
	if err != nil {
		return Job{}, err
	}
	canonical := make([]string, 0, len(normalized))
	for _, name := range normalized {
		key := strings.ToLower(name)
		if existing, ok := m.tags[key]; ok {
			canonical = append(canonical, existing.Name)
			continue
		}
		tag := Tag{ID: fmt.Sprintf("tag_%d", len(m.tags)+1), Name: name}
		m.tags[key] = tag
		canonical = append(canonical, name)
	}
	job.Tags = canonical
	job.UpdatedAt = time.Now().UTC()
	m.jobs[job.ID] = job
	m.pruneUnusedTagsLocked()
	return m.withCounts(job), nil
}

func (m *Memory) pruneUnusedTagsLocked() {
	used := map[string]struct{}{}
	for _, job := range m.jobs {
		for _, name := range job.Tags {
			used[strings.ToLower(name)] = struct{}{}
		}
	}
	for key := range m.tags {
		if _, ok := used[key]; !ok {
			delete(m.tags, key)
		}
	}
}

func (m *Memory) ListPageComments(_ context.Context, jobID string, pageIndex int) ([]PageComment, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if _, ok := m.jobs[jobID]; !ok {
		return nil, fmt.Errorf("job not found")
	}
	out := make([]PageComment, 0)
	for _, c := range m.comments {
		if c.JobID == jobID && c.PageIndex == pageIndex {
			out = append(out, c)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].ID < out[j].ID
		}
		return out[i].CreatedAt.Before(out[j].CreatedAt)
	})
	return out, nil
}

func (m *Memory) CreatePageComment(_ context.Context, comment PageComment) (PageComment, error) {
	if err := NormalizePageComment(&comment); err != nil {
		return PageComment{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.jobs[comment.JobID]; !ok {
		return PageComment{}, fmt.Errorf("job not found")
	}
	now := time.Now().UTC()
	if comment.ID == "" {
		comment.ID = newCommentID()
	}
	if comment.CreatedAt.IsZero() {
		comment.CreatedAt = now
	}
	comment.UpdatedAt = now
	m.comments[comment.ID] = comment
	return comment, nil
}

func (m *Memory) DeletePageComment(_ context.Context, jobID, commentID, userID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.comments[commentID]
	if !ok || c.JobID != jobID {
		return fmt.Errorf("comment not found")
	}
	if c.AuthorID != userID {
		return fmt.Errorf("not the author")
	}
	delete(m.comments, commentID)
	return nil
}

func newCommentID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("cmt_%d", time.Now().UnixNano())
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
