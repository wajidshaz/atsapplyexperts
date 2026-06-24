// Workable connector.
// Workable exposes a public jobs feed per company account:
//   https://apply.workable.com/api/v1/widget/accounts/{token}?details=true
// `token` is the company's Workable subdomain/account. Public, structured.

import { stripHtml, guessLevel, guessType, parseSalaryMax } from './normalize.js';

export async function fetchWorkable(company) {
  const { token, name } = company;
  const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(token)}?details=true`;
  const res = await fetch(url, { headers: { 'User-Agent': 'ATSApplyExperts/1.0' } });
  if (!res.ok) throw new Error(`Workable ${token}: HTTP ${res.status}`);
  const data = await res.json();
  const jobs = data.jobs || [];
  return jobs.map((j) => {
    const description = stripHtml(j.description || '');
    const loc = [j.city, j.region, j.country].filter(Boolean).join(', ') || (j.remote ? 'Remote' : 'Not specified');
    return {
      external_id: `workable:${token}:${j.shortcode || j.id}`,
      title: j.title,
      company: name || j.company || token,
      location: loc,
      salary: null,
      salary_max: parseSalaryMax(description),
      job_type: j.employment_type || guessType(j.title, description),
      experience_level: guessLevel(j.title),
      description,
      apply_link: j.application_url || j.url || j.shortlink,
      posted_at: j.published_on || j.created_at || null,
    };
  });
}
