/**
 * Snap-to-geometry engine for scale calibrate and box-edge magnets.
 *
 * Pipeline: page-vectors (PDF pt) → bakeGeometryIndex (PNG) → querySnap / edgeSnap.
 */

export { bakeGeometryIndex } from "./bake";
export {
  FULL_OVERLAY_VIEW,
  geometryHasOverlay,
  shouldShowVectorOverlay,
  VECTOR_OVERLAY_COLOR,
  VECTOR_OVERLAY_MIN_ZOOM,
  overlayViewRect,
  vectorOverlayPaths,
  activeSnapMark,
  type ActiveSnapMark,
} from "./overlay";
export { suggestDimLength, dimTextsNear } from "./dimSuggest";
export type { DimSuggestion } from "./dimSuggest";
export { lockFromHit, lockedSegmentId, isSegmentAllowed } from "./lock";
export { cursorNearLinework, querySnap, snapAndLock } from "./query";
export {
  applyCorner,
  cornerOfHandle,
  DEFAULT_ADJUST_SNAP,
  LINE_SNAP_MODES,
  P1_SNAP_MODES,
  POINT_SNAP_MODES,
  queryAdjustSnap,
  queryPointSnap,
  snapRectByPoint,
  type AdjustSnap,
} from "./pointSnap";
export {
  AUTO_SNAP_BAND_PX,
  AUTO_SNAP_MAX_SEG_TO_EDGE,
  EDGE_SNAP_CAPTURE_PX,
  EDGE_SNAP_RELEASE_PX,
  TINY_BOX_MIN_SIDE_PX,
  edgeHitToSnapHit,
  edgesForHandle,
  emptyMoveLock,
  queryEdgeCandidates,
  queryEdgeSnap,
  snapModelBoxes,
  snapMoveRect,
  snapRectEdges,
  snapResizeEdges,
  type BoxEdge,
  type EdgeLock,
  type EdgeSnapHit,
  type MoveLock,
} from "./edgeSnap";
export {
  bakeScaleFromSizes,
  pdfToPng,
  pngToPdf,
  radiusPngFromScreen,
} from "./transform";
export {
  clearGeometryCache,
  geometryCacheKey,
  getCachedGeometryIndex,
  setCachedGeometryIndex,
} from "./vectorCache";
export {
  ALL_SNAP_MODES,
  SNAP_PRIORITY,
  type DimTextPng,
  type FillPoly,
  type GeometryIndex,
  type LockState,
  type Point,
  type Segment,
  type SnapContext,
  type SnapGuide,
  type SnapHit,
  type SnapMode,
  type SnapPhase,
} from "./types";
