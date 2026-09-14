# TakeoffDetectionCollector

Team app for **cleaning** louvre / metal-panel / window boxes that were labeled on **75 DPI** rasters of vector elevation PDFs. Attach the source PDF, snap every edge to real linework (strokes, color fills, dots), and keep every old and new annotation version in Supabase.

Frontend: **Vercel** (Vite + React). Backend: **Railway** (Go + goroutines). Auth: **Microsoft** via Supabase Azure. Database + object storage: **Supabase**.

The previous password-only snap annotator is preserved under [`legacy/`](legacy/) for reference. This repo is the production cleaner.

## What we are cleaning

Source dataset: `coco-redacted-good-jobs-louvers-metal-panels` — **245 jobs / 784 pages / ~110k shapes**, rasterized at **75 DPI** from vector PDFs. A 3600×2700 page is a 48"×36" sheet at 75 DPI.

The COCO `segmentation` rings are almost all **axis-aligned rectangles**, because that is what the original labeling tool produced. Real openings are not rectangles, so the cleaner stores every shape as a **polygon** and lets a corrector add vertices to reshape an imported box (see [Markup](#markup)). A rectangle is just a 4-vertex polygon here — nothing needs converting up front.

| Class | Meaning |
|---|---|
| `PW` `SF` `WW` `CW` `SF/CW` | Window / storefront / curtain wall |
| `LOUVER` `METAL_PANEL` | Hard labels |
| `LOUVER_SOFT` `METAL_PANEL_SOFT` | Soft / uncertain |

Link jobs with the ingest program (COCO first, then clean vector PDFs). Bluebeam annotation markups are stripped so correctors see vector linework only.

## Ingest program

From `backend/`, with the API running:

```bash
go run ./cmd/ingest \
  --api http://localhost:8080 \
  --token dev \
  --coco /Users/you/Downloads/coco-redacted-good-jobs-louvers-metal-panels \
  --pdfs /Users/you/Downloads/vector-pdfs
```

`--pdfs` is a folder of `{slug}.pdf` files. Prefer unmarked elevation PDFs. If a file still has Bluebeam annotations, the server strips `/Annots` before storage and the frontend renders with annotations disabled.

Jobs start in **Original**. Matching is by filename stem = COCO job slug.

## Stages

| Stage | Who | Meaning |
|---|---|---|
| **Original** | first pass | still being cleaned |
| **In review** | anyone | second look; still editable |
| **Complete** | anyone | read-only until sent back |

**Open next original** / **Open next in review** in the inbox. Opening a sheet holds it until you leave; another user sees who has it and cannot open it.

## Tags

Jobs can have free-form tags (building, market, QC notes, and so on). In the inbox Tags column or the job header, type a name and press Enter to create it, or pick an existing name from the list that appears as you type. Click × on a pill to remove it from that job. Unused names leave the shared catalog. Filter the inbox with the Tags chips (jobs that have any of the selected tags).

## Cleaning process

1. Run `cmd/ingest` (COCO, then vector PDFs, linked by slug).
2. Claim an Original job. The canvas is the **vector PDF**, opened fit to the whole sheet. Use **Snap all** on Box Edits to pull imported boxes onto linework.
3. Work the three steps in order — **black out** the markups, **box edit** the geometry, **label fix** the classes — then send to review or mark complete.
4. Anyone can reopen a complete sheet back to review or original.

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
2. Convert each COCO `segmentation` ring (fallback: bbox → 4-gon) px → PDF pt via 75 DPI.
3. Overlay on a PDF.js render of the **vector** PDF.
4. Bake snap with the **displayed** raster size.
5. Persist edits as `polygon_pt` (keep the original 75 DPI polygon on version 0).

## Snap and blackout

Ported from `takeoff-services/apps/review-ui`:

- Snap priority: `endpoint → intersection → midpoint → perpendicular → nearest → ortho → parallel`
- Box magnets: `snapRectEdges` / `snapMoveRect` / `snapResizeEdges` (10 px capture, 13 px release, Alt bypass)
- One-shot `snapModelBoxes` from **Snap all** on Box Edits (not on first open)
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

Link the dataset while the API is running (prefer `cmd/ingest` over the inbox):

```bash
go run ./cmd/ingest \
  --api http://localhost:8080 \
  --token dev \
  --coco /Users/you/Downloads/coco-redacted-good-jobs-louvers-metal-panels \
  --pdfs /Users/you/Downloads/vector-pdfs
```

## Markup

Correcting a sheet runs in three ordered steps, picked from the step bar (`[` and `]` to move between them). Each step exposes only its own tools, so geometry cannot drift while labelling and the snap engine stays out of the way while redacting.

**1 · Black out** — drag to cover the takeoff markups so the shapes underneath are judged on their own. Regions are [0,1] page fractions and save as you draw. **Snapping is off in this step**: these are throwaway rectangles, not measurements.

**2 · Box edit** — the only step where geometry is editable.

- **Select (S)** — click a shape; Delete removes it
- **Draw (R)** — click vertices to build a polygon (Enter / click first point to close), or drag a quad
- **Move / vertex / edge** — drag the interior, a vertex (point snap), or an edge (line snap)
- **Box → polygon** — on the selected shape, drag a hollow **midpoint handle** to split that edge into a new vertex, or **double-click an edge** to add one. **Double-click a vertex** to remove it (a shape never drops below 3)
- **Snap all** — one-shot magnet for unedited imported boxes
- **Edges / Points** — toggle edge magnets vs corner magnets
- **Alt** — bypass snap for one drag

**3 · Label fix** — geometry is locked. Click a shape and pick a class, or press `1–9`.

Always available:

- **View** — a sheet always opens **fit to the page**, not at 100%. `Fit` / `−` / `+` / `100%` sit bottom-right of the canvas; the wheel zooms toward the cursor
- **Pan** — drag empty canvas, Space-drag, or middle-mouse
- **Save** — writes a new annotation version (blackouts save on their own)
- **Revert** — copies an older version forward

## Export

**Export COCO** downloads a cleaned `_annotations.coco.json` per job. Polygons are written back in **75 DPI pixel space** (`px = pt * 75 / 72`) as `segmentation` rings plus a derived `bbox`.

## Deploy

This repo is a monorepo. Collector paths:

| Service | Path |
|---|---|
| Frontend (Vercel) | `TakeoffDetectionCollector/frontend` |
| Backend (Railway) | `TakeoffDetectionCollector/backend` |
| Migrations | `TakeoffDetectionCollector/supabase/migrations` |

Copy values from the Supabase dashboard (Settings → API / Database). Never commit `.env` files.

### 1. Supabase

1. New project (not the takeoff-services prod project)
2. SQL editor: run every file in `supabase/migrations/` in order (`001` through `008`)
3. Storage: create **private** buckets `pdfs`, `coco`, `annotations`, `rasters`, `vectors`
4. Authentication → Providers → Azure (Microsoft). Redirect URLs:
   - `http://localhost:5173/auth/callback`
   - `https://<your-app>.vercel.app/auth/callback` (add this after Vercel exists)
5. Restrict to `@reflectionwindow.com` in Entra, or leave the API `ALLOWED_EMAIL_DOMAIN` gate as the check

Grab these from **Settings → API**:

- Project URL → `SUPABASE_URL` / `VITE_SUPABASE_URL`
- `anon` `public` key → `SUPABASE_ANON_KEY` / `VITE_SUPABASE_ANON_KEY`
- `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (Railway only)
- JWT secret (legacy HS256) → `SUPABASE_JWT_SECRET` (Railway only; new projects also verify via JWKS at `SUPABASE_URL`)

**Settings → Database → Connection string** (use the **Session pooler**, port `5432`, `sslmode=require`) → `SUPABASE_DB_URL`. Direct `db.<ref>.supabase.co` is IPv6-only and fails on Railway.

### 2. Railway (backend)

Project shape is [`.railway/railway.ts`](../.railway/railway.ts) (Infrastructure as Code). `railway.toml` is gone.

1. [railway.com/new](https://railway.com/new) → empty project (or **Deploy from GitHub** once, then switch ownership to IaC)
2. From the repo root:

```bash
npm install
railway login
railway link
railway config plan
railway config apply
```

3. If a leftover **Config file path** still points at `railway.toml`, clear it on the service. A service cannot be managed by both toml and IaC.
4. Settings → Networking → **Generate domain**. Copy it, no trailing slash.
5. Variables that are **not** in `.railway/railway.ts` (set in the dashboard; do not commit them):

| Name | Value |
|---|---|
| `CORS_ORIGINS` | `https://<your-app>.vercel.app,https://*.vercel.app` |
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | anon key |
| `SUPABASE_JWT_SECRET` | JWT secret |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role (server only) |
| `SUPABASE_DB_URL` | Session pooler URI |

Do **not** set `DEV_AUTH` or `PORT`. Domain, healthcheck `/health`, Dockerfile, watch path `TakeoffDetectionCollector/backend/**`, and Wait for CI (`checkSuites`) are in the TypeScript file.

Dockerfile `CMD` is `/app/collector`. Allow uploads ≥ 200 MB. Hit `https://<railway>/health` — you want `"ok": true`, `"store": "postgres"`, `"dev_auth": false`.

### 3. Vercel (frontend)

1. [vercel.com/new](https://vercel.com/new) → import this GitHub repo
2. **Root Directory:** `TakeoffDetectionCollector/frontend`
3. Framework: **Vite**. Build `npm run build`, output `dist`
4. Environment Variables — add for **Production, Preview, and Development**:

| Name | Value |
|---|---|
| `VITE_API_URL` | Railway URL, no trailing slash |
| `VITE_SUPABASE_URL` | Same as backend |
| `VITE_SUPABASE_ANON_KEY` | anon key |

`VITE_*` are baked in at **build** time. Changing them requires **Redeploy**.

5. Deploy. Copy the production URL.
6. Back in Railway, set `CORS_ORIGINS` to that exact origin (keep `https://*.vercel.app` if you want PR previews)
7. Back in Supabase Auth, add `https://<app>.vercel.app/auth/callback`

`vercel.json` skips a build when the commit did not touch `frontend/`.

### 4. CI/CD (auto-redeploy)

GitHub Actions:

- `.github/workflows/ci.yml` (**Collector**) — PR / push to `main` that touches `TakeoffDetectionCollector/` → Go tests (Docker image is a non-blocking smoke check) and frontend tests. On `main`, Vercel production follows a green frontend job; `railway up` follows a green backend job **if** the secrets below are set. Railway Git still deploys the API.
- `.github/workflows/railway-config.yml` (**Railway config**) — PRs that change `.railway/` get a plan comment; merging applies that plan (`RAILWAY_TOKEN`).

**Day one (no extra tokens):** connecting GitHub in the Vercel dashboard plus `railway config apply` after `railway link` is enough. Push to `main` rebuilds the service whose files changed.

**Gated deploys (tests must pass first):** add these GitHub repo secrets. `RAILWAY_TOKEN` is also what `.github/workflows/railway-config.yml` uses to plan/apply `.railway/railway.ts` on PRs. Vercel Git should stay **on** so a push to `main` shows up in the Vercel dashboard; the Collector workflow also deploys production after a green frontend job. Leave Railway Git connected — the TypeScript file owns the GitHub source and watch paths.

| Secret | Where |
|---|---|
| `VERCEL_TOKEN` | [vercel.com/account/tokens](https://vercel.com/account/tokens) — scope **RWW → takeoff-detection-collector** (project, not Full Account) |
| `VERCEL_ORG_ID` | `TakeoffDetectionCollector/frontend/.vercel/project.json` → `orgId` after `npx vercel link` in `frontend/` |
| `VERCEL_PROJECT_ID` | same file → `projectId` |
| `RAILWAY_TOKEN` | Railway project → Settings → Tokens (**project** token, not an account token) |
| `RAILWAY_SERVICE_ID` | Railway service → Settings → ID (optional if the project has one service) |

```bash
cd TakeoffDetectionCollector/frontend
npx vercel login
npx vercel link   # then open .vercel/project.json
```

After that, every green **Collector** run on `main` redeploys. Manual ship: GitHub → Actions → **Collector** → Run workflow.

## API (v1)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness |
| GET | `/v1/me` | current user |
| POST | `/v1/auth/dev` | local-only session |
| POST | `/v1/auth/supabase` | verify Microsoft JWT |
| GET | `/v1/jobs` | inbox (`?stage=`) |
| POST | `/v1/jobs/next` | claim next original or `?stage=corrected` |
| GET | `/v1/jobs/:id` | job + pages |
| POST | `/v1/jobs/:id/claim` | exclusive lock |
| POST | `/v1/jobs/:id/heartbeat` | extend lock |
| POST | `/v1/jobs/:id/release` | drop lock |
| POST | `/v1/jobs/:id/stage` | original → corrected → complete |
| GET | `/v1/tags` | shared tag catalog |
| PUT | `/v1/jobs/:id/tags` | replace the job's tags (creates missing names) |
| POST | `/v1/imports/coco` | zip or `dir=` |
| POST | `/v1/imports/pdfs` | `{slug}.pdf` files or `dir=` (annots stripped) |
| POST | `/v1/jobs/:id/pdf` | attach one vector PDF |
| GET | `/v1/jobs/:id/pages/:n/annotations` | latest boxes |
| POST | `/v1/jobs/:id/pages/:n/annotations` | new version |
| POST | `/v1/jobs/:id/pages/:n/revert` | copy old version forward |
| GET | `/v1/jobs/:id/pages/:n/vectors` | snap geometry |
| PUT | `/v1/jobs/:id/pages/:n/blackouts` | [0,1] regions |
| GET | `/v1/jobs/:id/export/coco` | cleaned COCO |

## Out of scope for v1

- Sharing this DB with takeoff-services production
- Live multi-user CRDT on one page (exclusive claim + last-write-wins if the lock expires)
- Training / YOLO in this repo (export only)
- Scanned / raster-only PDFs (no snap; freehand only)
