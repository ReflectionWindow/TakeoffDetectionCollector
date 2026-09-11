import { describe, expect, it } from "vitest";
import {
  ROOT_UPLOAD_DEST,
  uploadDestinationLabel,
  uploadDestinations,
  uploadProjectId,
} from "../src/lib/projects";

describe("upload destination", () => {
  const projects = [
    { id: "p-manila", name: "Manila" },
    { id: "p-chicago", name: "Chicago" },
  ];

  it("lists Root plus every project", () => {
    expect(uploadDestinations(projects)).toEqual([
      { id: ROOT_UPLOAD_DEST, name: "Root" },
      { id: "p-manila", name: "Manila" },
      { id: "p-chicago", name: "Chicago" },
    ]);
  });

  it("sends Root uploads with no project id", () => {
    expect(uploadProjectId("")).toBe("");
    expect(uploadProjectId("root")).toBe("");
    expect(uploadDestinationLabel("", projects)).toBe("Root");
    expect(uploadDestinationLabel("root", projects)).toBe("Root");
  });

  it("can target Chicago or Manila without using the inbox filter", () => {
    expect(uploadProjectId("p-chicago")).toBe("p-chicago");
    expect(uploadDestinationLabel("p-chicago", projects)).toBe("Chicago");
    expect(uploadProjectId("p-manila")).toBe("p-manila");
    expect(uploadDestinationLabel("p-manila", projects)).toBe("Manila");
  });
});
