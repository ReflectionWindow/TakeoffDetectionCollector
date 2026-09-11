import type { Box, PageComment } from "../api/types";

export const MAX_COMMENT_LEN = 4000;

export function commentAuthorLabel(comment: PageComment): string {
  const name = comment.author_name.trim();
  if (name) return name;
  const email = comment.author_email.trim();
  if (email) return email;
  return "Someone";
}

export function commentTimeLabel(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  if (s < 90) return "1 min ago";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 5400) return "1 hr ago";
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return new Date(t).toLocaleDateString();
}

export function linkedBox(comment: PageComment, boxes: Box[]): Box | undefined {
  if (!comment.annotation_id) return undefined;
  return boxes.find((b) => b.box_id === comment.annotation_id);
}

export function commentedBoxIds(comments: PageComment[]): string[] {
  const ids = new Set<string>();
  for (const comment of comments) {
    if (comment.annotation_id) ids.add(comment.annotation_id);
  }
  return [...ids];
}

export function normalizeCommentBody(raw: string): string {
  return raw.trim();
}
