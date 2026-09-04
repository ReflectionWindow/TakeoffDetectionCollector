package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/blackout"
	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/storage"
)

// Postgres is used when SUPABASE_DB_URL is set. Payloads live in object storage.
type Postgres struct {
	db   *sql.DB
	blob storage.Blob
}

func NewPostgres(db *sql.DB, blob storage.Blob) *Postgres {
	return &Postgres{db: db, blob: blob}
}

// EnsureUser upserts the authenticated user so annotation_revisions.author_id
// (a foreign key into users) always resolves. Called on write paths before a
// revision is saved.
func (p *Postgres) EnsureUser(ctx context.Context, id, email, name string) error {
	if id == "" || email == "" {
		return nil
	}
	_, err := p.db.ExecContext(ctx, `
		insert into users (id, email, name)
		values ($1::uuid, $2, $3)
		on conflict (id) do update set email = excluded.email, name = excluded.name`,
		id, email, name)
	return err
}

func (p *Postgres) UpsertJob(ctx context.Context, job Job) (Job, error) {
	if job.ID == "" {
		row := p.db.QueryRowContext(ctx, `
			insert into jobs (slug, title, status, source_coco_key, conflict_count)
			values ($1,$2,$3,$4,$5)
			on conflict (slug) do update set title=excluded.title, updated_at=now()
			returning id, slug, title, status, source_coco_key, conflict_count, created_at, updated_at`,
			job.Slug, job.Title, job.Status, job.SourceCocoKey, job.ConflictCount)
		if err := row.Scan(&job.ID, &job.Slug, &job.Title, &job.Status, &job.SourceCocoKey, &job.ConflictCount, &job.CreatedAt, &job.UpdatedAt); err != nil {
			return Job{}, err
		}
		return job, nil
	}
	_, err := p.db.ExecContext(ctx, `
		update jobs set title=$2, status=$3, source_coco_key=$4, conflict_count=$5, updated_at=now()
		where id=$1`, job.ID, job.Title, job.Status, job.SourceCocoKey, job.ConflictCount)
	return job, err
}

func (p *Postgres) GetJob(ctx context.Context, id string) (Job, error) {
	var job Job
	err := p.db.QueryRowContext(ctx, `
		select id, slug, title, status, coalesce(source_coco_key,''), conflict_count, created_at, updated_at
		from jobs where id=$1`, id).
		Scan(&job.ID, &job.Slug, &job.Title, &job.Status, &job.SourceCocoKey, &job.ConflictCount, &job.CreatedAt, &job.UpdatedAt)
	if err != nil {
		return Job{}, err
	}
	return p.withCounts(ctx, job)
}

func (p *Postgres) GetJobBySlug(ctx context.Context, slug string) (Job, error) {
	var id string
	if err := p.db.QueryRowContext(ctx, `select id from jobs where slug=$1`, slug).Scan(&id); err != nil {
		return Job{}, err
	}
	return p.GetJob(ctx, id)
}

func (p *Postgres) ListJobs(ctx context.Context) ([]Job, error) {
	rows, err := p.db.QueryContext(ctx, `select id from jobs order by slug`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Job
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		job, err := p.GetJob(ctx, id)
		if err != nil {
			return nil, err
		}
		out = append(out, job)
	}
	return out, rows.Err()
}

func (p *Postgres) UpdateJob(ctx context.Context, job Job) error {
	_, err := p.db.ExecContext(ctx, `update jobs set title=$2, status=$3, source_coco_key=$4, updated_at=now() where id=$1`,
		job.ID, job.Title, job.Status, job.SourceCocoKey)
	return err
}

func (p *Postgres) withCounts(ctx context.Context, job Job) (Job, error) {
	_ = p.db.QueryRowContext(ctx, `select count(*) from pages where job_id=$1`, job.ID).Scan(&job.PageCount)
	var n int
	_ = p.db.QueryRowContext(ctx, `select count(*) from documents where job_id=$1`, job.ID).Scan(&n)
	job.HasPDF = n > 0
	return job, nil
}

func (p *Postgres) UpsertPage(ctx context.Context, page Page) error {
	_, err := p.db.ExecContext(ctx, `
		insert into pages (job_id, page_index, pdf_page, width_px75, height_px75, width_pt, height_pt, raster_dpi, image_key, vectors_key)
		values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		on conflict (job_id, page_index) do update set
			pdf_page=excluded.pdf_page, width_px75=excluded.width_px75, height_px75=excluded.height_px75,
			width_pt=excluded.width_pt, height_pt=excluded.height_pt, raster_dpi=excluded.raster_dpi,
			image_key=excluded.image_key, vectors_key=excluded.vectors_key`,
		page.JobID, page.PageIndex, page.PDFPage, page.WidthPx75, page.HeightPx75, page.WidthPt, page.HeightPt, page.RasterDPI, page.ImageKey, page.VectorsKey)
	return err
}

func (p *Postgres) ListPages(ctx context.Context, jobID string) ([]Page, error) {
	rows, err := p.db.QueryContext(ctx, `
		select p.job_id, p.page_index, p.pdf_page, p.width_px75, p.height_px75, coalesce(p.width_pt,0), coalesce(p.height_pt,0),
		       p.raster_dpi, coalesce(p.image_key,''), coalesce(p.vectors_key,''), coalesce(d.storage_key,'')
		from pages p
		left join documents d on d.job_id=p.job_id
		where p.job_id=$1 order by p.page_index`, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Page
	for rows.Next() {
		var page Page
		if err := rows.Scan(&page.JobID, &page.PageIndex, &page.PDFPage, &page.WidthPx75, &page.HeightPx75, &page.WidthPt, &page.HeightPt, &page.RasterDPI, &page.ImageKey, &page.VectorsKey, &page.PDFKey); err != nil {
			return nil, err
		}
		out = append(out, page)
	}
	return out, rows.Err()
}

func (p *Postgres) GetPage(ctx context.Context, jobID string, pageIndex int) (Page, error) {
	pages, err := p.ListPages(ctx, jobID)
	if err != nil {
		return Page{}, err
	}
	for _, page := range pages {
		if page.PageIndex == pageIndex {
			return page, nil
		}
	}
	return Page{}, fmt.Errorf("page not found")
}

func (p *Postgres) SetDocument(ctx context.Context, jobID, storageKey, sha256 string, pageCount int) error {
	_, err := p.db.ExecContext(ctx, `
		insert into documents (job_id, storage_key, sha256, page_count)
		values ($1,$2,$3,$4)`, jobID, storageKey, sha256, pageCount)
	if err != nil {
		return err
	}
	_, err = p.db.ExecContext(ctx, `update jobs set status='ready', updated_at=now() where id=$1`, jobID)
	return err
}

func (p *Postgres) SaveRevision(ctx context.Context, rev Revision, payload AnnotationPayload) error {
	if rev.CreatedAt.IsZero() {
		rev.CreatedAt = time.Now().UTC()
	}
	_, err := p.db.ExecContext(ctx, `
		insert into annotation_revisions (job_id, page_index, version, parent_version, author_id, storage_key, note, created_at)
		values ($1,$2,$3,$4,nullif($5,'')::uuid,$6,$7,$8)
		on conflict (job_id, page_index, version) do nothing`,
		rev.JobID, rev.PageIndex, rev.Version, rev.ParentVersion, rev.AuthorID, rev.StorageKey, rev.Note, rev.CreatedAt)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return p.blob.Put(rev.StorageKey, raw, "application/json")
}

func (p *Postgres) loadPayload(rev Revision) (AnnotationPayload, error) {
	raw, err := p.blob.Get(rev.StorageKey)
	if err != nil {
		return AnnotationPayload{}, err
	}
	var payload AnnotationPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return AnnotationPayload{}, err
	}
	return payload, nil
}

func (p *Postgres) LatestRevision(ctx context.Context, jobID string, pageIndex int) (Revision, AnnotationPayload, error) {
	var rev Revision
	err := p.db.QueryRowContext(ctx, `
		select job_id, page_index, version, parent_version, coalesce(author_id::text,''), storage_key, note, created_at
		from annotation_revisions where job_id=$1 and page_index=$2
		order by version desc limit 1`, jobID, pageIndex).
		Scan(&rev.JobID, &rev.PageIndex, &rev.Version, &rev.ParentVersion, &rev.AuthorID, &rev.StorageKey, &rev.Note, &rev.CreatedAt)
	if err != nil {
		return Revision{}, AnnotationPayload{}, err
	}
	payload, err := p.loadPayload(rev)
	return rev, payload, err
}

func (p *Postgres) GetRevision(ctx context.Context, jobID string, pageIndex, version int) (Revision, AnnotationPayload, error) {
	var rev Revision
	err := p.db.QueryRowContext(ctx, `
		select job_id, page_index, version, parent_version, coalesce(author_id::text,''), storage_key, note, created_at
		from annotation_revisions where job_id=$1 and page_index=$2 and version=$3`, jobID, pageIndex, version).
		Scan(&rev.JobID, &rev.PageIndex, &rev.Version, &rev.ParentVersion, &rev.AuthorID, &rev.StorageKey, &rev.Note, &rev.CreatedAt)
	if err != nil {
		return Revision{}, AnnotationPayload{}, err
	}
	payload, err := p.loadPayload(rev)
	return rev, payload, err
}

func (p *Postgres) ListRevisions(ctx context.Context, jobID string, pageIndex int) ([]Revision, error) {
	rows, err := p.db.QueryContext(ctx, `
		select job_id, page_index, version, parent_version, coalesce(author_id::text,''), storage_key, note, created_at
		from annotation_revisions where job_id=$1 and page_index=$2 order by version`, jobID, pageIndex)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Revision
	for rows.Next() {
		var rev Revision
		if err := rows.Scan(&rev.JobID, &rev.PageIndex, &rev.Version, &rev.ParentVersion, &rev.AuthorID, &rev.StorageKey, &rev.Note, &rev.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, rev)
	}
	return out, rows.Err()
}

func (p *Postgres) SaveBlackouts(ctx context.Context, jobID string, page int, regions []blackout.Region) error {
	raw, err := json.Marshal(regions)
	if err != nil {
		return err
	}
	_, err = p.db.ExecContext(ctx, `
		insert into page_blackouts (job_id, page, regions, updated_at)
		values ($1,$2,$3,now())
		on conflict (job_id, page) do update set regions=excluded.regions, updated_at=now()`,
		jobID, page, raw)
	return err
}

func (p *Postgres) GetBlackouts(ctx context.Context, jobID string, page int) ([]blackout.Region, error) {
	var raw []byte
	err := p.db.QueryRowContext(ctx, `select regions from page_blackouts where job_id=$1 and page=$2`, jobID, page).Scan(&raw)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var regions []blackout.Region
	if err := json.Unmarshal(raw, &regions); err != nil {
		return nil, err
	}
	return regions, nil
}
