// Job scraper.
// Loops through the configured COMPANIES, calls the matching provider connector,
// normalizes the jobs, dedupes by (source, external_id), and upserts into `jobs`.
// One company failing does not stop the run — errors are caught and logged.
//
// The scraper does NOT score or filter. AI scoring happens in the matching step.
//
// To add LinkedIn/Indeed/Glassdoor breadth later, get a LICENSED aggregator key
// and add an `aggregator` connector here — it slots in like any other provider.

import { query } from '../config/db.js';
import { COMPANIES } from './connectors/companies.js';
import { fetchGreenhouse } from './connectors/greenhouse.js';
import { fetchLever } from './connectors/lever.js';
import { fetchAshby } from './connectors/ashby.js';
import { fetchWorkable } from './connectors/workable.js';
import { fetchWorkday } from './connectors/workday.js';
import { fetchJobSpy } from './connectors/jobspy.js';

const CONNECTORS = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
  workable: fetchWorkable,
  workday: fetchWorkday,
};

// Optional client-side filtering: keep only jobs matching the candidate's
// interests/location (used on single-client runs). Provider feeds return all a
// company's jobs, so we filter here rather than in the request.
function matchesFilters(job, keywords, location) {
  if (keywords && keywords.length) {
    const hay = `${job.title} ${job.description}`.toLowerCase();
    const hit = keywords.some((k) => hay.includes(String(k).toLowerCase()));
    if (!hit) return false;
  }
  if (location) {
    const loc = job.location?.toLowerCase() || '';
    if (Array.isArray(location)) {
      if (!location.some((l) => loc.includes(String(l).toLowerCase()))) return false;
    } else if (location === 'Remote') {
      if (!/remote/.test(loc)) return false;
    } // 'United States' is broad; we don't exclude on it here
  }
  return true;
}

// Bound any single connector call so one slow/hanging company board can't
// stall the whole scrape. The underlying request is left to settle and ignored.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms)),
  ]);
}

// Batch upsert: one multi-row INSERT per chunk instead of a round-trip per job.
// Returns how many rows were newly inserted (xmax=0).
const COLS = 12; // params per row (ai_summary is a literal NULL, not a param)
async function upsertJobs(provider, jobs) {
  if (!jobs.length) return 0;
  let inserted = 0;
  const CHUNK = 50;
  for (let i = 0; i < jobs.length; i += CHUNK) {
    const slice = jobs.slice(i, i + CHUNK);
    const valuesSql = [];
    const params = [];
    slice.forEach((j, idx) => {
      const b = idx * COLS;
      valuesSql.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},NULL,$${b+11},$${b+12})`);
      params.push(provider, j.external_id, j.title, j.company, j.location, j.salary, j.salary_max,
        j.job_type, j.experience_level, j.description, j.apply_link, j.posted_at);
    });
    const res = await query(
      `INSERT INTO jobs
         (source, external_id, title, company, location, salary, salary_max,
          job_type, experience_level, description, ai_summary, apply_link, posted_at)
       VALUES ${valuesSql.join(',')}
       ON CONFLICT (source, external_id) DO UPDATE SET
         title=EXCLUDED.title, location=EXCLUDED.location, salary=EXCLUDED.salary,
         salary_max=EXCLUDED.salary_max, job_type=EXCLUDED.job_type,
         experience_level=EXCLUDED.experience_level, description=EXCLUDED.description,
         apply_link=EXCLUDED.apply_link, posted_at=EXCLUDED.posted_at
       RETURNING (xmax = 0) AS inserted`,
      params,
    );
    inserted += res.rows.filter(r => r.inserted).length;
  }
  return inserted;
}

// runScraper()                                              -> all companies, no filter
// runScraper({ candidate_id, interests, work_scope, work_locations })
//                                                           -> filter to one candidate
const MAX_PER_COMPANY = Number(process.env.SCRAPER_MAX_PER_COMPANY || 60);

export async function runScraper(opts = {}) {
  const { candidate_id = null, interests = null, work_scope = null, work_locations = null } = opts;
  const keywords = Array.isArray(interests) && interests.length ? interests : null;
  let location = null;
  if (work_scope === 'usa') location = 'United States';
  else if (work_scope === 'remote') location = 'Remote';
  else if (work_scope === 'states' && Array.isArray(work_locations) && work_locations.length) location = work_locations;

  let inserted = 0, fetched = 0;
  const errors = [];

  for (const company of COMPANIES) {
    const connector = CONNECTORS[company.provider];
    if (!connector) { errors.push(`${company.name}: unknown provider ${company.provider}`); continue; }
    try {
      const jobs = await withTimeout(connector(company), 15000, company.name);
      fetched += jobs.length;
      const keep = jobs.filter(j => matchesFilters(j, keywords, location)).slice(0, MAX_PER_COMPANY);
      inserted += await upsertJobs(company.provider, keep);
    } catch (e) {
      // one company failing must not stop the whole run
      errors.push(`${company.name} (${company.provider}): ${e.message}`);
    }
  }

  // JobSpy micro-service (LinkedIn/Indeed/Glassdoor/etc.) — enabled by env.
  // It is search-based, so it uses the candidate's keywords + location.
  if (process.env.JOBSPY_ENABLED === 'true') {
    try {
      const jobs = await withTimeout(fetchJobSpy({ keywords: keywords || [], location }), 25000, 'jobspy');
      fetched += jobs.length;
      // JobSpy already searched by keyword/location; still apply our filter for safety.
      const keep = jobs.filter(j => matchesFilters(j, keywords, location)).slice(0, MAX_PER_COMPANY);
      // group by source so dedupe key (source, external_id) stays correct
      const bySource = {};
      for (const j of keep) (bySource[j._source || 'jobspy'] ??= []).push(j);
      for (const [src, arr] of Object.entries(bySource)) inserted += await upsertJobs(src, arr);
    } catch (e) {
      errors.push(`jobspy: ${e.message}`);
    }
  }

  return { fetched, inserted, errors, candidate_id, keywords, location };
}

// On-demand keyword search (used by the Jobs board "Search live").
// JobSpy is the search-based source, so this hits it directly with the query,
// stores the results, and reports how many were fetched/inserted.
export async function searchJobs({ keywords = [], location = null } = {}) {
  if (process.env.JOBSPY_ENABLED !== 'true') {
    return { fetched: 0, inserted: 0, jobspy: false, externalIds: [] };
  }
  const jobs = await withTimeout(fetchJobSpy({ keywords, location }), 30000, 'jobspy');
  const bySource = {};
  for (const j of jobs.slice(0, MAX_PER_COMPANY * 2)) (bySource[j._source || 'jobspy'] ??= []).push(j);
  let inserted = 0;
  for (const [src, arr] of Object.entries(bySource)) inserted += await upsertJobs(src, arr);
  // Return the external_ids so the caller can fetch these exact rows (with DB ids)
  // instead of re-filtering them out with a strict location match.
  const externalIds = jobs.map(j => j.external_id).filter(Boolean);
  return { fetched: jobs.length, inserted, jobspy: true, externalIds };
}
