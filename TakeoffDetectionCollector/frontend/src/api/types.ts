export type BoxOrigin = "imported" | "user" | "model";

export interface Box {
  box_id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score?: number | null;
  category_id: number;
  origin?: BoxOrigin;
  edited?: boolean;
  class_name?: string;
  blackout?: boolean | null;
}

export interface PageVectorsSegments {
  lines: number[][];
  rects: number[][];
  quads: number[][];
  curves: number[][];
}

export interface PageVectorsDimText {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  parsed_feet: number;
  confidence: number;
}

export interface PageVectorsStats {
  raw_path_count: number;
  returned_segment_count: number;
  truncated: boolean;
  dropped_short: number;
  dropped_fill_only: number;
  dropped_hatch?: number;
  dropped_outside: number;
  curves_as_chords: number;
  fill_count?: number;
  point_count?: number;
}

export type PageVectorsUnsupportedReason =
  | "rotated_page"
  | "password_protected"
  | "empty_page"
  | "out_of_range";

export interface PageVectorsResponse {
  job_id: string;
  page_index: number;
  pdf_page?: number | null;
  pdf_available: boolean;
  coord_space: "pt";
  page_width_pt?: number | null;
  page_height_pt?: number | null;
  image_width_px?: number | null;
  image_height_px?: number | null;
  rotation: number;
  empty: boolean;
  unsupported_reason?: PageVectorsUnsupportedReason | null;
  extract_version: string;
  segments: PageVectorsSegments;
  fills?: number[][];
  points?: number[][];
  dim_texts: PageVectorsDimText[];
  stats: PageVectorsStats;
}

export type JobStatus = "imported" | "awaiting_pdf" | "ready" | "cleaning" | "done";

export interface Job {
  id: string;
  slug: string;
  title: string;
  status: JobStatus;
  conflict_count: number;
  page_count: number;
  box_count: number;
  has_pdf: boolean;
  created_at: string;
  updated_at: string;
}

export interface PageMeta {
  job_id: string;
  page_index: number;
  pdf_page: number;
  width_px75: number;
  height_px75: number;
  width_pt: number;
  height_pt: number;
  raster_dpi: number;
}

export interface StoredBox {
  id: string;
  class: string;
  origin: "imported" | "user";
  bbox_pt: [number, number, number, number];
  bbox_px75: [number, number, number, number];
  edited: boolean;
  coco_id?: number;
  category_id?: number;
}

export interface AnnotationPayload {
  job_id: string;
  page_index: number;
  version: number;
  boxes: StoredBox[];
}

export interface Revision {
  job_id: string;
  page_index: number;
  version: number;
  parent_version?: number | null;
  author_id?: string;
  storage_key: string;
  note?: string;
  created_at: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}
