export const CLASSES = [
  { id: 0, name: "louvre", color: "#f5a623" },
  { id: 1, name: "metal_panel", color: "#7c9cff" },
  { id: 2, name: "window", color: "#3ecf8e" },
] as const;

export type ClassId = (typeof CLASSES)[number]["id"];
export type Tool = "polygon" | "rectangle" | "select";

export interface Point {
  x: number;
  y: number;
}

export interface Shape {
  id: string;
  classId: ClassId;
  points: Point[];
}

export interface PageMeta {
  width: number;
  height: number;
}

export interface Geometry {
  width: number;
  height: number;
  points: [number, number][];
  segments: [number, number][];
}

export interface UploadResponse {
  fileId: string;
  pageCount: number;
  pages: PageMeta[];
}

export interface ProjectFile {
  version: 1;
  fileName: string;
  pages: Record<string, Shape[]>;
}

export type SnapKind = "vertex" | "edge";

export interface SnapResult {
  x: number;
  y: number;
  kind: SnapKind;
}
