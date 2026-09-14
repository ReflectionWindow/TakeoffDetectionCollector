/**
 * 1D edge snap: pull axis-aligned box borders onto nearby PDF linework.
 *
 * Point-snap (`querySnap`) is for calibrate clicks. Box borders need a parallel
 * segment, a perpendicular band, and enough along-edge overlap.
 */

import type { Box } from "../../api/types";
import {
  MIN_BOX_SIZE,
  isRectangle,
  NEAR_AXIS_PX,
  pointsOf,
  polygonAABB,
  quadFromRect,
  withAABB,
  type Rect,
  type ResizeHandle,
} from "../geometry";
import { dist } from "./math";
import { queryEndpointIds, querySegmentIdsInAabb } from "./spatial";
import type { GeometryIndex, Point, Segment, SegmentId, SnapGuide, SnapHit } from "./types";

/** ~8° — diagonals / leaders / leftover hatch do not pull AABB borders. */
export const AXIS_ALIGN_MAX_SIN = Math.sin((8 * Math.PI) / 180);
export const MIN_OVERLAP_FRACTION = 0.5;
/** Absolute floor so a 4 px tick cannot steal a long opening edge. */
export const MIN_OVERLAP_PX = 6;
/** Auto-correct band in PNG / image px (one-shot, zoom does not apply). */
export const AUTO_SNAP_BAND_PX = 10;
/**
 * Ignore sheet-length grids when auto-correcting a window-sized box.
 * A 3-storey column line is ~10× a typical opening edge.
 */
export const AUTO_SNAP_MAX_SEG_TO_EDGE = 3;
/** Treat lines this close as one fat stroke; prefer the inward ink edge. */
export const AUTO_SNAP_PAIR_PX = 2.5;
/** Drag magnet in screen CSS px. Compared as `imageDist * zoom <= this`. */
export const EDGE_SNAP_CAPTURE_PX = 10;
export const EDGE_SNAP_RELEASE_PX = 13;
export const TINY_BOX_MIN_SIDE_PX = AUTO_SNAP_BAND_PX + MIN_BOX_SIZE;

export type BoxEdge = "w" | "e" | "n" | "s";

export type EdgeSnapHit = {
  edge: BoxEdge;
  /** Snapped x (w/e) or y (n/s) in PNG px. */
  coord: number;
  distPx: number;
  overlapPx: number;
  outward: boolean;
  segmentId: SegmentId;
  segment: Segment;
  point: { x: number; y: number };
  guide: SnapGuide;
};

export type EdgeLock = {
  edge: BoxEdge;
  segmentId: SegmentId;
};

export type MoveLock = {
  v: EdgeLock | null;
  h: EdgeLock | null;
};

export function emptyMoveLock(): MoveLock {
  return { v: null, h: null };
}

export function edgesForHandle(handle: ResizeHandle): BoxEdge[] {
  const edges: BoxEdge[] = [];
  if (handle.includes("w")) edges.push("w");
  if (handle.includes("e")) edges.push("e");
  if (handle.includes("n")) edges.push("n");
  if (handle.includes("s")) edges.push("s");
  return edges;
}

export function edgeHitToSnapHit(hit: EdgeSnapHit, zoom: number): SnapHit {
  const z = zoom > 1e-9 ? zoom : 1e-9;
  return {
    mode: "nearest",
    point: hit.point,
    distPx: hit.distPx,
    screenDistPx: hit.distPx * z,
    segmentId: hit.segmentId,
    guide: hit.guide,
  };
}

type Axis = "x" | "y";

function axisOfSegment(seg: Segment): Axis | null {
  const dx = Math.abs(seg.b.x - seg.a.x);
  const dy = Math.abs(seg.b.y - seg.a.y);
  const len = seg.length;
  if (!(len > 0)) return null;
  if (dx / len <= AXIS_ALIGN_MAX_SIN) return "x";
  if (dy / len <= AXIS_ALIGN_MAX_SIN) return "y";
  return null;
}

function edgeAxis(edge: BoxEdge): Axis {
  return edge === "w" || edge === "e" ? "x" : "y";
}

function edgeCoord(rect: Rect, edge: BoxEdge): number {
  if (edge === "w") return rect.x1;
  if (edge === "e") return rect.x2;
  if (edge === "n") return rect.y1;
  return rect.y2;
}

function edgeSpan(rect: Rect, edge: BoxEdge): { a: number; b: number; length: number } {
  if (edge === "w" || edge === "e") {
    return { a: rect.y1, b: rect.y2, length: Math.max(0, rect.y2 - rect.y1) };
  }
  return { a: rect.x1, b: rect.x2, length: Math.max(0, rect.x2 - rect.x1) };
}

function intervalOverlap(a0: number, a1: number, b0: number, b1: number): number {
  const lo = Math.max(Math.min(a0, a1), Math.min(b0, b1));
  const hi = Math.min(Math.max(a0, a1), Math.max(b0, b1));
  return Math.max(0, hi - lo);
}

function intervalMid(a0: number, a1: number, b0: number, b1: number): number {
  const lo = Math.max(Math.min(a0, a1), Math.min(b0, b1));
  const hi = Math.min(Math.max(a0, a1), Math.max(b0, b1));
  return (lo + hi) / 2;
}

/** Coordinate of a near-axis segment at `along` on the parallel axis. */
export function coordOnSegment(seg: Segment, axis: Axis, along: number): number {
  if (axis === "x") {
    const dy = seg.b.y - seg.a.y;
    if (Math.abs(dy) < 1e-9) return (seg.a.x + seg.b.x) / 2;
    const t = Math.min(1, Math.max(0, (along - seg.a.y) / dy));
    return seg.a.x + t * (seg.b.x - seg.a.x);
  }
  const dx = seg.b.x - seg.a.x;
  if (Math.abs(dx) < 1e-9) return (seg.a.y + seg.b.y) / 2;
  const t = Math.min(1, Math.max(0, (along - seg.a.x) / dx));
  return seg.a.y + t * (seg.b.y - seg.a.y);
}

function segmentAlongSpan(seg: Segment, axis: Axis): { a: number; b: number; length: number } {
  if (axis === "x") {
    return { a: seg.minY, b: seg.maxY, length: Math.max(0, seg.maxY - seg.minY) };
  }
  return { a: seg.minX, b: seg.maxX, length: Math.max(0, seg.maxX - seg.minX) };
}

function isOutward(edge: BoxEdge, from: number, to: number): boolean {
  if (edge === "w" || edge === "n") return to < from - 1e-6;
  return to > from + 1e-6;
}

function wouldCollapse(
  rect: Rect,
  edge: BoxEdge,
  coord: number,
  minSize: number,
): boolean {
  if (edge === "w") return rect.x2 - coord < minSize;
  if (edge === "e") return coord - rect.x1 < minSize;
  if (edge === "n") return rect.y2 - coord < minSize;
  return coord - rect.y1 < minSize;
}

/** Closest perpendicular distance wins; overlap breaks a true tie. */
function preferHit(a: EdgeSnapHit, b: EdgeSnapHit): EdgeSnapHit {
  if (a.distPx + 1e-6 < b.distPx) return a;
  if (b.distPx + 1e-6 < a.distPx) return b;
  return a.overlapPx >= b.overlapPx ? a : b;
}

function pickClosest(candidates: EdgeSnapHit[]): EdgeSnapHit | null {
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  for (let i = 1; i < candidates.length; i += 1) {
    best = preferHit(best, candidates[i]!);
  }
  return best;
}

function inwardRank(hit: EdgeSnapHit): number {
  if (hit.outward) return 0;
  if (hit.distPx < 1e-6) return 1;
  return 2;
}

/** Closest line, but a slightly inward fat-stroke edge wins over the outer ink. */
function preferAutoHit(a: EdgeSnapHit, b: EdgeSnapHit): EdgeSnapHit {
  if (Math.abs(a.distPx - b.distPx) > AUTO_SNAP_PAIR_PX + 1e-6) {
    return preferHit(a, b);
  }
  const ra = inwardRank(a);
  const rb = inwardRank(b);
  if (ra !== rb) return ra > rb ? a : b;
  return preferHit(a, b);
}

function pickAutoCorrect(candidates: EdgeSnapHit[]): EdgeSnapHit | null {
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  for (let i = 1; i < candidates.length; i += 1) {
    best = preferAutoHit(best, candidates[i]!);
  }
  return best;
}

function makeHit(
  rect: Rect,
  edge: BoxEdge,
  seg: Segment,
  coord: number,
  overlapPx: number,
): EdgeSnapHit {
  const current = edgeCoord(rect, edge);
  const span = edgeSpan(rect, edge);
  const along = intervalMid(span.a, span.b, ...spanTuple(seg, edgeAxis(edge)));
  const point =
    edgeAxis(edge) === "x" ? { x: coord, y: along } : { x: along, y: coord };
  return {
    edge,
    coord,
    distPx: Math.abs(coord - current),
    overlapPx,
    outward: isOutward(edge, current, coord),
    segmentId: seg.id,
    segment: seg,
    point,
    guide: { kind: "segment", a: seg.a, b: seg.b },
  };
}

function spanTuple(seg: Segment, axis: Axis): [number, number] {
  const span = segmentAlongSpan(seg, axis);
  return [span.a, span.b];
}

function bandAabb(rect: Rect, edge: BoxEdge, radiusPx: number) {
  if (edge === "w" || edge === "e") {
    const x = edgeCoord(rect, edge);
    return {
      minX: x - radiusPx,
      maxX: x + radiusPx,
      minY: rect.y1,
      maxY: rect.y2,
    };
  }
  const y = edgeCoord(rect, edge);
  return {
    minX: rect.x1,
    maxX: rect.x2,
    minY: y - radiusPx,
    maxY: y + radiusPx,
  };
}

type HitOpts = {
  minSize: number;
  minOverlapFraction: number;
  minOverlapPx: number;
  /** Skip segments longer than this × the box edge (grids). */
  maxSegToEdge?: number;
};

function defaultHitOpts(minSize?: number): HitOpts {
  return {
    minSize: minSize ?? MIN_BOX_SIZE,
    minOverlapFraction: MIN_OVERLAP_FRACTION,
    minOverlapPx: MIN_OVERLAP_PX,
  };
}

function hitFromSegment(
  rect: Rect,
  edge: BoxEdge,
  seg: Segment,
  radiusPx: number,
  hitOpts: HitOpts,
): EdgeSnapHit | null {
  const axis = edgeAxis(edge);
  if (axisOfSegment(seg) !== axis) return null;
  const span = edgeSpan(rect, edge);
  const segSpan = segmentAlongSpan(seg, axis);
  const overlapPx = intervalOverlap(span.a, span.b, segSpan.a, segSpan.b);
  const need = Math.max(hitOpts.minOverlapPx, hitOpts.minOverlapFraction * span.length);
  if (overlapPx + 1e-6 < need) return null;
  if (
    hitOpts.maxSegToEdge != null &&
    span.length > 0 &&
    seg.length > hitOpts.maxSegToEdge * span.length + 1e-6
  ) {
    return null;
  }
  const along = intervalMid(span.a, span.b, segSpan.a, segSpan.b);
  const coord = coordOnSegment(seg, axis, along);
  const distPx = Math.abs(coord - edgeCoord(rect, edge));
  if (distPx > radiusPx + 1e-6) return null;
  if (wouldCollapse(rect, edge, coord, hitOpts.minSize)) return null;
  return makeHit(rect, edge, seg, coord, overlapPx);
}

/** PNG band for a screen-pixel radius. Zoom only converts space, it is not a scale factor on 10. */
export function screenPxToImage(radiusScreenPx: number, zoom: number): number {
  const z = zoom > 1e-9 ? zoom : 1e-9;
  return radiusScreenPx / z;
}

/**
 * Candidates for one box edge within `radiusPx`. Does not skip other boxes'
 * edges — shared mullions are allowed. Opposite-edge collapse is rejected.
 */
export function queryEdgeCandidates(
  index: GeometryIndex,
  rect: Rect,
  edge: BoxEdge,
  radiusPx: number,
  opts?: {
    minSize?: number;
    minOverlapFraction?: number;
    minOverlapPx?: number;
    maxSegToEdge?: number;
  },
): EdgeSnapHit[] {
  if (!index || index.empty || !(radiusPx > 0)) return [];
  const hitOpts: HitOpts = {
    ...defaultHitOpts(opts?.minSize),
    ...(opts?.minOverlapFraction != null
      ? { minOverlapFraction: opts.minOverlapFraction }
      : {}),
    ...(opts?.minOverlapPx != null ? { minOverlapPx: opts.minOverlapPx } : {}),
    ...(opts?.maxSegToEdge != null ? { maxSegToEdge: opts.maxSegToEdge } : {}),
  };
  const band = bandAabb(rect, edge, radiusPx);
  const ids = querySegmentIdsInAabb(
    index.spatial,
    band.minX,
    band.minY,
    band.maxX,
    band.maxY,
  );
  const out: EdgeSnapHit[] = [];
  const seen = new Set<SegmentId>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const seg = index.segmentById.get(id);
    if (!seg) continue;
    const hit = hitFromSegment(rect, edge, seg, radiusPx, hitOpts);
    if (hit) out.push(hit);
  }
  return out;
}

export function queryEdgeSnap(
  index: GeometryIndex,
  rect: Rect,
  edge: BoxEdge,
  radiusPx: number,
  opts?: {
    minSize?: number;
    minOverlapFraction?: number;
    minOverlapPx?: number;
    maxSegToEdge?: number;
  },
): EdgeSnapHit | null {
  return pickClosest(queryEdgeCandidates(index, rect, edge, radiusPx, opts));
}

function resolveLockedHit(
  index: GeometryIndex,
  rect: Rect,
  lock: EdgeLock,
  releaseRadiusPx: number,
  hitOpts: HitOpts,
): EdgeSnapHit | null {
  const seg = index.segmentById.get(lock.segmentId);
  if (!seg) return null;
  return hitFromSegment(rect, lock.edge, seg, releaseRadiusPx, hitOpts);
}

function applyEdgeCoords(
  rect: Rect,
  assigned: Partial<Record<BoxEdge, number>>,
  minSize: number,
): Rect {
  let { x1, y1, x2, y2 } = rect;
  const w = assigned.w;
  const e = assigned.e;
  if (w != null && e != null) {
    if (e - w >= minSize) {
      x1 = w;
      x2 = e;
    } else {
      // Keep the stronger magnet (closer to its current edge).
      const wDist = Math.abs(w - rect.x1);
      const eDist = Math.abs(e - rect.x2);
      if (wDist <= eDist) x1 = Math.min(w, x2 - minSize);
      else x2 = Math.max(e, x1 + minSize);
    }
  } else if (w != null) {
    x1 = Math.min(w, x2 - minSize);
  } else if (e != null) {
    x2 = Math.max(e, x1 + minSize);
  }

  const n = assigned.n;
  const s = assigned.s;
  if (n != null && s != null) {
    if (s - n >= minSize) {
      y1 = n;
      y2 = s;
    } else {
      const nDist = Math.abs(n - rect.y1);
      const sDist = Math.abs(s - rect.y2);
      if (nDist <= sDist) y1 = Math.min(n, y2 - minSize);
      else y2 = Math.max(s, y1 + minSize);
    }
  } else if (n != null) {
    y1 = Math.min(n, y2 - minSize);
  } else if (s != null) {
    y2 = Math.max(s, y1 + minSize);
  }

  return { x1, y1, x2, y2 };
}

function pickMoveAxis(
  index: GeometryIndex,
  rect: Rect,
  a: BoxEdge,
  b: BoxEdge,
  radiusPx: number,
  releaseRadiusPx: number,
  hitOpts: HitOpts,
  prev: EdgeLock | null,
): { hit: EdgeSnapHit | null; lock: EdgeLock | null } {
  if (prev && (prev.edge === a || prev.edge === b)) {
    const held = pickEdgeWithLock(
      index,
      rect,
      prev.edge,
      radiusPx,
      releaseRadiusPx,
      hitOpts,
      prev,
    );
    if (held.hit) return held;
  }
  const q = {
    minSize: hitOpts.minSize,
    minOverlapFraction: hitOpts.minOverlapFraction,
    minOverlapPx: hitOpts.minOverlapPx,
    maxSegToEdge: hitOpts.maxSegToEdge,
  };
  const first = queryEdgeSnap(index, rect, a, radiusPx, q);
  const second = queryEdgeSnap(index, rect, b, radiusPx, q);
  let hit: EdgeSnapHit | null = null;
  if (first && second) hit = first.distPx <= second.distPx ? first : second;
  else hit = first ?? second;
  if (!hit) return { hit: null, lock: null };
  return { hit, lock: { edge: hit.edge, segmentId: hit.segmentId } };
}

function pickEdgeWithLock(
  index: GeometryIndex,
  rect: Rect,
  edge: BoxEdge,
  radiusPx: number,
  releaseRadiusPx: number,
  hitOpts: HitOpts,
  lock: EdgeLock | null,
): { hit: EdgeSnapHit | null; lock: EdgeLock | null } {
  if (lock && lock.edge === edge) {
    const held = resolveLockedHit(index, rect, lock, releaseRadiusPx, hitOpts);
    if (held) return { hit: held, lock };
  }
  const hit = queryEdgeSnap(index, rect, edge, radiusPx, {
    minSize: hitOpts.minSize,
    minOverlapFraction: hitOpts.minOverlapFraction,
    minOverlapPx: hitOpts.minOverlapPx,
    maxSegToEdge: hitOpts.maxSegToEdge,
  });
  if (!hit) return { hit: null, lock: null };
  return { hit, lock: { edge, segmentId: hit.segmentId } };
}

const ALL_EDGES: readonly BoxEdge[] = ["w", "e", "n", "s"];

type SnapOpts = {
  edges?: readonly BoxEdge[];
  locks?: Partial<Record<BoxEdge, EdgeLock>>;
  releaseRadiusPx?: number;
  minSize?: number;
  bypass?: boolean;
  /**
   * When set, `radiusPx` / `releaseRadiusPx` are screen CSS px.
   * A hit must satisfy `imageDist * zoom <= radiusScreen`.
   */
  zoom?: number;
  minOverlapFraction?: number;
  minOverlapPx?: number;
  maxSegToEdge?: number;
};

function resolveRadius(radiusPx: number, zoom: number | undefined): number {
  if (zoom == null) return radiusPx;
  return screenPxToImage(radiusPx, zoom);
}

function resolveHitOpts(opts?: SnapOpts): HitOpts {
  const base = defaultHitOpts(opts?.minSize);
  return {
    minSize: base.minSize,
    minOverlapFraction: opts?.minOverlapFraction ?? base.minOverlapFraction,
    minOverlapPx: opts?.minOverlapPx ?? base.minOverlapPx,
    ...(opts?.maxSegToEdge != null ? { maxSegToEdge: opts.maxSegToEdge } : {}),
  };
}

export function snapRectEdges(
  rect: Rect,
  index: GeometryIndex | null | undefined,
  radiusPx: number,
  opts?: SnapOpts,
): {
  rect: Rect;
  hits: EdgeSnapHit[];
  locks: Partial<Record<BoxEdge, EdgeLock>>;
} {
  if (!index || index.empty || opts?.bypass || !(radiusPx > 0)) {
    return { rect, hits: [], locks: {} };
  }
  const hitOpts = resolveHitOpts(opts);
  const capture = resolveRadius(radiusPx, opts?.zoom);
  const release = resolveRadius(opts?.releaseRadiusPx ?? radiusPx, opts?.zoom);
  const edges = opts?.edges ?? ALL_EDGES;
  const hits: EdgeSnapHit[] = [];
  const locks: Partial<Record<BoxEdge, EdgeLock>> = {};
  const assigned: Partial<Record<BoxEdge, number>> = {};

  for (const edge of edges) {
    const resolved = pickEdgeWithLock(
      index,
      rect,
      edge,
      capture,
      release,
      hitOpts,
      opts?.locks?.[edge] ?? null,
    );
    if (resolved.hit) {
      hits.push(resolved.hit);
      assigned[edge] = resolved.hit.coord;
    }
    if (resolved.lock) locks[edge] = resolved.lock;
  }

  return { rect: applyEdgeCoords(rect, assigned, hitOpts.minSize), hits, locks };
}

export function snapResizeEdges(
  bounds: Rect,
  handle: ResizeHandle,
  index: GeometryIndex | null | undefined,
  radiusPx: number,
  opts?: SnapOpts,
): {
  rect: Rect;
  hits: EdgeSnapHit[];
  locks: Partial<Record<BoxEdge, EdgeLock>>;
} {
  return snapRectEdges(bounds, index, radiusPx, {
    ...opts,
    edges: edgesForHandle(handle),
  });
}

/**
 * Translate a rect so the nearer vertical / horizontal edge magnets, size held.
 * If left and right want different dx, the closer magnet wins.
 */
export function snapMoveRect(
  rect: Rect,
  index: GeometryIndex | null | undefined,
  radiusPx: number,
  opts?: SnapOpts & { lock?: MoveLock | null },
): { rect: Rect; hits: EdgeSnapHit[]; lock: MoveLock } {
  const width = rect.x2 - rect.x1;
  const height = rect.y2 - rect.y1;
  if (!index || index.empty || opts?.bypass || !(radiusPx > 0)) {
    return { rect, hits: [], lock: emptyMoveLock() };
  }
  const hitOpts = resolveHitOpts(opts);
  const capture = resolveRadius(radiusPx, opts?.zoom);
  const release = resolveRadius(opts?.releaseRadiusPx ?? radiusPx, opts?.zoom);
  const prev = opts?.lock ?? emptyMoveLock();

  const vertical = pickMoveAxis(index, rect, "w", "e", capture, release, hitOpts, prev.v);
  const horizontal = pickMoveAxis(index, rect, "n", "s", capture, release, hitOpts, prev.h);

  const dx = vertical.hit
    ? vertical.hit.coord - edgeCoord(rect, vertical.hit.edge)
    : 0;
  const dy = horizontal.hit
    ? horizontal.hit.coord - edgeCoord(rect, horizontal.hit.edge)
    : 0;
  const vLock = vertical.lock;
  const hLock = horizontal.lock;
  const vHit = vertical.hit;
  const hHit = horizontal.hit;

  const hits: EdgeSnapHit[] = [];
  if (vHit) hits.push(vHit);
  if (hHit) hits.push(hHit);

  return {
    rect: {
      x1: rect.x1 + dx,
      y1: rect.y1 + dy,
      x2: rect.x1 + dx + width,
      y2: rect.y1 + dy + height,
    },
    hits,
    lock: { v: vLock, h: hLock },
  };
}

function isModelUnedited(box: Box): boolean {
  return box.origin !== "user" && box.edited !== true;
}

function isTiny(rect: Rect): boolean {
  return (
    rect.x2 - rect.x1 < TINY_BOX_MIN_SIDE_PX || rect.y2 - rect.y1 < TINY_BOX_MIN_SIDE_PX
  );
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x1 === b.x1 && a.y1 === b.y1 && a.x2 === b.x2 && a.y2 === b.y2;
}

/**
 * One-shot auto-correct for detect boxes. Does not set `edited`.
 * Shared mullions are allowed; opposite-edge collapse is not.
 */
export function snapModelBoxes(
  boxes: Box[],
  index: GeometryIndex | null | undefined,
  opts?: { bandPx?: number; minSize?: number },
): { boxes: Box[]; changed: boolean } {
  if (!index || index.empty || boxes.length === 0) {
    return { boxes, changed: false };
  }
  const bandPx = opts?.bandPx ?? AUTO_SNAP_BAND_PX;
  const minSize = opts?.minSize ?? MIN_BOX_SIZE;
  let changed = false;
  const next = boxes.map((box) => {
    if (!isModelUnedited(box) || isTiny(box)) return box;
    const pts = pointsOf(box);
    if (!isRectangle(pts, NEAR_AXIS_PX)) {
      const snapped = snapPolygonVertices(pts, index, bandPx);
      if (samePoints(pts, snapped)) return box;
      changed = true;
      return withAABB(box, snapped);
    }
    const rect = polygonAABB(pts);
    const assigned: Partial<Record<BoxEdge, number>> = {};
    const q = { minSize, maxSegToEdge: AUTO_SNAP_MAX_SEG_TO_EDGE };
    for (const edge of ALL_EDGES) {
      const hit = pickAutoCorrect(queryEdgeCandidates(index, rect, edge, bandPx, q));
      if (hit) assigned[edge] = hit.coord;
    }
    const nextRect = applyEdgeCoords(rect, assigned, minSize);
    const aligned = quadFromRect(nextRect);
    if (sameRect(rect, nextRect) && samePoints(pts, aligned)) return withAABB(box, pts);
    changed = true;
    return withAABB({ ...box, ...nextRect }, aligned);
  });
  return { boxes: next, changed };
}

function samePoints(a: Point[], b: Point[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => p.x === b[i]!.x && p.y === b[i]!.y);
}

function snapPolygonVertices(pts: Point[], index: GeometryIndex, bandPx: number): Point[] {
  return pts.map((p) => {
    const ids = queryEndpointIds(index.spatial, p.x, p.y, bandPx);
    let best: Point | null = null;
    let bestD = bandPx;
    for (const id of ids) {
      const ep = index.spatial.endpointsById.get(id);
      if (!ep) continue;
      const d = dist(p, ep.p);
      if (d <= bestD) {
        bestD = d;
        best = ep.p;
      }
    }
    return best ?? p;
  });
}
