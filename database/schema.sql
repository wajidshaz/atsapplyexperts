-- =====================================================================
--  AI + Human Job Application System — PostgreSQL schema
--  Engine: PostgreSQL 15+
--  Run:    psql -d jobpilot -f schema.sql
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";     -- case-insensitive email column

-- ---------- enums ----------
CREATE TYPE user_role     AS ENUM ('admin', 'candidate', 'employee');
CREATE TYPE user_plan     AS ENUM ('free', 'vip');
CREATE TYPE user_status   AS ENUM ('active', 'suspended', 'online', 'offline');
CREATE TYPE match_reco    AS ENUM ('approve', 'reject', 'review');
CREATE TYPE approval_dec  AS ENUM ('approved', 'rejected', 'pending');
CREATE TYPE approved_by   AS ENUM ('client', 'admin');
CREATE TYPE batch_status  AS ENUM ('draft', 'ready', 'submitted', 'expanded', 'closed');
CREATE TYPE app_status    AS ENUM ('to_do', 'applied', 'interview', 'rejected', 'offer');
CREATE TYPE task_status   AS ENUM ('pending', 'in_progress', 'done');

-- =====================================================================
--  USERS  (admin / candidate / employee share this table)
-- =====================================================================
CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         CITEXT UNIQUE NOT NULL,
    full_name     TEXT NOT NULL,
    role          user_role NOT NULL,
    plan          user_plan  NOT NULL DEFAULT 'free',
    status        user_status NOT NULL DEFAULT 'active',
    oauth_provider TEXT,                 -- 'google' | 'microsoft' (NO passwords stored)
    oauth_subject  TEXT,                 -- provider account id
    email_scope_granted BOOLEAN NOT NULL DEFAULT FALSE,  -- candidate allowed read-only inbox access
    email_read_token    TEXT,            -- read-only token for tracking recruiter replies (responses/interviews); never used to send
    referred_by   TEXT,                  -- name/id of the client who referred this client (manual add)
    invite_status TEXT NOT NULL DEFAULT 'active',  -- 'invited' (awaiting first OAuth login) | 'active'
    password_hash TEXT,                  -- bcrypt hash for admin/staff password login (NULL for OAuth-only clients)
    avatar_url     TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_role ON users(role);

-- candidate <-> employee assignment (who applies for whom)
CREATE TABLE assignments (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    employee_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    daily_target  INT NOT NULL DEFAULT 45,
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (candidate_id, employee_id)
);

-- =====================================================================
--  RESUMES
-- =====================================================================
CREATE TABLE resumes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_url      TEXT NOT NULL,         -- object-storage URL (S3/GCS)
    file_name     TEXT NOT NULL,
    parsed_text   TEXT,                  -- extracted plain text
    ai_skills     JSONB,                 -- ["React","TypeScript",...]
    ai_strength   INT CHECK (ai_strength BETWEEN 0 AND 100),
    kind          TEXT NOT NULL DEFAULT 'original',  -- 'original' (client upload) | 'master' (admin ATS version)
    master_status TEXT NOT NULL DEFAULT 'none',      -- master only: 'none'|'pending'|'approved'|'rejected'
    ats_keywords  JSONB,                 -- master only: keywords admin added for the target title
    approved_at   TIMESTAMPTZ,           -- when the client approved the master
    is_current    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_resumes_candidate ON resumes(candidate_id);

-- =====================================================================
--  CANDIDATE_PROFILES  (the application info from the client intake sheet)
--  Job-board credentials are stored encrypted at the app layer; passwords
--  are never returned in plain text to the UI.
-- =====================================================================
CREATE TABLE candidate_profiles (
    candidate_id  UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    accounts      JSONB,   -- encrypted: {linkedin:{user,enc_pw}, gmail:{...}, indeed, dice, monster}
    first_name    TEXT,
    last_name     TEXT,
    dob           DATE,
    street        TEXT,
    apartment     TEXT,
    city          TEXT,
    state         TEXT,
    zip           TEXT,
    country       TEXT,
    expected_salary INT,
    relocate      TEXT,
    masters_school TEXT, masters_course TEXT, masters_start DATE, masters_end DATE,
    bachelors_school TEXT, bachelors_course TEXT, bachelors_start DATE, bachelors_end DATE,
    legally_authorized TEXT,
    sponsorship   TEXT,
    visa_status   TEXT,
    citizenship   TEXT,
    clearance     TEXT,
    sex           TEXT,
    disability    TEXT,
    veteran       TEXT,
    convicted_felony TEXT,
    food_stamp    TEXT,
    tanf          TEXT,
    unemployment_benefits TEXT,
    agreements_accepted BOOLEAN NOT NULL DEFAULT FALSE,
    job_interests JSONB,   -- ["Frontend Engineer","React","Remote"] — drives the scraper
    work_scope    TEXT,    -- 'usa' | 'remote' | 'states'
    work_locations JSONB,  -- ["California","Texas","New York, NY"] — used when work_scope='states'
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
--  JOBS  (raw scraped listings, deduplicated)
-- =====================================================================
CREATE TABLE jobs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source        TEXT,                  -- scraper source (linkedin, indeed...)
    external_id   TEXT,                  -- id at source, for dedupe
    title         TEXT NOT NULL,
    company       TEXT NOT NULL,
    location      TEXT,
    salary        TEXT,                  -- free text, "if available"
    salary_max    INT,                   -- numeric upper bound for filtering
    job_type      TEXT,                  -- 'Full-time' | 'Contract' | 'Internship' ...
    experience_level TEXT,               -- 'Entry' | 'Mid' | 'Senior' | 'Lead'
    description   TEXT NOT NULL,         -- full JD
    ai_summary    TEXT,                  -- Kimi: what the job actually means
    apply_link    TEXT NOT NULL,
    posted_at     TIMESTAMPTZ,           -- when the listing was posted (for date filter)
    scraped_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, external_id)
);
CREATE INDEX idx_jobs_scraped ON jobs(scraped_at);

-- =====================================================================
--  JOB_MATCHES  (one row per candidate x job that AI scored)
-- =====================================================================
CREATE TABLE job_matches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    score           INT  NOT NULL CHECK (score BETWEEN 0 AND 100),
    recommendation  match_reco NOT NULL DEFAULT 'review',
    reasoning       TEXT,                -- AI explanation (suggest only, never acts)
    analysis        JSONB,               -- full AI recruiter report (rules, flags, skills, etc.)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (candidate_id, job_id)
);
CREATE INDEX idx_matches_candidate_score ON job_matches(candidate_id, score DESC);

-- =====================================================================
--  BATCHES  (groups of matches surfaced for approval: 10 then 35)
-- =====================================================================
CREATE TABLE batches (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    batch_number  INT  NOT NULL,         -- 1, 2, ...
    target_size   INT  NOT NULL DEFAULT 10,
    status        batch_status NOT NULL DEFAULT 'draft',
    sheet_url     TEXT,                  -- Google Sheet created on submit
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    submitted_at  TIMESTAMPTZ
);
CREATE INDEX idx_batches_candidate ON batches(candidate_id, batch_number);

-- link table: which matches belong to a batch
CREATE TABLE batch_items (
    batch_id   UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
    match_id   UUID NOT NULL REFERENCES job_matches(id) ON DELETE CASCADE,
    PRIMARY KEY (batch_id, match_id)
);

-- =====================================================================
--  APPROVALS  (candidate decision per match within a batch)
-- =====================================================================
CREATE TABLE approvals (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id      UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
    match_id      UUID NOT NULL REFERENCES job_matches(id) ON DELETE CASCADE,
    candidate_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    decision      approval_dec NOT NULL DEFAULT 'pending',
    approved_by_role approved_by,            -- who approved: client (self) or admin (override when client had no time)
    decided_at    TIMESTAMPTZ,
    UNIQUE (batch_id, match_id)
);

-- =====================================================================
--  APPLICATIONS  (an approved job an employee applies to by hand)
-- =====================================================================
CREATE TABLE applications (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    employee_id   UUID REFERENCES users(id) ON DELETE SET NULL,
    job_id        UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    batch_id      UUID REFERENCES batches(id) ON DELETE SET NULL,
    status        app_status NOT NULL DEFAULT 'to_do',
    applied_at    TIMESTAMPTZ,
    notes         TEXT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (candidate_id, job_id)
);
CREATE INDEX idx_apps_candidate ON applications(candidate_id);
CREATE INDEX idx_apps_employee  ON applications(employee_id, status);

-- =====================================================================
--  EMPLOYEES_TASKS  (daily work queue per employee/candidate)
-- =====================================================================
CREATE TABLE employees_tasks (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    candidate_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    batch_id      UUID REFERENCES batches(id) ON DELETE SET NULL,
    task_date     DATE NOT NULL DEFAULT CURRENT_DATE,
    total_jobs    INT  NOT NULL DEFAULT 0,
    completed     INT  NOT NULL DEFAULT 0,
    status        task_status NOT NULL DEFAULT 'pending',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tasks_employee_date ON employees_tasks(employee_id, task_date);

-- =====================================================================
--  REPORTS  (daily generated summaries, 3:30 PM)
-- =====================================================================
CREATE TABLE reports (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope         TEXT NOT NULL,          -- 'candidate' | 'employee' | 'system'
    subject_id    UUID,                   -- candidate or employee id (null = system)
    report_date   DATE NOT NULL DEFAULT CURRENT_DATE,
    metrics       JSONB NOT NULL,         -- {applied:42, response_rate:0.19, ...}
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (scope, subject_id, report_date)
);

-- =====================================================================
--  NOTIFICATIONS  (email/alert log — OAuth send, no passwords)
-- =====================================================================
CREATE TABLE notifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,            -- 'jobs_ready' | 'batch_ready' | 'status_update'
    payload     JSONB,
    sent_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
--  MESSAGES  (client <-> admin chat; one thread per client)
-- =====================================================================
CREATE TABLE messages (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- the client thread
    sender_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- who sent it
    sender_role   user_role NOT NULL,        -- 'candidate' | 'admin'
    body          TEXT NOT NULL,
    read_at       TIMESTAMPTZ,
    edited_at     TIMESTAMPTZ,               -- set when the sender edits the message
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_messages_client ON messages(client_id, created_at);

-- ---------- updated_at trigger ----------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_touch  BEFORE UPDATE ON users        FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_apps_touch   BEFORE UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
