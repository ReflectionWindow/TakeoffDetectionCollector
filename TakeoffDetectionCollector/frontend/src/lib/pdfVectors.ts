import { AnnotationMode, OPS, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";
import type { PageVectorsResponse } from "../api/types";
import { walkPdfOps } from "./pdfOps";

/** Must match the raster used on the annotation stage. */
export const SHEET_RENDER_SCALE = 1.5;

export async function extractPageVectors(
  page: PDFPageProxy,
  opts: { pageIndex: number; jobId: string; scale?: number },
): Promise<PageVectorsResponse> {
  const scale = opts.scale ?? SHEET_RENDER_SCALE;
  const viewport = page.getViewport({ scale });
  const opList = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
  const extracted = walkPdfOps(
    opList.fnArray,
    opList.argsArray,
    OPS,
    (x, y) => {
      const [vx, vy] = viewport.convertToViewportPoint(x, y);
      return { x: vx, y: vy };
    },
    viewport.width,
    viewport.height,
  );
  const imageW = Math.ceil(viewport.width);
  const imageH = Math.ceil(viewport.height);
  return {
    job_id: opts.jobId,
    page_index: opts.pageIndex,
    pdf_available: true,
    coord_space: "pt",
    page_width_pt: imageW,
    page_height_pt: imageH,
    image_width_px: imageW,
    image_height_px: imageH,
    rotation: 0,
    empty: extracted.fills.length === 0 && extracted.points.length === 0 && extracted.lines.length === 0,
    extract_version: "pdfjs-ops",
    segments: {
      lines: extracted.lines,
      rects: extracted.rects,
      quads: [],
      curves: [],
    },
    fills: extracted.fills,
    points: extracted.points,
    dim_texts: [],
    stats: {
      raw_path_count: extracted.fills.length + extracted.lines.length,
      returned_segment_count: extracted.lines.length,
      truncated: false,
      dropped_short: 0,
      dropped_fill_only: 0,
      dropped_outside: 0,
      curves_as_chords: 0,
      fill_count: extracted.fills.length,
      point_count: extracted.points.length,
    },
  };
}

export async function extractPageVectorsFromDoc(
  pdf: PDFDocumentProxy,
  pageIndex: number,
  jobId: string,
  scale = SHEET_RENDER_SCALE,
): Promise<PageVectorsResponse> {
  const page = await pdf.getPage(pageIndex + 1);
  return extractPageVectors(page, { pageIndex, jobId, scale });
}
