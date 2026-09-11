import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Job, JobStatus } from "../api/types";
import JobTags from "../components/JobTags";
import { claimNext, clearSession, deleteJob, isSessionError, listJobs, listTags, me, setJobTags } from "../lib/api";
import { STAGE_LABEL, STAGES, isLockedByOther, inUseReason, normalizeStatus, openedByLabel } from "../lib/stages";
import { mergeCatalog, tagKey } from "../lib/tags";

const PAGE_SIZE = 25;

export default function InboxPage() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [catalog, setCatalog] = useState<{ name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [userId, setUserId] = useState("");
  const [stage, setStage] = useState<JobStatus | "">("");
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({ all: 0, original: 0, corrected: 0, complete: 0 });
  const [tagCounts, setTagCounts] = useState<{ name: string; count: number }[]>([]);
  const pendingTags = useRef(new Set<string>());
  const pendingDeletes = useRef(new Set<string>());
  const [reload, setReload] = useState(0);

  useEffect(() => {
    void me()
      .then((m) => {
        setEmail(m.user.email);
        setUserId(m.user.id);
      })
      .catch((err) => {
        if (isSessionError(err)) {
          void clearSession().then(() => navigate("/login", { replace: true }));
        }
      });
  }, [navigate]);

  useEffect(() => {
    let alive = true;
    async function load() {
      const [data, tags] = await Promise.all([
        listJobs({
          stage: stage || undefined,
          tags: tagFilter,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        }),
        listTags().catch(() => ({ tags: [] as { name: string }[] })),
      ]);
      if (!alive) return;
      setCatalog(tags.tags);
      setJobs((prev) =>
        data.jobs
          .filter((j) => !pendingDeletes.current.has(j.id))
          .map((j) => (pendingTags.current.has(j.id) ? (prev.find((p) => p.id === j.id) ?? j) : j)),
      );
      setTotal(data.total);
      setCounts(data.counts);
      setTagCounts(data.tag_counts ?? []);
      if (data.total > 0 && page * PAGE_SIZE >= data.total) {
        setPage(Math.max(0, Math.floor((data.total - 1) / PAGE_SIZE)));
      }
    }
    void load().catch((err) => {
      if (alive) setError(err instanceof Error ? err.message : String(err));
    });
    const tick = window.setInterval(() => {
      void load().catch(() => undefined);
    }, 8_000);
    return () => {
      alive = false;
      window.clearInterval(tick);
    };
  }, [stage, tagFilter, page, reload]);

  async function onNext(which: "original" | "corrected") {
    setBusy(true);
    setError(null);
    try {
      const res = await claimNext(which);
      navigate(`/jobs/${res.job.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onTags(jobId: string, tags: string[]) {
    pendingTags.current.add(jobId);
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, tags } : j)));
    try {
      const res = await setJobTags(jobId, tags);
      setJobs((prev) => prev.map((j) => (j.id === jobId ? res.job : j)));
      setCatalog((prev) => mergeCatalog(prev, [res.job]).map((name) => ({ name })));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      pendingTags.current.delete(jobId);
    }
  }

  async function onDelete(job: Job) {
    const ok = window.confirm(`Delete “${job.slug}”? This removes the sheet, PDF, and annotations.`);
    if (!ok) return;
    pendingDeletes.current.add(job.id);
    setError(null);
    setJobs((prev) => prev.filter((j) => j.id !== job.id));
    setTotal((n) => Math.max(0, n - 1));
    const st = normalizeStatus(job.status);
    setCounts((c) => ({
      all: Math.max(0, c.all - 1),
      original: st === "original" ? Math.max(0, c.original - 1) : c.original,
      corrected: st === "corrected" ? Math.max(0, c.corrected - 1) : c.corrected,
      complete: st === "complete" ? Math.max(0, c.complete - 1) : c.complete,
    }));
    setTagCounts((prev) =>
      prev
        .map((t) =>
          job.tags?.some((name) => tagKey(name) === tagKey(t.name)) ? { ...t, count: Math.max(0, t.count - 1) } : t,
        )
        .filter((t) => t.count > 0),
    );
    try {
      await deleteJob(job.id);
      pendingDeletes.current.delete(job.id);
    } catch (err) {
      pendingDeletes.current.delete(job.id);
      setError(err instanceof Error ? err.message : String(err));
      setReload((n) => n + 1);
    }
  }

  const names = useMemo(() => mergeCatalog(catalog, jobs), [catalog, jobs]);
  const byTag = useMemo(() => {
    const map: Record<string, number> = {};
    for (const t of tagCounts) map[tagKey(t.name)] = t.count;
    return map;
  }, [tagCounts]);
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  function chooseStage(next: JobStatus | "") {
    setStage(next);
    setPage(0);
  }

  function toggleTagFilter(name: string) {
    setTagFilter((prev) => {
      const key = tagKey(name);
      return prev.some((t) => tagKey(t) === key) ? prev.filter((t) => tagKey(t) !== key) : [...prev, name];
    });
    setPage(0);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <strong>Collector</strong>
        <span className="muted">{email}</span>
        <span className="spacer" />
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void onNext("original")}>
          Open next original
        </button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => void onNext("corrected")}>
          Open next in review
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => {
            void clearSession().then(() => navigate("/login"));
          }}
        >
          Sign out
        </button>
      </header>
      <main className="inbox">
        <section className="import-panel">
          <p className="eyebrow">Markup correction</p>
          <h2>Open a sheet, then walk it in order.</h2>
          <p className="muted small exclusive-note">
            Only one person can have a sheet open at a time. If someone else is in it, you will see their name and cannot open it until they leave.
          </p>
        </section>

        {error ? <p className="error">{error}</p> : null}

        <section>
          <div className="stage-filter">
            <button type="button" className={stage === "" ? "active" : ""} onClick={() => chooseStage("")}>
              All ({counts.all})
            </button>
            {STAGES.map((s) => (
              <button key={s} type="button" className={stage === s ? "active" : ""} onClick={() => chooseStage(s)}>
                {STAGE_LABEL[s]} ({counts[s] ?? 0})
              </button>
            ))}
          </div>
          {tagCounts.length ? (
            <div className="stage-filter tag-filter">
              {tagCounts.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  className={tagFilter.some((x) => tagKey(x) === tagKey(t.name)) ? "active" : ""}
                  onClick={() => toggleTagFilter(t.name)}
                >
                  {t.name} ({byTag[tagKey(t.name)] ?? t.count})
                </button>
              ))}
            </div>
          ) : null}
          <table className="jobs">
            <thead>
              <tr>
                <th>Job</th>
                <th>Stage</th>
                <th>Tags</th>
                <th>Pages</th>
                <th>Boxes</th>
                <th>PDF</th>
                <th>Opened by</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const taken = isLockedByOther(job, userId);
                const reason = inUseReason(job, userId);
                return (
                  <tr key={job.id} className={taken ? "job-taken" : undefined}>
                    <td>
                      {taken ? (
                        <span>
                          {job.slug}
                          {reason ? <span className="taken-reason">{reason}</span> : null}
                        </span>
                      ) : (
                        <Link to={`/jobs/${job.id}`}>{job.slug}</Link>
                      )}
                    </td>
                    <td>
                      <span className={`pill ${normalizeStatus(job.status)}`}>{STAGE_LABEL[normalizeStatus(job.status)]}</span>
                    </td>
                    <td className="job-tags-cell">
                      <JobTags tags={job.tags} catalog={names} onChange={(next) => void onTags(job.id, next)} />
                    </td>
                    <td>{job.page_count}</td>
                    <td>{job.box_count}</td>
                    <td>{job.has_pdf ? "vector" : "missing"}</td>
                    <td className="muted small">{openedByLabel(job, userId)}</td>
                    <td className="job-actions">
                      <button type="button" className="btn-danger-quiet" onClick={() => void onDelete(job)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="pager">
            <span className="muted small">
              {total === 0 ? "No jobs" : `${from}–${to} of ${total}`}
            </span>
            <span className="spacer" />
            <button type="button" className="btn-ghost" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              Previous
            </button>
            <button type="button" className="btn-ghost" disabled={page >= lastPage} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
