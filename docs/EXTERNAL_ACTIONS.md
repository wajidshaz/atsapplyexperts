# External Actions — owner checklist (ordered)

Everything below must be done **outside the code** before go-live. For each: *why* it's needed and *what value* to put back into `backend/.env`.

> ⚠️ Two secrets and one key in your current `.env` are dev values committed to your machine. Rotate the OpenRouter key and regenerate `JWT_SECRET` / `CREDENTIAL_ENC_KEY` for production. The Gmail refresh token currently in `.env` is real — treat it as a live secret.

### 1. Install Node.js (done) + Postgres database
- **Why:** runtime + data store.
- **Do:** create a managed Postgres (Neon recommended). Run `npm run migrate` to load the schema.
- **Provide:** `DATABASE_URL`.

### 2. Generate app secrets
- **Why:** sign sessions and encrypt stored job-board credentials.
- **Do:** `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` and `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
- **Provide:** `JWT_SECRET`, `CREDENTIAL_ENC_KEY` (32 bytes), `JWT_EXPIRES` (optional). **Do not change `CREDENTIAL_ENC_KEY` after data exists** — it can't decrypt old credentials.

### 3. OpenRouter account
- **Why:** all AI (scoring + resume analysis + summaries).
- **Do:** create a key at openrouter.ai/keys. **Rotate the one currently in `.env`** (it was briefly placed in a committed example file).
- **Provide:** `OPENROUTER_API_KEY` (optionally override `OPENROUTER_CHAT_MODEL` / `OPENROUTER_EMBED_MODEL`).

### 4. Google Cloud project + OAuth consent screen
- **Why:** candidate Google sign-in **and** reading each client's inbox for reply tracking.
- **Do:** create a project, configure the OAuth consent screen, request scopes `openid email profile` + `gmail.readonly`. Add an OAuth **Web** client; register the redirect URI used by the frontend. Submit for verification (Gmail scopes are restricted — verification is required before non-test users).
- **Provide:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`.

### 5. Gmail sending account
- **Why:** transactional emails (invites, batch-ready, status updates). Owner confirmed **read + send**.
- **Do:** for `atsapplyexperts@gmail.com`, create OAuth credentials with `gmail.send`, mint a refresh token (OAuth Playground or your flow).
- **Provide:** `GMAIL_SENDER`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_REDIRECT_URI`. *(Already populated in your dev `.env`.)*

### 6. Google Sheets service account
- **Why:** create the per-batch job sheet appliers work from.
- **Do:** create a service account, enable Sheets + Drive APIs, download the JSON key.
- **Provide:** `GOOGLE_SERVICE_ACCOUNT` (the JSON, single line).

### 7. Seed the first admin
- **Why:** there's no public admin signup.
- **Do:** set `ADMIN_NAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` (use a strong password — the current `12345` is dev-only), then `node src/jobs/seed-admin.js`.

### 8. Hosting (three processes)
- **Why:** the API, the **scheduler worker**, and the **JobSpy** service run separately. The scheduler must be a **single** instance (avoid duplicate cron runs).
- **Do:** deploy the Node API (Render/Railway/Fly), the scheduler as a worker, and `jobspy-service` (Python) somewhere reachable.
- **Provide:** set `PORT`, `APP_URL` (your real frontend origin), `CORS_ORIGINS` if needed, `JOBSPY_ENABLED=true` + `JOBSPY_URL`.

### 9. JobSpy proxies (optional, for LinkedIn at scale)
- **Why:** LinkedIn rate-limits aggressively.
- **Provide:** `JOBSPY_PROXIES` (comma-separated `user:pass@host:port`).

### 10. Frontend hosting
- **Why:** serve `frontend/index.html` on a real origin matching `APP_URL` (so CORS + OAuth redirect work).
- **Do:** host the static page (Vercel/Netlify/any static host) and set the API base URL it calls.

### 11. File storage migration (when scaling)
- **Why:** resumes are on local disk now. For multi-instance hosting, move to S3/R2 with signed URLs.
- **Do:** swap `lib/upload.js` storage + the download route to object storage; keep the API gate.

### 12. Backups & monitoring
- **Why:** durability + operational visibility.
- **Do:** enable automated Postgres backups; add uptime/error monitoring on the API and scheduler.

---
After completing the above, follow `RUNBOOK.md` to start each service and run the smoke checks.
