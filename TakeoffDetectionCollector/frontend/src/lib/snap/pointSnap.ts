/** Point and edge snap for vertices: endpoints, intersections, midpoints, on-line, dots. */

import type { Rect, ResizeHandle } from "../geometry";
import { EDGE_SNAP_CAPTURE_PX } from "./edgeSnap";
import { querySnap } from "./query";
import type { GeometryIndex, Point, SnapHit, SnapMode } from "./types";

export const POINT_SNAP_MODES: readonly SnapMode[] = ["endpoint", "intersection", "midpoint"];
export const LINE_SNAP_MODES: readonly SnapMode[] = ["nearest"];

export type AdjustSnap = {
  line: boolean;
  point: boolean;
};

export const DEFAULT_ADJUST_SNAP: AdjustSnap = { line: true, point: true };

export function enabledAdjustModes(adjust: AdjustSnap): SnapMode[] {
  const modes: SnapMode[] = [];
  if (adjust.point) modes.push(...POINT_SNAP_MODES);
  if (adjust.line) modes.push(...LINE_SNAP_MODES);
  return modes;
}

export function queryPointSnap(
  index: GeometryIndex | null | undefined,
  cursor: Point,
  zoom: number,
  bypass: boolean,
): SnapHit | null {
  return queryAdjustSnap(index, cursor, zoom, bypass, { line: false, point: true });
}

export function queryAdjustSnap(
  index: GeometryIndex | null | undefined,
  cursor: Point,
  zoom: number,
  bypass: boolean,
  adjust: AdjustSnap,
): SnapHit | null {
  const enabledModes = enabledAdjustModes(adjust);
  if (!index || index.empty || bypass || !enabledModes.length) return null;
  return querySnap({
    index,
    cursor,
    radiusScreenPx: EDGE_SNAP_CAPTURE_PX,
    zoom,
    phase: "idle",
    lock: { kind: "none" },
    enabledModes,
    bypass,
  });
}

export function cornerOfHandle(rect: Rect, handle: ResizeHandle): Point | null {
  if (handle === "nw") return { x: rect.x1, y: rect.y1 };
  if (handle === "ne") return { x: rect.x2, y: rect.y1 };
  if (handle === "sw") return { x: rect.x1, y: rect.y2 };
  if (handle === "se") return { x: rect.x2, y: rect.y2 };
  return null;
}

export function applyCorner(rect: Rect, handle: ResizeHandle, point: Point): Rect {
  const next = { ...rect };
  if (handle.includes("w")) next.x1 = point.x;
  if (handle.includes("e")) next.x2 = point.x;
  if (handle.includes("n")) next.y1 = point.y;
  if (handle.includes("s")) next.y2 = point.y;
  return next;
}

const CORNER_HANDLES: ResizeHandle[] = ["nw", "ne", "sw", "se"];

export function snapRectByPoint(
  rect: Rect,
  index: GeometryIndex | null | undefined,
  zoom: number,
  bypass: boolean,
): { rect: Rect; hit: SnapHit | null } {
  if (!index || bypass) return { rect, hit: null };
  let best: { hit: SnapHit; dx: number; dy: number } | null = null;
  for (const handle of CORNER_HANDLES) {
    const corner = cornerOfHandle(rect, handle);
    if (!corner) continue;
    const hit = queryPointSnap(index, corner, zoom, false);
    if (!hit) continue;
    if (!best || hit.distPx < best.hit.distPx) {
      best = { hit, dx: hit.point.x - corner.x, dy: hit.point.y - corner.y };
    }
  }
  if (!best) return { rect, hit: null };
  return {
    rect: {
      x1: rect.x1 + best.dx,
      y1: rect.y1 + best.dy,
      x2: rect.x2 + best.dx,
      y2: rect.y2 + best.dy,
    },
    hit: best.hit,
  };
}
