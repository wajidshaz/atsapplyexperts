import test from 'node:test';
import assert from 'node:assert/strict';
import { requireAuth, requireRole, requireSelfOrAdmin, requireParamSelfOrAdmin } from '../src/middleware/auth.js';
import { validateBody, z } from '../src/middleware/validate.js';
import { sign } from '../src/lib/jwt.js';

function mockRes() {
  return { code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}

test('requireAuth → 401 when no token', () => {
  const res = mockRes(); let called = false;
  requireAuth({ headers: {} }, res, () => { called = true; });
  assert.equal(res.code, 401);
  assert.ok(!called);
});

test('requireAuth attaches req.user for a valid token', () => {
  const token = sign({ id: 'u1', role: 'admin', email: 'a@b.com' });
  const req = { headers: { authorization: 'Bearer ' + token } };
  let called = false;
  requireAuth(req, mockRes(), () => { called = true; });
  assert.ok(called);
  assert.equal(req.user.role, 'admin');
  assert.equal(req.user.id, 'u1');
});

test('requireRole → 403 for the wrong role', () => {
  const res = mockRes(); let called = false;
  requireRole('admin')({ user: { role: 'candidate' } }, res, () => { called = true; });
  assert.equal(res.code, 403);
  assert.ok(!called);
});

test('requireSelfOrAdmin lets a candidate touch their own id', () => {
  let called = false;
  requireSelfOrAdmin('id')({ user: { role: 'candidate', id: 'u1' }, params: { id: 'u1' } }, mockRes(), () => { called = true; });
  assert.ok(called);
});

test('requireSelfOrAdmin blocks a candidate touching another id', () => {
  const res = mockRes();
  requireSelfOrAdmin('id')({ user: { role: 'candidate', id: 'u1' }, params: { id: 'u2' } }, res, () => {});
  assert.equal(res.code, 403);
});

test('requireParamSelfOrAdmin lets an admin through for any id', () => {
  let called = false;
  requireParamSelfOrAdmin('id')({ user: { role: 'admin', id: 'admin1' }, params: { id: 'someone' } }, mockRes(), () => { called = true; });
  assert.ok(called);
});

test('validateBody rejects bad input with 400 and the { error } shape', () => {
  const res = mockRes();
  const mw = validateBody(z.object({ email: z.string().email() }));
  mw({ body: { email: 'not-an-email' } }, res, () => {});
  assert.equal(res.code, 400);
  assert.ok(typeof res.body.error === 'string');
});

test('validateBody passes and replaces req.body with parsed data', () => {
  const req = { body: { email: 'a@b.com', extra: 'x' } };
  let called = false;
  validateBody(z.object({ email: z.string().email() }))(req, mockRes(), () => { called = true; });
  assert.ok(called);
  assert.equal(req.body.email, 'a@b.com');
  assert.equal(req.body.extra, undefined); // stripped by schema
});
