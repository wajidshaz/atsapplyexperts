import { Router } from 'express';
import { query } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';
import { searchJobs } from '../services/scraper.js';
const r = Router();

r.use(requireAuth);

// Live search: scrape JobSpy for the query, store the results, then return all
// DB jobs matching the query (so fresh + previously-scraped jobs both show).
// GET /api/jobs/search?q=&location=&remote=
r.get('/search', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const location = (req.query.location || '').trim();
    const remote = req.query.remote === 'true';
    const keywords = q ? q.split(/\s+/) : [];

    let scraped = { jobspy: false, externalIds: [] };
    try {
      scraped = await searchJobs({ keywords, location: remote ? 'Remote' : (location || null) });
    } catch (e) {
      scraped = { error: e.message, jobspy: false, externalIds: [] };
    }

    // Return (a) the exact jobs JobSpy just scraped for this query, plus
    // (b) any previously-stored jobs matching the keyword — deduped. JobSpy
    // already location-targeted (a), so we don't re-filter those by location.
    const rows = [];
    const seen = new Set();
    if (scraped.externalIds && scraped.externalIds.length) {
      const fr = await query(
        `SELECT * FROM jobs WHERE external_id = ANY($1::text[]) ORDER BY scraped_at DESC`,
        [scraped.externalIds]);
      for (const j of fr.rows) if (!seen.has(j.id)) { seen.add(j.id); rows.push(j); }
    }
    if (q) {
      const ex = await query(
        `SELECT * FROM jobs WHERE (title ILIKE $1 OR company ILIKE $1 OR description ILIKE $1)
          ORDER BY scraped_at DESC LIMIT 100`, [`%${q}%`]);
      for (const j of ex.rows) if (!seen.has(j.id)) { seen.add(j.id); rows.push(j); }
    }
    res.json({ jobs: rows.slice(0, 100), scraped });
  } catch (e) { next(e); }
});

// LinkedIn-style job board with filters. Optional ?candidate_id scores against their profile.
// GET /api/jobs?search=&location=&type=&posted_days=&level=&min_salary=&min_score=&candidate_id=
r.get('/', async (req, res, next) => {
  try {
    const { search, location, type, posted_days, level, min_salary, min_score, candidate_id } = req.query;
    const params = [];
    let sql = `SELECT j.*` +
      (candidate_id ? `, m.score` : ``) +
      ` FROM jobs j`;
    if (candidate_id) {
      params.push(candidate_id);
      sql += ` LEFT JOIN job_matches m ON m.job_id=j.id AND m.candidate_id=$${params.length}`;
    }
    sql += ` WHERE 1=1`;
    if (search)      { params.push(`%${search}%`); sql += ` AND (j.title ILIKE $${params.length} OR j.company ILIKE $${params.length})`; }
    if (location)    { params.push(`%${location}%`); sql += ` AND j.location ILIKE $${params.length}`; }
    if (type)        { params.push(type); sql += ` AND j.job_type = $${params.length}`; }
    if (level)       { params.push(level); sql += ` AND j.experience_level = $${params.length}`; }
    if (min_salary)  { params.push(+min_salary); sql += ` AND j.salary_max >= $${params.length}`; }
    if (posted_days) { params.push(+posted_days); sql += ` AND j.posted_at >= now() - ($${params.length} || ' days')::interval`; }
    if (candidate_id && min_score) { params.push(+min_score); sql += ` AND m.score >= $${params.length}`; }
    sql += candidate_id ? ` ORDER BY m.score DESC NULLS LAST, j.posted_at DESC` : ` ORDER BY j.posted_at DESC`;
    sql += ` LIMIT 100`;   // cap payload — board doesn't need all rows at once
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (e) { next(e); }
});

r.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM jobs WHERE id=$1', [req.params.id]);
    res.json(rows[0] || null);
  } catch (e) { next(e); }
});

// Approve a job from the board -> creates/sets an approval so it flows to the applier.
// A candidate approves their OWN board (candidate_id + role derived from the token);
// an admin may approve on a client's behalf by passing { candidate_id }.
// Board approvals live in a per-candidate "board picks" batch (batch_number 0) so
// they stay consistent with the approvals-backed live board and summary views.
// POST /api/jobs/:id/approve  (candidate: {}) | (admin: { candidate_id })
r.post('/:id/approve', async (req, res, next) => {
  try {
    let candidateId, approvedByRole;
    if (req.user.role === 'candidate') {
      candidateId = req.user.id;
      approvedByRole = 'client';
    } else if (req.user.role === 'admin') {
      candidateId = req.body.candidate_id;
      approvedByRole = 'admin';
      if (!candidateId) return res.status(400).json({ error: 'candidate_id required for admin approval' });
    } else {
      return res.status(403).json({ error: 'Appliers cannot approve jobs' });
    }

    // find or create the match row
    const m = await query(
      `SELECT id FROM job_matches WHERE job_id=$1 AND candidate_id=$2 LIMIT 1`,
      [req.params.id, candidateId]);
    let matchId = m.rows[0]?.id;
    if (!matchId) {
      const ins = await query(
        `INSERT INTO job_matches (job_id, candidate_id, score) VALUES ($1,$2,$3) RETURNING id`,
        [req.params.id, candidateId, 0]);
      matchId = ins.rows[0].id;
    }

    // find or create the candidate's "board picks" batch (batch_number 0)
    let batch = await query(
      `SELECT id FROM batches WHERE candidate_id=$1 AND batch_number=0 LIMIT 1`, [candidateId]);
    let batchId = batch.rows[0]?.id;
    if (!batchId) {
      const ins = await query(
        `INSERT INTO batches (candidate_id, batch_number, target_size, status)
         VALUES ($1, 0, 0, 'ready') RETURNING id`, [candidateId]);
      batchId = ins.rows[0].id;
    }
    await query(
      `INSERT INTO batch_items (batch_id, match_id) VALUES ($1,$2)
       ON CONFLICT (batch_id, match_id) DO NOTHING`, [batchId, matchId]);

    const { rows } = await query(
      `INSERT INTO approvals (batch_id, candidate_id, match_id, decision, approved_by_role, decided_at)
       VALUES ($1,$2,$3,'approved',$4, now())
       ON CONFLICT (batch_id, match_id)
         DO UPDATE SET decision='approved', approved_by_role=$4, decided_at=now()
       RETURNING *`,
      [batchId, candidateId, matchId, approvedByRole]);
    res.json({ approved: rows[0], next: 'queued for applier' });
  } catch (e) { next(e); }
});

export default r;
