import { Router } from 'express';
import { query } from '../config/db.js';
import { createBatchSheet } from '../services/sheets.js';
import { requireAuth, requireSelfOrAdmin } from '../middleware/auth.js';
import { validateBody, z, APPROVAL_DEC } from '../middleware/validate.js';
const r = Router();

r.use(requireAuth);

// A candidate may only act on a batch/approval that belongs to them; admin bypasses.
async function ownerOf(table, id) {
  const { rows } = await query(`SELECT candidate_id FROM ${table} WHERE id=$1`, [id]);
  return rows[0]?.candidate_id || null;
}
function ownsParam(table, param) {
  return async (req, res, next) => {
    try {
      if (req.user.role === 'admin') return next();
      if (req.user.role !== 'candidate') return res.status(403).json({ error: 'Forbidden' });
      const owner = await ownerOf(table, req.params[param]);
      if (owner !== req.user.id) return res.status(403).json({ error: 'Forbidden: not your resource' });
      next();
    } catch (e) { next(e); }
  };
}

// Current batches for a candidate
r.get('/candidate/:id', requireSelfOrAdmin('id'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT * FROM batches WHERE candidate_id=$1 ORDER BY batch_number`, [req.params.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

// Items in a batch (with scores + AI summary). LEFT JOIN approvals so items
// without an approval row yet are still returned.
r.get('/:batchId/items', ownsParam('batches', 'batchId'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT a.id approval_id, a.decision, m.score, m.recommendation, j.*
         FROM batch_items bi
         JOIN job_matches m ON m.id=bi.match_id
         JOIN jobs j ON j.id=m.job_id
         LEFT JOIN approvals a ON a.match_id=m.id AND a.batch_id=bi.batch_id
        WHERE bi.batch_id=$1 ORDER BY m.score DESC`, [req.params.batchId]);
    res.json(rows);
  } catch (e) { next(e); }
});

// Approve / reject one job in a batch
const decisionSchema = z.object({ decision: z.enum(['approved', 'rejected']) });
r.post('/approval/:approvalId', ownsParam('approvals', 'approvalId'), validateBody(decisionSchema), async (req, res, next) => {
  try {
    const { decision } = req.body;
    const approvedBy = req.user.role === 'admin' ? 'admin' : 'client';
    const { rows } = await query(
      `UPDATE approvals SET decision=$1, approved_by_role=$2, decided_at=now() WHERE id=$3 RETURNING *`,
      [decision, approvedBy, req.params.approvalId]);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// Submit a batch -> create applications for approved jobs + Google Sheet
r.post('/:batchId/submit', ownsParam('batches', 'batchId'), async (req, res, next) => {
  try {
    const { rows: approved } = await query(
      `SELECT j.*, b.candidate_id, c.full_name
         FROM approvals a
         JOIN batches b ON b.id=a.batch_id
         JOIN users c ON c.id=b.candidate_id
         JOIN job_matches m ON m.id=a.match_id
         JOIN jobs j ON j.id=m.job_id
        WHERE a.batch_id=$1 AND a.decision='approved'`, [req.params.batchId]);

    for (const j of approved) {
      await query(
        `INSERT INTO applications (candidate_id, job_id, batch_id, status)
         VALUES ($1,$2,$3,'to_do') ON CONFLICT (candidate_id, job_id) DO NOTHING`,
        [j.candidate_id, j.id, req.params.batchId]);
    }
    let sheetUrl = null;
    if (approved.length) {
      try {
        sheetUrl = await createBatchSheet(approved[0].full_name, approved);
      } catch (e) {
        // Sheet creation is best-effort; don't fail the submit if Sheets is misconfigured.
        console.error('[batches] sheet creation failed:', e.message);
      }
    }
    await query(`UPDATE batches SET status='submitted', submitted_at=now(), sheet_url=$2 WHERE id=$1`,
      [req.params.batchId, sheetUrl]);
    res.json({ submitted: approved.length, sheetUrl });
  } catch (e) { next(e); }
});

export default r;
