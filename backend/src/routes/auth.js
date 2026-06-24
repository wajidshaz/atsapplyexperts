import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../config/db.js';
import { sign } from '../lib/jwt.js';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { validateBody, z } from '../middleware/validate.js';
import { notify } from '../services/mailer.js';

const r = Router();

// ---------------------------------------------------------------------
//  Password login for ADMIN / staff (clients use Google OAuth below).
//  Checked against a bcrypt HASH in users.password_hash. On success we
//  issue a signed JWT; the plain password is never stored or logged.
//  POST /api/auth/login  { username, password }
// ---------------------------------------------------------------------
const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

r.post('/login', authLimiter, validateBody(loginSchema), async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const { rows } = await query(
      `SELECT id, email, full_name, role, plan, password_hash
         FROM users
        WHERE (full_name = $1 OR email = $1)
          AND role IN ('admin','employee')
        LIMIT 1`,
      [username]);
    const user = rows[0];
    if (!user || !user.password_hash) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    delete user.password_hash;
    const token = sign(user);
    res.json({ user, token });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------
//  Google OAuth login for CLIENTS (candidates).
//  The frontend obtains an authorization `code` (offline access, with the
//  gmail.readonly scope) and posts it here. The server exchanges the code,
//  verifies the ID token, and derives the identity FROM GOOGLE — never from
//  the request body. Role is read from the existing DB row; OAuth can NEVER
//  create or elevate to admin/employee. Clients are invite-only.
//  POST /api/auth/oauth  { code, redirect_uri? }
// ---------------------------------------------------------------------
const oauthSchema = z.object({
  code: z.string().min(1),
  redirect_uri: z.string().url().optional(),
});

r.post('/oauth', authLimiter, validateBody(oauthSchema), async (req, res, next) => {
  try {
    const { code, redirect_uri } = req.body;
    // Exchange the auth code directly with Google using native fetch. The
    // googleapis/gaxios library's bundled node-fetch throws
    // ERR_STREAM_PREMATURE_CLOSE on some Node builds; native fetch is reliable.
    const form = new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirect_uri || process.env.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    });
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.id_token) {
      return res.status(401).json({ error: tokens.error_description || 'Google sign-in failed. Please try again.' });
    }
    // The id_token came directly from Google's token endpoint over TLS, so its
    // payload is trusted (decode the JWT body to read the verified identity).
    const payload = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString('utf8'));
    const email = payload?.email;
    const subject = payload?.sub;
    if (!email || !payload.email_verified) {
      return res.status(401).json({ error: 'Google account email not verified' });
    }

    // Identity is invite-only: the user must already exist as a candidate.
    const { rows } = await query(
      `SELECT id, email, full_name, role, plan, invite_status FROM users WHERE email=$1 LIMIT 1`,
      [email]);
    const user = rows[0];
    if (!user) return res.status(403).json({ error: 'No invitation found for this Google account. Ask your admin to invite you.' });
    if (user.role !== 'candidate') {
      return res.status(403).json({ error: 'This account signs in with a password, not Google.' });
    }

    // Did the client grant read-only Gmail access? Store the refresh token
    // (used later, server-side only, to track recruiter replies).
    const grantedGmail = (tokens.scope || '').includes('gmail.readonly');
    await query(
      `UPDATE users SET
         oauth_provider='google',
         oauth_subject=$2,
         invite_status='active',
         email_scope_granted=$3,
         email_read_token=COALESCE($4, email_read_token)
       WHERE id=$1`,
      [user.id, subject, grantedGmail, grantedGmail ? tokens.refresh_token : null]);

    // First activation (was still 'invited') → send a one-time welcome email.
    // Fire-and-forget: a mail failure must never block sign-in.
    if (user.invite_status === 'invited') {
      notify.welcome(user.email, user.full_name)
        .catch(e => console.error('[welcome mail]', e.message));
    }

    const token = sign(user);
    res.json({ user, token });
  } catch (e) {
    // Token exchange failures shouldn't 500 — they're auth failures.
    if (e?.message?.includes('invalid_grant') || e?.response?.data) {
      return res.status(401).json({ error: 'Google sign-in failed. Please try again.' });
    }
    next(e);
  }
});

// ---------------------------------------------------------------------
//  Current user — identity comes from the verified token, not the URL.
//  GET /api/auth/me
// ---------------------------------------------------------------------
r.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT id,email,full_name,role,plan,status FROM users WHERE id=$1', [req.user.id]);
    res.json(rows[0] || null);
  } catch (e) { next(e); }
});

export default r;
