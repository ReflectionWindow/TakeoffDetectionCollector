-- Job tags: a shared catalog plus many-to-many assignment.
-- Users pick an existing name or type a new one; names are unique case-insensitively.

create table if not exists tags (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  constraint tags_name_len check (char_length(trim(name)) between 1 and 40)
);

create unique index if not exists tags_name_lower_idx on tags (lower(name));

create table if not exists job_tags (
  job_id uuid not null references jobs(id) on delete cascade,
  tag_id uuid not null references tags(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (job_id, tag_id)
);

create index if not exists job_tags_tag_idx on job_tags (tag_id);
