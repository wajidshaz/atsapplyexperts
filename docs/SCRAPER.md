# Scraper

Orchestrator: `backend/src/services/scraper.js`. Connectors: `backend/src/services/connectors/`.

## Sources
- **Per-company public feeds** (no auth, no bot-evasion): Greenhouse, Lever, Ashby, Workable.
  - Target companies are configured in `connectors/companies.js` (provider + token + name).
- **Workday** — best-effort per-tenant; some tenants block automated calls. Those are logged and skipped, never bypassed.
- **JobSpy** (Python microservice) — search-based across Indeed / LinkedIn / Glassdoor / ZipRecruiter / Google. Gated by `JOBSPY_ENABLED`. Proxies via `JOBSPY_PROXIES` (recommended for LinkedIn).

## Normalization & dedupe
- `connectors/normalize.js` maps every source to a common shape: `external_id, title, company, location, salary, salary_max, job_type, experience_level, description, apply_link, posted_at`.
- All sources **upsert** into `jobs` keyed by unique `(source, external_id)` — re-running is idempotent.

## Filtering
- `runScraper({ candidate_id, interests, work_scope, work_locations })` filters by the candidate's `job_interests` keywords (title/description) and `work_scope`/`work_locations` (location). With no candidate, it pulls broadly across configured companies.
- Returns a summary: `{ fetched, inserted, errors, ... }`. Per-company failures don't abort the whole run.

## Honesty constraints (by design)
- No code bypasses bot-detection on sites that forbid scraping. JobSpy is used as-is with its documented rate-limit/proxy behavior.
- Failures are surfaced in the run summary and logs, not hidden.

## Known limitations
- LinkedIn rate-limits aggressively; large pulls need proxies.
- Workday coverage depends on each company's tenant config and policy.
- The daily match step scores per-candidate filtered jobs (capped at 200/candidate) to keep cost bounded; tune in `scheduler.js`.
