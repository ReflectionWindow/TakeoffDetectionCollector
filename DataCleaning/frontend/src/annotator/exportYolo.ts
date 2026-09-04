import JSZip from "jszip";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { CLASSES, type Shape } from "../types";
import { renderPageToCanvas } from "./pdf";

const DEFAULT_DPI = 200;

function yaml(): string {
  const names = CLASSES.map((c) => `  ${c.id}: ${c.name}`).join("\n");
  return `path: .\ntrain: images/train\nval: images/train\n\nnames:\n${names}\n`;
}

function shapeToLine(shape: Shape, width: number, height: number): string {
  const coords = shape.points
    .map((p) => {
      const x = clamp01(p.x / width);
      const y = clamp01(p.y / height);
      return `${x.toFixed(6)} ${y.toFixed(6)}`;
    })
    .join(" ");
  return `${shape.classId} ${coords}`;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function stem(fileName: string): string {
  return fileName.replace(/\.pdf$/i, "").replace(/[^\w.-]+/g, "_") || "sheet";
}

export async function exportYoloZip(opts: {
  pdf: PDFDocumentProxy;
  fileName: string;
  annotations: Record<number, Shape[]>;
  dpi?: number;
}): Promise<Blob> {
  const dpi = opts.dpi ?? DEFAULT_DPI;
  const scale = dpi / 72;
  const base = stem(opts.fileName);
  const zip = new JSZip();
  const canvas = document.createElement("canvas");
  let exported = 0;

  const pageIndices = Object.keys(opts.annotations)
    .map(Number)
    .filter((i) => (opts.annotations[i] ?? []).length > 0)
    .sort((a, b) => a - b);

  for (const pageIndex of pageIndices) {
    const shapes = opts.annotations[pageIndex];
    const page = await opts.pdf.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });
    const width = viewport.width;
    const height = viewport.height;

    await renderPageToCanvas(opts.pdf, pageIndex, scale, canvas);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))), "image/png");
    });

    const pageTag = String(pageIndex + 1).padStart(3, "0");
    const name = `${base}_p${pageTag}`;
    zip.file(`dataset/images/train/${name}.png`, blob);
    zip.file(
      `dataset/labels/train/${name}.txt`,
      shapes.map((s) => shapeToLine(s, width, height)).join("\n") + "\n",
    );
    exported += 1;
  }

  if (exported === 0) {
    throw new Error("No annotations to export. Draw at least one shape.");
  }

  zip.file("dataset/data.yaml", yaml());
  return zip.generateAsync({ type: "blob" });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  downloadBlob(blob, filename);
}
