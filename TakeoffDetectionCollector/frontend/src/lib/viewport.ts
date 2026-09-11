/**
 * Sheets are rendered well above viewport size, so opening one at zoom 1 lands
 * the corrector in the top-left corner of the page. Every load starts from the
 * whole sheet instead and lets them zoom in from there.
 */

export type Viewport = { zoom: number; panX: number; panY: number };

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 32;
export const FIT_PADDING = 20;

/** Wheel pixels that produce one ~8% zoom step. Larger = less sensitive. */
export const WHEEL_ZOOM_PIXELS = 40;
export const WHEEL_ZOOM_STEP = 1.5;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Scale that shows the whole sheet, centred, with a little breathing room. */
export function fitTransform(
  imageW: number,
  imageH: number,
  viewW: number,
  viewH: number,
  padding = FIT_PADDING,
): Viewport {
  if (imageW <= 0 || imageH <= 0 || viewW <= 0 || viewH <= 0) {
    return { zoom: 1, panX: 0, panY: 0 };
  }
  const usableW = Math.max(1, viewW - padding * 2);
  const usableH = Math.max(1, viewH - padding * 2);
  const zoom = clampZoom(Math.min(usableW / imageW, usableH / imageH));
  return {
    zoom,
    panX: (viewW - imageW * zoom) / 2,
    panY: (viewH - imageH * zoom) / 2,
  };
}

export function normalizeWheelDelta(delta: number, deltaMode = 0): number {
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * 120;
  return delta;
}

/**
 * Multiplicative zoom from a wheel event. Uses delta magnitude so a trackpad
 * pinch (many small pixel ticks) does not leap the way a 10% step-per-event did.
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const dy = Math.max(-120, Math.min(120, normalizeWheelDelta(deltaY, deltaMode)));
  return Math.pow(WHEEL_ZOOM_STEP, -dy / WHEEL_ZOOM_PIXELS);
}

export function panBy(current: Viewport, dx: number, dy: number): Viewport {
  return { ...current, panX: current.panX + dx, panY: current.panY + dy };
}

export type WheelInput = {
  deltaX: number;
  deltaY: number;
  deltaMode?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
};

/** Two-finger / mouse scroll pans. Pinch or Ctrl/⌘+wheel zooms about the cursor. */
export function applyWheel(current: Viewport, e: WheelInput, screenX: number, screenY: number): Viewport {
  const mode = e.deltaMode ?? 0;
  if (e.ctrlKey || e.metaKey) {
    return zoomAbout(current, current.zoom * wheelZoomFactor(e.deltaY, mode), screenX, screenY);
  }
  return panBy(current, -normalizeWheelDelta(e.deltaX, mode), -normalizeWheelDelta(e.deltaY, mode));
}

/** Zoom about a fixed screen point so the sheet does not jump under the cursor. */
export function zoomAbout(
  current: Viewport,
  nextZoom: number,
  screenX: number,
  screenY: number,
): Viewport {
  const zoom = clampZoom(nextZoom);
  const imgX = (screenX - current.panX) / current.zoom;
  const imgY = (screenY - current.panY) / current.zoom;
  return { zoom, panX: screenX - imgX * zoom, panY: screenY - imgY * zoom };
}
