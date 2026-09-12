package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
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
			insert into jobs (slug, title, status, source_coco_key, conflict_count, project_id)
			values ($1,$2,$3,$4,$5, nullif($6,'')::uuid)
			returning id, slug, title, status, source_coco_key, conflict_count, created_at, updated_at`,
			job.Slug, job.Title, job.Status, job.SourceCocoKey, job.ConflictCount, job.ProjectID)
		if err := row.Scan(&job.ID, &job.Slug, &job.Title, &job.Status, &job.SourceCocoKey, &job.ConflictCount, &job.CreatedAt, &job.UpdatedAt); err != nil {
			return Job{}, err
		}
		return p.GetJob(ctx, job.ID)
	}
	_, err := p.db.ExecContext(ctx, `
		update jobs set title=$2, status=$3, source_coco_key=$4, conflict_count=$5, updated_at=now()
		where id=$1`, job.ID, job.Title, job.Status, job.SourceCocoKey, job.ConflictCount)
	if err != nil {
		return Job{}, err
	}
	return p.GetJob(ctx, job.ID)
}

// jobSelect carries page, document, and box totals as aggregates so a job (or
// the whole inbox) is one round trip instead of extra queries per row.
const jobSelect = `
	select j.id, j.slug, j.title, j.status, coalesce(j.source_coco_key,''), j.conflict_count,
	       j.created_at, j.updated_at,
	       coalesce(j.claimed_by::text,''), coalesce(cu.email,''), j.claim_expires_at,
	       coalesce(j.corrected_by::text,''), coalesce(cor.email,''),
	       coalesce(j.verified_by::text,''), coalesce(ver.email,''),
	       coalesce(pg.n, 0), coalesce(doc.n, 0) > 0, coalesce(bx.n, 0),
	       coalesce((
	           select json_agg(t.name order by lower(t.name), t.name)
	           from job_tags jt
	           join tags t on t.id = jt.tag_id
	           where jt.job_id = j.id
	       ), '[]'::json),
	       coalesce(j.project_id::text,''), coalesce(pr.name,'')
	from jobs j
	left join projects pr on pr.id = j.project_id
	left join users cu on cu.id = j.claimed_by
	left join users cor on cor.id = j.corrected_by
	left join users ver on ver.id = j.verified_by
	left join (select job_id, count(*) as n from pages group by job_id) pg on pg.job_id = j.id
	left join (select job_id, count(*) as n from documents group by job_id) doc on doc.job_id = j.id
	left join (
		select r.job_id, sum(r.box_count) as n
		from annotation_revisions r
		join (
			select job_id, page_index, max(version) as version
			from annotation_revisions group by job_id, page_index
		) latest on latest.job_id = r.job_id
			and latest.page_index = r.page_index
			and latest.version = r.version
		group by r.job_id
	) bx on bx.job_id = j.id`

type rowScanner interface {
	Scan(dest ...any) error
}

func scanJob(row rowScanner) (Job, error) {
	var job Job
	var claimExp sql.NullTime
	var tagsJSON []byte
	err := row.Scan(&job.ID, &job.Slug, &job.Title, &job.Status, &job.SourceCocoKey, &job.ConflictCount,
		&job.CreatedAt, &job.UpdatedAt,
		&job.ClaimedBy, &job.ClaimedEmail, &claimExp,
		&job.CorrectedBy, &job.CorrectedEmail,
		&job.VerifiedBy, &job.VerifiedEmail,
		&job.PageCount, &job.HasPDF, &job.BoxCount, &tagsJSON,
		&job.ProjectID, &job.ProjectName)
	if err != nil {
		return Job{}, err
	}
	if claimExp.Valid {
		t := claimExp.Time.UTC()
		job.ClaimExpiresAt = &t
	}
	job.Status = NormalizeStatus(job.Status)
	job.Tags = decodeTagNames(tagsJSON)
	return job, nil
}

func decodeTagNames(raw []byte) []string {
	if len(raw) == 0 || string(raw) == "null" {
		return []string{}
	}
	var names []string
	if err := json.Unmarshal(raw, &names); err != nil || names == nil {
		return []string{}
	}
	return names
}

func (p *Postgres) GetJob(ctx context.Context, id string) (Job, error) {
	return scanJob(p.db.QueryRowContext(ctx, jobSelect+` where j.id=$1`, id))
}

func (p *Postgres) GetJobBySlug(ctx context.Context, projectID, slug string) (Job, error) {
	var id string
	var err error
	if projectID == "" {
		err = p.db.QueryRowContext(ctx, `select id from jobs where slug=$1 and project_id is null`, slug).Scan(&id)
	} else {
		err = p.db.QueryRowContext(ctx, `select id from jobs where slug=$1 and project_id=$2::uuid`, slug, projectID).Scan(&id)
	}
	if err != nil {
		return Job{}, err
	}
	return p.GetJob(ctx, id)
}

const sqlNormalizedStatus = `case
	when j.status in ('complete','verified','done') then 'complete'
	when j.status = 'corrected' then 'corrected'
	else 'original'
end`

func jobListWhere(q JobListQuery, start int) (string, []any, int) {
	var clauses []string
	var args []any
	n := start
	if q.Stage != "" {
		clauses = append(clauses, fmt.Sprintf("(%s) = $%d", sqlNormalizedStatus, n))
		args = append(args, string(q.Stage))
		n++
	}
	if len(q.Tags) > 0 {
		clauses = append(clauses, fmt.Sprintf(`exists (
			select 1 from job_tags jt join tags t on t.id = jt.tag_id
			where jt.job_id = j.id and lower(t.name) = any($%d)
		)`, n))
		args = append(args, q.Tags)
		n++
	}
	if q.Q != "" {
		clauses = append(clauses, fmt.Sprintf(`(j.slug ilike $%d escape '\' or j.title ilike $%d escape '\')`, n, n))
		args = append(args, ilikeContains(q.Q))
		n++
	}
	if q.Project == ProjectScopeRoot {
		clauses = append(clauses, "j.project_id is null")
	} else if q.Project != "" {
		clauses = append(clauses, fmt.Sprintf("j.project_id = $%d::uuid", n))
		args = append(args, q.Project)
		n++
	}
	if len(clauses) == 0 {
		return "", args, n
	}
	return " where " + strings.Join(clauses, " and "), args, n
}

func (p *Postgres) ListJobs(ctx context.Context, q JobListQuery) (JobList, error) {
	q = q.Normalized()
	counts, err := p.jobStageCounts(ctx, q)
	if err != nil {
		return JobList{}, err
	}
	tagCounts, err := p.jobTagCounts(ctx, q)
	if err != nil {
		return JobList{}, err
	}
	where, args, n := jobListWhere(q, 1)
	var total int
	if err := p.db.QueryRowContext(ctx, `select count(*) from jobs j`+where, args...).Scan(&total); err != nil {
		return JobList{}, err
	}
	if q.Offset > total {
		q.Offset = total
	}
	idSQL := `select j.id from jobs j` + where + fmt.Sprintf(` order by j.slug limit $%d offset $%d`, n, n+1)
	idArgs := append(append([]any{}, args...), q.Limit, q.Offset)
	rows, err := p.db.QueryContext(ctx, idSQL, idArgs...)
	if err != nil {
		return JobList{}, err
	}
	ids := make([]string, 0, q.Limit)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return JobList{}, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return JobList{}, err
	}
	rows.Close()

	out := make([]Job, 0, len(ids))
	if len(ids) > 0 {
		jobRows, err := p.db.QueryContext(ctx, jobSelect+` where j.id::text = any($1) order by j.slug`, ids)
		if err != nil {
			return JobList{}, err
		}
		defer jobRows.Close()
		for jobRows.Next() {
			job, err := scanJob(jobRows)
			if err != nil {
				return JobList{}, err
			}
			out = append(out, job)
		}
		if err := jobRows.Err(); err != nil {
			return JobList{}, err
		}
	}
	return JobList{Jobs: out, Total: total, Limit: q.Limit, Offset: q.Offset, Counts: counts, TagCounts: tagCounts}, nil
}

func (p *Postgres) jobStageCounts(ctx context.Context, q JobListQuery) (StageCounts, error) {
	q.Stage = ""
	q = q.Normalized()
	where, args, _ := jobListWhere(q, 1)
	var c StageCounts
	err := p.db.QueryRowContext(ctx, `
		select count(*)::int,
		       count(*) filter (where (`+sqlNormalizedStatus+`) = 'original')::int,
		       count(*) filter (where (`+sqlNormalizedStatus+`) = 'corrected')::int,
		       count(*) filter (where (`+sqlNormalizedStatus+`) = 'complete')::int
		from jobs j`+where, args...).Scan(&c.All, &c.Original, &c.Corrected, &c.Complete)
	return c, err
}

func (p *Postgres) jobTagCounts(ctx context.Context, q JobListQuery) ([]TagCount, error) {
	q.Tags = nil
	q = q.Normalized()
	where, args, _ := jobListWhere(q, 1)
	rows, err := p.db.QueryContext(ctx, `
		select t.name, count(*)::int
		from job_tags jt
		join tags t on t.id = jt.tag_id
		join jobs j on j.id = jt.job_id`+where+`
		group by t.name
		order by lower(t.name), t.name`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]TagCount, 0)
	for rows.Next() {
		var tc TagCount
		if err := rows.Scan(&tc.Name, &tc.Count); err != nil {
			return nil, err
		}
		out = append(out, tc)
	}
	return out, rows.Err()
}

type queryer interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func (p *Postgres) DeleteJob(ctx context.Context, id string) ([]string, error) {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	keys, err := collectJobBlobKeys(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	res, err := tx.ExecContext(ctx, `delete from jobs where id=$1`, id)
	if err != nil {
		return nil, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, fmt.Errorf("job not found")
	}
	if err := pruneUnusedTags(ctx, tx); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return keys, nil
}

func collectJobBlobKeys(ctx context.Context, q queryer, jobID string) ([]string, error) {
	seen := map[string]struct{}{}
	add := func(key string) {
		key = strings.TrimSpace(key)
		if key == "" {
			return
		}
		seen[key] = struct{}{}
	}
	var coco string
	if err := q.QueryRowContext(ctx, `select coalesce(source_coco_key,'') from jobs where id=$1`, jobID).Scan(&coco); err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("job not found")
		}
		return nil, err
	}
	add(coco)
	add(fmt.Sprintf("coco/%s/_annotations.coco.json", jobID))

	docRows, err := q.QueryContext(ctx, `select storage_key from documents where job_id=$1`, jobID)
	if err != nil {
		return nil, err
	}
	for docRows.Next() {
		var key string
		if err := docRows.Scan(&key); err != nil {
			docRows.Close()
			return nil, err
		}
		add(key)
	}
	if err := docRows.Err(); err != nil {
		docRows.Close()
		return nil, err
	}
	docRows.Close()

	pageRows, err := q.QueryContext(ctx, `select page_index, coalesce(image_key,''), coalesce(vectors_key,'') from pages where job_id=$1`, jobID)
	if err != nil {
		return nil, err
	}
	for pageRows.Next() {
		var idx int
		var image, vectors string
		if err := pageRows.Scan(&idx, &image, &vectors); err != nil {
			pageRows.Close()
			return nil, err
		}
		add(image)
		add(vectors)
		add(fmt.Sprintf("vectors/%s/p%d.json", jobID, idx))
	}
	if err := pageRows.Err(); err != nil {
		pageRows.Close()
		return nil, err
	}
	pageRows.Close()

	revRows, err := q.QueryContext(ctx, `select coalesce(storage_key,'') from annotation_revisions where job_id=$1`, jobID)
	if err != nil {
		return nil, err
	}
	for revRows.Next() {
		var key string
		if err := revRows.Scan(&key); err != nil {
			revRows.Close()
			return nil, err
		}
		add(key)
	}
	if err := revRows.Err(); err != nil {
		revRows.Close()
		return nil, err
	}
	revRows.Close()

	out := make([]string, 0, len(seen))
	for key := range seen {
		out = append(out, key)
	}
	return out, nil
}

func (p *Postgres) UpdateJob(ctx context.Context, job Job) error {
	_, err := p.db.ExecContext(ctx, `update jobs set title=$2, status=$3, source_coco_key=$4, updated_at=now() where id=$1`,
		job.ID, job.Title, job.Status, job.SourceCocoKey)
	return err
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
	// The PDF key comes from a scalar subquery rather than a join so a page is
	// never returned more than once.
	rows, err := p.db.QueryContext(ctx, `
		select p.job_id, p.page_index, p.pdf_page, p.width_px75, p.height_px75, coalesce(p.width_pt,0), coalesce(p.height_pt,0),
		       p.raster_dpi, coalesce(p.image_key,''), coalesce(p.vectors_key,''),
		       coalesce((
		           select d.storage_key from documents d
		           where d.job_id = p.job_id
		           order by d.created_at desc limit 1
		       ), '')
		from pages p
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

// SetDocument replaces the job's single source PDF. Re-attaching must not add
// a second documents row, or every join onto pages fans out.
func (p *Postgres) SetDocument(ctx context.Context, jobID, storageKey, sha256 string, pageCount int) error {
	_, err := p.db.ExecContext(ctx, `
		insert into documents (job_id, storage_key, sha256, page_count)
		values ($1,$2,$3,$4)
		on conflict (job_id) do update set
			storage_key=excluded.storage_key, sha256=excluded.sha256, page_count=excluded.page_count`,
		jobID, storageKey, sha256, pageCount)
	if err != nil {
		return err
	}
	_, err = p.db.ExecContext(ctx, `update jobs set updated_at=now() where id=$1`, jobID)
	return err
}

func (p *Postgres) SaveRevision(ctx context.Context, rev Revision, payload AnnotationPayload) error {
	if rev.CreatedAt.IsZero() {
		rev.CreatedAt = time.Now().UTC()
	}
	// box_count is denormalized so the inbox can total boxes without reading
	// every payload out of object storage. Re-importing a version refreshes it.
	_, err := p.db.ExecContext(ctx, `
		insert into annotation_revisions (job_id, page_index, version, parent_version, author_id, storage_key, note, created_at, box_count)
		values ($1,$2,$3,$4,nullif($5,'')::uuid,$6,$7,$8,$9)
		on conflict (job_id, page_index, version) do update set
			storage_key=excluded.storage_key, box_count=excluded.box_count`,
		rev.JobID, rev.PageIndex, rev.Version, rev.ParentVersion, rev.AuthorID, rev.StorageKey, rev.Note, rev.CreatedAt, len(payload.Boxes))
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

func (p *Postgres) ClaimJob(ctx context.Context, jobID, userID, email string, ttl time.Duration) (Job, error) {
	if err := p.EnsureUser(ctx, userID, email, ""); err != nil {
		return Job{}, err
	}
	job, err := p.GetJob(ctx, jobID)
	if err != nil {
		return Job{}, err
	}
	if !job.ClaimableBy(userID, time.Now().UTC()) {
		return Job{}, fmt.Errorf("job claimed by %s", job.ClaimedEmail)
	}
	_, err = p.db.ExecContext(ctx, `
		update jobs set claimed_by=$2::uuid, claimed_at=now(), claim_expires_at=now()+$3::interval, updated_at=now()
		where id=$1`, jobID, userID, interval(ttl))
	if err != nil {
		return Job{}, err
	}
	return p.GetJob(ctx, jobID)
}

func (p *Postgres) HeartbeatJob(ctx context.Context, jobID, userID string, ttl time.Duration) (Job, error) {
	res, err := p.db.ExecContext(ctx, `
		update jobs set claim_expires_at=now()+$3::interval, updated_at=now()
		where id=$1 and claimed_by=$2::uuid and (claim_expires_at is null or claim_expires_at > now())`,
		jobID, userID, interval(ttl))
	if err != nil {
		return Job{}, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return Job{}, fmt.Errorf("not the claimant")
	}
	return p.GetJob(ctx, jobID)
}

func (p *Postgres) ReleaseJob(ctx context.Context, jobID, userID string) (Job, error) {
	job, err := p.GetJob(ctx, jobID)
	if err != nil {
		return Job{}, err
	}
	if job.ClaimedBy != "" && job.ClaimedBy != userID && job.ClaimActive(time.Now().UTC()) {
		return Job{}, fmt.Errorf("not the claimant")
	}
	_, err = p.db.ExecContext(ctx, `
		update jobs set claim_expires_at=now(), updated_at=now()
		where id=$1`, jobID)
	if err != nil {
		return Job{}, err
	}
	return p.GetJob(ctx, jobID)
}

func (p *Postgres) ClaimNext(ctx context.Context, userID, email string, stage JobStatus, ttl time.Duration, project string) (Job, error) {
	if err := p.EnsureUser(ctx, userID, email, ""); err != nil {
		return Job{}, err
	}
	stage = NormalizeStatus(stage)
	project = NormalizeProjectScope(project)
	filter := ""
	args := []any{userID, interval(ttl), string(stage)}
	if project == ProjectScopeRoot {
		filter = " and j.project_id is null"
	} else if project != "" {
		filter = " and j.project_id = $4::uuid"
		args = append(args, project)
	}
	var id string
	err := p.db.QueryRowContext(ctx, `
		with next as (
			select j.id from jobs j
			where j.status = $3
			  and exists (select 1 from documents d where d.job_id = j.id)
			  and (j.claimed_by is null or j.claimed_by = $1::uuid or j.claim_expires_at is null or j.claim_expires_at < now())
			`+filter+`
			order by j.updated_at
			for update skip locked
			limit 1
		)
		update jobs set claimed_by=$1::uuid, claimed_at=now(), claim_expires_at=now()+$2::interval, updated_at=now()
		where id = (select id from next)
		returning id`, args...).Scan(&id)
	if err == sql.ErrNoRows {
		return Job{}, fmt.Errorf("no available job")
	}
	if err != nil {
		return Job{}, err
	}
	return p.GetJob(ctx, id)
}

func (p *Postgres) SetStage(ctx context.Context, jobID, userID, email string, stage JobStatus) (Job, error) {
	if err := p.EnsureUser(ctx, userID, email, ""); err != nil {
		return Job{}, err
	}
	job, err := p.GetJob(ctx, jobID)
	if err != nil {
		return Job{}, err
	}
	if err := ValidateStage(job, userID, stage); err != nil {
		return Job{}, err
	}
	next := NormalizeStatus(stage)
	var corrected, verified any
	switch next {
	case StatusCorrected:
		corrected = userID
		verified = nil
	case StatusOriginal:
		corrected = nil
		verified = nil
	case StatusComplete:
		if job.CorrectedBy != "" {
			corrected = job.CorrectedBy
		}
		verified = userID
	default:
		if job.CorrectedBy != "" {
			corrected = job.CorrectedBy
		}
		if job.VerifiedBy != "" {
			verified = job.VerifiedBy
		}
	}
	_, err = p.db.ExecContext(ctx, `
		update jobs set status=$2, corrected_by=nullif($3,'')::uuid, verified_by=nullif($4,'')::uuid, updated_at=now()
		where id=$1`, jobID, string(next), uuidOrEmpty(corrected), uuidOrEmpty(verified))
	if err != nil {
		return Job{}, err
	}
	return p.GetJob(ctx, jobID)
}

func (p *Postgres) ListProjects(ctx context.Context) ([]Project, int, error) {
	var rootCount int
	if err := p.db.QueryRowContext(ctx, `select count(*) from jobs where project_id is null`).Scan(&rootCount); err != nil {
		return nil, 0, err
	}
	rows, err := p.db.QueryContext(ctx, `
		select p.id::text, p.slug, p.name, p.created_at, count(j.id)::int
		from projects p
		left join jobs j on j.project_id = p.id
		group by p.id, p.slug, p.name, p.created_at
		order by lower(p.name), p.slug`)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := make([]Project, 0)
	for rows.Next() {
		var proj Project
		if err := rows.Scan(&proj.ID, &proj.Slug, &proj.Name, &proj.CreatedAt, &proj.JobCount); err != nil {
			return nil, 0, err
		}
		out = append(out, proj)
	}
	return out, rootCount, rows.Err()
}

func (p *Postgres) CreateProject(ctx context.Context, name string) (Project, error) {
	name, slug, err := NormalizeProjectName(name)
	if err != nil {
		return Project{}, err
	}
	var proj Project
	err = p.db.QueryRowContext(ctx, `
		insert into projects (slug, name) values ($1, $2)
		returning id::text, slug, name, created_at`, slug, name).Scan(&proj.ID, &proj.Slug, &proj.Name, &proj.CreatedAt)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return Project{}, fmt.Errorf("project already exists")
		}
		return Project{}, err
	}
	return proj, nil
}

func (p *Postgres) GetProject(ctx context.Context, id string) (Project, error) {
	var proj Project
	err := p.db.QueryRowContext(ctx, `
		select id::text, slug, name, created_at from projects where id=$1::uuid`, id).Scan(&proj.ID, &proj.Slug, &proj.Name, &proj.CreatedAt)
	if err != nil {
		return Project{}, fmt.Errorf("project not found")
	}
	return proj, nil
}

func (p *Postgres) GetProjectBySlug(ctx context.Context, slug string) (Project, error) {
	var proj Project
	err := p.db.QueryRowContext(ctx, `
		select id::text, slug, name, created_at from projects where slug=$1`, strings.ToLower(strings.TrimSpace(slug))).Scan(&proj.ID, &proj.Slug, &proj.Name, &proj.CreatedAt)
	if err != nil {
		return Project{}, fmt.Errorf("project not found")
	}
	return proj, nil
}

func (p *Postgres) ListTags(ctx context.Context) ([]Tag, error) {
	rows, err := p.db.QueryContext(ctx, `select id::text, name from tags order by lower(name), name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Tag, 0)
	for rows.Next() {
		var tag Tag
		if err := rows.Scan(&tag.ID, &tag.Name); err != nil {
			return nil, err
		}
		out = append(out, tag)
	}
	return out, rows.Err()
}

func (p *Postgres) SetJobTags(ctx context.Context, jobID string, names []string) (Job, error) {
	normalized, err := NormalizeTagNames(names)
	if err != nil {
		return Job{}, err
	}
	if _, err := p.GetJob(ctx, jobID); err != nil {
		return Job{}, err
	}
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return Job{}, err
	}
	defer func() { _ = tx.Rollback() }()

	ids := make([]string, 0, len(normalized))
	for _, name := range normalized {
		id, err := ensureTag(ctx, tx, name)
		if err != nil {
			return Job{}, err
		}
		ids = append(ids, id)
	}
	if _, err := tx.ExecContext(ctx, `delete from job_tags where job_id = $1`, jobID); err != nil {
		return Job{}, err
	}
	for _, id := range ids {
		if _, err := tx.ExecContext(ctx, `insert into job_tags (job_id, tag_id) values ($1, $2)`, jobID, id); err != nil {
			return Job{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `update jobs set updated_at = now() where id = $1`, jobID); err != nil {
		return Job{}, err
	}
	if err := pruneUnusedTags(ctx, tx); err != nil {
		return Job{}, err
	}
	if err := tx.Commit(); err != nil {
		return Job{}, err
	}
	return p.GetJob(ctx, jobID)
}

func (p *Postgres) ListPageComments(ctx context.Context, jobID string, pageIndex int) ([]PageComment, error) {
	if _, err := p.GetJob(ctx, jobID); err != nil {
		return nil, err
	}
	rows, err := p.db.QueryContext(ctx, `
		select c.id::text, c.job_id::text, c.page_index, c.author_id::text,
		       coalesce(u.email, ''), coalesce(u.name, ''),
		       c.body, coalesce(c.annotation_id, ''), c.created_at, c.updated_at
		from page_comments c
		left join users u on u.id = c.author_id
		where c.job_id = $1::uuid and c.page_index = $2
		order by c.created_at, c.id`, jobID, pageIndex)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]PageComment, 0)
	for rows.Next() {
		var c PageComment
		if err := rows.Scan(&c.ID, &c.JobID, &c.PageIndex, &c.AuthorID, &c.AuthorEmail, &c.AuthorName, &c.Body, &c.AnnotationID, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (p *Postgres) CreatePageComment(ctx context.Context, comment PageComment) (PageComment, error) {
	if err := NormalizePageComment(&comment); err != nil {
		return PageComment{}, err
	}
	if _, err := p.GetJob(ctx, comment.JobID); err != nil {
		return PageComment{}, err
	}
	var ann any
	if comment.AnnotationID != "" {
		ann = comment.AnnotationID
	}
	err := p.db.QueryRowContext(ctx, `
		insert into page_comments (job_id, page_index, author_id, body, annotation_id)
		values ($1::uuid, $2, $3::uuid, $4, $5)
		returning id::text, job_id::text, page_index, author_id::text, body, coalesce(annotation_id, ''), created_at, updated_at`,
		comment.JobID, comment.PageIndex, comment.AuthorID, comment.Body, ann).
		Scan(&comment.ID, &comment.JobID, &comment.PageIndex, &comment.AuthorID, &comment.Body, &comment.AnnotationID, &comment.CreatedAt, &comment.UpdatedAt)
	if err != nil {
		return PageComment{}, err
	}
	return comment, nil
}

func (p *Postgres) DeletePageComment(ctx context.Context, jobID, commentID, userID string) error {
	var author string
	err := p.db.QueryRowContext(ctx, `
		select author_id::text from page_comments where id = $1::uuid and job_id = $2::uuid`,
		commentID, jobID).Scan(&author)
	if err == sql.ErrNoRows {
		return fmt.Errorf("comment not found")
	}
	if err != nil {
		return err
	}
	if author != userID {
		return fmt.Errorf("not the author")
	}
	_, err = p.db.ExecContext(ctx, `delete from page_comments where id = $1::uuid and job_id = $2::uuid`, commentID, jobID)
	return err
}

func pruneUnusedTags(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `delete from tags t where not exists (select 1 from job_tags jt where jt.tag_id = t.id)`)
	return err
}

func ensureTag(ctx context.Context, tx *sql.Tx, name string) (string, error) {
	var id string
	err := tx.QueryRowContext(ctx, `
		insert into tags (name) values ($1)
		on conflict ((lower(name))) do update set name = tags.name
		returning id::text`, name).Scan(&id)
	return id, err
}

func interval(d time.Duration) string {
	if d <= 0 {
		d = DefaultClaimTTL
	}
	return fmt.Sprintf("%d seconds", int(d.Seconds()))
}

func uuidOrEmpty(v any) string {
	if v == nil {
		return ""
	}
	s, _ := v.(string)
	return s
}
