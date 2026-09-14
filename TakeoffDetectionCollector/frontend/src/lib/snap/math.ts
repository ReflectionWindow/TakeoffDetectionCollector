/** Pure geometry helpers for snap modes (PNG pixel space). */

import type { Point, Segment } from "./types";

export function hypot(dx: number, dy: number): number {
  return Math.hypot(dx, dy);
}

export function dist(a: Point, b: Point): number {
  return hypot(b.x - a.x, b.y - a.y);
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function clamp01(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t;
}

/** Closest point on finite segment AB to P. */
export function nearestOnSegment(p: Point, a: Point, b: Point): { point: Point; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!(len2 > 0)) return { point: { ...a }, t: 0 };
  const t = clamp01(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2);
  return { point: { x: a.x + t * dx, y: a.y + t * dy }, t };
}

/** Unit direction of segment, or null if degenerate. */
export function unitDir(a: Point, b: Point): Point | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = hypot(dx, dy);
  if (!(len > 0)) return null;
  return { x: dx / len, y: dy / len };
}

/**
 * Finite segment intersection. Returns null if parallel or intersection not on both segments.
 * Parametric: A + t(B−A) = C + u(D−C), with t,u ∈ [0,1].
 */
export function segmentIntersection(a: Point, b: Point, c: Point, d: Point): Point | null {
  const rX = b.x - a.x;
  const rY = b.y - a.y;
  const sX = d.x - c.x;
  const sY = d.y - c.y;
  const den = rX * sY - rY * sX;
  if (Math.abs(den) < 1e-12) return null;
  const qX = c.x - a.x;
  const qY = c.y - a.y;
  const t = (qX * sY - qY * sX) / den;
  const u = (qX * rY - qY * rX) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a.x + t * rX, y: a.y + t * rY };
}

const ENDPOINT_EPS_PX = 0.5;

/** Crossing in the interiors — not a shared endpoint / T-junction. */
export function segmentInteriorIntersection(a: Point, b: Point, c: Point, d: Point): Point | null {
  const p = segmentIntersection(a, b, c, d);
  if (!p) return null;
  if (
    dist(p, a) <= ENDPOINT_EPS_PX ||
    dist(p, b) <= ENDPOINT_EPS_PX ||
    dist(p, c) <= ENDPOINT_EPS_PX ||
    dist(p, d) <= ENDPOINT_EPS_PX
  ) {
    return null;
  }
  return p;
}

/** Axis-aligned AABB overlap (inclusive). */
export function aabbOverlap(
  a: { minX: number; minY: number; maxX: number; maxY: number },
  b: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  return !(a.maxX < b.minX || a.maxY < b.minY || a.minX > b.maxX || a.minY > b.maxY);
}

export function segmentAabb(seg: Segment): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  return { minX: seg.minX, minY: seg.minY, maxX: seg.maxX, maxY: seg.maxY };
}

export function quantize(v: number, step: number): number {
  if (!(step > 0)) return v;
  return Math.round(v / step) * step;
}
