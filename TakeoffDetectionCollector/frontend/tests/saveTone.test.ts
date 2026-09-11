import { describe, expect, it } from "vitest";
import { SAVE_FAIL_MESSAGE, saveStatusLabel } from "../src/hooks/useAnnotationDraft";

describe("save status copy", () => {
  it("stays humane across tones", () => {
    expect(saveStatusLabel("idle")).toBe("All changes saved");
    expect(saveStatusLabel("dirty")).toBe("Unsaved edits");
    expect(saveStatusLabel("saving")).toBe("Saving…");
    expect(saveStatusLabel("saved")).toBe("Saved");
    expect(saveStatusLabel("error")).toBe(SAVE_FAIL_MESSAGE);
    expect(saveStatusLabel("error", "Your session expired. Sign in again to keep saving.")).toBe(
      "Your session expired. Sign in again to keep saving.",
    );
  });
});
