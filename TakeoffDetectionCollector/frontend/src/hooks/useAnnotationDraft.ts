import { useCallback, useEffect, useRef, useState } from "react";
import type { Box } from "../api/types";

export type SaveTone = "idle" | "dirty" | "saving" | "saved" | "error";

const DEBOUNCE_MS = 300;
const MAX_HISTORY = 50;
export const SAVE_FAIL_MESSAGE = "Couldn't save just now. Your boxes are still on this page.";

function cloneBoxes(boxes: Box[]): Box[] {
  return boxes.map((b) => ({ ...b, points: b.points.map((p) => ({ ...p })) }));
}

export function saveStatusLabel(tone: SaveTone, saveError?: string | null): string {
  switch (tone) {
    case "dirty":
      return "Unsaved edits";
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved";
    case "error":
      return saveError || SAVE_FAIL_MESSAGE;
    default:
      return "All changes saved";
  }
}

type PersistFn = (boxes: Box[]) => Promise<void>;

/**
 * Optimistic boxes with a short undo stack and a 300ms save debounce, so
 * editing never waits on the network. Page flips hydrate from an in-memory
 * cache first.
 */
export function useAnnotationDraft(opts: { persist: PersistFn; writable: boolean }) {
  const persistRef = useRef(opts.persist);
  persistRef.current = opts.persist;
  const writableRef = useRef(opts.writable);
  writableRef.current = opts.writable;

  const [boxes, setBoxesState] = useState<Box[]>([]);
  const [saveTone, setSaveTone] = useState<SaveTone>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const boxesRef = useRef<Box[]>([]);
  const historyRef = useRef<Box[][]>([]);
  const futureRef = useRef<Box[][]>([]);
  const debounceRef = useRef<number | null>(null);
  const cacheRef = useRef(new Map<string, Box[]>());
  const saveGenRef = useRef(0);
  const pageKeyRef = useRef<string>("");
  const toneRef = useRef<SaveTone>("idle");

  const setTone = useCallback((tone: SaveTone) => {
    toneRef.current = tone;
    setSaveTone(tone);
  }, []);

  const syncHistoryFlags = useCallback(() => {
    setCanUndo(historyRef.current.length > 0);
    setCanRedo(futureRef.current.length > 0);
  }, []);

  const replace = useCallback(
    (next: Box[], record: boolean) => {
      if (record) {
        historyRef.current = [...historyRef.current, cloneBoxes(boxesRef.current)].slice(-MAX_HISTORY);
        futureRef.current = [];
      }
      boxesRef.current = next;
      setBoxesState(next);
      if (pageKeyRef.current) cacheRef.current.set(pageKeyRef.current, cloneBoxes(next));
      syncHistoryFlags();
    },
    [syncHistoryFlags],
  );

  const flush = useCallback(async () => {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (!writableRef.current) return;
    if (toneRef.current !== "dirty" && toneRef.current !== "error") return;
    const gen = ++saveGenRef.current;
    setTone("saving");
    setSaveError(null);
    try {
      await persistRef.current(boxesRef.current);
      if (gen !== saveGenRef.current) return;
      setTone("saved");
    } catch (err) {
      if (gen !== saveGenRef.current) return;
      setTone("error");
      setSaveError(err instanceof Error ? err.message : SAVE_FAIL_MESSAGE);
    }
  }, [setTone]);

  const scheduleSave = useCallback(() => {
    if (!writableRef.current) return;
    setTone("dirty");
    setSaveError(null);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      void flush();
    }, DEBOUNCE_MS);
  }, [flush, setTone]);

  const setBoxes = useCallback(
    (next: Box[] | ((prev: Box[]) => Box[])) => {
      const resolved = typeof next === "function" ? next(boxesRef.current) : next;
      replace(resolved, true);
      scheduleSave();
    },
    [replace, scheduleSave],
  );

  const undo = useCallback(() => {
    const prev = historyRef.current.pop();
    if (!prev) return;
    futureRef.current.push(cloneBoxes(boxesRef.current));
    boxesRef.current = prev;
    setBoxesState(prev);
    if (pageKeyRef.current) cacheRef.current.set(pageKeyRef.current, cloneBoxes(prev));
    syncHistoryFlags();
    scheduleSave();
  }, [scheduleSave, syncHistoryFlags]);

  const redo = useCallback(() => {
    const next = futureRef.current.pop();
    if (!next) return;
    historyRef.current.push(cloneBoxes(boxesRef.current));
    boxesRef.current = next;
    setBoxesState(next);
    if (pageKeyRef.current) cacheRef.current.set(pageKeyRef.current, cloneBoxes(next));
    syncHistoryFlags();
    scheduleSave();
  }, [scheduleSave, syncHistoryFlags]);

  const cached = useCallback((key: string): Box[] | null => {
    const hit = cacheRef.current.get(key);
    return hit ? cloneBoxes(hit) : null;
  }, []);

  /** Fill the page cache without swapping the visible draft. */
  const warm = useCallback((key: string, next: Box[]) => {
    if (cacheRef.current.has(key)) return;
    cacheRef.current.set(key, cloneBoxes(next));
  }, []);

  const hydrate = useCallback(
    (key: string, next: Box[]) => {
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      pageKeyRef.current = key;
      saveGenRef.current += 1;
      historyRef.current = [];
      futureRef.current = [];
      boxesRef.current = next;
      setBoxesState(next);
      cacheRef.current.set(key, cloneBoxes(next));
      setTone("idle");
      setSaveError(null);
      syncHistoryFlags();
    },
    [setTone, syncHistoryFlags],
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, []);

  return {
    boxes,
    setBoxes,
    saveTone,
    saveError,
    canUndo,
    canRedo,
    undo,
    redo,
    flush,
    hydrate,
    cached,
    warm,
    pageKey: pageKeyRef,
  };
}
