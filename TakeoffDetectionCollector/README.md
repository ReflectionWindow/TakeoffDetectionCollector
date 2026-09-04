# TakeoffDetectionCollector

Team app for **cleaning** louvre / metal-panel / window boxes that were labeled on **75 DPI** rasters of vector elevation PDFs. Attach the source PDF, snap every edge to real linework (strokes, color fills, dots), and keep every old and new annotation version in Supabase.

Frontend: **Vercel** (Vite + React). Backend: **Railway** (Go + goroutines). Auth: **Microsoft** via Supabase Azure. Database + object storage: **Supabase**.

The previous password-only snap annotator is preserved under [`legacy/`](legacy/) for reference. This repo is the production cleaner.

## What we are cleaning

Source dataset: `coco-redacted-good-jobs-louvers-metal-panels` — **245 jobs / 783 pages**, bbox-only COCO (no polygons), rasterized at **75 DPI** from vector PDFs. A 3600×2700 page is a 48"×36" sheet at 75 DPI.

| Class | Meaning |
|---|---|
| `PW` `SF` `WW` `CW` `SF/CW` | Window / storefront / curtain wall |
| `LOUVER` `METAL_PANEL` | Hard labels |
| `LOUVER_SOFT` `METAL_PANEL_SOFT` | Soft / uncertain |

PDFs are attached later. Import the COCO now; when a vector PDF lands, boxes remap into PDF space and snap to geometry.

## Architecture

```
Browser (Vercel)                    Railway (Go)                 Supabase
┌─────────────────────┐            ┌──────────────────┐         ┌─────────────┐
│ Microsoft login     │── JWT ───▶│ verify + domain  │────────▶│ Auth (Azure)│
│ Job inbox           │            │ import pool      │         │ Postgres    │
│ PDF.js + box canvas │◀─ API ────│ ingest pool      │◀───────▶│ Storage     │
│ review-ui snap      │            │ version pool     │         │  pdfs/      │
│ blackout [0,1]      │            │ geom extract     │         │  coco/      │
└─────────────────────┘            └──────────────────┘         │  annot vN   │
                                                                └─────────────┘
```

Env keys are **not** required to run locally. Leave them blank and the API uses an in-memory store + `DEV` sign-in. Plug in Supabase / Azure when you have them.

## Coordinate contract (precision)

Never store boxes in “whatever the canvas is today.”

| Space | Use |
|---|---|
| **PDF points** (72 pt = 1 in, y-down, page.rect) | Canonical geometry + snap extract |
| **75 DPI pixels** | Import-only. `pt = px * 72 / 75` |
| **Page fractions [0,1]** | Blackouts |
| **Displayed PNG px** | Snap bake + box drag. `sx = page_width_pt / image_width_px` — **no hardcoded DPI in snap math** |

When a PDF arrives:

1. Read `page.rect` width/height in pt.
2. Convert each COCO bbox `(x, y, w, h)` px → PDF pt via 75 DPI.
3. Overlay on a PDF.js render of the **vector** PDF.
4. Bake snap with the **displayed** raster size.
5. Persist edits in PDF pt (keep the original 75 DPI bbox on version 0).

## Snap and blackout

Ported from `takeoff-services/apps/review-ui`:

- Snap priority: `endpoint → intersection → midpoint → perpendicular → nearest → ortho → parallel`
- Box magnets: `snapRectEdges` / `snapMoveRect` / `snapResizeEdges` (10 px capture, 13 px release, Alt bypass)
- One-shot `snapModelBoxes` on first open of an imported page
- Blackouts stored as **[0,1] page fractions**

**Extensions** this collector adds (review-ui drops these):

- **Color fills** — fill outlines stay in the vector payload so a box can magnet to poche / panel fills
- **Dots** — isolated vertices and tick marks are a `points[]` bucket; endpoint snap hits them first

## Microsoft login

- Supabase Auth, provider `azure`, PKCE, redirect `/auth/callback`
- Backend verifies the JWT and rejects emails not ending in `@reflectionwindow.com`
- Dedicated Supabase project (do not share takeoff-services production tables)
- Production has **no** shared password. Local `DEV` login exists only when Supabase JWT is unset.

## Go backend (Railway)

Single service, worker pools (goroutines):

- **Import pool** — COCO jobs in parallel; each job writes pages + version-0 annotations
- **Ingest pool** — PDF upload → storage, then per-page extract
- **Version pool** — immutable JSON writes + revision rows

HTTP returns immediately with job status. No Redis in v1 (in-process queues + Postgres). Add Redis only if Railway replicas > 1.

MuPDF/CGO is **not** required for extract. Path walking is a pure-Go content-stream parser. Document-level work is parallel **across pages/jobs**, not concurrent writes to one PDF handle.

## Supabase schema

See [`supabase/migrations/001_init.sql`](supabase/migrations/001_init.sql).

**Storage buckets** (private, signed URLs):

```
pdfs/{job_id}/{sha256}.pdf
coco/{job_id}/_annotations.coco.json
annotations/{job_id}/p{page}/v{n}.json
rasters/{job_id}/p{page}.png
vectors/{job_id}/p{page}.json
```

Version 0 = imported COCO. Every save writes `v{n+1}` and never overwrites. Revert copies an old payload into a new version (append-only).

## Local development

```bash
# backend
cd backend
go test ./...
go run ./cmd/collector
# listens on :8080
# DEV login is on while SUPABASE_JWT_SECRET is empty
```

```bash
# frontend
cd frontend
cp .env.example .env.local   # leave blank for local /api proxy
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Click **Dev sign-in** until Microsoft keys exist.

Import the COCO tree (optional; needs the dataset on disk):

```bash
# while the API is running
curl -X POST http://localhost:8080/v1/imports/coco \
  -H 'Authorization: Bearer dev' \
  -F "dir=/Users/you/Downloads/coco-redacted-good-jobs-louvers-metal-panels"
```

Or zip the folder and upload it as `file`.

## Markup

- **Select (S)** — click a box; `1–9` reclass; Delete removes
- **Draw (R)** — drag a new box; edges snap to vectors
- **Move / resize** — drag interior or handles; magnets hold with hysteresis
- **Blackout (B)** — draw [0,1] redaction regions
- **Snap all** — one-shot magnet for unedited imported boxes
- **Alt** — bypass snap
- **Pan** — Space-drag or middle-mouse. Wheel zooms toward the cursor
- **Save** — writes a new annotation version
- **Revert** — copies an older version forward

## Export

**Export COCO** downloads a cleaned `_annotations.coco.json` per job. Boxes are written back in **75 DPI pixel space** (`px = pt * 75 / 72`) so training pipelines that expect the original raster size keep working.

## Deploy

### Supabase (when you have keys)

1. New project (not the takeoff-services prod project)
2. Run `supabase/migrations/001_init.sql`
3. Create private buckets: `pdfs`, `coco`, `annotations`, `rasters`, `vectors`
4. Auth → Azure (Microsoft). Redirect: `https://<app>.vercel.app/auth/callback` and `http://localhost:5173/auth/callback`
5. Restrict to `@reflectionwindow.com` in Entra or leave the API domain gate as the check

### Railway (backend)

1. New service from this repo
2. **Root directory:** `backend`
3. Variables (fill when ready):

| Name | Notes |
|---|---|
| `PORT` | Railway sets this |
| `CORS_ORIGINS` | `https://<app>.vercel.app` |
| `ALLOWED_EMAIL_DOMAIN` | `reflectionwindow.com` |
| `SUPABASE_URL` | |
| `SUPABASE_JWT_SECRET` | Project JWT secret (Auth → JWT) |
| `SUPABASE_SERVICE_ROLE_KEY` | server-only |
| `SUPABASE_DB_URL` | Postgres URI |
| `DATA_DIR` | optional local cache |

4. Start command: `./collector` (see `backend/Dockerfile`)

Uploads should allow at least 200 MB.

### Vercel (frontend)

1. New project, **root directory** `frontend`
2. Framework: Vite
3. Variables:

| Name | Notes |
|---|---|
| `VITE_API_URL` | Railway URL, no trailing slash |
| `VITE_SUPABASE_URL` | |
| `VITE_SUPABASE_ANON_KEY` | |

Redeploy after changing `VITE_*` (they are baked in at build time).

## API (v1)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness |
| GET | `/v1/me` | current user |
| POST | `/v1/auth/dev` | local-only session |
| POST | `/v1/auth/supabase` | verify Microsoft JWT |
| GET | `/v1/jobs` | inbox |
| GET | `/v1/jobs/:id` | job + pages |
| POST | `/v1/imports/coco` | zip or `dir=` |
| POST | `/v1/jobs/:id/pdf` | attach vector PDF |
| GET | `/v1/jobs/:id/pages/:n/annotations` | latest boxes |
| POST | `/v1/jobs/:id/pages/:n/annotations` | new version |
| POST | `/v1/jobs/:id/pages/:n/revert` | copy old version forward |
| GET | `/v1/jobs/:id/pages/:n/vectors` | snap geometry |
| PUT | `/v1/jobs/:id/pages/:n/blackouts` | [0,1] regions |
| GET | `/v1/jobs/:id/export/coco` | cleaned COCO |

## Out of scope for v1

- Sharing this DB with takeoff-services production
- Live multi-user CRDT on one page (last-write-wins per page)
- Training / YOLO in this repo (export only)
- Scanned / raster-only PDFs (no snap; freehand only)
