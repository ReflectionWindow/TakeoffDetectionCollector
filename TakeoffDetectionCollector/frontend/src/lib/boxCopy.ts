import type { Box } from "../api/types";
import { pointsOf, withAABB } from "./geometry";

/** Image-space nudge so a paste is not stacked exactly on the original. */
export const BOX_COPY_OFFSET = 16;

export function duplicateBoxes(
  boxes: Box[],
  dx = BOX_COPY_OFFSET,
  dy = BOX_COPY_OFFSET,
  newId: () => string = () => crypto.randomUUID(),
): Box[] {
  return boxes.map((b) => {
    const points = pointsOf(b).map((p) => ({ x: p.x + dx, y: p.y + dy }));
    return withAABB(
      {
        ...b,
        box_id: newId(),
        origin: "user",
        edited: true,
        score: null,
      },
      points,
    );
  });
}
