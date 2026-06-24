import { Router } from 'express';
import { query } from '../config/db.js';
import { requireAuth, requireRole, requireSelfOrAdmin } from '../middleware/auth.js';
const r = Router();

r.use(requireAuth);

r.get('/candidate/:id', requireSelfOrAdmin('id'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT report_date, metrics FROM reports
        WHERE scope='candidate' AND subject_id=$1 ORDER BY report_date DESC LIMIT 30`,
      [req.params.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

// Filterable application rows for the Reports screen + PDF export.
// GET /api/reports/candidate/:id/applications?company=&date=&min_score=&status=
r.get('/candidate/:id/applications', requireSelfOrAdmin('id'), async (req, res, next) => {
  try {
    const { company, date, min_score, status } = req.query;
    const params = [req.params.id];
    let sql = `SELECT j.company, j.title, a.applied_at::date AS date_applied,
                      m.score, a.status
                 FROM applications a
                 JOIN jobs j ON j.id = a.job_id
            LEFT JOIN job_matches m ON m.job_id = a.job_id AND m.candidate_id = a.candidate_id
                WHERE a.candidate_id = $1`;
    if (company)   { params.push(`%${company}%`); sql += ` AND j.company ILIKE $${params.length}`; }
    if (date)      { params.push(date);           sql += ` AND a.applied_at::date = $${params.length}`; }
    if (min_score) { params.push(+min_score);     sql += ` AND m.score >= $${params.length}`; }
    if (status)    { params.push(status);         sql += ` AND a.status = $${params.length}`; }
    sql += ` ORDER BY a.applied_at DESC NULLS LAST`;
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (e) { next(e); }
});

r.get('/system', requireRole('admin'), async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT report_date, metrics FROM reports WHERE scope='system' ORDER BY report_date DESC LIMIT 30`);
    res.json(rows);
  } catch (e) { next(e); }
});

export default r;
