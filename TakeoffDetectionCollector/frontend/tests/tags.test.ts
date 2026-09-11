import { describe, expect, it } from "vitest";
import {
  addTag,
  createLabel,
  jobMatchesTagFilter,
  mergeCatalog,
  normalizeTagName,
  removeTag,
  suggestTags,
} from "../src/lib/tags";

describe("tags", () => {
  it("trims and collapses spaces", () => {
    expect(normalizeTagName("  Hospital  East  ")).toBe("Hospital East");
    expect(normalizeTagName("   ")).toBeNull();
  });

  it("adds a new tag and reuses catalog casing", () => {
    expect(addTag([], ["Hospital"], "hospital")).toEqual(["Hospital"]);
    expect(addTag(["Hospital"], ["Hospital"], "hospital")).toEqual(["Hospital"]);
    expect(addTag(["QC"], ["Hospital"], "QC")).toEqual(["QC"]);
  });

  it("suggests unused catalog names", () => {
    expect(suggestTags(["Hospital", "QC", "West"], ["QC"], "h")).toEqual(["Hospital"]);
  });

  it("offers create only when the name is new", () => {
    expect(createLabel(["Hospital"], [], "QC")).toBe("QC");
    expect(createLabel(["Hospital"], [], "hospital")).toBeNull();
    expect(createLabel(["Hospital"], ["QC"], "qc")).toBeNull();
  });

  it("removes by case-insensitive name", () => {
    expect(removeTag(["Hospital", "QC"], "hospital")).toEqual(["QC"]);
  });

  it("filters jobs with any selected tag", () => {
    expect(jobMatchesTagFilter(["Hospital"], [])).toBe(true);
    expect(jobMatchesTagFilter(["Hospital"], ["hospital"])).toBe(true);
    expect(jobMatchesTagFilter(["QC"], ["Hospital"])).toBe(false);
    expect(jobMatchesTagFilter(["QC", "West"], ["Hospital", "qc"])).toBe(true);
  });

  it("merges catalog with tags already on jobs", () => {
    expect(mergeCatalog([{ name: "Hospital" }], [{ tags: ["QC"] }])).toEqual(["Hospital", "QC"]);
  });
});
