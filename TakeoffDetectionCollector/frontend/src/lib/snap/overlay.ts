/** Zoomed-in overlay of kept PDF strokes and junction / crossing dots. */

import { querySegmentIds } from "./spatial";
import type { FillPoly, GeometryIndex, Point, Segment, SnapHit } from "./types";

/** Past fit-to-page; actual size (100%) is well above this. */
export const VECTOR_OVERLAY_MIN_ZOOM = 1.5;
export const VECTOR_OVERLAY_COLOR = "#e11d48";
/** Screen-space halo: linework is only painted inside this radius of the cursor. */
export const VECTOR_OVERLAY_HOVER_PX = 48;

const DOT_SCREEN_PX = 1.6;
const VIEW_PAD_SCREEN = 24;
const MIN_FILL_SCREEN_PX = 1;
const MAX_OVERLAY_FILLS = 4000;
const MAX_OVERLAY_DOTS = 3000;
const MAX_OVERLAY_LINES = 3000;

export const FULL_OVERLAY_VIEW: OverlayView = {
  minX: Number.NEGATIVE_INFINITY,
  minY: Number.NEGATIVE_INFINITY,
  maxX: Number.POSITIVE_INFINITY,
  maxY: Number.POSITIVE_INFINITY,
};

export type OverlayView = { minX: number; minY: number; maxX: number; maxY: number };

export type VectorOverlayPaths = {
  fills: string;
  lines: string;
  crosses: string;
  dots: string;
};

export function shouldShowVectorOverlay(zoom: number): boolean {
  return zoom >= VECTOR_OVERLAY_MIN_ZOOM;
}

export function geometryHasOverlay(index: GeometryIndex | null | undefined): boolean {
  return Boolean(index && Array.isArray(index.fills) && Array.isArray(index.dots));
}

export function overlayViewRect(
  panX: number,
  panY: number,
  zoom: number,
  viewW: number,
  viewH: number,
): OverlayView {
  const z = zoom > 1e-9 ? zoom : 1e-9;
  const pad = VIEW_PAD_SCREEN / z;
  return {
    minX: -panX / z - pad,
    minY: -panY / z - pad,
    maxX: (viewW - panX) / z + pad,
    maxY: (viewH - panY) / z + pad,
  };
}

function overlaps(box: { minX: number; minY: number; maxX: number; maxY: number }, view: OverlayView): boolean {
  return !(box.maxX < view.minX || box.maxY < view.minY || box.minX > view.maxX || box.minY > view.maxY);
}

function fillLargeEnough(fill: FillPoly, zoom: number): boolean {
  return (fill.maxX - fill.minX) * zoom >= MIN_FILL_SCREEN_PX || (fill.maxY - fill.minY) * zoom >= MIN_FILL_SCREEN_PX;
}

function inView(p: Point, view: OverlayView): boolean {
  return p.x >= view.minX && p.x <= view.maxX && p.y >= view.minY && p.y <= view.maxY;
}

function dotPath(p: Point, r: number): string {
  const { x, y } = p;
  return `M ${x + r} ${y} A ${r} ${r} 0 1 0 ${x - r} ${y} A ${r} ${r} 0 1 0 ${x + r} ${y}`;
}

export function visibleFills(fills: FillPoly[] | undefined, view: OverlayView, zoom: number, cap = MAX_OVERLAY_FILLS): FillPoly[] {
  const out: FillPoly[] = [];
  for (const fill of fills ?? []) {
    if (!overlaps(fill, view) || !fillLargeEnough(fill, zoom)) continue;
    out.push(fill);
    if (out.length >= cap) break;
  }
  return out;
}

export function visibleSegments(segments: Segment[] | undefined, view: OverlayView, cap = MAX_OVERLAY_LINES): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments ?? []) {
    if (!overlaps(seg, view)) continue;
    out.push(seg);
    if (out.length >= cap) break;
  }
  return out;
}

export function visibleDots(dots: Point[], view: OverlayView, cap = MAX_OVERLAY_DOTS): Point[] {
  const out: Point[] = [];
  for (const p of dots) {
    if (!inView(p, view)) continue;
    out.push(p);
    if (out.length >= cap) break;
  }
  return out;
}

function lerpPoint(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Portion of AB inside the disk of radius r around c, or null if they miss. */
export function clipSegmentToDisk(a: Point, b: Point, c: Point, r: number): { a: Point; b: Point } | null {
  if (!(r > 0)) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - c.x;
  const fy = a.y - c.y;
  const A = dx * dx + dy * dy;
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - r * r;
  if (!(A > 1e-18)) return C <= 0 ? { a: { x: a.x, y: a.y }, b: { x: a.x, y: a.y } } : null;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const inv = 0.5 / A;
  const lo = Math.max(0, (-B - s) * inv);
  const hi = Math.min(1, (-B + s) * inv);
  if (hi < lo) return null;
  return { a: lerpPoint(a, b, lo), b: lerpPoint(a, b, hi) };
}

/** Combined SVG paths for snap segments and junction dots near the cursor, or null. */
export function vectorOverlayPaths(
  index: GeometryIndex,
  view: OverlayView,
  zoom: number,
  cursor?: Point | null,
): VectorOverlayPaths | null {
  if (!shouldShowVectorOverlay(zoom) || !cursor) return null;
  const z = zoom > 1e-9 ? zoom : 1e-9;
  const radiusPx = VECTOR_OVERLAY_HOVER_PX / z;
  const ids = querySegmentIds(index.spatial, cursor.x, cursor.y, radiusPx);
  const segs: { a: Point; b: Point }[] = [];
  for (const id of ids) {
    const seg = index.segmentById.get(id);
    if (!seg) continue;
    const clipped = clipSegmentToDisk(seg.a, seg.b, cursor, radiusPx);
    if (!clipped) continue;
    segs.push(clipped);
    if (segs.length >= MAX_OVERLAY_LINES) break;
  }
  const r2 = radiusPx * radiusPx;
  const marks: Point[] = [];
  for (const p of index.dots ?? []) {
    if (!inView(p, view)) continue;
    const dx = p.x - cursor.x;
    const dy = p.y - cursor.y;
    if (dx * dx + dy * dy > r2) continue;
    marks.push(p);
    if (marks.length >= MAX_OVERLAY_DOTS) break;
  }
  if (!marks.length && !segs.length) return null;
  const dotR = DOT_SCREEN_PX / z;
  return {
    fills: "",
    lines: segs.map((s) => `M ${s.a.x} ${s.a.y} L ${s.b.x} ${s.b.y}`).join(" "),
    crosses: "",
    dots: marks.map((p) => dotPath(p, dotR)).join(" "),
  };
}

export type ActiveSnapMark = {
  point: Point;
  a?: Point;
  b?: Point;
};

/** The segment the magnet actually latched, so the canvas can paint that edge. */
export function activeSnapMark(
  hit: SnapHit | null | undefined,
  index?: GeometryIndex | null,
): ActiveSnapMark | null {
  if (!hit) return null;
  const g = hit.guide;
  if (g && (g.kind === "segment" || g.kind === "midpoint")) {
    return { point: hit.point, a: g.a, b: g.b };
  }
  if (hit.segmentId && index) {
    const seg = index.segmentById.get(hit.segmentId);
    if (seg) return { point: hit.point, a: seg.a, b: seg.b };
  }
  return { point: hit.point };
}
