# Architecture

> **Docs index:** [API.md](API.md) · [DATA_MODEL.md](DATA_MODEL.md) · [ENV.md](ENV.md) · [RUNBOOK.md](RUNBOOK.md) · [AI.md](AI.md) · [GMAIL.md](GMAIL.md) · [SCRAPER.md](SCRAPER.md) · [EXTERNAL_ACTIONS.md](EXTERNAL_ACTIONS.md)

> **Auth:** the API is fully authenticated. Staff log in with password→JWT; candidates via server-side Google OAuth→JWT. Every route enforces role/ownership from the verified token (`middleware/auth.js`). CORS is locked to `APP_URL`; auth + scraper endpoints are rate-limited. AI is **OpenRouter** (not Kimi).

## System diagram (text)

```
                          ┌──────────────────────────────────────────┐
                          │                CLIENTS                     │
                          │  Candidate UI   Admin UI   Applier UI      │
                          │        (Next.js / static prototype)        │
                          └───────────────────┬────────────────────────┘
                                              │ HTTPS / REST (/api)
                                              ▼
                          ┌──────────────────────────────────────────┐
                          │            NODE / EXPRESS API              │
                          │  auth · candidates · jobs · batches ·      │
                          │  admin · employees · reports               │
                          └───┬───────────┬───────────┬───────────┬────┘
                              │           │           │           │
                  ┌───────────▼──┐  ┌─────▼─────┐ ┌───▼──────┐ ┌──▼────────┐
                  │ PostgreSQL   │  │OpenRouter │ │ Google   │ │  Gmail    │
                  │ (source of   │  │ AI (sugg- │ │ Sheets   │ │  send +   │
                  │  truth)      │  │ est only) │ │ API      │ │ read scan │
                  └───────▲──────┘  └─────▲─────┘ └────▲─────┘ └────▲──────┘
                          │               │            │            │
                          │        ┌──────┴────────────┴────────────┴──────┐
                          └────────┤        SCHEDULER (node-cron worker)    │
                                   │  8:00 scrape · 8:30 match · 15:30 report│
                                   └──────────────────┬──────────────────────┘
                                                      │
                                              ┌───────▼────────┐
                                              │  Job sources   │
                                              │ (LinkedIn etc) │
                                              └────────────────┘
```

## Data flow (one day)

```
SCRAPER ──writes──▶ jobs
   │
OpenRouter.matchJob ──writes──▶ job_matches (score, recommendation)   [AI suggests]
OpenRouter.simplifyJob ──writes──▶ jobs.ai_summary                    [AI suggests]
   │
SCHEDULER ──builds──▶ batches (Batch 1 = 10) + batch_items + approvals (pending)
   │
MAILER + notifications ──▶ candidate: "Batch 1 ready"
   │
CANDIDATE ──updates──▶ approvals.decision (approved / rejected)
   │
SUBMIT ──creates──▶ applications (to_do) + Google Sheet (sheet_url)
   │
APPLIER ──updates──▶ applications.status  +  sheet status cell
MAILER + notifications ──▶ candidate: "status updated"
   │
GMAIL READER (every 2h) ──advances──▶ applications.status from recruiter replies
SCHEDULER 9–17/2h ──unlocks──▶ Batch 2 (35) once Batch 1 submitted
SCHEDULER 15:30 ──aggregates──▶ reports (per candidate)
```

## Key principle: AI suggests, humans/scheduler act

The OpenRouter service (`services/openrouter.js`) returns plain data (scores,
summaries, recommendations). It never writes to the database, sends email, or
submits an application. Side effects happen only in:
- `jobs/scheduler.js` (writes matches, batches, reports; unlocks batch 2)
- route handlers triggered by a human action (approve, submit, status update)
- `services/gmail-reader.js` (advances status from recruiter replies — read-only inbox)

## Scaling notes

- Matching is the heavy step: run it per-candidate in a queue (BullMQ/Redis), not inline, so 8:30 fan-out parallelises.
- `job_matches` and `applications` are the hot tables — indexed on (candidate_id, score) and (employee_id, status).
- Stateless API → scale horizontally behind a load balancer; the scheduler stays a single worker to avoid duplicate cron runs (or use a leader lock).
```
