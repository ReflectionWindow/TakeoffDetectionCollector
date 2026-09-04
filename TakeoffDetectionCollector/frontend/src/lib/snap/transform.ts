/** Anisotropic PDF pt ↔ PNG px transforms for snap bake. */

import type { Point } from "./types";

export type BakeScale = {
  /** PDF pt per PNG px (X). */
  sx: number;
  /** PDF pt per PNG px (Y). */
  sy: number;
};

/**
 * Measured page.rect ÷ raster size — never average axes for snap bake.
 * Returns null when sizes are unusable.
 */
export function bakeScaleFromSizes(input: {
  pageWidthPt: number;
  pageHeightPt: number;
  imageWidthPx: number;
  imageHeightPx: number;
}): BakeScale | null {
  const { pageWidthPt, pageHeightPt, imageWidthPx, imageHeightPx } = input;
  if (
    !(pageWidthPt > 0) ||
    !(pageHeightPt > 0) ||
    !(imageWidthPx > 0) ||
    !(imageHeightPx > 0) ||
    !Number.isFinite(pageWidthPt) ||
    !Number.isFinite(pageHeightPt) ||
    !Number.isFinite(imageWidthPx) ||
    !Number.isFinite(imageHeightPx)
  ) {
    return null;
  }
  return {
    sx: pageWidthPt / imageWidthPx,
    sy: pageHeightPt / imageHeightPx,
  };
}

export function pdfToPng(p: Point, scale: BakeScale): Point {
  return { x: p.x / scale.sx, y: p.y / scale.sy };
}

export function pngToPdf(p: Point, scale: BakeScale): Point {
  return { x: p.x * scale.sx, y: p.y * scale.sy };
}

/** Snap radius in PNG px from screen CSS px + zoom. */
export function radiusPngFromScreen(radiusScreenPx: number, zoom: number): number {
  const z = zoom > 1e-9 ? zoom : 1e-9;
  return radiusScreenPx / z;
}
