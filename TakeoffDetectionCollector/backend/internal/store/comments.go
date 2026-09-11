package store

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	MaxCommentLen      = 4000
	MaxAnnotationIDLen = 128
)

type PageComment struct {
	ID           string    `json:"id"`
	JobID        string    `json:"job_id"`
	PageIndex    int       `json:"page_index"`
	AuthorID     string    `json:"author_id"`
	AuthorEmail  string    `json:"author_email"`
	AuthorName   string    `json:"author_name"`
	Body         string    `json:"body"`
	AnnotationID string    `json:"annotation_id,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func NormalizeCommentBody(raw string) (string, error) {
	body := strings.TrimSpace(raw)
	if body == "" {
		return "", fmt.Errorf("comment is empty")
	}
	if strings.ContainsRune(body, 0) {
		return "", fmt.Errorf("comment is invalid")
	}
	if utf8.RuneCountInString(body) > MaxCommentLen {
		return "", fmt.Errorf("comment must be %d characters or fewer", MaxCommentLen)
	}
	return body, nil
}

func NormalizeAnnotationID(raw string) (string, error) {
	id := strings.TrimSpace(raw)
	if id == "" {
		return "", nil
	}
	if strings.ContainsRune(id, 0) {
		return "", fmt.Errorf("annotation id is invalid")
	}
	if utf8.RuneCountInString(id) > MaxAnnotationIDLen {
		return "", fmt.Errorf("annotation id must be %d characters or fewer", MaxAnnotationIDLen)
	}
	return id, nil
}

func NormalizePageComment(c *PageComment) error {
	if c.JobID == "" {
		return fmt.Errorf("job id is required")
	}
	if c.AuthorID == "" {
		return fmt.Errorf("author is required")
	}
	if c.PageIndex < 0 {
		return fmt.Errorf("page index is invalid")
	}
	body, err := NormalizeCommentBody(c.Body)
	if err != nil {
		return err
	}
	ann, err := NormalizeAnnotationID(c.AnnotationID)
	if err != nil {
		return err
	}
	c.Body = body
	c.AnnotationID = ann
	return nil
}
