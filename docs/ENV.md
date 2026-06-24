# Environment Variables

All backend config lives in `backend/.env` (copy from `backend/.env.example`). Never commit `.env`.

| Variable | Required | What it does |
|---|---|---|
| `DATABASE_URL` | **Yes** | Postgres connection string (Neon). |
| `PORT` | No (4000) | API listen port. |
| `APP_URL` | **Yes** | Primary frontend origin. Used for CORS allow-list and invite links. |
| `CORS_ORIGINS` | No | Extra comma-separated origins allowed by CORS, beyond `APP_URL`. |
| `JWT_SECRET` | **Yes** | Secret for signing session JWTs **and** resume download grants. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. |
| `JWT_EXPIRES` | No (`7d`) | JWT lifetime. |
| `CREDENTIAL_ENC_KEY` | **Yes** | 32-byte base64 key for AES-256-GCM encryption of job-board credentials. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. |
| `GOOGLE_CLIENT_ID` | for client login | OAuth client used for candidate Google sign-in (server-side code exchange) and reading their inbox. |
| `GOOGLE_CLIENT_SECRET` | for client login | Secret for the above. |
| `GOOGLE_REDIRECT_URI` | for client login | Must match the redirect registered in Google Cloud and used by the frontend. |
| `GMAIL_SENDER` | for email | The "From" address (default `atsapplyexperts@gmail.com`). |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` | for email | OAuth client for the **company sending account**. |
| `GMAIL_REFRESH_TOKEN` | for email | Refresh token for the sending account (`atsapplyexperts@gmail.com`). |
| `GMAIL_REDIRECT_URI` | for email | Redirect used when the sending-account token was minted. |
| `OPENROUTER_API_KEY` | **Yes (AI)** | OpenRouter key (chat + embeddings). |
| `OPENROUTER_CHAT_MODEL` | No | Chat model for resume analysis / job summaries (default `google/gemini-2.0-flash-exp:free`). |
| `OPENROUTER_EMBED_MODEL` | No | Embedding model for matching (default `nvidia/llama-nemotron-embed-vl-1b-v2:free`). |
| `GOOGLE_SERVICE_ACCOUNT` | for Sheets | Service-account JSON (single line) for creating batch Google Sheets. |
| `UPLOAD_DIR` | No (`./uploads`) | Where uploaded resumes are stored on disk. |
| `ADMIN_NAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` | for seeding | Used once by `seed-admin.js`. |
| `JOBSPY_ENABLED` | No (`false`) | Enable the Python JobSpy microservice in scraping. |
| `JOBSPY_URL` | No | JobSpy service URL (default `http://127.0.0.1:8000`). |
| `JOBSPY_SITES` / `JOBSPY_RESULTS` / `JOBSPY_HOURS` / `JOBSPY_COUNTRY` / `JOBSPY_PROXIES` | No | JobSpy tuning. Proxies recommended for LinkedIn at scale. |

> **Two Google integrations, two purposes.** `GMAIL_*` is the single company **sending** account. `GOOGLE_*` is the OAuth client candidates use to sign in and to grant **read-only** access to *their own* inbox (for reply tracking). They can share one Google Cloud project but serve different roles.
