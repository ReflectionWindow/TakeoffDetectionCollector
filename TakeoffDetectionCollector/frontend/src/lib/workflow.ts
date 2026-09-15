/**
 * Correcting a sheet runs in three ordered steps: black out the Bluebeam
 * markups, fix the box geometry, then fix the labels. Each step exposes only
 * the tools it needs, so a corrector cannot nudge geometry while labelling or
 * fight the snap engine while redacting.
 */

export type Step = "blackout" | "boxes" | "labels";

export const STEPS: Step[] = ["blackout", "boxes", "labels"];

export const STEP_LABEL: Record<Step, string> = {
  blackout: "Black out",
  boxes: "Box Edits",
  labels: "Labels",
};

export const STEP_CONTINUE: Record<Step, string | null> = {
  blackout: "Continue to Box Edits",
  boxes: "Continue to Labels",
  labels: null,
};

export function parseStep(raw: string | null | undefined): Step {
  return raw === "boxes" || raw === "labels" || raw === "blackout" ? raw : "blackout";
}

export const STEP_BLURB: Record<Step, string> = {
  blackout: "Cover the takeoff markups so the shapes underneath are judged on their own.",
  boxes: "Reshape imported rectangles into polygons that follow the real opening.",
  labels: "Confirm the class on every shape. Geometry is locked so nothing shifts.",
};

export const STEP_HINT: Record<Step, string> = {
  blackout: "Drag to cover a markup. Drag a region to move it, or a corner to resize. Delete removes the selection.",
  boxes:
    "Click to add polygon vertices (Enter or click the first point to close). Drag to place a quad. Drag vertices or edges to adjust. Drag empty space or Shift-click to select a group. ⌘C / ⌘V copy and paste, ⌘D duplicates, Alt-drag stamps a copy.",
  labels: "Click a shape, or drag across several — you can start on a shape. Shift-click adds. Pick a class to assign.",
}

/** Snapping only helps while fitting geometry to linework. */
export function snapEnabled(step: Step): boolean {
  return step === "boxes";
}

/** Geometry is editable only in the box step. */
export function geometryLocked(step: Step): boolean {
  return step !== "boxes";
}

export function blackoutEnabled(step: Step): boolean {
  return step === "blackout";
}

/** Opening geometry is hidden while covering markups. */
export function boxesVisible(step: Step): boolean {
  return step !== "blackout";
}

/** Class names stay off the sheet until the labels step. */
export function labelsVisible(step: Step): boolean {
  return step === "labels";
}

export function stepIndex(step: Step): number {
  return STEPS.indexOf(step);
}

export function nextStep(step: Step): Step | null {
  return STEPS[stepIndex(step) + 1] ?? null;
}

export function prevStep(step: Step): Step | null {
  const i = stepIndex(step);
  return i > 0 ? STEPS[i - 1]! : null;
}
