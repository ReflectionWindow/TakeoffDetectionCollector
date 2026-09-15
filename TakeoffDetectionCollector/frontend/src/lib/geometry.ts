export const MIN_BOX_SIZE = 4;
export const DRAW_MIN_SCREEN_PX = 8;

export type Rect = { x1: number; y1: number; x2: number; y2: number };
export type ResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export function isDrawGesture(
  originX: number,
  originY: number,
  currentX: number,
  currentY: number,
  zoom: number,
  minScreenPx: number = DRAW_MIN_SCREEN_PX,
): boolean {
  const z = Math.max(zoom, 1e-6);
  return Math.abs(currentX - originX) * z >= minScreenPx && Math.abs(currentY - originY) * z >= minScreenPx;
}

export function normalizeRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return {
    x1: Math.min(x1, x2),
    y1: Math.min(y1, y2),
    x2: Math.max(x1, x2),
    y2: Math.max(y1, y2),
  };
}

export function clampRect(rect: Rect, imageWidth: number, imageHeight: number, minSize = MIN_BOX_SIZE): Rect {
  const w = Math.max(minSize, imageWidth);
  const h = Math.max(minSize, imageHeight);
  const minEdge = Math.min(minSize, w, h);
  let { x1, y1, x2, y2 } = normalizeRect(rect.x1, rect.y1, rect.x2, rect.y2);
  x1 = Math.max(0, Math.min(x1, w - minEdge));
  y1 = Math.max(0, Math.min(y1, h - minEdge));
  x2 = Math.max(x1 + minEdge, Math.min(x2, w));
  y2 = Math.max(y1 + minEdge, Math.min(y2, h));
  return { x1, y1, x2, y2 };
}

export function resizeRect(
  rect: Rect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  imageWidth: number,
  imageHeight: number,
): Rect {
  const maxX = Math.max(0, imageWidth);
  const maxY = Math.max(0, imageHeight);
  const minX = Math.min(MIN_BOX_SIZE, maxX);
  const minY = Math.min(MIN_BOX_SIZE, maxY);
  let { x1, y1, x2, y2 } = normalizeRect(rect.x1, rect.y1, rect.x2, rect.y2);
  if (handle.includes("e")) x2 = Math.min(maxX, Math.max(x1 + minX, x2 + dx));
  if (handle.includes("w")) x1 = Math.max(0, Math.min(x2 - minX, x1 + dx));
  if (handle.includes("s")) y2 = Math.min(maxY, Math.max(y1 + minY, y2 + dy));
  if (handle.includes("n")) y1 = Math.max(0, Math.min(y2 - minY, y1 + dy));
  return { x1, y1, x2, y2 };
}

export function resizeHandleAtPoint(
  point: { x: number; y: number },
  bounds: Rect,
  zoom: number,
  screenHitPx: number,
): ResizeHandle | null {
  const z = Math.max(zoom, 1e-6);
  const t = screenHitPx / 2 / z;
  const { x1, y1, x2, y2 } = normalizeRect(bounds.x1, bounds.y1, bounds.x2, bounds.y2);
  const distW = Math.abs(point.x - x1);
  const distE = Math.abs(point.x - x2);
  const distN = Math.abs(point.y - y1);
  const distS = Math.abs(point.y - y2);
  const inY = point.y >= y1 - t && point.y <= y2 + t;
  const inX = point.x >= x1 - t && point.x <= x2 + t;
  const nearW = inY && distW <= t;
  const nearE = inY && distE <= t;
  const nearN = inX && distN <= t;
  const nearS = inX && distS <= t;
  if (nearN && nearW) return "nw";
  if (nearN && nearE) return "ne";
  if (nearS && nearW) return "sw";
  if (nearS && nearE) return "se";
  if (nearN) return "n";
  if (nearS) return "s";
  if (nearW) return "w";
  if (nearE) return "e";
  return null;
}

export function pointInRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  const A = normalizeRect(a.x1, a.y1, a.x2, a.y2);
  const B = normalizeRect(b.x1, b.y1, b.x2, b.y2);
  return A.x1 < B.x2 && A.x2 > B.x1 && A.y1 < B.y2 && A.y2 > B.y1;
}

export function boxesInRect<T extends { box_id: string; x1: number; y1: number; x2: number; y2: number }>(
  boxes: T[],
  rect: Rect,
): string[] {
  return boxes.filter((b) => rectsOverlap(rect, b)).map((b) => b.box_id);
}

export const MARQUEE_DRAG_PX = 8;

export function isMarqueeGesture(dx: number, dy: number, zoom: number, minScreenPx = MARQUEE_DRAG_PX): boolean {
  return Math.hypot(dx, dy) * Math.max(zoom, 1e-6) >= minScreenPx;
}

export function applyMarqueeSelection(baseIds: string[], hitIds: string[], additive: boolean): string[] {
  if (!additive) return hitIds;
  return [...new Set([...baseIds, ...hitIds])];
}

export type PolyPoint = { x: number; y: number };

export function polygonAABB(points: PolyPoint[]): Rect {
  if (points.length === 0) return { x1: 0, y1: 0, x2: 0, y2: 0 };
  let x1 = points[0]!.x;
  let y1 = points[0]!.y;
  let x2 = x1;
  let y2 = y1;
  for (const p of points) {
    if (p.x < x1) x1 = p.x;
    if (p.y < y1) y1 = p.y;
    if (p.x > x2) x2 = p.x;
    if (p.y > y2) y2 = p.y;
  }
  return { x1, y1, x2, y2 };
}

export function quadFromRect(r: Rect): PolyPoint[] {
  const n = normalizeRect(r.x1, r.y1, r.x2, r.y2);
  return [
    { x: n.x1, y: n.y1 },
    { x: n.x2, y: n.y1 },
    { x: n.x2, y: n.y2 },
    { x: n.x1, y: n.y2 },
  ];
}

export function pointsOf(box: { points?: PolyPoint[]; x1: number; y1: number; x2: number; y2: number }): PolyPoint[] {
  if (box.points && box.points.length >= 3) return box.points;
  return quadFromRect(box);
}

export function withAABB<T extends { points?: PolyPoint[]; x1: number; y1: number; x2: number; y2: number }>(
  box: T,
  points: PolyPoint[],
): T {
  return { ...box, points, ...polygonAABB(points) };
}

export function pointInPolygon(x: number, y: number, points: PolyPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i]!.x;
    const yi = points[i]!.y;
    const xj = points[j]!.x;
    const yj = points[j]!.y;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function distToSegment(p: PolyPoint, a: PolyPoint, b: PolyPoint): { dist: number; t: number; point: PolyPoint } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 <= 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const point = { x: a.x + t * dx, y: a.y + t * dy };
  return { dist: Math.hypot(p.x - point.x, p.y - point.y), t, point };
}

export function nearestVertex(p: PolyPoint, points: PolyPoint[], maxDist: number): number {
  let best = -1;
  let bestD = maxDist;
  for (let i = 0; i < points.length; i++) {
    const d = Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export function nearestEdge(p: PolyPoint, points: PolyPoint[], maxDist: number): number {
  let best = -1;
  let bestD = maxDist;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const { dist } = distToSegment(p, a, b);
    if (dist <= bestD) {
      bestD = dist;
      best = i;
    }
  }
  return best;
}

/** Minimum vertices a shape can keep and still enclose an area. */
export const MIN_POLY_POINTS = 3;

/**
 * Handles shown on the midpoint of every edge. Dragging one splits that edge,
 * which is how an imported 4-corner box becomes a real polygon.
 */
export function edgeMidpoints(points: PolyPoint[]): PolyPoint[] {
  return points.map((a, i) => {
    const b = points[(i + 1) % points.length]!;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  });
}

export function nearestMidpoint(p: PolyPoint, points: PolyPoint[], maxDist: number): number {
  return nearestVertex(p, edgeMidpoints(points), maxDist);
}

/** Splits edge `edgeIndex` by inserting `at`, which becomes vertex edgeIndex+1. */
export function insertVertex(points: PolyPoint[], edgeIndex: number, at: PolyPoint): PolyPoint[] {
  if (edgeIndex < 0 || edgeIndex >= points.length) return points;
  const next = points.slice();
  next.splice(edgeIndex + 1, 0, at);
  return next;
}

/** Drops a vertex, refusing to go below a closed shape's minimum. */
export function removeVertex(points: PolyPoint[], index: number): PolyPoint[] {
  if (index < 0 || index >= points.length) return points;
  if (points.length <= MIN_POLY_POINTS) return points;
  const next = points.slice();
  next.splice(index, 1);
  return next;
}

/** Pixel slack for Bluebeam's hundredths-of-a-point rectangle vertices. */
export const NEAR_AXIS_PX = 1.5;

/** True when every edge is horizontal or vertical within `epsilon`. */
export function isRectangle(points: PolyPoint[], epsilon = 0.01): boolean {
  if (points.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % 4]!;
    const sameX = Math.abs(a.x - b.x) <= epsilon;
    const sameY = Math.abs(a.y - b.y) <= epsilon;
    if (!sameX && !sameY) return false;
  }
  return true;
}
