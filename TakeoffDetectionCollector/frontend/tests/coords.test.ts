import { describe, expect, it } from "vitest";
import { IMPORT_DPI, ptToPx75, px75ToPt } from "../src/lib/coords";
import { bakeGeometryIndex } from "../src/lib/snap";
import type { PageVectorsResponse } from "../src/api/types";

describe("75 DPI contract", () => {
  it("round-trips px75 through PDF points", () => {
    expect(ptToPx75(px75ToPt(3600))).toBeCloseTo(3600);
    expect(IMPORT_DPI).toBe(75);
  });
});

describe("bake fills and dots", () => {
  it("explodes fill outlines and keeps isolated points as endpoints", () => {
    const vectors: PageVectorsResponse = {
      job_id: "j",
      page_index: 0,
      pdf_available: true,
      coord_space: "pt",
      page_width_pt: 100,
      page_height_pt: 100,
      image_width_px: 100,
      image_height_px: 100,
      rotation: 0,
      empty: false,
      extract_version: "t",
      segments: { lines: [], rects: [], quads: [], curves: [] },
      fills: [[10, 10, 30, 10, 30, 20, 10, 20]],
      points: [[50, 50]],
      dim_texts: [],
      stats: {
        raw_path_count: 1,
        returned_segment_count: 0,
        truncated: false,
        dropped_short: 0,
        dropped_fill_only: 0,
        dropped_outside: 0,
        curves_as_chords: 0,
      },
    };
    const index = bakeGeometryIndex(vectors);
    expect(index).not.toBeNull();
    expect(index!.segments.length).toBe(4);
    expect(index!.endpoints.some((e) => e.p.x === 50 && e.p.y === 50)).toBe(true);
    expect(index!.empty).toBe(false);
  });
});
