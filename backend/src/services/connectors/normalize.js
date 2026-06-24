// Shared helpers so every connector returns the same clean shape.

// Strip HTML tags to plain text (descriptions come back as HTML on some providers).
export function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|li|br|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Rough experience level from the job title (real signal; not perfect).
export function guessLevel(title = '') {
  const t = title.toLowerCase();
  if (/\b(intern|internship)\b/.test(t)) return 'Entry';
  if (/\b(lead|principal|staff|head of|director|vp)\b/.test(t)) return 'Lead';
  if (/\b(senior|sr\.?|sr )\b/.test(t)) return 'Senior';
  if (/\b(junior|jr\.?|entry|graduate|associate)\b/.test(t)) return 'Entry';
  return 'Mid';
}

// Rough job type from title/description.
export function guessType(title = '', desc = '') {
  const s = `${title} ${desc}`.toLowerCase();
  if (/\b(intern|internship)\b/.test(s)) return 'Internship';
  if (/\b(contract|contractor|freelance|temporary|temp)\b/.test(s)) return 'Contract';
  if (/\bpart[- ]time\b/.test(s)) return 'Part-time';
  return 'Full-time';
}

// Best-effort numeric upper salary bound from free text (for the salary filter).
export function parseSalaryMax(text = '') {
  if (!text) return null;
  // Match things like "$120,000 - $150,000" or "120k-150k"
  const matches = [...String(text).matchAll(/\$?\s?(\d{2,3})(?:,(\d{3})|k)\b/gi)];
  let max = null;
  for (const m of matches) {
    let val = m[2] ? parseInt(m[1] + m[2], 10) : parseInt(m[1], 10) * 1000;
    if (val >= 20000 && val <= 1000000) max = Math.max(max || 0, val);
  }
  return max;
}
