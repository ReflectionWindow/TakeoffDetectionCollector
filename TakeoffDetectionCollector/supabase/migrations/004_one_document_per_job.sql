-- A job has exactly one source PDF, but SetDocument used a plain insert, so
-- re-running ingest added another documents row each time. Any query joining
-- pages to documents then returned every page once per document.
-- Safe to run repeatedly.

delete from documents
where ctid in (
  select ctid from (
    select ctid, row_number() over (
      partition by job_id order by created_at desc, ctid desc
    ) as rn
    from documents
  ) ranked
  where ranked.rn > 1
);

create unique index if not exists documents_job_id_key on documents (job_id);
