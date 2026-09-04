import type { Geometry, UploadResponse } from "./types";

const TOKEN_KEY = "takeoff.token";

export function apiBase(): string {
  const raw = import.meta.env.VITE_API_URL ?? "";
  return raw.replace(/\/$/, "");
}

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${apiBase()}${path}`, { ...init, headers });
  if (res.status === 401) {
    setToken(null);
    throw new Error("Unauthorized. Sign in again.");
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export async function createSession(password: string): Promise<string> {
  const data = await request<{ token: string }>("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  setToken(data.token);
  return data.token;
}

export async function uploadPdf(file: File): Promise<UploadResponse> {
  const body = new FormData();
  body.append("file", file);
  return request<UploadResponse>("/api/pdf", { method: "POST", body });
}

export async function fetchGeometry(fileId: string, pageIndex: number): Promise<Geometry> {
  return request<Geometry>(`/api/pdf/${fileId}/pages/${pageIndex}/geometry`);
}
