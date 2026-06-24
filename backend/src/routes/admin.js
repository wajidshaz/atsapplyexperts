import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../config/db.js';
import { runScraper } from '../services/scraper.js';
import { suggestBatchSize } from '../services/openrouter.js';
import { notify } from '../services/mailer.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { scraperLimiter } from '../middleware/rateLimit.js';
import { uploadResume, resolveStored } from '../lib/upload.js';
import { createNotification } from '../lib/notifications.js';
import { validateBody, z, USER_PLAN } from '../middleware/validate.js';
import { scoreCandidate, buildBatchOne, matchAndBatch } from '../lib/matching.js';
const r = Router();

// Every admin route requires a valid session AND the admin role.
r.use(requireAuth, requireRole('admin'));

r.get('/users', async (_req, res, next) => {
  try { const { rows } = await query('SELECT id,full_name,email,role,plan,status FROM users ORDER BY created_at DESC'); res.json(rows); }
  catch (e) { next(e); }
});

// Edit a staff member — rename and/or reset their password.
// PATCH /api/admin/users/:id  { full_name?, password? }
const editUserSchema = z.object({
  full_name: z.string().min(1).optional(),
  password: z.string().min(6).optional(),
});
r.patch('/users/:id', validateBody(editUserSchema), async (req, res, next) => {
  try {
    const { full_name, password } = req.body;
    const sets = []; const params = [];
    if (full_name) { params.push(full_name); sets.push(`full_name=$${params.length}`); }
    if (password)  { params.push(await bcrypt.hash(password, 12)); sets.push(`password_hash=$${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'Provide a name or a new password' });
    params.push(req.params.id);
    const { rows } = await query(
      `UPDATE users SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING id, full_name, email, role, status`, params);
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// Admin adds an applier (employee) or another admin manually — no OAuth needed for staff.
// Staff sign in with name + password, so a password is required (bcrypt-hashed).
// POST /api/admin/users  { full_name, email, role, password, daily_target? }
const newUserSchema = z.object({
  full_name: z.string().min(1),
  email: z.string().email(),
  role: z.enum(['employee', 'admin']).default('employee'),
  password: z.string().min(6),
  daily_target: z.coerce.number().int().positive().optional(),
});
r.post('/users', validateBody(newUserSchema), async (req, res, next) => {
  try {
    const { full_name, email, role = 'employee', password, daily_target } = req.body;
    const password_hash = await bcrypt.hash(password, 12);
    const { rows } = await query(
      `INSERT INTO users (email, full_name, role, status, password_hash)
       VALUES ($1,$2,$3,'active',$4)
       ON CONFLICT (email) DO UPDATE SET
         full_name=EXCLUDED.full_name, role=EXCLUDED.role, password_hash=EXCLUDED.password_hash
       RETURNING id, full_name, email, role, status`,
      [email, full_name, role, password_hash]);
    res.status(201).json({ user: rows[0], daily_target: daily_target || null });
  } catch (e) { next(e); }
});

// Admin invites a CLIENT (candidate). We create the account in 'invited' state and
// email a secure invite link. The client signs in with Google OAuth — we never
// create or store a password. invite_status flips to 'active' on first OAuth login.
// POST /api/admin/clients/invite  { full_name, email, plan?, referred_by? }
const inviteSchema = z.object({
  full_name: z.string().min(1),
  email: z.string().email(),
  plan: z.enum(USER_PLAN).default('free'),
  referred_by: z.string().nullable().optional(),
});
r.post('/clients/invite', validateBody(inviteSchema), async (req, res, next) => {
  try {
    const { full_name, email, plan = 'free', referred_by = null } = req.body;
    const { rows } = await query(
      `INSERT INTO users (email, full_name, role, plan, status, referred_by, invite_status)
       VALUES ($1,$2,'candidate',$3,'active',$4,'invited')
       ON CONFLICT (email) DO UPDATE SET full_name=EXCLUDED.full_name, plan=EXCLUDED.plan,
         referred_by=EXCLUDED.referred_by
       RETURNING id, full_name, email, plan, referred_by, invite_status`,
      [email, full_name, plan, referred_by]);
    // Send the OAuth invite email. Email failure must NOT fail the invite —
    // the client row is already created; we just report whether mail went out.
    let emailed = true;
    try { await notify.invite(email, full_name); }
    catch (e) { emailed = false; console.error('[invite mail]', e.message); }
    res.status(201).json({ invited: rows[0], emailed });
  } catch (e) { next(e); }
});

// Resend a pending client invite.
// POST /api/admin/clients/:id/resend-invite
r.post('/clients/:id/resend-invite', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT email, full_name, invite_status FROM users WHERE id=$1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    let emailed = true;
    try { await notify.invite(rows[0].email, rows[0].full_name); }
    catch (e) { emailed = false; console.error('[resend mail]', e.message); }
    res.json({ resent: emailed, email: rows[0].email });
  } catch (e) { next(e); }
});

// Admin override: client had no time to approve, so admin approves on their behalf.
// The job then flows to the applier exactly like a client-approved one.
// POST /api/admin/approvals/:approvalId/approve
r.post('/approvals/:approvalId/approve', async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE approvals
          SET decision='approved', approved_by_role='admin', decided_at=now()
        WHERE id=$1 AND decision='pending'
        RETURNING *`,
      [req.params.approvalId]);
    res.json(rows[0] || { message: 'Already decided' });
  } catch (e) { next(e); }
});

// Assign an employee (applier) to a candidate
const assignSchema = z.object({
  candidate_id: z.string().uuid(),
  employee_id: z.string().uuid(),
  daily_target: z.coerce.number().int().positive().optional(),
});
r.post('/assign', validateBody(assignSchema), async (req, res, next) => {
  try {
    const { candidate_id, employee_id, daily_target } = req.body;
    const { rows } = await query(
      `INSERT INTO assignments (candidate_id, employee_id, daily_target)
       VALUES ($1,$2,$3) ON CONFLICT (candidate_id, employee_id)
       DO UPDATE SET daily_target=EXCLUDED.daily_target, active=true RETURNING *`,
      [candidate_id, employee_id, daily_target || 45]);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// Manage plan (VIP / free)
const planSchema = z.object({ plan: z.enum(USER_PLAN) });
r.patch('/users/:id/plan', validateBody(planSchema), async (req, res, next) => {
  try { const { rows } = await query('UPDATE users SET plan=$1 WHERE id=$2 RETURNING id,plan', [req.body.plan, req.params.id]); res.json(rows[0]); }
  catch (e) { next(e); }
});

// Re-run scraper on demand.
// Body: {} for ALL clients, or { candidate_id } to target one client.
// When candidate_id is given, the scraper uses that candidate's job_interests
// keywords from their profile to target the search.
r.post('/scraper/run', scraperLimiter, async (req, res, next) => {
  try {
    const { candidate_id } = req.body || {};
    let interests = null, work_scope = null, work_locations = null;
    if (candidate_id) {
      const { rows } = await query(
        'SELECT job_interests, work_scope, work_locations FROM candidate_profiles WHERE candidate_id=$1', [candidate_id]);
      interests = rows[0]?.job_interests || [];
      work_scope = rows[0]?.work_scope || null;
      work_locations = rows[0]?.work_locations || [];
    }
    const result = await runScraper({ candidate_id: candidate_id || null, interests, work_scope, work_locations });

    // For a single client, kick off the AI recruiter filter + batch build in the
    // BACKGROUND (not awaited) so the request returns fast — the candidate's Batch
    // approval fills over the next minute or two. (The rich analysis is slow.)
    if (candidate_id) matchAndBatch(candidate_id, { limit: 5 });
    res.json({ mode: candidate_id ? 'single' : 'all', candidate_id: candidate_id || null, ...result, matching_started: !!candidate_id });
  } catch (e) { next(e); }
});

// Delete a user (client or employer). Cascades remove their related rows.
r.delete('/users/:id', async (req, res, next) => {
  try {
    await query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ deleted: req.params.id });
  } catch (e) { next(e); }
});

// Resume workflow — admin downloads the client's upload and uploads an ATS master resume.
// GET /api/admin/clients/:candidateId/resumes  -> list upload + master with status & signed URLs
r.get('/clients/:candidateId/resumes', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, file_name, file_url, kind, master_status, created_at
         FROM resumes WHERE candidate_id=$1 AND is_current=true ORDER BY kind`,
      [req.params.candidateId]);
    // In production, replace file_url with a short-lived signed download URL.
    res.json(rows);
  } catch (e) { next(e); }
});

// Admin downloads any of a client's resume files (original upload or master).
// GET /api/admin/clients/:candidateId/resume/:resumeId/file
r.get('/clients/:candidateId/resume/:resumeId/file', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT file_url, file_name FROM resumes WHERE id=$1 AND candidate_id=$2`,
      [req.params.resumeId, req.params.candidateId]);
    const r0 = rows[0];
    if (!r0) return res.status(404).json({ error: 'Resume not found' });
    const full = resolveStored(r0.file_url);
    if (!full) return res.status(404).json({ error: 'File missing on server' });
    res.download(full, r0.file_name);
  } catch (e) { next(e); }
});

// POST /api/admin/clients/:candidateId/master-resume  { file_url, file_name }
// Uploads the admin-built ATS master resume and sets it pending the client's approval.
r.post('/clients/:candidateId/master-resume', async (req, res, next) => {
  try {
    const { file_url, file_name } = req.body;
    await query(
      `UPDATE resumes SET is_current=false WHERE candidate_id=$1 AND kind='master'`,
      [req.params.candidateId]);
    const { rows } = await query(
      `INSERT INTO resumes (candidate_id, file_url, file_name, kind, master_status, is_current)
       VALUES ($1,$2,$3,'master','pending',true) RETURNING *`,
      [req.params.candidateId, file_url, file_name]);
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

// Admin uploads the ATS master resume as a real file (multipart, field "file").
// POST /api/admin/clients/:candidateId/master-resume/file
r.post('/clients/:candidateId/master-resume/file', uploadResume.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ats_keywords = req.body.ats_keywords ? JSON.parse(req.body.ats_keywords) : null;
    await query(`UPDATE resumes SET is_current=false WHERE candidate_id=$1 AND kind='master'`, [req.params.candidateId]);
    const { rows } = await query(
      `INSERT INTO resumes (candidate_id, file_url, file_name, kind, master_status, ats_keywords, is_current)
       VALUES ($1,$2,$3,'master','pending',$4,true) RETURNING *`,
      [req.params.candidateId, req.file.filename, req.file.originalname,
       ats_keywords ? JSON.stringify(ats_keywords) : null]);
    await createNotification(req.params.candidateId, 'master_ready', { resume_id: rows[0].id });
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

// Expand a batch (admin override) — AI suggests size, admin decides
r.post('/batches/:id/expand', async (req, res, next) => {
  try {
    const suggestion = await suggestBatchSize(req.body.stats || {});
    const size = req.body.size || suggestion.suggested_size;
    const { rows } = await query(
      `UPDATE batches SET target_size=$1, status='expanded' WHERE id=$2 RETURNING *`,
      [size, req.params.id]);
    res.json({ batch: rows[0], suggestion });
  } catch (e) { next(e); }
});

// Per-client approval summary for the admin dropdown:
// jobs received vs approved (by client or admin) vs rejected vs awaiting.
// GET /api/admin/clients/:candidateId/approval-summary
r.get('/clients/:candidateId/approval-summary', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT
          COUNT(*)                                                   AS jobs_received,
          COUNT(*) FILTER (WHERE decision='approved')                AS approved,
          COUNT(*) FILTER (WHERE decision='approved' AND approved_by_role='admin') AS admin_approved,
          COUNT(*) FILTER (WHERE decision='rejected')                AS rejected,
          COUNT(*) FILTER (WHERE decision='pending')                 AS awaiting
         FROM approvals WHERE candidate_id=$1`,
      [req.params.candidateId]);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// Jobs for a client with full descriptions, for the admin approvals screen.
// GET /api/admin/clients/:candidateId/jobs
r.get('/clients/:candidateId/jobs', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT a.id AS approval_id, a.decision, a.approved_by_role,
              m.score, j.title, j.company, j.description, j.ai_summary
         FROM approvals a
         JOIN job_matches m ON m.id=a.match_id
         JOIN jobs j ON j.id=m.job_id
        WHERE a.candidate_id=$1 ORDER BY m.score DESC`,
      [req.params.candidateId]);
    res.json(rows);
  } catch (e) { next(e); }
});

// Live board: every approved job and what the applier has done with it.
// Powers the admin "Live board" — counts + per-job status.
// GET /api/admin/live?candidate_id=  (optional filter to one client)
r.get('/live', async (req, res, next) => {
  try {
    const { candidate_id } = req.query;
    const filter = candidate_id ? ` AND ap.candidate_id = $1` : ``;
    const params = candidate_id ? [candidate_id] : [];
    const counts = await query(
      `SELECT
         COUNT(*)                                          AS approved_total,
         COUNT(*) FILTER (WHERE a.status='applied')        AS applied,
         COUNT(*) FILTER (WHERE a.status IN ('interview','offer')) AS responded,
         COUNT(*) FILTER (WHERE a.id IS NULL OR a.status='to_do') AS not_applied
       FROM approvals ap
       JOIN job_matches m ON m.id=ap.match_id
       LEFT JOIN applications a ON a.job_id=m.job_id AND a.candidate_id=ap.candidate_id
      WHERE ap.decision='approved'${filter}`, params);
    const rows = await query(
      `SELECT j.title, j.company, c.full_name AS client, e.full_name AS applier,
              COALESCE(a.status,'to_do') AS status, a.applied_at
         FROM approvals ap
         JOIN job_matches m ON m.id=ap.match_id
         JOIN jobs j ON j.id=m.job_id
         JOIN users c ON c.id=ap.candidate_id
         LEFT JOIN applications a ON a.job_id=m.job_id AND a.candidate_id=ap.candidate_id
         LEFT JOIN users e ON e.id=a.employee_id
        WHERE ap.decision='approved'${filter}
        ORDER BY a.applied_at DESC NULLS LAST
        LIMIT 200`, params);
    res.json({ counts: counts.rows[0], jobs: rows.rows });
  } catch (e) { next(e); }
});

// Admin overview metrics. GET /api/admin/metrics
r.get('/metrics', async (_req, res, next) => {
  try {
    const { rows: [m] } = await query(`
      SELECT
        (SELECT count(*) FROM users WHERE role='candidate' AND status='active')               AS active_candidates,
        (SELECT count(*) FROM users WHERE role='employee')                                     AS appliers,
        (SELECT count(*) FROM jobs WHERE scraped_at::date = CURRENT_DATE)                       AS jobs_today,
        (SELECT count(*) FROM applications WHERE status='applied' AND updated_at::date=CURRENT_DATE) AS applied_today,
        (SELECT count(*) FROM applications WHERE status='interview')                            AS interviews,
        (SELECT count(*) FROM applications WHERE status='offer')                                AS offers,
        (SELECT count(*) FROM approvals WHERE decision='pending')                               AS pending_approvals`);
    res.json(m);
  } catch (e) { next(e); }
});

// Per-applier performance. GET /api/admin/performance
r.get('/performance', async (_req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT e.id, e.full_name AS applier,
             (SELECT count(*) FROM assignments a WHERE a.employee_id=e.id AND a.active) AS clients,
             count(app.*) FILTER (WHERE app.status='applied' AND app.applied_at::date=CURRENT_DATE) AS applied_today,
             count(app.*) FILTER (WHERE app.status IN ('interview','offer')) AS responses
        FROM users e
        LEFT JOIN applications app ON app.employee_id=e.id
       WHERE e.role='employee'
       GROUP BY e.id, e.full_name
       ORDER BY applied_today DESC`);
    res.json(rows);
  } catch (e) { next(e); }
});

// Existing applier<->client assignments. GET /api/admin/assignments
r.get('/assignments', async (_req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT a.id, a.daily_target, a.active,
             c.id AS candidate_id, c.full_name AS candidate,
             e.id AS employee_id,  e.full_name AS applier
        FROM assignments a
        JOIN users c ON c.id=a.candidate_id
        JOIN users e ON e.id=a.employee_id
       WHERE a.active
       ORDER BY a.created_at DESC`);
    res.json(rows);
  } catch (e) { next(e); }
});

// Re-run AI matching on demand. POST /api/admin/matching/run  { candidate_id? }
r.post('/matching/run', async (req, res, next) => {
  try {
    const { candidate_id } = req.body || {};
    // Background matching so the request returns immediately.
    if (candidate_id) {
      matchAndBatch(candidate_id, { limit: 6 });
      return res.json({ mode: 'single', candidate_id, started: true });
    }
    const { rows: cands } = await query(`SELECT id FROM users WHERE role='candidate' AND status='active'`);
    for (const c of cands) matchAndBatch(c.id, { limit: 4 });
    res.json({ mode: 'all', candidates: cands.length, started: true });
  } catch (e) { next(e); }
});

// Generate today's reports on demand. POST /api/admin/reports/run
r.post('/reports/run', async (_req, res, next) => {
  try {
    await query(`
      INSERT INTO reports (scope, subject_id, metrics)
      SELECT 'candidate', candidate_id,
             jsonb_build_object(
               'applied',    count(*) FILTER (WHERE status='applied'),
               'interviews', count(*) FILTER (WHERE status='interview'),
               'offers',     count(*) FILTER (WHERE status='offer'))
        FROM applications WHERE updated_at::date = CURRENT_DATE
        GROUP BY candidate_id
      ON CONFLICT (scope, subject_id, report_date) DO UPDATE SET metrics=EXCLUDED.metrics`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
