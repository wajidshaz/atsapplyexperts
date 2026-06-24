// The list of companies the scraper pulls from.
// Add a company by adding one line here. Each entry needs:
//   provider: 'greenhouse' | 'lever' | 'ashby' | 'workable' | 'workday'
//   token:    the company's board token / handle (NOT needed for workday)
//   name:     display name shown in the app
// Workday entries instead need: host, tenant, site (see workday.js).
//
// HOW TO FIND A COMPANY'S TOKEN:
//   Greenhouse: their careers page URL like boards.greenhouse.io/stripe  -> token "stripe"
//   Lever:      jobs.lever.co/netflix                                     -> token "netflix"
//   Ashby:      jobs.ashbyhq.com/openai                                   -> token "openai"
//   Workable:   apply.workable.com/acme                                   -> token "acme"
//   Workday:    copy the host/tenant/site from the careers URL
//
// The tokens below are EXAMPLES to show the format. Verify each one against the
// company's real careers page before relying on it — do not assume they are live.

export const COMPANIES = [
  // --- Greenhouse (examples — verify before use) ---
  { provider: 'greenhouse', token: 'stripe',     name: 'Stripe' },
  { provider: 'greenhouse', token: 'airbnb',     name: 'Airbnb' },

  // --- Lever (examples — verify before use) ---
  { provider: 'lever',      token: 'netflix',    name: 'Netflix' },

  // --- Ashby (examples — verify before use) ---
  { provider: 'ashby',      token: 'openai',     name: 'OpenAI' },

  // --- Workable (examples — verify before use) ---
  // { provider: 'workable', token: 'yourcompany', name: 'Your Company' },

  // --- Workday (best effort — fill host/tenant/site from the careers URL) ---
  // { provider: 'workday', name: 'Acme',
  //   host: 'acme.wd1.myworkdayjobs.com', tenant: 'acme', site: 'External' },

  // --- Licensed aggregator (Path B) plugs in here as another provider once you
  //     have a key — e.g. { provider: 'adzuna', ... } — see scraper.js note.
];
