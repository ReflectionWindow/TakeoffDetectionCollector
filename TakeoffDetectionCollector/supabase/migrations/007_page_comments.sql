-- Page comments left during cleaning / review. Optional annotation_id is a
-- soft link to StoredBox.id (boxes live in versioned JSON, so this is not an FK).

create table if not exists page_comments (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  page_index int not null,
  author_id uuid not null references users(id),
  body text not null,
  annotation_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint page_comments_body_len check (char_length(trim(body)) between 1 and 4000),
  constraint page_comments_annotation_len check (annotation_id is null or char_length(annotation_id) between 1 and 128)
);

create index if not exists page_comments_job_page_idx
  on page_comments (job_id, page_index, created_at);
