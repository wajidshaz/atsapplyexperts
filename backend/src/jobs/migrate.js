// Apply database/schema.sql to DATABASE_URL using the pg driver.
// Use this instead of `psql` when the psql CLI isn't installed.
//   node src/jobs/migrate.js
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../config/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, '../../../database/schema.sql');

const sql = fs.readFileSync(schemaPath, 'utf8');
const client = await pool.connect();
try {
  await client.query(sql);            // schema.sql is parameterless → run as one batch
  console.log('migrate: schema applied successfully');
} catch (e) {
  console.error('migrate error:', e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
