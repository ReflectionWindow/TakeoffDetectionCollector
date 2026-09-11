-- Collapse verified into complete. Three statuses: original, corrected, complete.

update jobs set status = 'complete' where status = 'verified';

alter table jobs drop constraint if exists jobs_status_check;
alter table jobs add constraint jobs_status_check
  check (status in ('original', 'corrected', 'complete'));
