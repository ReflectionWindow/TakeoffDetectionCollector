# Railway Infrastructure as Code

TypeScript at `.railway/railway.ts` is the project spec. `railway.json` / `railway.toml` are deprecated (hard cutoff 2026-12-01).

```bash
npm install
railway login
railway link
railway config plan
railway config apply
```

Secrets (`SUPABASE_*`, `CORS_ORIGINS`) stay in the Railway dashboard, not this file.

PRs that touch `.railway/` get a plan comment from `.github/workflows/railway-config.yml`. Merging applies that plan. Code deploys still come from the GitHub source on the `collector` service (watch path: `TakeoffDetectionCollector/backend/**`).
