-- Dedicated collector project. Do not run against takeoff-services production.

create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key,
  email text not null unique,
  name text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  status text not null default 'original'
    check (status in ('original', 'corrected', 'verified', 'complete')),
  source_coco_key text,
  conflict_count int not null default 0,
  claimed_by uuid references users(id),
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  corrected_by uuid references users(id),
  verified_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  storage_key text not null,
  sha256 text not null,
  page_count int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists pages (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  page_index int not null,
  pdf_page int not null,
  width_px75 int not null default 0,
  height_px75 int not null default 0,
  width_pt double precision,
  height_pt double precision,
  raster_dpi int not null default 75,
  image_key text,
  vectors_key text,
  unique (job_id, page_index)
);

create table if not exists annotation_revisions (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  page_index int not null,
  version int not null,
  parent_version int,
  author_id uuid references users(id),
  storage_key text not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  unique (job_id, page_index, version)
);

create table if not exists page_blackouts (
  job_id uuid not null references jobs(id) on delete cascade,
  page int not null,
  regions jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  primary key (job_id, page)
);

create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  action text not null,
  job_id uuid,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists jobs_status_idx on jobs (status);
create index if not exists jobs_claim_idx on jobs (claimed_by, claim_expires_at);
create index if not exists revisions_job_page_idx on annotation_revisions (job_id, page_index, version desc);
