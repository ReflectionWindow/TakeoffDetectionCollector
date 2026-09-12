package store

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestNormalizeTagName(t *testing.T) {
	got, err := NormalizeTagName("  Hospital  East  ")
	if err != nil || got != "Hospital East" {
		t.Fatalf("got %q %v", got, err)
	}
	if _, err := NormalizeTagName("   "); err == nil {
		t.Fatal("empty should fail")
	}
	if _, err := NormalizeTagName(strings.Repeat("a", MaxTagLen+1)); err == nil {
		t.Fatal("overlong should fail")
	}
}

func TestNormalizeTagNamesDedupes(t *testing.T) {
	got, err := NormalizeTagNames([]string{" Hospital ", "hospital", "QC"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != "Hospital" || got[1] != "QC" {
		t.Fatalf("got %#v", got)
	}
}

func TestNormalizeTagNamesCap(t *testing.T) {
	raw := make([]string, MaxTagsPerJob+1)
	for i := range raw {
		raw[i] = fmt.Sprintf("tag-%d", i)
	}
	if _, err := NormalizeTagNames(raw); err == nil {
		t.Fatal("over cap should fail")
	}
}

func TestMemorySetJobTags(t *testing.T) {
	m := NewMemory()
	ctx := context.Background()
	job, err := m.UpsertJob(ctx, Job{Slug: "demo", Title: "demo", Status: StatusOriginal})
	if err != nil {
		t.Fatal(err)
	}
	got, err := m.SetJobTags(ctx, job.ID, []string{" Hospital ", "QC"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Tags) != 2 || got.Tags[0] != "Hospital" || got.Tags[1] != "QC" {
		t.Fatalf("tags %#v", got.Tags)
	}
	listed, err := m.ListTags(ctx)
	if err != nil || len(listed) != 2 {
		t.Fatalf("catalog %#v %v", listed, err)
	}
	again, err := m.SetJobTags(ctx, job.ID, []string{"hospital"})
	if err != nil {
		t.Fatal(err)
	}
	if len(again.Tags) != 1 || again.Tags[0] != "Hospital" {
		t.Fatalf("reuse catalog case %#v", again.Tags)
	}
	cleared, err := m.SetJobTags(ctx, job.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(cleared.Tags) != 0 {
		t.Fatalf("cleared %#v", cleared.Tags)
	}
	still, err := m.ListTags(ctx)
	if err != nil || len(still) != 0 {
		t.Fatalf("unused tags should drop from catalog %#v %v", still, err)
	}

	other, err := m.UpsertJob(ctx, Job{Slug: "other", Title: "other", Status: StatusOriginal})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.SetJobTags(ctx, job.ID, []string{"Kitchen"}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.SetJobTags(ctx, other.ID, []string{"Kitchen"}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.SetJobTags(ctx, job.ID, nil); err != nil {
		t.Fatal(err)
	}
	shared, err := m.ListTags(ctx)
	if err != nil || len(shared) != 1 || shared[0].Name != "Kitchen" {
		t.Fatalf("shared tag should remain %#v %v", shared, err)
	}
}
