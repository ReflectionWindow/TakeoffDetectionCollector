import { describe, expect, it } from "vitest";
import type { PageVectorsResponse } from "../src/api/types";
import { bakeGeometryIndex } from "../src/lib/snap";
import {
  activeSnapMark,
  overlayViewRect,
  shouldShowVectorOverlay,
  VECTOR_OVERLAY_MIN_ZOOM,
  vectorOverlayPaths,
  visibleDots,
  visibleFills,
} from "../src/lib/snap/overlay";

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

function vectors(overrides: Partial<PageVectorsResponse> = {}): PageVectorsResponse {
  const { segments: segOverride, ...rest } = overrides;
  return {
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
    fills: [[10, 10, 30, 10, 30, 20, 10, 20]],
    points: [
      [50, 50],
      [90, 90],
    ],
    dim_texts: [],
    stats: emptyStats(),
    ...rest,
    segments: {
      lines: [],
      rects: [[40, 5, 70, 25]],
      quads: [],
      curves: [],
      ...segOverride,
    },
  };
}

function vectorsFixtureOnlyLines(lines: number[][]): PageVectorsResponse {
  return vectors({
    fills: [],
    points: [],
    segments: { lines, rects: [], quads: [], curves: [] },
  });
}

describe("shouldShowVectorOverlay", () => {
  it("stays off until the sheet is zoomed in to the overlay cutoff", () => {
    expect(shouldShowVectorOverlay(VECTOR_OVERLAY_MIN_ZOOM - 0.01)).toBe(false);
    expect(shouldShowVectorOverlay(VECTOR_OVERLAY_MIN_ZOOM)).toBe(true);
    expect(shouldShowVectorOverlay(1)).toBe(true);
  });
});

describe("vector overlay culling", () => {
  it("keeps fills and dots that sit in the view", () => {
    const index = bakeGeometryIndex(vectors())!;
    const view = { minX: 0, minY: 0, maxX: 60, maxY: 60 };
    expect(visibleFills(index.fills, view, 4).length).toBeGreaterThanOrEqual(1);
    expect(visibleDots(index.dots, view).some((p) => p.x === 50 && p.y === 50)).toBe(true);
  });

  it("keeps CAD rects as color fills", () => {
    const index = bakeGeometryIndex(vectors())!;
    expect(index.fills.some((f) => f.minX === 40 && f.minY === 5)).toBe(true);
  });

  it("drops fills that are still specks at this zoom", () => {
    const index = bakeGeometryIndex(vectors())!;
    const view = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    expect(visibleFills(index.fills, view, 0.02)).toHaveLength(0);
  });

  it("builds red overlay paths once zoomed in", () => {
    const index = bakeGeometryIndex(vectors())!;
    const view = overlayViewRect(0, 0, 1, 400, 400);
    expect(vectorOverlayPaths(index, view, 0.2)).toBeNull();
    const paths = vectorOverlayPaths(index, view, 1);
    expect(paths).not.toBeNull();
    expect(paths!.fills).toBe("");
    expect(paths!.lines).toMatch(/M 40 /);
    expect(paths!.lines).toMatch(/M 10 /);
    expect(paths!.crosses).toMatch(/M 50 /);
    expect(paths!.crosses).toMatch(/M 90 /);
    expect(paths!.dots.length).toBeGreaterThan(0);
  });

  it("marks the magnet segment from a snap hit", () => {
    const index = bakeGeometryIndex(
      vectorsFixtureOnlyLines([[0, 10, 80, 10]]),
    )!;
    const hit = {
      mode: "nearest" as const,
      point: { x: 40, y: 10 },
      distPx: 1,
      screenDistPx: 1,
      segmentId: index.segments[0]!.id,
      guide: { kind: "segment" as const, a: index.segments[0]!.a, b: index.segments[0]!.b },
    };
    const mark = activeSnapMark(hit, index);
    expect(mark?.a).toEqual(index.segments[0]!.a);
    expect(mark?.b).toEqual(index.segments[0]!.b);
    expect(mark?.point).toEqual(hit.point);
  });

  it("draws a fat poche outline as a red snap edge", () => {
    const index = bakeGeometryIndex(
      vectors({
        points: [],
        segments: { lines: [], rects: [], quads: [], curves: [] },
        fills: [[10, 10, 80, 10, 80, 50, 10, 50]],
      }),
    )!;
    expect(index.segments.length).toBe(4);
    const view = overlayViewRect(0, 0, 1, 400, 400);
    const paths = vectorOverlayPaths(index, view, 1);
    expect(paths).not.toBeNull();
    expect(paths!.lines).toMatch(/M 10 10 L 80 10/);
    const hit = {
      mode: "nearest" as const,
      point: { x: 40, y: 10 },
      distPx: 1,
      screenDistPx: 1,
      segmentId: index.segments[0]!.id,
      guide: { kind: "segment" as const, a: index.segments[0]!.a, b: index.segments[0]!.b },
    };
    const mark = activeSnapMark(hit, index);
    expect(mark?.a).toEqual(index.segments[0]!.a);
    expect(mark?.b).toEqual(index.segments[0]!.b);
  });

  it("draws linework even when the page has no ticks", () => {
    const index = bakeGeometryIndex(
      vectorsFixtureOnlyLines([[0, 10, 80, 10]]),
    )!;
    const view = overlayViewRect(0, 0, 1, 400, 400);
    const paths = vectorOverlayPaths(index, view, 1);
    expect(paths).not.toBeNull();
    expect(paths!.lines).toMatch(/M 0 10 L 80 10/);
    expect(paths!.crosses).toBe("");
  });
});
