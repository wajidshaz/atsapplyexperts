// =====================================================================
//  Daily workflow scheduler (node-cron). Times are server-local.
//  This is the ONLY place that turns AI suggestions into stored rows /
//  emails. The AI itself never triggers any of this.
// =====================================================================
import cron from 'node-cron';
import { query } from '../config/db.js';
import { runScraper } from '../services/scraper.js';
import { matchJob, simplifyJob } from '../services/openrouter.js';
import { notify } from '../services/mailer.js';
import { createNotification } from '../lib/notifications.js';
import { runGmailReplyScan } from '../services/gmail-reader.js';

// Build today's candidate job-matching + batch 1. Exported so it can also
// be triggered manually (admin tools / tests) instead of only by cron.
export async function runDailyMatch() {
  const { rows: candidates } = await query(
    `SELECT u.id, u.email, r.parsed_text,
            p.job_interests, p.work_scope, p.work_locations
       FROM users u
       JOIN resumes r ON r.candidate_id = u.id AND r.is_current AND r.kind='original'
       LEFT JOIN candidate_profiles p ON p.candidate_id = u.id
      WHERE u.role = 'candidate' AND u.status = 'active'`);

  let built = 0;
  for (const c of candidates) {
    // Idempotency: if batch 1 already exists for today, skip this candidate.
    const { rows: existing } = await query(
      `SELECT 1 FROM batches WHERE candidate_id=$1 AND batch_number=1
         AND created_at::date = CURRENT_DATE LIMIT 1`, [c.id]);
    if (existing[0]) continue;

    // Only score jobs relevant to this candidate's interests (keyword match
    // on title/description). Falls back to all of today's jobs if no interests set.
    const interests = Array.isArray(c.job_interests) ? c.job_interests : [];
    const params = [];
    let where = `scraped_at::date = CURRENT_DATE`;
    const relParts = [];
    const ors = [];
    for (const k of interests) {
      params.push(`%${k}%`); const i = params.length;
      relParts.push(`(CASE WHEN title ILIKE $${i} THEN 10 ELSE 0 END)`);
      relParts.push(`(CASE WHEN description ILIKE $${i} THEN 1 ELSE 0 END)`);
      ors.push(`(title ILIKE $${i} OR description ILIKE $${i})`);
    }
    if (ors.length) where += ` AND (${ors.join(' OR ')})`;
    const relExpr = relParts.length ? relParts.join(' + ') : '0';
    // Prioritize by title relevance so the most on-target jobs are scored first.
    const { rows: jobs } = await query(
      `SELECT * FROM jobs WHERE ${where} ORDER BY (${relExpr}) DESC, scraped_at DESC LIMIT 200`, params);

    for (const job of jobs) {
      const m = await matchJob(c.parsed_text, job);            // full recruiter analysis
      await query(
        `INSERT INTO job_matches (candidate_id, job_id, score, recommendation, reasoning, analysis)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (candidate_id, job_id) DO UPDATE SET
           score=EXCLUDED.score, recommendation=EXCLUDED.recommendation,
           reasoning=EXCLUDED.reasoning, analysis=EXCLUDED.analysis`,
        [c.id, job.id, m.score, m.recommendation, m.reasoning, m.analysis ? JSON.stringify(m.analysis) : null]);
    }

    // Assemble batch 1 from the top non-rejected matches (citizenship/clearance/gov are filtered out).
    const { rows: top } = await query(
      `SELECT id FROM job_matches WHERE candidate_id=$1 AND recommendation <> 'reject' ORDER BY score DESC LIMIT 10`, [c.id]);
    if (!top.length) continue;
    const { rows: [batch] } = await query(
      `INSERT INTO batches (candidate_id, batch_number, target_size, status)
       VALUES ($1, 1, 10, 'ready') RETURNING id`, [c.id]);
    for (const t of top) {
      await query(`INSERT INTO batch_items (batch_id, match_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [batch.id, t.id]);
      await query(
        `INSERT INTO approvals (batch_id, match_id, candidate_id) VALUES ($1,$2,$3)
         ON CONFLICT (batch_id, match_id) DO NOTHING`,
        [batch.id, t.id, c.id]);
    }
    try { await notify.batchReady(c.email, 1); } catch (e) { console.error('[mail]', e.message); }
    await createNotification(c.id, 'batch_ready', { batch_number: 1 });
    built++;
  }
  return { candidates: candidates.length, batches_built: built };
}

// Unlock batch 2 (top 35) for candidates whose batch 1 is submitted and who
// don't already have a batch 2. Exported for manual triggering too.
export async function unlockBatch2() {
  const { rows: ready } = await query(
    `SELECT b1.candidate_id FROM batches b1
      WHERE b1.batch_number=1 AND b1.status='submitted'
        AND NOT EXISTS (SELECT 1 FROM batches b2 WHERE b2.candidate_id=b1.candidate_id AND b2.batch_number=2)`);
  for (const { candidate_id } of ready) {
    const { rows: top } = await query(
      `SELECT id FROM job_matches WHERE candidate_id=$1 ORDER BY score DESC OFFSET 10 LIMIT 35`, [candidate_id]);
    if (!top.length) continue;
    const { rows: [batch] } = await query(
      `INSERT INTO batches (candidate_id, batch_number, target_size, status)
       VALUES ($1, 2, 35, 'ready') RETURNING id`, [candidate_id]);
    for (const t of top) {
      await query(`INSERT INTO batch_items (batch_id, match_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [batch.id, t.id]);
      await query(`INSERT INTO approvals (batch_id, match_id, candidate_id) VALUES ($1,$2,$3) ON CONFLICT (batch_id, match_id) DO NOTHING`,
        [batch.id, t.id, candidate_id]);
    }
    const { rows: [u] } = await query(`SELECT email FROM users WHERE id=$1`, [candidate_id]);
    if (u) { try { await notify.batchReady(u.email, 2); } catch {} }
    await createNotification(candidate_id, 'batch_ready', { batch_number: 2 });
  }
}

// 8:00 AM — scrape fresh listings
cron.schedule('0 8 * * *', async () => {
  const { inserted } = await runScraper();
  console.log(`[8:00] scraper inserted ${inserted} jobs`);
});

// 8:30 AM — AI matching + filtering, build batch 1 (10), notify candidates
cron.schedule('30 8 * * *', async () => {
  const r = await runDailyMatch();
  console.log(`[8:30] matched & built batch 1 for ${r.batches_built}/${r.candidates} candidates`);
});

// Every 2 hours during the work day — unlock batch 2 + scan for recruiter replies
cron.schedule('0 9-17/2 * * *', async () => {
  await unlockBatch2();
  await runGmailReplyScan();
});

// 3:30 PM — generate daily reports
cron.schedule('30 15 * * *', async () => {
  await query(
    `INSERT INTO reports (scope, subject_id, metrics)
     SELECT 'candidate', candidate_id,
            jsonb_build_object(
              'applied', count(*) FILTER (WHERE status='applied'),
              'interviews', count(*) FILTER (WHERE status='interview'),
              'offers', count(*) FILTER (WHERE status='offer'))
       FROM applications
      WHERE updated_at::date = CURRENT_DATE
      GROUP BY candidate_id
     ON CONFLICT (scope, subject_id, report_date) DO UPDATE SET metrics=EXCLUDED.metrics`,
  );
  console.log('[15:30] reports generated');
});

console.log('Scheduler running: 8:00 scrape · 8:30 match · 9-17/2 batch2+replies · 15:30 report');
