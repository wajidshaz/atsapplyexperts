// One-time seed: create the first ADMIN account (Wajid Khosa) with a
// bcrypt-hashed password. The plain password is read from an env var so it
// never lives in the code or the database.
//
// Usage:
//   ADMIN_NAME="Wajid Khosa" ADMIN_EMAIL="wajid@ats.com" ADMIN_PASSWORD="choose-a-strong-one" \
//   node src/jobs/seed-admin.js
//
// Re-running updates the password for that account (safe).

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { query, pool } from '../config/db.js';

const name = process.env.ADMIN_NAME || 'Wajid Khosa';
const email = process.env.ADMIN_EMAIL || 'wajid@ats.com';
const password = process.env.ADMIN_PASSWORD;

if (!password) {
  console.error('Set ADMIN_PASSWORD env var (e.g. ADMIN_PASSWORD="..." node src/jobs/seed-admin.js)');
  process.exit(1);
}
if (password.length < 6) {
  console.error('Please choose a password with at least 6 characters.');
  process.exit(1);
}

const hash = await bcrypt.hash(password, 12);

const { rows } = await query(
  `INSERT INTO users (email, full_name, role, status, invite_status, password_hash)
   VALUES ($1,$2,'admin','active','active',$3)
   ON CONFLICT (email) DO UPDATE SET
     full_name=EXCLUDED.full_name, role='admin', password_hash=EXCLUDED.password_hash
   RETURNING id, full_name, email, role`,
  [email, name, hash],
);

console.log('Admin ready:', rows[0]);
console.log('Login with name "%s" (or email) and the password you set.', name);
await pool.end();
process.exit(0);
