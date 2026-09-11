package store

import (
	"context"
	"strings"
	"testing"
)

func TestNormalizeCommentBody(t *testing.T) {
	got, err := NormalizeCommentBody("  check the louver  ")
	if err != nil || got != "check the louver" {
		t.Fatalf("got %q %v", got, err)
	}
	if _, err := NormalizeCommentBody("   "); err == nil {
		t.Fatal("empty should fail")
	}
	if _, err := NormalizeCommentBody(strings.Repeat("a", MaxCommentLen+1)); err == nil {
		t.Fatal("overlong should fail")
	}
}

func TestMemoryPageCommentsSharedAcrossUsers(t *testing.T) {
	m := NewMemory()
	ctx := context.Background()
	job, err := m.UpsertJob(ctx, Job{Slug: "demo", Title: "demo", Status: StatusOriginal})
	if err != nil {
		t.Fatal(err)
	}
	first, err := m.CreatePageComment(ctx, PageComment{
		JobID:        job.ID,
		PageIndex:    0,
		AuthorID:     "user-a",
		AuthorEmail:  "a@reflectionwindow.com",
		AuthorName:   "A",
		Body:         "lopsided mullion",
		AnnotationID: "box-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == "" || first.AnnotationID != "box-1" {
		t.Fatalf("created %#v", first)
	}
	second, err := m.CreatePageComment(ctx, PageComment{
		JobID:       job.ID,
		PageIndex:   0,
		AuthorID:    "user-b",
		AuthorEmail: "b@reflectionwindow.com",
		AuthorName:  "B",
		Body:        "agreed, snap the left edge",
	})
	if err != nil {
		t.Fatal(err)
	}
	listed, err := m.ListPageComments(ctx, job.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 2 || listed[0].ID != first.ID || listed[1].ID != second.ID {
		t.Fatalf("thread %#v", listed)
	}
	otherPage, err := m.ListPageComments(ctx, job.ID, 1)
	if err != nil || len(otherPage) != 0 {
		t.Fatalf("other page %#v %v", otherPage, err)
	}
	if err := m.DeletePageComment(ctx, job.ID, first.ID, "user-b"); err == nil {
		t.Fatal("other user should not delete")
	}
	if err := m.DeletePageComment(ctx, job.ID, first.ID, "user-a"); err != nil {
		t.Fatal(err)
	}
	left, err := m.ListPageComments(ctx, job.ID, 0)
	if err != nil || len(left) != 1 || left[0].ID != second.ID {
		t.Fatalf("after delete %#v %v", left, err)
	}
}

func TestMemoryCreateCommentRequiresJob(t *testing.T) {
	m := NewMemory()
	_, err := m.CreatePageComment(context.Background(), PageComment{
		JobID:    "missing",
		AuthorID: "user-a",
		Body:     "hello",
	})
	if err == nil {
		t.Fatal("missing job should fail")
	}
}
