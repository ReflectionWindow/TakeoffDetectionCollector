import { quadFromRect, type PolyPoint } from "./geometry";

export const IMPORT_DPI = 75;
export const PT_PER_INCH = 72;

export function px75ToPt(px: number): number {
  return (px * PT_PER_INCH) / IMPORT_DPI;
}

export function ptToPx75(pt: number): number {
  return (pt * IMPORT_DPI) / PT_PER_INCH;
}

/** Display space for the canvas: PDF pt mapped onto the displayed pixel size. */
export function ptToDisplay(pt: number, pagePt: number, displayPx: number): number {
  if (!(pagePt > 0)) return pt;
  return (pt / pagePt) * displayPx;
}

export function displayToPt(px: number, pagePt: number, displayPx: number): number {
  if (!(displayPx > 0)) return px;
  return (px / displayPx) * pagePt;
}

/**
 * Stretch a 75-DPI raster coordinate onto the displayed sheet.
 * This does not assume the PDF page is cocoPx * 72/75 points — that only
 * holds when the raster was exactly 75 DPI of the same CropBox pdf.js draws.
 */
export function px75ToDisplay(px: number, cocoPx: number, displayPx: number): number {
  if (!(cocoPx > 0)) return px;
  return (px / cocoPx) * displayPx;
}

export type OverlayBox = {
  polygon_pt?: [number, number][];
  polygon_px75?: [number, number][];
  bbox_pt: [number, number, number, number];
  bbox_px75: [number, number, number, number];
  edited?: boolean;
};

export type OverlaySpace = {
  displayW: number;
  displayH: number;
  pageWpt: number;
  pageHpt: number;
  cocoW: number;
  cocoH: number;
  /** Version-0 imports: map raster pixels onto the PDF render, skipping the 75 DPI pt path. */
  rasterOverlay: boolean;
};

function fromPx75(
  pts: [number, number][],
  cocoW: number,
  cocoH: number,
  displayW: number,
  displayH: number,
): PolyPoint[] {
  return pts.map(([x, y]) => ({
    x: px75ToDisplay(x, cocoW, displayW),
    y: px75ToDisplay(y, cocoH, displayH),
  }));
}

function fromPt(
  pts: [number, number][],
  pageWpt: number,
  pageHpt: number,
  displayW: number,
  displayH: number,
): PolyPoint[] {
  return pts.map(([x, y]) => ({
    x: ptToDisplay(x, pageWpt, displayW),
    y: ptToDisplay(y, pageHpt, displayH),
  }));
}

function bboxQuad(bbox: [number, number, number, number], mapX: (v: number) => number, mapY: (v: number) => number): PolyPoint[] {
  const [x, y, w, h] = bbox;
  return quadFromRect({ x1: mapX(x), y1: mapY(y), x2: mapX(x + w), y2: mapY(y + h) });
}

/** Map a stored box onto the displayed PDF (or the 75-DPI raster when no PDF is attached). */
export function overlayBoxPoints(b: OverlayBox, space: OverlaySpace): PolyPoint[] {
  const polyPt = b.polygon_pt && b.polygon_pt.length >= 3 ? b.polygon_pt : null;
  const polyPx = b.polygon_px75 && b.polygon_px75.length >= 3 ? b.polygon_px75 : null;
  const cocoW = space.cocoW > 0 ? space.cocoW : space.displayW;
  const cocoH = space.cocoH > 0 ? space.cocoH : space.displayH;
  const { displayW, displayH, pageWpt, pageHpt } = space;

  if (space.rasterOverlay && polyPx) {
    return fromPx75(polyPx, cocoW, cocoH, displayW, displayH);
  }
  if (space.rasterOverlay && b.bbox_px75[2] > 0) {
    return bboxQuad(b.bbox_px75, (v) => px75ToDisplay(v, cocoW, displayW), (v) => px75ToDisplay(v, cocoH, displayH));
  }
  if (polyPt && pageWpt > 0) {
    return fromPt(polyPt, pageWpt, pageHpt, displayW, displayH);
  }
  if (polyPx) {
    return fromPx75(polyPx, cocoW, cocoH, displayW, displayH);
  }
  const w = b.bbox_pt[2];
  if (w > 0 && pageWpt > 0) {
    return bboxQuad(b.bbox_pt, (v) => ptToDisplay(v, pageWpt, displayW), (v) => ptToDisplay(v, pageHpt, displayH));
  }
  return bboxQuad(b.bbox_px75, (v) => px75ToDisplay(v, cocoW, displayW), (v) => px75ToDisplay(v, cocoH, displayH));
}
