import crypto from 'crypto';

const ALGO = 'aes-256-gcm';

function getKey() {
  const hex = process.env.GSESSION_MASTER_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('GSESSION_MASTER_KEY missing or not a 32-byte hex string');
  }
  return Buffer.from(hex, 'hex');
}

// Returns "iv:tag:ciphertext" (all hex). Safe to store at rest.
export function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decrypt(payload) {
  if (!payload) return '';
  const [ivHex, tagHex, dataHex] = payload.split(':');
  if (!ivHex || !tagHex || !dataHex) return '';
  const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}
