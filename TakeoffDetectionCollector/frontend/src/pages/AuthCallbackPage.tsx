import { useEffect, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { isAuthenticated, loginWithSupabase, setToken } from "../lib/api";
import { getSupabase, isSupabaseConfigured, signOutSupabase } from "../lib/supabase";

const COMPANY = "@reflectionwindow.com";
const exchanges = new Map<string, Promise<{ ok: true } | { ok: false; reason: "domain" | "retry" }>>();

async function completeSignIn(code: string) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Microsoft sign-in is not configured.");
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) {
    const { data: existing } = await supabase.auth.getSession();
    if (!existing.session?.access_token) {
      if (/code verifier|already used|expired|flow state/i.test(exchangeError.message || "")) {
        return { ok: false as const, reason: "retry" as const };
      }
      throw exchangeError;
    }
  }
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  const accessToken = data.session?.access_token;
  const email = data.session?.user?.email?.trim().toLowerCase() ?? "";
  if (!accessToken || !email) throw new Error("No Supabase session after Microsoft sign-in.");
  if (!email.endsWith(COMPANY)) {
    await signOutSupabase();
    return { ok: false as const, reason: "domain" as const };
  }
  const auth = await loginWithSupabase(accessToken);
  setToken(auth.token);
  await signOutSupabase();
  return { ok: true as const };
}

function signInOnce(code: string) {
  const existing = exchanges.get(code);
  if (existing) return existing;
  const started = completeSignIn(code);
  exchanges.set(code, started);
  return started;
}

export default function AuthCallbackPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function finish() {
      if (!isSupabaseConfigured()) {
        setError("Microsoft sign-in is not configured.");
        return;
      }
      const code = params.get("code");
      const oauthError = params.get("error_description") || params.get("error");
      if (oauthError) {
        setError(oauthError);
        return;
      }
      try {
        if (!code) {
          navigate(isAuthenticated() ? "/" : "/login", { replace: true });
          return;
        }
        const outcome = await signInOnce(code);
        if (cancelled) return;
        if (!outcome.ok) {
          navigate(outcome.reason === "domain" ? "/login?error=domain" : "/login", { replace: true });
          return;
        }
        navigate("/", { replace: true });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    void finish();
    return () => {
      cancelled = true;
    };
  }, [navigate, params]);

  if (isAuthenticated() && !error && !params.get("code")) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>{error ? "Could not complete sign-in" : "Completing sign-in…"}</h1>
        {error ? <p className="error">{error}</p> : <p className="muted">Finishing Microsoft authentication.</p>}
        {error ? (
          <button type="button" className="btn-primary" onClick={() => navigate("/login", { replace: true })}>
            Back to login
          </button>
        ) : null}
      </div>
    </div>
  );
}
