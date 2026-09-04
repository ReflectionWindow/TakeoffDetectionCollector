# Takeoff Snap Annotator

Team web app for labeling **louvres**, **metal panels**, and **windows** on vector blueprint PDFs. The cursor snaps to the PDF’s real vertices and edges, then you export a **YOLO-seg** dataset (`images/`, `labels/`, `data.yaml`).

- **Frontend** (Vercel): Vite + React, PDF.js render, snap markup, client-side zip export
- **Backend** (Railway): FastAPI + PyMuPDF geometry extract

This app lives in `DataCleaning/` inside the TakeoffDetection project. Commands below are from the **project root**.

## Local development

Use the shared password `dev-password` unless you set `ANNOTATOR_PASSWORD`.

```bash
# backend
cd DataCleaning/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export ANNOTATOR_PASSWORD=dev-password
export CORS_ORIGINS=http://localhost:5173,http://localhost:4173
uvicorn app:app --reload --port 8000
```

```bash
# frontend
cd DataCleaning/frontend
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Vite proxies `/api` to port 8000, so leave `VITE_API_URL` empty.

### Markup

- **Polygon (V):** click snapped vertices, click the first point or press Enter to close
- **Rectangle (R):** click-drag; stored as a 4-point YOLO polygon
- **Select (S):** click a shape, `1`/`2`/`3` to change class, Delete to remove
- **Snap:** vertex first, then edge. Hold **Shift** for ortho
- **Pan:** Space-drag or middle-mouse. Wheel zooms toward the cursor
- **Show snap dots:** debug whether the sheet exposed vector geometry
- **Save / Load JSON:** resume markup later (re-open the same PDF, then load the JSON)

### Export

**Export YOLO-seg** downloads:

```text
dataset/images/train/<sheet>_p001.png
dataset/labels/train/<sheet>_p001.txt
dataset/data.yaml
```

Each label line is `class x1 y1 x2 y2 ... xn yn` with coordinates normalized to `[0, 1]`.

Classes: `0 louvre`, `1 metal_panel`, `2 window`. Pages with no shapes are skipped. Split train/val yourself before training.

## Deploy

### Railway (backend)

1. New project from this repo
2. **Root directory:** `DataCleaning/backend`
3. **Config file path:** `/DataCleaning/backend/railway.toml` (Railway does not inherit this from the root directory)
4. Variables:
   - `ANNOTATOR_PASSWORD` — shared team password
   - `CORS_ORIGINS` — `https://<your-app>.vercel.app` (comma-separate extra origins)
5. Confirm the start command is `uvicorn app:app --host 0.0.0.0 --port $PORT`
6. Copy the public URL (no trailing slash)

Blueprints can be large; Railway should allow uploads up to 200 MB.

### Vercel (frontend)

1. New project from this repo
2. **Root directory:** `DataCleaning/frontend`
3. Framework preset: Vite
4. Environment variable: `VITE_API_URL` = Railway URL (e.g. `https://takeoff-api.up.railway.app`)
5. Redeploy after changing `VITE_API_URL` (it is baked in at build time)

Share the Vercel URL and the Railway password with the team. The UI prompts for the password once per browser session.

## Training

```bash
yolo segment train data=dataset/data.yaml model=yolo11n-seg.pt epochs=100 imgsz=1280
```
