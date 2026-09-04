import { describe, expect, it } from "vitest";
import { openingBoxes } from "../src/lib/blackout";
import { compactPageBlackouts, normalizeRegion } from "../src/lib/pageBlackouts";

describe("normalizeRegion", () => {
  it("normalizes pixel rects to [0,1] page fractions", () => {
    expect(normalizeRegion({ x1: 10, y1: 20, x2: 40, y2: 60 }, 100, 100)).toEqual({
      x1: 0.1,
      y1: 0.2,
      x2: 0.4,
      y2: 0.6,
    });
  });

  it("accepts reversed drag corners and clamps to the page", () => {
    expect(normalizeRegion({ x1: 40, y1: 60, x2: 10, y2: 20 }, 100, 50)).toEqual({
      x1: 0.1,
      y1: 0.4,
      x2: 0.4,
      y2: 1,
    });
  });

  it("rejects degenerate or zero-size inputs", () => {
    expect(normalizeRegion({ x1: 10, y1: 20, x2: 10, y2: 60 }, 100, 100)).toBeNull();
    expect(normalizeRegion({ x1: 0, y1: 0, x2: 1, y2: 1 }, 0, 100)).toBeNull();
  });
});

describe("compactPageBlackouts", () => {
  it("keeps selected pages that have regions, in selection order", () => {
    const out = compactPageBlackouts(
      [
        { page: 9, regions: [{ x1: 0, y1: 0, x2: 1, y2: 1 }] },
        { page: 2, regions: [{ x1: 0, y1: 0, x2: 0.5, y2: 0.5 }] },
        { page: 3, regions: [] },
      ],
      [2, 3, 9],
    );
    expect(out).toEqual([
      { page: 2, regions: [{ x1: 0, y1: 0, x2: 0.5, y2: 0.5 }] },
      { page: 9, regions: [{ x1: 0, y1: 0, x2: 1, y2: 1 }] },
    ]);
  });

  it("drops pages outside the selection", () => {
    expect(
      compactPageBlackouts(
        [{ page: 5, regions: [{ x1: 0, y1: 0, x2: 1, y2: 1 }] }],
        [1, 2],
      ),
    ).toEqual([]);
  });
});

describe("openingBoxes (legacy Box.blackout filter)", () => {
  it("excludes legacy blackout boxes from opening lists", () => {
    const boxes = [
      { box_id: "a", blackout: true as const },
      { box_id: "b" },
      { box_id: "c", blackout: false as const },
    ];
    expect(openingBoxes(boxes).map((b) => b.box_id)).toEqual(["b", "c"]);
  });
});
