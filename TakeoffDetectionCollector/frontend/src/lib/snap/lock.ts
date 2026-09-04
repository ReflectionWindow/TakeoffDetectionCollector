/** Lock-to-segment helpers after click 1. */

import type { LockState, SegmentId, SnapHit } from "./types";

export function lockFromHit(hit: SnapHit | null): LockState {
  if (!hit) return { kind: "none" };
  if (hit.segmentId) return { kind: "segment", segmentId: hit.segmentId };
  // Intersection: prefer first segment id if present.
  if (hit.segmentIdB) return { kind: "segment", segmentId: hit.segmentIdB };
  return { kind: "none" };
}

export function lockedSegmentId(lock: LockState): SegmentId | null {
  return lock.kind === "segment" ? lock.segmentId : null;
}

export function isSegmentAllowed(lock: LockState, segmentId: SegmentId | undefined): boolean {
  if (!segmentId) return lock.kind === "none";
  if (lock.kind === "none") return true;
  return lock.segmentId === segmentId;
}
