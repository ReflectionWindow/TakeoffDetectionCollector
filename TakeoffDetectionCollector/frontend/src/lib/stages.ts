import type { Job, JobStatus } from "../api/types";

export const STAGES: JobStatus[] = ["original", "corrected", "complete"];

export const STAGE_LABEL: Record<JobStatus, string> = {
  original: "Original",
  corrected: "In review",
  complete: "Complete",
};

export function normalizeStatus(status: string | null | undefined): JobStatus {
  if (status === "corrected") return "corrected";
  if (status === "complete" || status === "verified" || status === "done") return "complete";
  return "original";
}

export function isClaimActive(job: Job): boolean {
  if (!job.claimed_by) return false;
  if (!job.claim_expires_at) return true;
  return Date.parse(job.claim_expires_at) > Date.now();
}

export function isLockedByOther(job: Job, userId: string): boolean {
  if (!isClaimActive(job) || !job.claimed_by) return false;
  return job.claimed_by !== userId;
}

export function openedByLabel(job: Job, userId: string): string {
  if (!isClaimActive(job)) return "—";
  if (userId && job.claimed_by === userId) return "you";
  return job.claimed_email || "someone else";
}

export function inUseReason(job: Job, userId: string): string | null {
  if (!isLockedByOther(job, userId)) return null;
  const who = job.claimed_email || "Someone else";
  return `${who} has this sheet open. Only one person can work on a sheet at a time, so you can't open it until they go back to the inbox.`;
}

/** Annotation edits. Complete is read-only; In review stays editable. */
export function canEdit(job: Job, userId: string): boolean {
  if (normalizeStatus(job.status) === "complete") return false;
  return !isLockedByOther(job, userId);
}

export function nextActions(job: Job, _userId: string): JobStatus[] {
  switch (normalizeStatus(job.status)) {
    case "original":
      return job.has_pdf ? ["corrected", "complete"] : [];
    case "corrected":
      return ["complete"];
    case "complete":
      return ["corrected", "original"];
    default:
      return [];
  }
}

export type StatusAction = { stage: JobStatus; label: string };

/** Status moves shown after Labels (and whenever a complete sheet is open). */
export function statusActions(job: Job): StatusAction[] {
  const status = normalizeStatus(job.status);
  if (status === "original" && job.has_pdf) {
    return [
      { stage: "corrected", label: "Send to review" },
      { stage: "complete", label: "Mark complete" },
    ];
  }
  if (status === "corrected") {
    return [{ stage: "complete", label: "Mark complete" }];
  }
  if (status === "complete") {
    return [
      { stage: "corrected", label: "Move to review" },
      { stage: "original", label: "Back to original" },
    ];
  }
  return [];
}
