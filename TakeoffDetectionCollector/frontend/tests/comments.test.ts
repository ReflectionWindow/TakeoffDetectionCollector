import { describe, expect, it } from "vitest";
import type { Box, PageComment } from "../src/api/types";
import {
  commentAuthorLabel,
  commentTimeLabel,
  commentedBoxIds,
  linkedBox,
  normalizeCommentBody,
} from "../src/lib/comments";

function comment(partial: Partial<PageComment>): PageComment {
  return {
    id: "c1",
    job_id: "j1",
    page_index: 0,
    author_id: "u1",
    author_email: "alice@reflectionwindow.com",
    author_name: "",
    body: "note",
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    ...partial,
  };
}

describe("page comments", () => {
  it("prefers a name, then email", () => {
    expect(commentAuthorLabel(comment({ author_name: "Alice" }))).toBe("Alice");
    expect(commentAuthorLabel(comment({ author_name: "  " }))).toBe("alice@reflectionwindow.com");
  });

  it("labels recent times in plain language", () => {
    const now = Date.parse("2026-09-11T18:00:00Z");
    expect(commentTimeLabel(new Date(now - 10_000).toISOString(), now)).toBe("just now");
    expect(commentTimeLabel(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5 min ago");
  });

  it("links a comment to the live box when it still exists", () => {
    const boxes: Box[] = [
      { box_id: "box-9", points: [], x1: 0, y1: 0, x2: 10, y2: 10, category_id: 1, class_name: "LOUVER" },
    ];
    expect(linkedBox(comment({ annotation_id: "box-9" }), boxes)?.class_name).toBe("LOUVER");
    expect(linkedBox(comment({ annotation_id: "gone" }), boxes)).toBeUndefined();
    expect(commentedBoxIds([comment({ annotation_id: "box-9" }), comment({})])).toEqual(["box-9"]);
  });

  it("trims empty drafts", () => {
    expect(normalizeCommentBody("  hello  ")).toBe("hello");
    expect(normalizeCommentBody(" \n ")).toBe("");
  });
});
