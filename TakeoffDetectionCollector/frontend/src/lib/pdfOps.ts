/** Walk a pdf.js operator list and collect fills, ticks, and stroke segments. */

export type Mat = [number, number, number, number, number, number];
export type PdfOpPoint = { x: number; y: number };

export type PdfVectorOps = {
  moveTo: number;
  lineTo: number;
  curveTo: number;
  curveTo2: number;
  curveTo3: number;
  closePath: number;
  rectangle: number;
  stroke: number;
  closeStroke: number;
  fill: number;
  eoFill: number;
  fillStroke: number;
  eoFillStroke: number;
  closeFillStroke: number;
  closeEOFillStroke: number;
  endPath: number;
  clip: number;
  eoClip: number;
  save: number;
  restore: number;
  transform: number;
  constructPath: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  beginGroup: number;
  endGroup: number;
};

export type PdfVectorExtract = {
  lines: number[][];
  rects: number[][];
  fills: number[][];
  points: number[][];
};

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
const PAGE_FILL_FRAC = 0.45;
const SKINNY_PX = 16;
const TINY_FILL_PX = 3;
const HATCH_CELL_PX = 32;
const MAX_FILLS = 8_000;
const MAX_POINTS = 8_000;
const MAX_LINES = 16_000;
const DOT_MERGE_PX = 1.25;

/** Brick / poche cells: small and roughly square. Mullions are long and thin. */
function isHatchCell(w: number, h: number): boolean {
  const min = Math.min(w, h);
  const max = Math.max(w, h);
  return max <= HATCH_CELL_PX && max < min * 2.5;
}

export function mulMat(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function applyMat(m: Mat, x: number, y: number): PdfOpPoint {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

function q(v: number): number {
  return Math.round(v * 100) / 100;
}

function flat(pts: PdfOpPoint[]): number[] {
  const out: number[] = [];
  for (const p of pts) {
    out.push(q(p.x), q(p.y));
  }
  return out;
}

function bounds(pts: PdfOpPoint[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = pts[0]!.x;
  let minY = pts[0]!.y;
  let maxX = minX;
  let maxY = minY;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function mergeDots(points: number[][]): number[][] {
  const out: number[][] = [];
  for (const raw of points) {
    const x = raw[0]!;
    const y = raw[1]!;
    if (out.some((p) => Math.hypot(p[0]! - x, p[1]! - y) <= DOT_MERGE_PX)) continue;
    out.push([x, y]);
    if (out.length >= MAX_POINTS) break;
  }
  return out;
}

/**
 * Interpret a pdf.js operator list. `toPage` maps current-user-space points
 * (after content CTM) into the coordinate space you want (typically viewport px).
 */
export function walkPdfOps(
  fnArray: number[],
  argsArray: unknown[],
  ops: PdfVectorOps,
  toPage: (x: number, y: number) => PdfOpPoint,
  pageW: number,
  pageH: number,
): PdfVectorExtract {
  const lines: number[][] = [];
  const rects: number[][] = [];
  const fills: number[][] = [];
  const points: number[][] = [];
  const ctmStack: Mat[] = [];
  let ctm: Mat = IDENTITY;
  let clipNext = false;
  let subpaths: PdfOpPoint[][] = [];
  let current: PdfOpPoint[] = [];

  const map = (x: number, y: number) => {
    const p = applyMat(ctm, x, y);
    return toPage(p.x, p.y);
  };

  const flushCurrent = () => {
    if (current.length) subpaths.push(current);
    current = [];
  };

  const addPoint = (p: PdfOpPoint) => {
    if (points.length >= MAX_POINTS) return;
    points.push([q(p.x), q(p.y)]);
  };

  const addLine = (a: PdfOpPoint, b: PdfOpPoint) => {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 0.5) {
      addPoint({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      return;
    }
    if (lines.length >= MAX_LINES) return;
    lines.push([q(a.x), q(a.y), q(b.x), q(b.y)]);
  };

  const consumeConstructPath = (packed: unknown) => {
    if (!Array.isArray(packed) || packed.length < 2) return;
    const pathOps = packed[0] as ArrayLike<number>;
    const coords = packed[1] as ArrayLike<number>;
    let j = 0;
    let x = 0;
    let y = 0;
    for (let i = 0; i < pathOps.length; i += 1) {
      switch (pathOps[i] | 0) {
        case ops.rectangle: {
          flushCurrent();
          const rx = coords[j++]!;
          const ry = coords[j++]!;
          const rw = coords[j++]!;
          const rh = coords[j++]!;
          const a = map(rx, ry);
          const b = map(rx + rw, ry);
          const cpt = map(rx + rw, ry + rh);
          const d = map(rx, ry + rh);
          // pdf.js turns a zero-width/height `re` into a single line.
          if (Math.abs(rw) < 1e-6 || Math.abs(rh) < 1e-6) {
            subpaths.push([a, cpt]);
          } else {
            subpaths.push([a, b, cpt, d, a]);
          }
          x = rx;
          y = ry;
          break;
        }
        case ops.moveTo: {
          flushCurrent();
          x = coords[j++]!;
          y = coords[j++]!;
          current = [map(x, y)];
          break;
        }
        case ops.lineTo: {
          x = coords[j++]!;
          y = coords[j++]!;
          if (!current.length) current = [map(x, y)];
          else current.push(map(x, y));
          break;
        }
        case ops.curveTo: {
          j += 4;
          x = coords[j++]!;
          y = coords[j++]!;
          if (!current.length) current = [map(x, y)];
          else current.push(map(x, y));
          break;
        }
        case ops.curveTo2:
        case ops.curveTo3: {
          j += 2;
          x = coords[j++]!;
          y = coords[j++]!;
          if (!current.length) current = [map(x, y)];
          else current.push(map(x, y));
          break;
        }
        case ops.closePath: {
          if (current.length) {
            current.push(current[0]!);
            flushCurrent();
          }
          break;
        }
        default:
          break;
      }
    }
  };

  const recordOutline = (pts: PdfOpPoint[], close: boolean) => {
    if (pts.length < 2) return;
    for (let i = 1; i < pts.length; i += 1) addLine(pts[i - 1]!, pts[i]!);
    if (!close) return;
    const a = pts[0]!;
    const b = pts[pts.length - 1]!;
    if (Math.hypot(a.x - b.x, a.y - b.y) > 0.5) addLine(b, a);
  };

  /** Keep the long faces of a mullion; drop the 2–4 px caps. */
  const recordLongEdges = (pts: PdfOpPoint[]) => {
    const closed: PdfOpPoint[] = [...pts];
    if (closed.length >= 2) {
      const a = closed[0]!;
      const b = closed[closed.length - 1]!;
      if (Math.hypot(a.x - b.x, a.y - b.y) > 0.5) closed.push(a);
    }
    const lens: number[] = [];
    for (let i = 1; i < closed.length; i += 1) {
      lens.push(Math.hypot(closed[i]!.x - closed[i - 1]!.x, closed[i]!.y - closed[i - 1]!.y));
    }
    const maxLen = Math.max(0, ...lens);
    const minKeep = Math.max(SKINNY_PX, maxLen * 0.45);
    for (let i = 1; i < closed.length; i += 1) {
      if (lens[i - 1]! >= minKeep) addLine(closed[i - 1]!, closed[i]!);
    }
  };

  const recordFills = () => {
    const pageArea = pageW * pageH;
    for (const pts of [...subpaths, current].filter((p) => p.length >= 2)) {
      if (pts.length === 1) {
        addPoint(pts[0]!);
        continue;
      }
      const box = bounds(pts);
      const w = box.maxX - box.minX;
      const h = box.maxY - box.minY;
      if (w <= TINY_FILL_PX && h <= TINY_FILL_PX) {
        addPoint({ x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 });
        continue;
      }
      const skinny = Math.min(w, h) <= SKINNY_PX;
      if (pageArea > 0 && w * h > PAGE_FILL_FRAC * pageArea && !skinny) continue;
      // Hatch cells are small squares; keep a tick, skip their four edges.
      if (isHatchCell(w, h)) {
        addPoint({ x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 });
        continue;
      }
      if (pts.length >= 3 && fills.length < MAX_FILLS) fills.push(flat(pts));
      // Only long faces of skinny fills (mullions). Glass poche is a fat fill —
      // outlining it draws a red edge that snap will not use (or will fight).
      if (skinny) recordLongEdges(pts);
    }
  };

  const recordStrokes = () => {
    for (const pts of [...subpaths, current].filter((p) => p.length)) {
      if (pts.length === 1) {
        addPoint(pts[0]!);
        continue;
      }
      recordOutline(pts, false);
    }
  };

  const clearPath = () => {
    subpaths = [];
    current = [];
    clipNext = false;
  };

  for (let i = 0; i < fnArray.length; i += 1) {
    const fn = fnArray[i]!;
    const args = argsArray[i] as unknown[] | null | undefined;
    if (fn === ops.constructPath) {
      consumeConstructPath(args);
      continue;
    }
    if (fn === ops.moveTo && args && args.length >= 2) {
      flushCurrent();
      current = [map(Number(args[0]), Number(args[1]))];
      continue;
    }
    if (fn === ops.lineTo && args && args.length >= 2) {
      const p = map(Number(args[0]), Number(args[1]));
      if (!current.length) current = [p];
      else current.push(p);
      continue;
    }
    if (fn === ops.rectangle && args && args.length >= 4) {
      flushCurrent();
      const rx = Number(args[0]);
      const ry = Number(args[1]);
      const rw = Number(args[2]);
      const rh = Number(args[3]);
      const a = map(rx, ry);
      const b = map(rx + rw, ry);
      const cpt = map(rx + rw, ry + rh);
      const d = map(rx, ry + rh);
      subpaths.push(Math.abs(rw) < 1e-6 || Math.abs(rh) < 1e-6 ? [a, cpt] : [a, b, cpt, d, a]);
      continue;
    }
    if (fn === ops.closePath) {
      if (current.length) {
        current.push(current[0]!);
        flushCurrent();
      }
      continue;
    }
    if (fn === ops.save || fn === ops.beginGroup) {
      ctmStack.push(ctm);
      continue;
    }
    if (fn === ops.restore || fn === ops.endGroup || fn === ops.paintFormXObjectEnd) {
      ctm = ctmStack.pop() ?? IDENTITY;
      continue;
    }
    if (fn === ops.transform && args && args.length >= 6) {
      ctm = mulMat(ctm, args as unknown as Mat);
      continue;
    }
    if (fn === ops.paintFormXObjectBegin) {
      ctmStack.push(ctm);
      const matrix = args?.[0];
      if (Array.isArray(matrix) && matrix.length >= 6) ctm = mulMat(ctm, matrix as unknown as Mat);
      continue;
    }
    if (fn === ops.clip || fn === ops.eoClip) {
      clipNext = true;
      continue;
    }
    if (
      fn === ops.fill ||
      fn === ops.eoFill ||
      fn === ops.fillStroke ||
      fn === ops.eoFillStroke ||
      fn === ops.closeFillStroke ||
      fn === ops.closeEOFillStroke
    ) {
      if (!clipNext) {
        recordFills();
        if (fn !== ops.fill && fn !== ops.eoFill) recordStrokes();
      }
      clearPath();
      continue;
    }
    if (fn === ops.stroke || fn === ops.closeStroke) {
      if (!clipNext) recordStrokes();
      clearPath();
      continue;
    }
    if (fn === ops.endPath) {
      clearPath();
    }
  }

  return { lines, rects, fills, points: mergeDots(points) };
}
