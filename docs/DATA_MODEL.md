# Data Model

Source of truth: `database/schema.sql` (PostgreSQL 15+, `pgcrypto` for `gen_random_uuid()`).

## Enums
- `user_role`: admin · candidate · employee
- `user_plan`: free · vip
- `user_status`: active · suspended · online · offline
- `match_reco`: approve · reject · review
- `approval_dec`: approved · rejected · pending
- `approved_by`: client · admin
- `batch_status`: draft · ready · submitted · expanded · closed
- `app_status`: to_do · applied · interview · rejected · offer
- `task_status`: pending · in_progress · done

## Tables & key relationships

- **users** — everyone. OAuth fields for candidates; `password_hash` (bcrypt) for staff; `email_scope_granted` + `email_read_token` hold the per-client Gmail read grant; `invite_status` (`invited`→`active`).
- **assignments** — candidate ↔ employee (who applies for whom), `daily_target`, `active`. Unique `(candidate_id, employee_id)`.
- **resumes** — `kind` = `original` (client upload) or `master` (admin ATS version). `master_status` (`none|pending|approved|rejected`), `ats_keywords`, `is_current`. `file_url` stores the on-disk filename (served only through the gated download API). FK → users (cascade).
- **candidate_profiles** — 1:1 with a candidate. Intake fields + `accounts` (JSONB; **job-board passwords stored AES-256-GCM encrypted**, exposed only as `has_password`), `job_interests`, `work_scope`, `work_locations` (drive the scraper).
- **jobs** — scraped listings, deduped by unique `(source, external_id)`. Holds `ai_summary` (plain-English).
- **job_matches** — one row per `(candidate, job)` with `score 0–100`, `recommendation`, `reasoning`. Unique `(candidate_id, job_id)`.
- **batches** — `batch_number` (0 = board picks, 1 = first 10, 2 = next 35), `target_size`, `status`, `sheet_url`.
- **batch_items** — link `(batch_id, match_id)`.
- **approvals** — candidate decision per match within a batch. Unique `(batch_id, match_id)`; `approved_by_role` records client vs admin override.
- **applications** — an approved job an employee works. `status` (app_status), `employee_id`, `applied_at`, `notes`. Unique `(candidate_id, job_id)`.
- **employees_tasks** — daily work-queue counters per employee/candidate.
- **reports** — daily JSONB metrics; unique `(scope, subject_id, report_date)`.
- **notifications** — in-app bell feed; `sent_at` doubles as the "read at" marker.
- **messages** — one thread per client; `sender_role`, `read_at`.

Triggers keep `users.updated_at` and `applications.updated_at` fresh on update.
