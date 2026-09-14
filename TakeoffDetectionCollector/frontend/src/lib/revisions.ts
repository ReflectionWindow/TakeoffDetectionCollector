import type { Revision } from "../api/types";

export function isAutoSnapNote(note?: string | null): boolean {
  return (note ?? "").trim().toLowerCase() === "auto-snap";
}

export function isImportNote(note?: string | null): boolean {
  return (note ?? "").trim().toLowerCase().startsWith("imported");
}

/**
 * Version to restore when the latest revision is a silent auto-snap.
 * Returns null when the page is already on markup / a user edit.
 */
export function markupSourceVersion(revs: Revision[]): number | null {
  if (revs.length === 0) return null;
  const sorted = [...revs].sort((a, b) => a.version - b.version);
  const latest = sorted[sorted.length - 1]!;
  if (!isAutoSnapNote(latest.note)) return null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (isImportNote(sorted[i]!.note)) return sorted[i]!.version;
  }
  const v0 = sorted.find((r) => r.version === 0);
  return v0?.version ?? sorted[0]!.version;
}

/** Version-0 imports and restores of that import keep the 75 DPI raster overlay. */
export function shouldRasterOverlay(version: number, note?: string | null): boolean {
  if (version === 0) return true;
  const n = (note ?? "").trim().toLowerCase();
  return n.startsWith("imported") || n === "revert to v0";
}
