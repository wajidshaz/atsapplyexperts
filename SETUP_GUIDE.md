# ATS Apply Experts — Backend & Scraper Setup Guide

This guide takes you from the code you have now to a running backend with a working
job scraper. Follow it top to bottom. Each step says exactly what to do and how to
check it worked before moving on. If a step fails, stop there and tell me the error.

> Decisions locked in for this build:
> - Backend: **Node.js + Express** (already built)
> - Database: **Neon** (managed Postgres) — recommended
> - Login: **your Google OAuth credentials**
> - File storage: **server disk** (for now)
> - Job listings: **your own scraper** via provider connectors
>   (Greenhouse, Lever, Ashby, Workable, + best-effort Workday)
> - AI scoring: **DeepSeek** (added at Step 6, you'll supply the key then)

---

## Step 0 — Install the tools (one-time, on your computer)

You need three things installed. Check each with the command shown.

1. **Node.js 18 or newer** — runs the backend.
   - Check: `node -v`  → should print v18.x or higher.
   - If missing: install the LTS version from nodejs.org.

2. **Git** (to manage the code). Check: `git --version`.

3. **psql** (Postgres command-line client, to load the database schema).
   - Check: `psql --version`.
   - If missing: install the PostgreSQL client tools for your OS.

✅ **Done when:** all three commands print a version.

---

## Step 1 — Get the code running locally (no DB yet)

1. Unzip the project. In a terminal:
   ```bash
   cd ats-apply-experts/backend
   npm install
   ```
2. This installs the dependencies (express, pg, googleapis, node-cron, etc.).

✅ **Done when:** `npm install` finishes with no red errors and a `node_modules`
folder appears.

---

## Step 2 — Create the database on Neon

1. Go to **neon.tech** and sign up (free tier is fine to start).
2. Click **Create project**. Pick a name (e.g. "ats-apply-experts") and a region
   close to you. Leave the Postgres version at the default.
3. After it creates, Neon shows a **connection string** that looks like:
   ```
   postgresql://USER:PASSWORD@ep-xxxx.region.aws.neon.tech/dbname?sslmode=require
   ```
   Copy it — you'll need it in the next step. Keep it secret (it's a password).

✅ **Done when:** you have the connection string copied.

---

## Step 3 — Configure the backend's environment

1. In `ats-apply-experts/backend`, create a file named **`.env`** (note the dot).
2. Paste this in and fill the values:
   ```ini
   # Database (from Neon, Step 2)
   DATABASE_URL=postgresql://USER:PASSWORD@ep-xxxx.region.aws.neon.tech/dbname?sslmode=require

   # Server
   PORT=4000
   APP_URL=http://localhost:5173

   # Google OAuth (your existing credentials)
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-client-secret

   # File storage (server disk for now)
   UPLOAD_DIR=./uploads

   # DeepSeek (leave blank until Step 6)
   DEEPSEEK_API_KEY=
   ```
3. **Never commit `.env` to Git.** Confirm `.gitignore` contains a line `.env`
   (add it if not).

✅ **Done when:** `.env` exists with at least `DATABASE_URL` filled.

---

## Step 4 — Load the database schema

This creates all the tables (users, jobs, applications, messages, etc.).

1. From `ats-apply-experts/backend`, run:
   ```bash
   psql "$DATABASE_URL" -f ../database/schema.sql
   ```
   (On Windows PowerShell, replace `$DATABASE_URL` with the actual string in quotes.)
2. You should see a series of `CREATE TABLE` / `CREATE TYPE` messages.

✅ **Done when:** no errors, and this prints your tables:
   ```bash
   psql "$DATABASE_URL" -c "\dt"
   ```

---

## Step 5 — Start the backend and confirm it's alive

1. Run:
   ```bash
   npm run dev
   ```
2. You should see: `ATS Apply Experts API on :4000`.
3. In a browser or another terminal:
   ```bash
   curl http://localhost:4000/health
   ```
   It should return `{"ok":true,"service":"ats-apply-experts-api"}`.

✅ **Done when:** /health responds and the server didn't crash on the DB connection.
If it crashes here, the DATABASE_URL is wrong — tell me the exact error.

---

## Step 6 — Add DeepSeek (AI scoring & summaries)

1. Go to **platform.deepseek.com**, sign up, and create an **API key**.
2. Put it in `.env`:  `DEEPSEEK_API_KEY=sk-...`
3. Tell me when the key is in place — I'll wire the matching service to call
   DeepSeek (score each job 0–100 against the client's resume, write the plain-English
   summary). This is a code step I do; you only supply the key.

✅ **Done when:** the key is in `.env`. (Wiring happens after you confirm.)

---

## Step 7 — Configure the scraper's target companies

The scraper pulls from a list of companies you control, in
`backend/src/services/connectors/companies.js`.

1. Open that file. Each entry looks like:
   ```js
   { provider: 'greenhouse', token: 'stripe', name: 'Stripe' },
   ```
2. **How to find a company's token** (one-time per company):
   - **Greenhouse:** their careers page is `boards.greenhouse.io/<token>` → use `<token>`.
   - **Lever:** `jobs.lever.co/<token>`.
   - **Ashby:** `jobs.ashbyhq.com/<token>`.
   - **Workable:** `apply.workable.com/<token>`.
   - **Workday (best effort):** copy `host`, `tenant`, `site` from the careers URL
     (e.g. `acme.wd1.myworkdayjobs.com/.../External`). Add as:
     ```js
     { provider:'workday', name:'Acme', host:'acme.wd1.myworkdayjobs.com',
       tenant:'acme', site:'External' },
     ```
3. The example tokens in the file are placeholders — **verify each against the real
   careers page** before relying on it. Replace them with companies you actually target.

> ⚠️ Reality check on Workday: it has no clean public feed and some tenants block
> automated calls. The connector tries, but expect some Workday companies to fail —
> that's normal and won't break the run. Greenhouse/Lever/Ashby/Workable are the
> reliable ones.

✅ **Done when:** `companies.js` lists the real companies you want.

---

## Step 8 — Run the scraper manually (first real pull)

1. Add a quick run script. Create `backend/src/jobs/run-scraper-once.js`:
   ```js
   import 'dotenv/config';
   import { runScraper } from '../services/scraper.js';
   const result = await runScraper();
   console.log(JSON.stringify(result, null, 2));
   process.exit(0);
   ```
2. Run it:
   ```bash
   node src/jobs/run-scraper-once.js
   ```
3. You'll get a summary like:
   ```json
   { "fetched": 240, "inserted": 188, "errors": ["Acme (workday): HTTP 403"] }
   ```
   - `fetched` = jobs the connectors returned.
   - `inserted` = new jobs saved (re-runs insert only new ones).
   - `errors` = per-company failures (safe to ignore a few, especially Workday).
4. Confirm rows landed:
   ```bash
   psql "$DATABASE_URL" -c "SELECT source, count(*) FROM jobs GROUP BY source;"
   ```

✅ **Done when:** `inserted` > 0 and the jobs table has rows. If `fetched` is 0,
your tokens are wrong — re-check Step 7. If you see network/timeout errors, tell me.

---

## Step 9 — Schedule the daily run (8 AM automation)

The project already has `node-cron`. A scheduler file ties it together:
the daily scrape → (DeepSeek scoring) → batch creation.

1. Once Step 6 (DeepSeek) is wired, run the scheduler:
   ```bash
   npm run scheduler
   ```
2. It runs the pipeline every morning and can be triggered on demand from the
   admin **Automation** screen (the "Run scraper" button calls the same code,
   with the all-clients / one-client option you built).

✅ **Done when:** the scheduler logs a run at the scheduled time (or when triggered).

---

## Step 10 — Point the frontend at the real API

1. The frontend `index.html` currently uses in-browser demo data. To use the real
   backend, it calls `http://localhost:4000/api/...` instead.
2. I'll do this wiring with you screen by screen (login first, then jobs board,
   then approvals, etc.) so we can test each one as it goes live.

✅ **Done when:** the login screen authenticates against the real backend and a real
job list loads from your database.

---

## What I need from you, and when

| Step | You do | I do |
|---|---|---|
| 0–1 | Install tools, `npm install` | — |
| 2–3 | Make Neon DB, fill `.env` | — |
| 4–5 | Run schema, start server | — |
| 6 | Get DeepSeek key | Wire DeepSeek scoring |
| 7 | List your target companies | — (connectors built) |
| 8 | Run the scraper once | Fix any connector errors you hit |
| 9 | — | Build/confirm the scheduler pipeline |
| 10 | — | Wire frontend to API, screen by screen |

**Start with Steps 0–5.** When `/health` responds and the schema is loaded, tell me —
then we do DeepSeek (6) and the first real scraper run (8) together. If anything errors,
paste the exact message and I'll fix it. I won't assume; ask me anything as you go.
