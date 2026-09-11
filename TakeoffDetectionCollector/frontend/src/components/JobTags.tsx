import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  MAX_TAG_LEN,
  MAX_TAGS_PER_JOB,
  addTag,
  createLabel,
  jobTags,
  removeTag,
  suggestTags,
} from "../lib/tags";

type Props = {
  tags: string[] | undefined;
  catalog: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
  compact?: boolean;
};

export default function JobTags({ tags, catalog, onChange, disabled, compact }: Props) {
  const assigned = jobTags(tags);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const suggestions = useMemo(() => suggestTags(catalog, assigned, query), [catalog, assigned, query]);
  const created = createLabel(catalog, assigned, query);
  const options = created ? [...suggestions, `__create:${created}`] : suggestions;
  const atCap = assigned.length >= MAX_TAGS_PER_JOB;

  useEffect(() => {
    if (!open) return;
    const onPtr = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPtr);
    return () => window.removeEventListener("pointerdown", onPtr);
  }, [open]);

  useEffect(() => {
    setHi(0);
  }, [query, open]);

  function commit(raw: string) {
    const next = addTag(assigned, catalog, raw);
    if (!next) return;
    setQuery("");
    if (next !== assigned) onChange(next);
    setOpen(true);
    inputRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHi((n) => (options.length ? (n + 1) % options.length : 0));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setHi((n) => (options.length ? (n - 1 + options.length) % options.length : 0));
      return;
    }
    if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
      return;
    }
    if (e.key === "Backspace" && !query && assigned.length) {
      onChange(removeTag(assigned, assigned[assigned.length - 1]!));
      return;
    }
    if (e.key === "Enter" || e.key === ",") {
      const pick = options[hi];
      if (open && pick) {
        e.preventDefault();
        commit(pick.startsWith("__create:") ? pick.slice(9) : pick);
        return;
      }
      if (query.trim()) {
        e.preventDefault();
        commit(query);
      }
    }
  }

  const showMenu = open && !disabled && !atCap && (options.length > 0 || Boolean(query.trim()));

  return (
    <div ref={wrapRef} className={`job-tags${compact ? " compact" : ""}`} onClick={(e) => e.stopPropagation()}>
      {assigned.map((name) => (
        <span key={name} className="pill tag">
          {name}
          {disabled ? null : (
            <button
              type="button"
              className="tag-x"
              aria-label={`Remove ${name}`}
              onClick={() => onChange(removeTag(assigned, name))}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {disabled || atCap ? null : (
        <input
          ref={inputRef}
          className="tag-input"
          value={query}
          maxLength={MAX_TAG_LEN}
          placeholder={assigned.length ? "Add tag" : "Add or find a tag"}
          aria-label="Add tag"
          aria-autocomplete="list"
          aria-expanded={showMenu}
          aria-controls={listId}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
      )}
      {showMenu ? (
        <ul id={listId} className="tag-menu" role="listbox">
          {suggestions.map((name, i) => (
            <li key={name} role="option" aria-selected={hi === i}>
              <button
                type="button"
                className={hi === i ? "active" : ""}
                onMouseEnter={() => setHi(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit(name)}
              >
                {name}
              </button>
            </li>
          ))}
          {created ? (
            <li role="option" aria-selected={hi === suggestions.length}>
              <button
                type="button"
                className={hi === suggestions.length ? "active" : ""}
                onMouseEnter={() => setHi(suggestions.length)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit(created)}
              >
                Create “{created}”
              </button>
            </li>
          ) : null}
          {!options.length && query.trim() ? <li className="tag-empty">No matches</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
