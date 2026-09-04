package store

import (
	"context"
	"time"

	"github.com/StephenLiRWW/TakeoffDetectionCollector/internal/blackout"
)

type JobStatus string

const (
	StatusImported    JobStatus = "imported"
	StatusAwaitingPDF JobStatus = "awaiting_pdf"
	StatusReady       JobStatus = "ready"
	StatusCleaning    JobStatus = "cleaning"
	StatusDone        JobStatus = "done"
)

type Job struct {
	ID            string    `json:"id"`
	Slug          string    `json:"slug"`
	Title         string    `json:"title"`
	Status        JobStatus `json:"status"`
	SourceCocoKey string    `json:"source_coco_key,omitempty"`
	ConflictCount int       `json:"conflict_count"`
	PageCount     int       `json:"page_count"`
	BoxCount      int       `json:"box_count"`
	HasPDF        bool      `json:"has_pdf"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type Page struct {
	JobID      string   `json:"job_id"`
	PageIndex  int      `json:"page_index"`
	PDFPage    int      `json:"pdf_page"`
	WidthPx75  int      `json:"width_px75"`
	HeightPx75 int      `json:"height_px75"`
	WidthPt    float64  `json:"width_pt"`
	HeightPt   float64  `json:"height_pt"`
	RasterDPI  int      `json:"raster_dpi"`
	ImageKey   string   `json:"image_key,omitempty"`
	VectorsKey string   `json:"vectors_key,omitempty"`
	PDFKey     string   `json:"pdf_key,omitempty"`
}

type Box struct {
	ID        string     `json:"id"`
	Class     string     `json:"class"`
	Origin    string     `json:"origin"` // imported | user
	BBoxPt    [4]float64 `json:"bbox_pt"`
	BBoxPx75  [4]float64 `json:"bbox_px75"`
	Edited    bool       `json:"edited"`
	CocoID    int        `json:"coco_id,omitempty"`
	Category  int        `json:"category_id,omitempty"`
}

type AnnotationPayload struct {
	JobID     string `json:"job_id"`
	PageIndex int    `json:"page_index"`
	Version   int    `json:"version"`
	Boxes     []Box  `json:"boxes"`
}

type Revision struct {
	JobID         string    `json:"job_id"`
	PageIndex     int       `json:"page_index"`
	Version       int       `json:"version"`
	ParentVersion *int      `json:"parent_version,omitempty"`
	AuthorID      string    `json:"author_id,omitempty"`
	StorageKey    string    `json:"storage_key"`
	Note          string    `json:"note,omitempty"`
	CreatedAt     time.Time `json:"created_at"`
}

type Store interface {
	UpsertJob(ctx context.Context, job Job) (Job, error)
	GetJob(ctx context.Context, id string) (Job, error)
	GetJobBySlug(ctx context.Context, slug string) (Job, error)
	ListJobs(ctx context.Context) ([]Job, error)
	UpdateJob(ctx context.Context, job Job) error

	UpsertPage(ctx context.Context, page Page) error
	ListPages(ctx context.Context, jobID string) ([]Page, error)
	GetPage(ctx context.Context, jobID string, pageIndex int) (Page, error)

	SetDocument(ctx context.Context, jobID, storageKey, sha256 string, pageCount int) error

	SaveRevision(ctx context.Context, rev Revision, payload AnnotationPayload) error
	LatestRevision(ctx context.Context, jobID string, pageIndex int) (Revision, AnnotationPayload, error)
	GetRevision(ctx context.Context, jobID string, pageIndex, version int) (Revision, AnnotationPayload, error)
	ListRevisions(ctx context.Context, jobID string, pageIndex int) ([]Revision, error)

	SaveBlackouts(ctx context.Context, jobID string, page int, regions []blackout.Region) error
	GetBlackouts(ctx context.Context, jobID string, page int) ([]blackout.Region, error)
}
