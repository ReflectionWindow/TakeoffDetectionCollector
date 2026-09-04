"""Fine-tune YOLO11-seg on the markup GT tiles.

This is the path that generalizes to new sheets. The CAD matcher is better
on this elevation set without training; use this once more labeled pages exist.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from infer import WEIGHTS_DIR


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=Path(__file__).parent / "datasets" / "uih_cw_sf" / "data.yaml")
    parser.add_argument("--model", default=str(WEIGHTS_DIR / "yolo11n-seg.pt"))
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--project", type=Path, default=Path(__file__).parent / "runs" / "segment")
    args = parser.parse_args()

    from ultralytics import YOLO

    model = YOLO(args.model)
    model.train(
        data=str(args.data),
        epochs=args.epochs,
        imgsz=args.imgsz,
        project=str(args.project),
        name="uih_cw_sf",
        exist_ok=True,
    )


if __name__ == "__main__":
    main()
