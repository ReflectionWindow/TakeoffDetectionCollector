import * as pdfjsLib from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

export async function loadPdfData(data: ArrayBuffer): Promise<pdfjsLib.PDFDocumentProxy> {
  return pdfjsLib.getDocument({ data }).promise;
}

export type RenderedSheet = {
  width: number;
  height: number;
  /** pdf.js page.view size in PDF points (CropBox, rotation applied, y-down). */
  pageWidthPt: number;
  pageHeightPt: number;
};

export async function renderPageToCanvas(
  pdf: pdfjsLib.PDFDocumentProxy,
  pageIndex: number,
  scale: number,
  canvas: HTMLCanvasElement,
): Promise<RenderedSheet> {
  const page = await pdf.getPage(pageIndex + 1);
  const native = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale });
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas 2D not available");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvasContext: ctx,
    viewport,
    annotationMode: pdfjsLib.AnnotationMode.DISABLE,
  }).promise;
  return {
    width: canvas.width,
    height: canvas.height,
    pageWidthPt: native.width,
    pageHeightPt: native.height,
  };
}
