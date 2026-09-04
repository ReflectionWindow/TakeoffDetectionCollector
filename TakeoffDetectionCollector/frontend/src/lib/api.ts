import type {
  AnnotationPayload,
  AuthUser,
  Job,
  PageMeta,
  PageVectorsResponse,
  Revision,
  StoredBox,
} from "../api/types";
import type { BlackoutRegion } from "./pageBlackouts";

const TOKEN_KEY = "collector.token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function isAuthenticated(): boolean {
  return Boolean(getToken());
}

function apiBase(): string {
  const raw = import.meta.env.VITE_API_URL?.trim();
  return raw ? raw.replace(/\/$/, "") : "";
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${apiBase()}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  if (res.headers.get("content-type")?.includes("application/json")) {
    return res.json() as Promise<T>;
  }
  return res as unknown as T;
}

export async function health(): Promise<{ ok: boolean; dev_auth: boolean }> {
  return request("/health");
}

export async function devLogin(): Promise<{ token: string; user: AuthUser }> {
  return request("/v1/auth/dev", { method: "POST" });
}

export async function loginWithSupabase(accessToken: string): Promise<{ token: string; user: AuthUser }> {
  setToken(accessToken);
  return request("/v1/auth/supabase", { method: "POST" });
}

export async function me(): Promise<{ user: AuthUser; dev_auth: boolean }> {
  return request("/v1/me");
}

export async function listJobs(): Promise<{ jobs: Job[] }> {
  return request("/v1/jobs");
}

export async function getJob(id: string): Promise<{ job: Job; pages: PageMeta[] }> {
  return request(`/v1/jobs/${id}`);
}

export async function importCocoFile(file: File): Promise<{ imported: number; jobs: Job[] }> {
  const body = new FormData();
  body.append("file", file);
  return request("/v1/imports/coco", { method: "POST", body });
}

export async function importCocoDir(dir: string): Promise<{ imported: number; jobs: Job[] }> {
  const body = new FormData();
  body.append("dir", dir);
  return request("/v1/imports/coco", { method: "POST", body });
}

export async function attachPdf(jobId: string, file: File): Promise<{ ok: boolean }> {
  const body = new FormData();
  body.append("file", file);
  return request(`/v1/jobs/${jobId}/pdf`, { method: "POST", body });
}

export function pdfUrl(jobId: string): string {
  return `${apiBase()}/v1/jobs/${jobId}/pdf`;
}

export async function fetchPdf(jobId: string): Promise<ArrayBuffer> {
  const headers = new Headers();
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${apiBase()}/v1/jobs/${jobId}/pdf`, { headers });
  if (!res.ok) throw new Error(await res.text());
  return res.arrayBuffer();
}

export async function getAnnotations(
  jobId: string,
  page: number,
): Promise<{ revision: Revision; payload: AnnotationPayload }> {
  return request(`/v1/jobs/${jobId}/pages/${page}/annotations`);
}

export async function saveAnnotations(
  jobId: string,
  page: number,
  boxes: StoredBox[],
  note = "",
): Promise<{ revision: Revision; payload: AnnotationPayload }> {
  return request(`/v1/jobs/${jobId}/pages/${page}/annotations`, {
    method: "POST",
    body: JSON.stringify({ boxes, note }),
  });
}

export async function listRevisions(jobId: string, page: number): Promise<{ revisions: Revision[] }> {
  return request(`/v1/jobs/${jobId}/pages/${page}/revisions`);
}

export async function revertAnnotations(
  jobId: string,
  page: number,
  version: number,
): Promise<{ revision: Revision; payload: AnnotationPayload }> {
  return request(`/v1/jobs/${jobId}/pages/${page}/revert`, {
    method: "POST",
    body: JSON.stringify({ version }),
  });
}

export async function getVectors(jobId: string, page: number): Promise<PageVectorsResponse> {
  return request(`/v1/jobs/${jobId}/pages/${page}/vectors`);
}

export async function getBlackouts(jobId: string, page: number): Promise<{ regions: BlackoutRegion[] }> {
  return request(`/v1/jobs/${jobId}/pages/${page}/blackouts`);
}

export async function putBlackouts(
  jobId: string,
  page: number,
  regions: BlackoutRegion[],
): Promise<{ regions: BlackoutRegion[] }> {
  return request(`/v1/jobs/${jobId}/pages/${page}/blackouts`, {
    method: "PUT",
    body: JSON.stringify({ regions }),
  });
}

export function exportCocoUrl(jobId: string): string {
  return `${apiBase()}/v1/jobs/${jobId}/export/coco`;
}

export async function downloadCoco(jobId: string, slug: string): Promise<void> {
  const headers = new Headers();
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(exportCocoUrl(jobId), { headers });
  if (!res.ok) throw new Error(await res.text());
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${slug}.coco.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
