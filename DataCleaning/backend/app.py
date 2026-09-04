"""FastAPI service: auth, PDF upload, per-page snap geometry."""

from __future__ import annotations

import os
import secrets
import shutil
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import fitz
from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from geometry import extract_page_geometry

TTL_SECONDS = 2 * 60 * 60
MAX_UPLOAD_BYTES = 200 * 1024 * 1024
TEMP_ROOT = Path(os.environ.get("PDF_TEMP_DIR", "/tmp/takeoff-pdfs"))

PASSWORD = os.environ.get("ANNOTATOR_PASSWORD", "dev-password")
CORS_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "CORS_ORIGINS",
        "http://localhost:5173,http://localhost:4173",
    ).split(",")
    if o.strip()
]

@asynccontextmanager
async def lifespan(_app: FastAPI):
    TEMP_ROOT.mkdir(parents=True, exist_ok=True)
    yield
    if TEMP_ROOT.exists():
        shutil.rmtree(TEMP_ROOT, ignore_errors=True)


app = FastAPI(title="Takeoff Snap Geometry", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_sessions: dict[str, float] = {}
_pdfs: dict[str, dict] = {}


class PasswordBody(BaseModel):
    password: str


def _now() -> float:
    return time.time()


def _cleanup() -> None:
    now = _now()
    expired_tokens = [t for t, exp in _sessions.items() if exp < now]
    for t in expired_tokens:
        _sessions.pop(t, None)
    expired_files = [fid for fid, meta in _pdfs.items() if meta["expiry"] < now]
    for fid in expired_files:
        meta = _pdfs.pop(fid)
        path = Path(meta["path"])
        if path.exists():
            path.unlink(missing_ok=True)


def require_token(authorization: str | None = Header(default=None)) -> str:
    _cleanup()
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    token = authorization.split(" ", 1)[1].strip()
    exp = _sessions.get(token)
    if not exp or exp < _now():
        _sessions.pop(token, None)
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return token


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/api/session")
def create_session(body: PasswordBody) -> dict:
    _cleanup()
    if not secrets.compare_digest(body.password, PASSWORD):
        raise HTTPException(status_code=401, detail="Invalid password")
    token = secrets.token_urlsafe(32)
    _sessions[token] = _now() + TTL_SECONDS
    return {"token": token, "expiresIn": TTL_SECONDS}


@app.post("/api/pdf")
async def upload_pdf(
    file: UploadFile = File(...),
    _token: str = Depends(require_token),
) -> dict:
    _cleanup()
    name = (file.filename or "drawing.pdf").lower()
    if not name.endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Upload a PDF file")

    TEMP_ROOT.mkdir(parents=True, exist_ok=True)
    file_id = uuid.uuid4().hex
    dest = TEMP_ROOT / f"{file_id}.pdf"

    size = 0
    try:
        with dest.open("wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="PDF exceeds 200 MB")
                out.write(chunk)
    except HTTPException:
        dest.unlink(missing_ok=True)
        raise
    except Exception as exc:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"Failed to store PDF: {exc}") from exc

    try:
        doc = fitz.open(dest)
        if doc.is_encrypted:
            doc.close()
            dest.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail="Encrypted PDFs are not supported")
        pages = []
        for page in doc:
            r = page.rect
            pages.append({"width": float(r.width), "height": float(r.height)})
        page_count = doc.page_count
        doc.close()
    except HTTPException:
        raise
    except Exception as exc:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"Could not open PDF: {exc}") from exc

    _pdfs[file_id] = {
        "path": str(dest),
        "expiry": _now() + TTL_SECONDS,
        "pageCount": page_count,
        "pages": pages,
    }
    return {"fileId": file_id, "pageCount": page_count, "pages": pages}


@app.get("/api/pdf/{file_id}/pages/{page_index}/geometry")
def page_geometry(
    file_id: str,
    page_index: int,
    _token: str = Depends(require_token),
) -> dict:
    _cleanup()
    meta = _pdfs.get(file_id)
    if not meta:
        raise HTTPException(status_code=404, detail="PDF session expired. Upload again.")
    if page_index < 0 or page_index >= meta["pageCount"]:
        raise HTTPException(status_code=404, detail="Page not found")

    path = Path(meta["path"])
    if not path.exists():
        _pdfs.pop(file_id, None)
        raise HTTPException(status_code=404, detail="PDF session expired. Upload again.")

    try:
        doc = fitz.open(path)
        page = doc[page_index]
        geom = extract_page_geometry(page)
        doc.close()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Geometry extract failed: {exc}") from exc

    meta["expiry"] = _now() + TTL_SECONDS
    return geom

