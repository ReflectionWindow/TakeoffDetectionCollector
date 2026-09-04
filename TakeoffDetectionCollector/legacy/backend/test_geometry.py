"""Smoke-check that a vector rectangle becomes snap points + segments."""

import fitz

from geometry import extract_page_geometry


def test_rectangle_drawings() -> None:
    doc = fitz.open()
    page = doc.new_page(width=200, height=100)
    page.draw_rect(fitz.Rect(10, 20, 80, 70), color=(0, 0, 0), width=0.5)
    geom = extract_page_geometry(page)
    doc.close()

    assert geom["width"] == 200
    assert geom["height"] == 100
    assert len(geom["points"]) == 4
    assert len(geom["segments"]) == 4
    xs = sorted({round(p[0], 1) for p in geom["points"]})
    ys = sorted({round(p[1], 1) for p in geom["points"]})
    assert xs == [10.0, 80.0]
    assert ys == [20.0, 70.0]


if __name__ == "__main__":
    test_rectangle_drawings()
    print("geometry ok")
