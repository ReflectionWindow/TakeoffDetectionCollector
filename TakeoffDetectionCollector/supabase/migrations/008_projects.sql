-- Projects: named buckets for jobs. Root (unassigned) is jobs.project_id IS NULL.
-- migrate/main.go re-runs every file, so the Manila backfill is one-shot
-- (only when jobs.project_id is first added).

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

insert into projects (slug, name)
values ('manila', 'Manila'), ('chicago', 'Chicago')
on conflict (slug) do nothing;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'jobs' and column_name = 'project_id'
  ) then
    alter table jobs add column project_id uuid references projects(id);
    update jobs
    set project_id = (select id from projects where slug = 'manila')
    where project_id is null;
  end if;
end $$;

alter table jobs drop constraint if exists jobs_slug_key;

create unique index if not exists jobs_slug_in_project_idx
  on jobs (project_id, slug) where project_id is not null;

create unique index if not exists jobs_slug_root_idx
  on jobs (slug) where project_id is null;

create index if not exists jobs_project_idx on jobs (project_id);
