// =====================================================================
//  Rate limiters. Kept in their own module so route files can import the
//  strict limiters without creating a circular dependency on app.js.
// =====================================================================
import rateLimit from 'express-rate-limit';

const common = { standardHeaders: true, legacyHeaders: false };

// Looser cap for general API traffic.
export const globalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 600, ...common });

// Strict cap on auth endpoints to blunt credential stuffing.
export const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, ...common });

// Scraper runs are expensive; keep them rare.
export const scraperLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, ...common });
