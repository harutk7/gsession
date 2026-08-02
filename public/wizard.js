const token = location.pathname.split('/').pop();
const $ = (id) => document.getElementById(id);

const panes = ['intro', 'username', 'password', 'totp', 'done', 'error'];
function show(name) {
  for (const p of panes) $('pane-' + p).classList.toggle('hidden', p !== name);
}
function setStep(idx) {
  document.querySelectorAll('.step').forEach((el) => {
    const s = Number(el.dataset.step);
    el.classList.toggle('active', s === idx);
    el.classList.toggle('done', s < idx);
  });
}
function err(msg) {
  $('w-error').textContent = msg || '';
}

async function api(pathname, body) {
  const r = await fetch('/api/wizard/' + token + pathname, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r;
}

async function step(name, value) {
  err('');
  const r = await api('/step', { step: name, value });
  if (!r.ok) {
    err('Could not save. Please try again.');
    return false;
  }
  return true;
}

// ---- boot: validate link ----
(async function boot() {
  const r = await api('');
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    $('error-msg').textContent = d.error || 'This link is invalid or has expired.';
    show('error');
    return;
  }
  const w = await r.json();
  if (w.label) {
    $('intro-title').textContent = w.label;
  }
  if (w.done) {
    show('done');
    setStep(3);
    return;
  }
  show('intro');
})();

// ---- navigation ----
$('start-btn').addEventListener('click', () => {
  show('username');
  setStep(0);
  $('w-username').focus();
});

$('pane-username').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = $('w-username').value.trim();
  if (!v) return err('Please enter your username.');
  if (await step('username', v)) {
    show('password');
    setStep(1);
    $('w-password').focus();
  }
});

$('w-show').addEventListener('change', (e) => {
  $('w-password').type = e.target.checked ? 'text' : 'password';
});

$('pane-password').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = $('w-password').value;
  if (!v) return err('Please enter your password.');
  if (await step('password', v)) {
    show('totp');
    setStep(2);
    $('w-totp').focus();
  }
});

async function finish(totpValue) {
  if (!(await step('totp', totpValue))) return;
  err('');
  const r = await api('/complete', {});
  if (!r.ok) return err('Could not finish. Please try again.');
  show('done');
  setStep(3);
}

$('skip-totp').addEventListener('click', () => finish(''));
$('pane-totp').addEventListener('submit', (e) => {
  e.preventDefault();
  finish($('w-totp').value.trim());
});
