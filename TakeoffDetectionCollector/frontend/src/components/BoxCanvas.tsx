import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Box, PolyPoint } from "../api/types";
import { classColor, classNameToId } from "../lib/classes";
import {
  boxesInRect,
  distToSegment,
  edgeMidpoints,
  insertVertex,
  isDrawGesture,
  MIN_POLY_POINTS,
  nearestEdge,
  nearestMidpoint,
  nearestVertex,
  pointInPolygon,
  pointsOf,
  quadFromRect,
  removeVertex,
  resizeHandleAtPoint,
  resizeRect,
  withAABB,
  type Rect,
  type ResizeHandle,
} from "../lib/geometry";
import {
  hitRegionIndex,
  normalizeRegion,
  regionToRect,
  translateRegion,
  type BlackoutRegion,
} from "../lib/pageBlackouts";
import {
  DEFAULT_ADJUST_SNAP,
  EDGE_SNAP_CAPTURE_PX,
  activeSnapMark,
  overlayViewRect,
  queryAdjustSnap,
  querySnap,
  snapResizeEdges,
  VECTOR_OVERLAY_COLOR,
  vectorOverlayPaths,
  type ActiveSnapMark,
  type AdjustSnap,
  type GeometryIndex,
} from "../lib/snap";
import { MAX_ZOOM, MIN_ZOOM, applyWheel, fitTransform, zoomAbout, type Viewport } from "../lib/viewport";
import { duplicateBoxes } from "../lib/boxCopy";
import SheetLayer from "./SheetLayer";

export type CanvasTool = "select" | "draw" | "blackout" | "pan";

const NO_SNAP: AdjustSnap = { line: false, point: false };
const GEOMETRY_STROKE = "#6ea8ff";

function aabbOf(pts: PolyPoint[]): Rect {
  let x1 = pts[0]!.x;
  let y1 = pts[0]!.y;
  let x2 = x1;
  let y2 = y1;
  for (const p of pts) {
    if (p.x < x1) x1 = p.x;
    if (p.y < y1) y1 = p.y;
    if (p.x > x2) x2 = p.x;
    if (p.y > y2) y2 = p.y;
  }
  return { x1, y1, x2, y2 };
}

/** Map a quad edge to an AABB handle so drag uses parallel-edge snap, not nearest-point. */
function polyEdgeAsHandle(pts: PolyPoint[], index: number): ResizeHandle | null {
  if (pts.length !== 4) return null;
  const a = pts[index]!;
  const b = pts[(index + 1) % pts.length]!;
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  if (dx < 1e-3 && dy > 1e-3) {
    const minX = Math.min(pts[0]!.x, pts[1]!.x, pts[2]!.x, pts[3]!.x);
    return Math.abs(a.x - minX) < 1e-3 ? "w" : "e";
  }
  if (dy < 1e-3 && dx > 1e-3) {
    const minY = Math.min(pts[0]!.y, pts[1]!.y, pts[2]!.y, pts[3]!.y);
    return Math.abs(a.y - minY) < 1e-3 ? "n" : "s";
  }
  return null;
}

function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

type Props = {
  imageWidth: number;
  imageHeight: number;
  canvas: HTMLCanvasElement | null;
  boxes: Box[];
  onBoxes: (boxes: Box[]) => void;
  geometryIndex: GeometryIndex | null;
  tool: CanvasTool;
  className: string;
  blackouts: BlackoutRegion[];
  onBlackouts: (regions: BlackoutRegion[]) => void;
  selectedBlackoutIndex?: number | null;
  onSelectedBlackoutIndex?: (index: number | null) => void;
  selectedIds: string[];
  onSelectedIds: (ids: string[]) => void;
  commentedIds?: string[];
  adjustSnap?: AdjustSnap;
  readOnly?: boolean;
  /** Labelling and blackout steps keep shapes selectable but not editable. */
  geometryLocked?: boolean;
  /** Blackout is freehand redaction, so the snap engine stays out of the way. */
  snapping?: boolean;
  /** Hide opening geometry during the blackout step. */
  showBoxes?: boolean;
  /** Class tags stay off until the labels step. */
  showLabels?: boolean;
  /** Only the blackout step can create, move, or resize cover regions. */
  editBlackouts?: boolean;
  /** Labels step: shift-click and marquee select a group. */
  multiSelect?: boolean;
  /** Changing this refits the sheet — one value per job/page. */
  fitKey?: string;
};

export default function BoxCanvas({
  imageWidth,
  imageHeight,
  canvas,
  boxes,
  onBoxes,
  geometryIndex,
  tool,
  className,
  blackouts,
  onBlackouts,
  selectedBlackoutIndex = null,
  onSelectedBlackoutIndex,
  selectedIds,
  onSelectedIds,
  commentedIds = [],
  adjustSnap = DEFAULT_ADJUST_SNAP,
  readOnly = false,
  geometryLocked = false,
  snapping = true,
  showBoxes = true,
  showLabels = true,
  editBlackouts = false,
  multiSelect = false,
  fitKey = "",
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [viewSize, setViewSize] = useState({ w: 0, h: 0 });
  const snap = snapping ? adjustSnap : NO_SNAP;
  const [snapMark, setSnapMark] = useState<ActiveSnapMark | null>(null);
  const [hover, setHover] = useState<PolyPoint | null>(null);
  const [draftRect, setDraftRect] = useState<Rect | null>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [draftPoly, setDraftPoly] = useState<PolyPoint[]>([]);
  const [preview, setPreview] = useState<Box[] | null>(null);
  const [liveBlackouts, setLiveBlackouts] = useState<BlackoutRegion[] | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const dragRef = useRef<
    | { kind: "draw" | "blackout"; x: number; y: number }
    | { kind: "move"; id: string; x: number; y: number; points: PolyPoint[] }
    | { kind: "copy-move"; x: number; y: number; copies: Box[]; base: Box[]; sourceIds: string[] }
    | { kind: "vertex"; id: string; index: number; points: PolyPoint[] }
    | { kind: "edge"; id: string; index: number; x: number; y: number; points: PolyPoint[] }
    | { kind: "blackout-move"; index: number; x: number; y: number; region: BlackoutRegion }
    | { kind: "blackout-resize"; index: number; handle: ResizeHandle; x: number; y: number; region: BlackoutRegion }
    | { kind: "marquee"; x: number; y: number; additive: boolean }
    | { kind: "pan"; x: number; y: number; panX: number; panY: number }
    | null
  >(null);
  const viewRef = useRef<Viewport>({ zoom: 1, panX: 0, panY: 0 });
  const previewRef = useRef<Box[] | null>(null);
  const liveBlackoutsRef = useRef<BlackoutRegion[] | null>(null);
  const hoverRef = useRef<PolyPoint | null>(null);
  const snapRafRef = useRef(0);
  const sizeRef = useRef({ imageWidth, imageHeight });
  sizeRef.current = { imageWidth, imageHeight };

  const shown = preview ?? boxes;
  const shownBlackouts = liveBlackouts ?? blackouts;
  const selectedSet = new Set(selectedIds);
  const commentedSet = new Set(commentedIds);
  const vectorOverlay = useMemo(() => {
    if (!geometryIndex || viewSize.w <= 0 || viewSize.h <= 0) return null;
    return vectorOverlayPaths(
      geometryIndex,
      overlayViewRect(pan.x, pan.y, zoom, viewSize.w, viewSize.h),
      zoom,
    );
  }, [geometryIndex, zoom, pan.x, pan.y, viewSize.w, viewSize.h]);

  useEffect(() => {
    previewRef.current = null;
    setPreview(null);
  }, [boxes]);

  useEffect(() => {
    liveBlackoutsRef.current = null;
    setLiveBlackouts(null);
  }, [blackouts]);

  useEffect(() => {
    if (tool === "draw") return;
    setDraftPoly([]);
    setHover(null);
    setDraftRect(null);
    const drag = dragRef.current;
    if (drag?.kind === "draw" || drag?.kind === "blackout") dragRef.current = null;
  }, [tool]);

  const applyView = useCallback((v: Viewport) => {
    viewRef.current = v;
    setZoom(v.zoom);
    setPan({ x: v.panX, y: v.panY });
  }, []);

  useEffect(() => {
    viewRef.current = { zoom, panX: pan.x, panY: pan.y };
  }, [zoom, pan.x, pan.y]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        if (!e.repeat) setSpaceDown(true);
        if (e.target === document.body) e.preventDefault();
      }
      if ((e.key === "Enter" || e.key === "Escape") && draftPoly.length) {
        if (e.key === "Enter" && draftPoly.length >= 3) commitPoly(draftPoly);
        setDraftPoly([]);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceDown(false);
    };
    const onBlur = () => setSpaceDown(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", onBlur);
    };
  }, [draftPoly, boxes, className]);

  const clientToImage = useCallback((clientX: number, clientY: number) => {
    const el = wrapRef.current;
    const view = viewRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return {
      x: (clientX - rect.left - view.panX) / view.zoom,
      y: (clientY - rect.top - view.panY) / view.zoom,
    };
  }, []);

  function showSnap(hit: Parameters<typeof activeSnapMark>[0]) {
    setSnapMark(activeSnapMark(hit, geometryIndex));
  }

  function snapPoint(p: PolyPoint, bypass: boolean): PolyPoint {
    if ((!snap.point && !snap.line) || !geometryIndex) {
      if (bypass) setSnapMark(null);
      return p;
    }
    const hit = queryAdjustSnap(geometryIndex, p, viewRef.current.zoom, bypass, snap);
    showSnap(hit);
    return hit?.point ?? p;
  }

  function setLive(next: Box[]) {
    previewRef.current = next;
    setPreview(next);
  }

  function setBlackoutLive(next: BlackoutRegion[]) {
    liveBlackoutsRef.current = next;
    setLiveBlackouts(next);
  }

  function commitPoints(id: string, points: PolyPoint[]) {
    const next = shown.map((b) => (b.box_id === id ? withAABB({ ...b, edited: true, origin: "user" as const }, points) : b));
    onBoxes(next);
  }

  function commitPoly(points: PolyPoint[]) {
    if (points.length < 3) return;
    const id = crypto.randomUUID();
    const box = withAABB(
      {
        box_id: id,
        points,
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 0,
        category_id: classNameToId(className),
        class_name: className,
        origin: "user" as const,
        edited: true,
      },
      points,
    );
    onBoxes([...shown, box]);
    onSelectedIds([id]);
  }

  const fitToView = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const { imageWidth: w, imageHeight: h } = sizeRef.current;
    applyView(fitTransform(w, h, rect.width, rect.height));
  }, [applyView]);

  useEffect(() => {
    fitToView();
  }, [fitToView, fitKey]);

  const touchedRef = useRef(false);
  useEffect(() => {
    touchedRef.current = false;
  }, [fitKey, imageWidth, imageHeight]);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setViewSize({ w: r.width, h: r.height });
      if (!touchedRef.current) fitToView();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitToView]);

  const zoomBy = useCallback(
    (factor: number) => {
      const el = wrapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const view = viewRef.current;
      touchedRef.current = true;
      applyView(zoomAbout(view, view.zoom * factor, rect.width / 2, rect.height / 2));
    },
    [applyView],
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      touchedRef.current = true;
      applyView(applyWheel(viewRef.current, e, e.clientX - rect.left, e.clientY - rect.top));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyView]);

  function scheduleSnapCursor(p: PolyPoint) {
    hoverRef.current = p;
    if (snapRafRef.current) return;
    snapRafRef.current = requestAnimationFrame(() => {
      snapRafRef.current = 0;
      const cursor = hoverRef.current;
      if (dragRef.current || !cursor || !geometryIndex || (!snap.point && !snap.line)) {
        if (!dragRef.current) setSnapMark(null);
        return;
      }
      const z = viewRef.current.zoom;
      showSnap(queryAdjustSnap(geometryIndex, cursor, z, false, snap));
    });
  }

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const p = clientToImage(e.clientX, e.clientY);
    const view = viewRef.current;
    if (e.button === 1 || spaceDown || tool === "pan") {
      dragRef.current = { kind: "pan", x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY };
      return;
    }
    if (e.button !== 0) return;
    if (readOnly) {
      dragRef.current = { kind: "pan", x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY };
      return;
    }
    if (editBlackouts && (tool === "blackout" || tool === "select")) {
      const selectedRegion = selectedBlackoutIndex != null ? shownBlackouts[selectedBlackoutIndex] : null;
      if (selectedRegion) {
        const handle = resizeHandleAtPoint(p, regionToRect(selectedRegion, imageWidth, imageHeight), view.zoom, 14);
        if (handle) {
          dragRef.current = {
            kind: "blackout-resize",
            index: selectedBlackoutIndex!,
            handle,
            x: p.x,
            y: p.y,
            region: selectedRegion,
          };
          return;
        }
      }
      const hit = hitRegionIndex(p, shownBlackouts, imageWidth, imageHeight);
      if (hit >= 0) {
        onSelectedBlackoutIndex?.(hit);
        onSelectedIds([]);
        dragRef.current = {
          kind: "blackout-move",
          index: hit,
          x: p.x,
          y: p.y,
          region: shownBlackouts[hit]!,
        };
        return;
      }
      onSelectedBlackoutIndex?.(null);
    }
    if (!geometryLocked && e.altKey && showBoxes) {
      const hitBox = [...shown].reverse().find((b) => pointInPolygon(p.x, p.y, pointsOf(b)));
      if (hitBox) {
        const source = selectedIds.includes(hitBox.box_id)
          ? shown.filter((b) => selectedIds.includes(b.box_id))
          : [hitBox];
        const copies = duplicateBoxes(source, 0, 0);
        if (copies.length) {
          onSelectedIds(copies.map((c) => c.box_id));
          dragRef.current = {
            kind: "copy-move",
            x: p.x,
            y: p.y,
            copies,
            base: boxes,
            sourceIds: source.map((b) => b.box_id),
          };
          setLive([...boxes, ...copies]);
          return;
        }
      }
    }
    if (tool === "draw" || tool === "blackout") {
      dragRef.current = { kind: tool, x: p.x, y: p.y };
      setDraftRect({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
      return;
    }
    const hitPx = 10 / view.zoom;
    const primaryId = selectedIds.length === 1 ? selectedIds[0] : null;
    const selected = geometryLocked || !showBoxes ? undefined : shown.find((b) => b.box_id === primaryId);
    if (selected) {
      const pts = pointsOf(selected);
      const vi = nearestVertex(p, pts, hitPx);
      if (vi >= 0) {
        dragRef.current = { kind: "vertex", id: selected.box_id, index: vi, points: pts };
        return;
      }
      const mi = nearestMidpoint(p, pts, hitPx);
      if (mi >= 0) {
        const split = insertVertex(pts, mi, edgeMidpoints(pts)[mi]!);
        dragRef.current = { kind: "vertex", id: selected.box_id, index: mi + 1, points: split };
        setLive(shown.map((b) => (b.box_id === selected.box_id ? withAABB({ ...b, edited: true, origin: "user" as const }, split) : b)));
        return;
      }
      const ei = nearestEdge(p, pts, hitPx);
      if (ei >= 0) {
        dragRef.current = { kind: "edge", id: selected.box_id, index: ei, x: p.x, y: p.y, points: pts };
        return;
      }
    }
    const hit = showBoxes ? [...shown].reverse().find((b) => pointInPolygon(p.x, p.y, pointsOf(b))) : undefined;
    if (hit) {
      if (multiSelect && e.shiftKey) onSelectedIds(toggleId(selectedIds, hit.box_id));
      else onSelectedIds([hit.box_id]);
      if (!geometryLocked) {
        dragRef.current = { kind: "move", id: hit.box_id, x: p.x, y: p.y, points: pointsOf(hit) };
        return;
      }
      dragRef.current = null;
      return;
    }
    if (multiSelect && tool === "select") {
      dragRef.current = { kind: "marquee", x: p.x, y: p.y, additive: e.shiftKey };
      setMarquee({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
      if (!e.shiftKey) onSelectedIds([]);
      return;
    }
    onSelectedIds([]);
    dragRef.current = { kind: "pan", x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY };
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (readOnly || geometryLocked || tool !== "select" || !showBoxes) return;
    const target = shown.find((b) => b.box_id === selectedIds[0]);
    if (!target || selectedIds.length !== 1) return;
    const p = clientToImage(e.clientX, e.clientY);
    const hitPx = 10 / viewRef.current.zoom;
    const pts = pointsOf(target);

    const vi = nearestVertex(p, pts, hitPx);
    if (vi >= 0) {
      if (pts.length > MIN_POLY_POINTS) commitPoints(target.box_id, removeVertex(pts, vi));
      e.preventDefault();
      return;
    }
    const ei = nearestEdge(p, pts, hitPx);
    if (ei >= 0) {
      const a = pts[ei]!;
      const b = pts[(ei + 1) % pts.length]!;
      const at = snapPoint(distToSegment(p, a, b).point, e.altKey);
      commitPoints(target.box_id, insertVertex(pts, ei, at));
      e.preventDefault();
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = clientToImage(e.clientX, e.clientY);
    if (draftPoly.length) setHover(p);
    scheduleSnapCursor(p);
    const drag = dragRef.current;
    if (!drag) return;
    const bypass = e.altKey;
    const z = viewRef.current.zoom;
    if (drag.kind === "pan") {
      touchedRef.current = true;
      applyView({
        zoom: z,
        panX: drag.panX + e.clientX - drag.x,
        panY: drag.panY + e.clientY - drag.y,
      });
      return;
    }
    if (drag.kind === "draw" || drag.kind === "blackout") {
      let rect: Rect = { x1: drag.x, y1: drag.y, x2: p.x, y2: p.y };
      if (drag.kind === "draw" && snap.point) {
        const hit = snapPoint({ x: p.x, y: p.y }, bypass);
        rect = { ...rect, x2: hit.x, y2: hit.y };
      }
      setDraftRect(rect);
      return;
    }
    if (drag.kind === "marquee") {
      setMarquee({ x1: drag.x, y1: drag.y, x2: p.x, y2: p.y });
      return;
    }
    if (drag.kind === "blackout-move") {
      const dx = (p.x - drag.x) / imageWidth;
      const dy = (p.y - drag.y) / imageHeight;
      setBlackoutLive(blackouts.map((r, i) => (i === drag.index ? translateRegion(drag.region, dx, dy) : r)));
      return;
    }
    if (drag.kind === "blackout-resize") {
      const dx = p.x - drag.x;
      const dy = p.y - drag.y;
      const resized = resizeRect(regionToRect(drag.region, imageWidth, imageHeight), drag.handle, dx, dy, imageWidth, imageHeight);
      const next = normalizeRegion(resized, imageWidth, imageHeight);
      if (next) {
        setBlackoutLive(blackouts.map((r, i) => (i === drag.index ? next : r)));
      }
      return;
    }
    if (drag.kind === "move" || drag.kind === "copy-move") {
      const dx = p.x - drag.x;
      const dy = p.y - drag.y;
      const shiftPts = (pts: PolyPoint[]) => {
        let next = pts.map((pt) => ({ x: pt.x + dx, y: pt.y + dy }));
        if ((snap.point || snap.line) && geometryIndex) {
          let best: { dx: number; dy: number; d: number; hit: NonNullable<ReturnType<typeof queryAdjustSnap>> } | null = null;
          for (const pt of next) {
            const hit = queryAdjustSnap(geometryIndex, pt, z, bypass, snap);
            if (!hit) continue;
            if (!best || hit.distPx < best.d) {
              best = { dx: hit.point.x - pt.x, dy: hit.point.y - pt.y, d: hit.distPx, hit };
            }
          }
          if (best) {
            next = next.map((pt) => ({ x: pt.x + best!.dx, y: pt.y + best!.dy }));
            showSnap(best.hit);
          } else showSnap(null);
        }
        return next;
      };
      if (drag.kind === "copy-move") {
        const moved = drag.copies.map((b) => withAABB({ ...b, edited: true, origin: "user" as const }, shiftPts(pointsOf(b))));
        setLive([...drag.base, ...moved]);
        return;
      }
      const pts = shiftPts(drag.points);
      setLive(shown.map((b) => (b.box_id === drag.id ? withAABB({ ...b, edited: true, origin: "user" as const }, pts) : b)));
      return;
    }
    if (drag.kind === "vertex") {
      const pts = drag.points.map((pt, i) => (i === drag.index ? snapPoint(p, bypass) : pt));
      setLive(shown.map((b) => (b.box_id === drag.id ? withAABB({ ...b, edited: true, origin: "user" as const }, pts) : b)));
      return;
    }
    if (drag.kind === "edge") {
      const dx = p.x - drag.x;
      const dy = p.y - drag.y;
      const i0 = drag.index;
      const i1 = (drag.index + 1) % drag.points.length;
      let pts = drag.points.map((pt, i) => (i === i0 || i === i1 ? { x: pt.x + dx, y: pt.y + dy } : pt));
      if (snap.line && geometryIndex && !bypass) {
        const handle = polyEdgeAsHandle(drag.points, i0);
        if (handle) {
          const out = snapResizeEdges(aabbOf(pts), handle, geometryIndex, EDGE_SNAP_CAPTURE_PX, { zoom: z });
          pts = quadFromRect(out.rect);
          const edgeHit = out.hits[0];
          showSnap(
            edgeHit
              ? {
                  mode: "nearest",
                  point: edgeHit.point,
                  distPx: edgeHit.distPx,
                  screenDistPx: edgeHit.distPx * z,
                  segmentId: edgeHit.segmentId,
                  guide: { kind: "segment", a: edgeHit.segment.a, b: edgeHit.segment.b },
                }
              : null,
          );
        } else {
          const a = pts[i0]!;
          const mid = { x: (a.x + pts[i1]!.x) / 2, y: (a.y + pts[i1]!.y) / 2 };
          const hit = querySnap({
            index: geometryIndex,
            cursor: mid,
            radiusScreenPx: EDGE_SNAP_CAPTURE_PX,
            zoom: z,
            phase: "idle",
            lock: { kind: "none" },
            bypass,
          });
          showSnap(hit);
          if (hit) {
            const ox = hit.point.x - mid.x;
            const oy = hit.point.y - mid.y;
            pts = pts.map((pt, i) => (i === i0 || i === i1 ? { x: pt.x + ox, y: pt.y + oy } : pt));
          }
        }
      } else {
        showSnap(null);
      }
      setLive(shown.map((b) => (b.box_id === drag.id ? withAABB({ ...b, edited: true, origin: "user" as const }, pts) : b)));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.kind === "copy-move") {
      const p = clientToImage(e.clientX, e.clientY);
      const moved = Math.hypot(p.x - drag.x, p.y - drag.y) * viewRef.current.zoom >= 4;
      const live = previewRef.current;
      if (moved && live) onBoxes(live);
      else {
        previewRef.current = null;
        setPreview(null);
        onSelectedIds(drag.sourceIds);
      }
      e.stopPropagation();
      return;
    }
    if (drag.kind === "move" || drag.kind === "vertex" || drag.kind === "edge") {
      const live = previewRef.current;
      if (live) onBoxes(live);
      e.stopPropagation();
      return;
    }
    if (drag.kind === "blackout-move" || drag.kind === "blackout-resize") {
      const live = liveBlackoutsRef.current;
      if (live) onBlackouts(live);
      liveBlackoutsRef.current = null;
      setLiveBlackouts(null);
      e.stopPropagation();
      return;
    }
    if (drag.kind === "marquee" && marquee) {
      const ids = boxesInRect(shown, marquee);
      if (ids.length || Math.hypot(marquee.x2 - drag.x, marquee.y2 - drag.y) * viewRef.current.zoom >= 8) {
        onSelectedIds(drag.additive ? [...new Set([...selectedIds, ...ids])] : ids);
      }
      setMarquee(null);
      e.stopPropagation();
      return;
    }
    if (drag.kind === "draw" && draftRect) {
      if (isDrawGesture(drag.x, drag.y, draftRect.x2, draftRect.y2, viewRef.current.zoom)) {
        const a = snapPoint({ x: draftRect.x1, y: draftRect.y1 }, e.altKey);
        const b = snapPoint({ x: draftRect.x2, y: draftRect.y2 }, e.altKey);
        commitPoly(quadFromRect({ x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
        setDraftPoly([]);
      } else if (tool === "draw") {
        const p = snapPoint({ x: draftRect.x2, y: draftRect.y2 }, e.altKey);
        if (draftPoly.length >= 3) {
          const first = draftPoly[0]!;
          if (Math.hypot(p.x - first.x, p.y - first.y) * viewRef.current.zoom <= 10) {
            commitPoly(draftPoly);
            setDraftPoly([]);
            setDraftRect(null);
            e.stopPropagation();
            return;
          }
        }
        setDraftPoly((prev) => [...prev, p]);
      }
    }
    if (drag.kind === "blackout" && draftRect && isDrawGesture(drag.x, drag.y, draftRect.x2, draftRect.y2, viewRef.current.zoom)) {
      const region = normalizeRegion(draftRect, imageWidth, imageHeight);
      if (region) {
        onBlackouts([...blackouts, region]);
        onSelectedBlackoutIndex?.(blackouts.length);
      }
    }
    setDraftRect(null);
    e.stopPropagation();
  };

  const livePoly = draftPoly.length ? (hover ? [...draftPoly, hover] : draftPoly) : null;

  const stageClass = [
    "stage",
    tool === "blackout" || tool === "draw" ? "draw-mode" : "",
    tool === "pan" || spaceDown ? "pan-mode" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={wrapRef}
      className={stageClass}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        if (!dragRef.current) setSnapMark(null);
      }}
      onDoubleClick={onDoubleClick}
    >
      <div className="zoom-controls instrument-chrome" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" onClick={fitToView} title="Fit whole sheet">
          Fit
        </button>
        <button type="button" onClick={() => zoomBy(1 / 1.25)} disabled={zoom <= MIN_ZOOM} title="Zoom out">
          −
        </button>
        <span className="zoom-level">{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => zoomBy(1.25)} disabled={zoom >= MAX_ZOOM} title="Zoom in">
          +
        </button>
        <button
          type="button"
          onClick={() => {
            const el = wrapRef.current;
            if (!el) return;
            const rect = el.getBoundingClientRect();
            touchedRef.current = true;
            applyView(zoomAbout(viewRef.current, 1, rect.width / 2, rect.height / 2));
          }}
          title="Actual size"
        >
          100%
        </button>
      </div>
      <div
        className="stage-inner"
        style={{
          width: imageWidth * zoom,
          height: imageHeight * zoom,
          transform: `translate(${pan.x}px, ${pan.y}px)`,
        }}
      >
        {canvas ? (
          <SheetLayer canvas={canvas} zoom={zoom} />
        ) : (
          <div className="blank-sheet" />
        )}
        <svg className="overlay" viewBox={`0 0 ${imageWidth} ${imageHeight}`}>
          {vectorOverlay?.lines ? (
            <path
              className="vector-overlay"
              d={vectorOverlay.lines}
              fill="none"
              stroke={VECTOR_OVERLAY_COLOR}
              strokeWidth={1.25 / zoom}
              strokeLinecap="square"
            />
          ) : null}
          {vectorOverlay?.crosses ? (
            <path
              className="vector-overlay"
              d={vectorOverlay.crosses}
              fill="none"
              stroke={VECTOR_OVERLAY_COLOR}
              strokeWidth={1.4 / zoom}
              strokeLinecap="square"
            />
          ) : null}
          {vectorOverlay?.dots ? (
            <path className="vector-overlay" d={vectorOverlay.dots} fill={VECTOR_OVERLAY_COLOR} />
          ) : null}
          {shownBlackouts.map((r, i) => {
            const selected = selectedBlackoutIndex === i;
            const rect = regionToRect(r, imageWidth, imageHeight);
            return (
              <g key={`b-${i}`}>
                <rect
                  x={rect.x1}
                  y={rect.y1}
                  width={rect.x2 - rect.x1}
                  height={rect.y2 - rect.y1}
                  fill={selected ? "rgba(17,17,17,0.7)" : "rgba(17,17,17,0.55)"}
                  stroke={selected ? GEOMETRY_STROKE : "#111"}
                  strokeWidth={(selected ? 3.5 : 2) / zoom}
                />
                {selected && editBlackouts
                  ? (["nw", "ne", "se", "sw"] as const).map((handle) => {
                      const cx = handle.includes("w") ? rect.x1 : rect.x2;
                      const cy = handle.includes("n") ? rect.y1 : rect.y2;
                      return (
                        <rect
                          key={handle}
                          x={cx - 4 / zoom}
                          y={cy - 4 / zoom}
                          width={8 / zoom}
                          height={8 / zoom}
                          fill="#fff"
                          stroke={GEOMETRY_STROKE}
                          strokeWidth={1.5 / zoom}
                        />
                      );
                    })
                  : null}
              </g>
            );
          })}
          {showBoxes
            ? shown.map((b) => {
                const pts = pointsOf(b);
                const color = showLabels ? classColor(b.class_name ?? "") : GEOMETRY_STROKE;
                const selected = selectedSet.has(b.box_id);
                const name = b.class_name ?? "";
                const wPx = (b.x2 - b.x1) * zoom;
                const showTag = showLabels && name.length > 0 && (selected || wPx > 26);
                const fs = 11 / zoom;
                const padX = 5 / zoom;
                const tagW = name.length * fs * 0.62 + padX * 2;
                const tagH = fs + 6 / zoom;
                const tagY = b.y1 - tagH - 2 / zoom;
                const d = pts.map((pt, i) => `${i === 0 ? "M" : "L"} ${pt.x} ${pt.y}`).join(" ") + " Z";
                return (
                  <g key={b.box_id}>
                    <path
                      d={d}
                      fill={selected ? `${color}22` : "none"}
                      stroke={color}
                      strokeWidth={(selected ? 3.5 : 2) / zoom}
                    />
                    {selected && !geometryLocked
                      ? edgeMidpoints(pts).map((pt, i) => (
                          <circle
                            key={`m-${i}`}
                            cx={pt.x}
                            cy={pt.y}
                            r={3 / zoom}
                            fill="#fff"
                            fillOpacity={0.5}
                            stroke={color}
                            strokeWidth={1 / zoom}
                            strokeDasharray={`${2 / zoom} ${1.5 / zoom}`}
                          />
                        ))
                      : null}
                    {selected && !geometryLocked
                      ? pts.map((pt, i) => (
                          <circle key={i} cx={pt.x} cy={pt.y} r={4 / zoom} fill="#fff" stroke={color} strokeWidth={1.5 / zoom} />
                        ))
                      : null}
                    {showTag ? (
                      <g>
                        <rect x={b.x1} y={tagY} width={tagW} height={tagH} rx={4 / zoom} fill={color} opacity={selected ? 1 : 0.92} />
                        <text className="box-label" x={b.x1 + padX} y={tagY + tagH - 4.5 / zoom} fontSize={fs} fill="#fff">
                          {name}
                        </text>
                      </g>
                    ) : null}
                    {commentedSet.has(b.box_id) ? (
                      <circle
                        cx={b.x2 - 5 / zoom}
                        cy={b.y1 + 5 / zoom}
                        r={4.5 / zoom}
                        fill="#f5c518"
                        stroke="#8a6a00"
                        strokeWidth={1 / zoom}
                      />
                    ) : null}
                  </g>
                );
              })
            : null}
          {livePoly && livePoly.length >= 1 ? (
            <path
              d={livePoly.map((pt, i) => `${i === 0 ? "M" : "L"} ${pt.x} ${pt.y}`).join(" ")}
              fill="none"
              stroke="#111"
              strokeDasharray={`${6 / zoom} ${4 / zoom}`}
              strokeWidth={2 / zoom}
            />
          ) : null}
          {draftRect ? (
            <rect
              x={Math.min(draftRect.x1, draftRect.x2)}
              y={Math.min(draftRect.y1, draftRect.y2)}
              width={Math.abs(draftRect.x2 - draftRect.x1)}
              height={Math.abs(draftRect.y2 - draftRect.y1)}
              fill="none"
              stroke="#111"
              strokeDasharray={`${6 / zoom} ${4 / zoom}`}
              strokeWidth={2 / zoom}
            />
          ) : null}
          {marquee ? (
            <rect
              x={Math.min(marquee.x1, marquee.x2)}
              y={Math.min(marquee.y1, marquee.y2)}
              width={Math.abs(marquee.x2 - marquee.x1)}
              height={Math.abs(marquee.y2 - marquee.y1)}
              fill="rgba(110, 168, 255, 0.14)"
              stroke={GEOMETRY_STROKE}
              strokeDasharray={`${6 / zoom} ${4 / zoom}`}
              strokeWidth={1.5 / zoom}
            />
          ) : null}
          {snapMark?.a && snapMark.b ? (
            <path
              className="vector-overlay"
              d={`M ${snapMark.a.x} ${snapMark.a.y} L ${snapMark.b.x} ${snapMark.b.y}`}
              fill="none"
              stroke={VECTOR_OVERLAY_COLOR}
              strokeWidth={2.5 / zoom}
              strokeLinecap="round"
            />
          ) : null}
          {snapMark ? (
            <circle cx={snapMark.point.x} cy={snapMark.point.y} r={3.5 / zoom} fill={VECTOR_OVERLAY_COLOR} />
          ) : null}
        </svg>
      </div>
    </div>
  );
}
