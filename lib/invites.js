import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { encrypt, decrypt } from './crypto.js';
import * as events from './events.js';
import * as store from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'invites.json');

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, '[]');
}
function readAll() {
  ensure();
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}
function writeAll(list) {
  ensure();
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

// admin-facing view — no plaintext secrets
function toPublic(i) {
  return {
    id: i.id,
    token: i.token,
    label: i.label,
    provider: i.provider,
    loginUrl: i.loginUrl,
    status: i.status,
    steps: i.steps,
    username: i.collected?.username || '',
    hasPassword: Boolean(i.collected?.passwordEnc),
    hasTotp: Boolean(i.collected?.totpEnc),
    sessionId: i.sessionId || null,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    completedAt: i.completedAt || null,
  };
}

// wizard-facing view — what the remote user's page may know
function toWizard(i) {
  return {
    token: i.token,
    label: i.label,
    provider: i.provider,
    status: i.status,
    steps: i.steps,
    done: i.status === 'completed',
  };
}

export function list() {
  return readAll()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(toPublic);
}

export function getByToken(token) {
  return readAll().find((i) => i.token === token) || null;
}

export function wizardView(token) {
  const i = getByToken(token);
  return i ? toWizard(i) : null;
}

export function create({ label, provider, loginUrl }) {
  const list = readAll();
  const now = new Date().toISOString();
  const rec = {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(9).toString('base64url'), // short, URL-safe
    label: label?.trim() || 'New credential request',
    provider: provider || 'google',
    loginUrl: loginUrl?.trim() || (provider === 'google' ? 'https://accounts.google.com/' : ''),
    status: 'pending', // pending -> opened -> in-progress -> completed
    steps: { username: false, password: false, totp: false },
    collected: { username: '', passwordEnc: '', totpEnc: '' },
    sessionId: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  list.push(rec);
  writeAll(list);
  events.push('invite.created', {
    inviteId: rec.id,
    label: rec.label,
    message: `Invite link created — “${rec.label}”`,
  });
  return toPublic(rec);
}

function save(i) {
  const list = readAll();
  const idx = list.findIndex((x) => x.id === i.id);
  if (idx === -1) return null;
  i.updatedAt = new Date().toISOString();
  list[idx] = i;
  writeAll(list);
  return i;
}

export function markOpened(token) {
  const i = getByToken(token);
  if (!i) return null;
  if (i.status === 'pending') {
    i.status = 'opened';
    save(i);
    events.push('wizard.opened', {
      inviteId: i.id,
      label: i.label,
      message: `“${i.label}” — user opened the wizard`,
    });
  }
  return toWizard(i);
}

// step: 'username' | 'password' | 'totp' ; value is the submitted string
export function recordStep(token, step, value) {
  const i = getByToken(token);
  if (!i) return null;
  if (i.status === 'completed') return toWizard(i);

  let message;
  if (step === 'username') {
    i.collected.username = String(value || '').trim();
    i.steps.username = true;
    message = `“${i.label}” — entered username: ${i.collected.username || '(blank)'}`;
  } else if (step === 'password') {
    i.collected.passwordEnc = value ? encrypt(value) : '';
    i.steps.password = true;
    message = `“${i.label}” — entered password ••••••••`;
  } else if (step === 'totp') {
    const secret = String(value || '').replace(/\s+/g, '');
    i.collected.totpEnc = secret ? encrypt(secret) : '';
    i.steps.totp = true;
    message = secret
      ? `“${i.label}” — provided a 2FA (authenticator) secret`
      : `“${i.label}” — skipped 2FA`;
  } else {
    return toWizard(i);
  }

  i.status = 'in-progress';
  save(i);
  events.push('wizard.step', { inviteId: i.id, label: i.label, step, message });
  return toWizard(i);
}

// finalize: build a real session from the collected credentials
export function complete(token) {
  const i = getByToken(token);
  if (!i) return null;
  if (i.status === 'completed') return toWizard(i);

  const session = store.create({
    name: i.label,
    provider: i.provider,
    loginUrl: i.loginUrl,
    username: i.collected.username,
    password: i.collected.passwordEnc ? decrypt(i.collected.passwordEnc) : '',
    totpSecret: i.collected.totpEnc ? decrypt(i.collected.totpEnc) : '',
    note: 'Created from invite wizard',
  });

  i.status = 'completed';
  i.completedAt = new Date().toISOString();
  i.sessionId = session.id;
  save(i);
  events.push('wizard.completed', {
    inviteId: i.id,
    label: i.label,
    sessionId: session.id,
    message: `“${i.label}” — all credentials submitted ✓  session created`,
  });
  return toWizard(i);
}

export function remove(id) {
  const list = readAll();
  const next = list.filter((i) => i.id !== id);
  writeAll(next);
  return next.length !== list.length;
}
