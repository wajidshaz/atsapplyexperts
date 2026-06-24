# ATS Apply Experts — AI + Human Job Application System

A hybrid SaaS platform: AI finds and scores jobs, candidates approve in batches, and trained human appliers submit each application by hand. The AI **only suggests** — it never applies, emails, or changes records on its own.

```
ai-human-job-system/
├── frontend/
│   └── index.html            ← runnable website (landing, login, 3 dashboards)
├── database/
│   └── schema.sql            ← full PostgreSQL schema (run first)
├── backend/
│   ├── package.json
│   ├── .env.example
│   └── src/
│       ├── app.js            ← Express entry, mounts all routes
│       ├── config/db.js      ← Postgres pool
│       ├── routes/           ← auth, candidates, jobs, batches, admin, employees, reports
│       ├── services/         ← kimi (AI), scraper, sheets, mailer
│       └── jobs/scheduler.js ← daily 8:00 / 8:30 / 15:30 cron workflow
└── docs/
    └── ARCHITECTURE.md       ← text architecture diagram + data flow
```

## Quick start

```bash
# 1. database
createdb jobpilot
psql -d jobpilot -f database/schema.sql

# 2. backend
cd backend
cp .env.example .env          # fill in keys
npm install
npm run dev                   # API on :4000
npm run scheduler             # daily cron worker (separate process)

# 3. frontend (no build needed for the prototype)
open ../frontend/index.html   # or serve the folder statically
```

## Roles

| Role | Does |
|------|------|
| Admin | Manage users, assign appliers, control scraper/AI, manage VIP/free, monitor performance |
| Candidate | Upload resume, view AI matches, approve/reject in batches, track applications, view reports |
| Employee (applier) | See assigned candidates, open the Google Sheet job list, apply by hand, update status |

## REST API

Base URL `/api`.

**Auth**
- `POST /auth/oauth` — sign in / register via Google OAuth (stores token + subject, never a password). Also requests **read-only** inbox access (`email_scope_granted`, `email_read_token`) to track recruiter replies — response ratio, interviews. Never used to send mail.
- `GET  /auth/me/:id`

**Candidates**
- `POST /candidates/:id/resume` — upload resume, runs AI analysis
- `GET  /candidates/:id/matches` — AI-scored jobs
- `GET  /candidates/:id/applications` — tracking

**Batches & approvals**
- `GET  /batches/candidate/:id`
- `GET  /batches/:batchId/items`
- `POST /batches/approval/:approvalId` — `{ decision: "approved" | "rejected" }`
- `POST /batches/:batchId/submit` — creates applications + Google Sheet

**Admin**
- `GET   /admin/users`
- `POST  /admin/users` — manually add an applier (employee) or admin, no OAuth needed for staff
- `POST  /admin/clients/invite` — invite a CLIENT by email; account created in 'invited' state, OAuth invite sent, no password stored (flips to 'active' on first Google login)
- `POST  /admin/clients/:id/resend-invite` — resend a pending client invite
- `GET   /admin/live` — live board: counts (approved/applied/responded/not-applied) + per-job applier status
- `POST  /admin/approvals/:approvalId/approve` — **admin override**: when the client has no time to approve, admin approves on their behalf and the job flows to the applier
- `POST  /admin/assign` — applier → candidate
- `PATCH /admin/users/:id/plan` — VIP / free
- `POST  /admin/scraper/run` — re-run scraper
- `POST  /admin/batches/:id/expand` — AI suggests size, admin decides

**Candidates**
- `POST /candidates/:id/resume` — upload resume, runs AI analysis
- `POST /candidates/:id/master-resume` — admin uploads the ATS-optimized master resume, sent to client for approval
- `PATCH /candidates/:id/master-resume` — client approves/rejects the master `{ decision }`
- `GET  /candidates/:id/matches` — AI-scored jobs
- `GET  /candidates/:id/applications` — tracking
- `GET  /candidates/:id/profile` / `PUT /candidates/:id/profile` — intake profile (passwords never returned)

**Jobs board**
- `GET  /jobs` — LinkedIn-style board with filters: `?search=&location=&type=&posted_days=&level=&min_salary=&min_score=&candidate_id=` (match score included when candidate_id is given)
- `GET  /jobs/:id` — single job
- `POST /jobs/:id/approve` — approve a job from the board `{ candidate_id, approved_by_role }`; creates an approval so it flows to the applier

**Employees**
- `GET   /employees/:id/candidates`
- `GET   /employees/resume/:candidateId` — download master resume **only if approved** (returns 423 Locked while pending/rejected)
- `GET   /employees/profile/:candidateId` — full client profile to apply with, **passwords stripped**
- `GET   /employees/:id/sheet/:candidateId`
- `PATCH /employees/applications/:appId` — `{ status: "applied" | "interview" | "rejected" | "offer" }`

**Pipeline (kanban)**
- `GET   /employees/pipeline?candidate_id=` — all applications with their stage (to_do/applied/interview/offer/rejected)
- `PATCH /employees/pipeline/:appId` — move a card to a new stage `{ stage, note? }`

**Reports**
- `GET /reports/candidate/:id`
- `GET /reports/candidate/:id/applications?company=&date=&min_score=&status=` — filtered rows for the Reports screen + PDF export
- `GET /reports/system`

**Messages** (client ↔ admin chat)
- `GET   /messages/threads` — admin: all client threads with last message + unread count
- `GET   /messages/thread/:clientId` — all messages in one client's thread
- `POST  /messages/thread/:clientId` — send a message `{ sender_id, sender_role, body }`
- `PATCH /messages/thread/:clientId/read` — mark incoming messages read `{ reader_role }`

## Daily workflow (scheduler.js)

| Time | Step |
|------|------|
| 8:00 AM | Scraper pulls + dedupes fresh listings into `jobs` |
| 8:30 AM | Kimi scores every candidate × job, writes `job_matches`, builds Batch 1 (10), emails candidates |
| 8:30–9:00 AM | Candidate approves/rejects in their window |
| 9:00 AM–3:00 PM | Appliers submit approved jobs by hand, update status in the sheet (syncs to `applications`) |
| 3:30 PM | Daily reports generated per candidate |

Admin can re-run the scraper, re-run matching, expand batches, and assign appliers at any time.

## Batch system

- Batch 1 = 10 jobs, Batch 2 = 35 jobs (defaults in `batches.target_size`)
- Batch 2 unlocks only after Batch 1 is submitted
- Admin can expand/reduce sizes; Kimi suggests a size from approval behaviour but never changes it itself

## AI engine (Kimi) — see `backend/src/services/kimi.js`

Five suggest-only functions: `matchJob` (0–100 + recommendation), `analyzeResume` (skills + strength), `simplifyJob` (plain-English JD), `recommend`, `suggestBatchSize`. Every prompt is prefixed with a guardrail forbidding the model from claiming to take any action.

## Deployment plan

- Frontend → Vercel (the prototype is static; the production version is a Next.js app on Vercel)
- Backend API → Render / Railway / Fly.io as a Node service
- Scheduler → a separate always-on worker process running `npm run scheduler` (or move crons to the platform's scheduled-jobs feature)
- Database → managed PostgreSQL (Supabase / Neon / RDS) with daily backups
- Secrets → platform env vars (never commit `.env`)
- Files (resumes) → S3 / GCS object storage, signed URLs only
- Email & Sheets → Google OAuth credentials stored as env vars; tokens only, no passwords

## Security notes

- OAuth-only auth; no password storage anywhere
- AI output is advisory data — only the scheduler and human actions write side effects
- Resumes live in object storage, referenced by URL, not in the DB
