/** Main snap query: hard priority across modes within screen-pixel radius. */

import { lockFromHit } from "./lock";
import { nearestOnSegment, dist } from "./math";
import { bestOf, collectModeHits } from "./modes";
import { querySegmentIds } from "./spatial";
import { radiusPngFromScreen } from "./transform";
import {
  ALL_SNAP_MODES,
  SNAP_PRIORITY,
  type GeometryIndex,
  type LockState,
  type Point,
  type SnapContext,
  type SnapHit,
  type SnapMode,
} from "./types";

const MODES_NEEDING_P1: ReadonlySet<SnapMode> = new Set([
  "perpendicular",
  "ortho",
  "parallel",
]);

/** Ortho stays in-radius on a vertical drag and steals the second edge. */
const ORTHO_MODE: SnapMode = "ortho";

/**
 * True when the cursor is within radiusPx of any segment (true distance, not
 * just AABB). Used to drop ortho while approaching real linework.
 */
export function cursorNearLinework(
  index: GeometryIndex,
  cursor: Point,
  radiusPx: number,
): boolean {
  if (!(radiusPx > 0) || index.empty) return false;
  const ids = querySegmentIds(index.spatial, cursor.x, cursor.y, radiusPx);
  for (const id of ids) {
    const seg = index.segmentById.get(id);
    if (!seg) continue;
    const { point } = nearestOnSegment(cursor, seg.a, seg.b);
    if (dist(cursor, point) <= radiusPx) return true;
  }
  return false;
}

/**
 * Resolve the best snap hit for the current cursor.
 * Returns null when bypassed, empty index, or nothing within radius.
 */
export function querySnap(ctx: SnapContext): SnapHit | null {
  if (ctx.bypass) return null;
  if (ctx.index.empty) return null;

  const zoom = ctx.zoom > 1e-9 ? ctx.zoom : 1e-9;
  // Floor so high zoom still has a usable magnet in image space.
  const radiusPx = Math.max(radiusPngFromScreen(ctx.radiusScreenPx, zoom), 2);
  if (!(radiusPx > 0)) return null;

  const enabled = new Set(ctx.enabledModes ?? ALL_SNAP_MODES);
  const lock: LockState =
    ctx.phase === "p2" || ctx.phase === "length" ? ctx.lock : { kind: "none" };

  // During p1 placement (idle / first click), do not use lock yet.
  const activeLock: LockState =
    ctx.phase === "idle" || (ctx.phase === "p1" && !ctx.p1) ? { kind: "none" } : lock;

  // Vertical measure keeps |dx| tiny, so ortho stays in-radius the whole drag and
  // steals the second edge. While near any linework, drop ortho so nearest /
  // perpendicular can latch. Leave parallel alone (explicit lock / CAD mode).
  if (
    ctx.p1 &&
    (ctx.phase === "p2" || ctx.phase === "length") &&
    enabled.has(ORTHO_MODE) &&
    cursorNearLinework(ctx.index, ctx.cursor, radiusPx * 2)
  ) {
    enabled.delete(ORTHO_MODE);
  }

  const screenRadius = Math.max(ctx.radiusScreenPx, radiusPx * zoom);

  for (const mode of SNAP_PRIORITY) {
    if (!enabled.has(mode)) continue;
    if (MODES_NEEDING_P1.has(mode) && !ctx.p1) continue;
    const hits = collectModeHits(
      mode,
      ctx.index,
      ctx.cursor,
      radiusPx,
      zoom,
      activeLock,
      ctx.p1,
    ).filter((h) => h.screenDistPx <= screenRadius + 1e-6);
    const best = bestOf(hits);
    if (best) return best;
  }
  return null;
}

/** Convenience: snap + derive lock for committing p1. */
export function snapAndLock(ctx: SnapContext): { hit: SnapHit | null; lock: LockState } {
  const hit = querySnap(ctx);
  return { hit, lock: lockFromHit(hit) };
}
