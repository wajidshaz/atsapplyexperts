// =====================================================================
//  Field-level encryption for sensitive data at rest (job-board
//  credentials in candidate_profiles.accounts).
//  AES-256-GCM with a 32-byte key from CREDENTIAL_ENC_KEY (base64).
//  Format stored: "v1:<iv_b64>:<tag_b64>:<ciphertext_b64>".
// =====================================================================
import crypto from 'node:crypto';

function getKey() {
  const raw = process.env.CREDENTIAL_ENC_KEY;
  if (!raw) throw new Error('CREDENTIAL_ENC_KEY is not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('CREDENTIAL_ENC_KEY must be 32 bytes (base64-encoded)');
  return key;
}

export function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decrypt(blob) {
  if (!blob || typeof blob !== 'string' || !blob.startsWith('v1:')) return null;
  const [, ivB64, tagB64, dataB64] = blob.split(':');
  const key = getKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}

// Sign a short-lived download grant (HMAC) so file access goes through
// the API instead of exposing raw storage paths.
export function signDownload(resumeId, ttlSeconds = 300) {
  const exp = Date.now() + ttlSeconds * 1000;
  const payload = `${resumeId}.${exp}`;
  const mac = crypto.createHmac('sha256', process.env.JWT_SECRET || 'insecure-dev-secret')
    .update(payload).digest('base64url');
  return `${exp}.${mac}`;
}

export function verifyDownload(resumeId, token) {
  if (!token) return false;
  const [expStr, mac] = token.split('.');
  const exp = Number(expStr);
  if (!exp || Date.now() > exp) return false;
  const expected = crypto.createHmac('sha256', process.env.JWT_SECRET || 'insecure-dev-secret')
    .update(`${resumeId}.${exp}`).digest('base64url');
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
}
