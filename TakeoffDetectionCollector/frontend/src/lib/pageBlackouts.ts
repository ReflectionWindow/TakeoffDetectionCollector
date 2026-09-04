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
