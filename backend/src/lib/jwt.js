// =====================================================================
//  JWT helpers — stateless session tokens.
//  Tokens carry the minimum we need to authorize a request: the user id
//  and role. Everything else is looked up from the DB when needed.
// =====================================================================
import jwt from 'jsonwebtoken';

const SECRET  = process.env.JWT_SECRET;
const EXPIRES = process.env.JWT_EXPIRES || '7d';

if (!SECRET && process.env.NODE_ENV !== 'test') {
  // Fail loud at boot rather than silently issuing forgeable tokens.
  console.warn('[jwt] WARNING: JWT_SECRET is not set — set it before going live.');
}

export function sign(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email },
    SECRET || 'insecure-dev-secret',
    { expiresIn: EXPIRES },
  );
}

export function verify(token) {
  return jwt.verify(token, SECRET || 'insecure-dev-secret');
}
