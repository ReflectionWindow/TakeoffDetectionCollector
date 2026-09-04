import type { Geometry, Point, SnapResult } from "../types";

const cellKey = (cx: number, cy: number) => `${cx}:${cy}`;

export class SnapIndex {
  readonly points: [number, number][];
  readonly segments: [number, number][];
  private readonly cellSize: number;
  private readonly pointCells = new Map<string, number[]>();
  private readonly segCells = new Map<string, number[]>();

  constructor(geometry: Geometry, cellSize = 8) {
    this.points = geometry.points;
    this.segments = geometry.segments;
    this.cellSize = cellSize;

    geometry.points.forEach((p, i) => {
      const k = cellKey(Math.floor(p[0] / cellSize), Math.floor(p[1] / cellSize));
      const list = this.pointCells.get(k);
      if (list) list.push(i);
      else this.pointCells.set(k, [i]);
    });

    geometry.segments.forEach((seg, si) => {
      const a = geometry.points[seg[0]];
      const b = geometry.points[seg[1]];
      if (!a || !b) return;
      for (const k of this.segmentCells(a[0], a[1], b[0], b[1])) {
        const list = this.segCells.get(k);
        if (list) list.push(si);
        else this.segCells.set(k, [si]);
      }
    });
  }

  snap(x: number, y: number, radiusPdf: number, orthoFrom?: Point, ortho?: boolean): SnapResult | null {
    let qx = x;
    let qy = y;
    if (ortho && orthoFrom) {
      if (Math.abs(x - orthoFrom.x) >= Math.abs(y - orthoFrom.y)) {
        qx = x;
        qy = orthoFrom.y;
      } else {
        qx = orthoFrom.x;
        qy = y;
      }
    }

    const r2 = radiusPdf * radiusPdf;
    let bestVertex: SnapResult | null = null;
    let bestV = r2;

    for (const i of this.nearbyPointIndices(qx, qy, radiusPdf)) {
      const p = this.points[i];
      const d = (p[0] - qx) ** 2 + (p[1] - qy) ** 2;
      if (d <= bestV) {
        bestV = d;
        bestVertex = { x: p[0], y: p[1], kind: "vertex" };
      }
    }
    if (bestVertex) return bestVertex;

    let bestEdge: SnapResult | null = null;
    let bestE = r2;
    const seen = new Set<number>();
    for (const si of this.nearbySegIndices(qx, qy, radiusPdf)) {
      if (seen.has(si)) continue;
      seen.add(si);
      const seg = this.segments[si];
      const a = this.points[seg[0]];
      const b = this.points[seg[1]];
      const proj = projectOnSegment(qx, qy, a[0], a[1], b[0], b[1]);
      const d = (proj.x - qx) ** 2 + (proj.y - qy) ** 2;
      if (d <= bestE) {
        bestE = d;
        bestEdge = { x: proj.x, y: proj.y, kind: "edge" };
      }
    }
    if (bestEdge) return bestEdge;

    if (ortho && orthoFrom) return { x: qx, y: qy, kind: "edge" };
    return null;
  }

  private nearbyPointIndices(x: number, y: number, radius: number): number[] {
    return this.gather(this.pointCells, x, y, radius);
  }

  private nearbySegIndices(x: number, y: number, radius: number): number[] {
    return this.gather(this.segCells, x, y, radius);
  }

  private gather(map: Map<string, number[]>, x: number, y: number, radius: number): number[] {
    const minX = Math.floor((x - radius) / this.cellSize);
    const maxX = Math.floor((x + radius) / this.cellSize);
    const minY = Math.floor((y - radius) / this.cellSize);
    const maxY = Math.floor((y + radius) / this.cellSize);
    const out: number[] = [];
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        const list = map.get(cellKey(cx, cy));
        if (list) out.push(...list);
      }
    }
    return out;
  }

  private segmentCells(x0: number, y0: number, x1: number, y1: number): string[] {
    const keys: string[] = [];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / this.cellSize));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + dx * t;
      const y = y0 + dy * t;
      keys.push(cellKey(Math.floor(x / this.cellSize), Math.floor(y / this.cellSize)));
    }
    return keys;
  }
}

function projectOnSegment(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Point {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return { x: x0, y: y0 };
  let t = ((px - x0) * dx + (py - y0) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: x0 + t * dx, y: y0 + t * dy };
}

export function dist2(a: Point, b: Point): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
