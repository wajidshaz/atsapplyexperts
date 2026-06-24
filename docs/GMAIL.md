# Gmail Integration

There are **two** distinct Gmail uses. Keep them straight.

## 1. Sending (company account) — `backend/src/services/mailer.js`
- Sends from a single account (`GMAIL_SENDER`, default `atsapplyexperts@gmail.com`) via the Gmail API using `GMAIL_REFRESH_TOKEN`.
- Templated triggers: `jobsReady`, `batchReady`, `statusUpdate`, `invite`.
- Scope used: `gmail.send` (no passwords stored — OAuth tokens only).

## 2. Reading (per-client inbox) — `backend/src/services/gmail-reader.js`
- **Purpose:** track recruiter replies / interview invites and advance application status automatically.
- **Consent:** each candidate grants `gmail.readonly` **to their own inbox** during Google sign-in. The refresh token is stored in `users.email_read_token`, and `users.email_scope_granted` is set true.
- **Cadence:** scanned every 2 hours, 09:00–17:00 (scheduler cron), and on-demand via `runGmailReplyScan()`.
- **What is read:** recent messages (`newer_than:2d`, ≤25), and only the `From` + `Subject` headers plus the snippet. Full bodies are **not** read or stored.
- **What is stored:** only the resulting `applications.status` change and a short notification (status + subject). No email content is persisted.
- **Classification (heuristic, conservative):**
  - offer keywords → `offer`
  - rejection keywords → `rejected`
  - interview keywords → `interview`
  - Matched to an application by the job's company name appearing in the subject/snippet/sender. Status only ever moves **forward** (never downgrades a real offer).
- **Honesty:** matching is heuristic and best-effort. One inbox failing never aborts the rest; failures are logged, not hidden.

## Scope summary (owner confirmed: read **and** send)
- Company account: `gmail.send`.
- Per-client: `gmail.readonly`.
- We never send mail on a client's behalf with their token.
