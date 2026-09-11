package store

import (
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	ProjectScopeRoot   = "root"
	ProjectManilaSlug  = "manila"
	ProjectChicagoSlug = "chicago"
	MaxProjectName     = 80

	// Stable IDs for the in-memory store so tests can refer to seeded projects.
	ProjectManilaID  = "00000000-0000-4000-8000-000000000001"
	ProjectChicagoID = "00000000-0000-4000-8000-000000000002"
)

type Project struct {
	ID        string    `json:"id"`
	Slug      string    `json:"slug"`
	Name      string    `json:"name"`
	JobCount  int       `json:"job_count"`
	CreatedAt time.Time `json:"created_at"`
}

func NormalizeProjectName(raw string) (name, slug string, err error) {
	name = strings.Join(strings.Fields(raw), " ")
	if name == "" {
		return "", "", fmt.Errorf("project name is empty")
	}
	if utf8.RuneCountInString(name) > MaxProjectName {
		return "", "", fmt.Errorf("project name must be %d characters or fewer", MaxProjectName)
	}
	slug = projectSlug(name)
	if slug == "" || slug == ProjectScopeRoot || slug == "all" {
		return "", "", fmt.Errorf("project name is invalid")
	}
	return name, slug, nil
}

func projectSlug(name string) string {
	var b strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(name) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		if lastDash {
			continue
		}
		b.WriteByte('-')
		lastDash = true
	}
	return strings.Trim(b.String(), "-")
}

// NormalizeProjectScope returns "" (all), "root", or a project id.
func NormalizeProjectScope(raw string) string {
	raw = strings.TrimSpace(strings.ToLower(raw))
	if raw == "" || raw == "all" {
		return ""
	}
	if raw == ProjectScopeRoot {
		return ProjectScopeRoot
	}
	return strings.TrimSpace(raw)
}

func jobMatchesProject(job Job, project string) bool {
	if project == "" {
		return true
	}
	if project == ProjectScopeRoot {
		return job.ProjectID == ""
	}
	return job.ProjectID == project
}

func jobMatchesQuery(job Job, q string) bool {
	if q == "" {
		return true
	}
	needle := strings.ToLower(q)
	return strings.Contains(strings.ToLower(job.Slug), needle) || strings.Contains(strings.ToLower(job.Title), needle)
}

func slugKey(projectID, slug string) string {
	if projectID == "" {
		return ProjectScopeRoot + "\x00" + slug
	}
	return projectID + "\x00" + slug
}
