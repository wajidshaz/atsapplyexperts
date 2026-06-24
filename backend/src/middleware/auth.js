// =====================================================================
//  Auth middleware — JWT verification + role/ownership enforcement.
//  The role on req.user comes from a signed token; it is NEVER taken
//  from the request body or params. This is the single source of truth
//  for "who is calling".
// =====================================================================
import { verify } from '../lib/jwt.js';
import { query } from '../config/db.js';

// Require a valid Bearer token. Attaches { id, role, email } to req.user.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const claims = verify(token);
    req.user = { id: claims.sub, role: claims.role, email: claims.email };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// Require the caller to hold one of the given roles.
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient role' });
    }
    next();
  };
}

// A candidate may only act on their own :id; admins may act on anyone.
// `param` is the route param holding the candidate id (default ':id').
export function requireSelfOrAdmin(param = 'id') {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (req.user.role === 'admin') return next();
    if (req.user.role === 'candidate' && req.user.id === req.params[param]) return next();
    return res.status(403).json({ error: 'Forbidden: not your resource' });
  };
}

// Any authenticated user whose id equals the given route param, or an admin.
// Used for employee-id-scoped routes (e.g. /:id/candidates).
export function requireParamSelfOrAdmin(param = 'id') {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (req.user.role === 'admin' || req.user.id === req.params[param]) return next();
    return res.status(403).json({ error: 'Forbidden: not your resource' });
  };
}

// An employee may only touch a candidate they are actively assigned to;
// admins bypass. Used on employee endpoints that take a :candidateId.
export function requireAssignedOrAdmin(param = 'candidateId') {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Authentication required' });
      if (req.user.role === 'admin') return next();
      if (req.user.role !== 'employee') return res.status(403).json({ error: 'Forbidden' });
      const { rows } = await query(
        `SELECT 1 FROM assignments
          WHERE employee_id=$1 AND candidate_id=$2 AND active LIMIT 1`,
        [req.user.id, req.params[param]],
      );
      if (!rows[0]) return res.status(403).json({ error: 'Forbidden: candidate not assigned to you' });
      next();
    } catch (e) { next(e); }
  };
}
