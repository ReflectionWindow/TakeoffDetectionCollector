import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { devLogin, health, isAuthenticated, setToken } from "../lib/api";
import { isSupabaseConfigured, signInWithMicrosoft } from "../lib/supabase";

const COMPANY = "@reflectionwindow.com";

export default function LoginPage() {
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(
    params.get("error") === "domain" ? `Sign-in restricted to ${COMPANY} accounts.` : null,
  );
  const [busy, setBusy] = useState(false);
  const [devOk, setDevOk] = useState(false);
  const microsoft = isSupabaseConfigured();

  useEffect(() => {
    void health()
      .then((h) => setDevOk(h.dev_auth))
      .catch(() => setDevOk(true));
  }, []);

  if (isAuthenticated()) return <Navigate to="/" replace />;

  async function onMicrosoft() {
    setError(null);
    setBusy(true);
    try {
      await signInWithMicrosoft();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function onDev(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await devLogin();
      setToken(res.token);
      window.location.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <p className="eyebrow">TakeoffDetectionCollector</p>
        <h1>Clean elevation labels</h1>
        <p className="muted">
          Microsoft accounts at {COMPANY}. Env keys can be added later — local Dev sign-in works
          until then.
        </p>
        {error ? <p className="error">{error}</p> : null}
        <button type="button" className="btn-primary" disabled={!microsoft || busy} onClick={onMicrosoft}>
          Sign in with Microsoft
        </button>
        {!microsoft ? (
          <p className="muted small">Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable Microsoft.</p>
        ) : null}
        {devOk ? (
          <form onSubmit={onDev}>
            <button type="submit" className="btn-ghost" disabled={busy}>
              Dev sign-in
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
