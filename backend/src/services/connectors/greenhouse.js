// Greenhouse connector.
// Greenhouse publishes every company's jobs at a public, structured endpoint:
//   https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
// `token` is the company's board token (e.g. "stripe", "airbnb"). This is the
// company's own public job feed — no scraping tricks, no auth, allowed.
//
// Returns normalized jobs: { external_id, title, company, location, salary,
//   description, apply_link, job_type, experience_level, salary_max, posted_at }

import { stripHtml, guessLevel, guessType, parseSalaryMax } from './normalize.js';

export async function fetchGreenhouse(company) {
  const { token, name } = company; // { token: 'stripe', name: 'Stripe' }
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`;
  const res = await fetch(url, { headers: { 'User-Agent': 'ATSApplyExperts/1.0' } });
  if (!res.ok) throw new Error(`Greenhouse ${token}: HTTP ${res.status}`);
  const data = await res.json();
  const jobs = data.jobs || [];
  return jobs.map((j) => {
    const description = stripHtml(j.content || '');
    return {
      external_id: `greenhouse:${token}:${j.id}`,
      title: j.title,
      company: name || token,
      location: j.location?.name || 'Not specified',
      salary: null,
      salary_max: parseSalaryMax(description),
      job_type: guessType(j.title, description),
      experience_level: guessLevel(j.title),
      description,
      apply_link: j.absolute_url,
      posted_at: j.updated_at || j.created_at || null,
    };
  });
}
