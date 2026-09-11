/** Snap mode candidate generators (PNG space). */

import { dist, nearestOnSegment, segmentIntersection, unitDir } from "./math";
import { isSegmentAllowed } from "./lock";
import { queryEndpointIds, querySegmentIds } from "./spatial";
import type {
  GeometryIndex,
  LockState,
  Point,
  Segment,
  SnapHit,
  SnapMode,
} from "./types";

const INTERSECTION_PAIR_CAP = 400;

function hitBase(
  mode: SnapMode,
  point: Point,
  cursor: Point,
  zoom: number,
  extra: Partial<SnapHit> = {},
): SnapHit {
  const distPx = dist(cursor, point);
  return {
    mode,
    point,
    distPx,
    screenDistPx: distPx * zoom,
    ...extra,
  };
}

function bestOf(hits: SnapHit[]): SnapHit | null {
  if (hits.length === 0) return null;
  hits.sort((a, b) => {
    if (a.distPx !== b.distPx) return a.distPx - b.distPx;
    // Prefer shorter segments when distances tie.
    return 0;
  });
  return hits[0]!;
}

function segmentsNear(
  index: GeometryIndex,
  cursor: Point,
  radiusPx: number,
  lock: LockState,
): Segment[] {
  const locked = lock.kind === "segment" ? lock.segmentId : null;
  if (locked) {
    const seg = index.segmentById.get(locked);
    return seg ? [seg] : [];
  }
  const ids = querySegmentIds(index.spatial, cursor.x, cursor.y, radiusPx);
  const out: Segment[] = [];
  for (const id of ids) {
    const seg = index.segmentById.get(id);
    if (seg) out.push(seg);
  }
  return out;
}

export function collectEndpointHits(
  index: GeometryIndex,
  cursor: Point,
  radiusPx: number,
  zoom: number,
  lock: LockState,
): SnapHit[] {
  const hits: SnapHit[] = [];
  // Overlay ticks (isolated PDF crosses/dots) sit on exact PNG coords and
  // must compete with line endpoints, not be skipped.
  if (lock.kind !== "segment") {
    for (const p of index.dots ?? []) {
      const d = dist(cursor, p);
      if (d > radiusPx) continue;
      hits.push(hitBase("endpoint", p, cursor, zoom));
    }
  }
  const ids = queryEndpointIds(index.spatial, cursor.x, cursor.y, radiusPx);
  for (const id of ids) {
    const ep = index.spatial.endpointsById.get(id);
    if (!ep) continue;
    // When locked, only endpoints that belong to the locked segment.
    if (lock.kind === "segment") {
      if (!ep.segmentIds.includes(lock.segmentId)) continue;
    }
    const d = dist(cursor, ep.p);
    if (d > radiusPx) continue;
    const segmentId = ep.segmentIds[0];
    hits.push(
      hitBase("endpoint", ep.p, cursor, zoom, {
        endpointId: ep.id,
        segmentId,
        guide: segmentId
          ? (() => {
              const seg = index.segmentById.get(segmentId);
              return seg ? { kind: "segment" as const, a: seg.a, b: seg.b } : undefined;
            })()
          : undefined,
      }),
    );
  }
  return hits;
}

export function collectMidpointHits(
  index: GeometryIndex,
  cursor: Point,
  radiusPx: number,
  zoom: number,
  lock: LockState,
): SnapHit[] {
  const hits: SnapHit[] = [];
  for (const seg of segmentsNear(index, cursor, radiusPx, lock)) {
    if (!isSegmentAllowed(lock, seg.id)) continue;
    const d = dist(cursor, seg.mid);
    if (d > radiusPx) continue;
    hits.push(
      hitBase("midpoint", seg.mid, cursor, zoom, {
        segmentId: seg.id,
        guide: { kind: "midpoint", a: seg.a, b: seg.b },
      }),
    );
  }
  return hits;
}

export function collectNearestHits(
  index: GeometryIndex,
  cursor: Point,
  radiusPx: number,
  zoom: number,
  lock: LockState,
): SnapHit[] {
  const hits: SnapHit[] = [];
  for (const seg of segmentsNear(index, cursor, radiusPx, lock)) {
    if (!isSegmentAllowed(lock, seg.id)) continue;
    const { point } = nearestOnSegment(cursor, seg.a, seg.b);
    const d = dist(cursor, point);
    if (d > radiusPx) continue;
    hits.push(
      hitBase("nearest", point, cursor, zoom, {
        segmentId: seg.id,
        guide: { kind: "segment", a: seg.a, b: seg.b },
      }),
    );
  }
  return hits;
}

export function collectIntersectionHits(
  index: GeometryIndex,
  cursor: Point,
  radiusPx: number,
  zoom: number,
  lock: LockState,
): SnapHit[] {
  const nearby = segmentsNear(index, cursor, radiusPx * 1.5, { kind: "none" });
  const hits: SnapHit[] = [];
  let pairs = 0;

  const lockedId = lock.kind === "segment" ? lock.segmentId : null;
  const primary = lockedId
    ? nearby.filter((s) => s.id === lockedId)
    : nearby;

  for (let i = 0; i < primary.length; i += 1) {
    const a = primary[i]!;
    const others = lockedId ? nearby.filter((s) => s.id !== lockedId) : nearby.slice(i + 1);
    for (const b of others) {
      if (pairs >= INTERSECTION_PAIR_CAP) break;
      pairs += 1;
      const p = segmentIntersection(a.a, a.b, b.a, b.b);
      if (!p) continue;
      const d = dist(cursor, p);
      if (d > radiusPx) continue;
      if (lockedId && a.id !== lockedId && b.id !== lockedId) continue;
      hits.push(
        hitBase("intersection", p, cursor, zoom, {
          segmentId: lockedId ?? a.id,
          segmentIdB: b.id === (lockedId ?? a.id) ? a.id : b.id,
          guide: { kind: "segment", a: a.a, b: a.b },
        }),
      );
    }
    if (pairs >= INTERSECTION_PAIR_CAP) break;
  }
  return hits;
}

export function collectPerpendicularHits(
  index: GeometryIndex,
  cursor: Point,
  radiusPx: number,
  zoom: number,
  lock: LockState,
  p1: Point,
): SnapHit[] {
  const hits: SnapHit[] = [];
  for (const seg of segmentsNear(index, cursor, radiusPx, lock)) {
    if (!isSegmentAllowed(lock, seg.id)) continue;
    const { point: foot } = nearestOnSegment(p1, seg.a, seg.b);
    const d = dist(cursor, foot);
    if (d > radiusPx) continue;
    hits.push(
      hitBase("perpendicular", foot, cursor, zoom, {
        segmentId: seg.id,
        guide: { kind: "perp", from: p1, to: foot },
      }),
    );
  }
  return hits;
}

export function collectOrthoHits(
  cursor: Point,
  radiusPx: number,
  zoom: number,
  lock: LockState,
  p1: Point,
  index: GeometryIndex,
): SnapHit[] {
  const candidates: { point: Point; axis: "h" | "v" }[] = [
    { point: { x: cursor.x, y: p1.y }, axis: "h" },
    { point: { x: p1.x, y: cursor.y }, axis: "v" },
  ];
  const hits: SnapHit[] = [];
  for (const c of candidates) {
    let point = c.point;
    let segmentId: string | undefined;
    if (lock.kind === "segment") {
      const seg = index.segmentById.get(lock.segmentId);
      if (!seg) continue;
      const projected = nearestOnSegment(c.point, seg.a, seg.b);
      point = projected.point;
      segmentId = seg.id;
    }
    const d = dist(cursor, point);
    if (d > radiusPx) continue;
    hits.push(
      hitBase("ortho", point, cursor, zoom, {
        segmentId,
        guide: { kind: "ortho", axis: c.axis, through: p1 },
      }),
    );
  }
  return hits;
}

export function collectParallelHits(
  index: GeometryIndex,
  cursor: Point,
  radiusPx: number,
  zoom: number,
  lock: LockState,
  p1: Point,
): SnapHit[] {
  // Reference direction: locked segment, else nearest segment to cursor.
  let ref: Segment | null = null;
  if (lock.kind === "segment") {
    ref = index.segmentById.get(lock.segmentId) ?? null;
  } else {
    const near = segmentsNear(index, cursor, radiusPx * 2, { kind: "none" });
    let bestD = Infinity;
    for (const seg of near) {
      const { point } = nearestOnSegment(cursor, seg.a, seg.b);
      const d = dist(cursor, point);
      if (d < bestD) {
        bestD = d;
        ref = seg;
      }
    }
  }
  if (!ref) return [];
  const dir = unitDir(ref.a, ref.b);
  if (!dir) return [];

  // Project cursor onto line through p1 parallel to ref.
  const vx = cursor.x - p1.x;
  const vy = cursor.y - p1.y;
  const t = vx * dir.x + vy * dir.y;
  let point: Point = { x: p1.x + t * dir.x, y: p1.y + t * dir.y };

  if (lock.kind === "segment") {
    const seg = index.segmentById.get(lock.segmentId);
    if (seg) {
      const projected = nearestOnSegment(point, seg.a, seg.b);
      point = projected.point;
    }
  }

  const d = dist(cursor, point);
  if (d > radiusPx) return [];
  return [
    hitBase("parallel", point, cursor, zoom, {
      segmentId: ref.id,
      guide: { kind: "parallel", through: p1, dir },
    }),
  ];
}

export function collectModeHits(
  mode: SnapMode,
  index: GeometryIndex,
  cursor: Point,
  radiusPx: number,
  zoom: number,
  lock: LockState,
  p1: Point | undefined,
): SnapHit[] {
  switch (mode) {
    case "endpoint":
      return collectEndpointHits(index, cursor, radiusPx, zoom, lock);
    case "midpoint":
      return collectMidpointHits(index, cursor, radiusPx, zoom, lock);
    case "nearest":
      return collectNearestHits(index, cursor, radiusPx, zoom, lock);
    case "intersection":
      return collectIntersectionHits(index, cursor, radiusPx, zoom, lock);
    case "perpendicular":
      return p1 ? collectPerpendicularHits(index, cursor, radiusPx, zoom, lock, p1) : [];
    case "ortho":
      return p1 ? collectOrthoHits(cursor, radiusPx, zoom, lock, p1, index) : [];
    case "parallel":
      return p1 ? collectParallelHits(index, cursor, radiusPx, zoom, lock, p1) : [];
    default:
      return [];
  }
}

export { bestOf };
