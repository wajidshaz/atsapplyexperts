import { Router } from 'express';
import { query } from '../config/db.js';
import { analyzeResume } from '../services/openrouter.js';
import { requireAuth, requireRole, requireSelfOrAdmin } from '../middleware/auth.js';
import { encrypt } from '../lib/crypto.js';
import { createNotification } from '../lib/notifications.js';
import { validateBody, z } from '../middleware/validate.js';
import { uploadResume, extractText, resolveStored } from '../lib/upload.js';
import { scoreCandidate, buildBatchOne, matchAndBatch } from '../lib/matching.js';
const r = Router();

r.use(requireAuth);

// Current resume + AI analysis + master-resume status (for the Resume screen).
// GET /api/candidates/:id/resume
r.get('/:id/resume', requireSelfOrAdmin('id'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT kind, file_name, ai_skills, ai_strength, master_status, ats_keywords, created_at
         FROM resumes WHERE candidate_id=$1 AND is_current=true`, [req.params.id]);
    const original = rows.find(r => r.kind === 'original') || null;
    const master   = rows.find(r => r.kind === 'master') || null;
    res.json({
      original: original && { file_name: original.file_name, ai_skills: original.ai_skills || [], ai_strength: original.ai_strength },
      master:   master && { file_name: master.file_name, master_status: master.master_status, ats_keywords: master.ats_keywords || [] },
    });
  } catch (e) { next(e); }
});

// Candidate overview metrics. GET /api/candidates/:id/metrics
r.get('/:id/metrics', requireSelfOrAdmin('id'), async (req, res, next) => {
  try {
    const id = req.params.id;
    const { rows: [m] } = await query(`
      SELECT
        (SELECT count(*) FROM job_matches WHERE candidate_id=$1)                                  AS matches,
        (SELECT count(*) FROM approvals WHERE candidate_id=$1 AND decision='pending')             AS pending_approval,
        (SELECT count(*) FROM applications WHERE candidate_id=$1 AND status IN ('to_do','applied')) AS in_progress,
        (SELECT count(*) FROM applications WHERE candidate_id=$1 AND status='interview')           AS interviews,
        (SELECT count(*) FROM applications WHERE candidate_id=$1 AND status='offer')               AS offers,
        (SELECT count(*) FROM applications WHERE candidate_id=$1 AND status='applied')             AS applied`,
      [id]);
    res.json(m);
  } catch (e) { next(e); }
});

// "Find my matches" — score recent jobs for this candidate now.
// POST /api/candidates/:id/rescore
r.post('/:id/rescore', requireSelfOrAdmin('id'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT 1 FROM resumes WHERE candidate_id=$1 AND is_current AND kind='original' LIMIT 1`, [req.params.id]);
    if (!rows[0]) return res.json({ reason: 'no_resume' });
    matchAndBatch(req.params.id, { limit: 6 }); // background — fills the batch over ~1-2 min
    res.json({ started: true });
  } catch (e) { next(e); }
});

// Download the candidate's own resume file (original or master).
// GET /api/candidates/:id/resume/file?kind=original|master
r.get('/:id/resume/file', requireSelfOrAdmin('id'), async (req, res, next) => {
  try {
    const kind = req.query.kind === 'master' ? 'master' : 'original';
    const { rows } = await query(
      `SELECT file_url, file_name FROM resumes WHERE candidate_id=$1 AND kind=$2 AND is_current=true LIMIT 1`,
      [req.params.id, kind]);
    const r0 = rows[0];
    if (!r0) return res.status(404).json({ error: 'No resume on file' });
    const full = resolveStored(r0.file_url);
    if (!full) return res.status(404).json({ error: 'File missing on server' });
    res.download(full, r0.file_name);
  } catch (e) { next(e); }
});

// Merge incoming accounts ({provider:{user,password}}) with what's stored,
// encrypting any newly-supplied passwords and preserving existing ones.
function mergeAccounts(incoming, existing) {
  if (!incoming) return existing || null;
  const out = { ...(existing || {}) };
  for (const [provider, val] of Object.entries(incoming)) {
    const prev = out[provider] || {};
    out[provider] = { user: val.user ?? prev.user ?? '' };
    if (val.password) out[provider].enc_pw = encrypt(val.password);   // new password → encrypt
    else if (prev.enc_pw) out[provider].enc_pw = prev.enc_pw;          // keep existing
  }
  return out;
}

// Upload resume metadata + run AI analysis (suggest only).
// NOTE: file ingestion via multipart lives at POST /:id/resume/file (uploads.js).
r.post('/:id/resume', requireSelfOrAdmin('id'), async (req, res, next) => {
  try {
    const { file_url, file_name, parsed_text } = req.body;
    const ai = await analyzeResume(parsed_text);
    await query('UPDATE resumes SET is_current=false WHERE candidate_id=$1', [req.params.id]);
    const { rows } = await query(
      `INSERT INTO resumes (candidate_id,file_url,file_name,parsed_text,ai_skills,ai_strength,is_current)
       VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING *`,
      [req.params.id, file_url, file_name, parsed_text, JSON.stringify(ai.skills), ai.strength],
    );
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// Real file upload: client uploads a resume; we extract text server-side,
// run AI analysis, and store the resume row. multipart/form-data, field "file".
// POST /api/candidates/:id/resume/file
r.post('/:id/resume/file', requireSelfOrAdmin('id'), uploadResume.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const parsed_text = await extractText(req.file.path, req.file.mimetype);
    const ai = await analyzeResume(parsed_text || req.file.originalname);
    await query('UPDATE resumes SET is_current=false WHERE candidate_id=$1 AND kind=\'original\'', [req.params.id]);
    const { rows } = await query(
      `INSERT INTO resumes (candidate_id,file_url,file_name,parsed_text,ai_skills,ai_strength,kind,is_current)
       VALUES ($1,$2,$3,$4,$5,$6,'original',true) RETURNING id, file_name, ai_skills, ai_strength`,
      [req.params.id, req.file.filename, req.file.originalname, parsed_text,
       JSON.stringify(ai.skills || []), ai.strength ?? null],
    );
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

// AI job matches for a candidate
r.get('/:id/matches', requireSelfOrAdmin('id'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT m.score, m.recommendation, m.reasoning, m.analysis, j.*
         FROM job_matches m JOIN jobs j ON j.id=m.job_id
        WHERE m.candidate_id=$1 AND m.recommendation <> 'reject'
        ORDER BY m.score DESC`, [req.params.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

// Application tracking
r.get('/:id/applications', requireSelfOrAdmin('id'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT a.status, a.applied_at, j.title, j.company, e.full_name AS applied_by
         FROM applications a JOIN jobs j ON j.id=a.job_id
         LEFT JOIN users e ON e.id=a.employee_id
        WHERE a.candidate_id=$1 ORDER BY a.updated_at DESC`, [req.params.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

// Get profile (account passwords stripped — only usernames + "set" flags returned)
r.get('/:id/profile', requireSelfOrAdmin('id'), async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM candidate_profiles WHERE candidate_id=$1', [req.params.id]);
    const p = rows[0];
    if (p && p.accounts) {
      for (const k of Object.keys(p.accounts)) {
        p.accounts[k] = { user: p.accounts[k].user || '', has_password: !!p.accounts[k].enc_pw };
      }
    }
    res.json(p || null);
  } catch (e) { next(e); }
});

// Save / update profile (upsert). Account passwords are encrypted at the app layer.
r.put('/:id/profile', requireSelfOrAdmin('id'), async (req, res, next) => {
  try {
    const b = req.body;
    // Merge + encrypt account credentials against what's already stored.
    let accounts = null;
    if (b.accounts) {
      const { rows: ex } = await query('SELECT accounts FROM candidate_profiles WHERE candidate_id=$1', [req.params.id]);
      accounts = JSON.stringify(mergeAccounts(b.accounts, ex[0]?.accounts));
    }
    const { rows } = await query(
      `INSERT INTO candidate_profiles
        (candidate_id, accounts, first_name, last_name, dob, street, apartment, city, state, zip, country,
         expected_salary, relocate, masters_school, masters_course, masters_start, masters_end,
         bachelors_school, bachelors_course, bachelors_start, bachelors_end,
         legally_authorized, sponsorship, visa_status, citizenship, clearance, sex, disability, veteran,
         convicted_felony, food_stamp, tanf, unemployment_benefits, agreements_accepted, job_interests,
         work_scope, work_locations, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37, now())
       ON CONFLICT (candidate_id) DO UPDATE SET
         accounts=COALESCE(EXCLUDED.accounts, candidate_profiles.accounts),
         first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name, dob=EXCLUDED.dob,
         street=EXCLUDED.street, apartment=EXCLUDED.apartment, city=EXCLUDED.city, state=EXCLUDED.state,
         zip=EXCLUDED.zip, country=EXCLUDED.country, expected_salary=EXCLUDED.expected_salary,
         relocate=EXCLUDED.relocate, masters_school=EXCLUDED.masters_school, masters_course=EXCLUDED.masters_course,
         masters_start=EXCLUDED.masters_start, masters_end=EXCLUDED.masters_end,
         bachelors_school=EXCLUDED.bachelors_school, bachelors_course=EXCLUDED.bachelors_course,
         bachelors_start=EXCLUDED.bachelors_start, bachelors_end=EXCLUDED.bachelors_end,
         legally_authorized=EXCLUDED.legally_authorized, sponsorship=EXCLUDED.sponsorship,
         visa_status=EXCLUDED.visa_status, citizenship=EXCLUDED.citizenship, clearance=EXCLUDED.clearance,
         sex=EXCLUDED.sex, disability=EXCLUDED.disability, veteran=EXCLUDED.veteran,
         convicted_felony=EXCLUDED.convicted_felony, food_stamp=EXCLUDED.food_stamp, tanf=EXCLUDED.tanf,
         unemployment_benefits=EXCLUDED.unemployment_benefits, agreements_accepted=EXCLUDED.agreements_accepted,
         job_interests=EXCLUDED.job_interests,
         work_scope=EXCLUDED.work_scope, work_locations=EXCLUDED.work_locations,
         updated_at=now()
       RETURNING candidate_id, updated_at`,
      [req.params.id, accounts, b.first_name, b.last_name, b.dob, b.street, b.apartment, b.city, b.state, b.zip,
       b.country, b.expected_salary, b.relocate, b.masters_school, b.masters_course, b.masters_start, b.masters_end,
       b.bachelors_school, b.bachelors_course, b.bachelors_start, b.bachelors_end, b.legally_authorized,
       b.sponsorship, b.visa_status, b.citizenship, b.clearance, b.sex, b.disability, b.veteran,
       b.convicted_felony, b.food_stamp, b.tanf, b.unemployment_benefits, !!b.agreements_accepted,
       b.job_interests ? JSON.stringify(b.job_interests) : null,
       b.work_scope || null,
       b.work_locations ? JSON.stringify(b.work_locations) : null]);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// Client approves or requests changes to the ATS master resume (legacy path).
// POST /api/candidates/:id/master-resume/decision  { decision }
const decisionSchema = z.object({ decision: z.enum(['approved', 'rejected']) });
r.post('/:id/master-resume/decision', requireSelfOrAdmin('id'), validateBody(decisionSchema), async (req, res, next) => {
  try {
    const { decision } = req.body;
    const { rows } = await query(
      `UPDATE resumes SET master_status=$1, approved_at = CASE WHEN $1='approved' THEN now() ELSE NULL END
        WHERE candidate_id=$2 AND kind='master' AND is_current=true
        RETURNING id, master_status`,
      [decision, req.params.id]);
    res.json(rows[0] || { message: 'No master resume to decide on' });
  } catch (e) { next(e); }
});

// Admin uploads a MASTER (ATS-optimized) resume for a candidate and sends it for approval.
// POST /api/candidates/:id/master-resume  { file_url, file_name, ats_keywords }
r.post('/:id/master-resume', requireRole('admin'), async (req, res, next) => {
  try {
    const { file_url, file_name, ats_keywords } = req.body;
    await query(`UPDATE resumes SET is_current=false WHERE candidate_id=$1 AND kind='master'`, [req.params.id]);
    const { rows } = await query(
      `INSERT INTO resumes (candidate_id, file_url, file_name, kind, master_status, ats_keywords, is_current)
       VALUES ($1,$2,$3,'master','pending',$4,true) RETURNING *`,
      [req.params.id, file_url, file_name, ats_keywords ? JSON.stringify(ats_keywords) : null]);
    await createNotification(req.params.id, 'master_ready', { resume_id: rows[0].id });
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

// Client approves or rejects the master resume.
// PATCH /api/candidates/:id/master-resume  { decision }
r.patch('/:id/master-resume', requireSelfOrAdmin('id'), validateBody(decisionSchema), async (req, res, next) => {
  try {
    const { decision } = req.body;
    const { rows } = await query(
      `UPDATE resumes SET master_status=$1, approved_at = CASE WHEN $1='approved' THEN now() ELSE NULL END
        WHERE candidate_id=$2 AND kind='master' AND is_current=true RETURNING *`,
      [decision, req.params.id]);
    res.json(rows[0] || { message: 'No master resume to update' });
  } catch (e) { next(e); }
});

export default r;
