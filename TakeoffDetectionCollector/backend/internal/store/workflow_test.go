package store

import (
	"context"
	"testing"
	"time"
)

func TestValidateStage(t *testing.T) {
	job := Job{Status: StatusOriginal, HasPDF: true, CorrectedBy: "a"}
	if err := ValidateStage(job, "a", StatusCorrected); err != nil {
		t.Fatal(err)
	}
	if err := ValidateStage(job, "a", StatusComplete); err != nil {
		t.Fatal(err)
	}
	job.Status = StatusCorrected
	if err := ValidateStage(job, "a", StatusComplete); err != nil {
		t.Fatal(err)
	}
	if err := ValidateStage(job, "a", StatusOriginal); err != nil {
		t.Fatal(err)
	}
	job.Status = StatusComplete
	if err := ValidateStage(job, "a", StatusCorrected); err != nil {
		t.Fatal(err)
	}
	if err := ValidateStage(job, "a", StatusOriginal); err != nil {
		t.Fatal(err)
	}
	if err := ValidateStage(job, "b", JobStatus("nope")); err == nil {
		t.Fatal("unknown stage should fail")
	}
}

func TestReleaseJobKeepsLastOpener(t *testing.T) {
	m := NewMemory()
	job, err := m.UpsertJob(context.Background(), Job{Slug: "a", Title: "a", Status: StatusOriginal})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.ClaimJob(context.Background(), job.ID, "u1", "a@x.com", time.Hour); err != nil {
		t.Fatal(err)
	}
	got, err := m.ReleaseJob(context.Background(), job.ID, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if got.ClaimedBy != "u1" || got.ClaimedEmail != "a@x.com" {
		t.Fatalf("release cleared opener: %+v", got)
	}
	if got.ClaimActive(time.Now().UTC().Add(time.Second)) {
		t.Fatal("lock should be expired after release")
	}
	if !got.ClaimableBy("u2", time.Now().UTC().Add(time.Second)) {
		t.Fatal("expired lock should be claimable")
	}
}

func TestNormalizeStatusDropsVerified(t *testing.T) {
	if got := NormalizeStatus(StatusVerified); got != StatusComplete {
		t.Fatalf("verified -> %s", got)
	}
	if got := NormalizeStatus(StatusDone); got != StatusComplete {
		t.Fatalf("done -> %s", got)
	}
}
