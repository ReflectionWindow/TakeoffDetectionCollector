import { describe, expect, it } from "vitest";
import type { Revision } from "../src/api/types";
import { markupSourceVersion, shouldRasterOverlay } from "../src/lib/revisions";

function rev(version: number, note: string): Revision {
  return {
    job_id: "j",
    page_index: 0,
    version,
    storage_key: `annotations/j/p0/v${version}.json`,
    note,
    created_at: "2026-01-01T00:00:00Z",
  };
}

describe("markupSourceVersion", () => {
  it("leaves an import alone", () => {
    expect(markupSourceVersion([rev(0, "imported coco")])).toBeNull();
    expect(markupSourceVersion([rev(0, "imported bluebeam")])).toBeNull();
  });

  it("restores auto-snap back to the import", () => {
    expect(markupSourceVersion([rev(0, "imported coco"), rev(1, "auto-snap")])).toBe(0);
    expect(markupSourceVersion([rev(0, "imported bluebeam"), rev(1, "auto-snap")])).toBe(0);
  });

  it("does not undo a user edit after snap", () => {
    expect(markupSourceVersion([rev(0, "imported coco"), rev(1, "auto-snap"), rev(2, "edit")])).toBeNull();
  });

  it("falls back to version 0 when the import note is missing", () => {
    expect(markupSourceVersion([rev(0, ""), rev(1, "auto-snap")])).toBe(0);
  });
});

describe("shouldRasterOverlay", () => {
  it("uses the raster path for version 0 and restores of it", () => {
    expect(shouldRasterOverlay(0, "imported coco")).toBe(true);
    expect(shouldRasterOverlay(2, "revert to v0")).toBe(true);
    expect(shouldRasterOverlay(1, "edit")).toBe(false);
    expect(shouldRasterOverlay(1, "auto-snap")).toBe(false);
  });
});
