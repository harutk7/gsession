import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { encrypt, decrypt } from './crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'sessions.json');

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
  // Atomic: write to a temp file then rename, so a crash mid-write can never
  // leave a half-written (unparseable) sessions.json behind.
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, FILE);
}

// ---- public shape (no secrets leak to the browser) ----
function toPublic(s) {
  return {
    id: s.id,
    name: s.name,
    provider: s.provider,
    loginUrl: s.loginUrl,
    username: s.username,
    hasPassword: Boolean(s.passwordEnc),
    hasTotp: Boolean(s.totpEnc),
    driverName: s.driverName || '',
    licensePlate: s.licensePlate || '',
    phone: s.phone || '',
    status: s.status,
    note: s.note || '',
    createdAt: s.createdAt,
    lastOpenedAt: s.lastOpenedAt || null,
  };
}

export function list() {
  return readAll().map(toPublic);
}

export function getRaw(id) {
  return readAll().find((s) => s.id === id) || null;
}

export function getSecrets(id) {
  const s = getRaw(id);
  if (!s) return null;
  return { password: decrypt(s.passwordEnc), totpSecret: decrypt(s.totpEnc) };
}

export function create({ name, provider, loginUrl, username, password, totpSecret, note, driverName, licensePlate, phone }) {
  const list = readAll();
  const rec = {
    id: crypto.randomUUID(),
    name: name?.trim() || 'Untitled session',
    provider: provider || 'google',
    loginUrl: loginUrl?.trim() || (provider === 'google' ? 'https://accounts.google.com/' : ''),
    username: username?.trim() || '',
    driverName: driverName?.trim() || '',
    licensePlate: (licensePlate || '').trim().toUpperCase(),
    phone: phone?.trim() || '',
    passwordEnc: password ? encrypt(password) : '',
    totpEnc: totpSecret ? encrypt(totpSecret.replace(/\s+/g, '')) : '',
    status: 'new',
    note: note?.trim() || '',
    createdAt: new Date().toISOString(),
    lastOpenedAt: null,
  };
  list.push(rec);
  writeAll(list);
  return toPublic(rec);
}

export function update(id, patch) {
  const list = readAll();
  const i = list.findIndex((s) => s.id === id);
  if (i === -1) return null;
  const s = list[i];
  if (patch.name !== undefined) s.name = patch.name.trim();
  if (patch.loginUrl !== undefined) s.loginUrl = patch.loginUrl.trim();
  if (patch.username !== undefined) s.username = patch.username.trim();
  if (patch.driverName !== undefined) s.driverName = patch.driverName.trim();
  if (patch.licensePlate !== undefined) s.licensePlate = String(patch.licensePlate).trim().toUpperCase();
  if (patch.phone !== undefined) s.phone = patch.phone.trim();
  if (patch.note !== undefined) s.note = patch.note.trim();
  // undefined = leave unchanged; '' = clear (same semantics as totpSecret)
  if (patch.password !== undefined) s.passwordEnc = patch.password ? encrypt(patch.password) : '';
  if (patch.totpSecret !== undefined) {
    s.totpEnc = patch.totpSecret ? encrypt(patch.totpSecret.replace(/\s+/g, '')) : '';
  }
  if (patch.status !== undefined) s.status = patch.status;
  if (patch.lastOpenedAt !== undefined) s.lastOpenedAt = patch.lastOpenedAt;
  list[i] = s;
  writeAll(list);
  return toPublic(s);
}

export function setStatus(id, status) {
  return update(id, { status });
}

export function remove(id) {
  const list = readAll();
  const next = list.filter((s) => s.id !== id);
  writeAll(next);
  return next.length !== list.length;
}
