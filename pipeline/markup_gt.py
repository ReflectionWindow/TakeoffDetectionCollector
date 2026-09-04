"""Convert labeled PDF area markups to GT JSON and run YOLOE visual prompts."""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

import cv2
import numpy as np
import pymupdf

from infer import (
    DEFAULT_CONF,
    DEFAULT_DPI,
    DEFAULT_IMGSZ,
    DEFAULT_YOLOE,
    INPUT_DIR,
    OUTPUT_DIR,
    WEIGHTS_DIR,
    Detection,
    bind_visual_prompts,
    collect_pages,
    draw_overlay,
    load_yoloe,
    run_inference,
    save_results,
)

CLASS_COLORS = {
    "CW": [0.2, 0.4, 1.0],
    "SF": [1.0, 0.6, 0.0],
}
CLASS_NAMES = list(CLASS_COLORS)


def _polygon_area(points: list[list[float]]) -> float:
    xy = np.asarray(points, dtype=np.float64)
    return abs(float(np.dot(xy[:, 0], np.roll(xy[:, 1], 1)) - np.dot(xy[:, 1], np.roll(xy[:, 0], 1)))) / 2


def _round_points(points: list[list[float]]) -> list[list[float]]:
    return [[round(float(x), 2), round(float(y), 2)] for x, y in points]


def extract_markup_gt(markup_pdf: Path, image_pdf: Path, dpi: int = DEFAULT_DPI) -> tuple[dict, list[dict]]:
    """Extract CW/SF polygon annotations and map PDF points to raster pixels."""
    rendered_pages = collect_pages(image_pdf, dpi=dpi)
    document = pymupdf.open(markup_pdf)
    if len(document) != len(rendered_pages):
        raise ValueError(f"Markup has {len(document)} pages but source has {len(rendered_pages)}")

    class_to_id = {name: index for index, name in enumerate(CLASS_NAMES)}
    pages_json = []
    candidates = []
    try:
        for page_index, (pdf_page, raster_page) in enumerate(zip(document, rendered_pages)):
            scale_x = raster_page["width"] / pdf_page.rect.width
            scale_y = raster_page["height"] / pdf_page.rect.height
            annotations = []
            polygon_index = 0
            for annotation in pdf_page.annots() or []:
                if annotation.type[1] != "Polygon" or not annotation.vertices:
                    continue
                content = (annotation.info.get("content") or "").strip()
                class_name = content.splitlines()[0].strip()
                if class_name not in class_to_id:
                    continue

                pdf_polygon = [[float(x), float(y)] for x, y in annotation.vertices]
                pixel_polygon = [[x * scale_x, y * scale_y] for x, y in pdf_polygon]
                pixel_array = np.asarray(pixel_polygon)
                x1, y1 = pixel_array.min(axis=0)
                x2, y2 = pixel_array.max(axis=0)
                annotation_id = f"p{page_index + 1:03d}_{class_name.lower()}_{polygon_index:03d}"
                polygon_index += 1
                item = {
                    "id": annotation_id,
                    "class_id": class_to_id[class_name],
                    "class_name": class_name,
                    "bbox_xyxy": [round(float(v), 2) for v in (x1, y1, x2, y2)],
                    "polygon": _round_points(pixel_polygon),
                    "pdf_bbox_xyxy": [
                        round(float(v), 2)
                        for v in (
                            min(point[0] for point in pdf_polygon),
                            min(point[1] for point in pdf_polygon),
                            max(point[0] for point in pdf_polygon),
                            max(point[1] for point in pdf_polygon),
                        )
                    ],
                    "pdf_polygon": _round_points(pdf_polygon),
                    "markup_content": content,
                    "markup_color_rgb": CLASS_COLORS[class_name],
                }
                annotations.append(item)
                candidates.append(
                    {
                        **item,
                        "page_index": page_index,
                        "pixel_area": _polygon_area(pixel_polygon),
                    }
                )

            pages_json.append(
                {
                    "page_index": page_index,
                    "stem": raster_page["stem"],
                    "width": raster_page["width"],
                    "height": raster_page["height"],
                    "annotations": annotations,
                }
            )
    finally:
        document.close()

    gt = {
        "schema_version": "1.0",
        "task": "instance_segmentation",
        "coordinate_space": "raster_pixels_xy",
        "render_dpi": dpi,
        "markup_source": markup_pdf.name,
        "image_source": image_pdf.name,
        "classes": [
            {"id": index, "name": name, "markup_color_rgb": CLASS_COLORS[name]}
            for index, name in enumerate(CLASS_NAMES)
        ],
        "pages": pages_json,
        "visual_prompt_examples": [],
    }
    return gt, candidates


def choose_prompt_examples(candidates: list[dict], per_class: int = 5, per_page: int = 2) -> list[dict]:
    """Choose large, clean examples while distributing them across pages."""
    chosen = []
    for class_name in CLASS_NAMES:
        class_candidates = []
        for candidate in candidates:
            if candidate["class_name"] != class_name:
                continue
            x1, y1, x2, y2 = candidate["bbox_xyxy"]
            bbox_area = max((x2 - x1) * (y2 - y1), 1.0)
            rectangularity = candidate["pixel_area"] / bbox_area
            candidate = dict(candidate)
            candidate["quality_score"] = candidate["pixel_area"] * rectangularity
            class_candidates.append(candidate)

        counts: Counter[int] = Counter()
        for candidate in sorted(class_candidates, key=lambda item: item["quality_score"], reverse=True):
            page_index = candidate["page_index"]
            if counts[page_index] >= per_page:
                continue
            chosen.append(candidate)
            counts[page_index] += 1
            if sum(1 for item in chosen if item["class_name"] == class_name) == min(
                per_class, len(class_candidates)
            ):
                break
    return chosen


def make_prompt_board(
    pages: list[dict],
    examples: list[dict],
    cell_size: int = 640,
    columns: int = 3,
    padding: int = 24,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Letterbox cross-page example crops into a compact visual-prompt board."""
    rows = math.ceil(len(examples) / columns)
    width = columns * cell_size + (columns + 1) * padding
    height = rows * cell_size + (rows + 1) * padding
    board = np.full((height, width, 3), 255, dtype=np.uint8)
    prompt_boxes = []
    class_ids = []

    for index, example in enumerate(examples):
        page = pages[example["page_index"]]["image_rgb"]
        x1, y1, x2, y2 = [int(round(value)) for value in example["bbox_xyxy"]]
        crop = np.ascontiguousarray(page[y1:y2, x1:x2])
        if crop.size == 0:
            raise ValueError(f"Empty prompt crop for {example['id']}")
        crop_height, crop_width = crop.shape[:2]
        gain = min(cell_size / crop_width, cell_size / crop_height)
        resized_width = max(1, round(crop_width * gain))
        resized_height = max(1, round(crop_height * gain))
        resized = cv2.resize(crop, (resized_width, resized_height), interpolation=cv2.INTER_AREA)

        row, column = divmod(index, columns)
        cell_x = padding + column * cell_size
        cell_y = padding + row * cell_size
        paste_x = cell_x + (cell_size - resized_width) // 2
        paste_y = cell_y + (cell_size - resized_height) // 2
        board[paste_y : paste_y + resized_height, paste_x : paste_x + resized_width] = resized
        prompt_boxes.append([paste_x, paste_y, paste_x + resized_width, paste_y + resized_height])
        class_ids.append(example["class_id"])

    return (
        board,
        np.asarray(prompt_boxes, dtype=np.float32),
        np.asarray(class_ids, dtype=np.int32),
    )


def save_gt_artifacts(gt: dict, pages: list[dict], output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "UIH_ELEVATION_GT.json"
    json_path.write_text(json.dumps(gt, indent=2))
    for page_data, page in zip(gt["pages"], pages):
        detections = [
            Detection(
                class_name=item["class_name"],
                class_id=item["class_id"],
                confidence=1.0,
                bbox_xyxy=item["bbox_xyxy"],
                mask_polygon=item["polygon"],
            )
            for item in page_data["annotations"]
        ]
        overlay = draw_overlay(page["image_rgb"], detections, show_center_markers=False)
        cv2.imwrite(str(output_dir / f"{page_data['stem']}_gt_overlay.png"), overlay)
    return json_path


def _bbox_iou(a: list[float], b: list[float]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    intersection = max(0.0, min(ax2, bx2) - max(ax1, bx1)) * max(0.0, min(ay2, by2) - max(ay1, by1))
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - intersection
    return intersection / union if union else 0.0


def evaluate_inferences(gt: dict, inferences: list, iou_threshold: float = 0.3) -> dict:
    """Greedily match same-class prediction and GT boxes and report metrics."""
    totals = defaultdict(lambda: {"true_positive": 0, "false_positive": 0, "false_negative": 0})
    page_metrics = []
    for gt_page, inference in zip(gt["pages"], inferences):
        page_classes = {}
        for class_name in CLASS_NAMES:
            ground_truth = [item for item in gt_page["annotations"] if item["class_name"] == class_name]
            predictions = [item for item in inference.detections if item.class_name == class_name]
            pairs = sorted(
                (
                    (_bbox_iou(prediction.bbox_xyxy, truth["bbox_xyxy"]), prediction_index, truth_index)
                    for prediction_index, prediction in enumerate(predictions)
                    for truth_index, truth in enumerate(ground_truth)
                ),
                reverse=True,
            )
            matched_predictions = set()
            matched_truth = set()
            for iou, prediction_index, truth_index in pairs:
                if iou < iou_threshold:
                    break
                if prediction_index not in matched_predictions and truth_index not in matched_truth:
                    matched_predictions.add(prediction_index)
                    matched_truth.add(truth_index)
            values = {
                "true_positive": len(matched_predictions),
                "false_positive": len(predictions) - len(matched_predictions),
                "false_negative": len(ground_truth) - len(matched_truth),
            }
            page_classes[class_name] = values
            for key, value in values.items():
                totals[class_name][key] += value
        page_metrics.append({"page_index": gt_page["page_index"], "classes": page_classes})

    class_metrics = {}
    for class_name, values in totals.items():
        tp = values["true_positive"]
        fp = values["false_positive"]
        fn = values["false_negative"]
        class_metrics[class_name] = {
            **values,
            "precision": round(tp / (tp + fp), 4) if tp + fp else 0.0,
            "recall": round(tp / (tp + fn), 4) if tp + fn else 0.0,
        }
    return {"bbox_iou_threshold": iou_threshold, "classes": class_metrics, "pages": page_metrics}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--markup", type=Path, required=True)
    parser.add_argument("--source", type=Path, default=INPUT_DIR / "UIH_ELEVATION.pdf")
    parser.add_argument("--gt-dir", type=Path, default=Path(__file__).parent / "ground_truth")
    parser.add_argument("--output", type=Path, default=OUTPUT_DIR / "yoloe_markup")
    parser.add_argument("--weights", default=str(WEIGHTS_DIR / Path(DEFAULT_YOLOE).name))
    parser.add_argument("--dpi", type=int, default=DEFAULT_DPI)
    parser.add_argument("--imgsz", type=int, default=DEFAULT_IMGSZ)
    parser.add_argument("--conf", type=float, default=DEFAULT_CONF)
    parser.add_argument("--tile-size", type=int, default=2560)
    parser.add_argument("--overlap", type=float, default=0.25)
    parser.add_argument("--skip-inference", action="store_true")
    args = parser.parse_args()

    pages = collect_pages(args.source, dpi=args.dpi)
    gt, candidates = extract_markup_gt(args.markup, args.source, dpi=args.dpi)
    examples = choose_prompt_examples(candidates)
    gt["visual_prompt_examples"] = [
        {
            "annotation_id": example["id"],
            "page_index": example["page_index"],
            "class_id": example["class_id"],
            "class_name": example["class_name"],
            "bbox_xyxy": example["bbox_xyxy"],
            "quality_score": round(example["quality_score"], 2),
        }
        for example in examples
    ]
    json_path = save_gt_artifacts(gt, pages, args.gt_dir)
    print(f"GT: {json_path}")
    print("counts:", dict(Counter(item["class_name"] for item in candidates)))
    print("examples:", [(item["id"], item["class_name"]) for item in examples])

    board, prompt_boxes, class_ids = make_prompt_board(pages, examples)
    board_bgr = cv2.cvtColor(board, cv2.COLOR_RGB2BGR)
    cv2.imwrite(str(args.gt_dir / "UIH_ELEVATION_prompt_board.png"), board_bgr)

    if args.skip_inference:
        return
    model = load_yoloe(args.weights, classes=None)
    bind_visual_prompts(model, board, prompt_boxes, class_ids, CLASS_NAMES, imgsz=args.imgsz)
    inferences = run_inference(
        pages,
        model=model,
        imgsz=args.imgsz,
        conf=args.conf,
        tile_size=args.tile_size,
        overlap=args.overlap,
        iou=0.5,
    )
    inference_path = save_results(inferences, args.output)
    evaluation = evaluate_inferences(gt, inferences)
    evaluation["inference_config"] = {
        "confidence": args.conf,
        "image_size": args.imgsz,
        "tile_size": args.tile_size,
        "tile_overlap": args.overlap,
    }
    evaluation_path = args.output / "evaluation.json"
    evaluation_path.write_text(json.dumps(evaluation, indent=2))
    for result in inferences:
        print(result.stem, dict(Counter(item.class_name for item in result.detections)))
    print(f"Inference: {inference_path}")
    print(f"Evaluation: {evaluation_path}")
    print("metrics:", evaluation["classes"])


if __name__ == "__main__":
    main()
