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

func TestMemorySearchAndProjects(t *testing.T) {
	m := NewMemory()
	ctx := context.Background()
	if _, err := m.UpsertJob(ctx, Job{Slug: "alpha-sheet", Title: "Alpha Hospital", Status: StatusOriginal, ProjectID: ProjectManilaID}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.UpsertJob(ctx, Job{Slug: "bravo-sheet", Title: "Bravo Clinic", Status: StatusOriginal, ProjectID: ProjectChicagoID}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.UpsertJob(ctx, Job{Slug: "root-sheet", Title: "Unassigned", Status: StatusOriginal}); err != nil {
		t.Fatal(err)
	}

	hit, err := m.ListJobs(ctx, JobListQuery{Q: "alpha", Limit: 25})
	if err != nil {
		t.Fatal(err)
	}
	if hit.Total != 1 || hit.Jobs[0].Slug != "alpha-sheet" || hit.Counts.All != 1 {
		t.Fatalf("search %#v", hit)
	}
	title, err := m.ListJobs(ctx, JobListQuery{Q: "clinic", Limit: 25})
	if err != nil {
		t.Fatal(err)
	}
	if title.Total != 1 || title.Jobs[0].Slug != "bravo-sheet" {
		t.Fatalf("title search %#v", title)
	}

	manila, err := m.ListJobs(ctx, JobListQuery{Project: ProjectManilaID, Limit: 25})
	if err != nil {
		t.Fatal(err)
	}
	if manila.Total != 1 || manila.Jobs[0].ProjectName != "Manila" {
		t.Fatalf("manila %#v", manila)
	}
	root, err := m.ListJobs(ctx, JobListQuery{Project: ProjectScopeRoot, Limit: 25})
	if err != nil {
		t.Fatal(err)
	}
	if root.Total != 1 || root.Jobs[0].Slug != "root-sheet" {
		t.Fatalf("root %#v", root)
	}

	projects, rootCount, err := m.ListProjects(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if rootCount != 1 || len(projects) != 2 {
		t.Fatalf("projects %d %#v", rootCount, projects)
	}

	if _, err := m.UpsertJob(ctx, Job{Slug: "alpha-sheet", Title: "dup", Status: StatusOriginal, ProjectID: ProjectManilaID}); err == nil {
		t.Fatal("duplicate slug in project should fail")
	}
	if _, err := m.UpsertJob(ctx, Job{Slug: "alpha-sheet", Title: "dup root", Status: StatusOriginal}); err != nil {
		t.Fatal(err)
	}

	chicago, err := m.CreateProject(ctx, "Dallas")
	if err != nil {
		t.Fatal(err)
	}
	if chicago.Slug != "dallas" {
		t.Fatalf("slug %s", chicago.Slug)
	}
	if _, err := m.CreateProject(ctx, "Manila"); err == nil {
		t.Fatal("duplicate project")
	}
}
