# API Reference

Base URL: `http://localhost:4000` (dev). All app endpoints are under `/api`.

## Authentication model

- **Staff (admin / employee)** log in with name + password → receive a **JWT**.
- **Clients (candidates)** sign in with **Google OAuth** (server-side code exchange) → receive a JWT.
- Send the token on every protected request: `Authorization: Bearer <token>`.
- The caller's **role and id come from the verified token**, never from the request body or URL. Role can never be elevated by the client.

Error shape is uniform: `{ "error": "<message>" }`. Common statuses: `400` validation, `401` not authenticated, `403` wrong role / not your resource, `404` not found, `423` locked (resume gate), `429` rate-limited.

---

## Auth — `/api/auth`

| Method | Path | Auth | Body | Response | Errors |
|---|---|---|---|---|---|
| POST | `/login` | public (rate-limited) | `{ username, password }` | `{ user, token }` | 400, 401 |
| POST | `/oauth` | public (rate-limited) | `{ code, redirect_uri? }` | `{ user, token }` | 401 (Google failed), 403 (no invite / not a candidate) |
| GET | `/me` | any | — | current user | 401 |

`/oauth` exchanges the Google authorization `code` server-side, verifies the ID token, and matches an **invited** candidate by email. It flips `invite_status` to `active` and, if the user granted `gmail.readonly`, stores their refresh token for reply tracking.

## Candidates — `/api/candidates`
All require auth. "Self/admin" = the candidate themselves or an admin.

| Method | Path | Auth | Body | Notes |
|---|---|---|---|---|
| POST | `/:id/resume` | self/admin | `{ file_url, file_name, parsed_text }` | JSON metadata path (AI analysis runs) |
| POST | `/:id/resume/file` | self/admin | multipart `file` | Real upload → text extracted server-side → AI analysis |
| GET | `/:id/matches` | self/admin | — | Scored job matches |
| GET | `/:id/applications` | self/admin | — | Application tracking |
| GET | `/:id/profile` | self/admin | — | **Account passwords stripped** (usernames + `has_password`) |
| PUT | `/:id/profile` | self/admin | intake fields + `accounts` | Account passwords **encrypted at rest** |
| POST | `/:id/master-resume/decision` | self/admin | `{ decision: approved\|rejected }` | Client decision |
| POST | `/:id/master-resume` | **admin** | `{ file_url, file_name, ats_keywords }` | Admin uploads master (status `pending`) |
| PATCH | `/:id/master-resume` | self/admin | `{ decision }` | Client approve/reject |

## Jobs — `/api/jobs`
All require auth.

| Method | Path | Auth | Query/Body | Notes |
|---|---|---|---|---|
| GET | `/` | any | `search, location, type, posted_days, level, min_salary, min_score, candidate_id` | Filterable board |
| GET | `/:id` | any | — | Single job |
| POST | `/:id/approve` | candidate or admin | candidate: `{}` · admin: `{ candidate_id }` | Approves into the "board picks" batch → flows to applier |

## Batches — `/api/batches`
All require auth + ownership (candidate owns their batch; admin bypasses).

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/candidate/:id` | — | All batches for a candidate |
| GET | `/:batchId/items` | — | Items with score + decision |
| POST | `/approval/:approvalId` | `{ decision }` | Approve/reject one item |
| POST | `/:batchId/submit` | — | Creates applications + a Google Sheet; returns `{ submitted, sheetUrl }` |

## Admin — `/api/admin`
**Every** route requires the `admin` role.

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/users` | — | All users |
| POST | `/users` | `{ full_name, email, role, daily_target? }` | Add staff |
| POST | `/clients/invite` | `{ full_name, email, plan?, referred_by? }` | Invite candidate (emails OAuth link) |
| POST | `/clients/:id/resend-invite` | — | Resend invite |
| POST | `/approvals/:approvalId/approve` | — | Admin override approval |
| POST | `/assign` | `{ candidate_id, employee_id, daily_target? }` | Assign applier ↔ candidate |
| PATCH | `/users/:id/plan` | `{ plan: free\|vip }` | Change plan |
| POST | `/scraper/run` | `{ candidate_id? }` | Run scraper (rate-limited) |
| DELETE | `/users/:id` | — | Delete user (cascades) |
| GET | `/clients/:candidateId/resumes` | — | List resumes |
| POST | `/clients/:candidateId/master-resume` | `{ file_url, file_name }` | Upload master (URL) |
| POST | `/clients/:candidateId/master-resume/file` | multipart `file` + `ats_keywords?` | Upload master (file) |
| POST | `/batches/:id/expand` | `{ size?, stats? }` | AI-suggested batch size |
| GET | `/clients/:candidateId/approval-summary` | — | Counts |
| GET | `/clients/:candidateId/jobs` | — | Jobs + decisions |
| GET | `/live` | `?candidate_id` | Live board counts + per-job status |

## Employees — `/api/employees`
Require `employee` or `admin`. Candidate-scoped routes also require the employee be **assigned** to that candidate.

| Method | Path | Auth detail | Body | Notes |
|---|---|---|---|---|
| GET | `/:id/candidates` | own id / admin | — | Assigned candidates |
| GET | `/:id/sheet/:candidateId` | assigned / admin | — | Job sheet |
| PATCH | `/applications/:appId` | assigned to app | `{ status }` | Updates status; emails + notifies candidate |
| GET | `/resume/:candidateId` | assigned / admin | — | `{ file_name, download_url }` or **423** (not approved) / 404 |
| GET | `/resume/:candidateId/file?rid=&t=` | assigned / admin | — | Streams the file behind a signed grant |
| GET | `/profile/:candidateId` | assigned / admin | — | Profile, **passwords stripped** |
| GET | `/pipeline` | employee-scoped | `?candidate_id` | Kanban cards (employee sees only assigned) |
| PATCH | `/pipeline/:appId` | assigned to app | `{ stage, note? }` | Move stage |

## Reports — `/api/reports`
Require auth.

| Method | Path | Auth | Query | Notes |
|---|---|---|---|---|
| GET | `/candidate/:id` | self/admin | — | Last 30 daily reports |
| GET | `/candidate/:id/applications` | self/admin | `company, date, min_score, status` | Filterable rows (drives PDF export) |
| GET | `/system` | **admin** | — | System metrics |

## Messages — `/api/messages`
Require auth; thread access limited to the client or an admin.

| Method | Path | Auth | Body | Notes |
|---|---|---|---|---|
| GET | `/threads` | **admin** | — | All client threads + unread counts |
| GET | `/thread/:clientId` | participant | — | Thread messages |
| POST | `/thread/:clientId` | participant | `{ body }` | Sender derived from token; notifies the other party |
| PATCH | `/thread/:clientId/read` | participant | — | Mark other party's messages read |

## Notifications — `/api/notifications`
Require auth.

| Method | Path | Notes |
|---|---|---|
| GET | `/` | `{ notifications, unread }` for the current user |
| PATCH | `/read` | Mark all the user's notifications read |
