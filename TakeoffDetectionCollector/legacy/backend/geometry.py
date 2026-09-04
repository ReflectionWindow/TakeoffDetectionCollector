"""Extract compact snap vertices and segments from a vector PDF page."""

from __future__ import annotations

from collections import defaultdict

import fitz

TOL = 0.35
MIN_SEGMENT_LEN = 0.4
CURVE_SAMPLES = 4


def _xy(pt) -> tuple[float, float]:
    if hasattr(pt, "x"):
        return (float(pt.x), float(pt.y))
    return (float(pt[0]), float(pt[1]))


def _bezier(
    p1: tuple[float, float],
    p2: tuple[float, float],
    p3: tuple[float, float],
    p4: tuple[float, float],
    t: float,
) -> tuple[float, float]:
    u = 1.0 - t
    uu, tt = u * u, t * t
    uuu, ttt = uu * u, tt * t
    return (
        uuu * p1[0] + 3 * uu * t * p2[0] + 3 * u * tt * p3[0] + ttt * p4[0],
        uuu * p1[1] + 3 * uu * t * p2[1] + 3 * u * tt * p3[1] + ttt * p4[1],
    )


class _PointIndex:
    def __init__(self, tol: float = TOL) -> None:
        self.tol = tol
        self.points: list[tuple[float, float]] = []
        self._grid: dict[tuple[int, int], list[int]] = defaultdict(list)

    def add(self, x: float, y: float) -> int:
        gx = round(x / self.tol)
        gy = round(y / self.tol)
        for ix in (gx - 1, gx, gx + 1):
            for iy in (gy - 1, gy, gy + 1):
                for idx in self._grid.get((ix, iy), ()):
                    px, py = self.points[idx]
                    if abs(px - x) <= self.tol and abs(py - y) <= self.tol:
                        return idx
        idx = len(self.points)
        self.points.append((round(x, 4), round(y, 4)))
        self._grid[(gx, gy)].append(idx)
        return idx


def _rect_corners(rect) -> list[tuple[float, float]]:
    if hasattr(rect, "x0"):
        x0, y0, x1, y1 = float(rect.x0), float(rect.y0), float(rect.x1), float(rect.y1)
    else:
        x0, y0, x1, y1 = (float(rect[0]), float(rect[1]), float(rect[2]), float(rect[3]))
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def _quad_corners(quad) -> list[tuple[float, float]]:
    if hasattr(quad, "ul"):
        return [_xy(quad.ul), _xy(quad.ur), _xy(quad.lr), _xy(quad.ll)]
    corners = []
    for attr in ("ul", "ur", "lr", "ll"):
        if hasattr(quad, attr):
            corners.append(_xy(getattr(quad, attr)))
    if len(corners) == 4:
        return corners
    pts = list(quad)
    return [_xy(p) for p in pts[:4]]


def extract_page_geometry(page: fitz.Page) -> dict:
    """Return page size plus deduped snap points and indexed segments.

    Coordinates are y-down, origin at the page top-left (PyMuPDF / visual space),
    matching a PDF.js canvas render.
    """
    rect = page.rect
    width = float(rect.width)
    height = float(rect.height)
    index = _PointIndex()
    segments: set[tuple[int, int]] = set()

    def add_segment(a: tuple[float, float], b: tuple[float, float]) -> None:
        dx, dy = a[0] - b[0], a[1] - b[1]
        if dx * dx + dy * dy < MIN_SEGMENT_LEN * MIN_SEGMENT_LEN:
            index.add(*a)
            index.add(*b)
            return
        i = index.add(*a)
        j = index.add(*b)
        if i != j:
            segments.add((i, j) if i < j else (j, i))

    def add_ring(pts: list[tuple[float, float]]) -> None:
        for a, b in zip(pts, pts[1:] + pts[:1]):
            add_segment(a, b)

    for path in page.get_drawings():
        items = path.get("items") or []
        for item in items:
            if not item:
                continue
            op = item[0]
            try:
                if op == "l" and len(item) >= 3:
                    add_segment(_xy(item[1]), _xy(item[2]))
                elif op == "c" and len(item) >= 5:
                    p1, p2, p3, p4 = _xy(item[1]), _xy(item[2]), _xy(item[3]), _xy(item[4])
                    samples = [
                        _bezier(p1, p2, p3, p4, t / CURVE_SAMPLES)
                        for t in range(CURVE_SAMPLES + 1)
                    ]
                    for a, b in zip(samples, samples[1:]):
                        add_segment(a, b)
                elif op == "re" and len(item) >= 2:
                    add_ring(_rect_corners(item[1]))
                elif op == "qu" and len(item) >= 2:
                    add_ring(_quad_corners(item[1]))
            except (TypeError, ValueError, AttributeError, IndexError):
                continue

    return {
        "width": width,
        "height": height,
        "points": [list(p) for p in index.points],
        "segments": [list(s) for s in segments],
    }
