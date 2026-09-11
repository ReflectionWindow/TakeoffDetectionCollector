import { describe, expect, it } from "vitest";
import type { PageVectorsResponse } from "../src/api/types";
import {
  bakeGeometryIndex,
  querySnap,
  snapAndLock,
  suggestDimLength,
  bakeScaleFromSizes,
  pdfToPng,
  pngToPdf,
  radiusPngFromScreen,
  SNAP_PRIORITY,
  type GeometryIndex,
  type SnapContext,
  type SnapMode,
} from "../src/lib/snap";
import {
  dist,
  nearestOnSegment,
  segmentIntersection,
  unitDir,
} from "../src/lib/snap/math";

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

/** Unit square at (0,0)–(50,50) pt → PNG (0,0)–(100,100) with sx=sy=0.5. */
function unitSquareIndex(): GeometryIndex {
  const index = bakeGeometryIndex(
    vectorsFixture({
      segments: {
        lines: [],
        rects: [[0, 0, 50, 50]],
        quads: [],
        curves: [],
      },
    }),
  );
  expect(index).not.toBeNull();
  return index!;
}

function crossIndex(): GeometryIndex {
  // Horizontal + vertical crossing at (25,25) pt → PNG (50,50).
  const index = bakeGeometryIndex(
    vectorsFixture({
      segments: {
        lines: [
          [0, 25, 50, 25],
          [25, 0, 25, 50],
        ],
        rects: [],
        quads: [],
        curves: [],
      },
    }),
  );
  expect(index).not.toBeNull();
  return index!;
}

function ctx(
  index: GeometryIndex,
  partial: Partial<SnapContext> & { cursor: { x: number; y: number } },
): SnapContext {
  return {
    index,
    radiusScreenPx: 12,
    zoom: 1,
    phase: "idle",
    lock: { kind: "none" },
    ...partial,
  };
}

describe("bakeScaleFromSizes / transform", () => {
  it("keeps anisotropic sx/sy (never averages)", () => {
    const scale = bakeScaleFromSizes({
      pageWidthPt: 100,
      pageHeightPt: 200,
      imageWidthPx: 200,
      imageHeightPx: 400,
    });
    expect(scale).toEqual({ sx: 0.5, sy: 0.5 });

    const aniso = bakeScaleFromSizes({
      pageWidthPt: 100,
      pageHeightPt: 200,
      imageWidthPx: 250,
      imageHeightPx: 400,
    });
    expect(aniso!.sx).toBeCloseTo(0.4, 10);
    expect(aniso!.sy).toBeCloseTo(0.5, 10);
    expect(aniso!.sx).not.toBeCloseTo(aniso!.sy, 5);
  });

  it("round-trips pdf ↔ png with anisotropic scale", () => {
    const scale = { sx: 0.4, sy: 0.5 };
    const png = pdfToPng({ x: 40, y: 100 }, scale);
    expect(png.x).toBeCloseTo(100, 10);
    expect(png.y).toBeCloseTo(200, 10);
    const back = pngToPdf(png, scale);
    expect(back.x).toBeCloseTo(40, 10);
    expect(back.y).toBeCloseTo(100, 10);
  });

  it("converts screen radius by zoom", () => {
    expect(radiusPngFromScreen(10, 2)).toBeCloseTo(5, 10);
    expect(radiusPngFromScreen(10, 0.5)).toBeCloseTo(20, 10);
  });
});

describe("math helpers", () => {
  it("finds finite segment intersections", () => {
    const p = segmentIntersection(
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: -5 },
      { x: 5, y: 5 },
    );
    expect(p).toEqual({ x: 5, y: 0 });
  });

  it("rejects non-overlapping or parallel segments", () => {
    expect(
      segmentIntersection({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }),
    ).toBeNull();
    expect(
      segmentIntersection({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 3, y: -1 }, { x: 3, y: 1 }),
    ).toBeNull();
  });

  it("projects nearest point onto a segment", () => {
    const { point, t } = nearestOnSegment({ x: 5, y: 10 }, { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(point).toEqual({ x: 5, y: 0 });
    expect(t).toBeCloseTo(0.5, 10);
  });
});

describe("bakeGeometryIndex", () => {
  it("explodes rects into 4 edges and merges corner endpoints", () => {
    const index = unitSquareIndex();
    expect(index.segments).toHaveLength(4);
    expect(index.endpoints).toHaveLength(4);
    expect(index.sx).toBeCloseTo(0.5, 10);
    expect(index.sy).toBeCloseTo(0.5, 10);
    // Bottom-left corner of rect in PNG.
    const corner = index.endpoints.find((e) => e.p.x === 0 && e.p.y === 0);
    expect(corner).toBeDefined();
    expect(corner!.segmentIds.length).toBe(2);
  });

  it("refuses rotated / password / missing sizes", () => {
    expect(
      bakeGeometryIndex(vectorsFixture({ unsupported_reason: "rotated_page" })),
    ).toBeNull();
    expect(
      bakeGeometryIndex(vectorsFixture({ unsupported_reason: "password_protected" })),
    ).toBeNull();
    expect(bakeGeometryIndex(vectorsFixture({ pdf_available: false }))).toBeNull();
    expect(
      bakeGeometryIndex(
        vectorsFixture({ page_width_pt: null, image_width_px: null }),
      ),
    ).toBeNull();
  });

  it("bakes dim texts into PNG with centers", () => {
    const index = bakeGeometryIndex(
      vectorsFixture({
        segments: {
          lines: [[0, 0, 50, 0]],
          rects: [],
          quads: [],
          curves: [],
        },
        dim_texts: [
          {
            text: "10'-0\"",
            x0: 10,
            y0: 5,
            x1: 40,
            y1: 5,
            parsed_feet: 10,
            confidence: 0.9,
          },
        ],
      }),
    );
    expect(index!.dimTexts).toHaveLength(1);
    expect(index!.dimTexts[0]!.center.x).toBeCloseTo(50, 5);
    expect(index!.dimTexts[0]!.parsedFeet).toBe(10);
  });
});

describe("querySnap priority", () => {
  it("uses SNAP_PRIORITY endpoint → intersection → midpoint → perpendicular → nearest → ortho → parallel", () => {
    expect(SNAP_PRIORITY[0]).toBe("endpoint");
    expect(SNAP_PRIORITY[1]).toBe("intersection");
    expect(SNAP_PRIORITY[2]).toBe("midpoint");
    expect(SNAP_PRIORITY[3]).toBe("perpendicular");
    expect(SNAP_PRIORITY[4]).toBe("nearest");
    expect(SNAP_PRIORITY[5]).toBe("ortho");
    expect(SNAP_PRIORITY.at(-1)).toBe("parallel");
  });

  it("snaps to endpoint over nearby midpoint", () => {
    const index = unitSquareIndex();
    // Near bottom-left corner; midpoint of bottom edge is at (50,0).
    const hit = querySnap(
      ctx(index, { cursor: { x: 2, y: 2 }, radiusScreenPx: 20 }),
    );
    expect(hit?.mode).toBe("endpoint");
    expect(hit!.point.x).toBeCloseTo(0, 5);
    expect(hit!.point.y).toBeCloseTo(0, 5);
  });

  it("snaps to intersection when no endpoint is closer", () => {
    const index = crossIndex();
    const hit = querySnap(
      ctx(index, { cursor: { x: 51, y: 49 }, radiusScreenPx: 8 }),
    );
    expect(hit?.mode).toBe("intersection");
    expect(hit!.point.x).toBeCloseTo(50, 5);
    expect(hit!.point.y).toBeCloseTo(50, 5);
  });

  it("snaps to midpoint when endpoints are far", () => {
    const index = bakeGeometryIndex(
      vectorsFixture({
        segments: {
          lines: [[0, 25, 50, 25]],
          rects: [],
          quads: [],
          curves: [],
        },
      }),
    )!;
    // Mid of horizontal line at PNG (50,50). Endpoints at (0,50) and (100,50).
    const hit = querySnap(
      ctx(index, { cursor: { x: 50, y: 52 }, radiusScreenPx: 8 }),
    );
    expect(hit?.mode).toBe("midpoint");
    expect(hit!.point).toEqual({ x: 50, y: 50 });
  });

  it("falls back to nearest on segment", () => {
    const index = bakeGeometryIndex(
      vectorsFixture({
        segments: {
          lines: [[0, 25, 50, 25]],
          rects: [],
          quads: [],
          curves: [],
        },
      }),
    )!;
    // Cursor near line but away from mid/ends — force only nearest.
    const hit = querySnap(
      ctx(index, {
        cursor: { x: 30, y: 55 },
        radiusScreenPx: 10,
        enabledModes: ["nearest"] as SnapMode[],
      }),
    );
    expect(hit?.mode).toBe("nearest");
    expect(hit!.point.y).toBeCloseTo(50, 5);
    expect(hit!.point.x).toBeCloseTo(30, 5);
  });

  it("returns null when bypassed or empty", () => {
    const index = unitSquareIndex();
    expect(querySnap(ctx(index, { cursor: { x: 0, y: 0 }, bypass: true }))).toBeNull();
    const empty = bakeGeometryIndex(
      vectorsFixture({
        segments: { lines: [], rects: [], quads: [], curves: [] },
      }),
    )!;
    expect(empty.empty).toBe(true);
    expect(querySnap(ctx(empty, { cursor: { x: 10, y: 10 } }))).toBeNull();
  });

  it("respects screen radius / zoom (tighter at high zoom)", () => {
    const index = unitSquareIndex();
    // Cursor 8 PNG px from corner. At zoom=1, radiusScreen=6 → miss.
    expect(
      querySnap(
        ctx(index, {
          cursor: { x: 8, y: 0 },
          zoom: 1,
          radiusScreenPx: 6,
          enabledModes: ["endpoint"],
        }),
      ),
    ).toBeNull();
    // Same cursor; zoom 0.5 → radiusPng = 12 → hit.
    const hit = querySnap(
      ctx(index, {
        cursor: { x: 8, y: 0 },
        zoom: 0.5,
        radiusScreenPx: 6,
        enabledModes: ["endpoint"],
      }),
    );
    expect(hit?.mode).toBe("endpoint");
  });

  it("uses on-screen distance, not a PNG-pixel floor", () => {
    const index = unitSquareIndex();
    // 1.5 PNG from (0,0). At zoom 8 that is 12 screen px > 10 screen radius → miss.
    // A 2 PNG floor would have captured this.
    expect(
      querySnap(
        ctx(index, {
          cursor: { x: 1.5, y: 0 },
          zoom: 8,
          radiusScreenPx: 10,
          enabledModes: ["endpoint"],
        }),
      ),
    ).toBeNull();
    expect(
      querySnap(
        ctx(index, {
          cursor: { x: 1, y: 0 },
          zoom: 8,
          radiusScreenPx: 10,
          enabledModes: ["endpoint"],
        }),
      )?.mode,
    ).toBe("endpoint");
  });
});

describe("p2 modes (perp / ortho / parallel) + lock", () => {
  it("locks to the segment from p1 hit", () => {
    const index = unitSquareIndex();
    const { hit, lock } = snapAndLock(
      ctx(index, { cursor: { x: 1, y: 1 }, radiusScreenPx: 10 }),
    );
    expect(hit?.mode).toBe("endpoint");
    expect(lock.kind).toBe("segment");
  });

  it("perpendicular drops foot of p1 onto locked segment near cursor", () => {
    const index = bakeGeometryIndex(
      vectorsFixture({
        segments: {
          lines: [[0, 25, 50, 25]],
          rects: [],
          quads: [],
          curves: [],
        },
      }),
    )!;
    const seg = index.segments[0]!;
    const p1 = { x: 50, y: 80 };
    const hit = querySnap(
      ctx(index, {
        cursor: { x: 50, y: 55 },
        phase: "p2",
        p1,
        lock: { kind: "segment", segmentId: seg.id },
        enabledModes: ["perpendicular"],
        radiusScreenPx: 20,
      }),
    );
    expect(hit?.mode).toBe("perpendicular");
    expect(hit!.point.x).toBeCloseTo(50, 5);
    expect(hit!.point.y).toBeCloseTo(50, 5);
  });

  it("ortho snaps to horizontal/vertical through p1", () => {
    const index = unitSquareIndex();
    const p1 = { x: 40, y: 40 };
    const hit = querySnap(
      ctx(index, {
        cursor: { x: 70, y: 42 },
        phase: "p2",
        p1,
        lock: { kind: "none" },
        enabledModes: ["ortho"],
        radiusScreenPx: 10,
      }),
    );
    expect(hit?.mode).toBe("ortho");
    expect(hit!.point.y).toBeCloseTo(40, 5);
  });

  it("prefers linework over ortho when measuring between horizontal lines", () => {
    const index = bakeGeometryIndex(
      vectorsFixture({
        segments: {
          lines: [
            [0, 20, 100, 20],
            [0, 80, 100, 80],
          ],
          rects: [],
          quads: [],
          curves: [],
        },
      }),
    )!;
    const top = index.segments.find((s) => Math.abs(s.a.y - 40) < 1) ?? index.segments[0]!;
    const bottom = index.segments.find((s) => Math.abs(s.a.y - 160) < 1) ?? index.segments[1]!;
    const p1 = { x: top.a.x + 30, y: top.a.y };
    const hit = querySnap(
      ctx(index, {
        cursor: { x: p1.x + 2, y: bottom.a.y },
        phase: "p2",
        p1,
        lock: { kind: "none" },
        radiusScreenPx: 12,
        zoom: 1,
      }),
    );
    expect(hit?.mode).not.toBe("ortho");
    expect(["nearest", "perpendicular"]).toContain(hit?.mode);
    expect(hit!.point.y).toBeCloseTo(bottom.a.y, 5);
  });

  it("drops ortho while approaching the second horizontal on a vertical drag", () => {
    const index = bakeGeometryIndex(
      vectorsFixture({
        segments: {
          lines: [
            [0, 20, 100, 20],
            [0, 80, 100, 80],
          ],
          rects: [],
          quads: [],
          curves: [],
        },
      }),
    )!;
    const top = index.segments.find((s) => Math.abs(s.a.y - 40) < 1) ?? index.segments[0]!;
    const bottom = index.segments.find((s) => Math.abs(s.a.y - 160) < 1) ?? index.segments[1]!;
    const p1 = { x: top.mid.x, y: top.a.y };
    // Still a few px above the bottom line, but |dx|~0 so ortho would otherwise win.
    const hit = querySnap(
      ctx(index, {
        cursor: { x: p1.x + 0.5, y: bottom.a.y - 3 },
        phase: "p2",
        p1,
        lock: { kind: "none" },
        radiusScreenPx: 10,
        zoom: 1,
      }),
    );
    expect(hit?.mode).not.toBe("ortho");
    expect(hit!.point.y).toBeCloseTo(bottom.a.y, 5);
  });

  it("keeps ortho between lines when far from linework", () => {
    const index = bakeGeometryIndex(
      vectorsFixture({
        segments: {
          lines: [
            [0, 20, 100, 20],
            [0, 80, 100, 80],
          ],
          rects: [],
          quads: [],
          curves: [],
        },
      }),
    )!;
    const top = index.segments.find((s) => Math.abs(s.a.y - 40) < 1) ?? index.segments[0]!;
    const bottom = index.segments.find((s) => Math.abs(s.a.y - 160) < 1) ?? index.segments[1]!;
    const p1 = { x: top.mid.x, y: top.a.y };
    const midY = (top.a.y + bottom.a.y) / 2;
    const hit = querySnap(
      ctx(index, {
        cursor: { x: p1.x + 1, y: midY },
        phase: "p2",
        p1,
        lock: { kind: "none" },
        radiusScreenPx: 10,
        zoom: 1,
      }),
    );
    expect(hit?.mode).toBe("ortho");
    expect(hit!.point.x).toBeCloseTo(p1.x, 5);
  });

  it("parallel projects along reference direction through p1", () => {
    const index = bakeGeometryIndex(
      vectorsFixture({
        segments: {
          lines: [
            [0, 10, 50, 10], // ref horizontal at y=20 PNG
            [0, 40, 50, 40],
          ],
          rects: [],
          quads: [],
          curves: [],
        },
      }),
    )!;
    const ref = index.segments[0]!;
    // p1 already on the locked segment; parallel extends along it.
    const p1 = { x: 20, y: ref.a.y };
    const hit = querySnap(
      ctx(index, {
        cursor: { x: 80, y: ref.a.y + 4 },
        phase: "p2",
        p1,
        lock: { kind: "segment", segmentId: ref.id },
        enabledModes: ["parallel"],
        radiusScreenPx: 12,
      }),
    );
    expect(hit?.mode).toBe("parallel");
    expect(hit!.point.y).toBeCloseTo(ref.a.y, 5);
    expect(hit!.point.x).toBeGreaterThan(p1.x);
    const dir = unitDir(ref.a, ref.b)!;
    expect(Math.abs(dir.y)).toBeLessThan(1e-9);
  });

  it("lock restricts endpoint snap to the locked segment", () => {
    const index = unitSquareIndex();
    const bottom = index.segments.find(
      (s) => Math.abs(s.a.y) < 1e-6 && Math.abs(s.b.y) < 1e-6,
    )!;
    // Cursor near top-left corner — would normally snap there, but lock is bottom edge.
    const hit = querySnap(
      ctx(index, {
        cursor: { x: 2, y: 2 },
        phase: "p2",
        p1: { x: 50, y: 0 },
        lock: { kind: "segment", segmentId: bottom.id },
        enabledModes: ["endpoint"],
        radiusScreenPx: 20,
      }),
    );
    // Top-left not on bottom; bottom's left endpoint (0,0) is in radius.
    expect(hit?.mode).toBe("endpoint");
    expect(hit!.segmentId).toBe(bottom.id);
  });
});

describe("suggestDimLength", () => {
  it("prefills from nearby parallel dim text without auto-confirm semantics", () => {
    const index = bakeGeometryIndex(
      vectorsFixture({
        segments: {
          lines: [[0, 25, 50, 25]],
          rects: [],
          quads: [],
          curves: [],
        },
        dim_texts: [
          {
            text: "8'-0\"",
            x0: 5,
            y0: 20,
            x1: 45,
            y1: 20,
            parsed_feet: 8,
            confidence: 0.95,
          },
          {
            text: "junk",
            x0: 0,
            y0: 0,
            x1: 5,
            y1: 5,
            parsed_feet: 99,
            confidence: 0.2,
          },
        ],
      }),
    )!;
    const p1 = { x: 0, y: 50 };
    const p2 = { x: 100, y: 50 };
    const suggestion = suggestDimLength(index, p1, p2, { maxDistPx: 40 });
    expect(suggestion).not.toBeNull();
    expect(suggestion!.parsedFeet).toBe(8);
    expect(suggestion!.text).toContain("8");
  });

  it("returns null when dims are far or low confidence", () => {
    const index = bakeGeometryIndex(
      vectorsFixture({
        segments: {
          lines: [[0, 0, 50, 0]],
          rects: [],
          quads: [],
          curves: [],
        },
        dim_texts: [
          {
            text: "3'",
            x0: 0,
            y0: 90,
            x1: 10,
            y1: 90,
            parsed_feet: 3,
            confidence: 0.9,
          },
        ],
      }),
    )!;
    expect(suggestDimLength(index, { x: 0, y: 0 }, { x: 100, y: 0 }, { maxDistPx: 20 })).toBeNull();
  });
});

describe("SF must-not-break invariants", () => {
  it("snap points stay in PNG space (same units as calibrate clicks)", () => {
    const index = unitSquareIndex();
    const hit = querySnap(ctx(index, { cursor: { x: 1, y: 1 } }));
    expect(hit).not.toBeNull();
    // Corners of unit square bake to 0/100 PNG — never raw PDF pt (0/50).
    expect(hit!.point.x).toBeLessThanOrEqual(100);
    expect(hit!.point.y).toBeLessThanOrEqual(100);
    expect(dist(hit!.point, { x: 0, y: 0 })).toBeLessThan(1);
  });

  it("does not invent geometry when image size override mismatches would refuse bake", () => {
    // Missing sizes → null index; caller must skip snap (PR3), never invent DPI.
    expect(
      bakeGeometryIndex(
        vectorsFixture({
          image_width_px: null,
          image_height_px: null,
          page_width_pt: 100,
          page_height_pt: 200,
        }),
      ),
    ).toBeNull();
  });

  it("anisotropic bake keeps PNG Euclidean distance", () => {
    // page 100×200 pt, raster 250×400 px → sx=0.4, sy=0.5 (never average).
    const index = bakeGeometryIndex(
      vectorsFixture({
        page_width_pt: 100,
        page_height_pt: 200,
        image_width_px: 250,
        image_height_px: 400,
        segments: {
          lines: [[0, 50, 40, 50]], // 40 pt → 100 PNG px on X
          rects: [],
          quads: [],
          curves: [],
        },
      }),
    );
    expect(index).not.toBeNull();
    expect(index!.sx).toBeCloseTo(0.4, 10);
    expect(index!.sy).toBeCloseTo(0.5, 10);
    expect(index!.truncated).toBe(false);
    const seg = index!.segments[0]!;
    expect(dist(seg.a, seg.b)).toBeCloseTo(100, 5);
  });
});

describe("geometry cache", () => {
  it("round-trips a baked index by job/page/size key", async () => {
    const {
      clearGeometryCache,
      geometryCacheKey,
      getCachedGeometryIndex,
      setCachedGeometryIndex,
    } = await import("../src/lib/snap/vectorCache");
    clearGeometryCache();
    const index = unitSquareIndex();
    const key = geometryCacheKey("job-a", 0, 200, 400);
    setCachedGeometryIndex(key, index);
    expect(getCachedGeometryIndex(key)).toBe(index);
    clearGeometryCache(key);
    expect(getCachedGeometryIndex(key)).toBeNull();
  });
});
