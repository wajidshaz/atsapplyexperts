// On-demand AI matching for a single candidate. Shared by the admin
// "re-run matching" action and the candidate "find my matches" button, so we
// don't import the cron scheduler (which would register timers) into routes.
import { query } from '../config/db.js';
import { matchJob } from '../services/openrouter.js';

// Score the candidate's jobs against their resume — STEP 1: analyze the
// candidate (resume + preferred titles + interests + work scope); STEP 2: fetch
// & PRIORITIZE jobs by relevance to those titles/interests; STEP 3: AI-compare
// each JD to the resume, best matches first.
// Capped (default 8) because each job is a sequential AI call. Upserts job_matches.
export async function scoreCandidate(candidateId, { limit = 8 } = {}) {
  // ---- STEP 1: analyze the candidate ----
  const { rows: cand } = await query(
    `SELECT r.parsed_text, p.job_interests, p.work_scope, p.work_locations
       FROM users u
       JOIN resumes r ON r.candidate_id=u.id AND r.is_current AND r.kind='original'
       LEFT JOIN candidate_profiles p ON p.candidate_id=u.id
      WHERE u.id=$1 LIMIT 1`, [candidateId]);
  if (!cand[0]) return { scored: 0, reason: 'no_resume' };

  const resumeText = cand[0].parsed_text || '';
  const interests = Array.isArray(cand[0].job_interests) ? cand[0].job_interests : [];
  const workScope = cand[0].work_scope || '';
  const workLocations = Array.isArray(cand[0].work_locations) ? cand[0].work_locations : [];

  // ---- STEP 2: fetch + PRIORITIZE by relevance ----
  // Only consider jobs not yet scored for this candidate (so each run advances
  // through the pool). Rank by a relevance score so the limited AI budget is
  // spent on the BEST title matches first, not whatever was scraped most recently:
  //   title matches a preferred title/interest .. +10 each  (strongest signal)
  //   description mentions an interest ......... +1  each
  //   matches the candidate's work scope/location +3
  const params = [candidateId];
  let where = `j.scraped_at::date >= CURRENT_DATE - INTERVAL '30 days'
    AND NOT EXISTS (SELECT 1 FROM job_matches jm WHERE jm.candidate_id=$1 AND jm.job_id=j.id)`;

  const relParts = [];
  const matchOrs = [];
  for (const k of interests) {
    params.push(`%${k}%`); const i = params.length;
    relParts.push(`(CASE WHEN j.title ILIKE $${i} THEN 10 ELSE 0 END)`);
    relParts.push(`(CASE WHEN j.description ILIKE $${i} THEN 1 ELSE 0 END)`);
    matchOrs.push(`j.title ILIKE $${i} OR j.description ILIKE $${i}`);
  }
  // Work-scope / location preference adds a smaller boost.
  if (workScope === 'remote') {
    relParts.push(`(CASE WHEN j.location ILIKE '%remote%' OR j.title ILIKE '%remote%' THEN 3 ELSE 0 END)`);
  } else if (workScope === 'states' && workLocations.length) {
    for (const loc of workLocations) {
      params.push(`%${loc}%`); const i = params.length;
      relParts.push(`(CASE WHEN j.location ILIKE $${i} THEN 3 ELSE 0 END)`);
    }
  }
  const relExpr = relParts.length ? relParts.join(' + ') : '0';
  // If the candidate has interests, restrict to jobs matching at least one;
  // otherwise fall back to all recent jobs.
  if (matchOrs.length) where += ` AND (${matchOrs.join(' OR ')})`;

  params.push(limit);
  const { rows: jobs } = await query(
    `SELECT j.*, (${relExpr}) AS relevance
       FROM jobs j WHERE ${where}
      ORDER BY relevance DESC, j.scraped_at DESC
      LIMIT $${params.length}`, params);

  // ---- STEP 3: AI-compare each JD to the resume, best matches first ----
  if (jobs.length) {
    console.log(`[scoreCandidate] ${candidateId}: scoring ${jobs.length} job(s) in priority order:`);
    jobs.forEach(j => console.log(`  · rel ${j.relevance}  ${j.title}`));
  }
  let scored = 0;
  for (const job of jobs) {
    try {
      const m = await matchJob(resumeText, job); // full recruiter analysis
      await query(
        `INSERT INTO job_matches (candidate_id, job_id, score, recommendation, reasoning, analysis)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (candidate_id, job_id) DO UPDATE SET
           score=EXCLUDED.score, recommendation=EXCLUDED.recommendation,
           reasoning=EXCLUDED.reasoning, analysis=EXCLUDED.analysis`,
        [candidateId, job.id, m.score, m.recommendation, m.reasoning, m.analysis ? JSON.stringify(m.analysis) : null]);
      scored++;
    } catch (e) { /* skip a job that fails to score (rate-limit etc.) */ }
  }
  return { scored, available: jobs.length };
}

// Score new jobs + build the batch. Used fire-and-forget (NOT awaited) by routes
// so the slow AI work runs in the background and never times out the request.
export async function matchAndBatch(candidateId, { limit = 5 } = {}) {
  try {
    const s = await scoreCandidate(candidateId, { limit });
    const b = await buildBatchOne(candidateId);
    console.log(`[matchAndBatch] ${candidateId}: scored ${s.scored ?? 0}, +${b.items ?? 0} to batch`);
    return { scored: s.scored ?? 0, batch_items: b.items ?? 0, reason: s.reason };
  } catch (e) {
    console.error('[matchAndBatch]', candidateId, e.message);
    return { error: e.message };
  }
}

// Build / refresh the candidate's Batch 1 from their top-scored matches, so the
// daily-scraped & scored jobs actually appear on the Batch approval screen.
export async function buildBatchOne(candidateId, { size = 10 } = {}) {
  // Top passing matches (rule-filter passed) that are NOT already in a batch and
  // NOT already an application — so submitted/applied jobs never re-appear, and a
  // fresh scrape surfaces only NEW jobs.
  const { rows: top } = await query(
    `SELECT m.id FROM job_matches m
      WHERE m.candidate_id=$1 AND m.recommendation <> 'reject'
        AND NOT EXISTS (SELECT 1 FROM batch_items bi WHERE bi.match_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.candidate_id = m.candidate_id AND a.job_id = m.job_id)
      ORDER BY m.score DESC LIMIT $2`,
    [candidateId, size]);
  if (!top.length) return { batch: null, items: 0 };

  // Reuse an OPEN (awaiting-review) batch; otherwise start a new numbered one.
  let { rows: [b] } = await query(
    `SELECT id FROM batches WHERE candidate_id=$1 AND status IN ('ready','draft','expanded')
      ORDER BY created_at DESC LIMIT 1`, [candidateId]);
  if (!b) {
    const { rows: [mx] } = await query(
      `SELECT COALESCE(MAX(batch_number),0)+1 AS n FROM batches WHERE candidate_id=$1`, [candidateId]);
    ({ rows: [b] } = await query(
      `INSERT INTO batches (candidate_id, batch_number, target_size, status)
       VALUES ($1, $2, $3, 'ready') RETURNING id`, [candidateId, mx.n, size]));
  }
  let items = 0;
  for (const t of top) {
    await query(`INSERT INTO batch_items (batch_id, match_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [b.id, t.id]);
    await query(
      `INSERT INTO approvals (batch_id, match_id, candidate_id) VALUES ($1,$2,$3)
       ON CONFLICT (batch_id, match_id) DO NOTHING`, [b.id, t.id, candidateId]);
    items++;
  }
  return { batch: b.id, items };
}
