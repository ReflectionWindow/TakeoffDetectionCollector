import { useCallback, useEffect, useMemo, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { createSession, fetchGeometry, getToken, setToken, uploadPdf } from "./api";
import { PdfStage } from "./annotator/PdfStage";
import { downloadBlob, downloadJson, exportYoloZip } from "./annotator/exportYolo";
import { loadPdf } from "./annotator/pdf";
import {
  CLASSES,
  type ClassId,
  type Geometry,
  type PageMeta,
  type ProjectFile,
  type Shape,
  type Tool,
} from "./types";

const GEOM_CACHE_MAX = 8;

export default function App() {
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Open a vector PDF to start.");

  const [file, setFile] = useState<File | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [fileId, setFileId] = useState<string | null>(null);
  const [pages, setPages] = useState<PageMeta[]>([]);
  const [pageIndex, setPageIndex] = useState(0);

  const [geomCache, setGeomCache] = useState<Record<number, Geometry>>({});
  const [geomLoading, setGeomLoading] = useState(false);

  const [annotations, setAnnotations] = useState<Record<number, Shape[]>>({});
  const [tool, setTool] = useState<Tool>("polygon");
  const [classId, setClassId] = useState<ClassId>(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSnapDots, setShowSnapDots] = useState(false);
  const [zoom, setZoom] = useState(1);

  const shapes = annotations[pageIndex] ?? [];
  const pageCount = pages.length;
  const geometry = geomCache[pageIndex] ?? null;

  const shapeCount = useMemo(
    () => Object.values(annotations).reduce((n, list) => n + list.length, 0),
    [annotations],
  );

  const signIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setBusy(true);
    try {
      const t = await createSession(password);
      setTokenState(t);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  };

  const openPdf = async (next: File) => {
    setBusy(true);
    setStatus("Uploading PDF and reading pages…");
    try {
      const doc = await loadPdf(next);
      const meta = await uploadPdf(next);
      setFile(next);
      setPdf(doc);
      setFileId(meta.fileId);
      setPages(meta.pages);
      setPageIndex(0);
      setGeomCache({});
      setAnnotations({});
      setSelectedId(null);
      setStatus(`${next.name} · ${meta.pageCount} page${meta.pageCount === 1 ? "" : "s"}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Failed to open PDF");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!fileId || !pages.length) return;
    if (geomCache[pageIndex]) return;
    let cancelled = false;
    setGeomLoading(true);
    setStatus("Extracting snap geometry…");
    void fetchGeometry(fileId, pageIndex)
      .then((geom) => {
        if (cancelled) return;
        setGeomCache((prev) => {
          const next = { ...prev, [pageIndex]: geom };
          const keys = Object.keys(next).map(Number);
          if (keys.length > GEOM_CACHE_MAX) {
            const drop = keys.find((k) => k !== pageIndex);
            if (drop !== undefined) delete next[drop];
          }
          return next;
        });
        setStatus(
          `${file?.name ?? "PDF"} · page ${pageIndex + 1}/${pages.length} · ${geom.points.length} snap points`,
        );
      })
      .catch((err) => {
        if (!cancelled) setStatus(err instanceof Error ? err.message : "Geometry failed");
      })
      .finally(() => {
        if (!cancelled) setGeomLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fileId, pageIndex, pages.length, geomCache, file?.name]);

  const setPageShapes = useCallback(
    (next: Shape[]) => {
      setAnnotations((prev) => ({ ...prev, [pageIndex]: next }));
    },
    [pageIndex],
  );

  const exportZip = async () => {
    if (!pdf || !file) return;
    setBusy(true);
    setStatus("Rasterizing pages and packing YOLO-seg zip…");
    try {
      const blob = await exportYoloZip({ pdf, fileName: file.name, annotations });
      downloadBlob(blob, `${file.name.replace(/\.pdf$/i, "")}_yolo-seg.zip`);
      setStatus(`Exported ${shapeCount} shape${shapeCount === 1 ? "" : "s"}.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Export failed");
    } finally {
      setBusy(false);
    }
  };

  const saveProject = () => {
    if (!file) return;
    const data: ProjectFile = { version: 1, fileName: file.name, pages: annotations };
    downloadJson(data, `${file.name.replace(/\.pdf$/i, "")}.takeoff.json`);
  };

  const loadProject = async (jsonFile: File) => {
    const text = await jsonFile.text();
    const data = JSON.parse(text) as ProjectFile;
    if (data.version !== 1 || !data.pages) throw new Error("Not a takeoff project file");
    setAnnotations(data.pages);
    setStatus(`Restored annotations from ${jsonFile.name}`);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "1") setClassId(0);
      if (e.key === "2") setClassId(1);
      if (e.key === "3") setClassId(2);
      if (e.key === "v" || e.key === "V") setTool("polygon");
      if (e.key === "r" || e.key === "R") setTool("rectangle");
      if (e.key === "s" || e.key === "S") setTool("select");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!token) {
    return (
      <div className="gate">
        <form className="gate-card" onSubmit={signIn}>
          <p className="eyebrow">Takeoff Detection</p>
          <h1>Snap Annotator</h1>
          <p className="lede">
            Shared team access. Enter the annotator password, then mark louvres, metal panels, and
            windows on a vector PDF.
          </p>
          <label>
            Password
            <input
              type="password"
              value={password}
              autoFocus
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          {authError && <p className="error">{authError}</p>}
          <button type="submit" disabled={busy || !password}>
            {busy ? "Checking…" : "Continue"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark" />
          Snap Annotator
        </div>
        <label className="file-btn">
          Open PDF
          <input
            type="file"
            accept="application/pdf"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void openPdf(f);
            }}
          />
        </label>
        <div className="pager">
          <button
            type="button"
            disabled={pageIndex <= 0}
            onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
          >
            Prev
          </button>
          <span>
            {pageCount ? `${pageIndex + 1} / ${pageCount}` : "–"}
          </span>
          <button
            type="button"
            disabled={!pageCount || pageIndex >= pageCount - 1}
            onClick={() => setPageIndex((i) => Math.min(pageCount - 1, i + 1))}
          >
            Next
          </button>
        </div>
        <div className="spacer" />
        <label className="file-btn ghost">
          Load JSON
          <input
            type="file"
            accept="application/json,.takeoff.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void loadProject(f).catch((err) => setStatus(String(err)));
            }}
          />
        </label>
        <button type="button" className="ghost" disabled={!file} onClick={saveProject}>
          Save JSON
        </button>
        <button type="button" className="primary" disabled={!file || busy || !shapeCount} onClick={() => void exportZip()}>
          Export YOLO-seg
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            setToken(null);
            setTokenState(null);
          }}
        >
          Sign out
        </button>
      </header>

      <div className="workspace">
        <aside className="rail">
          <section>
            <h2>Tool</h2>
            <div className="seg">
              <button type="button" className={tool === "polygon" ? "on" : ""} onClick={() => setTool("polygon")}>
                Polygon <kbd>V</kbd>
              </button>
              <button type="button" className={tool === "rectangle" ? "on" : ""} onClick={() => setTool("rectangle")}>
                Rectangle <kbd>R</kbd>
              </button>
              <button type="button" className={tool === "select" ? "on" : ""} onClick={() => setTool("select")}>
                Select <kbd>S</kbd>
              </button>
            </div>
          </section>
          <section>
            <h2>Class</h2>
            <div className="classes">
              {CLASSES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={classId === c.id ? "on" : ""}
                  onClick={() => {
                    setClassId(c.id);
                    if (selectedId) {
                      setPageShapes(
                        shapes.map((s) => (s.id === selectedId ? { ...s, classId: c.id } : s)),
                      );
                    }
                  }}
                >
                  <span className="swatch" style={{ background: c.color }} />
                  {c.name}
                  <kbd>{c.id + 1}</kbd>
                </button>
              ))}
            </div>
          </section>
          <section>
            <h2>Snap</h2>
            <label className="check">
              <input
                type="checkbox"
                checked={showSnapDots}
                onChange={(e) => setShowSnapDots(e.target.checked)}
              />
              Show snap dots
            </label>
            <p className="hint">
              Cursor snaps to PDF vertices, then edges. Hold Shift for ortho. Space-drag or
              middle-drag to pan. Click the first vertex or press Enter to close a polygon.
            </p>
          </section>
          <section className="shapes">
            <h2>
              This page <span>{shapes.length}</span>
            </h2>
            <ul>
              {shapes.map((s, i) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className={selectedId === s.id ? "on" : ""}
                    onClick={() => {
                      setSelectedId(s.id);
                      setTool("select");
                    }}
                  >
                    <span className="swatch" style={{ background: classColor(s.classId) }} />
                    {className(s.classId)} {i + 1}
                  </button>
                  <button
                    type="button"
                    className="icon"
                    onClick={() => {
                      setPageShapes(shapes.filter((x) => x.id !== s.id));
                      if (selectedId === s.id) setSelectedId(null);
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
              {!shapes.length && <li className="empty">No shapes on this page.</li>}
            </ul>
          </section>
        </aside>

        <main>
          {pdf && pages[pageIndex] ? (
            <PdfStage
              pdf={pdf}
              pageIndex={pageIndex}
              pageSize={pages[pageIndex]}
              geometry={geometry}
              shapes={shapes}
              tool={tool}
              classId={classId}
              showSnapDots={showSnapDots}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onShapesChange={setPageShapes}
              onZoomChange={setZoom}
            />
          ) : (
            <div
              className="drop"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files[0];
                if (f && f.type === "application/pdf") void openPdf(f);
              }}
            >
              <p>Drop a vector blueprint PDF here</p>
              <label className="file-btn primary">
                Choose PDF
                <input
                  type="file"
                  accept="application/pdf"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void openPdf(f);
                  }}
                />
              </label>
            </div>
          )}
        </main>
      </div>

      <footer className="statusbar">
        <span>{status}</span>
        {geomLoading && <span className="pill">geometry…</span>}
        <span className="spacer" />
        <span>{Math.round(zoom * 100)}%</span>
        <span>{shapeCount} labeled</span>
      </footer>
    </div>
  );
}

function classColor(id: number): string {
  return CLASSES.find((c) => c.id === id)?.color ?? "#888";
}

function className(id: number): string {
  return CLASSES.find((c) => c.id === id)?.name ?? "class";
}
