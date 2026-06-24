import test from 'node:test';
import assert from 'node:assert/strict';
import { sign, verify } from '../src/lib/jwt.js';

test('jwt sign/verify roundtrip preserves id + role', () => {
  const token = sign({ id: 'u1', role: 'candidate', email: 'a@b.com' });
  const claims = verify(token);
  assert.equal(claims.sub, 'u1');
  assert.equal(claims.role, 'candidate');
  assert.equal(claims.email, 'a@b.com');
});

test('jwt rejects a tampered token', () => {
  const token = sign({ id: 'u1', role: 'admin', email: 'a@b.com' });
  assert.throws(() => verify(token + 'tampered'));
});
