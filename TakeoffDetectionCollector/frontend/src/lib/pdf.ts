import * as pdfjsLib from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

export async function loadPdfData(data: ArrayBuffer): Promise<pdfjsLib.PDFDocumentProxy> {
  return pdfjsLib.getDocument({ data }).promise;
}

export async function renderPageToCanvas(
  pdf: pdfjsLib.PDFDocumentProxy,
  pageIndex: number,
  scale: number,
  canvas: HTMLCanvasElement,
): Promise<{ width: number; height: number }> {
  const page = await pdf.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale });
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas 2D not available");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { width: viewport.width, height: viewport.height };
}
