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
