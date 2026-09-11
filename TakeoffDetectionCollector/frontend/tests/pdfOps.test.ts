import { describe, expect, it } from "vitest";
import { walkPdfOps, type PdfVectorOps } from "../src/lib/pdfOps";

const OPS: PdfVectorOps = {
  moveTo: 13,
  lineTo: 14,
  curveTo: 15,
  curveTo2: 16,
  curveTo3: 17,
  closePath: 18,
  rectangle: 19,
  stroke: 20,
  closeStroke: 21,
  fill: 22,
  eoFill: 23,
  fillStroke: 24,
  eoFillStroke: 25,
  closeFillStroke: 26,
  closeEOFillStroke: 27,
  endPath: 28,
  clip: 29,
  eoClip: 30,
  save: 10,
  restore: 11,
  transform: 12,
  constructPath: 91,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  beginGroup: 76,
  endGroup: 77,
};

function identity(x: number, y: number) {
  return { x, y };
}

describe("walkPdfOps", () => {
  it("records a filled rectangle as a color fill", () => {
    const out = walkPdfOps(
      [OPS.constructPath, OPS.fill],
      [[[OPS.rectangle], [10, 10, 20, 8], [10, 10, 30, 18]], null],
      OPS,
      identity,
      400,
      400,
    );
    expect(out.fills).toHaveLength(1);
    expect(out.fills[0]!.slice(0, 4)).toEqual([10, 10, 30, 10]);
  });

  it("keeps a short stroke as linework so edges can snap", () => {
    const out = walkPdfOps(
      [OPS.constructPath, OPS.stroke],
      [[[OPS.moveTo, OPS.lineTo], [50, 50, 54, 50], [50, 50, 54, 50]], null],
      OPS,
      identity,
      400,
      400,
    );
    expect(out.lines).toEqual([[50, 50, 54, 50]]);
    expect(out.points).toEqual([]);
  });

  it("turns a degenerate stroke into a tick", () => {
    const out = walkPdfOps(
      [OPS.constructPath, OPS.stroke],
      [[[OPS.moveTo, OPS.lineTo], [50, 50, 50.2, 50], [50, 50, 50.2, 50]], null],
      OPS,
      identity,
      400,
      400,
    );
    expect(out.lines).toHaveLength(0);
    expect(out.points).toEqual([[50.1, 50]]);
  });

  it("turns a skinny filled rect into linework (CAD mullions are `re f`, not strokes)", () => {
    const out = walkPdfOps(
      [OPS.constructPath, OPS.fill],
      [[[OPS.rectangle], [10, 10, 80, 4], [10, 10, 90, 14]], null],
      OPS,
      identity,
      400,
      400,
    );
    expect(out.fills).toHaveLength(1);
    expect(out.lines.length).toBe(2);
    expect(out.lines.some((l) => Math.abs(l[2]! - l[0]!) >= 70)).toBe(true);
  });

  it("does not turn a glass poche fill into snap edges", () => {
    const out = walkPdfOps(
      [OPS.constructPath, OPS.fill],
      [[[OPS.rectangle], [10, 10, 80, 50], [10, 10, 90, 60]], null],
      OPS,
      identity,
      400,
      400,
    );
    expect(out.fills).toHaveLength(1);
    expect(out.lines).toHaveLength(0);
  });

  it("keeps brick hatch cells as ticks, not four-edge boxes", () => {
    const out = walkPdfOps(
      [OPS.constructPath, OPS.fill],
      [[[OPS.rectangle], [10, 10, 12, 12], [10, 10, 22, 22]], null],
      OPS,
      identity,
      400,
      400,
    );
    expect(out.fills).toHaveLength(0);
    expect(out.lines).toHaveLength(0);
    expect(out.points).toHaveLength(1);
  });

  it("drops a page-sized fill so the background is not painted red", () => {
    const out = walkPdfOps(
      [OPS.constructPath, OPS.fill],
      [[[OPS.rectangle], [0, 0, 400, 400], [0, 0, 400, 400]], null],
      OPS,
      identity,
      400,
      400,
    );
    expect(out.fills).toHaveLength(0);
    expect(out.lines).toHaveLength(0);
  });

  it("applies content-stream transforms before mapping", () => {
    const out = walkPdfOps(
      [OPS.transform, OPS.constructPath, OPS.fill],
      [
        [1, 0, 0, 1, 100, 0],
        [[OPS.rectangle], [0, 10, 40, 20], [0, 10, 40, 30]],
        null,
      ],
      OPS,
      identity,
      400,
      400,
    );
    expect(out.fills[0]!.slice(0, 2)).toEqual([100, 10]);
  });
});
