/** Normalized [0,1] page-fraction rectangle (top-left origin, y-down). */
export type BlackoutRegion = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

/** Pre-rasterize blackouts for one 1-based PDF page. */
export type PageBlackout = {
  page: number;
  regions: BlackoutRegion[];
};

/** Convert a pixel rect on a page preview into normalized [0,1] fractions. */
export function normalizeRegion(
  rect: { x1: number; y1: number; x2: number; y2: number },
  width: number,
  height: number,
): BlackoutRegion | null {
  if (!(width > 0 && height > 0)) return null;
  const x1 = Math.min(rect.x1, rect.x2) / width;
  const y1 = Math.min(rect.y1, rect.y2) / height;
  const x2 = Math.max(rect.x1, rect.x2) / width;
  const y2 = Math.max(rect.y1, rect.y2) / height;
  if (!(x2 > x1 && y2 > y1)) return null;
  const clamped: BlackoutRegion = {
    x1: Math.max(0, Math.min(1, x1)),
    y1: Math.max(0, Math.min(1, y1)),
    x2: Math.max(0, Math.min(1, x2)),
    y2: Math.max(0, Math.min(1, y2)),
  };
  if (!(clamped.x2 > clamped.x1 && clamped.y2 > clamped.y1)) return null;
  return clamped;
}

/** Translate a region in normalized page space, keeping it on the sheet. */
export function translateRegion(r: BlackoutRegion, dx: number, dy: number): BlackoutRegion {
  const w = r.x2 - r.x1;
  const h = r.y2 - r.y1;
  let x1 = r.x1 + dx;
  let y1 = r.y1 + dy;
  if (x1 < 0) x1 = 0;
  if (y1 < 0) y1 = 0;
  if (x1 + w > 1) x1 = 1 - w;
  if (y1 + h > 1) y1 = 1 - h;
  return { x1, y1, x2: x1 + w, y2: y1 + h };
}

export function regionToRect(r: BlackoutRegion, width: number, height: number): {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
} {
  return {
    x1: r.x1 * width,
    y1: r.y1 * height,
    x2: r.x2 * width,
    y2: r.y2 * height,
  };
}

/** Top-most blackout under a point in image pixels, or -1. */
export function hitRegionIndex(
  p: { x: number; y: number },
  regions: BlackoutRegion[],
  width: number,
  height: number,
): number {
  for (let i = regions.length - 1; i >= 0; i--) {
    const r = regions[i]!;
    const x1 = r.x1 * width;
    const y1 = r.y1 * height;
    const x2 = r.x2 * width;
    const y2 = r.y2 * height;
    if (p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2) return i;
  }
  return -1;
}

/** Drop empty pages; keep only pages in `selectedPages` (order preserved). */
export function compactPageBlackouts(
  blackouts: PageBlackout[],
  selectedPages: number[],
): PageBlackout[] {
  const selected = new Set(selectedPages);
  const byPage = new Map<number, BlackoutRegion[]>();
  for (const entry of blackouts) {
    if (!selected.has(entry.page) || !entry.regions.length) continue;
    byPage.set(entry.page, entry.regions);
  }
  return selectedPages
    .filter((p) => byPage.has(p))
    .map((page) => ({ page, regions: byPage.get(page)! }));
}
