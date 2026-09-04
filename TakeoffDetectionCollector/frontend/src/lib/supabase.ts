import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null | undefined;

export function isSupabaseConfigured(): boolean {
  return Boolean(import.meta.env.VITE_SUPABASE_URL?.trim() && import.meta.env.VITE_SUPABASE_ANON_KEY?.trim());
}

export function getSupabase(): SupabaseClient | null {
  if (cached !== undefined) return cached;
  const url = import.meta.env.VITE_SUPABASE_URL?.trim();
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!url || !key) {
    cached = null;
    return null;
  }
  cached = createClient(url, key, {
    auth: {
      flowType: "pkce",
      detectSessionInUrl: false,
      persistSession: true,
      autoRefreshToken: true,
    },
  });
  return cached;
}

export async function signOutSupabase(): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    /* best-effort */
  }
}

export async function signInWithMicrosoft(): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) {
    throw new Error("Microsoft sign-in is not configured (missing VITE_SUPABASE_*).");
  }
  await signOutSupabase();
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "azure",
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
      scopes: "openid email profile",
      queryParams: { prompt: "select_account" },
    },
  });
  if (error) throw error;
}
