/** Uniform grid spatial index over segments and endpoints (PNG space). */

import type { Endpoint, EndpointId, Segment, SegmentId, SpatialGrid } from "./types";

export function cellKey(cx: number, cy: number): string {
  return `${cx}:${cy}`;
}

function pushId(map: Map<string, string[]>, key: string, id: string): void {
  const list = map.get(key);
  if (list) list.push(id);
  else map.set(key, [id]);
}

/**
 * Build a grid. Cell size should be ~2–4× typical snap radius in PNG px.
 * Default 32 px works well for R≈10 screen px at zoom 0.5–2.
 */
export function buildSpatialGrid(
  segments: Segment[],
  endpoints: Endpoint[],
  cellSize: number = 32,
): SpatialGrid {
  const size = cellSize > 0 ? cellSize : 32;
  const segmentCells = new Map<string, SegmentId[]>();
  const endpointCells = new Map<string, EndpointId[]>();
  const endpointsById = new Map<EndpointId, Endpoint>();

  for (const seg of segments) {
    const x0 = Math.floor(seg.minX / size);
    const y0 = Math.floor(seg.minY / size);
    const x1 = Math.floor(seg.maxX / size);
    const y1 = Math.floor(seg.maxY / size);
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        pushId(segmentCells, cellKey(cx, cy), seg.id);
      }
    }
  }

  for (const ep of endpoints) {
    endpointsById.set(ep.id, ep);
    const cx = Math.floor(ep.p.x / size);
    const cy = Math.floor(ep.p.y / size);
    pushId(endpointCells, cellKey(cx, cy), ep.id);
  }

  return { cellSize: size, segmentCells, endpointCells, endpointsById };
}

function uniqueIds(ids: string[]): string[] {
  if (ids.length <= 1) return ids;
  return [...new Set(ids)];
}

function querySegmentIdsInCells(
  grid: SpatialGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): SegmentId[] {
  const out: SegmentId[] = [];
  for (let gx = x0; gx <= x1; gx += 1) {
    for (let gy = y0; gy <= y1; gy += 1) {
      const list = grid.segmentCells.get(cellKey(gx, gy));
      if (list) out.push(...list);
    }
  }
  return uniqueIds(out);
}

/** Segment ids whose AABB cells overlap the query disk (AABB of radius). */
export function querySegmentIds(
  grid: SpatialGrid,
  cx: number,
  cy: number,
  radius: number,
): SegmentId[] {
  const size = grid.cellSize;
  return querySegmentIdsInCells(
    grid,
    Math.floor((cx - radius) / size),
    Math.floor((cy - radius) / size),
    Math.floor((cx + radius) / size),
    Math.floor((cy + radius) / size),
  );
}

/** Segment ids whose AABB cells overlap a rectangle (inclusive). */
export function querySegmentIdsInAabb(
  grid: SpatialGrid,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): SegmentId[] {
  const size = grid.cellSize;
  return querySegmentIdsInCells(
    grid,
    Math.floor(minX / size),
    Math.floor(minY / size),
    Math.floor(maxX / size),
    Math.floor(maxY / size),
  );
}

export function queryEndpointIds(
  grid: SpatialGrid,
  cx: number,
  cy: number,
  radius: number,
): EndpointId[] {
  const size = grid.cellSize;
  const x0 = Math.floor((cx - radius) / size);
  const y0 = Math.floor((cy - radius) / size);
  const x1 = Math.floor((cx + radius) / size);
  const y1 = Math.floor((cy + radius) / size);
  const out: EndpointId[] = [];
  for (let gx = x0; gx <= x1; gx += 1) {
    for (let gy = y0; gy <= y1; gy += 1) {
      const list = grid.endpointCells.get(cellKey(gx, gy));
      if (list) out.push(...list);
    }
  }
  return uniqueIds(out);
}
