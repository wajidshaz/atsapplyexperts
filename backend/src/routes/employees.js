import { Router } from 'express';
import { query } from '../config/db.js';
import { notify } from '../services/mailer.js';
import { requireAuth, requireRole, requireParamSelfOrAdmin, requireAssignedOrAdmin } from '../middleware/auth.js';
import { createNotification } from '../lib/notifications.js';
import { signDownload, verifyDownload } from '../lib/crypto.js';
import { resolveStored } from '../lib/upload.js';
import { validateBody, z, APP_STATUS } from '../middleware/validate.js';
const r = Router();

// All employee routes require staff (employee or admin) auth.
r.use(requireAuth, requireRole('employee', 'admin'));

// For application-scoped routes: the employee must be assigned to that app's candidate.
async function requireAssignedToApp(req, res, next) {
  try {
    if (req.user.role === 'admin') return next();
    const { rows } = await query(
      `SELECT 1 FROM applications a
         JOIN assignments asg ON asg.candidate_id=a.candidate_id AND asg.active
        WHERE a.id=$1 AND asg.employee_id=$2 LIMIT 1`,
      [req.params.appId, req.user.id]);
    if (!rows[0]) return res.status(403).json({ error: 'Forbidden: application not assigned to you' });
    next();
  } catch (e) { next(e); }
}

// Applier overview metrics. GET /api/employees/:id/metrics
r.get('/:id/metrics', requireParamSelfOrAdmin('id'), async (req, res, next) => {
  try {
    const { rows: [m] } = await query(`
      SELECT
        count(*) FILTER (WHERE status IN ('to_do','applied','interview','offer')) AS assigned,
        count(*) FILTER (WHERE status='applied' AND applied_at::date=CURRENT_DATE) AS applied_today,
        count(*) FILTER (WHERE status='to_do')                                     AS remaining,
        count(*) FILTER (WHERE status IN ('interview','offer'))                    AS responses
       FROM applications WHERE employee_id=$1`, [req.params.id]);
    res.json(m);
  } catch (e) { next(e); }
});

// Candidates assigned to this employee, with today's progress (applied / total).
r.get('/:id/candidates', requireParamSelfOrAdmin('id'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.id, c.full_name, c.plan, a.daily_target,
              (SELECT count(*) FROM applications ap WHERE ap.candidate_id=c.id AND ap.status<>'rejected') AS total_jobs,
              (SELECT count(*) FROM applications ap WHERE ap.candidate_id=c.id AND ap.status<>'to_do' AND ap.status<>'rejected') AS done_jobs
         FROM assignments a JOIN users c ON c.id=a.candidate_id
        WHERE a.employee_id=$1 AND a.active`, [req.params.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

// The job sheet (applications) for one candidate
r.get('/:id/sheet/:candidateId', requireAssignedOrAdmin('candidateId'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT a.id, a.status, j.title, j.company, j.apply_link
         FROM applications a JOIN jobs j ON j.id=a.job_id
        WHERE a.candidate_id=$1 AND a.status <> 'rejected' ORDER BY a.updated_at`,
      [req.params.candidateId]);
    res.json(rows);
  } catch (e) { next(e); }
});

// Update an application status (Applied / Interview / Rejected / Offer).
// The acting employee is taken from the token, not the body.
const statusSchema = z.object({ status: z.enum(APP_STATUS) });
r.patch('/applications/:appId', requireAssignedToApp, validateBody(statusSchema), async (req, res, next) => {
  try {
    const { status } = req.body;
    const setApplied = status === 'applied' ? ', applied_at=now()' : '';
    const { rows } = await query(
      `UPDATE applications SET status=$1, employee_id=$2${setApplied}
        WHERE id=$3 RETURNING *`,
      [status, req.user.id, req.params.appId]);
    if (!rows[0]) return res.status(404).json({ error: 'application not found' });
    // notify candidate of status change (email + in-app)
    const { rows: who } = await query(
      `SELECT u.id, u.email, j.title FROM applications a
         JOIN users u ON u.id=a.candidate_id JOIN jobs j ON j.id=a.job_id WHERE a.id=$1`,
      [req.params.appId]);
    if (who[0]) {
      try { await notify.statusUpdate(who[0].email, who[0].title, status); } catch (e) { console.error('[mail]', e.message); }
      await createNotification(who[0].id, 'status_update', { title: who[0].title, status });
    }
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// Download a candidate's resume — ONLY if their master resume is approved.
// Blocked (423) while pending/rejected. Returns an API-gated, short-lived link.
// GET /api/employees/resume/:candidateId
r.get('/resume/:candidateId', requireAssignedOrAdmin('candidateId'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, file_url, file_name, master_status FROM resumes
        WHERE candidate_id=$1 AND kind='master' AND is_current=true LIMIT 1`,
      [req.params.candidateId]);
    const master = rows[0];
    if (!master) return res.status(404).json({ error: 'No master resume prepared yet' });
    if (master.master_status !== 'approved') {
      return res.status(423).json({ // 423 Locked
        error: 'Resume is not downloadable yet',
        reason: master.master_status === 'pending' ? 'Pending client approval' : 'Sent back for changes',
        master_status: master.master_status,
      });
    }
    const grant = signDownload(master.id);
    res.json({
      file_name: master.file_name,
      download_url: `/api/employees/resume/${req.params.candidateId}/file?rid=${master.id}&t=${grant}`,
    });
  } catch (e) { next(e); }
});

// Stream the actual resume file behind a short-lived signed grant.
// GET /api/employees/resume/:candidateId/file?rid=&t=
r.get('/resume/:candidateId/file', requireAssignedOrAdmin('candidateId'), async (req, res, next) => {
  try {
    const { rid, t } = req.query;
    if (!rid || !verifyDownload(rid, t)) return res.status(403).json({ error: 'Invalid or expired download link' });
    const { rows } = await query(
      `SELECT file_url, file_name, master_status FROM resumes
        WHERE id=$1 AND candidate_id=$2 AND kind='master' AND is_current=true LIMIT 1`,
      [rid, req.params.candidateId]);
    const master = rows[0];
    if (!master) return res.status(404).json({ error: 'Resume not found' });
    if (master.master_status !== 'approved') return res.status(423).json({ error: 'Resume not approved' });
    const full = resolveStored(master.file_url);
    if (!full) return res.status(404).json({ error: 'File missing on server' });
    res.download(full, master.file_name);
  } catch (e) { next(e); }
});

// Employer view of a candidate's profile — EVERYTHING except passwords.
// GET /api/employees/profile/:candidateId
r.get('/profile/:candidateId', requireAssignedOrAdmin('candidateId'), async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM candidate_profiles WHERE candidate_id=$1', [req.params.candidateId]);
    const p = rows[0];
    if (!p) return res.json(null);
    if (p.accounts) {
      for (const k of Object.keys(p.accounts)) {
        // strip any password fields; expose username only
        p.accounts[k] = { user: p.accounts[k].user || '' };
      }
    }
    res.json(p);
  } catch (e) { next(e); }
});

// Pipeline (kanban) — applications by stage. Employees see only their assigned
// candidates; admins see everyone. Optional ?candidate_id narrows further.
// GET /api/employees/pipeline?candidate_id=
r.get('/pipeline', async (req, res, next) => {
  try {
    const { candidate_id } = req.query;
    const params = [];
    const clauses = [];
    if (req.user.role === 'employee') {
      params.push(req.user.id);
      clauses.push(`a.candidate_id IN (SELECT candidate_id FROM assignments WHERE employee_id=$${params.length} AND active)`);
    }
    if (candidate_id) {
      params.push(candidate_id);
      clauses.push(`a.candidate_id = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT a.id, j.title, j.company, c.full_name AS client,
              a.status AS stage, a.notes AS note, a.updated_at
         FROM applications a
         JOIN jobs j ON j.id=a.job_id
         JOIN users c ON c.id=a.candidate_id
        ${where}
        ORDER BY a.updated_at DESC`, params);
    res.json(rows);
  } catch (e) { next(e); }
});

// Move a card to a new stage (drag-and-drop on the kanban).
// PATCH /api/employees/pipeline/:appId  { stage, note? }
const stageSchema = z.object({ stage: z.enum(APP_STATUS), note: z.string().max(2000).optional() });
r.patch('/pipeline/:appId', requireAssignedToApp, validateBody(stageSchema), async (req, res, next) => {
  try {
    const { stage, note } = req.body;
    const { rows } = await query(
      `UPDATE applications SET status=$1, notes=COALESCE($2, notes), employee_id=$3, updated_at=now()
        WHERE id=$4 RETURNING id, status, notes`,
      [stage, note ?? null, req.user.id, req.params.appId]);
    res.json(rows[0] || { message: 'not found' });
  } catch (e) { next(e); }
});

export default r;
