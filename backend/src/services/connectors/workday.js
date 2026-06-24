// Workday connector — BEST EFFORT.
//
// Unlike Greenhouse/Lever/Ashby/Workable, Workday has NO single public feed.
// Each company runs its own tenant on its own host, e.g.:
//   https://{tenant}.{dc}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
// Many tenants respond to a POST with a JSON body and return structured jobs,
// but some require headers/cookies, paginate oddly, or block automated calls.
// So this connector is provided per-company and may fail for some tenants —
// that is expected. It does NOT attempt to bypass any protection; if a tenant
// blocks automated access, we skip it and log it.
//
// company config shape for Workday:
//   { provider:'workday', name:'Acme', host:'acme.wd1.myworkdayjobs.com',
//     tenant:'acme', site:'External' }

import { stripHtml, guessLevel, guessType, parseSalaryMax } from './normalize.js';

export async function fetchWorkday(company) {
  const { host, tenant, site, name } = company;
  if (!host || !tenant || !site) {
    throw new Error(`Workday ${name}: needs host, tenant and site in config`);
  }
  const url = `https://${host}/wday/cxs/${tenant}/${site}/jobs`;
  const out = [];
  let offset = 0;
  const limit = 20;
  // Workday paginates; pull up to a sane cap.
  for (let page = 0; page < 10; page++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'ATSApplyExperts/1.0' },
      body: JSON.stringify({ limit, offset, searchText: '', appliedFacets: {} }),
    });
    if (!res.ok) throw new Error(`Workday ${name}: HTTP ${res.status}`);
    const data = await res.json();
    const postings = data.jobPostings || [];
    if (!postings.length) break;
    for (const j of postings) {
      const path = j.externalPath || '';
      out.push({
        external_id: `workday:${tenant}:${path}`,
        title: j.title,
        company: name || tenant,
        location: j.locationsText || 'Not specified',
        salary: null,
        salary_max: null,
        job_type: guessType(j.title, ''),
        experience_level: guessLevel(j.title),
        description: stripHtml(j.bulletFields?.join(' ') || j.title),
        apply_link: `https://${host}${path}`,
        posted_at: null,
      });
    }
    offset += limit;
    if (postings.length < limit) break;
  }
  return out;
}
