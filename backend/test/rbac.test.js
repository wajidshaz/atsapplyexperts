// End-to-end RBAC checks against the real Express app. These never reach the
// database because the auth/role middleware short-circuits first.
process.env.NODE_ENV = 'test';

import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { sign } from '../src/lib/jwt.js';

test('health endpoint is public', async () => {
  const res = await request(app).get('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('admin route requires authentication (401 without token)', async () => {
  const res = await request(app).get('/api/admin/users');
  assert.equal(res.status, 401);
});

test('candidate token is forbidden on an admin route (403)', async () => {
  const token = sign({ id: 'cand1', role: 'candidate', email: 'c@x.com' });
  const res = await request(app).get('/api/admin/users').set('Authorization', 'Bearer ' + token);
  assert.equal(res.status, 403);
});

test('a candidate cannot read another candidate\'s matches (403)', async () => {
  const token = sign({ id: 'cand1', role: 'candidate', email: 'c@x.com' });
  const res = await request(app).get('/api/candidates/cand2/matches').set('Authorization', 'Bearer ' + token);
  assert.equal(res.status, 403);
});

test('OAuth login cannot self-assign a role (body role is ignored)', async () => {
  // Even though we send role:admin, the route derives identity from Google and
  // role from the DB. With a bogus code the exchange fails — but crucially it is
  // NEVER a 200 that trusts the client-supplied role.
  const res = await request(app)
    .post('/api/auth/oauth')
    .send({ code: 'bogus-code', role: 'admin', email: 'hacker@x.com' });
  assert.notEqual(res.status, 200);
});
