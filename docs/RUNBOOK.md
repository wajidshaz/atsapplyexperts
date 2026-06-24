# Runbook — running everything locally

## Prerequisites
- Node.js 18+ (developed on v24).
- A Postgres database (Neon) reachable via `DATABASE_URL`.
- (Optional) Python 3.10+ for the JobSpy microservice.

## 1. Backend API
```powershell
cd backend
npm install
# create .env from .env.example and fill DATABASE_URL, JWT_SECRET, CREDENTIAL_ENC_KEY, etc.
npm run migrate        # loads ../database/schema.sql into the DB
node src/jobs/seed-admin.js   # creates the first admin from ADMIN_* env vars
npm run dev            # API on http://localhost:4000  (GET /health → {ok:true})
```

## 2. Scheduler (separate process)
The daily pipeline runs as its own always-on worker:
```powershell
cd backend
npm run scheduler
```
Cron jobs (server-local time):
- **08:00** — scrape fresh jobs (`runScraper`)
- **08:30** — AI match + build Batch 1 (10) per candidate, notify
- **09:00–17:00 every 2h** — unlock Batch 2 (35) for submitted candidates + scan Gmail for recruiter replies
- **15:30** — generate daily reports

Each step is also exported for manual runs (e.g. `runDailyMatch`, `unlockBatch2`, `runGmailReplyScan`).

## 3. JobSpy microservice (optional)
```powershell
cd jobspy-service
pip install -r requirements.txt
python app.py          # serves http://127.0.0.1:8000  (/health, POST /scrape)
```
Then set `JOBSPY_ENABLED=true` (and `JOBSPY_URL`) in the backend `.env`.

## 4. Frontend
`frontend/index.html` is a static page. Serve it on `APP_URL` (e.g. a static dev server on `:5173`) so CORS matches. Open it in a browser and sign in.

## 5. Tests
```powershell
cd backend
npm test               # node:test + supertest — auth, RBAC, crypto, validation
```
These do not require a database (the auth/role layer short-circuits before any query).

## Daily pipeline order (data flow)
scrape → AI score (`job_matches`) → Batch 1 (`batches`/`batch_items`/`approvals`) → candidate approves → submit (`applications` + Google Sheet) → applier updates status → Gmail reply scan advances status → reports.
