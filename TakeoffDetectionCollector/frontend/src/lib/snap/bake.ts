/** Bake PageVectorsResponse (PDF pt) into a PNG-space GeometryIndex. */

import type { PageVectorsResponse } from "../../api/types";
import { midpoint, quantize, segmentInteriorIntersection } from "./math";
import { buildSpatialGrid, querySegmentIdsInAabb } from "./spatial";
import { bakeScaleFromSizes, pdfToPng } from "./transform";
import type {
  DimTextPng,
  Endpoint,
  EndpointId,
  FillPoly,
  GeometryIndex,
  Point,
  Segment,
  SegmentId,
} from "./types";

const ENDPOINT_MERGE_PX = 0.5;
const MIN_SEG_LEN_PX = 0.25;
/** Soft client cap after rect/quad explode (server already caps raw drawings). */
const MAX_BAKED_SEGMENTS = 16_000;
const CROSSING_PAIR_CAP = 40_000;

function aabb(a: Point, b: Point) {
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
}

function polyBounds(pts: Point[]): FillPoly | null {
  if (pts.length < 3) return null;
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
  return { points: pts, minX, minY, maxX, maxY };
}

function makeSegment(id: SegmentId, a: Point, b: Point): Segment | null {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(len >= MIN_SEG_LEN_PX)) return null;
  const box = aabb(a, b);
  return {
    id,
    a,
    b,
    mid: midpoint(a, b),
    length: len,
    ...box,
  };
}

function endpointKey(p: Point): string {
  const x = quantize(p.x, ENDPOINT_MERGE_PX);
  const y = quantize(p.y, ENDPOINT_MERGE_PX);
  return `${x}:${y}`;
}

/**
 * Convert API vectors into a snap index.
 * Returns null when geometry cannot be trusted (missing sizes, empty, unsupported).
 */
export function bakeGeometryIndex(
  vectors: PageVectorsResponse,
  opts?: {
    /** Override raster size when annotation draft is more trustworthy. */
    imageWidthPx?: number;
    imageHeightPx?: number;
    pageIndex?: number;
  },
): GeometryIndex | null {
  if (!vectors.pdf_available) return null;
  if (vectors.unsupported_reason === "rotated_page") return null;
  if (vectors.unsupported_reason === "password_protected") return null;
  if (vectors.unsupported_reason === "out_of_range") return null;

  const pageWidthPt = vectors.page_width_pt;
  const pageHeightPt = vectors.page_height_pt;
  const imageWidthPx = opts?.imageWidthPx ?? vectors.image_width_px ?? null;
  const imageHeightPx = opts?.imageHeightPx ?? vectors.image_height_px ?? null;
  if (
    pageWidthPt == null ||
    pageHeightPt == null ||
    imageWidthPx == null ||
    imageHeightPx == null
  ) {
    return null;
  }

  const scale = bakeScaleFromSizes({
    pageWidthPt,
    pageHeightPt,
    imageWidthPx,
    imageHeightPx,
  });
  if (!scale) return null;

  const pageIndex = opts?.pageIndex ?? vectors.page_index;
  const segments: Segment[] = [];
  const fills: FillPoly[] = [];
  const dots: Point[] = [];
  const segmentById = new Map<SegmentId, Segment>();
  let segSeq = 0;

  const addLine = (x1: number, y1: number, x2: number, y2: number, tag: string) => {
    const a = pdfToPng({ x: x1, y: y1 }, scale);
    const b = pdfToPng({ x: x2, y: y2 }, scale);
    const id: SegmentId = `s:${pageIndex}:${tag}:${segSeq}`;
    segSeq += 1;
    const seg = makeSegment(id, a, b);
    if (!seg) return;
    segments.push(seg);
    segmentById.set(seg.id, seg);
  };

  for (const line of vectors.segments.lines ?? []) {
    if (line.length < 4) continue;
    addLine(line[0]!, line[1]!, line[2]!, line[3]!, "l");
  }

  for (const rect of vectors.segments.rects ?? []) {
    if (rect.length < 4) continue;
    const [x0, y0, x1, y1] = rect;
    // Explode rect into 4 edges for snap. CAD poche is usually `re f`, so
    // keep the quad for the zoomed color-fill overlay too.
    addLine(x0!, y0!, x1!, y0!, "re");
    addLine(x1!, y0!, x1!, y1!, "re");
    addLine(x1!, y1!, x0!, y1!, "re");
    addLine(x0!, y1!, x0!, y0!, "re");
    const fill = polyBounds([
      pdfToPng({ x: x0!, y: y0! }, scale),
      pdfToPng({ x: x1!, y: y0! }, scale),
      pdfToPng({ x: x1!, y: y1! }, scale),
      pdfToPng({ x: x0!, y: y1! }, scale),
    ]);
    if (fill) fills.push(fill);
  }

  for (const quad of vectors.segments.quads ?? []) {
    if (quad.length < 8) continue;
    const pts: Point[] = [
      { x: quad[0]!, y: quad[1]! },
      { x: quad[2]!, y: quad[3]! },
      { x: quad[4]!, y: quad[5]! },
      { x: quad[6]!, y: quad[7]! },
    ].map((p) => pdfToPng(p, scale));
    const fill = polyBounds(pts);
    if (fill) fills.push(fill);
    for (let i = 0; i < 4; i += 1) {
      const a = pts[i]!;
      const b = pts[(i + 1) % 4]!;
      const id: SegmentId = `s:${pageIndex}:qu:${segSeq}`;
      segSeq += 1;
      const seg = makeSegment(id, a, b);
      if (!seg) continue;
      segments.push(seg);
      segmentById.set(seg.id, seg);
    }
  }

  for (const curve of vectors.segments.curves ?? []) {
    if (curve.length < 4) continue;
    addLine(curve[0]!, curve[1]!, curve[2]!, curve[3]!, "c");
  }

  for (const fill of vectors.fills ?? []) {
    if (fill.length < 4) continue;
    const pts: Point[] = [];
    for (let i = 0; i + 1 < fill.length; i += 2) {
      pts.push(pdfToPng({ x: fill[i]!, y: fill[i + 1]! }, scale));
    }
    if (pts.length < 2) continue;
    const poly = polyBounds(pts);
    if (poly) fills.push(poly);
  }

  let truncated = Boolean(vectors.stats?.truncated);
  if (segments.length > MAX_BAKED_SEGMENTS) {
    truncated = true;
    const keep = segments.slice(0, MAX_BAKED_SEGMENTS);
    segments.length = 0;
    segments.push(...keep);
    segmentById.clear();
    for (const seg of segments) segmentById.set(seg.id, seg);
  }

  // Merge endpoints within ENDPOINT_MERGE_PX.
  const epMap = new Map<string, Endpoint>();
  let epSeq = 0;
  for (const seg of segments) {
    for (const p of [seg.a, seg.b]) {
      const key = endpointKey(p);
      let ep = epMap.get(key);
      if (!ep) {
        const id: EndpointId = `e:${pageIndex}:${epSeq}`;
        epSeq += 1;
        ep = { id, p: { x: quantize(p.x, ENDPOINT_MERGE_PX), y: quantize(p.y, ENDPOINT_MERGE_PX) }, segmentIds: [] };
        epMap.set(key, ep);
      }
      if (!ep.segmentIds.includes(seg.id)) ep.segmentIds.push(seg.id);
    }
  }
  for (const raw of vectors.points ?? []) {
    if (raw.length < 2) continue;
    const p = pdfToPng({ x: raw[0]!, y: raw[1]! }, scale);
    const key = endpointKey(p);
    if (epMap.has(key)) continue;
    const id: EndpointId = `e:${pageIndex}:${epSeq}`;
    epSeq += 1;
    epMap.set(key, {
      id,
      p: { x: quantize(p.x, ENDPOINT_MERGE_PX), y: quantize(p.y, ENDPOINT_MERGE_PX) },
      segmentIds: [],
    });
  }
  const endpoints = [...epMap.values()];

  const dimTexts: DimTextPng[] = (vectors.dim_texts ?? []).map((d) => {
    const a = pdfToPng({ x: d.x0, y: d.y0 }, scale);
    const b = pdfToPng({ x: d.x1, y: d.y1 }, scale);
    return {
      text: d.text,
      x0: a.x,
      y0: a.y,
      x1: b.x,
      y1: b.y,
      parsedFeet: d.parsed_feet,
      confidence: d.confidence,
      center: midpoint(a, b),
    };
  });

  const spatial = buildSpatialGrid(segments, endpoints);
  dots.push(...overlayDots(segments, endpoints, spatial, segmentById));
  const empty = segments.length === 0 && endpoints.length === 0;

  return {
    pageIndex,
    imageWidthPx,
    imageHeightPx,
    sx: scale.sx,
    sy: scale.sy,
    pageWidthPt,
    pageHeightPt,
    segments,
    endpoints,
    segmentById,
    fills,
    dots,
    dimTexts,
    empty,
    truncated,
    spatial,
  };
}

function overlayDots(
  segments: Segment[],
  endpoints: Endpoint[],
  spatial: ReturnType<typeof buildSpatialGrid>,
  segmentById: Map<SegmentId, Segment>,
): Point[] {
  const out: Point[] = [];
  const seen = new Set<string>();
  const add = (p: Point) => {
    const key = `${quantize(p.x, ENDPOINT_MERGE_PX)}:${quantize(p.y, ENDPOINT_MERGE_PX)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ x: quantize(p.x, ENDPOINT_MERGE_PX), y: quantize(p.y, ENDPOINT_MERGE_PX) });
  };
  for (const ep of endpoints) {
    if (ep.segmentIds.length >= 2) add(ep.p);
  }
  let pairs = 0;
  for (const a of segments) {
    const ids = querySegmentIdsInAabb(spatial, a.minX, a.minY, a.maxX, a.maxY);
    for (const id of ids) {
      if (id <= a.id) continue;
      const b = segmentById.get(id);
      if (!b) continue;
      pairs += 1;
      if (pairs > CROSSING_PAIR_CAP) return out;
      const p = segmentInteriorIntersection(a.a, a.b, b.a, b.b);
      if (p) add(p);
    }
  }
  return out;
}
