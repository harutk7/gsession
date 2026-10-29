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
    contactName: s.contactName || '',
    phone: s.phone || '',
    truckPlate: s.truckPlate || '',
    trailerPlate: s.trailerPlate || '',
    driverName: s.driverName || '',
    driverPhone: s.driverPhone || '',
    licensePlate: s.licensePlate || '',
    license: s.license || '',
    vehicle: s.vehicle || '',
    city: s.city || '',
    email: s.email || '',
    state: s.state || '',
    status: s.status,
    note: s.note || '',
    docs: s.docs || {},
    deviceTrusted: Boolean(s.deviceTrusted),
    passkeyAdded: Boolean(s.passkeyAdded),
    hasPasskey: Boolean(s.passkeyEnc),
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

// The session's WebAuthn passkey credentials (an array of CDP Credential
// objects, encrypted at rest — the private keys are the secret). Returned as a
// plain array (empty when none) so the browser can re-seed them into a fresh
// virtual authenticator on every launch.
export function getPasskeys(id) {
  const s = getRaw(id);
  if (!s || !s.passkeyEnc) return [];
  try {
    const parsed = JSON.parse(decrypt(s.passkeyEnc));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function create({ name, provider, loginUrl, username, password, totpSecret, note, contactName, phone, truckPlate, trailerPlate, driverName, driverPhone, licensePlate, license, vehicle, city, email, state }) {
  const list = readAll();
  const rec = {
    id: crypto.randomUUID(),
    name: name?.trim() || 'Untitled session',
    provider: provider || 'google',
    loginUrl: loginUrl?.trim() || (provider === 'google' ? 'https://accounts.google.com/' : ''),
    username: username?.trim() || '',
    contactName: contactName?.trim() || '',
    phone: phone?.trim() || '',
    truckPlate: (truckPlate || '').trim().toUpperCase(),
    trailerPlate: (trailerPlate || '').trim().toUpperCase(),
    driverName: driverName?.trim() || '',
    driverPhone: driverPhone?.trim() || '',
    licensePlate: (licensePlate || '').trim().toUpperCase(),
    license: (license || '').trim(),
    vehicle: (vehicle || '').trim(),
    city: (city || '').trim(),
    email: (email || '').trim(),
    state: (state || '').trim(),
    passwordEnc: password ? encrypt(password) : '',
    totpEnc: totpSecret ? encrypt(totpSecret.replace(/\s+/g, '')) : '',
    passkeyEnc: '',
    passkeyAdded: false,
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
  if (patch.contactName !== undefined) s.contactName = patch.contactName.trim();
  if (patch.phone !== undefined) s.phone = patch.phone.trim();
  if (patch.truckPlate !== undefined) s.truckPlate = String(patch.truckPlate).trim().toUpperCase();
  if (patch.trailerPlate !== undefined) s.trailerPlate = String(patch.trailerPlate).trim().toUpperCase();
  if (patch.driverName !== undefined) s.driverName = patch.driverName.trim();
  if (patch.driverPhone !== undefined) s.driverPhone = patch.driverPhone.trim();
  if (patch.licensePlate !== undefined) s.licensePlate = String(patch.licensePlate).trim().toUpperCase();
  if (patch.license !== undefined) s.license = patch.license.trim();
  if (patch.vehicle !== undefined) s.vehicle = patch.vehicle.trim();
  if (patch.city !== undefined) s.city = patch.city.trim();
  if (patch.email !== undefined) s.email = patch.email.trim();
  if (patch.state !== undefined) s.state = patch.state.trim();
  if (patch.note !== undefined) s.note = patch.note.trim();
  // undefined = leave unchanged; '' = clear (same semantics as totpSecret)
  if (patch.password !== undefined) s.passwordEnc = patch.password ? encrypt(patch.password) : '';
  if (patch.totpSecret !== undefined) {
    s.totpEnc = patch.totpSecret ? encrypt(patch.totpSecret.replace(/\s+/g, '')) : '';
  }
    if (patch.status !== undefined) s.status = patch.status;
    // docs: { insurance: 'file.png', license: 'file.pdf' } — names of files
    // stored under data/uploads/<id>/ (uploaded via the driver step).
    if (patch.docs !== undefined) {
      s.docs = patch.docs && typeof patch.docs === 'object' ? patch.docs : {};
    }
    if (patch.deviceTrusted !== undefined) s.deviceTrusted = Boolean(patch.deviceTrusted);
    // passkeys: an array of WebAuthn credential objects (or null/[] to clear).
    // Stored encrypted — the private keys must not sit in plain JSON.
    if (patch.passkeys !== undefined) {
      s.passkeyEnc = patch.passkeys && patch.passkeys.length ? encrypt(JSON.stringify(patch.passkeys)) : '';
    }
    if (patch.passkeyAdded !== undefined) s.passkeyAdded = Boolean(patch.passkeyAdded);
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
