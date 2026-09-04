import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Job } from "../api/types";
import { importCocoDir, importCocoFile, listJobs, me, setToken } from "../lib/api";

export default function InboxPage() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dir, setDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");

  async function refresh() {
    const data = await listJobs();
    setJobs(data.jobs);
  }

  useEffect(() => {
    void me()
      .then((m) => setEmail(m.user.email))
      .catch(() => navigate("/login", { replace: true }));
    void refresh().catch((err) => setError(String(err)));
  }, [navigate]);

  async function onZip(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await importCocoFile(file);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onDir() {
    if (!dir.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await importCocoDir(dir.trim());
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <strong>Collector</strong>
        <span className="muted">{email}</span>
        <span className="spacer" />
        <button
          type="button"
          className="btn-ghost"
          onClick={() => {
            setToken(null);
            navigate("/login");
          }}
        >
          Sign out
        </button>
      </header>
      <main className="inbox">
        <section className="import-panel">
          <h2>Import 75 DPI COCO</h2>
          <p className="muted">
            Zip of job folders, a single <code>_annotations.coco.json</code>, or a server path to the
            dataset tree.
          </p>
          <label className="btn-primary file-btn">
            Upload zip / JSON
            <input
              type="file"
              accept=".zip,.json"
              hidden
              onChange={(e) => void onZip(e.target.files?.[0])}
            />
          </label>
          <div className="row">
            <input
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              placeholder="/path/to/coco-redacted-good-jobs-louvers-metal-panels"
            />
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => void onDir()}>
              Import directory
            </button>
          </div>
          {busy ? <p className="muted">Importing…</p> : null}
          {error ? <p className="error">{error}</p> : null}
        </section>
        <section>
          <h2>Jobs ({jobs.length})</h2>
          <table className="jobs">
            <thead>
              <tr>
                <th>Job</th>
                <th>Status</th>
                <th>Pages</th>
                <th>Boxes</th>
                <th>PDF</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>
                    <Link to={`/jobs/${job.id}`}>{job.slug}</Link>
                  </td>
                  <td>
                    <span className={`pill ${job.status}`}>{job.status.replace("_", " ")}</span>
                  </td>
                  <td>{job.page_count}</td>
                  <td>{job.box_count}</td>
                  <td>{job.has_pdf ? "yes" : "awaiting"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </div>
  );
}
