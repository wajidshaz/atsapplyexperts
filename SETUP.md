# ATS Apply Experts — Backend Setup Guide

This guide gets the backend API running on your own machine (or a server), connects it
to a database, and serves the frontend. Follow it top to bottom.

There are two parts:
1. **Backend** — a Node.js + Express API (the `backend/` folder).
2. **Database** — PostgreSQL, created from `database/schema.sql`.
3. **Frontend** — the single `frontend/index.html` file. It is a static page; once the
   backend is live you point its API calls at it.

---

## 0. What you need to install first

| Tool | Why | Check it's installed |
|------|-----|----------------------|
| **Node.js 18+** | runs the backend | `node -v` |
| **PostgreSQL 14+** | the database | `psql --version` |
| **Git** (optional) | to clone/deploy | `git --version` |

- Node.js: https://nodejs.org (download the LTS version).
- PostgreSQL: https://www.postgresql.org/download/ (or use a hosted DB — see Step 5 option B).

---

## 1. Get the code onto your machine

Unzip the project. You'll have this structure:

```
ats-apply-experts/
├── backend/            <- the API
│   ├── src/
│   ├── package.json
│   └── .env.example
├── database/
│   └── schema.sql      <- creates all tables
├── frontend/
│   └── index.html      <- the app UI
├── docs/
├── README.md
└── SETUP.md            <- this file
```

Open a terminal **inside the `backend` folder**:

```bash
cd ats-apply-experts/backend
```

---

## 2. Install the backend dependencies

```bash
npm install
```

This reads `package.json` and downloads Express, the Postgres driver (`pg`),
`node-cron` (the daily scheduler), `googleapis` (Sheets/Gmail), and `dotenv`.

---

## 3. Create the database

Create an empty Postgres database and a user. Run `psql` (the Postgres shell):

```bash
# open the postgres shell as the default superuser
psql postgres
```

Inside the `psql` prompt, paste:

```sql
CREATE DATABASE ats_apply;
CREATE USER ats_user WITH PASSWORD 'change_this_password';
GRANT ALL PRIVILEGES ON DATABASE ats_apply TO ats_user;
\q
```

Now load the schema (this creates every table — users, jobs, approvals, resumes,
candidate_profiles, messages, etc.):

```bash
psql "postgres://ats_user:change_this_password@localhost:5432/ats_apply" -f ../database/schema.sql
```

If it runs with no errors, your tables exist. (You can verify with
`psql "<connection-string>" -c "\dt"` — it should list ~15 tables.)

---

## 4. Configure environment variables

Copy the example file and edit it:

```bash
cp .env.example .env
```

Open `.env` and fill it in. **Minimum to boot the server:**

```bash
PORT=4000
DATABASE_URL=postgres://ats_user:change_this_password@localhost:5432/ats_apply
```

The rest are only needed when you turn on that specific feature:

| Variable | Needed for | If you skip it |
|----------|-----------|----------------|
| `DATABASE_URL` | everything | **required** |
| `KIMI_API_KEY`, `KIMI_API_URL`, `KIMI_MODEL` | AI job matching & summaries | matching returns empty; app still runs |
| `GOOGLE_SERVICE_ACCOUNT` | Google Sheets job sheet | sheet sync off |
| `GMAIL_*` | sending invite / notification emails | emails are no-ops (logged, not sent) |
| `SCRAPER_SOURCES` | which boards to scrape | defaults to `linkedin,indeed` |
| `APP_URL` | invite links in emails | falls back to a placeholder URL |

You can launch with just the first two and add the others later.

---

## 5. Start the backend

### Option A — local Postgres (what you set up in Step 3)

```bash
npm run dev      # auto-restarts on file changes (development)
# or
npm start        # plain run (production)
```

You should see:

```
ATS Apply Experts API on :4000
```

Test it's alive — in another terminal:

```bash
curl http://localhost:4000/health
# -> {"ok":true,"service":"ats-apply-experts-api"}
```

### Option B — hosted database (no local Postgres)

If you'd rather not install Postgres locally, create a free/managed database on
**Neon**, **Supabase**, **Railway**, or **Render**. They give you a `DATABASE_URL`
string — paste it into `.env`, then run the schema load from Step 3 against that URL,
and `npm start`. Everything else is identical.

---

## 6. Connect the frontend to the backend

Right now `frontend/index.html` runs as a self-contained demo (data lives in the
browser). To make it talk to your live API, you add a small base URL and replace the
demo actions with `fetch()` calls. The endpoints are all listed in `README.md`. Example:

```js
const API = "http://localhost:4000/api";

// load the jobs board with filters
const res = await fetch(`${API}/jobs?search=react&type=Full-time&min_score=80`);
const jobs = await res.json();

// approve a job from the board -> flows to the applier
await fetch(`${API}/jobs/123/approve`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ candidate_id: "<uuid>", approved_by_role: "client" }),
});
```

Serve the frontend as a static file (any static host works). Quick local option:

```bash
# from the frontend folder
npx serve .        # or: python3 -m http.server 5500
```

Then open the printed URL (e.g. http://localhost:5500).

> **CORS note:** the API already enables CORS for all origins (`app.use(cors())`),
> so the browser can call it from a different port during development.

---

## 7. Turn on the daily automation (optional)

The scheduler runs the morning scrape, AI matching, batch building, and the afternoon
report. Run it as a separate process:

```bash
npm run scheduler
```

It prints: `Scheduler running: 8:00 scrape · 8:30 match · 15:30 report`.
Times are server-local. On a server you'd keep this alive with `pm2` or a systemd
service (see Step 8).

---

## 8. Deploying to a server (when you're ready)

A simple, reliable setup:

1. Put the code on a Linux server (DigitalOcean, Render, Railway, a VPS, etc.).
2. Provision a managed Postgres and load `schema.sql` into it.
3. Set the same `.env` values on the server (use the host's secrets/env settings).
4. Run the API with a process manager so it restarts on crash/reboot:
   ```bash
   npm install -g pm2
   pm2 start src/app.js --name ats-api
   pm2 start src/jobs/scheduler.js --name ats-scheduler
   pm2 save
   ```
5. Put **Nginx** (or the host's built-in proxy) in front, with HTTPS, forwarding to
   `localhost:4000`. Serve `frontend/index.html` from the same domain to avoid CORS.

---

## 9. Wiring the real integrations (later, one at a time)

The code has clearly-marked stubs so the app runs before these are connected:

- **Scraper** (`src/services/scraper.js`) — `fetchSource()` returns `[]` until you add
  real LinkedIn/Indeed API or provider calls. It already accepts the candidate's job
  titles and work location to target the search.
- **AI matching** (`src/services/kimi.js`) — point `KIMI_*` at Moonshot (or swap for
  another model). Used by the scheduler for scores and summaries.
- **Email** (`src/services/mailer.js`) — fill the `GMAIL_*` vars to actually send
  invites/notifications; until then they're logged, not sent. (No passwords are ever
  stored — sign-in is Google OAuth.)
- **Google Sheets** (`src/services/sheets.js`) — add `GOOGLE_SERVICE_ACCOUNT` to sync
  the applier's job sheet.
- **File storage for resumes** — resume upload/download expects an object store
  (S3/GCS). Store files there and keep the URL in the `resumes` table; the employer
  download endpoint already gates on `master_status = 'approved'`.

---

## Quick reference — common commands

```bash
npm install            # install dependencies (run once)
npm run dev            # start API with auto-reload
npm start              # start API (production)
npm run scheduler      # start the daily cron jobs
npm run migrate        # (re)load schema.sql into $DATABASE_URL

curl localhost:4000/health     # is the API up?
psql "<DATABASE_URL>" -c "\dt" # list tables
```

## Troubleshooting

- **`ECONNREFUSED ...:5432`** → Postgres isn't running, or `DATABASE_URL` is wrong.
- **`password authentication failed`** → the user/password in `DATABASE_URL` doesn't
  match what you created in Step 3.
- **`relation "users" does not exist`** → you didn't load `schema.sql` (Step 3).
- **Port already in use** → change `PORT` in `.env`, or stop the other process.
- **Frontend can't reach API** → check the API is on :4000, and that you used the full
  `http://localhost:4000/api/...` path.
