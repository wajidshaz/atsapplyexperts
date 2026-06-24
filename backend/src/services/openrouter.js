// =====================================================================
//  OpenRouter — all AI features (chat-based).
//
//  NOTE: OpenRouter no longer offers embedding models, so job matching is
//  done with the chat model (it also returns human-readable reasoning).
//
//  RULE: the AI only SUGGESTS. It never writes to the DB, sends email,
//  submits applications, or triggers automation. All callers treat its
//  output as advisory data that a human (or an explicit job) acts on.
// =====================================================================

const OR_BASE = 'https://openrouter.ai/api/v1';
const OR_KEY  = process.env.OPENROUTER_API_KEY;

// Free OpenRouter models are shared and frequently rate-limited (429). We try a
// list in order so that if one model is busy, the next can serve the request.
// OPENROUTER_CHAT_MODEL (single) is tried first; OPENROUTER_CHAT_MODELS overrides the list.
const DEFAULT_MODELS = [
  'google/gemma-4-31b-it:free',
  'openai/gpt-oss-20b:free',
  'openai/gpt-oss-120b:free',
  'nvidia/nemotron-nano-9b-v2:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
];
const MODELS = [...new Set([
  ...(process.env.OPENROUTER_CHAT_MODEL ? [process.env.OPENROUTER_CHAT_MODEL.trim()] : []),
  ...(process.env.OPENROUTER_CHAT_MODELS ? process.env.OPENROUTER_CHAT_MODELS.split(',').map(s => s.trim()) : DEFAULT_MODELS),
].filter(Boolean))];

// Cap input sizes so prompts stay within the model's context window.
const MAX_CHARS = 6000;

// ---- shared guardrail prepended to every system prompt ----
const GUARD =
  'You are an advisory assistant inside a job-application platform. ' +
  'You only analyse and suggest. You never claim to take actions, never ' +
  'apply to jobs, never send messages, and never modify records. ' +
  'Reply strictly in the requested format and nothing else.';

async function callChat(system, user, { json = false, maxTokens = 1200 } = {}) {
  if (!OR_KEY) throw new Error('OPENROUTER_API_KEY is not set in environment');
  const base = {
    temperature: 0.2,
    max_tokens: maxTokens, // room so reasoning-style models still emit content
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: user },
    ],
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  };

  // Try each model; on 429/503/empty/parse-failure, fall through to the next.
  // Two rounds total so a brief congestion blip still resolves.
  let lastErr;
  for (let round = 0; round < 2; round++) {
    for (const model of MODELS) {
      try {
        const res = await fetch(`${OR_BASE}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OR_KEY}` },
          body: JSON.stringify({ model, ...base }),
        });
        if (res.status === 429 || res.status === 503) { lastErr = new Error(`${model}: ${res.status} rate-limited`); continue; }
        if (!res.ok) { lastErr = new Error(`${model}: ${res.status} ${(await res.text()).slice(0, 150)}`); continue; }
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content ?? '';
        if (json && !text.trim()) { lastErr = new Error(`${model}: empty content`); continue; }
        if (!json) return text;
        let clean = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
        const m = clean.match(/\{[\s\S]*\}/);
        if (m) clean = m[0];
        return JSON.parse(clean);
      } catch (e) { lastErr = e; /* try the next model */ }
    }
    await new Promise(r => setTimeout(r, 2000)); // brief pause before the second round
  }
  throw lastErr || new Error('All OpenRouter models failed');
}

// =====================================================================
//  1. JOB MATCHING — full AI Recruiter analysis (rule-driven JSON).
//     Returns { score, recommendation, reasoning, analysis } where
//     analysis is the detailed recruiter report. Jobs requiring US
//     citizenship/clearance or that are government/defense are hard-rejected
//     (cheap regex) before spending an AI call.
// =====================================================================

// High-confidence instant-reject terms (rule 1 + clearance). Broad gov detection
// (rule 2) is left to the AI to avoid false positives on words like "federal holiday".
const GOV_CLEARANCE = /\b(u\.?s\.?\s*citizens?(\s*only|\s*required)?|must\s*be\s*a?\s*u\.?s\.?\s*citizen|citizenship\s*(is\s*)?required|security\s*clearance|secret\s*clearance|top\s*secret|public\s*trust|green\s*card\s*required|active\s*clearance|polygraph|\bdod\b|department\s*of\s*defense|us\s*persons?\s*only|government\s*contract|federal\s*contract)\b/i;

const RECRUITER_PROMPT = `You are an expert AI Recruiter and Resume Matching Specialist. Analyze a candidate's resume against a job description and decide if it's a strong match. Apply these rules strictly:

1. CITIZENSHIP (highest priority): If the job requires US Citizenship, Green Card, Security/Secret/Top Secret/Public Trust Clearance, or any government clearance (terms like "US Citizen only","Citizen required","Security Clearance","Public Trust","DoD","US Persons Only"), set status REJECTED with rejection_reason "Citizenship/Clearance Restriction".
2. GOVERNMENT FILTER: Reject government/federal/state/county/military/defense/public-sector/government-contractor roles. Only approve private-sector companies.
3. PRIVATE SECTOR: Verify employer is private. If government-related or unclear, set status MANUAL_REVIEW.
4. RESUME MATCH: Compare experience, skills, tools, technologies, certifications, education, domain. List matching and missing skills.
5. SCORING WEIGHTS: Technical Skills 40, Relevant Experience 25, Industry/Domain 10, Tools & Tech 10, Education/Certs 5, Keyword 10. overall_match_score is 0-100.
6. VISA SPONSORSHIP: Detect Yes / No / Not Mentioned.
7. EMPLOYMENT: type (Full-time/Contract/C2C/W2/1099/Part-time), work_mode (Remote/Hybrid/Onsite), relocation_required.
8. RED FLAGS: unrealistic pay, vague desc, upfront payment, personal-email recruiters, spam.
9. SENIORITY: level (Intern/Junior/Mid/Senior/Lead/Principal) vs candidate experience (Overqualified/Aligned/Underqualified).
10. SALARY: extract range; assess Above/At/Below Market.
11. ATS KEYWORDS: top JD keywords missing from the resume.
12. SKILL GAP: quick way to address each missing critical skill.
13. PRIORITY: application_priority "1-5 stars".
14. CONFIDENCE: High/Medium/Low based on data completeness.
15. MATCH LEVEL: 90-100 Excellent, 75-89 Good, 60-74 Average, <60 Poor.
17. FINAL: one of APPLY IMMEDIATELY / APPLY WITH RESUME MODIFICATION / LOW PRIORITY / DO NOT APPLY.

Return ONLY this JSON (no prose, no markdown):
{"job_title":"","company_name":"","company_type":"Private/Government/Unknown","citizenship_requirement_found":false,"clearance_requirement_found":false,"government_related":false,"visa_sponsorship_available":"Yes/No/Not Mentioned","employment_type":"","work_mode":"Remote/Hybrid/Onsite","relocation_required":false,"seniority_level":"","seniority_alignment":"Overqualified/Aligned/Underqualified","salary_range":"","salary_assessment":"Above/At/Below Market","red_flags_detected":[],"status":"APPROVED/REJECTED/MANUAL_REVIEW","overall_match_score":0,"match_level":"Excellent/Good/Average/Poor","confidence_score":"High/Medium/Low","matching_skills":[],"missing_skills":[],"missing_ats_keywords":[],"skill_gap_suggestions":[],"years_of_experience_required":"","candidate_experience":"","summary":"","rejection_reason":"","application_priority":"1-5 stars","final_recommendation":"APPLY IMMEDIATELY/APPLY WITH RESUME MODIFICATION/LOW PRIORITY/DO NOT APPLY"}`;

function rejectedAnalysis(job, reason) {
  return {
    job_title: job.title, company_name: job.company, company_type: 'Government',
    citizenship_requirement_found: true, clearance_requirement_found: true, government_related: true,
    status: 'REJECTED', overall_match_score: 0, match_level: 'Poor', confidence_score: 'High',
    rejection_reason: reason, summary: reason, final_recommendation: 'DO NOT APPLY', application_priority: '1 star',
  };
}

export async function matchJob(resumeText, job) {
  const hay = `${job.title || ''} ${job.company || ''} ${job.description || ''}`;
  // Rule 1 hard filter — reject without spending an AI call.
  if (GOV_CLEARANCE.test(hay)) {
    const reason = 'Citizenship/Clearance Restriction';
    return { score: 0, recommendation: 'reject', reasoning: reason, analysis: rejectedAnalysis(job, reason) };
  }

  const user = `RESUME:\n${(resumeText || '').slice(0, MAX_CHARS)}\n\nJOB DESCRIPTION:\nTitle: ${job.title}\nCompany: ${job.company}\nLocation: ${job.location || 'Not specified'}\nSalary: ${job.salary || 'Not listed'}\n\n${(job.description || '').slice(0, MAX_CHARS)}`;

  let out;
  try {
    out = await callChat(RECRUITER_PROMPT, user, { json: true, maxTokens: 1800 });
  } catch (e) {
    // AI unavailable → leave it for manual review rather than dropping it.
    return { score: 0, recommendation: 'review', reasoning: 'AI analysis unavailable', analysis: { status: 'MANUAL_REVIEW', overall_match_score: 0, summary: 'AI analysis unavailable' } };
  }

  const score = Math.max(0, Math.min(100, parseInt(out.overall_match_score, 10) || 0));
  // Derive the gate DETERMINISTICALLY from the score, not the model's free-text
  // `status` (free models set it inconsistently — e.g. "APPROVED" at 32). This
  // keeps the recommendation aligned with the match-level rubric every time:
  //   >=75 Good/Excellent -> approve · 60-74 Average -> review · <60 Poor -> reject
  let status = score >= 75 ? 'APPROVED' : score >= 60 ? 'MANUAL_REVIEW' : 'REJECTED';
  // Enforce rule 1/2 (citizenship/clearance/government) even if the score is high.
  if (out.citizenship_requirement_found || out.clearance_requirement_found || out.government_related) status = 'REJECTED';

  out.overall_match_score = score;
  out.status = status;
  if (!out.match_level) out.match_level = score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 60 ? 'Average' : 'Poor';
  out.job_title = out.job_title || job.title;
  out.company_name = out.company_name || job.company;

  const recommendation = status === 'APPROVED' ? 'approve' : status === 'REJECTED' ? 'reject' : 'review';
  return { score, recommendation, reasoning: out.summary || out.final_recommendation || '', analysis: out };
}

// =====================================================================
//  2. RESUME ANALYSIS — skills + strength score
// =====================================================================
export function analyzeResume(resumeText) {
  const system = `${GUARD}
Analyse a resume. Return JSON only:
{"skills": ["<top 5-10 hard skills>"], "strength": <int 0-100>, "summary": "<one sentence>"}`;
  return callChat(system, (resumeText || '').slice(0, MAX_CHARS), { json: true });
}

// =====================================================================
//  3. JOB DESCRIPTION SIMPLIFICATION
// =====================================================================
export function simplifyJob(description) {
  const system = `${GUARD}
Rewrite a job description as 1-2 plain sentences a busy person can scan.
State what they'd actually do day to day. No buzzwords. Return plain text only.`;
  return callChat(system, (description || '').slice(0, MAX_CHARS));
}

// =====================================================================
//  4. RECOMMENDATION — re-check edge cases on a scored match
// =====================================================================
export function recommend(score, reasoning) {
  const system = `${GUARD}
Given a match score and reasoning, output JSON only:
{"recommendation": "approve"|"reject"|"review", "why": "<short>"}`;
  return callChat(system, `score: ${score}\nreasoning: ${reasoning}`, { json: true });
}

// =====================================================================
//  5. BATCH EXPANSION — suggest next batch size
// =====================================================================
export function suggestBatchSize(stats) {
  const system = `${GUARD}
Suggest the next batch size for a candidate based on their behaviour. Return JSON only:
{"suggested_size": <int>, "reason": "<short>"}
Heuristics: high approval rate + fast review -> larger; many rejects or slow -> smaller.
Never exceed 50 in one batch.`;
  return callChat(system, JSON.stringify(stats), { json: true });
}
