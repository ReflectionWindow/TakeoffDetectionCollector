import { describe, expect, it } from "vitest";
import type { PageVectorsResponse } from "../src/api/types";
import { bakeGeometryIndex } from "../src/lib/snap";
import { applyCorner, enabledAdjustModes, queryAdjustSnap, queryPointSnap, snapRectByPoint } from "../src/lib/snap/pointSnap";

function emptyStats() {
  return {
    raw_path_count: 0,
    returned_segment_count: 0,
    truncated: false,
    dropped_short: 0,
    dropped_fill_only: 0,
    dropped_hatch: 0,
    dropped_outside: 0,
    curves_as_chords: 0,
  };
}

function indexWithLines(lines: number[][]) {
  const vec: PageVectorsResponse = {
    job_id: "job-1",
    page_index: 0,
    pdf_available: true,
    coord_space: "pt",
    page_width_pt: 100,
    page_height_pt: 100,
    image_width_px: 100,
    image_height_px: 100,
    rotation: 0,
    empty: false,
    extract_version: "test",
    dim_texts: [],
    stats: emptyStats(),
    segments: { lines, rects: [], quads: [], curves: [] },
  };
  return bakeGeometryIndex(vec, { imageWidthPx: 100, imageHeightPx: 100, pageIndex: 0 });
}

describe("point snap", () => {
  it("enables perpendicular / ortho / parallel for a second click", () => {
    expect(enabledAdjustModes({ line: true, point: true })).toEqual([
      "endpoint",
      "intersection",
      "midpoint",
      "nearest",
      "perpendicular",
      "ortho",
      "parallel",
    ]);
  });

  it("snaps a cursor to a nearby endpoint", () => {
    const index = indexWithLines([[10, 10, 40, 10]]);
    const hit = queryPointSnap(index, { x: 11, y: 12 }, 1, false);
    expect(hit?.mode).toBe("endpoint");
    expect(hit?.point.x).toBeCloseTo(10);
    expect(hit?.point.y).toBeCloseTo(10);
  });

  it("translates a rect so a corner hits an endpoint", () => {
    const index = indexWithLines([[20, 20, 80, 20]]);
    const { rect, hit } = snapRectByPoint({ x1: 22, y1: 23, x2: 35, y2: 40 }, index, 1, false);
    expect(hit).not.toBeNull();
    expect(rect.x1).toBeCloseTo(20);
    expect(rect.y1).toBeCloseTo(20);
    expect(rect.x2 - rect.x1).toBeCloseTo(13);
  });

  it("snaps onto a segment along its length when edge snap is on", () => {
    const index = indexWithLines([[0, 20, 80, 20]]);
    const miss = queryPointSnap(index, { x: 15, y: 24 }, 1, false);
    expect(miss).toBeNull();
    const hit = queryAdjustSnap(index, { x: 15, y: 24 }, 1, false, { line: true, point: false });
    expect(hit?.mode).toBe("nearest");
    expect(hit?.point.x).toBeCloseTo(15);
    expect(hit?.point.y).toBeCloseTo(20);
  });

  it("does not snap onto a bulky poche fill outline", () => {
    const vec: PageVectorsResponse = {
      job_id: "job-1",
      page_index: 0,
      pdf_available: true,
      coord_space: "pt",
      page_width_pt: 100,
      page_height_pt: 100,
      image_width_px: 100,
      image_height_px: 100,
      rotation: 0,
      empty: false,
      extract_version: "test",
      dim_texts: [],
      stats: emptyStats(),
      segments: { lines: [], rects: [], quads: [], curves: [] },
      fills: [[10, 10, 80, 10, 80, 50, 10, 50]],
    };
    const index = bakeGeometryIndex(vec, { imageWidthPx: 100, imageHeightPx: 100, pageIndex: 0 });
    const hit = queryAdjustSnap(index, { x: 40, y: 12 }, 1, false, { line: true, point: true });
    expect(hit).toBeNull();
  });

  it("snaps a cursor onto an isolated PDF tick / cross", () => {
    const vec: PageVectorsResponse = {
      job_id: "job-1",
      page_index: 0,
      pdf_available: true,
      coord_space: "pt",
      page_width_pt: 100,
      page_height_pt: 100,
      image_width_px: 100,
      image_height_px: 100,
      rotation: 0,
      empty: false,
      extract_version: "test",
      dim_texts: [],
      stats: emptyStats(),
      segments: { lines: [], rects: [], quads: [], curves: [] },
      points: [[50, 50]],
    };
    const index = bakeGeometryIndex(vec, { imageWidthPx: 100, imageHeightPx: 100, pageIndex: 0 });
    const hit = queryPointSnap(index, { x: 54, y: 51 }, 1, false);
    expect(hit?.point.x).toBeCloseTo(50);
    expect(hit?.point.y).toBeCloseTo(50);
  });

  it("applies a corner handle without moving the opposite edges", () => {
    const next = applyCorner({ x1: 0, y1: 0, x2: 40, y2: 30 }, "se", { x: 50, y: 40 });
    expect(next).toEqual({ x1: 0, y1: 0, x2: 50, y2: 40 });
  });
});
