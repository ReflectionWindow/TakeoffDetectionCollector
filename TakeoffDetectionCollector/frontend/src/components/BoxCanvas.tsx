import { useCallback, useEffect, useRef, useState } from "react";
import type { Box } from "../api/types";
import { classColor } from "../lib/classes";
import {
  isDrawGesture,
  pointInRect,
  resizeHandleAtPoint,
  resizeRect,
  type Rect,
  type ResizeHandle,
} from "../lib/geometry";
import { normalizeRegion, type BlackoutRegion } from "../lib/pageBlackouts";
import {
  EDGE_SNAP_CAPTURE_PX,
  EDGE_SNAP_RELEASE_PX,
  emptyMoveLock,
  querySnap,
  snapModelBoxes,
  snapMoveRect,
  snapRectEdges,
  snapResizeEdges,
  type EdgeLock,
  type GeometryIndex,
  type MoveLock,
} from "../lib/snap";

type Tool = "select" | "draw" | "blackout";

type Props = {
  imageWidth: number;
  imageHeight: number;
  canvas: HTMLCanvasElement | null;
  boxes: Box[];
  onBoxes: (boxes: Box[]) => void;
  geometryIndex: GeometryIndex | null;
  tool: Tool;
  className: string;
  blackouts: BlackoutRegion[];
  onBlackouts: (regions: BlackoutRegion[]) => void;
  selectedId: string | null;
  onSelectedId: (id: string | null) => void;
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
  selectedId,
  onSelectedId,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<Rect | null>(null);
  const dragRef = useRef<
    | { kind: "draw" | "blackout"; x: number; y: number; locks: Partial<Record<"w" | "e" | "n" | "s", EdgeLock>> }
    | { kind: "move"; id: string; x: number; y: number; ox1: number; oy1: number; lock: MoveLock }
    | { kind: "resize"; id: string; handle: ResizeHandle; x: number; y: number; rect: Rect; locks: Partial<Record<"w" | "e" | "n" | "s", EdgeLock>> }
    | { kind: "pan"; x: number; y: number; panX: number; panY: number }
    | null
  >(null);
  const snappedRef = useRef(false);
  const spaceRef = useRef(false);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceRef.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceRef.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  useEffect(() => {
    if (!geometryIndex || snappedRef.current) return;
    const { boxes: next, changed } = snapModelBoxes(boxes, geometryIndex);
    snappedRef.current = true;
    if (changed) onBoxes(next);
  }, [geometryIndex, boxes, onBoxes]);

  useEffect(() => {
    snappedRef.current = false;
  }, [geometryIndex]);

  const clientToImage = useCallback(
    (clientX: number, clientY: number) => {
      const el = wrapRef.current;
      if (!el) return { x: 0, y: 0 };
      const rect = el.getBoundingClientRect();
      return {
        x: (clientX - rect.left - pan.x) / zoom,
        y: (clientY - rect.top - pan.y) / zoom,
      };
    },
    [pan.x, pan.y, zoom],
  );

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const next = Math.min(8, Math.max(0.2, zoom * factor));
    const img = clientToImage(e.clientX, e.clientY);
    setPan({
      x: e.clientX - (wrapRef.current?.getBoundingClientRect().left ?? 0) - img.x * next,
      y: e.clientY - (wrapRef.current?.getBoundingClientRect().top ?? 0) - img.y * next,
    });
    setZoom(next);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const p = clientToImage(e.clientX, e.clientY);
    if (e.button === 1 || spaceRef.current) {
      dragRef.current = { kind: "pan", x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
      return;
    }
    if (e.button !== 0) return;
    if (tool === "draw" || tool === "blackout") {
      dragRef.current = { kind: tool, x: p.x, y: p.y, locks: {} };
      setDraft({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
      return;
    }
    const hit = [...boxes].reverse().find((b) => pointInRect(p.x, p.y, b));
    if (hit) {
      const handle = resizeHandleAtPoint(p, hit, zoom, 12);
      if (handle) {
        dragRef.current = {
          kind: "resize",
          id: hit.box_id,
          handle,
          x: p.x,
          y: p.y,
          rect: { x1: hit.x1, y1: hit.y1, x2: hit.x2, y2: hit.y2 },
          locks: {},
        };
      } else {
        dragRef.current = {
          kind: "move",
          id: hit.box_id,
          x: p.x,
          y: p.y,
          ox1: hit.x1,
          oy1: hit.y1,
          lock: emptyMoveLock(),
        };
      }
      onSelectedId(hit.box_id);
      return;
    }
    onSelectedId(null);
    dragRef.current = { kind: "pan", x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = clientToImage(e.clientX, e.clientY);
    setHover(p);
    const drag = dragRef.current;
    if (!drag) return;
    const bypass = e.altKey;
    if (drag.kind === "pan") {
      setPan({ x: drag.panX + e.clientX - drag.x, y: drag.panY + e.clientY - drag.y });
      return;
    }
    if (drag.kind === "draw" || drag.kind === "blackout") {
      let rect: Rect = { x1: drag.x, y1: drag.y, x2: p.x, y2: p.y };
      if (drag.kind === "draw" && geometryIndex) {
        const snapped = snapRectEdges(rect, geometryIndex, EDGE_SNAP_CAPTURE_PX, {
          zoom,
          releaseRadiusPx: EDGE_SNAP_RELEASE_PX,
          locks: drag.locks,
          bypass,
          minOverlapFraction: 0,
          minOverlapPx: 4,
        });
        rect = snapped.rect;
        drag.locks = snapped.locks;
      }
      setDraft(rect);
      return;
    }
    if (drag.kind === "move") {
      const w = boxes.find((b) => b.box_id === drag.id);
      if (!w) return;
      const width = w.x2 - w.x1;
      const height = w.y2 - w.y1;
      let rect: Rect = { x1: drag.ox1 + (p.x - drag.x), y1: drag.oy1 + (p.y - drag.y), x2: 0, y2: 0 };
      rect.x2 = rect.x1 + width;
      rect.y2 = rect.y1 + height;
      const snapped = snapMoveRect(rect, geometryIndex, EDGE_SNAP_CAPTURE_PX, {
        zoom,
        releaseRadiusPx: EDGE_SNAP_RELEASE_PX,
        lock: drag.lock,
        bypass,
        minOverlapFraction: 0,
        minOverlapPx: 4,
      });
      drag.lock = snapped.lock;
      onBoxes(
        boxes.map((b) =>
          b.box_id === drag.id ? { ...b, ...snapped.rect, edited: true, origin: "user" } : b,
        ),
      );
      return;
    }
    if (drag.kind === "resize") {
      let rect = resizeRect(drag.rect, drag.handle, p.x - drag.x, p.y - drag.y, imageWidth, imageHeight);
      const snapped = snapResizeEdges(rect, drag.handle, geometryIndex, EDGE_SNAP_CAPTURE_PX, {
        zoom,
        releaseRadiusPx: EDGE_SNAP_RELEASE_PX,
        locks: drag.locks,
        bypass,
        minOverlapFraction: 0,
        minOverlapPx: 4,
      });
      drag.locks = snapped.locks;
      onBoxes(
        boxes.map((b) =>
          b.box_id === drag.id ? { ...b, ...snapped.rect, edited: true, origin: "user" } : b,
        ),
      );
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.kind === "draw" && draft && isDrawGesture(drag.x, drag.y, draft.x2, draft.y2, zoom)) {
      const id = crypto.randomUUID();
      onBoxes([
        ...boxes,
        {
          box_id: id,
          ...draft,
          category_id: classNameToId(className),
          class_name: className,
          origin: "user",
          edited: true,
        },
      ]);
      onSelectedId(id);
    }
    if (drag.kind === "blackout" && draft && isDrawGesture(drag.x, drag.y, draft.x2, draft.y2, zoom)) {
      const region = normalizeRegion(draft, imageWidth, imageHeight);
      if (region) onBlackouts([...blackouts, region]);
    }
    setDraft(null);
    e.stopPropagation();
  };

  const snapDot = hover && geometryIndex
    ? querySnap({
        index: geometryIndex,
        cursor: hover,
        radiusScreenPx: 10,
        zoom,
        phase: "idle",
        lock: { kind: "none" },
        bypass: false,
      })
    : null;

  return (
    <div
      ref={wrapRef}
      className="stage"
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div
        className="stage-inner"
        style={{
          width: imageWidth,
          height: imageHeight,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        }}
      >
        {canvas ? <img alt="" src={canvas.toDataURL()} width={imageWidth} height={imageHeight} /> : (
          <div className="blank-sheet" style={{ width: imageWidth, height: imageHeight }} />
        )}
        <svg className="overlay" viewBox={`0 0 ${imageWidth} ${imageHeight}`}>
          {blackouts.map((r, i) => (
            <rect
              key={`b-${i}`}
              x={r.x1 * imageWidth}
              y={r.y1 * imageHeight}
              width={(r.x2 - r.x1) * imageWidth}
              height={(r.y2 - r.y1) * imageHeight}
              fill="rgba(17,17,17,0.55)"
              stroke="#111"
              strokeWidth={2 / zoom}
            />
          ))}
          {boxes.map((b) => (
            <rect
              key={b.box_id}
              x={b.x1}
              y={b.y1}
              width={b.x2 - b.x1}
              height={b.y2 - b.y1}
              fill="none"
              stroke={classColor(b.class_name ?? "")}
              strokeWidth={(selectedId === b.box_id ? 3 : 2) / zoom}
            />
          ))}
          {draft ? (
            <rect
              x={Math.min(draft.x1, draft.x2)}
              y={Math.min(draft.y1, draft.y2)}
              width={Math.abs(draft.x2 - draft.x1)}
              height={Math.abs(draft.y2 - draft.y1)}
              fill="none"
              stroke="#111"
              strokeDasharray={`${6 / zoom} ${4 / zoom}`}
              strokeWidth={2 / zoom}
            />
          ) : null}
          {snapDot ? (
            <circle cx={snapDot.point.x} cy={snapDot.point.y} r={4 / zoom} fill="#22c55e" />
          ) : null}
        </svg>
      </div>
    </div>
  );
}

function classNameToId(name: string): number {
  const map: Record<string, number> = {
    PW: 1, SF: 2, WW: 3, CW: 4, "SF/CW": 5, LOUVER: 6, METAL_PANEL: 7, LOUVER_SOFT: 8, METAL_PANEL_SOFT: 9,
  };
  return map[name] ?? 3;
}
