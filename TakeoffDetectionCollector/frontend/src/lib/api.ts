import type {
  AnnotationPayload,
  AuthUser,
  Job,
  JobTag,
  PageComment,
  PageMeta,
  PageVectorsResponse,
  Project,
  Revision,
  StoredBox,
} from "../api/types";
import type { BlackoutRegion } from "./pageBlackouts";
import { getSupabase, signOutSupabase } from "./supabase";

const TOKEN_KEY = "collector.token";

export const SESSION_EXPIRED_MESSAGE = "Your session expired. Sign in again to keep saving.";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

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

export async function clearSession(): Promise<void> {
  setToken(null);
  await signOutSupabase();
}

export function isSessionError(err: unknown): boolean {
  if (err instanceof ApiError && err.status === 401) return true;
  const raw = (err instanceof Error ? err.message : String(err)).trim();
  return /^unauthorized$/i.test(raw);
}

function apiBase(): string {
  const raw = import.meta.env.VITE_API_URL?.trim();
  return raw ? raw.replace(/\/$/, "") : "";
}

async function currentToken(): Promise<string | null> {
  const supabase = getSupabase();
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    const access = data.session?.access_token;
    if (access) {
      if (access !== getToken()) setToken(access);
      return access;
    }
  }
  return getToken();
}

async function refreshCollectorToken(): Promise<string | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.refreshSession();
  const access = data.session?.access_token;
  if (access) {
    setToken(access);
    return access;
  }
  return null;
}

type RequestOpts = RequestInit & { _retried?: boolean };

async function request<T>(path: string, init: RequestOpts = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = await currentToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${apiBase()}${path}`, { ...init, headers });
  if (res.status === 401 && !init._retried) {
    const refreshed = await refreshCollectorToken();
    if (refreshed) return request<T>(path, { ...init, _retried: true });
    await clearSession();
    throw new ApiError(SESSION_EXPIRED_MESSAGE, 401);
  }
  if (!res.ok) {
    const text = (await res.text()).trim();
    if (res.status === 401 || /^unauthorized$/i.test(text)) {
      await clearSession();
      throw new ApiError(SESSION_EXPIRED_MESSAGE, res.status);
    }
    throw new ApiError(text || res.statusText, res.status);
  }
  if (res.headers.get("content-type")?.includes("application/json")) {
    return res.json() as Promise<T>;
  }
  return res as unknown as T;
}

export async function health(): Promise<{ ok: boolean; dev_auth: boolean }> {
  const res = await fetch(`${apiBase()}/health`);
  if (!res.ok) throw new ApiError((await res.text()).trim() || res.statusText, res.status);
  return res.json() as Promise<{ ok: boolean; dev_auth: boolean }>;
}

export async function devLogin(): Promise<{ token: string; user: AuthUser }> {
  return request("/v1/auth/dev", { method: "POST" });
}

export async function loginWithSupabase(accessToken: string): Promise<{ token: string; user: AuthUser }> {
  const headers = new Headers({ Authorization: `Bearer ${accessToken}` });
  const res = await fetch(`${apiBase()}/v1/auth/supabase`, { method: "POST", headers });
  if (!res.ok) {
    const text = (await res.text()).trim();
    throw new ApiError(text || res.statusText || "Collector API rejected sign-in.", res.status);
  }
  const data = (await res.json()) as { token: string; user: AuthUser };
  setToken(data.token || accessToken);
  return data;
}

export async function me(): Promise<{ user: AuthUser; dev_auth: boolean }> {
  return request("/v1/me");
}

export async function listJobs(opts?: {
  stage?: string;
  tags?: string[];
  q?: string;
  project?: string;
  limit?: number;
  offset?: number;
}): Promise<{
  jobs: Job[];
  total: number;
  limit: number;
  offset: number;
  counts: { all: number; original: number; corrected: number; complete: number };
  tag_counts: { name: string; count: number }[];
}> {
  const q = new URLSearchParams();
  if (opts?.stage) q.set("stage", opts.stage);
  if (opts?.q) q.set("q", opts.q);
  if (opts?.project) q.set("project", opts.project);
  for (const tag of opts?.tags ?? []) q.append("tag", tag);
  q.set("limit", String(opts?.limit ?? 25));
  q.set("offset", String(opts?.offset ?? 0));
  return request(`/v1/jobs?${q.toString()}`);
}

export async function deleteJob(id: string): Promise<{ ok: boolean }> {
  return request(`/v1/jobs/${id}`, { method: "DELETE" });
}

export async function claimJob(id: string): Promise<{ job: Job }> {
  return request(`/v1/jobs/${id}/claim`, { method: "POST" });
}

export async function heartbeatJob(id: string): Promise<{ job: Job }> {
  return request(`/v1/jobs/${id}/heartbeat`, { method: "POST" });
}

export async function releaseJob(id: string): Promise<{ job: Job }> {
  return request(`/v1/jobs/${id}/release`, { method: "POST" });
}

/** Drop the sheet lock as the tab unloads. sendBeacon avoids a CORS preflight. */
export function releaseJobOnUnload(id: string, token = getToken()): void {
  if (!id || !token) return;
  const url = `${apiBase()}/v1/jobs/${id}/release`;
  const auth = `Bearer ${token}`;
  try {
    if (typeof navigator !== "undefined" && navigator.sendBeacon?.(url, new Blob([auth], { type: "text/plain" }))) {
      return;
    }
  } catch {
    /* fall through to keepalive fetch */
  }
  try {
    void fetch(url, { method: "POST", headers: { Authorization: auth }, keepalive: true });
  } catch {
    /* page is going away */
  }
}

export async function claimNext(
  stage: "original" | "corrected" = "original",
  project?: string,
): Promise<{ job: Job }> {
  const q = new URLSearchParams({ stage });
  if (project) q.set("project", project);
  return request(`/v1/jobs/next?${q.toString()}`, { method: "POST" });
}

export async function listProjects(): Promise<{ projects: Project[]; root_job_count: number }> {
  return request("/v1/projects");
}

export async function createProject(name: string): Promise<{ project: Project }> {
  return request("/v1/projects", { method: "POST", body: JSON.stringify({ name }) });
}

export type JobImportResult = {
  imported: number;
  skipped: number;
  jobs: Job[];
  errors: { slug: string; error: string }[];
};

export async function importJobs(files: File[], projectId?: string): Promise<JobImportResult> {
  const body = new FormData();
  if (projectId) body.append("project_id", projectId);
  for (const file of files) {
    body.append("files", file, file.name);
  }
  return request("/v1/imports/jobs", { method: "POST", body });
}

export async function setStage(id: string, stage: Job["status"]): Promise<{ job: Job }> {
  return request(`/v1/jobs/${id}/stage`, { method: "POST", body: JSON.stringify({ stage }) });
}

export async function listTags(): Promise<{ tags: JobTag[] }> {
  return request("/v1/tags");
}

export async function setJobTags(id: string, tags: string[]): Promise<{ job: Job }> {
  return request(`/v1/jobs/${id}/tags`, { method: "PUT", body: JSON.stringify({ tags }) });
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

export type PdfImportResult = {
  attached: number;
  skipped: number;
  jobs: { slug: string; page_count: number; job: Job }[];
};

export async function importPdfsDir(dir: string): Promise<PdfImportResult> {
  const body = new FormData();
  body.append("dir", dir);
  return request("/v1/imports/pdfs", { method: "POST", body });
}

export async function importPdfsFiles(files: File[]): Promise<PdfImportResult> {
  const body = new FormData();
  for (const file of files) {
    body.append("files", file, file.name);
  }
  return request("/v1/imports/pdfs", { method: "POST", body });
}

export function pdfUrl(jobId: string): string {
  return `${apiBase()}/v1/jobs/${jobId}/pdf`;
}

export async function fetchPdf(jobId: string): Promise<ArrayBuffer> {
  const headers = new Headers();
  const token = await currentToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${apiBase()}/v1/jobs/${jobId}/pdf`, { headers });
  if (res.status === 401) {
    await clearSession();
    throw new ApiError(SESSION_EXPIRED_MESSAGE, 401);
  }
  if (!res.ok) throw new ApiError((await res.text()).trim() || res.statusText, res.status);
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 5) throw new ApiError("empty pdf", res.status);
  return buf;
}

export async function getAnnotations(
  jobId: string,
  page: number,
  version?: number,
): Promise<{ revision: Revision; payload: AnnotationPayload }> {
  const q = version != null ? `?version=${version}` : "";
  return request(`/v1/jobs/${jobId}/pages/${page}/annotations${q}`);
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

export async function listComments(jobId: string, page: number): Promise<{ comments: PageComment[] }> {
  return request(`/v1/jobs/${jobId}/pages/${page}/comments`);
}

export async function createComment(
  jobId: string,
  page: number,
  body: string,
  annotationId?: string | null,
): Promise<{ comment: PageComment }> {
  return request(`/v1/jobs/${jobId}/pages/${page}/comments`, {
    method: "POST",
    body: JSON.stringify({
      body,
      annotation_id: annotationId || undefined,
    }),
  });
}

export async function deleteComment(jobId: string, page: number, commentId: string): Promise<{ ok: boolean }> {
  return request(`/v1/jobs/${jobId}/pages/${page}/comments/${commentId}`, { method: "DELETE" });
}

export function exportCocoUrl(jobId: string): string {
  return `${apiBase()}/v1/jobs/${jobId}/export/coco`;
}

export async function downloadCoco(jobId: string, slug: string): Promise<void> {
  const headers = new Headers();
  const token = await currentToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(exportCocoUrl(jobId), { headers });
  if (res.status === 401) {
    await clearSession();
    throw new ApiError(SESSION_EXPIRED_MESSAGE, 401);
  }
  if (!res.ok) throw new ApiError((await res.text()).trim() || res.statusText, res.status);
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${slug}.coco.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
