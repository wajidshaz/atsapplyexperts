// Lever connector.
// Lever publishes each company's jobs at a public, structured endpoint:
//   https://api.lever.co/v0/postings/{handle}?mode=json
// `handle` is the company's Lever handle (e.g. "netflix", "spotify"). This is
// the company's own public postings feed — allowed, no auth required.

import { stripHtml, guessLevel, guessType, parseSalaryMax } from './normalize.js';

export async function fetchLever(company) {
  const { token, name } = company; // token = Lever handle
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`;
  const res = await fetch(url, { headers: { 'User-Agent': 'ATSApplyExperts/1.0' } });
  if (!res.ok) throw new Error(`Lever ${token}: HTTP ${res.status}`);
  const jobs = await res.json();
  return (Array.isArray(jobs) ? jobs : []).map((j) => {
    const description = stripHtml(j.descriptionPlain || j.description || '');
    const loc = j.categories?.location || 'Not specified';
    return {
      external_id: `lever:${token}:${j.id}`,
      title: j.text,
      company: name || token,
      location: loc,
      salary: j.salaryRange ? `${j.salaryRange.min}-${j.salaryRange.max}` : null,
      salary_max: j.salaryRange?.max || parseSalaryMax(description),
      job_type: j.categories?.commitment || guessType(j.text, description),
      experience_level: guessLevel(j.text),
      description,
      apply_link: j.hostedUrl || j.applyUrl,
      posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
    };
  });
}
