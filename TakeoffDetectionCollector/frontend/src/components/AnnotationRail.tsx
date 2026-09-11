import { Link } from "react-router-dom";
import type { Box, Job, PageComment, Revision } from "../api/types";
import CommentThread from "./CommentThread";
import { CLASSES, classColor } from "../lib/classes";
import { SESSION_EXPIRED_MESSAGE, isSessionError } from "../lib/api";
import type { BlackoutRegion } from "../lib/pageBlackouts";
import { normalizeStatus } from "../lib/stages";
import type { AdjustSnap } from "../lib/snap";
import { STEP_HINT, STEP_LABEL, stepIndex, type Step } from "../lib/workflow";

type Props = {
  step: Step;
  job: Job;
  readOnly: boolean;
  lockNote: string | null;
  blackouts: BlackoutRegion[];
  boxes: Box[];
  selectedIds: string[];
  selectedBlackoutIndex: number | null;
  klass: string;
  boxTool: "select" | "draw" | "pan";
  adjustSnap: AdjustSnap;
  revisions: Revision[];
  comments: PageComment[];
  userId: string;
  postingComment: boolean;
  error: string | null;
  hasPdf: boolean;
  onBoxTool: (tool: "select" | "draw" | "pan") => void;
  onAdjustSnap: (next: AdjustSnap | ((prev: AdjustSnap) => AdjustSnap)) => void;
  onSnapAll: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClearBlackouts: () => void;
  onReclass: (name: string) => void;
  onRevert: (version: number) => void;
  onPdf: (file: File | undefined) => void;
  onPostComment: (body: string, annotationId: string | null) => void;
  onDeleteComment: (id: string) => void;
  onSelectAnnotation: (id: string) => void;
};

export default function AnnotationRail({
  step,
  job,
  readOnly,
  lockNote,
  blackouts,
  boxes,
  selectedIds,
  selectedBlackoutIndex,
  klass,
  boxTool,
  adjustSnap,
  revisions,
  comments,
  userId,
  postingComment,
  error,
  hasPdf,
  onBoxTool,
  onAdjustSnap,
  onSnapAll,
  onDuplicate,
  onDelete,
  onClearBlackouts,
  onReclass,
  onRevert,
  onPdf,
  onPostComment,
  onDeleteComment,
  onSelectAnnotation,
}: Props) {
  const selectedBoxes = boxes.filter((b) => selectedIds.includes(b.box_id));
  const sharedClass =
    selectedBoxes.length && selectedBoxes.every((b) => b.class_name === selectedBoxes[0]?.class_name)
      ? (selectedBoxes[0]?.class_name ?? null)
      : null;
  const sessionLost = error ? isSessionError(new Error(error)) || error === SESSION_EXPIRED_MESSAGE : false;
  const status = normalizeStatus(job.status);

  return (
    <aside className="rail">
      {readOnly ? (
        <section className="panel locked-panel">
          <h3>Read only</h3>
          <p className="hint">
            {lockNote ??
              (status === "complete"
                ? "This sheet is complete. You can still move it back to review or original."
                : "You do not hold this sheet.")}
          </p>
        </section>
      ) : null}

      <section className="panel step-panel">
        <h3>
          {stepIndex(step) + 1} · {STEP_LABEL[step]}
        </h3>
        <p className="hint">{STEP_HINT[step]}</p>

        {step === "blackout" ? (
          <>
            <div className="stat-row">
              <span className="stat-num">{blackouts.length}</span>
              <span className="stat-label">{blackouts.length === 1 ? "region covered" : "regions covered"}</span>
            </div>
            <div className="rail-actions">
              <button type="button" onClick={onDelete} disabled={selectedBlackoutIndex == null}>
                Delete selected
              </button>
              <button type="button" onClick={onClearBlackouts} disabled={!blackouts.length}>
                Clear all
              </button>
            </div>
            <p className="muted small">Drag a region to move it, or a corner to resize. ⌘Z undoes the last change.</p>
          </>
        ) : null}

        {step === "boxes" ? (
          <>
            <div className="seg">
              <button type="button" className={boxTool === "select" ? "active" : ""} onClick={() => onBoxTool("select")}>
                Select <span className="kbd">S</span>
              </button>
              <button type="button" className={boxTool === "draw" ? "active" : ""} onClick={() => onBoxTool("draw")}>
                Draw <span className="kbd">R</span>
              </button>
            </div>
            <h4>Snap to linework</h4>
            <div className="seg">
              <button
                type="button"
                className={adjustSnap.line ? "active" : ""}
                onClick={() => onAdjustSnap((s) => ({ ...s, line: !s.line }))}
              >
                Edges
              </button>
              <button
                type="button"
                className={adjustSnap.point ? "active" : ""}
                onClick={() => onAdjustSnap((s) => ({ ...s, point: !s.point }))}
              >
                Points
              </button>
            </div>
            <div className="rail-actions wrap">
              <button type="button" onClick={onSnapAll}>
                Snap all
              </button>
              <button type="button" onClick={onDuplicate} disabled={!selectedIds.length}>
                Duplicate
              </button>
              <button type="button" onClick={onDelete} disabled={!selectedIds.length}>
                Delete
              </button>
            </div>
            <p className="muted small">⌘C / ⌘V copy and paste. Alt-drag stamps a copy. Hold Alt while drawing to bypass snapping. ⌘Z / ⇧⌘Z undo and redo.</p>
            <h4>Draw as</h4>
            <div className="class-grid compact">
              {CLASSES.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  className={`class-chip${klass === c.name ? " active" : ""}`}
                  onClick={() => onReclass(c.name)}
                >
                  <span className="swatch" style={{ background: c.color }} />
                  <span className="cname">{c.name}</span>
                </button>
              ))}
            </div>
          </>
        ) : null}

        {step === "labels" ? (
          <>
            <div className="stat-row">
              <span className="stat-num">{boxes.length}</span>
              <span className="stat-label">{boxes.length === 1 ? "shape" : "shapes"} on this page</span>
            </div>
            {selectedBoxes.length ? (
              <div className="selected-info">
                <span className="swatch" style={{ background: classColor(sharedClass ?? "") }} />
                <span>
                  {selectedBoxes.length === 1 ? (
                    <>
                      Selected · <strong>{sharedClass ?? "unlabeled"}</strong>
                    </>
                  ) : (
                    <>
                      <strong>{selectedBoxes.length}</strong> selected
                      {sharedClass ? (
                        <>
                          {" "}
                          · <strong>{sharedClass}</strong>
                        </>
                      ) : (
                        " · mixed classes"
                      )}
                    </>
                  )}
                </span>
              </div>
            ) : (
              <div className="selected-info none">Click or drag-select shapes, then pick a class.</div>
            )}
            <div className="class-grid">
              {CLASSES.map((c) => {
                const count = boxes.filter((b) => b.class_name === c.name).length;
                return (
                  <button
                    key={c.name}
                    type="button"
                    className={`class-chip${(sharedClass ?? (selectedBoxes.length ? "" : klass)) === c.name ? " active" : ""}`}
                    onClick={() => onReclass(c.name)}
                    title={`Assign ${c.name} (${count})`}
                  >
                    <span className="swatch" style={{ background: c.color }} />
                    <span className="cname">{c.name}</span>
                    <span className="kbd">{count}</span>
                  </button>
                );
              })}
            </div>
          </>
        ) : null}
      </section>

      <CommentThread
        comments={comments}
        boxes={boxes}
        selectedIds={selectedIds}
        userId={userId}
        posting={postingComment}
        onPost={onPostComment}
        onDelete={onDeleteComment}
        onSelectAnnotation={onSelectAnnotation}
      />

      {!hasPdf ? (
        <section className="panel">
          <h3>Sheet PDF</h3>
          <p className="muted small">This job has no linked vector PDF yet.</p>
          <label className="btn-ghost file-btn">
            Attach vector PDF
            <input type="file" accept="application/pdf" hidden onChange={(e) => onPdf(e.target.files?.[0])} />
          </label>
        </section>
      ) : null}

      <details className="panel versions-panel">
        <summary>
          Versions <span className="muted">{revisions.length ? `v${revisions[0]?.version}` : ""}</span>
        </summary>
        <ul className="revs">
          {revisions.map((r) => (
            <li key={r.version}>
              <button type="button" onClick={() => onRevert(r.version)}>
                <span className="rev-v">v{r.version}</span>
                <span className="rev-note">{r.note}</span>
              </button>
            </li>
          ))}
        </ul>
      </details>
      {error ? (
        <p className="error">
          {sessionLost ? (
            <>
              {SESSION_EXPIRED_MESSAGE} <Link to="/login">Sign in again</Link>
            </>
          ) : (
            error
          )}
        </p>
      ) : null}
    </aside>
  );
}
