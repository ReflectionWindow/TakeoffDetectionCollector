import { describe, expect, it } from "vitest";
import { uploadDestinationLabel, uploadProjectId } from "../src/lib/projects";

describe("upload destination", () => {
  const projects = [
    { id: "p-manila", name: "Manila" },
    { id: "p-chicago", name: "Chicago" },
  ];

  it("sends All and Root uploads to Root", () => {
    expect(uploadProjectId("")).toBe("");
    expect(uploadProjectId("root")).toBe("");
    expect(uploadDestinationLabel("", projects)).toBe("Root");
    expect(uploadDestinationLabel("root", projects)).toBe("Root");
  });

  it("targets the selected project", () => {
    expect(uploadProjectId("p-chicago")).toBe("p-chicago");
    expect(uploadDestinationLabel("p-chicago", projects)).toBe("Chicago");
  });
});
