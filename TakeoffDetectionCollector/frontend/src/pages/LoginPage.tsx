import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { clearSession, devLogin, getToken, health, isSessionError, me, setToken } from "../lib/api";
import { isSupabaseConfigured, signInWithMicrosoft } from "../lib/supabase";

const COMPANY = "@reflectionwindow.com";
const API_DOWN = "The collector API is not running. Start the backend, then try again.";

export default function LoginPage() {
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(
    params.get("error") === "domain" ? `Sign-in restricted to ${COMPANY} accounts.` : null,
  );
  const [busy, setBusy] = useState(false);
  const [devOk, setDevOk] = useState(false);
  const [apiDown, setApiDown] = useState(false);
  const [sessionOk, setSessionOk] = useState(false);
  const [checking, setChecking] = useState(() => Boolean(getToken()));
  const microsoft = isSupabaseConfigured();

  useEffect(() => {
    void health()
      .then((h) => {
        setDevOk(h.dev_auth);
        setApiDown(false);
      })
      .catch(() => {
        setApiDown(true);
        setDevOk(false);
        setError(API_DOWN);
      });
  }, []);

  useEffect(() => {
    if (!getToken()) {
      setChecking(false);
      return;
    }
    let alive = true;
    void me()
      .then(() => {
        if (alive) setSessionOk(true);
      })
      .catch((err) => {
        if (isSessionError(err)) void clearSession();
        if (alive) setChecking(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (sessionOk) return <Navigate to="/" replace />;
  if (checking) {
    return (
      <div className="auth-wrap">
        <p className="muted">Checking session…</p>
      </div>
    );
  }

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
        <p className="eyebrow">Collector</p>
        <h1>Sign in</h1>
        <p className="muted">Use a Microsoft account at {COMPANY}.</p>
        {error ? <p className="error">{error}</p> : null}
        <button type="button" className="btn-primary" disabled={!microsoft || busy || apiDown} onClick={onMicrosoft}>
          Sign in with Microsoft
        </button>
        {!microsoft ? (
          <p className="muted small">Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable Microsoft.</p>
        ) : null}
        {devOk ? (
          <form onSubmit={onDev}>
            <button type="submit" className="btn-ghost" disabled={busy || apiDown}>
              Dev sign-in
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
