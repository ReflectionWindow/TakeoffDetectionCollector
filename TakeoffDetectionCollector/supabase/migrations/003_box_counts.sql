-- Annotation payloads live in object storage, so the inbox cannot count boxes
-- without fetching every page. Keep the count next to the revision row.
-- Safe to run repeatedly.

alter table annotation_revisions add column if not exists box_count int not null default 0;

-- Inbox aggregates read the newest revision per page.
create index if not exists annotation_revisions_latest_idx
  on annotation_revisions (job_id, page_index, version desc);
