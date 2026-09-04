"""Rasterize blueprint PDFs/images and run pretrained YOLO11-seg."""

from __future__ import annotations

import argparse
import json
import os
import re
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

DEFAULT_DPI = 200
DEFAULT_IMGSZ = 1280
DEFAULT_CONF = 0.25
DEFAULT_MODEL_NAME = "yolo11m-seg.pt"
DEFAULT_YOLOE_NAME = "yoloe-11m-seg.pt"
DEFAULT_YOLOE_PROMPTS = ["louvre", "metal panel", "window"]
DEFAULT_TILE_SIZE = 1280
DEFAULT_TILE_OVERLAP = 0.2
DEFAULT_IOU = 0.5

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
PDF_EXTS = {".pdf"}

# TakeoffDetection/
#   DataCleaning/   snap annotator
#   pipeline/       this package
PIPELINE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = PIPELINE_DIR.parent
DATACLEANING_DIR = PROJECT_ROOT / "DataCleaning"
INPUT_DIR = PIPELINE_DIR / "input"
OUTPUT_DIR = PIPELINE_DIR / "output"
WEIGHTS_DIR = PIPELINE_DIR / "weights"
DEFAULT_MODEL = str(WEIGHTS_DIR / DEFAULT_MODEL_NAME)
DEFAULT_YOLOE = str(WEIGHTS_DIR / DEFAULT_YOLOE_NAME)


@dataclass
class Detection:
    class_name: str
    class_id: int
    confidence: float
    bbox_xyxy: list[float]
    mask_polygon: list[list[float]]


@dataclass
class PageInference:
    source: str
    page_index: int
    stem: str
    width: int
    height: int
    image_rgb: np.ndarray
    overlay_bgr: np.ndarray
    detections: list[Detection]

    @property
    def overlay_rgb(self) -> np.ndarray:
        return self.overlay_bgr[:, :, ::-1]


def sanitize_stem(name: str) -> str:
    cleaned = re.sub(r"[^\w.-]+", "_", name).strip("._")
    return cleaned or "sheet"


def collect_sources(input_path: Path) -> list[Path]:
    path = Path(input_path).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"Input not found: {path}")
    if path.is_file():
        suffix = path.suffix.lower()
        if suffix not in PDF_EXTS | IMAGE_EXTS:
            raise ValueError(f"Unsupported file type: {path.suffix}")
        return [path]
    sources = [
        p
        for p in sorted(path.iterdir())
        if p.is_file() and p.suffix.lower() in PDF_EXTS | IMAGE_EXTS
    ]
    if not sources:
        raise FileNotFoundError(
            f"No PDF or image files in {path}. Drop blueprints into {INPUT_DIR}."
        )
    return sources


def rasterize_pdf(path: Path, dpi: int = DEFAULT_DPI) -> list[tuple[int, np.ndarray, str]]:
    import fitz

    doc = fitz.open(path)
    base = sanitize_stem(path.stem)
    matrix = fitz.Matrix(dpi / 72, dpi / 72)
    pages: list[tuple[int, np.ndarray, str]] = []
    try:
        for index, page in enumerate(doc):
            pix = page.get_pixmap(matrix=matrix, alpha=False)
            image = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
            if pix.n == 4:
                image = image[:, :, :3]
            elif pix.n == 1:
                image = np.repeat(image, 3, axis=2)
            pages.append((index, np.ascontiguousarray(image), f"{base}_p{index + 1:03d}"))
    finally:
        doc.close()
    return pages


def load_image(path: Path) -> tuple[int, np.ndarray, str]:
    import cv2

    bgr = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError(f"Could not read image: {path}")
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    return 0, rgb, sanitize_stem(path.stem)


def collect_pages(input_path: Path, dpi: int = DEFAULT_DPI) -> list[dict]:
    pages: list[dict] = []
    for source in collect_sources(input_path):
        if source.suffix.lower() in PDF_EXTS:
            rendered = rasterize_pdf(source, dpi=dpi)
        else:
            rendered = [load_image(source)]
        for page_index, image_rgb, stem in rendered:
            pages.append(
                {
                    "source": str(source),
                    "page_index": page_index,
                    "stem": stem,
                    "width": int(image_rgb.shape[1]),
                    "height": int(image_rgb.shape[0]),
                    "image_rgb": image_rgb,
                }
            )
    return pages


def resolve_weights(weights: str | Path = DEFAULT_MODEL) -> str:
    path = Path(weights).expanduser()
    name = path.name if path.suffix else str(weights)
    for candidate in (
        path if path.is_absolute() else None,
        WEIGHTS_DIR / name,
        PIPELINE_DIR / name,
        PIPELINE_DIR / "notebooks" / name,
        PROJECT_ROOT / name,
    ):
        if candidate is not None and candidate.is_file():
            return str(candidate.resolve())
    return name


def load_model(weights: str = DEFAULT_MODEL):
    from ultralytics import YOLO

    resolved = resolve_weights(weights)
    path = Path(resolved)
    if path.is_file():
        return YOLO(str(path))
    WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    prev = os.getcwd()
    os.chdir(WEIGHTS_DIR)
    try:
        return YOLO(path.name)
    finally:
        os.chdir(prev)


def load_yoloe(
    weights: str = DEFAULT_YOLOE_NAME,
    classes: list[str] | None = None,
):
    """Load a YOLOE-seg checkpoint.

    Pass `classes` for text prompts. Omit them when you will bind visual
    example boxes with `bind_visual_prompts`.
    """
    from ultralytics import YOLOE

    resolved = resolve_weights(weights)
    path = Path(resolved)
    WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    prev = os.getcwd()
    os.chdir(WEIGHTS_DIR)
    try:
        source = str(path) if path.is_file() else path.name
        model = YOLOE(source)
        if classes:
            model.set_classes(list(classes))
        return model
    finally:
        os.chdir(prev)


def make_visual_prompt_board(
    image: np.ndarray,
    bboxes: np.ndarray,
    columns: int = 3,
    padding: int = 24,
) -> tuple[np.ndarray, np.ndarray]:
    """Pack prompt crops into a compact image and return their new xyxy boxes."""
    boxes = np.asarray(bboxes, dtype=np.int32)
    if boxes.ndim != 2 or boxes.shape[1] != 4 or len(boxes) == 0:
        raise ValueError(f"bboxes must have non-empty shape (N, 4), got {boxes.shape}")
    if columns < 1 or padding < 0:
        raise ValueError("columns must be positive and padding must be non-negative")

    height, width = image.shape[:2]
    crops = []
    for x1, y1, x2, y2 in boxes:
        x1, x2 = np.clip((x1, x2), 0, width)
        y1, y2 = np.clip((y1, y2), 0, height)
        if x2 <= x1 or y2 <= y1:
            raise ValueError(f"invalid or empty prompt box: {[x1, y1, x2, y2]}")
        crops.append(np.ascontiguousarray(image[y1:y2, x1:x2]))

    rows = [crops[i : i + columns] for i in range(0, len(crops), columns)]
    row_heights = [max(crop.shape[0] for crop in row) for row in rows]
    row_widths = [sum(crop.shape[1] for crop in row) + padding * (len(row) + 1) for row in rows]
    board_height = sum(row_heights) + padding * (len(rows) + 1)
    board_width = max(row_widths)
    board = np.full((board_height, board_width, image.shape[2]), 255, dtype=image.dtype)

    packed_boxes = []
    y = padding
    for row, row_height in zip(rows, row_heights):
        x = padding
        for crop in row:
            crop_height, crop_width = crop.shape[:2]
            board[y : y + crop_height, x : x + crop_width] = crop
            packed_boxes.append([x, y, x + crop_width, y + crop_height])
            x += crop_width + padding
        y += row_height + padding
    return board, np.asarray(packed_boxes, dtype=np.float32)


def bind_visual_prompts(
    model,
    refer_image: np.ndarray,
    bboxes: np.ndarray,
    class_ids: np.ndarray,
    names: list[str],
    imgsz: int = DEFAULT_IMGSZ,
):
    """Bake visual-example embeddings into `model` from boxes on `refer_image`.

    `bboxes` are xyxy in the reference image's pixel space. `class_ids` must
    include every index in `names` (0..n-1). After this call, later
    `model.predict` uses those embeddings and no longer needs prompts.
    """
    from ultralytics.models.yolo.yoloe import YOLOEVPSegPredictor

    boxes = np.asarray(bboxes, dtype=np.float32)
    classes = np.asarray(class_ids, dtype=np.int32)
    expected_classes = set(range(len(names)))
    if boxes.ndim != 2 or boxes.shape[1] != 4:
        raise ValueError(f"bboxes must have shape (N, 4), got {boxes.shape}")
    if classes.ndim != 1 or len(classes) != len(boxes):
        raise ValueError("class_ids must have shape (N,) and match bboxes")
    if set(classes.tolist()) != expected_classes:
        raise ValueError(f"class_ids must include every class index 0..{len(names) - 1}")

    visual_prompts = {
        "bboxes": boxes,
        "cls": classes,
    }
    model.predict(
        refer_image,
        visual_prompts=visual_prompts,
        refer_image=refer_image,
        predictor=YOLOEVPSegPredictor,
        imgsz=imgsz,
        verbose=False,
    )
    model.set_classes(list(names), embeddings=model.model.pe)
    return model


def _simplify_polygon(xy: np.ndarray, epsilon_ratio: float = 0.002) -> list[list[float]]:
    import cv2

    if xy is None or len(xy) < 3:
        return []
    pts = np.asarray(xy, dtype=np.float32).reshape(-1, 1, 2)
    peri = cv2.arcLength(pts, True)
    epsilon = max(epsilon_ratio * peri, 1.0)
    approx = cv2.approxPolyDP(pts, epsilon, True).reshape(-1, 2)
    if len(approx) < 3:
        approx = np.asarray(xy, dtype=np.float32).reshape(-1, 2)
    return [[round(float(x), 2), round(float(y), 2)] for x, y in approx]


def serialize_detections(
    result,
    dx: float = 0.0,
    dy: float = 0.0,
    width: int | None = None,
    height: int | None = None,
) -> list[Detection]:
    detections: list[Detection] = []
    boxes = result.boxes
    if boxes is None or len(boxes) == 0:
        return detections

    names = result.names or {}
    polygons = result.masks.xy if result.masks is not None else [None] * len(boxes)

    for i in range(len(boxes)):
        class_id = int(boxes.cls[i].item())
        x1, y1, x2, y2 = [float(v) for v in boxes.xyxy[i].tolist()]
        x1, x2 = x1 + dx, x2 + dx
        y1, y2 = y1 + dy, y2 + dy
        if width is not None:
            x1 = min(max(x1, 0.0), width)
            x2 = min(max(x2, 0.0), width)
        if height is not None:
            y1 = min(max(y1, 0.0), height)
            y2 = min(max(y2, 0.0), height)
        polygon = polygons[i] if i < len(polygons) else None
        shifted = None
        if polygon is not None:
            shifted = np.asarray(polygon, dtype=np.float32)
            shifted[:, 0] += dx
            shifted[:, 1] += dy
            if width is not None:
                shifted[:, 0] = np.clip(shifted[:, 0], 0, width)
            if height is not None:
                shifted[:, 1] = np.clip(shifted[:, 1], 0, height)
        detections.append(
            Detection(
                class_name=str(names.get(class_id, class_id)),
                class_id=class_id,
                confidence=round(float(boxes.conf[i].item()), 4),
                bbox_xyxy=[round(x1, 2), round(y1, 2), round(x2, 2), round(y2, 2)],
                mask_polygon=_simplify_polygon(shifted) if shifted is not None else [],
            )
        )
    return detections


def tile_windows(width: int, height: int, tile_size: int, overlap: float) -> list[tuple[int, int, int, int]]:
    tile_w = min(tile_size, width)
    tile_h = min(tile_size, height)
    stride_x = max(int(tile_w * (1.0 - overlap)), 1)
    stride_y = max(int(tile_h * (1.0 - overlap)), 1)
    xs = list(range(0, max(width - tile_w, 0) + 1, stride_x))
    ys = list(range(0, max(height - tile_h, 0) + 1, stride_y))
    if not xs or xs[-1] + tile_w < width:
        xs.append(max(width - tile_w, 0))
    if not ys or ys[-1] + tile_h < height:
        ys.append(max(height - tile_h, 0))
    return [(x, y, tile_w, tile_h) for y in ys for x in xs]


def _iou(a: list[float], b: list[float]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    denom = area_a + area_b - inter
    return inter / denom if denom else 0.0


def nms_detections(detections: list[Detection], iou_thres: float = DEFAULT_IOU) -> list[Detection]:
    kept: list[Detection] = []
    by_class: dict[int, list[Detection]] = {}
    for det in detections:
        by_class.setdefault(det.class_id, []).append(det)
    for group in by_class.values():
        group.sort(key=lambda d: d.confidence, reverse=True)
        selected: list[Detection] = []
        for det in group:
            if all(_iou(det.bbox_xyxy, other.bbox_xyxy) < iou_thres for other in selected):
                selected.append(det)
        kept.extend(selected)
    kept.sort(key=lambda d: d.confidence, reverse=True)
    return kept


def _detection_color(class_id: int) -> tuple[int, int, int]:
    return (
        int(37 + (class_id * 83) % 200),
        int(80 + (class_id * 47) % 160),
        int(200 - (class_id * 31) % 140),
    )


def _detection_polygon(det: Detection) -> list[list[float]]:
    if len(det.mask_polygon) >= 3:
        return det.mask_polygon
    x1, y1, x2, y2 = det.bbox_xyxy
    return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]


def _polygon_label_point(polygon: list[list[float]]) -> tuple[int, int]:
    pts = np.asarray(polygon, dtype=np.float32)
    x = int(pts[:, 0].mean())
    y = int(max(pts[:, 1].min() - 6, 16))
    return x, y


def _polygon_centroid(polygon: list[list[float]]) -> tuple[int, int]:
    pts = np.asarray(polygon, dtype=np.float32)
    return int(pts[:, 0].mean()), int(pts[:, 1].mean())


def _polygon_extent(polygon: list[list[float]]) -> float:
    pts = np.asarray(polygon, dtype=np.float32)
    return float(max(pts[:, 0].max() - pts[:, 0].min(), pts[:, 1].max() - pts[:, 1].min()))


def _polygon_area(polygon: list[list[float]]) -> float:
    pts = np.asarray(polygon, dtype=np.float32)
    x = pts[:, 0]
    y = pts[:, 1]
    return float(0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def crop_around_detection(
    image_rgb: np.ndarray,
    det: Detection,
    pad: int = 80,
) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    height, width = image_rgb.shape[:2]
    x1, y1, x2, y2 = [int(v) for v in det.bbox_xyxy]
    cx0 = max(0, x1 - pad)
    cy0 = max(0, y1 - pad)
    cx1 = min(width, x2 + pad)
    cy1 = min(height, y2 + pad)
    return image_rgb[cy0:cy1, cx0:cx1].copy(), (cx0, cy0, cx1, cy1)


def shift_detection(det: Detection, dx: float, dy: float) -> Detection:
    return Detection(
        class_name=det.class_name,
        class_id=det.class_id,
        confidence=det.confidence,
        bbox_xyxy=[
            det.bbox_xyxy[0] - dx,
            det.bbox_xyxy[1] - dy,
            det.bbox_xyxy[2] - dx,
            det.bbox_xyxy[3] - dy,
        ],
        mask_polygon=[[x - dx, y - dy] for x, y in det.mask_polygon],
    )


def draw_overlay(
    image_rgb: np.ndarray,
    detections: list[Detection],
    *,
    mask_alpha: float = 0.28,
    line_thickness: int = 2,
    font_scale: float = 0.5,
    show_center_markers: bool = False,
    marker_min_area_ratio: float = 0.00005,
) -> np.ndarray:
    import cv2

    overlay = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGR).copy()
    tint = overlay.copy()
    image_area = float(image_rgb.shape[0] * image_rgb.shape[1])
    for det in detections:
        color = _detection_color(det.class_id)
        polygon = _detection_polygon(det)
        pts = np.array(polygon, dtype=np.int32).reshape((-1, 1, 2))
        cv2.fillPoly(tint, [pts], color)
        cv2.polylines(overlay, [pts], True, color, line_thickness, cv2.LINE_AA)
        label_x, label_y = _polygon_label_point(polygon)
        label = f"{det.class_name} {det.confidence:.2f}"
        cv2.putText(
            overlay,
            label,
            (label_x, label_y),
            cv2.FONT_HERSHEY_SIMPLEX,
            font_scale,
            color,
            max(1, line_thickness - 1),
            cv2.LINE_AA,
        )
        if show_center_markers:
            poly_area = _polygon_area(polygon)
            if poly_area / image_area < marker_min_area_ratio:
                cx, cy = _polygon_centroid(polygon)
                radius = max(12, int(_polygon_extent(polygon) * 0.75))
                cv2.circle(overlay, (cx, cy), radius, color, max(2, line_thickness), cv2.LINE_AA)
    return cv2.addWeighted(tint, mask_alpha, overlay, 1.0 - mask_alpha, 0)


def draw_detection_detail(
    image_rgb: np.ndarray,
    det: Detection,
    *,
    pad: int = 80,
    mask_alpha: float = 0.45,
    line_thickness: int = 4,
) -> np.ndarray:
    crop, (cx0, cy0, _, _) = crop_around_detection(image_rgb, det, pad=pad)
    local = shift_detection(det, cx0, cy0)
    return draw_overlay(
        crop,
        [local],
        mask_alpha=mask_alpha,
        line_thickness=line_thickness,
        font_scale=0.7,
    )


def infer_page(
    model,
    page: dict,
    imgsz: int = DEFAULT_IMGSZ,
    conf: float = DEFAULT_CONF,
    tile_size: int | None = DEFAULT_TILE_SIZE,
    overlap: float = DEFAULT_TILE_OVERLAP,
    iou: float = DEFAULT_IOU,
) -> PageInference:
    image = page["image_rgb"]
    height, width = image.shape[:2]
    use_tiles = tile_size is not None and tile_size > 0

    if use_tiles:
        windows = tile_windows(width, height, tile_size, overlap)
        detections: list[Detection] = []
        for x, y, tw, th in windows:
            tile = np.ascontiguousarray(image[y : y + th, x : x + tw])
            result = model.predict(tile, imgsz=imgsz, conf=conf, verbose=False)[0]
            detections.extend(serialize_detections(result, dx=x, dy=y, width=width, height=height))
        detections = nms_detections(detections, iou_thres=iou)
        overlay = draw_overlay(image, detections, show_center_markers=True)
    else:
        result = model.predict(image, imgsz=imgsz, conf=conf, verbose=False)[0]
        detections = serialize_detections(result, width=width, height=height)
        overlay = draw_overlay(image, detections, show_center_markers=True)

    return PageInference(
        source=page["source"],
        page_index=page["page_index"],
        stem=page["stem"],
        width=page["width"],
        height=page["height"],
        image_rgb=image,
        overlay_bgr=overlay,
        detections=detections,
    )


def run_inference(
    pages: list[dict],
    model=None,
    weights: str = DEFAULT_MODEL,
    imgsz: int = DEFAULT_IMGSZ,
    conf: float = DEFAULT_CONF,
    tile_size: int | None = DEFAULT_TILE_SIZE,
    overlap: float = DEFAULT_TILE_OVERLAP,
    iou: float = DEFAULT_IOU,
) -> list[PageInference]:
    if model is None:
        model = load_model(weights)
    results = []
    for page in pages:
        if tile_size:
            n_tiles = len(tile_windows(page["width"], page["height"], tile_size, overlap))
            print(f"{page['stem']}: {n_tiles} tiles ({page['width']}x{page['height']})")
        results.append(
            infer_page(
                model,
                page,
                imgsz=imgsz,
                conf=conf,
                tile_size=tile_size,
                overlap=overlap,
                iou=iou,
            )
        )
    return results


def save_results(inferences: list[PageInference], output_dir: Path) -> Path:
    import cv2

    out = Path(output_dir).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)

    payload = []
    for item in inferences:
        raw_path = out / f"{item.stem}.png"
        overlay_path = out / f"{item.stem}_overlay.png"
        cv2.imwrite(str(raw_path), cv2.cvtColor(item.image_rgb, cv2.COLOR_RGB2BGR))
        cv2.imwrite(str(overlay_path), item.overlay_bgr)
        payload.append(
            {
                "source": item.source,
                "page_index": item.page_index,
                "stem": item.stem,
                "width": item.width,
                "height": item.height,
                "image": raw_path.name,
                "overlay": overlay_path.name,
                "detections": [asdict(det) for det in item.detections],
            }
        )

    json_path = out / "detections.json"
    json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return json_path


def run(
    input_path: Path,
    output_dir: Path | None = None,
    weights: str = DEFAULT_MODEL,
    imgsz: int = DEFAULT_IMGSZ,
    conf: float = DEFAULT_CONF,
    dpi: int = DEFAULT_DPI,
    tile_size: int | None = DEFAULT_TILE_SIZE,
    overlap: float = DEFAULT_TILE_OVERLAP,
    iou: float = DEFAULT_IOU,
) -> list[PageInference]:
    pages = collect_pages(input_path, dpi=dpi)
    inferences = run_inference(
        pages,
        weights=weights,
        imgsz=imgsz,
        conf=conf,
        tile_size=tile_size,
        overlap=overlap,
        iou=iou,
    )
    if output_dir is not None:
        save_results(inferences, output_dir)
    return inferences


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run pretrained YOLO11-seg on blueprint PDFs or images, with optional tiling."
    )
    parser.add_argument(
        "--input",
        type=Path,
        default=INPUT_DIR,
        help="PDF/image file or folder (default: pipeline/input)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=OUTPUT_DIR,
        help="Directory for overlays and detections.json (default: pipeline/output)",
    )
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Ultralytics weights path or name")
    parser.add_argument("--imgsz", type=int, default=DEFAULT_IMGSZ)
    parser.add_argument("--conf", type=float, default=DEFAULT_CONF)
    parser.add_argument("--dpi", type=int, default=DEFAULT_DPI)
    parser.add_argument("--tile-size", type=int, default=DEFAULT_TILE_SIZE, help="0 disables tiling")
    parser.add_argument("--overlap", type=float, default=DEFAULT_TILE_OVERLAP)
    parser.add_argument("--iou", type=float, default=DEFAULT_IOU)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    inferences = run(
        input_path=args.input,
        output_dir=args.output,
        weights=args.model,
        imgsz=args.imgsz,
        conf=args.conf,
        dpi=args.dpi,
        tile_size=args.tile_size or None,
        overlap=args.overlap,
        iou=args.iou,
    )
    total = sum(len(item.detections) for item in inferences)
    print(f"Processed {len(inferences)} page(s), {total} detection(s).")
    print(f"Wrote overlays and detections.json to {Path(args.output).resolve()}")


if __name__ == "__main__":
    main()
