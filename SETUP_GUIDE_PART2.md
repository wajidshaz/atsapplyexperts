# Setup Guide — Part 2: Admin Login, JobSpy & DeepSeek

This continues from `SETUP_GUIDE.md` (Part 1: Node backend, Neon DB, schema).
Do Part 1 first — you need the database running and `/health` responding.

Three things here:
- **A.** Admin (Wajid Khosa) password login — stored securely (hashed)
- **B.** JobSpy job-extraction micro-service (Python) + wiring to the Node backend
- **C.** DeepSeek for scoring (you supply the key)

---

## A — Admin login (Wajid Khosa)

The admin logs in with a **name + password**, exactly as you wanted. The password
is stored as a **bcrypt hash**, never as plain text — Wajid still just types his
password and clicks Login.

### A1. Install the password library
```bash
cd ats-apply-experts/backend
npm install            # bcryptjs is now in package.json
```

### A2. Re-load the schema (adds the password column)
The users table now has a `password_hash` column. If your DB is fresh, the Part 1
load already includes it. If you loaded the schema before this update, run:
```bash
psql "$DATABASE_URL" -c "ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;"
```

### A3. Create Wajid's admin account
Pick a password (I strongly suggest something stronger than 1234 for a live admin,
but it's your choice). Run:
```bash
ADMIN_NAME="Wajid Khosa" ADMIN_EMAIL="wajid@ats.com" ADMIN_PASSWORD="your-password" \
  node src/jobs/seed-admin.js
```
You'll see: `Admin ready: { ... role: 'admin' }`.

### A4. Test the login endpoint
```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"Wajid Khosa","password":"your-password"}'
```
✅ **Done when:** it returns Wajid's user object (no password field). A wrong
password returns `{"error":"Invalid credentials"}`.

> On the login screen, choosing **Admin** or **Applier** shows the name+password
> form; choosing **Candidate** shows Google sign-in. When we wire the frontend to
> the API (Part 1, Step 10), the Login button will call `/api/auth/login`.

---

## B — JobSpy job-extraction micro-service

JobSpy runs as its own small **Python service**. The Node backend calls it over
HTTP. This keeps Python isolated and lets the scraper use JobSpy alongside the
Greenhouse/Lever/Ashby/Workable connectors.

### B1. Start the Python service
```bash
cd jobspy-service
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
python app.py                   # http://127.0.0.1:8000
```
Check:
```bash
curl http://127.0.0.1:8000/health
# {"ok": true, "jobspy_installed": true, "error": null}
```

### B2. Test a real extraction
```bash
curl -X POST http://127.0.0.1:8000/scrape \
  -H "Content-Type: application/json" \
  -d '{"site_name":["indeed"],"search_term":"frontend engineer","location":"United States","results_wanted":15,"hours_old":72,"country_indeed":"USA"}'
```
✅ **Done when:** you get `{"count": N, "jobs": [...]}` with real listings.
Start with `indeed` — it's the most reliable. Add `"linkedin"` later (it rate-limits;
you may need proxies).

### B3. Turn JobSpy on in the Node backend
Add to `ats-apply-experts/backend/.env`:
```ini
JOBSPY_ENABLED=true
JOBSPY_URL=http://127.0.0.1:8000
JOBSPY_SITES=indeed,linkedin
JOBSPY_RESULTS=50
JOBSPY_HOURS=72
JOBSPY_COUNTRY=USA
# JOBSPY_PROXIES=user:pass@host:port,user:pass@host:port   # optional, for LinkedIn
```

### B4. Run the full scraper (connectors + JobSpy together)
With both the Python service AND the Node backend running:
```bash
cd ats-apply-experts/backend
node src/jobs/run-scraper-once.js
```
✅ **Done when:** the summary shows jobs inserted, and the jobs table has rows
from both the company connectors and JobSpy:
```bash
psql "$DATABASE_URL" -c "SELECT source, count(*) FROM jobs GROUP BY source;"
```

> ⚠️ Honest reminders: LinkedIn rate-limits (~10th page) — keep `JOBSPY_RESULTS`
> modest or add proxies. Indeed is the most reliable. If a board stops returning
> data, update JobSpy: `pip install -U python-jobspy` inside the venv.

---

## C — DeepSeek (scoring & summaries)

1. Get an API key at **platform.deepseek.com**.
2. Put it in `backend/.env`: `DEEPSEEK_API_KEY=sk-...`
3. Tell me when it's in — I'll wire the matching service so each scraped job is
   scored 0–100 against the client's resume and gets a plain-English summary.

✅ **Done when:** the key is in `.env`. (Code wiring is my step.)

---

## Order to run things (every day / on demand)

1. Start the **Python JobSpy service** (`python app.py`).
2. Start the **Node backend** (`npm run dev`).
3. The scraper (manual `run-scraper-once.js` or the daily scheduler) pulls from
   connectors + JobSpy → saves jobs → (DeepSeek scores them) → batches are built.
4. Admins/clients approve from the **Jobs board**; appliers work the **Pipeline**;
   the **Live board** shows applied vs not-applied.

---

## What I need from you next

| Part | You do | I do |
|---|---|---|
| A | `npm install`, run seed-admin, test login | (built) |
| B | Start Python service, test, set env | (built — tell me any errors) |
| C | Get DeepSeek key into `.env` | Wire scoring |
| — | — | Wire frontend Login + Jobs to the real API |

Do **A** and **B** first. When Wajid can log in via the API and the scraper inserts
JobSpy jobs, tell me — then we do DeepSeek (C) and connect the frontend. Paste any
exact error and I'll fix it. I won't assume — ask me anything.
