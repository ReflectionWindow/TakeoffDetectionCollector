import { describe, expect, it } from "vitest";
import {
  applyMarqueeSelection,
  boxesInRect,
  edgeMidpoints,
  insertVertex,
  isAdditiveSelectEvent,
  isMarqueeGesture,
  isRectangle,
  MIN_POLY_POINTS,
  nearestMidpoint,
  quadFromRect,
  rectsOverlap,
  removeVertex,
} from "../src/lib/geometry";

const box = quadFromRect({ x1: 0, y1: 0, x2: 100, y2: 50 });

describe("edgeMidpoints", () => {
  it("returns one midpoint per edge, including the closing edge", () => {
    expect(edgeMidpoints(box)).toEqual([
      { x: 50, y: 0 },
      { x: 100, y: 25 },
      { x: 50, y: 50 },
      { x: 0, y: 25 },
    ]);
  });
});

describe("nearestMidpoint", () => {
  it("finds the handle under the cursor", () => {
    expect(nearestMidpoint({ x: 52, y: 2 }, box, 10)).toBe(0);
    expect(nearestMidpoint({ x: 98, y: 26 }, box, 10)).toBe(1);
  });

  it("misses when the cursor is far from every handle", () => {
    expect(nearestMidpoint({ x: 50, y: 25 }, box, 5)).toBe(-1);
  });
});

describe("insertVertex", () => {
  it("turns an imported rectangle into a five-sided polygon", () => {
    const pulled = insertVertex(box, 0, { x: 50, y: -20 });
    expect(pulled).toHaveLength(5);
    expect(pulled[1]).toEqual({ x: 50, y: -20 });
    expect(isRectangle(box)).toBe(true);
    expect(isRectangle(pulled)).toBe(false);
  });

  it("keeps winding order so the shape does not self-cross", () => {
    const pulled = insertVertex(box, 1, { x: 120, y: 25 });
    expect(pulled.map((p) => `${p.x},${p.y}`)).toEqual([
      "0,0",
      "100,0",
      "120,25",
      "100,50",
      "0,50",
    ]);
  });

  it("ignores an out-of-range edge", () => {
    expect(insertVertex(box, 9, { x: 1, y: 1 })).toEqual(box);
  });
});

describe("removeVertex", () => {
  it("drops the requested vertex", () => {
    const five = insertVertex(box, 0, { x: 50, y: -20 });
    expect(removeVertex(five, 1)).toEqual(box);
  });

  it("refuses to collapse a triangle into a line", () => {
    const tri = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    expect(tri).toHaveLength(MIN_POLY_POINTS);
    expect(removeVertex(tri, 0)).toEqual(tri);
  });
});

describe("isRectangle", () => {
  it("tolerates sub-pixel drift on an axis-aligned quad", () => {
    expect(isRectangle([
      { x: 0, y: 0 },
      { x: 100.004, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 50.002 },
    ])).toBe(true);
  });

  it("rejects a rotated quad", () => {
    expect(isRectangle([
      { x: 10, y: 0 },
      { x: 20, y: 10 },
      { x: 10, y: 20 },
      { x: 0, y: 10 },
    ])).toBe(false);
  });
});

describe("rectsOverlap / boxesInRect", () => {
  it("selects boxes whose bounds intersect a marquee", () => {
    expect(rectsOverlap({ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 5, y1: 5, x2: 20, y2: 20 })).toBe(true);
    expect(rectsOverlap({ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 11, y1: 0, x2: 20, y2: 10 })).toBe(false);
    expect(
      boxesInRect(
        [
          { box_id: "a", x1: 0, y1: 0, x2: 10, y2: 10 },
          { box_id: "b", x1: 50, y1: 50, x2: 60, y2: 60 },
        ],
        { x1: 8, y1: 8, x2: 12, y2: 12 },
      ),
    ).toEqual(["a"]);
  });
});

describe("marquee selection", () => {
  it("replaces the selection unless additive", () => {
    expect(applyMarqueeSelection(["a"], ["b", "c"], false)).toEqual(["b", "c"]);
    expect(applyMarqueeSelection(["a"], ["b", "c"], true)).toEqual(["a", "b", "c"]);
  });

  it("keeps original order and drops duplicates when adding", () => {
    expect(applyMarqueeSelection(["a", "b"], ["b", "c"], true)).toEqual(["a", "b", "c"]);
  });

  it("commits after a short drag, including a thin swipe", () => {
    expect(isMarqueeGesture(8, 0, 1)).toBe(true);
    expect(isMarqueeGesture(4, 0, 1)).toBe(false);
    expect(isMarqueeGesture(4, 0, 2)).toBe(true);
  });
});

describe("additive select modifiers", () => {
  it("treats Shift, ⌘, and Ctrl as additive", () => {
    expect(isAdditiveSelectEvent({ shiftKey: true })).toBe(true);
    expect(isAdditiveSelectEvent({ metaKey: true })).toBe(true);
    expect(isAdditiveSelectEvent({ ctrlKey: true })).toBe(true);
    expect(isAdditiveSelectEvent({})).toBe(false);
  });

  it("reads Accel/Meta from getModifierState and a held-key fallback", () => {
    expect(isAdditiveSelectEvent({ getModifierState: (k) => k === "Accel" })).toBe(true);
    expect(isAdditiveSelectEvent({ getModifierState: (k) => k === "Meta" })).toBe(true);
    expect(isAdditiveSelectEvent({}, true)).toBe(true);
    expect(isAdditiveSelectEvent({ getModifierState: () => false })).toBe(false);
  });
});
