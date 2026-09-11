package store

import "testing"

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

func TestNormalizeStatusDropsVerified(t *testing.T) {
	if got := NormalizeStatus(StatusVerified); got != StatusComplete {
		t.Fatalf("verified -> %s", got)
	}
	if got := NormalizeStatus(StatusDone); got != StatusComplete {
		t.Fatalf("done -> %s", got)
	}
}
