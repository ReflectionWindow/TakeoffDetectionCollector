-- Four-stage workflow + exclusive claim for concurrent correctors.
-- Safe to run on databases that already applied 001_init.

alter table jobs add column if not exists claimed_by uuid references users(id);
alter table jobs add column if not exists claimed_at timestamptz;
alter table jobs add column if not exists claim_expires_at timestamptz;
alter table jobs add column if not exists corrected_by uuid references users(id);
alter table jobs add column if not exists verified_by uuid references users(id);

update jobs set status = 'original'
  where status in ('imported', 'awaiting_pdf', 'ready', 'cleaning');
update jobs set status = 'complete' where status = 'done';

alter table jobs drop constraint if exists jobs_status_check;
alter table jobs add constraint jobs_status_check
  check (status in ('original', 'corrected', 'verified', 'complete'));

alter table jobs alter column status set default 'original';

create index if not exists jobs_claim_idx on jobs (claimed_by, claim_expires_at);
