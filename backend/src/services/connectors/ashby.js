// Ashby connector.
// Ashby exposes a public job board API per company:
//   https://api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true
// `token` is the company's job-board name. Public, structured, allowed.

import { stripHtml, guessLevel, guessType, parseSalaryMax } from './normalize.js';

export async function fetchAshby(company) {
  const { token, name } = company;
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`;
  const res = await fetch(url, { headers: { 'User-Agent': 'ATSApplyExperts/1.0' } });
  if (!res.ok) throw new Error(`Ashby ${token}: HTTP ${res.status}`);
  const data = await res.json();
  const jobs = data.jobs || [];
  return jobs.map((j) => {
    const description = stripHtml(j.descriptionPlain || j.description || '');
    const comp = j.compensation?.compensationTierSummary || null;
    return {
      external_id: `ashby:${token}:${j.id}`,
      title: j.title,
      company: name || token,
      location: j.location || (j.isRemote ? 'Remote' : 'Not specified'),
      salary: comp,
      salary_max: parseSalaryMax(comp || description),
      job_type: j.employmentType || guessType(j.title, description),
      experience_level: guessLevel(j.title),
      description,
      apply_link: j.jobUrl || j.applyUrl,
      posted_at: j.publishedAt || null,
    };
  });
}
