/**
 * Snap-to-geometry types for scale calibrate.
 *
 * After bake, every point is in **PNG pixel space** (same as boxes / calibrate clicks).
 */

export type Point = { x: number; y: number };

export type SnapMode =
  | "endpoint"
  | "midpoint"
  | "nearest"
  | "intersection"
  | "perpendicular"
  | "ortho"
  | "parallel";

export const ALL_SNAP_MODES: readonly SnapMode[] = [
  "endpoint",
  "intersection",
  "midpoint",
  "perpendicular",
  "nearest",
  "ortho",
  "parallel",
] as const;

/** Hard priority: first mode class with any in-radius hit wins. */
export const SNAP_PRIORITY: readonly SnapMode[] = ALL_SNAP_MODES;

export type SegmentId = string;
export type EndpointId = string;

export type Segment = {
  id: SegmentId;
  a: Point;
  b: Point;
  mid: Point;
  length: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type Endpoint = {
  id: EndpointId;
  p: Point;
  segmentIds: SegmentId[];
};

export type DimTextPng = {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  parsedFeet: number;
  confidence: number;
  center: Point;
};

/** Closed color-fill polygon in PNG space, kept for the zoomed overlay. */
export type FillPoly = {
  points: Point[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type SnapGuide =
  | { kind: "segment"; a: Point; b: Point }
  | { kind: "ray"; origin: Point; dir: Point }
  | { kind: "ortho"; axis: "h" | "v"; through: Point }
  | { kind: "perp"; from: Point; to: Point }
  | { kind: "parallel"; through: Point; dir: Point }
  | { kind: "midpoint"; a: Point; b: Point };

export type SnapHit = {
  mode: SnapMode;
  point: Point;
  /** Distance from cursor in PNG px (zoom already divided out of cursor). */
  distPx: number;
  /** Same distance expressed in screen px (distPx * zoom). */
  screenDistPx: number;
  segmentId?: SegmentId;
  segmentIdB?: SegmentId;
  endpointId?: EndpointId;
  guide?: SnapGuide;
};

export type LockState =
  | { kind: "none" }
  | { kind: "segment"; segmentId: SegmentId };

export type SnapPhase = "idle" | "p1" | "p2" | "length";

export type GeometryIndex = {
  pageIndex: number;
  imageWidthPx: number;
  imageHeightPx: number;
  /** PDF pt per PNG px (X). Used only for bake / diagnostics — snap is PNG Euclidean. */
  sx: number;
  /** PDF pt per PNG px (Y). */
  sy: number;
  pageWidthPt: number;
  pageHeightPt: number;
  segments: Segment[];
  endpoints: Endpoint[];
  segmentById: Map<SegmentId, Segment>;
  /** Color-fill polygons (PNG), separate from exploded snap edges. */
  fills: FillPoly[];
  /**
   * Overlay dots only: corners / T-junctions (endpoint degree ≥ 2) and
   * interior crossings. Dead-end endpoints and isolated ticks are omitted.
   */
  dots: Point[];
  dimTexts: DimTextPng[];
  empty: boolean;
  /** True when extract or client bake hit a segment budget. */
  truncated: boolean;
  /** Uniform grid over segment AABBs + endpoints. */
  spatial: SpatialGrid;
};

export type SpatialGrid = {
  cellSize: number;
  /** cellKey → segment ids */
  segmentCells: Map<string, SegmentId[]>;
  /** cellKey → endpoint ids */
  endpointCells: Map<string, EndpointId[]>;
  endpointsById: Map<EndpointId, Endpoint>;
};

export type SnapContext = {
  index: GeometryIndex;
  /** Cursor in PNG px (from clientToImage). */
  cursor: Point;
  /** Screen-space snap radius in CSS px (e.g. 10). */
  radiusScreenPx: number;
  /** Canvas zoom (image CSS size / natural PNG size). */
  zoom: number;
  phase: SnapPhase;
  p1?: Point;
  lock: LockState;
  enabledModes?: readonly SnapMode[];
  /** When true, skip snap (Alt bypass). */
  bypass?: boolean;
};
