import { describe, expect, it } from "vitest";
import type { PageVectorsResponse } from "../src/api/types";
import { bakeGeometryIndex } from "../src/lib/snap";
import {
  activeSnapMark,
  clipSegmentToDisk,
  overlayViewRect,
  shouldShowVectorOverlay,
  VECTOR_OVERLAY_HOVER_PX,
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
    expect(shouldShowVectorOverlay(1)).toBe(false);
  });
});

describe("vector overlay culling", () => {
  it("keeps fills and junction dots that sit in the view", () => {
    const index = bakeGeometryIndex(vectors())!;
    const view = { minX: 0, minY: 0, maxX: 60, maxY: 60 };
    expect(visibleFills(index.fills, view, 4).length).toBeGreaterThanOrEqual(1);
    expect(visibleDots(index.dots, view).some((p) => Math.abs(p.x - 40) < 0.6 && Math.abs(p.y - 5) < 0.6)).toBe(true);
    expect(visibleDots(index.dots, view).some((p) => p.x === 50 && p.y === 50)).toBe(false);
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

  it("builds red overlay paths once zoomed in and the cursor is nearby", () => {
    const index = bakeGeometryIndex(vectors())!;
    const view = overlayViewRect(0, 0, 2, 400, 400);
    expect(vectorOverlayPaths(index, view, 1, { x: 40, y: 5 })).toBeNull();
    expect(vectorOverlayPaths(index, view, 2)).toBeNull();
    expect(vectorOverlayPaths(index, view, 2, { x: 0, y: 90 })).toBeNull();
    const paths = vectorOverlayPaths(index, view, 2, { x: 40, y: 5 });
    expect(paths).not.toBeNull();
    expect(paths!.fills).toBe("");
    expect(paths!.lines).toMatch(/M /);
    expect(paths!.crosses).toBe("");
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

  it("does not turn a bulky poche fill into overlay snap edges", () => {
    const index = bakeGeometryIndex(
      vectors({
        points: [],
        segments: { lines: [], rects: [], quads: [], curves: [] },
        fills: [[10, 10, 80, 10, 80, 50, 10, 50]],
      }),
    )!;
    expect(index.segments).toHaveLength(0);
    const view = overlayViewRect(0, 0, 2, 400, 400);
    expect(vectorOverlayPaths(index, view, 2, { x: 40, y: 30 })).toBeNull();
  });

  it("draws linework even when the page has no ticks", () => {
    const index = bakeGeometryIndex(
      vectorsFixtureOnlyLines([[0, 10, 80, 10]]),
    )!;
    const view = overlayViewRect(0, 0, 2, 400, 400);
    const paths = vectorOverlayPaths(index, view, 2, { x: 40, y: 10 });
    expect(paths).not.toBeNull();
    expect(paths!.lines).toMatch(/L /);
    expect(paths!.lines).not.toMatch(/L 80 10/);
    expect(paths!.crosses).toBe("");
    expect(paths!.dots).toBe("");
  });

  it("hides distant linework and clips a long edge to the cursor halo", () => {
    const index = bakeGeometryIndex(vectorsFixtureOnlyLines([[0, 10, 200, 10]]))!;
    const view = overlayViewRect(0, 0, 2, 400, 400);
    expect(vectorOverlayPaths(index, view, 2, { x: 10, y: 80 })).toBeNull();
    const paths = vectorOverlayPaths(index, view, 2, { x: 10, y: 10 });
    expect(paths).not.toBeNull();
    expect(paths!.lines).not.toMatch(/L 200 /);
    const radius = VECTOR_OVERLAY_HOVER_PX / 2;
    const clipped = clipSegmentToDisk({ x: 0, y: 10 }, { x: 200, y: 10 }, { x: 10, y: 10 }, radius);
    expect(clipped).not.toBeNull();
    expect(clipped!.a.x).toBeCloseTo(0);
    expect(clipped!.b.x).toBeCloseTo(10 + radius);
  });

  it("dots corners and crossings, not dead-end endpoints", () => {
    const index = bakeGeometryIndex(
      vectorsFixtureOnlyLines([
        [0, 10, 40, 10],
        [40, 10, 40, 40],
        [10, 0, 10, 40],
        [0, 20, 40, 20],
      ]),
    )!;
    const t = index.dots.some((p) => Math.abs(p.x - 40) < 0.6 && Math.abs(p.y - 10) < 0.6);
    const cross = index.dots.some((p) => Math.abs(p.x - 10) < 0.6 && Math.abs(p.y - 20) < 0.6);
    const dead = index.dots.some((p) => Math.abs(p.x - 0) < 0.6 && Math.abs(p.y - 10) < 0.6);
    expect(t).toBe(true);
    expect(cross).toBe(true);
    expect(dead).toBe(false);
  });
});

describe("clipSegmentToDisk", () => {
  it("keeps the overlap of a segment and a disk", () => {
    const hit = clipSegmentToDisk({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, 2);
    expect(hit).not.toBeNull();
    expect(hit!.a.x).toBeCloseTo(3);
    expect(hit!.b.x).toBeCloseTo(7);
    expect(clipSegmentToDisk({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }, 2)).toBeNull();
  });
});
