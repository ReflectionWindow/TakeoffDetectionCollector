package store

import (
	"context"
	"testing"
)

func TestMemoryListJobsPagesAndDelete(t *testing.T) {
	m := NewMemory()
	ctx := context.Background()
	for i, slug := range []string{"alpha", "bravo", "charlie"} {
		status := StatusOriginal
		if i == 2 {
			status = StatusCorrected
		}
		if _, err := m.UpsertJob(ctx, Job{Slug: slug, Title: slug, Status: status, Tags: []string{"Hospital"}}); err != nil {
			t.Fatal(err)
		}
	}
	page, err := m.ListJobs(ctx, JobListQuery{Limit: 2, Offset: 0})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 3 || len(page.Jobs) != 2 || page.Jobs[0].Slug != "alpha" || page.Counts.Original != 2 || page.Counts.Corrected != 1 {
		t.Fatalf("page %#v", page)
	}
	next, err := m.ListJobs(ctx, JobListQuery{Limit: 2, Offset: 2})
	if err != nil {
		t.Fatal(err)
	}
	if next.Total != 3 || len(next.Jobs) != 1 || next.Jobs[0].Slug != "charlie" {
		t.Fatalf("next %#v", next)
	}
	review, err := m.ListJobs(ctx, JobListQuery{Stage: StatusCorrected, Limit: 25})
	if err != nil {
		t.Fatal(err)
	}
	if review.Total != 1 || review.Jobs[0].Slug != "charlie" {
		t.Fatalf("stage %#v", review)
	}
	id := page.Jobs[0].ID
	if _, err := m.DeleteJob(ctx, id); err != nil {
		t.Fatal(err)
	}
	after, err := m.ListJobs(ctx, JobListQuery{Limit: 25})
	if err != nil {
		t.Fatal(err)
	}
	if after.Total != 2 {
		t.Fatalf("after delete %#v", after)
	}
	if _, err := m.GetJob(ctx, id); err == nil {
		t.Fatal("deleted job should be gone")
	}
}
