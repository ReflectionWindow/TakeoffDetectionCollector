import { describe, expect, it } from "vitest";
import type { Box, PageVectorsResponse } from "../src/api/types";
import {
  bakeGeometryIndex,
  EDGE_SNAP_CAPTURE_PX,
  emptyMoveLock,
  snapModelBoxes,
  snapMoveRect,
  snapRectEdges,
  snapResizeEdges,
  TINY_BOX_MIN_SIDE_PX,
  type GeometryIndex,
} from "../src/lib/snap";
import { MIN_BOX_SIZE } from "../src/lib/geometry";

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

function vectorsFixture(overrides: Partial<PageVectorsResponse> = {}): PageVectorsResponse {
  const { segments: segOverride, ...rest } = overrides;
  return {
    job_id: "job-1",
    page_index: 0,
    pdf_available: true,
    coord_space: "pt",
    page_width_pt: 100,
    page_height_pt: 200,
    image_width_px: 200,
    image_height_px: 400,
    rotation: 0,
    empty: false,
    extract_version: "test",
    dim_texts: [],
    stats: emptyStats(),
    ...rest,
    segments: {
      lines: [],
      rects: [],
      quads: [],
      curves: [],
      ...segOverride,
    },
  };
}

/** sx=sy=0.5 → PNG = 2 × PDF pt. */
function indexFromLines(lines: number[][]): GeometryIndex {
  const index = bakeGeometryIndex(
    vectorsFixture({
      segments: { lines, rects: [], quads: [], curves: [] },
    }),
  );
  expect(index).not.toBeNull();
  return index!;
}

function box(partial: Partial<Box> & { box_id: string; x1: number; y1: number; x2: number; y2: number }): Box {
  const { x1, y1, x2, y2 } = partial;
  return {
    category_id: 1,
    origin: "model",
    edited: false,
    points: [
      { x: x1, y: y1 },
      { x: x2, y: y1 },
      { x: x2, y: y2 },
      { x: x1, y: y2 },
    ],
    ...partial,
  };
}

describe("snapModelBoxes", () => {
  it("snaps two boxes to the same shared mullion", () => {
    // Vertical line at x=50 pt → PNG x=100, y=40–200.
    const index = indexFromLines([[50, 20, 50, 100]]);
    const left = box({ box_id: "a", x1: 20, y1: 50, x2: 103, y2: 180 });
    const right = box({ box_id: "b", x1: 97, y1: 50, x2: 170, y2: 180 });
    const { boxes, changed } = snapModelBoxes([left, right], index);
    expect(changed).toBe(true);
    expect(boxes[0]!.x2).toBeCloseTo(100, 5);
    expect(boxes[1]!.x1).toBeCloseTo(100, 5);
  });

  it("rejects a snap that would collapse opposite edges", () => {
    const index = indexFromLines([[25, 20, 25, 80]]);
    // Line at PNG x=50. Box is 20–28 (width 8); snapping west to 50 would invert.
    const source = box({ box_id: "a", x1: 20, y1: 50, x2: 28, y2: 180 });
    const { boxes, changed } = snapModelBoxes([source], index);
    expect(changed).toBe(false);
    expect(boxes[0]).toEqual(source);
    expect(boxes[0]!.x2 - boxes[0]!.x1).toBeGreaterThanOrEqual(MIN_BOX_SIZE);
  });

  it("prefers the inward edge of a fat stroke over the outer ink", () => {
    // Outer at PNG 100, inner at PNG 102 (~1 pt pair in this fixture scale).
    const index = indexFromLines([
      [50, 20, 50, 100],
      [51, 20, 51, 100],
    ]);
    const source = box({ box_id: "a", x1: 100, y1: 50, x2: 180, y2: 180 });
    const first = snapModelBoxes([source], index);
    expect(first.changed).toBe(true);
    expect(first.boxes[0]!.x1).toBeCloseTo(102, 5);
    const second = snapModelBoxes(first.boxes, index);
    expect(second.changed).toBe(false);
    expect(second.boxes[0]!.x1).toBeCloseTo(102, 5);
  });

  it("ignores a sheet-length grid so a nearby local frame can win", () => {
    // Grid at PNG x=100, full page. Local jamb at PNG x=106.
    const index = indexFromLines([
      [50, 0, 50, 200],
      [53, 20, 53, 100],
    ]);
    const source = box({ box_id: "a", x1: 100, y1: 50, x2: 180, y2: 180 });
    const { boxes, changed } = snapModelBoxes([source], index);
    expect(changed).toBe(true);
    expect(boxes[0]!.x1).toBeCloseTo(106, 5);
  });

  it("picks the closest line, not a farther outward grid", () => {
    // Frame at 50 pt (PNG 100, 2 px inward). Grid at 47 pt (PNG 94, 8 px out).
    const index = indexFromLines([
      [50, 20, 50, 100],
      [47, 10, 47, 180],
    ]);
    const source = box({ box_id: "a", x1: 102, y1: 50, x2: 180, y2: 180 });
    const { boxes, changed } = snapModelBoxes([source], index);
    expect(changed).toBe(true);
    expect(boxes[0]!.x1).toBeCloseTo(100, 5);
  });

  it("does not walk outward across parallel brick courses", () => {
    const index = indexFromLines([
      [50, 20, 50, 100],
      [47, 20, 47, 100],
      [44, 20, 44, 100],
    ]);
    const source = box({ box_id: "a", x1: 100, y1: 50, x2: 180, y2: 180 });
    const first = snapModelBoxes([source], index);
    expect(first.changed).toBe(false);
    const second = snapModelBoxes(first.boxes, index);
    expect(second.changed).toBe(false);
    expect(second.boxes[0]!.x1).toBeCloseTo(100, 5);
  });

  it("leaves a box unchanged when no line is in band", () => {
    const index = indexFromLines([[10, 20, 10, 80]]);
    const source = box({ box_id: "a", x1: 80, y1: 50, x2: 160, y2: 180 });
    const { boxes, changed } = snapModelBoxes([source], index);
    expect(changed).toBe(false);
    expect(boxes[0]).toEqual(source);
  });

  it("is a no-op when the box is already on the line", () => {
    const index = indexFromLines([[50, 20, 50, 100]]);
    const source = box({ box_id: "a", x1: 100, y1: 50, x2: 180, y2: 180 });
    const { boxes, changed } = snapModelBoxes([source], index);
    expect(changed).toBe(false);
    expect(boxes[0]).toEqual(source);
  });

  it("skips tiny noise boxes", () => {
    const index = indexFromLines([[50, 20, 50, 100]]);
    const side = TINY_BOX_MIN_SIDE_PX - 2;
    const source = box({ box_id: "a", x1: 102, y1: 50, x2: 102 + side, y2: 50 + side });
    const { boxes, changed } = snapModelBoxes([source], index);
    expect(changed).toBe(false);
    expect(boxes[0]).toEqual(source);
  });

  it("does not auto-correct user-drawn or already-edited boxes", () => {
    const index = indexFromLines([[50, 20, 50, 100]]);
    const user = box({
      box_id: "u",
      x1: 102,
      y1: 50,
      x2: 180,
      y2: 180,
      origin: "user",
      edited: true,
    });
    const edited = box({
      box_id: "e",
      x1: 102,
      y1: 50,
      x2: 180,
      y2: 180,
      edited: true,
    });
    const { changed } = snapModelBoxes([user, edited], index);
    expect(changed).toBe(false);
  });
});

describe("snapMoveRect", () => {
  it("preserves size when only one axis magnets", () => {
    const index = indexFromLines([[50, 20, 50, 100]]);
    const rect = { x1: 108, y1: 40, x2: 168, y2: 160 };
    const out = snapMoveRect(rect, index, 12);
    expect(out.rect.x2 - out.rect.x1).toBeCloseTo(60, 8);
    expect(out.rect.y2 - out.rect.y1).toBeCloseTo(120, 8);
    expect(out.rect.x1).toBeCloseTo(100, 5);
    expect(out.rect.y1).toBeCloseTo(40, 5);
  });

  it("holds a lock until the free edge leaves the release radius", () => {
    const index = indexFromLines([[50, 20, 50, 100]]);
    const near = snapMoveRect({ x1: 108, y1: 40, x2: 168, y2: 160 }, index, 10, {
      releaseRadiusPx: 13,
    });
    expect(near.lock.v).not.toBeNull();
    expect(near.rect.x1).toBeCloseTo(100, 5);

    const stillHeld = snapMoveRect({ x1: 111, y1: 40, x2: 171, y2: 160 }, index, 10, {
      lock: near.lock,
      releaseRadiusPx: 13,
    });
    expect(stillHeld.lock.v?.segmentId).toBe(near.lock.v?.segmentId);
    expect(stillHeld.rect.x1).toBeCloseTo(100, 5);

    const released = snapMoveRect({ x1: 120, y1: 40, x2: 180, y2: 160 }, index, 10, {
      lock: stillHeld.lock,
      releaseRadiusPx: 13,
    });
    expect(released.lock.v).toBeNull();
    expect(released.rect.x1).toBeCloseTo(120, 5);
  });

  it("stays free when Alt bypasses or the index is empty", () => {
    const index = indexFromLines([[50, 20, 50, 100]]);
    const rect = { x1: 108, y1: 40, x2: 168, y2: 160 };
    const bypassed = snapMoveRect(rect, index, 12, { bypass: true });
    expect(bypassed.rect).toEqual(rect);
    expect(bypassed.lock).toEqual(emptyMoveLock());

    const empty = bakeGeometryIndex(
      vectorsFixture({
        empty: true,
        segments: { lines: [], rects: [], quads: [], curves: [] },
      }),
    );
    expect(empty).not.toBeNull();
    const missed = snapMoveRect(rect, empty, 12);
    expect(missed.rect).toEqual(rect);
  });
});

describe("snapResizeEdges", () => {
  it("snaps only the active edge", () => {
    const index = indexFromLines([
      [50, 20, 50, 100],
      [20, 60, 80, 60],
    ]);
    const bounds = { x1: 20, y1: 40, x2: 108, y2: 160 };
    const out = snapResizeEdges(bounds, "e", index, 12);
    expect(out.rect.x2).toBeCloseTo(100, 5);
    expect(out.rect.x1).toBe(20);
    expect(out.rect.y1).toBe(40);
    expect(out.rect.y2).toBe(160);
  });
});

describe("screen-pixel drag radius", () => {
  it("at max zoom, 10 screen px is a fraction of an image pixel — not glued", () => {
    expect(EDGE_SNAP_CAPTURE_PX).toBe(10);
    // Horizontal line at 40 pt → PNG y=80.
    const index = indexFromLines([[20, 40, 80, 40]]);
    const zoom = 24;
    // 2 PNG px away = 48 screen px > 10 — free.
    const far = snapResizeEdges(
      { x1: 50, y1: 82, x2: 150, y2: 160 },
      "n",
      index,
      EDGE_SNAP_CAPTURE_PX,
      { zoom, minOverlapFraction: 0, minOverlapPx: 4 },
    );
    expect(far.rect.y1).toBe(82);

    // 0.3 PNG px away = 7.2 screen px ≤ 10 — snaps.
    const near = snapResizeEdges(
      { x1: 50, y1: 80.3, x2: 150, y2: 160 },
      "n",
      index,
      EDGE_SNAP_CAPTURE_PX,
      { zoom, minOverlapFraction: 0, minOverlapPx: 4 },
    );
    expect(near.rect.y1).toBeCloseTo(80, 5);
  });
});

describe("snapRectEdges", () => {
  it("ignores a far door jamb that shares an X but does not overlap", () => {
    // Long vertical at x=50, but only in the top of the page (PNG y=20–60).
    const index = indexFromLines([[50, 10, 50, 30]]);
    const rect = { x1: 108, y1: 200, x2: 180, y2: 320 };
    const out = snapRectEdges(rect, index, 14);
    expect(out.rect).toEqual(rect);
    expect(out.hits).toHaveLength(0);
  });
});
