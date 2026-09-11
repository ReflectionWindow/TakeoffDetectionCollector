import { useEffect, useState } from "react";
import type { Box, PageComment } from "../api/types";
import {
  MAX_COMMENT_LEN,
  commentAuthorLabel,
  commentTimeLabel,
  linkedBox,
  normalizeCommentBody,
} from "../lib/comments";

type Props = {
  comments: PageComment[];
  boxes: Box[];
  selectedIds: string[];
  userId: string;
  posting: boolean;
  onPost: (body: string, annotationId: string | null) => void;
  onDelete: (id: string) => void;
  onSelectAnnotation: (id: string) => void;
};

export default function CommentThread({
  comments,
  boxes,
  selectedIds,
  userId,
  posting,
  onPost,
  onDelete,
  onSelectAnnotation,
}: Props) {
  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null;
  const selectedBox = selectedId ? boxes.find((b) => b.box_id === selectedId) : undefined;
  const [body, setBody] = useState("");
  const [linkSelection, setLinkSelection] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(tick);
  }, []);

  const draft = normalizeCommentBody(body);
  const canPost = draft.length > 0 && draft.length <= MAX_COMMENT_LEN && !posting;

  function submit() {
    if (!canPost) return;
    onPost(draft, linkSelection && selectedId ? selectedId : null);
    setBody("");
  }

  return (
    <section className="panel comments-panel">
      <h3>
        Comments <span className="muted">{comments.length || ""}</span>
      </h3>
      {comments.length ? (
        <ul className="comment-list">
          {comments.map((comment) => {
            const linked = linkedBox(comment, boxes);
            const missing = Boolean(comment.annotation_id) && !linked;
            return (
              <li key={comment.id} className="comment-item">
                <div className="comment-meta">
                  <strong>{commentAuthorLabel(comment)}</strong>
                  <span className="muted small">{commentTimeLabel(comment.created_at, now)}</span>
                  {comment.author_id === userId ? (
                    <button type="button" className="comment-delete" onClick={() => onDelete(comment.id)}>
                      Delete
                    </button>
                  ) : null}
                </div>
                <p className="comment-body">{comment.body}</p>
                {comment.annotation_id ? (
                  <button
                    type="button"
                    className="comment-link"
                    onClick={() => onSelectAnnotation(comment.annotation_id!)}
                    disabled={missing}
                  >
                    {linked
                      ? `On ${linked.class_name || "shape"}`
                      : missing
                        ? "Linked shape is gone"
                        : "Linked shape"}
                  </button>
                ) : (
                  <span className="muted small">This page</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted small">Notes on this page are shared with everyone who opens the job.</p>
      )}
      <textarea
        className="comment-input"
        rows={3}
        maxLength={MAX_COMMENT_LEN}
        placeholder={selectedBox ? `Note on ${selectedBox.class_name || "this shape"}…` : "Leave a note on this page…"}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      />
      {selectedId ? (
        <label className="comment-link-toggle">
          <input type="checkbox" checked={linkSelection} onChange={(e) => setLinkSelection(e.target.checked)} />
          Link to selected shape{selectedBox?.class_name ? ` (${selectedBox.class_name})` : ""}
        </label>
      ) : (
        <p className="muted small">Select a shape to attach this note to it.</p>
      )}
      <div className="rail-actions">
        <button type="button" onClick={submit} disabled={!canPost}>
          {posting ? "Posting…" : "Post comment"}
        </button>
      </div>
    </section>
  );
}
