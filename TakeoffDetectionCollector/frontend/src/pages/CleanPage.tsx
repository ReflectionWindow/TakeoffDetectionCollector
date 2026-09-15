import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { Box, Job, PageComment, PageMeta, Revision, StoredBox } from "../api/types";
import AnnotationRail from "../components/AnnotationRail";
import BoxCanvas, { type CanvasTool } from "../components/BoxCanvas";
import BoxToolbar from "../components/BoxToolbar";
import JobTags from "../components/JobTags";
import ToolPalette from "../components/ToolPalette";
import { useAnnotationDraft } from "../hooks/useAnnotationDraft";
import {
  attachPdf,
  claimJob,
  createComment,
  deleteComment,
  downloadCoco,
  fetchPdf,
  getAnnotations,
  getBlackouts,
  getJob,
  heartbeatJob,
  listComments,
  listRevisions,
  listTags,
  me,
  putBlackouts,
  releaseJob,
  releaseJobOnUnload,
  revertAnnotations,
  saveAnnotations,
  setJobTags,
  setStage,
  SESSION_EXPIRED_MESSAGE,
  isSessionError,
} from "../lib/api";
import { CLASSES, classById } from "../lib/classes";
import { commentedBoxIds } from "../lib/comments";
import { displayToPt, overlayBoxPoints } from "../lib/coords";
import { pointsOf, polygonAABB } from "../lib/geometry";
import { BOX_COPY_OFFSET, duplicateBoxes } from "../lib/boxCopy";
import { markupSourceVersion, shouldRasterOverlay } from "../lib/revisions";
import { STAGE_LABEL, canEdit, normalizeStatus, statusActions } from "../lib/stages";
import { mergeCatalog } from "../lib/tags";
import type { BlackoutRegion } from "../lib/pageBlackouts";
import { loadPdfData, renderPageToCanvas } from "../lib/pdf";
import { SHEET_RENDER_SCALE, extractPageVectorsFromDoc } from "../lib/pdfVectors";
import {
  DEFAULT_ADJUST_SNAP,
  bakeGeometryIndex,
  geometryCacheKey,
  geometryHasOverlay,
  getCachedGeometryIndex,
  setCachedGeometryIndex,
  snapModelBoxes,
  type AdjustSnap,
  type GeometryIndex,
} from "../lib/snap";
import {
  STEPS,
  STEP_CONTINUE,
  STEP_HINT,
  STEP_LABEL,
  blackoutEnabled,
  boxesVisible,
  geometryLocked,
  labelsVisible,
  nextStep,
  parseStep,
  snapEnabled,
  stepIndex,
  type Step,
} from "../lib/workflow";

type BoxTool = "select" | "draw" | "pan";
type SheetEntry = {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  pageWidthPt: number;
  pageHeightPt: number;
};

function claimMessage(err: unknown): string {
  if (isSessionError(err)) return SESSION_EXPIRED_MESSAGE;
  const raw = (err instanceof Error ? err.message : String(err)).trim();
  const who = /claimed by (\S+@\S+)/i.exec(raw)?.[1];
  if (who) return `${who} has this sheet open.`;
  if (/claimed by /i.test(raw)) return "Someone else has this sheet open.";
  if (/not the claimant/i.test(raw)) return "Your hold on this sheet expired. Reopen it from the inbox.";
  if (/unauthorized/i.test(raw)) return SESSION_EXPIRED_MESSAGE;
  return raw;
}

function pageCacheKey(jobId: string, idx: number, w: number, h: number) {
  return `${jobId}:${idx}:${w}x${h}`;
}

const STEP_KEYS: Record<Step, string> = {
  blackout: "Scroll to pan · Pinch or ⌃scroll to zoom · Space-drag also pans · Drag a region to move it · Delete removes it · ⌘Z undo · ⇧⌘Z redo",
  boxes: "Select · Draw · Drag empty to group-select · Shift-click adds · Esc clears · ⌘C copy · ⌘V paste · ⌘D duplicate · Alt-drag stamps a copy · Scroll pans · Pinch or ⌃scroll zooms · ⌘Z undo · ⇧⌘Z redo",
  labels: "Drag across shapes to group-select · Shift-click adds · ⌘A all · Pick a class · Scroll pans · Pinch or ⌃scroll zooms · ⌘Z undo",
};

export default function CleanPage() {
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const step = parseStep(params.get("step"));
  const [job, setJob] = useState<Job | null>(null);
  const [pages, setPages] = useState<PageMeta[]>([]);
  const [pageIndex, setPageIndex] = useState(() => Number(params.get("page") ?? 0) || 0);
  const [stored, setStored] = useState<StoredBox[]>([]);
  const [version, setVersion] = useState(0);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [boxTool, setBoxTool] = useState<BoxTool>("draw");
  const [klass, setKlass] = useState("WW");
  const [blackouts, setBlackouts] = useState<BlackoutRegion[]>([]);
  const [index, setIndex] = useState<GeometryIndex | null>(null);
  const [sheet, setSheet] = useState<HTMLCanvasElement | null>(null);
  const [sheetPts, setSheetPts] = useState<{ widthPt: number; heightPt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [boxesHidden, setBoxesHidden] = useState(false);
  const [selectedBlackoutIndex, setSelectedBlackoutIndex] = useState<number | null>(null);
  const [blackoutUndo, setBlackoutUndo] = useState(0);
  const [blackoutRedo, setBlackoutRedo] = useState(0);
  const [adjustSnap, setAdjustSnap] = useState<AdjustSnap>(DEFAULT_ADJUST_SNAP);
  const [userId, setUserId] = useState("");
  const [lockNote, setLockNote] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [tagCatalog, setTagCatalog] = useState<string[]>([]);
  const [comments, setComments] = useState<PageComment[]>([]);
  const [postingComment, setPostingComment] = useState(false);
  const boxClipboard = useRef<{ boxes: Box[]; pasteCount: number }>({ boxes: [], pasteCount: 0 });

  const page = pages.find((p) => p.page_index === pageIndex) ?? pages[0];
  const displayW = sheet?.width || page?.width_px75 || 1;
  const displayH = sheet?.height || page?.height_px75 || 1;
  const pageWpt = sheetPts?.widthPt || page?.width_pt || 1;
  const pageHpt = sheetPts?.heightPt || page?.height_pt || 1;

  const canvasTool: CanvasTool = blackoutEnabled(step)
    ? boxTool === "pan"
      ? "pan"
      : boxTool === "select"
        ? "select"
        : "blackout"
    : geometryLocked(step)
      ? boxTool === "pan"
        ? "pan"
        : "select"
      : boxTool === "draw"
        ? "draw"
        : boxTool;

  const heldRef = useRef(false);
  const claimGenRef = useRef(0);
  const tagWriteRef = useRef(0);
  const pdfRef = useRef<{ jobId: string; doc: Awaited<ReturnType<typeof loadPdfData>> } | null>(null);
  const sheetCacheRef = useRef(new Map<number, SheetEntry>());
  const loadGenRef = useRef(0);
  const pageIndexRef = useRef(pageIndex);
  pageIndexRef.current = pageIndex;
  const fromBoxesRef = useRef<(rows: Box[]) => StoredBox[]>(() => []);
  const blackoutsRef = useRef<BlackoutRegion[]>([]);
  const blackoutHistRef = useRef<BlackoutRegion[][]>([]);
  const blackoutFutureRef = useRef<BlackoutRegion[][]>([]);
  const editStackRef = useRef<Array<"boxes" | "blackouts">>([]);
  const editFutureRef = useRef<Array<"boxes" | "blackouts">>([]);

  const persist = useCallback(
    async (rows: Box[]) => {
      if (!id) return;
      const payload = fromBoxesRef.current(rows);
      const res = await saveAnnotations(id, pageIndexRef.current, payload, "edit");
      setVersion(res.payload.version);
      setStored(res.payload.boxes);
      const revs = await listRevisions(id, pageIndexRef.current);
      setRevisions(revs.revisions);
    },
    [id],
  );

  const draft = useAnnotationDraft({ persist, writable: Boolean(job && canEdit(job, userId)) });

  const toBoxes = useCallback(
    (rows: StoredBox[], wPx: number, hPx: number, wPt: number, hPt: number, meta: PageMeta | undefined, rasterOverlay = false): Box[] =>
      rows.map((b) => {
        const points = overlayBoxPoints(b, {
          displayW: wPx,
          displayH: hPx,
          pageWpt: wPt,
          pageHpt: hPt,
          cocoW: meta?.width_px75 || 0,
          cocoH: meta?.height_px75 || 0,
          rasterOverlay,
        });
        return {
          box_id: b.id,
          points,
          ...polygonAABB(points),
          category_id: b.category_id || classById(0).id,
          class_name: b.class,
          origin: b.origin === "user" ? "user" : "imported",
          edited: b.edited,
        };
      }),
    [],
  );

  const fromBoxes = useCallback(
    (rows: Box[]): StoredBox[] =>
      rows.map((b) => {
        const pts = pointsOf(b);
        const polygon_pt = pts.map((p) => [displayToPt(p.x, pageWpt, displayW), displayToPt(p.y, pageHpt, displayH)] as [number, number]);
        const aabb = polygonAABB(polygon_pt.map(([x, y]) => ({ x, y })));
        const prev = stored.find((s) => s.id === b.box_id);
        return {
          id: b.box_id,
          class: b.class_name || klass,
          origin: b.origin === "user" ? "user" : "imported",
          polygon_pt,
          polygon_px75: prev?.polygon_px75 ?? [],
          bbox_pt: [aabb.x1, aabb.y1, aabb.x2 - aabb.x1, aabb.y2 - aabb.y1],
          bbox_px75: prev?.bbox_px75 ?? [0, 0, 0, 0],
          edited: Boolean(b.edited),
          category_id: b.category_id,
        };
      }),
    [displayW, displayH, pageWpt, pageHpt, stored, klass],
  );
  fromBoxesRef.current = fromBoxes;

  const renderSheet = useCallback(async (jobId: string, idx: number): Promise<SheetEntry> => {
    const cached = sheetCacheRef.current.get(idx);
    if (cached) {
      setSheet(cached.canvas);
      setSheetPts({ widthPt: cached.pageWidthPt, heightPt: cached.pageHeightPt });
      return cached;
    }
    if (pdfRef.current?.jobId !== jobId) {
      const doc = await loadPdfData(await fetchPdf(jobId));
      pdfRef.current = { jobId, doc };
      sheetCacheRef.current.clear();
    }
    const c = document.createElement("canvas");
    const rendered = await renderPageToCanvas(pdfRef.current.doc, idx, SHEET_RENDER_SCALE, c);
    const entry = {
      canvas: c,
      width: rendered.width,
      height: rendered.height,
      pageWidthPt: rendered.pageWidthPt,
      pageHeightPt: rendered.pageHeightPt,
    };
    sheetCacheRef.current.set(idx, entry);
    setSheet(c);
    setSheetPts({ widthPt: rendered.pageWidthPt, heightPt: rendered.pageHeightPt });
    return entry;
  }, []);

  const loadPage = useCallback(
    async (
      jobId: string,
      idx: number,
      wPx: number,
      hPx: number,
      wPt: number,
      hPt: number,
      meta: PageMeta | undefined,
    ) => {
      const gen = ++loadGenRef.current;
      const key = pageCacheKey(jobId, idx, wPx, hPx);
      const cachedBoxes = draft.cached(key);
      const [ann, revs, blk, notes] = await Promise.all([
        getAnnotations(jobId, idx),
        listRevisions(jobId, idx),
        getBlackouts(jobId, idx),
        listComments(jobId, idx).catch(() => ({ comments: [] as PageComment[] })),
      ]);
      if (gen !== loadGenRef.current) return;
      setRevisions(revs.revisions);
      setComments(notes.comments);
      setBlackouts(blk.regions ?? []);
      blackoutsRef.current = blk.regions ?? [];
      blackoutHistRef.current = [];
      blackoutFutureRef.current = [];
      editStackRef.current = [];
      editFutureRef.current = [];
      setBlackoutUndo(0);
      setBlackoutRedo(0);
      setSelectedBlackoutIndex(null);
      const geomKey = geometryCacheKey(jobId, idx, wPx, hPx);
      let geom = getCachedGeometryIndex(geomKey);
      if (!geometryHasOverlay(geom) && pdfRef.current?.jobId === jobId) {
        const vec = await extractPageVectorsFromDoc(pdfRef.current.doc, idx, jobId);
        if (gen !== loadGenRef.current) return;
        const baked = bakeGeometryIndex(vec, { imageWidthPx: wPx, imageHeightPx: hPx, pageIndex: idx });
        if (baked) {
          geom = baked;
          setCachedGeometryIndex(geomKey, baked);
        }
      }
      setIndex(geom);
      let payload = ann.payload;
      let revision = ann.revision;
      const source = markupSourceVersion(revs.revisions);
      if (source != null && source !== payload.version) {
        const restored = await getAnnotations(jobId, idx, source);
        if (gen !== loadGenRef.current) return;
        payload = restored.payload;
        revision = restored.revision;
      }
      const rasterOverlay = shouldRasterOverlay(payload.version, revision.note);
      const nextBoxes =
        source != null || !cachedBoxes
          ? toBoxes(payload.boxes, wPx, hPx, wPt, hPt, meta, rasterOverlay)
          : cachedBoxes;
      setStored(payload.boxes);
      setVersion(payload.version);
      draft.hydrate(key, nextBoxes);
    },
    [draft, toBoxes],
  );

  const prefetchNeighbors = useCallback(
    (jobId: string, idx: number, hasPdf: boolean, pageList: PageMeta[]) => {
      const neighbors = [idx - 2, idx - 1, idx + 1, idx + 2].filter((i) => i >= 0 && i < pageList.length);
      for (const i of neighbors) {
        const meta = pageList.find((p) => p.page_index === i);
        if (!meta) continue;
        void (async () => {
          try {
            let wPx = meta.width_px75;
            let hPx = meta.height_px75;
            let wPt = meta.width_pt;
            let hPt = meta.height_pt;
            if (hasPdf) {
              const cached = sheetCacheRef.current.get(i);
              if (cached) {
                wPx = cached.width;
                hPx = cached.height;
                wPt = cached.pageWidthPt;
                hPt = cached.pageHeightPt;
              } else if (pdfRef.current?.jobId === jobId) {
                const c = document.createElement("canvas");
                const rendered = await renderPageToCanvas(pdfRef.current.doc, i, SHEET_RENDER_SCALE, c);
                sheetCacheRef.current.set(i, {
                  canvas: c,
                  width: rendered.width,
                  height: rendered.height,
                  pageWidthPt: rendered.pageWidthPt,
                  pageHeightPt: rendered.pageHeightPt,
                });
                wPx = rendered.width;
                hPx = rendered.height;
                wPt = rendered.pageWidthPt;
                hPt = rendered.pageHeightPt;
              }
            }
            const key = pageCacheKey(jobId, i, wPx, hPx);
            if (draft.cached(key)) return;
            const [ann, pageRevs] = await Promise.all([getAnnotations(jobId, i), listRevisions(jobId, i)]);
            const source = markupSourceVersion(pageRevs.revisions);
            const shown = source != null && source !== ann.payload.version ? await getAnnotations(jobId, i, source) : ann;
            const geomKey = geometryCacheKey(jobId, i, wPx, hPx);
            if (!geometryHasOverlay(getCachedGeometryIndex(geomKey)) && pdfRef.current?.jobId === jobId) {
              const vec = await extractPageVectorsFromDoc(pdfRef.current.doc, i, jobId);
              const baked = bakeGeometryIndex(vec, { imageWidthPx: wPx, imageHeightPx: hPx, pageIndex: i });
              if (baked) setCachedGeometryIndex(geomKey, baked);
            }
            draft.warm(
              key,
              toBoxes(shown.payload.boxes, wPx, hPx, wPt, hPt, meta, shouldRasterOverlay(shown.payload.version, shown.revision.note)),
            );
          } catch {
            /* prefetch is best-effort */
          }
        })();
      }
    },
    [draft, toBoxes],
  );

  useEffect(() => {
    if (!id) return;
    let alive = true;
    let unloadReleased = false;
    const gen = ++claimGenRef.current;
    const dropOnUnload = () => {
      unloadReleased = true;
      heldRef.current = false;
      releaseJobOnUnload(id);
    };
    void (async () => {
      try {
        const who = await me();
        if (!alive) return;
        setUserId(who.user.id);
        const data = await getJob(id);
        if (!alive) return;
        setJob(data.job);
        void listTags()
          .then((t) => {
            if (alive) setTagCatalog(mergeCatalog(t.tags, [data.job]));
          })
          .catch(() => undefined);
        try {
          const claimed = await claimJob(id);
          if (unloadReleased) {
            releaseJobOnUnload(id);
            return;
          }
          if (!alive || gen !== claimGenRef.current) return;
          heldRef.current = true;
          setJob(claimed.job);
          setLockNote(null);
          setBlocked(null);
        } catch (err) {
          if (alive && gen === claimGenRef.current) {
            const who = data.job.claimed_email || "Someone else";
            setBlocked(
              `${who} has this sheet open. Only one person can work on a sheet at a time, so you can't open it until they go back to the inbox.`,
            );
            setError(isSessionError(err) ? SESSION_EXPIRED_MESSAGE : null);
          }
          return;
        }
        setPages(data.pages);
        const wanted = Number(params.get("page") ?? 0) || 0;
        const first = data.pages.find((p) => p.page_index === wanted) ?? data.pages[0];
        if (!first) return;
        setPageIndex(first.page_index);
        let wPx = first.width_px75;
        let hPx = first.height_px75;
        let wPt = first.width_pt;
        let hPt = first.height_pt;
        if (data.job.has_pdf) {
          const rendered = await renderSheet(id, first.page_index);
          wPx = rendered.width;
          hPx = rendered.height;
          wPt = rendered.pageWidthPt;
          hPt = rendered.pageHeightPt;
        } else {
          setSheet(null);
          setSheetPts(null);
        }
        await loadPage(id, first.page_index, wPx, hPx, wPt, hPt, first);
        if (alive) prefetchNeighbors(id, first.page_index, data.job.has_pdf, data.pages);
      } catch (err) {
        setError(isSessionError(err) ? SESSION_EXPIRED_MESSAGE : err instanceof Error ? err.message : String(err));
      }
    })();
    const beat = window.setInterval(() => {
      if (!heldRef.current) return;
      void heartbeatJob(id)
        .then((r) => {
          if (alive) {
            setJob(r.job);
            setLockNote(null);
          }
        })
        .catch((err) => {
          heldRef.current = false;
          if (alive) {
            const msg = claimMessage(err);
            setBlocked(msg);
            if (isSessionError(err) || msg === SESSION_EXPIRED_MESSAGE) setError(SESSION_EXPIRED_MESSAGE);
          }
        });
    }, 30_000);
    const onPageShow = (e: PageTransitionEvent) => {
      if (!e.persisted || !alive || gen !== claimGenRef.current) return;
      unloadReleased = false;
      void claimJob(id)
        .then((r) => {
          if (!alive || gen !== claimGenRef.current) return;
          heldRef.current = true;
          setJob(r.job);
          setLockNote(null);
          setBlocked(null);
        })
        .catch((err) => {
          heldRef.current = false;
          if (!alive || gen !== claimGenRef.current) return;
          const who = claimMessage(err);
          setBlocked(who);
          if (isSessionError(err) || who === SESSION_EXPIRED_MESSAGE) setError(SESSION_EXPIRED_MESSAGE);
        });
    };
    window.addEventListener("pagehide", dropOnUnload);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      alive = false;
      window.clearInterval(beat);
      window.removeEventListener("pagehide", dropOnUnload);
      window.removeEventListener("pageshow", onPageShow);
      const releasedGen = gen;
      heldRef.current = false;
      window.setTimeout(() => {
        if (claimGenRef.current !== releasedGen) return;
        void releaseJob(id).catch(() => undefined);
      }, 50);
    };
    // Mount-only: claim, heartbeat, and PDF parse must not restart on every draft identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!id || blocked) return;
    let alive = true;
    const tick = window.setInterval(() => {
      void listComments(id, pageIndex)
        .then((res) => {
          if (alive) setComments(res.comments);
        })
        .catch(() => undefined);
    }, 8_000);
    return () => {
      alive = false;
      window.clearInterval(tick);
    };
  }, [id, pageIndex, blocked]);

  async function changePage(next: number, nextStep?: Step) {
    if (!id || !job) return;
    const meta = pages.find((p) => p.page_index === next);
    if (!meta) return;
    await draft.flush();
    setPageIndex(next);
    setComments([]);
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        n.set("page", String(next));
        if (nextStep) n.set("step", nextStep);
        return n;
      },
      { replace: true },
    );
    setSelectedIds([]);
    setSelectedBlackoutIndex(null);
    let wPx = meta.width_px75;
    let hPx = meta.height_px75;
    let wPt = meta.width_pt;
    let hPt = meta.height_pt;
    if (job.has_pdf) {
      const rendered = await renderSheet(id, next);
      wPx = rendered.width;
      hPx = rendered.height;
      wPt = rendered.pageWidthPt;
      hPt = rendered.pageHeightPt;
    }
    await loadPage(id, next, wPx, hPx, wPt, hPt, meta);
    prefetchNeighbors(id, next, job.has_pdf, pages);
  }

  function setStep(next: Step) {
    if (next === "blackout") setBoxTool((t) => (t === "pan" ? "pan" : "draw"));
    if (next === "boxes") setBoxTool((t) => (t === "pan" ? "pan" : "select"));
    if (next === "labels") setBoxTool("select");
    setBoxesHidden(false);
    setSelectedIds([]);
    setSelectedBlackoutIndex(null);
    const first = pages[0]?.page_index ?? 0;
    if (pageIndex !== first) {
      void changePage(first, next);
      return;
    }
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        n.set("step", next);
        n.set("page", String(first));
        return n;
      },
      { replace: true },
    );
  }

  async function onRevert(v: number) {
    if (!id) return;
    const res = await revertAnnotations(id, pageIndex, v);
    setStored(res.payload.boxes);
    setVersion(res.payload.version);
    draft.hydrate(
      pageCacheKey(id, pageIndex, displayW, displayH),
      toBoxes(res.payload.boxes, displayW, displayH, pageWpt, pageHpt, page, shouldRasterOverlay(res.payload.version, res.revision.note)),
    );
    const revs = await listRevisions(id, pageIndex);
    setRevisions(revs.revisions);
  }

  async function onPdf(file: File | undefined) {
    if (!file || !id) return;
    await attachPdf(id, file);
    const data = await getJob(id);
    setJob(data.job);
    setPages(data.pages);
    pdfRef.current = null;
    sheetCacheRef.current.clear();
    const rendered = await renderSheet(id, pageIndex);
    const meta = data.pages.find((p) => p.page_index === pageIndex) ?? data.pages[0];
    await loadPage(id, pageIndex, rendered.width, rendered.height, rendered.pageWidthPt, rendered.pageHeightPt, meta);
  }

  async function persistBlackouts(regions: BlackoutRegion[], record = true) {
    if (record) {
      blackoutHistRef.current = [...blackoutHistRef.current, blackoutsRef.current.map((r) => ({ ...r }))].slice(-50);
      blackoutFutureRef.current = [];
      editStackRef.current = [...editStackRef.current, "blackouts"];
      editFutureRef.current = [];
      setBlackoutUndo(blackoutHistRef.current.length);
      setBlackoutRedo(0);
    }
    blackoutsRef.current = regions;
    setBlackouts(regions);
    if (id) {
      try {
        await putBlackouts(id, pageIndex, regions);
      } catch (err) {
        setError(isSessionError(err) ? SESSION_EXPIRED_MESSAGE : err instanceof Error ? err.message : String(err));
      }
    }
  }

  function setBoxesTracked(next: Box[]) {
    editStackRef.current = [...editStackRef.current, "boxes"];
    editFutureRef.current = [];
    draft.setBoxes(next);
  }

  function undoBlackoutStep() {
    const prev = blackoutHistRef.current.pop();
    if (!prev) return;
    blackoutFutureRef.current.push(blackoutsRef.current.map((r) => ({ ...r })));
    setBlackoutUndo(blackoutHistRef.current.length);
    setBlackoutRedo(blackoutFutureRef.current.length);
    void persistBlackouts(prev, false);
  }

  function redoBlackoutStep() {
    const next = blackoutFutureRef.current.pop();
    if (!next) return;
    blackoutHistRef.current.push(blackoutsRef.current.map((r) => ({ ...r })));
    setBlackoutUndo(blackoutHistRef.current.length);
    setBlackoutRedo(blackoutFutureRef.current.length);
    void persistBlackouts(next, false);
  }

  function undo() {
    const kind = editStackRef.current.pop();
    if (kind) editFutureRef.current.push(kind);
    if (kind === "blackouts") undoBlackoutStep();
    else draft.undo();
  }

  function redo() {
    const kind = editFutureRef.current.pop();
    if (kind) editStackRef.current.push(kind);
    if (kind === "blackouts") redoBlackoutStep();
    else draft.redo();
  }

  function reclass(name: string) {
    setKlass(name);
    if (step !== "labels" || !selectedIds.length) return;
    const chosen = new Set(selectedIds);
    setBoxesTracked(
      draft.boxes.map((b) =>
        chosen.has(b.box_id)
          ? { ...b, class_name: name, category_id: CLASSES.find((c) => c.name === name)?.id ?? b.category_id, edited: true }
          : b,
      ),
    );
  }

  function deleteSelected() {
    if (step === "blackout" && selectedBlackoutIndex != null) {
      void persistBlackouts(blackouts.filter((_, i) => i !== selectedBlackoutIndex));
      setSelectedBlackoutIndex(null);
      return;
    }
    if (!selectedIds.length || geometryLocked(step)) return;
    const drop = new Set(selectedIds);
    setBoxesTracked(draft.boxes.filter((b) => !drop.has(b.box_id)));
    setSelectedIds([]);
  }

  function copySelected() {
    if (geometryLocked(step) || !selectedIds.length) return false;
    const chosen = draft.boxes.filter((b) => selectedIds.includes(b.box_id));
    if (!chosen.length) return false;
    boxClipboard.current = { boxes: chosen.map((b) => ({ ...b, points: pointsOf(b).map((p) => ({ ...p })) })), pasteCount: 0 };
    return true;
  }

  function pasteClipboard() {
    if (geometryLocked(step) || !boxClipboard.current.boxes.length) return;
    boxClipboard.current.pasteCount += 1;
    const n = boxClipboard.current.pasteCount;
    const copies = duplicateBoxes(boxClipboard.current.boxes, BOX_COPY_OFFSET * n, BOX_COPY_OFFSET * n);
    setBoxesTracked([...draft.boxes, ...copies]);
    setSelectedIds(copies.map((c) => c.box_id));
    setBoxTool("select");
  }

  function duplicateSelected() {
    if (geometryLocked(step) || !selectedIds.length) return;
    const chosen = draft.boxes.filter((b) => selectedIds.includes(b.box_id));
    const copies = duplicateBoxes(chosen);
    if (!copies.length) return;
    setBoxesTracked([...draft.boxes, ...copies]);
    setSelectedIds(copies.map((c) => c.box_id));
    setBoxTool("select");
  }

  function snapAll() {
    const { boxes: next, changed } = snapModelBoxes(
      draft.boxes.map((b) => ({ ...b, origin: b.edited ? "user" : "imported" })),
      index,
    );
    if (changed) setBoxesTracked(next);
  }

  async function onAdvance(next: Job["status"]) {
    if (!id) return;
    try {
      await draft.flush();
      const res = await setStage(id, next);
      setJob(res.job);
      setLockNote(null);
    } catch (err) {
      setError(isSessionError(err) ? SESSION_EXPIRED_MESSAGE : err instanceof Error ? err.message : String(err));
    }
  }

  async function onSaveTags(tags: string[]) {
    if (!id) return;
    const seq = ++tagWriteRef.current;
    setJob((j) => (j ? { ...j, tags } : j));
    try {
      const res = await setJobTags(id, tags);
      if (tagWriteRef.current !== seq) return;
      setJob(res.job);
      setTagCatalog((prev) => mergeCatalog(prev.map((name) => ({ name })), [res.job]));
    } catch (err) {
      if (tagWriteRef.current === seq) {
        setError(isSessionError(err) ? SESSION_EXPIRED_MESSAGE : err instanceof Error ? err.message : String(err));
      }
    }
  }

  async function onPostComment(body: string, annotationId: string | null) {
    if (!id) return;
    setPostingComment(true);
    try {
      const res = await createComment(id, pageIndex, body, annotationId);
      setComments((prev) => (prev.some((c) => c.id === res.comment.id) ? prev : [...prev, res.comment]));
    } catch (err) {
      setError(isSessionError(err) ? SESSION_EXPIRED_MESSAGE : err instanceof Error ? err.message : String(err));
    } finally {
      setPostingComment(false);
    }
  }

  async function onDeleteComment(commentId: string) {
    if (!id) return;
    try {
      await deleteComment(id, pageIndex, commentId);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
    } catch (err) {
      setError(isSessionError(err) ? SESSION_EXPIRED_MESSAGE : err instanceof Error ? err.message : String(err));
    }
  }

  function onContinue() {
    const following = nextStep(step);
    if (following) {
      setStep(following);
      return;
    }
    if (!job) return;
    const actions = statusActions(job);
    if (actions[0]) void onAdvance(actions[0].stage);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && e.key.toLowerCase() === "c") {
        if (copySelected()) e.preventDefault();
        return;
      }
      if (mod && e.key.toLowerCase() === "v") {
        if (step === "boxes") {
          e.preventDefault();
          pasteClipboard();
        }
        return;
      }
      if (mod && e.key.toLowerCase() === "d") {
        if (step === "boxes" && selectedIds.length) {
          e.preventDefault();
          duplicateSelected();
        }
        return;
      }
      if (e.key === "Escape") {
        setSelectedIds([]);
        setSelectedBlackoutIndex(null);
      }
      if (mod && e.key.toLowerCase() === "a" && (step === "labels" || step === "boxes") && !boxesHidden) {
        e.preventDefault();
        setSelectedIds(draft.boxes.map((b) => b.box_id));
        return;
      }
      if (e.key === "[") setStep(STEPS[Math.max(0, stepIndex(step) - 1)]!);
      if (e.key === "]") {
        const nxt = nextStep(step);
        if (nxt) setStep(nxt);
      }
      if (e.key === "s" || e.key === "S") setBoxTool("select");
      if ((step === "boxes" || step === "blackout") && (e.key === "r" || e.key === "R")) setBoxTool("draw");
      if (e.key === "Delete" || e.key === "Backspace") deleteSelected();
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && CLASSES[n - 1]) reclass(CLASSES[n - 1].name);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIds, step, draft, boxesHidden]);

  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      if (draft.saveTone === "dirty" || draft.saveTone === "saving") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [draft.saveTone]);

  if (blocked) {
    return (
      <div className="app-shell">
        <header className="topbar">
          <Link className="back" to="/">
            ‹ Inbox
          </Link>
        </header>
        <main className="in-use-panel">
          <p className="eyebrow">Sheet in use</p>
          <h1>You can’t open this sheet right now</h1>
          <p>{blocked}</p>
          <Link className="btn-primary" to="/">
            Back to inbox
          </Link>
        </main>
      </div>
    );
  }

  if (!job || !page) {
    return (
      <div className="app-shell">
        <p className="muted">{error ?? "Loading…"}</p>
        <Link to="/">Back</Link>
      </div>
    );
  }

  const readOnly = !canEdit(job, userId);
  const continueLabel = STEP_CONTINUE[step];
  const actions = step === "labels" || normalizeStatus(job.status) === "complete" ? statusActions(job) : [];

  return (
    <div className="app-shell clean">
      <header className="topbar">
        <Link className="back" to="/">
          ‹ Inbox
        </Link>
        <div className="job-id">
          <strong>{job.slug}</strong>
          <span className={`pill ${normalizeStatus(job.status)}`}>{STAGE_LABEL[normalizeStatus(job.status)]}</span>
          <span className="pill holding">Only you have this sheet open</span>
          <JobTags compact tags={job.tags} catalog={tagCatalog} onChange={(next) => void onSaveTags(next)} />
        </div>
        <span className="muted small">v{version}</span>
        <span className="spacer" />
        <button type="button" className="btn-ghost" onClick={() => void downloadCoco(job.id, job.slug)}>
          Export COCO
        </button>
      </header>
      <div className="stage-tabs-wrap">
        <nav className="stage-tabs" aria-label="Correction stages">
          {STEPS.map((s, i) => (
            <button
              key={s}
              type="button"
              className={`stage-tab${s === step ? " stage-tab-active" : ""}`}
              onClick={() => setStep(s)}
            >
              <span className="stage-tab-num" aria-hidden>
                {i + 1}
              </span>
              {STEP_LABEL[s]}
            </button>
          ))}
        </nav>
      </div>
      <BoxToolbar
        saveTone={draft.saveTone}
        saveError={draft.saveError}
        pageLabel={`Page ${pageIndex + 1} of ${pages.length}`}
        canPrevPage={pageIndex > 0}
        canNextPage={pageIndex + 1 < pages.length}
        onPrevPage={() => void changePage(pageIndex - 1)}
        onNextPage={() => void changePage(pageIndex + 1)}
        continueLabel={continueLabel}
        onContinue={onContinue}
        continueDisabled={false}
        boxesHidden={boxesHidden}
        onToggleBoxesHidden={
          step === "boxes"
            ? () => {
                setBoxesHidden((hidden) => {
                  if (!hidden) setSelectedIds([]);
                  return !hidden;
                });
              }
            : undefined
        }
        statusActions={actions}
        onStatusAction={(stage) => void onAdvance(stage)}
        readOnly={readOnly}
      />
      <div className="clean-body">
        <AnnotationRail
          step={step}
          job={job}
          readOnly={readOnly}
          lockNote={lockNote}
          blackouts={blackouts}
          boxes={draft.boxes}
          selectedIds={selectedIds}
          selectedBlackoutIndex={selectedBlackoutIndex}
          klass={klass}
          boxTool={boxTool}
          adjustSnap={adjustSnap}
          revisions={revisions}
          comments={comments}
          userId={userId}
          postingComment={postingComment}
          error={error ?? (draft.saveError === SESSION_EXPIRED_MESSAGE ? SESSION_EXPIRED_MESSAGE : null)}
          hasPdf={job.has_pdf}
          onBoxTool={setBoxTool}
          onAdjustSnap={setAdjustSnap}
          onSnapAll={snapAll}
          onDuplicate={duplicateSelected}
          onDelete={deleteSelected}
          onClearBlackouts={() => {
            void persistBlackouts([]);
            setSelectedBlackoutIndex(null);
          }}
          onReclass={reclass}
          onRevert={(v) => void onRevert(v)}
          onPdf={(file) => void onPdf(file)}
          onPostComment={(body, annotationId) => void onPostComment(body, annotationId)}
          onDeleteComment={(commentId) => void onDeleteComment(commentId)}
          onSelectAnnotation={(boxId) => setSelectedIds([boxId])}
        />
        <div className="canvas-wrap">
          <BoxCanvas
            imageWidth={displayW}
            imageHeight={displayH}
            canvas={sheet}
            boxes={draft.boxes}
            onBoxes={setBoxesTracked}
            geometryIndex={index}
            tool={canvasTool}
            className={klass}
            blackouts={blackouts}
            onBlackouts={(regions) => void persistBlackouts(regions)}
            selectedBlackoutIndex={selectedBlackoutIndex}
            onSelectedBlackoutIndex={setSelectedBlackoutIndex}
            selectedIds={selectedIds}
            onSelectedIds={setSelectedIds}
            commentedIds={commentedBoxIds(comments)}
            adjustSnap={adjustSnap}
            readOnly={readOnly}
            geometryLocked={geometryLocked(step)}
            snapping={snapEnabled(step)}
            showBoxes={boxesVisible(step) && !boxesHidden}
            showLabels={labelsVisible(step)}
            editBlackouts={blackoutEnabled(step)}
            multiSelect={(step === "labels" || step === "boxes") && !boxesHidden}
            fitKey={`${job.id}:${pageIndex}:${displayW}x${displayH}`}
          />
          <ToolPalette
            tool={canvasTool}
            step={step}
            readOnly={readOnly}
            geometryLocked={geometryLocked(step)}
            canDelete={step === "blackout" ? selectedBlackoutIndex != null : selectedIds.length > 0 && !geometryLocked(step)}
            canDuplicate={step === "boxes" && selectedIds.length > 0}
            canUndo={draft.canUndo || blackoutUndo > 0}
            canRedo={draft.canRedo || blackoutRedo > 0}
            onToolChange={(t) => {
              if (t === "pan") setBoxTool("pan");
              else if (t === "draw" || t === "blackout") setBoxTool(step === "blackout" ? "draw" : "draw");
              else setBoxTool("select");
            }}
            onDelete={deleteSelected}
            onDuplicate={duplicateSelected}
            onUndo={undo}
            onRedo={redo}
          />
        </div>
      </div>
      <p className="hint-strip">
        {STEP_KEYS[step]}
        <span className="hint-strip-blurb">{STEP_HINT[step]}</span>
      </p>
    </div>
  );
}
