import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { encrypt, decrypt, signDownload, verifyDownload } from '../src/lib/crypto.js';

// crypto.js reads CREDENTIAL_ENC_KEY at call time, so setting it here (after the
// hoisted imports, before the test callbacks run) is sufficient.
process.env.CREDENTIAL_ENC_KEY = Buffer.alloc(32, 7).toString('base64');

test('encrypt → decrypt roundtrip', () => {
  const cipher = encrypt('hunter2');
  assert.notEqual(cipher, 'hunter2');
  assert.match(cipher, /^v1:/);
  assert.equal(decrypt(cipher), 'hunter2');
});

test('encrypt returns null for empty input', () => {
  assert.equal(encrypt(''), null);
  assert.equal(encrypt(null), null);
});

test('decrypt rejects non-ciphertext', () => {
  assert.equal(decrypt('not-encrypted'), null);
});

test('download grant verifies for the right id only', () => {
  const grant = signDownload('resume-1', 300);
  assert.ok(verifyDownload('resume-1', grant));
  assert.ok(!verifyDownload('resume-2', grant)); // bound to a specific id
});

test('expired download grant is rejected', () => {
  const grant = signDownload('resume-1', -1); // already expired
  assert.ok(!verifyDownload('resume-1', grant));
});
