import { describe, expect, it } from "vitest";
import type { Box } from "../src/api/types";
import { BOX_COPY_OFFSET, duplicateBoxes } from "../src/lib/boxCopy";

function box(partial: Partial<Box> & Pick<Box, "box_id" | "x1" | "y1" | "x2" | "y2">): Box {
  return {
    points: [],
    category_id: 3,
    class_name: "WW",
    origin: "imported",
    ...partial,
  };
}

describe("duplicateBoxes", () => {
  it("assigns new ids and offsets geometry so the copy is not stacked", () => {
    const ids = ["copy-1", "copy-2"];
    const copies = duplicateBoxes(
      [
        box({ box_id: "a", x1: 10, y1: 20, x2: 40, y2: 80, points: [{ x: 10, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 80 }, { x: 10, y: 80 }] }),
        box({ box_id: "b", x1: 100, y1: 0, x2: 110, y2: 10 }),
      ],
      BOX_COPY_OFFSET,
      BOX_COPY_OFFSET,
      () => ids.shift()!,
    );
    expect(copies.map((c) => c.box_id)).toEqual(["copy-1", "copy-2"]);
    expect(copies[0]).toMatchObject({
      x1: 26,
      y1: 36,
      x2: 56,
      y2: 96,
      origin: "user",
      edited: true,
      class_name: "WW",
      score: null,
    });
    expect(copies[0]!.points[0]).toEqual({ x: 26, y: 36 });
    expect(copies[1]).toMatchObject({ x1: 116, y1: 16, x2: 126, y2: 26 });
  });

  it("can stamp a copy in place for alt-drag", () => {
    const [copy] = duplicateBoxes([box({ box_id: "a", x1: 0, y1: 0, x2: 8, y2: 8 })], 0, 0, () => "n");
    expect(copy).toMatchObject({ box_id: "n", x1: 0, y1: 0, x2: 8, y2: 8 });
  });

  it("returns an empty list when nothing is selected", () => {
    expect(duplicateBoxes([])).toEqual([]);
  });
});
