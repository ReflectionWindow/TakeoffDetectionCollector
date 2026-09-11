import { describe, expect, it } from "vitest";
import type { Job } from "../src/api/types";
import {
  canEdit,
  isLockedByOther,
  nextActions,
  normalizeStatus,
  openedByLabel,
  inUseReason,
  statusActions,
  STAGES,
} from "../src/lib/stages";

function job(partial: Partial<Job>): Job {
  return {
    id: "1",
    slug: "demo",
    title: "demo",
    status: "original",
    conflict_count: 0,
    page_count: 1,
    box_count: 1,
    has_pdf: true,
    tags: [],
    created_at: "",
    updated_at: "",
    ...partial,
  };
}

describe("stages", () => {
  it("keeps three statuses", () => {
    expect(STAGES).toEqual(["original", "corrected", "complete"]);
    expect(normalizeStatus("verified")).toBe("complete");
  });

  it("locks a job opened by someone else", () => {
    const j = job({
      claimed_by: "u2",
      claimed_email: "b@x.com",
      claim_expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(isLockedByOther(j, "u1")).toBe(true);
    expect(canEdit(j, "u1")).toBe(false);
    expect(canEdit(j, "u2")).toBe(true);
    expect(openedByLabel(j, "u1")).toBe("b@x.com");
    expect(openedByLabel(j, "u2")).toBe("you");
    expect(openedByLabel({ ...j, claim_expires_at: new Date(Date.now() - 1000).toISOString() }, "u2")).toBe("you");
    expect(openedByLabel(job({ verified_email: "fin@x.com", verified_by: "u3" }), "u1")).toBe("fin@x.com");
    expect(openedByLabel(job({ verified_email: "fin@x.com", verified_by: "u3" }), "u3")).toBe("you");
    expect(openedByLabel(job({}), "u1")).toBe("—");
    expect(inUseReason(j, "u1")).toMatch(/b@x.com has this sheet open/);
    expect(inUseReason(j, "u2")).toBeNull();
  });

  it("keeps in-review editable, including for the person who sent it", () => {
    const j = job({ status: "corrected", corrected_by: "u1", has_pdf: true });
    expect(canEdit(j, "u1")).toBe(true);
    expect(nextActions(j, "u1")).toEqual(["complete"]);
    expect(statusActions(j)).toEqual([{ stage: "complete", label: "Mark complete" }]);
  });

  it("makes complete read-only and allows moving it back", () => {
    const j = job({ status: "complete" });
    expect(canEdit(j, "u1")).toBe(false);
    expect(nextActions(j, "u1")).toEqual(["corrected", "original"]);
    expect(statusActions(j)).toEqual([
      { stage: "corrected", label: "Move to review" },
      { stage: "original", label: "Back to original" },
    ]);
  });

  it("lets original go to review or complete after labels", () => {
    expect(statusActions(job({ status: "original", has_pdf: true }))).toEqual([
      { stage: "corrected", label: "Send to review" },
      { stage: "complete", label: "Mark complete" },
    ]);
  });
});
