import { describe, expect, it } from "vitest";
import {
  STEPS,
  blackoutEnabled,
  boxesVisible,
  geometryLocked,
  labelsVisible,
  nextStep,
  parseStep,
  prevStep,
  snapEnabled,
  stepIndex,
} from "../src/lib/workflow";

describe("workflow steps", () => {
  it("runs blackout, then boxes, then labels", () => {
    expect(STEPS).toEqual(["blackout", "boxes", "labels"]);
    expect(stepIndex("blackout")).toBe(0);
    expect(stepIndex("labels")).toBe(2);
  });

  it("walks forward and stops at the end", () => {
    expect(nextStep("blackout")).toBe("boxes");
    expect(nextStep("boxes")).toBe("labels");
    expect(nextStep("labels")).toBeNull();
  });

  it("walks back and stops at the start", () => {
    expect(prevStep("labels")).toBe("boxes");
    expect(prevStep("boxes")).toBe("blackout");
    expect(prevStep("blackout")).toBeNull();
  });

  it("parses a stage from the URL and ignores junk", () => {
    expect(parseStep("boxes")).toBe("boxes");
    expect(parseStep("labels")).toBe("labels");
    expect(parseStep("nope")).toBe("blackout");
    expect(parseStep(null)).toBe("blackout");
  });

  it("keeps snapping out of the blackout step", () => {
    expect(snapEnabled("blackout")).toBe(false);
    expect(snapEnabled("boxes")).toBe(true);
    expect(snapEnabled("labels")).toBe(false);
  });

  it("only unlocks geometry while editing boxes", () => {
    expect(geometryLocked("blackout")).toBe(true);
    expect(geometryLocked("boxes")).toBe(false);
    expect(geometryLocked("labels")).toBe(true);
  });

  it("only draws blackout regions in the blackout step", () => {
    expect(blackoutEnabled("blackout")).toBe(true);
    expect(blackoutEnabled("boxes")).toBe(false);
    expect(blackoutEnabled("labels")).toBe(false);
  });

  it("hides opening geometry during blackout and labels until the labels step", () => {
    expect(boxesVisible("blackout")).toBe(false);
    expect(boxesVisible("boxes")).toBe(true);
    expect(boxesVisible("labels")).toBe(true);
    expect(labelsVisible("blackout")).toBe(false);
    expect(labelsVisible("boxes")).toBe(false);
    expect(labelsVisible("labels")).toBe(true);
  });
});
