package store

import (
	"fmt"
	"time"
)

// DefaultClaimTTL is how long a sheet stays locked after the last heartbeat.
// Heartbeats run every 30s while the tab is open; tab close releases immediately.
const DefaultClaimTTL = 5 * time.Minute

func IsStage(s JobStatus) bool {
	switch s {
	case StatusOriginal, StatusCorrected, StatusComplete:
		return true
	default:
		return false
	}
}

func NormalizeStatus(s JobStatus) JobStatus {
	switch s {
	case StatusImported, StatusAwaitingPDF, StatusReady, StatusCleaning:
		return StatusOriginal
	case StatusDone, StatusVerified:
		return StatusComplete
	default:
		if IsStage(s) {
			return s
		}
		return StatusOriginal
	}
}

func isAcceptedStatus(s JobStatus) bool {
	switch s {
	case StatusOriginal, StatusCorrected, StatusComplete,
		StatusVerified, StatusDone, StatusImported, StatusAwaitingPDF, StatusReady, StatusCleaning:
		return true
	default:
		return false
	}
}

func (j Job) ClaimActive(now time.Time) bool {
	if j.ClaimedBy == "" {
		return false
	}
	if j.ClaimExpiresAt == nil {
		return true
	}
	return now.Before(*j.ClaimExpiresAt)
}

func (j Job) HeldBy(userID string, now time.Time) bool {
	return j.ClaimActive(now) && j.ClaimedBy == userID
}

func (j Job) ClaimableBy(userID string, now time.Time) bool {
	if !j.ClaimActive(now) {
		return true
	}
	return j.ClaimedBy == userID
}

func ValidateStage(job Job, userID string, want JobStatus) error {
	if !isAcceptedStatus(want) {
		return fmt.Errorf("unknown stage %s", want)
	}
	cur := NormalizeStatus(job.Status)
	next := NormalizeStatus(want)
	if cur == next {
		return nil
	}
	switch cur {
	case StatusOriginal:
		if next != StatusCorrected && next != StatusComplete {
			return fmt.Errorf("original can move to review or complete")
		}
		if !job.HasPDF {
			return fmt.Errorf("attach a vector pdf before leaving original")
		}
	case StatusCorrected:
		if next == StatusOriginal || next == StatusComplete {
			return nil
		}
		return fmt.Errorf("in review can move to complete or back to original")
	case StatusComplete:
		if next == StatusOriginal || next == StatusCorrected {
			return nil
		}
		return fmt.Errorf("complete can move back to review or original")
	default:
		return fmt.Errorf("cannot move from %s to %s", cur, next)
	}
	return nil
}
