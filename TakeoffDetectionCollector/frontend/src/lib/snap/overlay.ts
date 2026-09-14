/** Zoomed-in overlay of kept PDF strokes and junction / crossing dots. */

import type { FillPoly, GeometryIndex, Point, Segment, SnapHit } from "./types";

/** Past fit-to-page; actual size (100%) is well above this. */
export const VECTOR_OVERLAY_MIN_ZOOM = 1.5;
export const VECTOR_OVERLAY_COLOR = "#e11d48";

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

/** Combined SVG paths for in-view snap segments and junction dots, or null when nothing to draw. */
export function vectorOverlayPaths(index: GeometryIndex, view: OverlayView, zoom: number): VectorOverlayPaths | null {
  if (!shouldShowVectorOverlay(zoom)) return null;
  const marks = visibleDots(index.dots ?? [], view);
  const segs = visibleSegments(index.segments, view);
  if (!marks.length && !segs.length) return null;
  const z = zoom > 1e-9 ? zoom : 1e-9;
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
