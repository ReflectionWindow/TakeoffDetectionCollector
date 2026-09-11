package store

import "strings"

const (
	DefaultJobPageSize = 25
	MaxJobPageSize     = 100
	MaxJobQueryLen     = 200
)

type JobListQuery struct {
	Stage   JobStatus
	Tags    []string
	Q       string
	Project string
	Limit   int
	Offset  int
}

type StageCounts struct {
	All       int `json:"all"`
	Original  int `json:"original"`
	Corrected int `json:"corrected"`
	Complete  int `json:"complete"`
}

type TagCount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type JobList struct {
	Jobs      []Job       `json:"jobs"`
	Total     int         `json:"total"`
	Limit     int         `json:"limit"`
	Offset    int         `json:"offset"`
	Counts    StageCounts `json:"counts"`
	TagCounts []TagCount  `json:"tag_counts"`
}

func (q JobListQuery) Normalized() JobListQuery {
	if q.Limit <= 0 {
		q.Limit = DefaultJobPageSize
	}
	if q.Limit > MaxJobPageSize {
		q.Limit = MaxJobPageSize
	}
	if q.Offset < 0 {
		q.Offset = 0
	}
	if q.Stage != "" {
		q.Stage = NormalizeStatus(q.Stage)
	}
	q.Q = strings.TrimSpace(q.Q)
	if len(q.Q) > MaxJobQueryLen {
		q.Q = q.Q[:MaxJobQueryLen]
	}
	q.Project = NormalizeProjectScope(q.Project)
	tags := make([]string, 0, len(q.Tags))
	seen := map[string]struct{}{}
	for _, raw := range q.Tags {
		name := strings.ToLower(strings.TrimSpace(raw))
		if name == "" {
			continue
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		tags = append(tags, name)
	}
	q.Tags = tags
	return q
}

func jobMatchesTags(job Job, tags []string) bool {
	if len(tags) == 0 {
		return true
	}
	have := map[string]struct{}{}
	for _, t := range job.Tags {
		have[strings.ToLower(t)] = struct{}{}
	}
	for _, t := range tags {
		if _, ok := have[t]; ok {
			return true
		}
	}
	return false
}

func jobMatchesSearch(job Job, q JobListQuery) bool {
	return jobMatchesQuery(job, q.Q) && jobMatchesProject(job, q.Project)
}

func jobMatchesList(job Job, q JobListQuery) bool {
	if !jobMatchesSearch(job, q) {
		return false
	}
	if q.Stage != "" && NormalizeStatus(job.Status) != q.Stage {
		return false
	}
	return jobMatchesTags(job, q.Tags)
}

func ilikeContains(q string) string {
	q = strings.ReplaceAll(q, `\`, `\\`)
	q = strings.ReplaceAll(q, `%`, `\%`)
	q = strings.ReplaceAll(q, `_`, `\_`)
	return "%" + q + "%"
}
