"""API smoke checks for session, upload, and geometry."""

from pathlib import Path

import fitz
from fastapi.testclient import TestClient

import app as svc


def _tiny_pdf() -> bytes:
    doc = fitz.open()
    page = doc.new_page(width=200, height=100)
    page.draw_rect(fitz.Rect(10, 20, 80, 70), color=(0, 0, 0), width=0.5)
    data = doc.tobytes()
    doc.close()
    return data


def test_auth_and_geometry(tmp_path: Path | None = None) -> None:
    svc.PASSWORD = "dev-password"
    svc.TEMP_ROOT = Path(tmp_path) if tmp_path else Path("/tmp/takeoff-test")
    svc.TEMP_ROOT.mkdir(parents=True, exist_ok=True)
    client = TestClient(svc.app)

    blocked = client.get("/api/pdf/x/pages/0/geometry")
    assert blocked.status_code == 401

    bad = client.post("/api/session", json={"password": "nope"})
    assert bad.status_code == 401

    ok = client.post("/api/session", json={"password": "dev-password"})
    assert ok.status_code == 200
    token = ok.json()["token"]
    headers = {"Authorization": f"Bearer {token}"}

    upload = client.post(
        "/api/pdf",
        headers=headers,
        files={"file": ("sheet.pdf", _tiny_pdf(), "application/pdf")},
    )
    assert upload.status_code == 200, upload.text
    file_id = upload.json()["fileId"]
    assert upload.json()["pageCount"] == 1

    geom = client.get(f"/api/pdf/{file_id}/pages/0/geometry", headers=headers)
    assert geom.status_code == 200
    body = geom.json()
    assert body["width"] == 200
    assert len(body["points"]) == 4
    assert len(body["segments"]) == 4


if __name__ == "__main__":
    test_auth_and_geometry()
    print("api ok")
