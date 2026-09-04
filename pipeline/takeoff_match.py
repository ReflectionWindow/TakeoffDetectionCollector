"""CAD-aware takeoff: match markup examples instead of prompting YOLOE.

CW bays repeat on a vertical grid. SF is a handful of wide base bands.
Leave-one-page-out uses examples from the other elevations only.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np

from infer import (
    DEFAULT_DPI,
    INPUT_DIR,
    OUTPUT_DIR,
    Detection,
    PageInference,
    collect_pages,
    draw_overlay,
    nms_detections,
    save_results,
)
from markup_gt import CLASS_NAMES, evaluate_inferences, extract_markup_gt

SCALE = 4
CW_SEED = 0.42
CW_EXPAND = 0.32
CW_SCALES = (0.85, 1.0, 1.18)
SF_SEED = 0.60
MAX_TEMPLATES = {"CW": 8, "SF": 4}


def _gray(image: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    return cv2.GaussianBlur(gray, (3, 3), 0)


def _box_wh(bbox: list[float]) -> tuple[float, float]:
    x1, y1, x2, y2 = bbox
    return x2 - x1, y2 - y1


def _crop(image: np.ndarray, bbox: list[float], pad: int = 0) -> np.ndarray | None:
    height, width = image.shape[:2]
    x1, y1, x2, y2 = [int(round(value)) for value in bbox]
    x1, y1 = max(0, x1 - pad), max(0, y1 - pad)
    x2, y2 = min(width, x2 + pad), min(height, y2 + pad)
    if x2 - x1 < 8 or y2 - y1 < 8:
        return None
    return np.ascontiguousarray(image[y1:y2, x1:x2])


def _template_score(item: dict) -> float:
    width, height = _box_wh(item["bbox_xyxy"])
    area = max(width * height, 1.0)
    rectangularity = item.get("pixel_area", area) / area
    if item["class_name"] == "CW":
        aspect = width / max(height, 1.0)
        return rectangularity * min(height, 1400) * (1.0 if 0.04 <= aspect <= 0.22 else 0.2)
    return rectangularity / (1.0 + abs(np.log(area / 200_000.0)))


def choose_templates(candidates: list[dict], holdout: int) -> list[dict]:
    chosen: list[dict] = []
    for class_name in CLASS_NAMES:
        pool = [
            item
            for item in candidates
            if item["class_name"] == class_name and item["page_index"] != holdout
        ]
        pool.sort(key=_template_score, reverse=True)
        picked = []
        used_pages: dict[int, int] = defaultdict(int)
        for item in pool:
            if used_pages[item["page_index"]] >= 3:
                continue
            if any(
                abs(item["bbox_xyxy"][0] - other["bbox_xyxy"][0]) < 40
                and abs(item["bbox_xyxy"][1] - other["bbox_xyxy"][1]) < 40
                and item["page_index"] == other["page_index"]
                for other in picked
            ):
                continue
            picked.append(item)
            used_pages[item["page_index"]] += 1
            if len(picked) >= MAX_TEMPLATES[class_name]:
                break
        chosen.extend(picked)
    return chosen


def _geometry_ok(class_name: str, bbox: list[float], image_shape: tuple[int, int]) -> bool:
    width, height = _box_wh(bbox)
    if width < 8 or height < 8:
        return False
    aspect = width / height
    y1, y2 = bbox[1], bbox[3]
    if class_name == "CW":
        return 50 <= width <= 220 and height >= 400 and 0.03 <= aspect <= 0.28
    return (
        0.35 <= aspect <= 12.0
        and 160 <= height <= 900
        and 3800 <= (y1 + y2) / 2 <= 5300
        and y2 < image_shape[0] * 0.78
    )


def _search_band(templates: list[dict], image_shape: tuple[int, int], pad: float = 0.22) -> tuple[int, int, int, int]:
    height, width = image_shape[:2]
    boxes = np.asarray([item["bbox_xyxy"] for item in templates], dtype=np.float32)
    y1 = max(0, int(boxes[:, 1].min() * (1.0 - pad)))
    y2 = min(height, int(boxes[:, 3].max() * (1.0 + pad)))
    return 0, y1, width, y2


def _match_template(image: np.ndarray, template: np.ndarray, threshold: float) -> list[tuple[float, int, int]]:
    if template.shape[0] >= image.shape[0] or template.shape[1] >= image.shape[1]:
        return []
    result = cv2.matchTemplate(image, template, cv2.TM_CCOEFF_NORMED)
    ys, xs = np.where(result >= threshold)
    hits = [(float(result[y, x]), int(x), int(y)) for y, x in zip(ys, xs)]
    hits.sort(reverse=True)
    kept: list[tuple[float, int, int]] = []
    min_dist = max(8, min(template.shape[:2]) // 6)
    for score, x, y in hits:
        if all(abs(x - kx) + abs(y - ky) >= min_dist for _, kx, ky in kept):
            kept.append((score, x, y))
        if len(kept) >= 80:
            break
    return kept


def _period(xs: list[float], typical_width: float) -> float | None:
    values = np.array(sorted(xs), dtype=np.float32)
    if len(values) < 3:
        return None
    deltas = []
    for i, left in enumerate(values):
        for right in values[i + 1 :]:
            gap = float(right - left)
            if 0.7 * typical_width <= gap <= 2.4 * typical_width:
                deltas.append(gap)
    if len(deltas) < 2:
        return None
    return float(np.median(deltas))


def _ncc_at(image: np.ndarray, template: np.ndarray, x: int, y: int) -> float:
    th, tw = template.shape[:2]
    if x < 0 or y < 0 or x + tw > image.shape[1] or y + th > image.shape[0]:
        return 0.0
    patch = image[y : y + th, x : x + tw]
    result = cv2.matchTemplate(patch, template, cv2.TM_CCOEFF_NORMED)
    return float(result[0, 0]) if result.size else 0.0


def match_class(
    page_image: np.ndarray,
    pages: list[dict],
    templates: list[dict],
    class_name: str,
    class_id: int,
) -> list[Detection]:
    if not templates:
        return []

    gray = _gray(page_image)
    small = cv2.resize(gray, (gray.shape[1] // SCALE, gray.shape[0] // SCALE), interpolation=cv2.INTER_AREA)
    x1, y1, x2, y2 = _search_band(templates, page_image.shape)
    region = small[y1 // SCALE : y2 // SCALE, x1 // SCALE : x2 // SCALE]
    detections: list[Detection] = []
    seeds: list[tuple[float, float, float, float, float, np.ndarray]] = []

    scales = CW_SCALES if class_name == "CW" else (1.0,)
    threshold = CW_SEED if class_name == "CW" else SF_SEED
    for item in templates:
        crop = _crop(pages[item["page_index"]]["image_rgb"], item["bbox_xyxy"])
        if crop is None:
            continue
        gray_crop = _gray(crop)
        for scale in scales:
            pw = max(12, int(round(crop.shape[1] * scale)))
            ph = max(12, int(round(crop.shape[0] * scale)))
            scaled = cv2.resize(gray_crop, (pw, ph), interpolation=cv2.INTER_AREA)
            template = cv2.resize(
                scaled,
                (max(8, pw // SCALE), max(8, ph // SCALE)),
                interpolation=cv2.INTER_AREA,
            )
            for score, rx, ry in _match_template(region, template, threshold):
                px = x1 + rx * SCALE
                py = y1 + ry * SCALE
                if not _geometry_ok(class_name, [px, py, px + pw, py + ph], page_image.shape):
                    continue
                bbox = [px, py, px + pw, py + ph]
                detections.append(
                    Detection(
                        class_name=class_name,
                        class_id=class_id,
                        confidence=round(score, 4),
                        bbox_xyxy=[round(float(v), 2) for v in bbox],
                        mask_polygon=[
                            [bbox[0], bbox[1]],
                            [bbox[2], bbox[1]],
                            [bbox[2], bbox[3]],
                            [bbox[0], bbox[3]],
                        ],
                    )
                )
                seeds.append((score, px, py, pw, ph, template))

    detections = nms_detections(detections, iou_thres=0.35)
    if class_name == "SF":
        detections.sort(key=lambda item: item.confidence, reverse=True)
        return detections[:6]
    if class_name != "CW" or len(seeds) < 2:
        return detections

    widths = [item[3] for item in seeds]
    typical_width = float(np.median(widths))
    by_row: dict[int, list[tuple[float, float, float, float, np.ndarray]]] = defaultdict(list)
    for score, px, py, pw, ph, template in seeds:
        by_row[int(round(py / 80.0))].append((score, px, py, pw, ph, template))

    extras: list[Detection] = []
    for row in by_row.values():
        period = _period([item[1] for item in row], typical_width)
        if period is None:
            continue
        template = max(row, key=lambda item: item[0])[-1]
        _, _, py, pw, ph, _ = max(row, key=lambda item: item[0])
        xs = [item[1] for item in row]
        start, stop = min(xs) - 8 * period, max(xs) + 8 * period
        x = start
        while x <= stop:
            full_x = int(round(x))
            full_y = int(round(py))
            score = _ncc_at(
                small,
                template,
                (full_x - x1) // SCALE,
                (full_y - y1) // SCALE,
            )
            if score >= CW_EXPAND and _geometry_ok(class_name, [full_x, full_y, full_x + pw, full_y + ph], page_image.shape):
                bbox = [full_x, full_y, full_x + pw, full_y + ph]
                extras.append(
                    Detection(
                        class_name=class_name,
                        class_id=class_id,
                        confidence=round(score, 4),
                        bbox_xyxy=[round(float(v), 2) for v in bbox],
                        mask_polygon=[
                            [bbox[0], bbox[1]],
                            [bbox[2], bbox[1]],
                            [bbox[2], bbox[3]],
                            [bbox[0], bbox[3]],
                        ],
                    )
                )
            x += period
    return nms_detections(detections + extras, iou_thres=0.35)


def export_yolo_seg(gt: dict, pages: list[dict], output_dir: Path, tile: int = 1280, overlap: float = 0.25) -> Path:
    """Write a YOLO-seg tile dataset with the last page held out as val."""
    from infer import tile_windows

    output_dir = Path(output_dir)
    for split in ("train", "val"):
        (output_dir / "images" / split).mkdir(parents=True, exist_ok=True)
        (output_dir / "labels" / split).mkdir(parents=True, exist_ok=True)

    names = {item["id"]: item["name"] for item in gt["classes"]}
    for page_data, page in zip(gt["pages"], pages):
        split = "val" if page_data["page_index"] == max(item["page_index"] for item in gt["pages"]) else "train"
        windows = tile_windows(page["width"], page["height"], tile, overlap)
        for index, (x, y, tw, th) in enumerate(windows):
            labels = []
            for item in page_data["annotations"]:
                polygon = np.asarray(item["polygon"], dtype=np.float32)
                local = polygon.copy()
                local[:, 0] -= x
                local[:, 1] -= y
                if (
                    local[:, 0].max() <= 0
                    or local[:, 1].max() <= 0
                    or local[:, 0].min() >= tw
                    or local[:, 1].min() >= th
                ):
                    continue
                local[:, 0] = np.clip(local[:, 0], 0, tw)
                local[:, 1] = np.clip(local[:, 1], 0, th)
                if cv2.contourArea(local.reshape(-1, 1, 2)) < 80:
                    continue
                coords = []
                for px, py in local:
                    coords.extend((f"{px / tw:.6f}", f"{py / th:.6f}"))
                labels.append(f"{item['class_id']} " + " ".join(coords))
            if not labels:
                continue
            stem = f"{page_data['stem']}_t{index:03d}"
            crop = page["image_rgb"][y : y + th, x : x + tw]
            cv2.imwrite(str(output_dir / "images" / split / f"{stem}.png"), cv2.cvtColor(crop, cv2.COLOR_RGB2BGR))
            (output_dir / "labels" / split / f"{stem}.txt").write_text("\n".join(labels) + "\n")

    yaml = output_dir / "data.yaml"
    yaml.write_text(
        "\n".join(
            [
                f"path: {output_dir.resolve()}",
                "train: images/train",
                "val: images/val",
                "names:",
                *[f"  {index}: {name}" for index, name in names.items()],
                "",
            ]
        )
    )
    return yaml


def run_leave_one_out(pages: list[dict], gt: dict, candidates: list[dict]) -> tuple[list[PageInference], dict]:
    inferences = []
    used_templates = []
    for page in pages:
        templates = choose_templates(candidates, holdout=page["page_index"])
        detections = []
        for class_id, class_name in enumerate(CLASS_NAMES):
            class_templates = [item for item in templates if item["class_name"] == class_name]
            detections.extend(match_class(page["image_rgb"], pages, class_templates, class_name, class_id))
            used_templates.extend(
                {
                    "holdout_page": page["page_index"],
                    "annotation_id": item["id"],
                    "class_name": item["class_name"],
                    "source_page": item["page_index"],
                }
                for item in class_templates
            )
        overlay = draw_overlay(page["image_rgb"], detections, show_center_markers=False)
        inferences.append(
            PageInference(
                source=page["source"],
                page_index=page["page_index"],
                stem=page["stem"],
                width=page["width"],
                height=page["height"],
                image_rgb=page["image_rgb"],
                overlay_bgr=overlay,
                detections=detections,
            )
        )
    evaluation = evaluate_inferences(gt, inferences)
    evaluation["method"] = "leave_one_page_out_template_grid"
    evaluation["templates"] = used_templates
    return inferences, evaluation


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--markup", type=Path, required=True)
    parser.add_argument("--source", type=Path, default=INPUT_DIR / "UIH_ELEVATION.pdf")
    parser.add_argument("--output", type=Path, default=OUTPUT_DIR / "cad_match")
    parser.add_argument("--dataset", type=Path, default=Path(__file__).parent / "datasets" / "uih_cw_sf")
    parser.add_argument("--dpi", type=int, default=DEFAULT_DPI)
    args = parser.parse_args()

    pages = collect_pages(args.source, dpi=args.dpi)
    gt, candidates = extract_markup_gt(args.markup, args.source, dpi=args.dpi)
    inferences, evaluation = run_leave_one_out(pages, gt, candidates)
    inference_path = save_results(inferences, args.output)
    eval_path = args.output / "evaluation.json"
    eval_path.write_text(json.dumps(evaluation, indent=2))
    yaml_path = export_yolo_seg(gt, pages, args.dataset)
    baseline_path = OUTPUT_DIR / "yoloe_markup" / "evaluation.json"
    comparison = {"cad_match": evaluation["classes"]}
    if baseline_path.is_file():
        baseline = json.loads(baseline_path.read_text())
        comparison["yoloe_visual_prompts"] = baseline.get("classes", {})
    (args.output / "comparison.json").write_text(json.dumps(comparison, indent=2))
    print(f"Inference: {inference_path}")
    print(f"Evaluation: {eval_path}")
    print("metrics:", evaluation["classes"])
    print(f"YOLO-seg dataset: {yaml_path}")


if __name__ == "__main__":
    main()
