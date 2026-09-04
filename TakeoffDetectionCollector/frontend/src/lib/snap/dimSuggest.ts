/** Suggest a length (feet) from nearby dimension text after p1–p2 commit. */

import { dist, midpoint } from "./math";
import type { DimTextPng, GeometryIndex, Point } from "./types";

export type DimSuggestion = {
  text: string;
  parsedFeet: number;
  confidence: number;
  /** Lower is better. */
  score: number;
};

/**
 * Pick the best dim label near the calibrate segment.
 * Never auto-confirm — caller should prefill an editable field only.
 */
export function suggestDimLength(
  index: GeometryIndex,
  p1: Point,
  p2: Point,
  opts?: { maxDistPx?: number; minConfidence?: number },
): DimSuggestion | null {
  if (index.dimTexts.length === 0) return null;
  const maxDist = opts?.maxDistPx ?? 80;
  const minConf = opts?.minConfidence ?? 0.55;
  const mid = midpoint(p1, p2);
  const segLen = dist(p1, p2);
  if (!(segLen > 0)) return null;

  const dx = (p2.x - p1.x) / segLen;
  const dy = (p2.y - p1.y) / segLen;

  let best: DimSuggestion | null = null;

  for (const dim of index.dimTexts) {
    if (dim.confidence < minConf) continue;
    if (!(dim.parsedFeet > 0)) continue;
    const dMid = dist(mid, dim.center);
    if (dMid > maxDist) continue;

    // Prefer labels whose bbox long axis is roughly parallel to the measure.
    const dimDx = dim.x1 - dim.x0;
    const dimDy = dim.y1 - dim.y0;
    const dimLen = Math.hypot(dimDx, dimDy) || 1;
    const ux = dimDx / dimLen;
    const uy = dimDy / dimLen;
    const parallel = Math.abs(ux * dx + uy * dy); // 1 = parallel
    const score = dMid + (1 - parallel) * 40 + (1 - dim.confidence) * 20;

    if (!best || score < best.score) {
      best = {
        text: dim.text,
        parsedFeet: dim.parsedFeet,
        confidence: dim.confidence,
        score,
      };
    }
  }

  return best;
}

export function dimTextsNear(
  index: GeometryIndex,
  point: Point,
  radiusPx: number,
): DimTextPng[] {
  return index.dimTexts.filter((d) => dist(point, d.center) <= radiusPx);
}
