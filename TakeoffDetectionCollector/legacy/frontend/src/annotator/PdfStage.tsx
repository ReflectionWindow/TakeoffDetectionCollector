import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { CLASSES, type ClassId, type Geometry, type Point, type Shape, type SnapResult, type Tool } from "../types";
import { renderPageToCanvas } from "./pdf";
import { SnapIndex, dist2, pointInPolygon } from "./snap";

const SNAP_PX = 12;
const CLOSE_PX = 12;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;

interface Props {
  pdf: PDFDocumentProxy;
  pageIndex: number;
  pageSize: { width: number; height: number };
  geometry: Geometry | null;
  shapes: Shape[];
  tool: Tool;
  classId: ClassId;
  showSnapDots: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onShapesChange: (shapes: Shape[]) => void;
  onZoomChange: (zoom: number) => void;
}

function newId(): string {
  return crypto.randomUUID();
}

function classColor(classId: number): string {
  return CLASSES.find((c) => c.id === classId)?.color ?? "#888";
}

export function PdfStage({
  pdf,
  pageIndex,
  pageSize,
  geometry,
  shapes,
  tool,
  classId,
  showSnapDots,
  selectedId,
  onSelect,
  onShapesChange,
  onZoomChange,
}: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 40, y: 40 });
  const [draft, setDraft] = useState<Point[]>([]);
  const [rectStart, setRectStart] = useState<Point | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [snap, setSnap] = useState<SnapResult | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [panning, setPanning] = useState(false);
  const panOrigin = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const renderGen = useRef(0);

  const snapIndex = useMemo(() => (geometry ? new SnapIndex(geometry) : null), [geometry]);

  const toPdf = useCallback(
    (clientX: number, clientY: number): Point | null => {
      const el = viewportRef.current;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: (clientX - r.left - pan.x) / zoom,
        y: (clientY - r.top - pan.y) / zoom,
      };
    },
    [pan.x, pan.y, zoom],
  );

  const applySnap = useCallback(
    (raw: Point, ortho: boolean): { point: Point; snap: SnapResult | null } => {
      const last = draft.length ? draft[draft.length - 1] : undefined;
      const radiusPdf = SNAP_PX / zoom;
      if (!snapIndex) return { point: raw, snap: null };
      const hit = snapIndex.snap(raw.x, raw.y, radiusPdf, last, ortho);
      if (hit) return { point: { x: hit.x, y: hit.y }, snap: hit };
      return { point: raw, snap: null };
    },
    [draft, snapIndex, zoom],
  );

  useEffect(() => {
    onZoomChange(zoom);
  }, [zoom, onZoomChange]);

  useEffect(() => {
    setDraft([]);
    setRectStart(null);
    setSnap(null);
    setCursor(null);
  }, [pageIndex]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gen = ++renderGen.current;
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.min(4, Math.max(1, zoom * dpr));
    const handle = window.setTimeout(() => {
      void renderPageToCanvas(pdf, pageIndex, scale, canvas).then(() => {
        if (renderGen.current !== gen) return;
      });
    }, 80);
    return () => window.clearTimeout(handle);
  }, [pdf, pageIndex, zoom]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        setSpaceDown(true);
      }
      if (e.key === "Escape") {
        setDraft([]);
        setRectStart(null);
        onSelect(null);
      }
      if (e.key === "Backspace" && draft.length) {
        e.preventDefault();
        setDraft((d) => d.slice(0, -1));
      }
      if (e.key === "Enter" && draft.length >= 3) {
        e.preventDefault();
        onShapesChange([...shapes, { id: newId(), classId, points: draft }]);
        setDraft([]);
        setSnap(null);
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId && draft.length === 0) {
        e.preventDefault();
        onShapesChange(shapes.filter((s) => s.id !== selectedId));
        onSelect(null);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceDown(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onUp);
    };
  }, [draft, selectedId, shapes, classId, onSelect, onShapesChange]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheelNative = (e: WheelEvent) => e.preventDefault();
    el.addEventListener("wheel", onWheelNative, { passive: false });
    return () => el.removeEventListener("wheel", onWheelNative);
  }, []);

  const commitPolygon = (points: Point[]) => {
    if (points.length < 3) return;
    onShapesChange([...shapes, { id: newId(), classId, points }]);
    setDraft([]);
    setSnap(null);
  };

  const commitRect = (a: Point, b: Point) => {
    if (Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1) {
      setRectStart(null);
      return;
    }
    const points: Point[] = [
      { x: a.x, y: a.y },
      { x: b.x, y: a.y },
      { x: b.x, y: b.y },
      { x: a.x, y: b.y },
    ];
    onShapesChange([...shapes, { id: newId(), classId, points }]);
    setRectStart(null);
    setSnap(null);
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const el = viewportRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
    setPan({
      x: mx - ((mx - pan.x) * next) / zoom,
      y: my - ((my - pan.y) * next) / zoom,
    });
    setZoom(next);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || e.button === 2 || spaceDown) {
      e.preventDefault();
      setPanning(true);
      panOrigin.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const raw = toPdf(e.clientX, e.clientY);
    if (!raw) return;
    const { point } = applySnap(raw, e.shiftKey);

    if (tool === "select") {
      const hit = [...shapes].reverse().find((s) => pointInPolygon(point, s.points));
      onSelect(hit ? hit.id : null);
      if (!hit) {
        setPanning(true);
        panOrigin.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }
      return;
    }

    if (tool === "rectangle") {
      setRectStart(point);
      setCursor(point);
      return;
    }

    if (tool === "polygon") {
      if (draft.length >= 3) {
        const first = draft[0];
        if (dist2(point, first) <= (CLOSE_PX / zoom) ** 2) {
          commitPolygon(draft);
          return;
        }
      }
      setDraft((d) => [...d, point]);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (panning) {
      setPan({
        x: panOrigin.current.panX + (e.clientX - panOrigin.current.x),
        y: panOrigin.current.panY + (e.clientY - panOrigin.current.y),
      });
      return;
    }
    const raw = toPdf(e.clientX, e.clientY);
    if (!raw) return;
    const { point, snap: hit } = applySnap(raw, e.shiftKey);
    setCursor(point);
    setSnap(hit);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (panning) {
      setPanning(false);
      return;
    }
    if (tool === "rectangle" && rectStart) {
      const raw = toPdf(e.clientX, e.clientY);
      if (!raw) {
        setRectStart(null);
        return;
      }
      const { point } = applySnap(raw, e.shiftKey);
      commitRect(rectStart, point);
    }
  };

  const pageW = pageSize.width;
  const pageH = pageSize.height;
  const cssW = pageW * zoom;
  const cssH = pageH * zoom;

  const draftPreview = useMemo(() => {
    if (tool === "rectangle" && rectStart && cursor) {
      return [rectStart, { x: cursor.x, y: rectStart.y }, cursor, { x: rectStart.x, y: cursor.y }];
    }
    if (tool === "polygon" && draft.length && cursor) return [...draft, cursor];
    return draft;
  }, [tool, rectStart, cursor, draft]);

  const visibleDots = useMemo(() => {
    if (!showSnapDots || !geometry) return [];
    const el = viewportRef.current;
    if (!el) return geometry.points.slice(0, 4000);
    const r = el.getBoundingClientRect();
    const minX = (0 - pan.x) / zoom;
    const minY = (0 - pan.y) / zoom;
    const maxX = (r.width - pan.x) / zoom;
    const maxY = (r.height - pan.y) / zoom;
    const out: [number, number][] = [];
    for (const p of geometry.points) {
      if (p[0] >= minX && p[0] <= maxX && p[1] >= minY && p[1] <= maxY) {
        out.push(p);
        if (out.length >= 6000) break;
      }
    }
    return out;
  }, [showSnapDots, geometry, pan.x, pan.y, zoom]);

  return (
    <div
      ref={viewportRef}
      className={`stage ${spaceDown || panning ? "panning" : ""}`}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="stage-world" style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}>
        <canvas ref={canvasRef} className="pdf-canvas" style={{ width: cssW, height: cssH }} />
        <svg
          className="overlay"
          width={cssW}
          height={cssH}
          viewBox={`0 0 ${pageW} ${pageH}`}
          pointerEvents="none"
        >
          {showSnapDots &&
            visibleDots.map((p, i) => (
              <circle key={i} cx={p[0]} cy={p[1]} r={1.2 / zoom} fill="#3d9eff" opacity={0.55} />
            ))}
          {shapes.map((s) => {
            const d = toPath(s.points);
            const selected = s.id === selectedId;
            return (
              <path
                key={s.id}
                d={d}
                fill={classColor(s.classId)}
                fillOpacity={selected ? 0.35 : 0.22}
                stroke={classColor(s.classId)}
                strokeWidth={(selected ? 2.4 : 1.4) / zoom}
              />
            );
          })}
          {draftPreview.length > 0 && (
            <path
              d={toPath(draftPreview, tool === "polygon" && draft.length < 3)}
              fill={classColor(classId)}
              fillOpacity={draftPreview.length > 2 ? 0.18 : 0}
              stroke={classColor(classId)}
              strokeWidth={1.6 / zoom}
              strokeDasharray={`${4 / zoom} ${3 / zoom}`}
            />
          )}
          {draft.map((p, i) => (
            <rect
              key={i}
              x={p.x - 3.5 / zoom}
              y={p.y - 3.5 / zoom}
              width={7 / zoom}
              height={7 / zoom}
              fill="#111318"
              stroke={classColor(classId)}
              strokeWidth={1.4 / zoom}
            />
          ))}
          {snap && cursor && (
            <g>
              {snap.kind === "vertex" ? (
                <rect
                  x={snap.x - 5 / zoom}
                  y={snap.y - 5 / zoom}
                  width={10 / zoom}
                  height={10 / zoom}
                  fill="none"
                  stroke="#19e6c8"
                  strokeWidth={2 / zoom}
                />
              ) : (
                <polygon
                  points={tickPoints(snap.x, snap.y, 7 / zoom)}
                  fill="none"
                  stroke="#19e6c8"
                  strokeWidth={2 / zoom}
                />
              )}
            </g>
          )}
        </svg>
      </div>
    </div>
  );
}

function toPath(points: Point[], open = false): string {
  if (!points.length) return "";
  const head = `M ${points[0].x} ${points[0].y}`;
  const rest = points
    .slice(1)
    .map((p) => `L ${p.x} ${p.y}`)
    .join(" ");
  return open ? `${head} ${rest}` : `${head} ${rest} Z`;
}

function tickPoints(x: number, y: number, s: number): string {
  return `${x},${y - s} ${x + s},${y} ${x},${y + s} ${x - s},${y}`;
}
