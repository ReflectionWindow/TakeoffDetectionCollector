import { Link } from "react-router-dom";
import type { JobStatus } from "../api/types";
import { SESSION_EXPIRED_MESSAGE } from "../lib/api";
import type { SaveTone } from "../hooks/useAnnotationDraft";
import { saveStatusLabel } from "../hooks/useAnnotationDraft";
import type { StatusAction } from "../lib/stages";

type Props = {
  saveTone: SaveTone;
  saveError?: string | null;
  pageLabel: string;
  canPrevPage: boolean;
  canNextPage: boolean;
  onPrevPage: () => void;
  onNextPage: () => void;
  continueLabel: string | null;
  onContinue: () => void;
  continueDisabled?: boolean;
  boxesHidden?: boolean;
  onToggleBoxesHidden?: () => void;
  statusActions?: StatusAction[];
  onStatusAction?: (stage: JobStatus) => void;
  readOnly: boolean;
};

export default function BoxToolbar({
  saveTone,
  saveError = null,
  pageLabel,
  canPrevPage,
  canNextPage,
  onPrevPage,
  onNextPage,
  continueLabel,
  onContinue,
  continueDisabled = false,
  boxesHidden = false,
  onToggleBoxesHidden,
  statusActions = [],
  onStatusAction,
  readOnly,
}: Props) {
  const toneClass =
    saveTone === "error" ? "save-tone error" : saveTone === "saved" || saveTone === "idle" ? "save-tone ok" : "save-tone dirty";

  return (
    <div className="box-toolbar">
      <div className="box-toolbar-side">
        <span className={toneClass} aria-live="polite">
          {saveStatusLabel(saveTone, saveError)}
          {saveTone === "error" && saveError === SESSION_EXPIRED_MESSAGE ? (
            <>
              {" "}
              <Link to="/login">Sign in again</Link>
            </>
          ) : null}
        </span>
      </div>
      <div className="page-nav">
        <button type="button" className="page-nav-btn" disabled={!canPrevPage} onClick={onPrevPage} aria-label="Previous page">
          ‹
        </button>
        <span className="page-nav-label">{pageLabel}</span>
        <button type="button" className="page-nav-btn" disabled={!canNextPage} onClick={onNextPage} aria-label="Next page">
          ›
        </button>
      </div>
      <div className="box-toolbar-side box-toolbar-end">
        {onToggleBoxesHidden ? (
          <button
            type="button"
            className="btn-ghost"
            aria-pressed={boxesHidden}
            onClick={onToggleBoxesHidden}
          >
            {boxesHidden ? "Show boxes" : "Hide boxes"}
          </button>
        ) : null}
        {continueLabel ? (
          <button type="button" className="btn-primary" disabled={continueDisabled} onClick={onContinue}>
            {continueLabel}
          </button>
        ) : null}
        {statusActions.map((action, i) => (
          <button
            key={action.stage}
            type="button"
            className={!continueLabel && i === 0 ? "btn-primary" : "btn-ghost"}
            onClick={() => onStatusAction?.(action.stage)}
          >
            {action.label}
          </button>
        ))}
        {readOnly ? <span className="page-subtitle">Read-only</span> : null}
      </div>
    </div>
  );
}
