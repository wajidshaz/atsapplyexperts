// JobSpy connector.
// Calls our Python JobSpy micro-service (see /jobspy-service) over HTTP and
// returns jobs in the same normalized shape as the other connectors.
//
// Configure the service URL with JOBSPY_URL (default http://127.0.0.1:8000).
// This connector is "search-based" (keywords + location) rather than per-company,
// so the scraper passes the candidate's interests/location through to it.

import { guessLevel } from './normalize.js';

const JOBSPY_URL = process.env.JOBSPY_URL || 'http://127.0.0.1:8000';

// opts: { keywords: [...], location: 'United States'|'Remote'|[...], sites: [...] }
export async function fetchJobSpy(opts = {}) {
  const { keywords = [], location = null, sites = null } = opts;
  const search_term = Array.isArray(keywords) && keywords.length ? keywords.join(' ') : '';
  let loc = '';
  let is_remote = false;
  if (location === 'Remote') { is_remote = true; }
  else if (Array.isArray(location)) loc = location[0] || '';
  else if (typeof location === 'string') loc = location === 'United States' ? '' : location;

  const body = {
    site_name: sites || (process.env.JOBSPY_SITES || 'indeed,linkedin').split(','),
    search_term,
    location: loc,
    results_wanted: Number(process.env.JOBSPY_RESULTS || 50),
    hours_old: Number(process.env.JOBSPY_HOURS || 72),
    is_remote,
    country_indeed: process.env.JOBSPY_COUNTRY || 'USA',
    proxies: process.env.JOBSPY_PROXIES ? process.env.JOBSPY_PROXIES.split(',') : undefined,
  };

  const res = await fetch(`${JOBSPY_URL}/scrape`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`JobSpy service HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.jobs || []).map((j) => ({
    external_id: j.external_id,
    title: j.title,
    company: j.company || 'Unknown',
    location: j.location || 'Not specified',
    salary: j.salary || null,
    salary_max: j.salary_max || null,
    job_type: j.job_type || 'Full-time',
    experience_level: j.experience_level || guessLevel(j.title || ''),
    description: j.description || '',
    apply_link: j.apply_link || '',
    posted_at: j.posted_at || null,
    _source: j.source || 'jobspy',
  }));
}
