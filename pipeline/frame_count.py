"""Count transoms and mullions on a captured window crop (raster only).

A member is often two or three parallel CAD strokes. Detection boxes also
clip the outer frame, so the crop is padded and peaks on the box edge are
treated as frame, not interior members.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path

import cv2
import numpy as np

from infer import OUTPUT_DIR

PAD_PX = 28
MERGE_PX = 16
MAX_MEMBER_PX = 22
COVERAGE = 0.32
SOLIDITY = 0.42
INK_OFFSET = 28
FILL_SWITCH = 0.42


@dataclass
class Member:
    position: float
    coverage: float
    kind: str  # interior | frame
    stroke_count: int


@dataclass
class FrameCount:
    window_id: str
    class_name: str
    bbox_xyxy: list[float]
    transoms: int
    mullions: int
    lite_rows: int
    lite_cols: int
    transom_members: list[Member]
    mullion_members: list[Member]
    notes: list[str]


def _ink_mask(gray: np.ndarray) -> np.ndarray:
    """Global dark threshold on line drawings; local contrast on filled panels."""
    paper = float(np.percentile(gray, 92))
    global_ink = gray < paper - INK_OFFSET
    if float(global_ink.mean()) < FILL_SWITCH:
        return np.where(global_ink, 255, 0).astype(np.uint8)
    dark = gray < min(80.0, paper - 80.0)
    blur = cv2.GaussianBlur(gray, (15, 15), 0)
    local = gray.astype(np.int16) < blur.astype(np.int16) - 16
    return np.where(dark | local, 255, 0).astype(np.uint8)


def _isolate_lines(ink: np.ndarray, horizontal: bool, span: int, merge: int) -> np.ndarray:
    length = max(12, span)
    kernel = (length, 1) if horizontal else (1, length)
    lines = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, kernel))
    close = (1, merge) if horizontal else (merge, 1)
    return cv2.morphologyEx(lines, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, close))


def _coverage_profile(mask: np.ndarray, axis: int) -> np.ndarray:
    if mask.size == 0:
        return np.zeros(0, dtype=np.float32)
    return (mask > 0).mean(axis=axis).astype(np.float32)


def _longest_run_ratio(values: np.ndarray) -> float:
    if values.size == 0:
        return 0.0
    longest = current = 0
    for value in values:
        if value:
            current += 1
            longest = max(longest, current)
        else:
            current = 0
    return longest / float(values.size)


def _merge_from_gaps(gaps: np.ndarray, fallback: int, bay: int) -> int:
    gaps = np.asarray(gaps, dtype=np.float32)
    if gaps.size < 4 or bay < 8:
        return fallback
    low, high = float(gaps.min()), float(gaps.max())
    if high < 1.7 * max(low, 1.0):
        return fallback
    small, large = low, high
    group_small = gaps
    for _ in range(8):
        near_small = np.abs(gaps - small) <= np.abs(gaps - large)
        group_small, group_large = gaps[near_small], gaps[~near_small]
        if group_small.size == 0 or group_large.size == 0:
            return fallback
        small, large = float(np.median(group_small)), float(np.median(group_large))
        if small > large:
            small, large = large, small
            group_small, group_large = group_large, group_small
    if large < 1.75 * max(small, 1.0) or small > MAX_MEMBER_PX + 8:
        return fallback
    merge = int(round(float(np.percentile(group_small, 75)) * 1.2))
    cap = max(fallback, min(MAX_MEMBER_PX + 10, int(0.045 * bay) if bay else MAX_MEMBER_PX))
    return int(np.clip(merge, fallback, cap))


def _cluster_peaks(profile: np.ndarray, merge: int, min_coverage: float, bay: int | None = None) -> list[Member]:
    if profile.size < 3:
        return []
    threshold = max(min_coverage, 0.45 * float(profile.max()) if profile.max() > 0 else 1.0)
    raw: list[tuple[int, float]] = []
    for i in range(1, len(profile) - 1):
        if profile[i] >= profile[i - 1] and profile[i] >= profile[i + 1] and profile[i] >= threshold:
            raw.append((i, float(profile[i])))
    raw.sort(key=lambda item: -item[1])
    seeds: list[tuple[int, float]] = []
    for index, score in raw:
        if all(abs(index - kept) >= max(2, merge // 4) for kept, _ in seeds):
            seeds.append((index, score))
    seeds.sort()
    if not seeds:
        return []
    if bay and len(seeds) >= 5:
        merge = _merge_from_gaps(np.diff([index for index, _ in seeds]), merge, bay)

    max_span = max(MAX_MEMBER_PX, merge + 8)
    groups: list[list[tuple[int, float]]] = [[seeds[0]]]
    for item in seeds[1:]:
        gap = item[0] - groups[-1][-1][0]
        span = item[0] - groups[-1][0][0]
        if gap <= merge and span <= max_span:
            groups[-1].append(item)
        else:
            groups.append([item])

    members = []
    for group in groups:
        weights = np.array([score for _, score in group], dtype=np.float32)
        positions = np.array([index for index, _ in group], dtype=np.float32)
        members.append(
            Member(
                position=float(np.average(positions, weights=weights)),
                coverage=float(weights.max()),
                kind="interior",
                stroke_count=len(group),
            )
        )
    return members


def _runs(values: np.ndarray) -> list[int]:
    lengths: list[int] = []
    current = 0
    for value in values:
        if value:
            current += 1
        elif current:
            lengths.append(current)
            current = 0
    if current:
        lengths.append(current)
    return lengths


def _longest_run_span(values: np.ndarray) -> tuple[int, int] | None:
    best_len = -1
    best: tuple[int, int] | None = None
    start: int | None = None
    for index, value in enumerate(values):
        if value and start is None:
            start = index
        elif not value and start is not None:
            if index - start > best_len:
                best_len = index - start
                best = (start, index)
            start = None
    if start is not None and len(values) - start > best_len:
        best = (start, len(values))
    return best


def _is_dashed(ink_row: np.ndarray) -> bool:
    runs = _runs(ink_row > 0)
    if not runs:
        return True
    longest = max(runs)
    width = max(len(ink_row), 1)
    if longest / width >= 0.50:
        return False
    total = float(sum(runs))
    if longest / max(total, 1.0) >= 0.55 and longest >= 40:
        return False
    median = float(np.median(runs))
    return len(runs) >= 4 and median < 0.12 * width


def _material_break(gray: np.ndarray, y: int, box: tuple[int, int, int, int], band: int = 18) -> bool:
    x1, _, x2, _ = box
    above = gray[max(0, y - band) : y, x1:x2]
    below = gray[y : min(gray.shape[0], y + band), x1:x2]
    if above.size < 20 or below.size < 20:
        return False
    return abs(float(above.std()) - float(below.std())) > 12.0 or abs(float(above.mean()) - float(below.mean())) > 18.0


def _keep_solid(
    members: list[Member],
    mask: np.ndarray,
    ink: np.ndarray,
    gray: np.ndarray,
    horizontal: bool,
    box: tuple[int, int, int, int],
) -> list[Member]:
    x1, y1, x2, y2 = box
    kept = []
    for member in members:
        pos = int(round(member.position))
        if horizontal:
            if not 0 <= pos < mask.shape[0]:
                continue
            strip = mask[pos, max(0, x1) : min(mask.shape[1], x2)] > 0
            raw = ink[pos, max(0, x1) : min(ink.shape[1], x2)]
        else:
            if not 0 <= pos < mask.shape[1]:
                continue
            strip = mask[max(0, y1) : min(mask.shape[0], y2), pos] > 0
            raw = ink[max(0, y1) : min(ink.shape[0], y2), pos]
        if _longest_run_ratio(strip) < SOLIDITY:
            continue
        runs = _runs(strip)
        longest = max(runs) if runs else 0
        min_span = 0.22 * (x2 - x1) if horizontal else 0.20 * (y2 - y1)
        if longest < min_span:
            continue
        if horizontal and (_is_dashed(raw) or _dashed_neighbors(ink, pos, True, box)):
            if not _material_break(gray, pos, box):
                continue
        kept.append(member)
    return kept


def _add_partial_horizontals(
    existing: list[Member],
    mask: np.ndarray,
    ink: np.ndarray,
    gray: np.ndarray,
    box: tuple[int, int, int, int],
    merge: int,
) -> list[Member]:
    x1, y1, x2, y2 = box
    width = x2 - x1
    height = y2 - y1
    if width < 80 or height < 80:
        return existing
    extras: list[Member] = []
    for start, stop in ((x1, x1 + int(0.58 * width)), (x1 + int(0.42 * width), x2)):
        if stop - start < 48:
            continue
        slice_box = (start, y1, stop, y2)
        members = _keep_solid(
            _cluster_peaks(_coverage_profile(mask[:, start:stop], 1), merge, 0.50),
            mask,
            ink,
            gray,
            True,
            slice_box,
        )
        other_a, other_b = (stop, x2) if start == x1 else (x1, start)
        for member in members:
            pos = int(round(member.position))
            if not 0 <= pos < mask.shape[0]:
                continue
            rel_y = (pos - y1) / float(max(height, 1))
            if rel_y < 0.14 or rel_y > 0.34:
                continue
            here = _longest_run_ratio(mask[pos, start:stop] > 0)
            other = _longest_run_ratio(mask[pos, other_a:other_b] > 0)
            if here < 0.50 or other >= 0.18:
                continue
            raw_runs = _runs(ink[pos, start:stop] > 0)
            mask_runs = _runs(mask[pos, start:stop] > 0)
            raw_long = max(raw_runs) if raw_runs else 0
            mask_long = max(mask_runs) if mask_runs else 0
            if raw_long < max(70, 0.65 * mask_long):
                continue
            if not 0.25 * width <= raw_long <= 0.65 * width:
                continue
            if _is_local_perimeter(mask, pos, start, stop, box):
                continue
            if not _has_room_below_head(mask, pos, start, stop, box):
                continue
            extras.append(member)
    combined = list(existing)
    for member in extras:
        if all(abs(member.position - kept.position) > merge + 6 for kept in combined):
            combined.append(member)
    combined.sort(key=lambda item: item.position)
    return combined


def _is_local_perimeter(
    mask: np.ndarray,
    y: int,
    start: int,
    stop: int,
    box: tuple[int, int, int, int],
    tol: int = 16,
) -> bool:
    x1, y1, x2, y2 = box
    cols = np.where(mask[y, start:stop] > 0)[0] + start
    if cols.size < 8:
        return True
    sample = cols[:: max(1, cols.size // 40)]
    heads, sills = [], []
    for x in sample:
        hits = np.where(mask[y1:y2, x] > 0)[0]
        if hits.size == 0:
            continue
        heads.append(int(hits[0]) + y1)
        sills.append(int(hits[-1]) + y1)
    if not heads:
        return True
    return abs(float(np.median(heads)) - y) <= tol or abs(float(np.median(sills)) - y) <= tol


def _has_room_below_head(
    mask: np.ndarray,
    y: int,
    start: int,
    stop: int,
    box: tuple[int, int, int, int],
) -> bool:
    x1, y1, x2, y2 = box
    cols = np.where(mask[y, start:stop] > 0)[0] + start
    if cols.size < 8:
        return False
    sample = cols[:: max(1, cols.size // 40)]
    gaps = []
    for x in sample:
        above = np.where(mask[y1:y, x] > 0)[0]
        if above.size:
            gaps.append(y - (int(above[-1]) + y1))
    if len(gaps) < 4:
        return False
    return float(np.median(gaps)) >= max(48.0, 0.12 * (y2 - y1))


def _dashed_neighbors(
    ink: np.ndarray,
    pos: int,
    horizontal: bool,
    box: tuple[int, int, int, int],
    radius: int = 4,
) -> bool:
    x1, y1, x2, y2 = box
    flags = []
    for delta in range(-radius, radius + 1):
        index = pos + delta
        if horizontal:
            if not 0 <= index < ink.shape[0]:
                continue
            row = ink[index, max(0, x1) : min(ink.shape[1], x2)]
        else:
            if not 0 <= index < ink.shape[1]:
                continue
            row = ink[max(0, y1) : min(ink.shape[0], y2), index]
        if not np.any(row > 0):
            continue
        flags.append(_is_dashed(row))
    return bool(flags) and sum(flags) >= max(3, int(0.6 * len(flags)))


def _merge_filled_bands(
    members: list[Member],
    gray: np.ndarray,
    horizontal: bool,
    box: tuple[int, int, int, int],
    max_gap: int,
) -> list[Member]:
    if len(members) < 2:
        return members
    x1, y1, x2, y2 = box
    paper = float(np.percentile(gray, 90))
    kept = [members[0]]
    for member in members[1:]:
        prev = kept[-1]
        start, stop = int(round(prev.position)), int(round(member.position))
        if stop <= start or stop - start > max_gap:
            kept.append(member)
            continue
        strip = gray[start : stop + 1, x1:x2] if horizontal else gray[y1:y2, start : stop + 1]
        fill = float((strip < paper - 20).mean()) if strip.size else 0.0
        if fill >= 0.55:
            kept[-1] = Member(
                position=0.5 * (prev.position + member.position),
                coverage=max(prev.coverage, member.coverage),
                kind="interior",
                stroke_count=prev.stroke_count + member.stroke_count,
            )
        else:
            kept.append(member)
    return kept


def _drop_weak_texture(members: list[Member]) -> list[Member]:
    if len(members) < 8:
        return members
    scores = np.array([member.coverage for member in members], dtype=np.float32)
    if float(scores.std()) < 0.12:
        return members
    reference = float(np.median(np.sort(scores)[::-1][: max(3, len(scores) // 3)]))
    return [member for member in members if member.coverage >= 0.72 * reference]


def _collapse_close_members(members: list[Member], limit: float) -> list[Member]:
    if len(members) < 2 or limit <= 0:
        return members
    ordered = sorted(members, key=lambda member: member.position)
    kept = [ordered[0]]
    for member in ordered[1:]:
        if member.position - kept[-1].position <= limit:
            prev = kept[-1]
            kept[-1] = Member(
                position=0.5 * (prev.position + member.position),
                coverage=max(prev.coverage, member.coverage),
                kind=prev.kind,
                stroke_count=prev.stroke_count + member.stroke_count,
            )
        else:
            kept.append(member)
    return kept


def _label_borders(
    members: list[Member],
    box0: float,
    box1: float,
    pad_start: float,
    pad_end: float,
) -> list[Member]:
    band = max(8.0, min(36.0, 0.08 * (box1 - box0)), MERGE_PX * 1.2)
    labeled = []
    for member in members:
        pos = member.position
        on_box_edge = abs(pos - box0) <= band or abs(pos - box1) <= band
        in_pad = pos < box0 - 1 or pos > box1 + 1
        outside_search = pos < pad_start or pos > pad_end
        kind = "frame" if on_box_edge or in_pad or outside_search else "interior"
        labeled.append(
            Member(
                position=member.position,
                coverage=member.coverage,
                kind=kind,
                stroke_count=member.stroke_count,
            )
        )
    return labeled


def _absorb_near_frame(members: list[Member], distance: float) -> list[Member]:
    frames = [member.position for member in members if member.kind == "frame"]
    if not frames:
        return members
    absorbed = []
    for member in members:
        kind = member.kind
        if kind == "interior" and any(abs(member.position - frame) <= distance for frame in frames):
            kind = "frame"
        absorbed.append(
            Member(
                position=member.position,
                coverage=member.coverage,
                kind=kind,
                stroke_count=member.stroke_count,
            )
        )
    return absorbed


def count_window_frame(
    image_bgr: np.ndarray,
    bbox_xyxy: list[float],
    *,
    window_id: str = "",
    class_name: str = "",
    pad: int = PAD_PX,
) -> tuple[FrameCount, np.ndarray]:
    height, width = image_bgr.shape[:2]
    x1, y1, x2, y2 = [int(round(v)) for v in bbox_xyxy]
    x1, x2 = max(0, min(x1, x2)), min(width, max(x1, x2))
    y1, y2 = max(0, min(y1, y2)), min(height, max(y1, y2))
    bay_w, bay_h = max(x2 - x1, 1), max(y2 - y1, 1)

    cx0, cy0 = max(0, x1 - pad), max(0, y1 - pad)
    cx1, cy1 = min(width, x2 + pad), min(height, y2 + pad)
    crop = image_bgr[cy0:cy1, cx0:cx1]
    if crop.size == 0:
        empty = FrameCount(window_id, class_name, bbox_xyxy, 0, 0, 0, 0, [], [], ["empty crop"])
        return empty, image_bgr[0:1, 0:1].copy()

    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    ink = _ink_mask(gray)
    merge = max(7, min(MERGE_PX, int(0.045 * min(bay_w, bay_h)) or MERGE_PX))
    h_span = max(16, int(0.32 * bay_w))
    v_span = max(16, int(0.48 * bay_h))
    h_mask = _isolate_lines(ink, True, h_span, merge)
    v_mask = _isolate_lines(ink, False, v_span, merge)

    local_x1, local_y1 = x1 - cx0, y1 - cy0
    local_x2, local_y2 = x2 - cx0, y2 - cy0
    box = (local_x1, local_y1, local_x2, local_y2)
    transoms = _label_borders(
        _merge_filled_bands(
            _add_partial_horizontals(
                _keep_solid(
                    _cluster_peaks(_coverage_profile(h_mask, 1), merge, COVERAGE, bay_h),
                    h_mask,
                    ink,
                    gray,
                    True,
                    box,
                ),
                h_mask,
                ink,
                gray,
                box,
                merge,
            ),
            gray,
            True,
            box,
            max(22, int(0.035 * bay_h)),
        ),
        local_y1,
        local_y2,
        0,
        crop.shape[0] - 1,
    )
    mullions = _label_borders(
        _drop_weak_texture(
            _collapse_close_members(
                _merge_filled_bands(
                    _keep_solid(
                        _cluster_peaks(_coverage_profile(v_mask, 0), merge, COVERAGE, bay_w),
                        v_mask,
                        ink,
                        gray,
                        False,
                        box,
                    ),
                    gray,
                    False,
                    box,
                    max(22, int(0.035 * bay_w)),
                ),
                max(merge + 8, min(42, int(0.018 * bay_w) or 42)),
            )
        ),
        local_x1,
        local_x2,
        0,
        crop.shape[1] - 1,
    )

    transoms = _absorb_near_frame(transoms, 28)
    mullions = _absorb_near_frame(mullions, 22)
    interior_t = [m for m in transoms if m.kind == "interior"]
    interior_m = [m for m in mullions if m.kind == "interior"]
    notes = []
    if any(m.stroke_count > 1 for m in transoms + mullions):
        notes.append("merged stacked CAD strokes into single members")
    if any(m.kind == "frame" for m in transoms + mullions):
        notes.append("frame peaks on or just outside the detection box were not counted as interior")

    result = FrameCount(
        window_id=window_id,
        class_name=class_name,
        bbox_xyxy=[float(x1), float(y1), float(x2), float(y2)],
        transoms=len(interior_t),
        mullions=len(interior_m),
        lite_rows=len(interior_t) + 1,
        lite_cols=len(interior_m) + 1,
        transom_members=transoms,
        mullion_members=mullions,
        notes=notes,
    )
    overlay = _draw_count_overlay(crop, result, (local_x1, local_y1, local_x2, local_y2), h_mask, v_mask)
    return result, overlay


def _draw_count_overlay(
    crop: np.ndarray,
    result: FrameCount,
    local_box: tuple[int, int, int, int],
    h_mask: np.ndarray,
    v_mask: np.ndarray,
) -> np.ndarray:
    overlay = crop.copy()
    tint = overlay.copy()
    x1, y1, x2, y2 = local_box
    cv2.rectangle(overlay, (x1, y1), (x2, y2), (180, 80, 220), 2)
    for member in result.transom_members:
        y = int(round(member.position))
        color = (60, 200, 80) if member.kind == "interior" else (40, 140, 255)
        xa, xb = x1, x2
        if member.kind == "interior" and 0 <= y < h_mask.shape[0]:
            span = _longest_run_span(h_mask[y, x1:x2] > 0)
            if span:
                xa, xb = x1 + span[0], x1 + span[1]
        cv2.line(overlay, (xa, y), (xb, y), color, 2)
    for member in result.mullion_members:
        x = int(round(member.position))
        color = (60, 200, 80) if member.kind == "interior" else (40, 140, 255)
        cv2.line(overlay, (x, y1), (x, y2), color, 2)
    lines = overlay.copy()
    lines[h_mask > 0] = (0.55 * lines[h_mask > 0] + np.array([40, 220, 40])).astype(np.uint8)
    lines[v_mask > 0] = (0.55 * lines[v_mask > 0] + np.array([220, 160, 40])).astype(np.uint8)
    overlay = cv2.addWeighted(lines, 0.35, overlay, 0.65, 0)
    label = f"{result.window_id}  T={result.transoms}  M={result.mullions}  lites {result.lite_rows}x{result.lite_cols}"
    cv2.putText(overlay, label, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (20, 20, 20), 3, cv2.LINE_AA)
    cv2.putText(overlay, label, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)
    del tint
    return overlay


def _windows_from_gt(gt: dict) -> list[dict]:
    windows = []
    for page in gt["pages"]:
        for item in page["annotations"]:
            windows.append(
                {
                    "id": item["id"],
                    "class_name": item["class_name"],
                    "page_index": page["page_index"],
                    "stem": page["stem"],
                    "bbox_xyxy": item["bbox_xyxy"],
                }
            )
    return windows


def _windows_from_detections(payload: list[dict]) -> list[dict]:
    windows = []
    for page in payload:
        for index, item in enumerate(page.get("detections") or []):
            windows.append(
                {
                    "id": f"{page['stem']}_{item['class_name'].lower()}_{index:03d}",
                    "class_name": item["class_name"],
                    "page_index": page["page_index"],
                    "stem": page["stem"],
                    "bbox_xyxy": item["bbox_xyxy"],
                }
            )
    return windows


def _load_page_images(image_dir: Path) -> dict[str, np.ndarray]:
    images = {}
    for path in sorted(image_dir.glob("*.png")):
        if path.name.endswith("_overlay.png"):
            continue
        image = cv2.imread(str(path))
        if image is not None:
            images[path.stem] = image
    return images


def run_counts(
    windows: list[dict],
    images: dict[str, np.ndarray],
    output_dir: Path,
    *,
    classes: set[str] | None = None,
) -> list[FrameCount]:
    output_dir.mkdir(parents=True, exist_ok=True)
    overlay_dir = output_dir / "overlays"
    overlay_dir.mkdir(parents=True, exist_ok=True)
    results: list[FrameCount] = []
    for window in windows:
        if classes and window["class_name"] not in classes:
            continue
        image = images.get(window["stem"])
        if image is None:
            continue
        result, overlay = count_window_frame(
            image,
            window["bbox_xyxy"],
            window_id=window["id"],
            class_name=window["class_name"],
        )
        results.append(result)
        cv2.imwrite(str(overlay_dir / f"{window['id']}.png"), overlay)
    payload = []
    for result in results:
        row = asdict(result)
        row["transom_members"] = [asdict(m) for m in result.transom_members]
        row["mullion_members"] = [asdict(m) for m in result.mullion_members]
        payload.append(row)
    (output_dir / "counts.json").write_text(json.dumps(payload, indent=2))
    return results


def _highlight_bbox(image_bgr: np.ndarray) -> list[float] | None:
    hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
    pink = cv2.inRange(hsv, (140, 40, 40), (175, 255, 255))
    magenta = cv2.inRange(hsv, (125, 40, 40), (145, 255, 255))
    mask = cv2.bitwise_or(pink, magenta)
    if int(mask.sum()) < 200:
        return None
    ys, xs = np.where(mask > 0)
    return [float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max())]


def count_image(path: Path, output_dir: Path) -> FrameCount:
    image = cv2.imread(str(path))
    if image is None:
        raise ValueError(f"Could not read image: {path}")
    bbox = _highlight_bbox(image) or [0, 0, image.shape[1] - 1, image.shape[0] - 1]
    result, overlay = count_window_frame(image, bbox, window_id=path.stem, class_name="window")
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "overlays").mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output_dir / "overlays" / f"{path.stem}.png"), overlay)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Count transoms/mullions on captured window images.")
    parser.add_argument("--boxes", type=Path, default=Path(__file__).parent / "ground_truth" / "UIH_ELEVATION_GT.json")
    parser.add_argument("--images", type=Path, default=OUTPUT_DIR)
    parser.add_argument("--image", type=Path, help="Single captured window image instead of a box list")
    parser.add_argument("--output", type=Path, default=OUTPUT_DIR / "frame_count")
    parser.add_argument("--classes", nargs="*", default=["CW", "SF"])
    args = parser.parse_args()

    if args.image:
        result = count_image(args.image, args.output)
        print(f"{result.window_id}: transoms={result.transoms} mullions={result.mullions} lites={result.lite_rows}x{result.lite_cols}")
        return

    raw = json.loads(Path(args.boxes).read_text())
    windows = _windows_from_detections(raw) if isinstance(raw, list) else _windows_from_gt(raw)
    images = _load_page_images(args.images)
    results = run_counts(windows, images, args.output, classes=set(args.classes))
    by_class: dict[str, list[FrameCount]] = {}
    for result in results:
        by_class.setdefault(result.class_name, []).append(result)
    print(f"Counted {len(results)} window(s) → {args.output / 'counts.json'}")
    for class_name, rows in by_class.items():
        transoms = [row.transoms for row in rows]
        mullions = [row.mullions for row in rows]
        print(
            f"  {class_name}: n={len(rows)}  transoms median={int(np.median(transoms))} "
            f"mullions median={int(np.median(mullions))}"
        )


if __name__ == "__main__":
    main()
