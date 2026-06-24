// =====================================================================
//  Validation middleware — zod schemas for request bodies / queries.
//  On failure it returns the same { error } shape the central error
//  handler uses, so the frontend can treat all errors uniformly.
// =====================================================================
import { z } from 'zod';

// Validate req.body against a zod schema; replaces req.body with the
// parsed (and coerced) result so handlers get clean data.
export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      const msg = result.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
      return res.status(400).json({ error: msg });
    }
    req.body = result.data;
    next();
  };
}

// Validate req.query (read-only on Express 5, so we stash the parsed
// result on req.valitatedQuery rather than reassigning req.query).
export function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query ?? {});
    if (!result.success) {
      const msg = result.error.issues.map(i => `${i.path.join('.') || 'query'}: ${i.message}`).join('; ');
      return res.status(400).json({ error: msg });
    }
    req.validatedQuery = result.data;
    next();
  };
}

// ---- shared enum/value vocabularies (mirror the DB enums) ----
export const APP_STATUS    = ['to_do', 'applied', 'interview', 'rejected', 'offer'];
export const APPROVAL_DEC  = ['approved', 'rejected', 'pending'];
export const MASTER_STATUS = ['approved', 'rejected'];
export const USER_ROLE     = ['admin', 'candidate', 'employee'];
export const USER_PLAN     = ['free', 'vip'];

export { z };
