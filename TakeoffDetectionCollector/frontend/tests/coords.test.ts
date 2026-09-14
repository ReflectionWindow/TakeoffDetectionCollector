import { describe, expect, it } from "vitest";
import { IMPORT_DPI, overlayBoxPoints, ptToPx75, px75ToPt, type OverlayBox } from "../src/lib/coords";
import { bakeGeometryIndex } from "../src/lib/snap";
import type { PageVectorsResponse } from "../src/api/types";

describe("75 DPI contract", () => {
  it("round-trips px75 through PDF points", () => {
    expect(ptToPx75(px75ToPt(3600))).toBeCloseTo(3600);
    expect(IMPORT_DPI).toBe(75);
  });
});

describe("imported raster overlay", () => {
  const cocoW = 3600;
  const cocoH = 2700;
  // 36"×27" CropBox — not the 48"×36" implied by 3600×2700 at 75 DPI.
  const pageWpt = 2592;
  const pageHpt = 1944;
  const displayW = pageWpt * 1.5;
  const displayH = pageHpt * 1.5;
  const box: OverlayBox = {
    polygon_pt: [
      [px75ToPt(900), px75ToPt(675)],
      [px75ToPt(1800), px75ToPt(675)],
      [px75ToPt(1800), px75ToPt(1350)],
      [px75ToPt(900), px75ToPt(1350)],
    ],
    polygon_px75: [
      [900, 675],
      [1800, 675],
      [1800, 1350],
      [900, 1350],
    ],
    bbox_pt: [px75ToPt(900), px75ToPt(675), px75ToPt(900), px75ToPt(675)],
    bbox_px75: [900, 675, 900, 675],
    edited: false,
  };

  it("stretches COCO pixels onto the rendered PDF, not through 75 DPI page size", () => {
    const pts = overlayBoxPoints(box, {
      displayW,
      displayH,
      pageWpt,
      pageHpt,
      cocoW,
      cocoH,
      rasterOverlay: true,
    });
    expect(pts[0]!.x).toBeCloseTo((900 / cocoW) * displayW);
    expect(pts[0]!.y).toBeCloseTo((675 / cocoH) * displayH);
    expect(pts[2]!.x).toBeCloseTo((1800 / cocoW) * displayW);
    expect(pts[2]!.y).toBeCloseTo((1350 / cocoH) * displayH);
  });

  it("the 75 DPI pt path would land in the wrong place on a different CropBox", () => {
    const pts = overlayBoxPoints(box, {
      displayW,
      displayH,
      pageWpt,
      pageHpt,
      cocoW,
      cocoH,
      rasterOverlay: false,
    });
    expect(pts[0]!.x).not.toBeCloseTo((900 / cocoW) * displayW);
    expect(pts[0]!.x).toBeCloseTo((px75ToPt(900) / pageWpt) * displayW);
  });
});

describe("bake fills and dots", () => {
  it("does not explode bulky fills and keeps isolated ticks as endpoints only", () => {
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
    expect(index!.segments).toHaveLength(0);
    expect(index!.fills).toHaveLength(1);
    expect(index!.fills[0]!.points).toHaveLength(4);
    expect(index!.dots.some((p) => p.x === 50 && p.y === 50)).toBe(false);
    expect(index!.endpoints.some((e) => e.p.x === 50 && e.p.y === 50)).toBe(true);
    expect(index!.empty).toBe(false);
  });
});
