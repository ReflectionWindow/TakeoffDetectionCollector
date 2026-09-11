/** In-memory GeometryIndex cache keyed by job + page + displayed raster size. */

import type { GeometryIndex } from "./types";

const cache = new Map<string, GeometryIndex>();

export function geometryCacheKey(
  jobId: string,
  pageIndex: number,
  imageWidthPx: number,
  imageHeightPx: number,
): string {
  return `${jobId}:${pageIndex}:${imageWidthPx}x${imageHeightPx}:pdfjs-v5`;
}

export function getCachedGeometryIndex(key: string): GeometryIndex | null {
  return cache.get(key) ?? null;
}

export function setCachedGeometryIndex(key: string, index: GeometryIndex): void {
  cache.set(key, index);
}

/** Test / page-nav helper — drop one entry or clear all. */
export function clearGeometryCache(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}
