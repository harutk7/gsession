import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// The store encrypts passkey credentials with the master key — set one before
// any encrypt/decrypt runs (crypto reads it lazily at call time).
process.env.GSESSION_MASTER_KEY = 'a'.repeat(64);
const store = await import('../lib/store.js');

// Keep the test from touching the real sessions file.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', 'sessions.json');
const backup = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null;
test.after(() => {
  if (backup !== null) fs.writeFileSync(FILE, backup);
});

const CRED = {
  credentialId: 'dGVzdC1jcmVkZW50aWFsLWlk',
  isResidentCredential: false,
  rpId: 'accounts.google.com',
  privateKey: 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg',
  userHandle: 'dXNlci1oYW5kbGU=',
  signCount: 1,
  userName: 'u',
  userDisplayName: 'u',
};

test('new session has no passkey flags', () => {
  const s = store.create({ name: 'pk-test', provider: 'google', username: 'pk@test.com' });
  assert.equal(s.passkeyAdded, false);
  assert.equal(s.hasPasskey, false);
  store.remove(s.id);
});

test('passkey credentials round-trip encrypted and are flagged', () => {
  const s = store.create({ name: 'pk-test', provider: 'google', username: 'pk@test.com' });
  store.update(s.id, { passkeys: [CRED], passkeyAdded: true });

  // stored encrypted at rest (never plain JSON)
  const raw = store.getRaw(s.id);
  assert.ok(raw.passkeyEnc && raw.passkeyEnc.length > 0);
  assert.ok(!raw.passkeyEnc.includes(CRED.privateKey));

  // readable back
  assert.deepEqual(store.getPasskeys(s.id), [CRED]);

  // public shape surfaces the flags but not the secret
  const pub = store.list().find((x) => x.id === s.id);
  assert.equal(pub.passkeyAdded, true);
  assert.equal(pub.hasPasskey, true);
  assert.equal(pub.passkeyEnc, undefined);
  store.remove(s.id);
});

test('passkeys can be appended and cleared', () => {
  const s = store.create({ name: 'pk-test', provider: 'google', username: 'pk@test.com' });
  store.update(s.id, { passkeys: [CRED], passkeyAdded: true });
  const second = { ...CRED, credentialId: 'c2Vjb25k', signCount: 2 };
  store.update(s.id, { passkeys: [CRED, second] });
  assert.equal(store.getPasskeys(s.id).length, 2);

  store.update(s.id, { passkeys: [] });
  assert.deepEqual(store.getPasskeys(s.id), []);
  const pub = store.list().find((x) => x.id === s.id);
  assert.equal(pub.hasPasskey, false);
  store.remove(s.id);
});
