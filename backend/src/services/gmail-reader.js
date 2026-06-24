// =====================================================================
//  Gmail reply tracking (READ-ONLY use of each client's own inbox).
//
//  Each candidate who granted gmail.readonly at sign-in has a refresh
//  token stored in users.email_read_token. We use it server-side only to
//  scan recent inbox messages, heuristically classify recruiter replies
//  (interview / offer / rejection), and advance the matching application's
//  status. We never send mail with this token and never store raw email
//  bodies — only the resulting status change + a short notification.
//
//  This matching is heuristic (company name / sender domain appearing in
//  the subject or snippet). It is intentionally conservative: it only ever
//  moves an application forward (applied → interview/offer) or to rejected,
//  never backwards, and logs what it changed.
// =====================================================================
import { google } from 'googleapis';
import { query } from '../config/db.js';
import { createNotification } from '../lib/notifications.js';

const INTERVIEW = /\b(interview|schedule a call|availability|next steps|meet (the|with) (team|hiring))\b/i;
const OFFER     = /\b(offer letter|pleased to offer|extend an offer|job offer)\b/i;
const REJECT    = /\b(unfortunately|not moving forward|decided not to|regret to inform|other candidates)\b/i;

function classify(text) {
  if (OFFER.test(text)) return 'offer';
  if (REJECT.test(text)) return 'rejected';
  if (INTERVIEW.test(text)) return 'interview';
  return null;
}

// Forward-only ranking so a later weaker signal can't undo a stronger one.
const RANK = { to_do: 0, applied: 1, interview: 2, offer: 3, rejected: 3 };
function shouldAdvance(current, next) {
  if (next === 'rejected') return current !== 'offer'; // don't overwrite a real offer
  return (RANK[next] ?? 0) > (RANK[current] ?? 0);
}

function header(msg, name) {
  return (msg.payload?.headers || []).find(h => h.name === name)?.value || '';
}

async function scanCandidate(c) {
  const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: c.email_read_token });
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });

  // Candidate's open applications + the company we applied to.
  const { rows: apps } = await query(
    `SELECT a.id, a.status, lower(j.company) AS company
       FROM applications a JOIN jobs j ON j.id=a.job_id
      WHERE a.candidate_id=$1 AND a.status IN ('applied','to_do','interview')`,
    [c.id]);
  if (!apps.length) return 0;

  const list = await gmail.users.messages.list({ userId: 'me', q: 'newer_than:2d', maxResults: 25 });
  let updated = 0;
  for (const ref of list.data.messages || []) {
    const msg = (await gmail.users.messages.get({
      userId: 'me', id: ref.id, format: 'metadata', metadataHeaders: ['From', 'Subject'],
    })).data;
    const from = header(msg, 'From').toLowerCase();
    const subject = header(msg, 'Subject');
    const haystack = `${subject} ${msg.snippet || ''}`.toLowerCase();
    const verdict = classify(`${subject} ${msg.snippet || ''}`);
    if (!verdict) continue;

    // Match to an application by company name appearing in subject/snippet/sender.
    const match = apps.find(a => a.company && a.company.length > 2 &&
      (haystack.includes(a.company) || from.includes(a.company.replace(/\s+/g, ''))));
    if (!match || !shouldAdvance(match.status, verdict)) continue;

    await query(`UPDATE applications SET status=$1, updated_at=now() WHERE id=$2`, [verdict, match.id]);
    await createNotification(c.id, 'status_update', { status: verdict, source: 'email', subject });
    match.status = verdict;
    updated++;
  }
  return updated;
}

// Scan every consenting candidate. Best-effort: one failure never aborts the rest.
export async function runGmailReplyScan() {
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.warn('[gmail-reader] GOOGLE_CLIENT_ID not set — skipping reply scan');
    return { scanned: 0, updated: 0 };
  }
  const { rows: candidates } = await query(
    `SELECT id, email, email_read_token FROM users
      WHERE role='candidate' AND email_scope_granted=true AND email_read_token IS NOT NULL`);
  let updated = 0;
  for (const c of candidates) {
    try { updated += await scanCandidate(c); }
    catch (e) { console.error(`[gmail-reader] ${c.email}:`, e.message); }
  }
  console.log(`[gmail-reader] scanned ${candidates.length} inboxes, advanced ${updated} applications`);
  return { scanned: candidates.length, updated };
}
