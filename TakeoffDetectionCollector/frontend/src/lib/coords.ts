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
