import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Box, Job, PageMeta, Revision, StoredBox } from "../api/types";
import BoxCanvas from "../components/BoxCanvas";
import {
  attachPdf,
  downloadCoco,
  fetchPdf,
  getAnnotations,
  getBlackouts,
  getJob,
  getVectors,
  listRevisions,
  putBlackouts,
  revertAnnotations,
  saveAnnotations,
} from "../lib/api";
import { CLASSES, classById } from "../lib/classes";
import { ptToDisplay } from "../lib/coords";
import type { BlackoutRegion } from "../lib/pageBlackouts";
import { loadPdfData, renderPageToCanvas } from "../lib/pdf";
import { bakeGeometryIndex, snapModelBoxes, type GeometryIndex } from "../lib/snap";

type Tool = "select" | "draw" | "blackout";

export default function CleanPage() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<Job | null>(null);
  const [pages, setPages] = useState<PageMeta[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [stored, setStored] = useState<StoredBox[]>([]);
  const [version, setVersion] = useState(0);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [klass, setKlass] = useState("WW");
  const [blackouts, setBlackouts] = useState<BlackoutRegion[]>([]);
  const [index, setIndex] = useState<GeometryIndex | null>(null);
  const [sheet, setSheet] = useState<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const page = pages.find((p) => p.page_index === pageIndex) ?? pages[0];
  const displayW = sheet?.width || page?.width_px75 || 1;
  const displayH = sheet?.height || page?.height_px75 || 1;
  const pageWpt = page?.width_pt || 1;
  const pageHpt = page?.height_pt || 1;

  const toBoxes = useCallback(
    (rows: StoredBox[], wPx: number, hPx: number, wPt: number, hPt: number): Box[] =>
      rows.map((b) => {
        const [x, y, w, h] = b.bbox_pt;
        const usePt = wPt > 0 && (b.edited || w > 0);
        if (usePt) {
          return {
            box_id: b.id,
            x1: ptToDisplay(x, wPt, wPx),
            y1: ptToDisplay(y, hPt, hPx),
            x2: ptToDisplay(x + w, wPt, wPx),
            y2: ptToDisplay(y + h, hPt, hPx),
            category_id: b.category_id || classById(0).id,
            class_name: b.class,
            origin: b.origin === "user" ? "user" : "imported",
            edited: b.edited,
          };
        }
        const [px, py, pw, ph] = b.bbox_px75;
        return {
          box_id: b.id,
          x1: (px / (page?.width_px75 || wPx)) * wPx,
          y1: (py / (page?.height_px75 || hPx)) * hPx,
          x2: ((px + pw) / (page?.width_px75 || wPx)) * wPx,
          y2: ((py + ph) / (page?.height_px75 || hPx)) * hPx,
          category_id: b.category_id || 3,
          class_name: b.class,
          origin: "imported",
          edited: b.edited,
        };
      }),
    [page],
  );

  const fromBoxes = useCallback(
    (rows: Box[]): StoredBox[] =>
      rows.map((b) => {
        const x = (b.x1 / displayW) * pageWpt;
        const y = (b.y1 / displayH) * pageHpt;
        const w = ((b.x2 - b.x1) / displayW) * pageWpt;
        const h = ((b.y2 - b.y1) / displayH) * pageHpt;
        const prev = stored.find((s) => s.id === b.box_id);
        return {
          id: b.box_id,
          class: b.class_name || klass,
          origin: b.origin === "user" ? "user" : "imported",
          bbox_pt: [x, y, w, h],
          bbox_px75: prev?.bbox_px75 ?? [0, 0, 0, 0],
          edited: Boolean(b.edited),
          category_id: b.category_id,
        };
      }),
    [displayW, displayH, pageWpt, pageHpt, stored, klass],
  );

  async function loadPage(jobId: string, idx: number, wPx: number, hPx: number, wPt: number, hPt: number) {
    const [ann, revs, blk, vec] = await Promise.all([
      getAnnotations(jobId, idx),
      listRevisions(jobId, idx),
      getBlackouts(jobId, idx),
      getVectors(jobId, idx).catch(() => null),
    ]);
    setStored(ann.payload.boxes);
    setVersion(ann.payload.version);
    setRevisions(revs.revisions);
    setBlackouts(blk.regions ?? []);
    setBoxes(toBoxes(ann.payload.boxes, wPx, hPx, wPt, hPt));
    setDirty(false);
    if (vec) {
      setIndex(bakeGeometryIndex(vec, { imageWidthPx: wPx, imageHeightPx: hPx, pageIndex: idx }));
    } else {
      setIndex(null);
    }
  }

  useEffect(() => {
    if (!id) return;
    void (async () => {
      try {
        const data = await getJob(id);
        setJob(data.job);
        setPages(data.pages);
        const first = data.pages[0];
        if (!first) return;
        setPageIndex(first.page_index);
        let wPx = first.width_px75;
        let hPx = first.height_px75;
        if (data.job.has_pdf) {
          const buf = await fetchPdf(id);
          const pdf = await loadPdfData(buf);
          const c = document.createElement("canvas");
          const rendered = await renderPageToCanvas(pdf, first.page_index, 1.5, c);
          setSheet(c);
          wPx = rendered.width;
          hPx = rendered.height;
        } else {
          setSheet(null);
        }
        await loadPage(id, first.page_index, wPx, hPx, first.width_pt, first.height_pt);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [id]);

  async function changePage(next: number) {
    if (!id || !job) return;
    const meta = pages.find((p) => p.page_index === next);
    if (!meta) return;
    setPageIndex(next);
    let wPx = meta.width_px75;
    let hPx = meta.height_px75;
    if (job.has_pdf) {
      const buf = await fetchPdf(id);
      const pdf = await loadPdfData(buf);
      const c = document.createElement("canvas");
      const rendered = await renderPageToCanvas(pdf, next, 1.5, c);
      setSheet(c);
      wPx = rendered.width;
      hPx = rendered.height;
    }
    await loadPage(id, next, wPx, hPx, meta.width_pt, meta.height_pt);
  }

  async function onSave() {
    if (!id) return;
    const payload = fromBoxes(boxes);
    const res = await saveAnnotations(id, pageIndex, payload, "edit");
    setVersion(res.payload.version);
    setStored(res.payload.boxes);
    setDirty(false);
    const revs = await listRevisions(id, pageIndex);
    setRevisions(revs.revisions);
  }

  async function onRevert(v: number) {
    if (!id) return;
    const res = await revertAnnotations(id, pageIndex, v);
    setStored(res.payload.boxes);
    setVersion(res.payload.version);
    setBoxes(toBoxes(res.payload.boxes, displayW, displayH, pageWpt, pageHpt));
    const revs = await listRevisions(id, pageIndex);
    setRevisions(revs.revisions);
    setDirty(false);
  }

  async function onPdf(file: File | undefined) {
    if (!file || !id) return;
    await attachPdf(id, file);
    const data = await getJob(id);
    setJob(data.job);
    setPages(data.pages);
    const buf = await fetchPdf(id);
    const pdf = await loadPdfData(buf);
    const c = document.createElement("canvas");
    const rendered = await renderPageToCanvas(pdf, pageIndex, 1.5, c);
    setSheet(c);
    const meta = data.pages.find((p) => p.page_index === pageIndex) ?? data.pages[0];
    await loadPage(id, pageIndex, rendered.width, rendered.height, meta.width_pt, meta.height_pt);
  }

  async function persistBlackouts(regions: BlackoutRegion[]) {
    setBlackouts(regions);
    if (id) await putBlackouts(id, pageIndex, regions);
  }

  function reclass(name: string) {
    setKlass(name);
    if (!selectedId) return;
    setBoxes((prev) =>
      prev.map((b) =>
        b.box_id === selectedId
          ? { ...b, class_name: name, category_id: CLASSES.find((c) => c.name === name)?.id ?? b.category_id, edited: true }
          : b,
      ),
    );
    setDirty(true);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "s" || e.key === "S") setTool("select");
      if (e.key === "r" || e.key === "R") setTool("draw");
      if (e.key === "b" || e.key === "B") setTool("blackout");
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedId) {
          setBoxes((prev) => prev.filter((b) => b.box_id !== selectedId));
          setSelectedId(null);
          setDirty(true);
        }
      }
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && CLASSES[n - 1]) reclass(CLASSES[n - 1].name);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  function deleteSelected() {
    if (!selectedId) return;
    setBoxes((prev) => prev.filter((b) => b.box_id !== selectedId));
    setSelectedId(null);
    setDirty(true);
  }

  function snapAll() {
    const { boxes: next, changed } = snapModelBoxes(
      boxes.map((b) => ({ ...b, origin: b.edited ? "user" : "imported" })),
      index,
    );
    if (changed) {
      setBoxes(next);
      setDirty(true);
    }
  }

  if (!job || !page) {
    return (
      <div className="app-shell">
        <p className="muted">{error ?? "Loading…"}</p>
        <Link to="/">Back</Link>
      </div>
    );
  }

  return (
    <div className="app-shell clean">
      <header className="topbar">
        <Link to="/">Inbox</Link>
        <strong>{job.slug}</strong>
        <span className="muted">
          p{pageIndex + 1}/{pages.length} · v{version}
          {dirty ? " · unsaved" : ""}
        </span>
        <select value={pageIndex} onChange={(e) => void changePage(Number(e.target.value))}>
          {pages.map((p) => (
            <option key={p.page_index} value={p.page_index}>
              Page {p.page_index + 1}
            </option>
          ))}
        </select>
        <button type="button" className="btn-primary" onClick={() => void onSave()}>
          Save version
        </button>
        <button type="button" className="btn-ghost" onClick={() => job && void downloadCoco(job.id, job.slug)}>
          Export COCO
        </button>
      </header>
      <div className="clean-body">
        <aside className="rail">
          <h3>Tools</h3>
          <button type="button" className={tool === "select" ? "active" : ""} onClick={() => setTool("select")}>
            Select (S)
          </button>
          <button type="button" className={tool === "draw" ? "active" : ""} onClick={() => setTool("draw")}>
            Draw (R)
          </button>
          <button type="button" className={tool === "blackout" ? "active" : ""} onClick={() => setTool("blackout")}>
            Blackout (B)
          </button>
          <button type="button" onClick={snapAll}>
            Snap all
          </button>
          <button type="button" onClick={deleteSelected}>
            Delete
          </button>
          <h3>Class</h3>
          {CLASSES.map((c) => (
            <button
              key={c.name}
              type="button"
              className={klass === c.name ? "active" : ""}
              style={{ borderLeft: `4px solid ${c.color}` }}
              onClick={() => reclass(c.name)}
            >
              {c.name}
            </button>
          ))}
          <h3>PDF</h3>
          <label className="btn-ghost file-btn">
            {job.has_pdf ? "Replace PDF" : "Attach vector PDF"}
            <input type="file" accept="application/pdf" hidden onChange={(e) => void onPdf(e.target.files?.[0])} />
          </label>
          <p className="muted small">
            {job.has_pdf
              ? "Snapping to extracted vectors, fills, and dots."
              : "Boxes shown in 75 DPI space until a PDF is attached."}
          </p>
          <h3>Versions</h3>
          <ul className="revs">
            {revisions.map((r) => (
              <li key={r.version}>
                <button type="button" onClick={() => void onRevert(r.version)}>
                  v{r.version} {r.note}
                </button>
              </li>
            ))}
          </ul>
          {error ? <p className="error">{error}</p> : null}
        </aside>
        <BoxCanvas
          imageWidth={displayW}
          imageHeight={displayH}
          canvas={sheet}
          boxes={boxes}
          onBoxes={(next) => {
            setBoxes(next);
            setDirty(true);
          }}
          geometryIndex={index}
          tool={tool}
          className={klass}
          blackouts={blackouts}
          onBlackouts={(regions) => void persistBlackouts(regions)}
          selectedId={selectedId}
          onSelectedId={setSelectedId}
        />
      </div>
    </div>
  );
}

