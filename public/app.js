let TOKEN = localStorage.getItem('gsession_token') || '';

const $ = (id) => document.getElementById(id);

function api(pathname, opts = {}) {
  return fetch('/api' + pathname, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + TOKEN,
      ...(opts.headers || {}),
    },
  });
}

function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  setTimeout(() => (t.className = 'toast hidden'), 4200);
}

// ---------- auth gate ----------
async function checkToken(token) {
  const r = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const d = await r.json();
  return d.ok;
}

async function unlock(token) {
  const ok = await checkToken(token);
  if (!ok) {
    $('gate-error').textContent = 'Invalid token.';
    return;
  }
  TOKEN = token;
  localStorage.setItem('gsession_token', token);
  $('gate').classList.add('hidden');
  $('app').classList.remove('hidden');
  load();
  connectEvents();
}

$('gate-form').addEventListener('submit', (e) => {
  e.preventDefault();
  unlock($('gate-token').value.trim());
});

$('lock-btn').addEventListener('click', () => {
  localStorage.removeItem('gsession_token');
  location.reload();
});

// ---------- render ----------
function statusBadge(s) {
  const labels = { 'logged-in': 'logged in', trusted: 'keypass ✓', pending: 'needs 2FA', error: 'error', new: 'new' };
  return `<span class="badge ${s.status}">${labels[s.status] || s.status}</span>`;
}

function card(s) {
  const chips = [];
  chips.push(`<span class="chip">${s.provider}</span>`);
  if (s.hasPassword) chips.push('<span class="chip">password ✓</span>');
  if (s.hasTotp) chips.push('<span class="chip">2FA ✓</span>');
  if (s.deviceTrusted) chips.push('<span class="chip trusted">🔑 device ✓</span>');
  const driver = [];
  if (s.driverName) driver.push(`<span class="chip driver">👤 ${escapeHtml(s.driverName)}</span>`);
  if (s.licensePlate) driver.push(`<span class="chip driver">🚚 <b>${escapeHtml(s.licensePlate)}</b></span>`);
  if (s.phone) driver.push(`<span class="chip driver">📞 ${escapeHtml(s.phone)}</span>`);
  if (s.license) driver.push(`<span class="chip driver">🪪 ${escapeHtml(s.license)}</span>`);
  if (s.vehicle) driver.push(`<span class="chip driver">🚗 ${escapeHtml(s.vehicle)}</span>`);
  if (s.city) driver.push(`<span class="chip driver">📍 ${escapeHtml(s.city)}</span>`);
  return `
  <div class="card" data-id="${s.id}">
    <div class="card-head">
      <div>
        <h3>${escapeHtml(s.name)}</h3>
        <div class="sub">${escapeHtml(s.username || '—')}</div>
      </div>
      <div style="display:flex;gap:6px;flex-direction:column;align-items:flex-end">
        ${statusBadge(s)}
        ${s.open ? '<span class="badge open">browser open</span>' : ''}
      </div>
    </div>
    <div class="chips">${driver.length ? driver.join('') : ''}${chips.join('')}</div>
    ${s.note ? `<div class="sub">${escapeHtml(s.note)}</div>` : ''}
    <div class="card-actions">
      <button class="primary" onclick="doLogin('${s.id}')">Auto-login</button>
      <button onclick="doOpen('${s.id}')">Open</button>
      <button title="Register this OS as the account's trusted device (keypass)" onclick="doTrust('${s.id}')">🔑 Device</button>
      ${s.open ? `<button class="primary" onclick="openStream('${s.id}','${escapeHtml(s.name)}')">📺 Watch</button>` : ''}
      ${s.open ? `<button onclick="doClose('${s.id}')">Close</button>` : ''}
      <button onclick="editSession('${s.id}')">Edit</button>
      <button class="danger" onclick="doDelete('${s.id}')">Delete</button>
    </div>
  </div>`;
}

let CACHE = [];
async function load() {
  const r = await api('/sessions');
  if (r.status === 401) return $('lock-btn').click();
  CACHE = await r.json();
  const grid = $('grid');
  $('empty').classList.toggle('hidden', CACHE.length > 0);
  grid.innerHTML = CACHE.map(card).join('');
}

// ---------- single static link ----------
// One link everyone uses. No invite list and no per-link generation anymore.
function shareLink() {
  return location.origin + '/w/login';
}
function copyText(text) {
  navigator.clipboard.writeText(text).then(() => toast('Link copied.', 'ok'));
}
(function setShareLink() {
  const el = $('share-link');
  if (el) el.value = shareLink();
})();

// ---------- live notifications (SSE) ----------
let unread = 0;
let drawerOpen = false;
let sse = null;
function connectEvents() {
  if (sse) sse.close();
  sse = new EventSource('/api/events?token=' + encodeURIComponent(TOKEN));
  sse.onmessage = (e) => {
    let evt;
    try { evt = JSON.parse(e.data); } catch { return; }
    addNote(evt);
    // wizard activity should refresh the invite/session cards
    if (evt.type && evt.type.startsWith('wizard')) load();
    // a live challenge (2FA / phone-approve / displayed number) appears while
    // the user is signing in from their side: pop the watch modal with the
    // number so it's visible without doing anything from the panel.
    if (evt.type === 'wizard.challenge' && evt.sessionId && !document.querySelector('#watch-modal:not(.hidden)')) {
      openPending(evt.sessionId, { options: evt.options, message: evt.loginMessage || evt.message });
    }
    if (!drawerOpen) bumpUnread();
  };
  sse.onerror = () => { /* browser auto-reconnects */ };
}
function bumpUnread() {
  unread += 1;
  const c = $('bell-count');
  c.textContent = unread;
  c.classList.remove('hidden');
}
const noteClass = (type) =>
  type === 'invite.created' ? 'created'
  : type === 'wizard.opened' ? 'opened'
  : type === 'wizard.completed' ? 'completed'
  : 'step';
let feedHasItems = false;
function addNote(evt) {
  const feed = $('feed');
  if (!feedHasItems) { feed.innerHTML = ''; feedHasItems = true; }
  const div = document.createElement('div');
  div.className = 'note ' + noteClass(evt.type);
  const time = new Date(evt.ts).toLocaleTimeString();
  div.innerHTML = `<div>${escapeHtml(evt.message || evt.type)}</div><div class="t">${time}</div>`;
  feed.prepend(div);
}
function toggleDrawer(open) {
  drawerOpen = open === undefined ? !drawerOpen : open;
  $('drawer').classList.toggle('open', drawerOpen);
  if (drawerOpen) { unread = 0; $('bell-count').classList.add('hidden'); }
}
$('bell-btn').addEventListener('click', () => toggleDrawer());

// ---------- actions ----------
async function doOpen(id) {
  toast('Launching browser…');
  const r = await api(`/sessions/${id}/open`, { method: 'POST' });
  const d = await r.json();
  if (d.ok) {
    toast(d.message || 'Browser opened.', d.status === 'error' ? 'err' : 'ok');
    maybeWatchPending(id, d);
  } else toast(d.error || 'Failed to open', 'err');
  load();
}

async function doLogin(id) {
  toast('Opening browser and signing in…');
  const r = await api(`/sessions/${id}/login`, { method: 'POST' });
  const d = await r.json();
  if (d.ok) {
    toast(d.message || 'Done', d.status === 'error' ? 'err' : 'ok');
    maybeWatchPending(id, d);
  } else toast(d.error || 'Login failed', 'err');
  load();
}

// ---------- pending-challenge tracking (number / code / phone-approve) ----------
// After an open/login lands on a pending step, the panel shows the challenge
// (with the verification NUMBER when Google shows one) and keeps re-checking
// /api/sessions/:id/state until it settles. `d` is the API response (carries
// state + options straight from the browser side when a step just finished).
const PENDING_STATES = ['numchoice', 'code', 'approve', 'trust-start', 'password'];
function stateOf(d) {
  return d.trustState || d.state;
}
function maybeWatchPending(id, d) {
  if (d.open && PENDING_STATES.includes(stateOf(d))) {
    openPending(id, { options: d.options, message: d.trustMessage || d.message });
  } else if (d.open && stateOf(d) === 'trusted') {
    toast('Device registered — this OS is the keypass for the account now.', 'ok');
  }
}
let _pendingTimer = null;
async function openPending(id, first) {
  stopPending();
  openWatchShell('Sign-in progress');
  watchMsg().textContent = (first && first.message) || 'Waiting for Google to finish checking…';
  watchMsg().classList.remove('hidden');
  renderPending(first || {});
  await pollPendingState(id);
  _pendingTimer = setInterval(() => pollPendingState(id), 3500);
}
function stopPending() {
  if (_pendingTimer) { clearInterval(_pendingTimer); _pendingTimer = null; }
}
async function pollPendingState(id) {
  try {
    const r = await api(`/sessions/${id}/state`);
    const d = await r.json();
    if (!d.open) {
      stopPending();
      closeWatch();
      load();
      return;
    }
    renderPending(d);
    if (d.state === 'trusted') {
      stopPending();
      toast('Device registered ✓ This OS is the keypass for the account now.', 'ok');
      watchMsg().textContent = 'Device registered ✓ Future sign-ins on this OS skip the phone-tap / 2FA for this account.';
      watchMsg().classList.remove('hidden');
      setTimeout(() => { closeWatch(); load(); }, 2500);
    } else if (d.status === 'logged-in' || d.state === 'signed-in') {
      // signed in — the state endpoint auto-advances the device registration
      // (keypass) now; keep polling so the modal tracks its pages (number etc).
      toast('Signed in — registering this device with the account…', 'ok');
      watchMsg().textContent = 'Signed in ✓ Now registering this OS as the trusted device (keypass) — progress here.';
      watchMsg().classList.remove('hidden');
    } else if (d.status === 'error') {
      stopPending();
      watchMsg().textContent = d.message || 'Sign-in hit an error.';
      watchMsg().classList.remove('hidden');
      load();
    }
  } catch {}
}
function renderPending(d) {
  const opts = (d.options && d.options.length) ? d.options : null;
  if (opts && opts.join('|') !== (watchNumbers().dataset.opts || '')) {
    watchNumbers().dataset.opts = opts.join('|');
    watchNumbers().innerHTML =
      (opts.length === 1
        ? '<div class="watch-num-label">Verification number on Google’s page</div>'
        : '<div class="watch-num-label">Pick the number Google is showing</div>') +
      opts.map((n) => `<div class="watch-number">${escapeHtml(n)}</div>`).join('');
  }
  watchNumbers().classList.toggle('hidden', !opts);
  if (d.message) {
    watchMsg().classList.remove('hidden');
    watchMsg().textContent = d.message;
  }
}

async function doTrust(id) {
  toast('Registering this OS as the trusted device…');
  const r = await api(`/sessions/${id}/trust`, { method: 'POST' });
  const d = await r.json();
  if (!d.ok) { toast(d.error || 'Device registration failed', 'err'); load(); return; }
  toast(d.message || 'Device registration started.', d.state === 'trusted' ? 'ok' : '');
  maybeWatchPending(id, d);
  load();
}

async function doClose(id) {
  await api(`/sessions/${id}/close`, { method: 'POST' });
  toast('Browser closed.', 'ok');
  load();
}

async function doDelete(id) {
  if (!confirm('Delete this session and its stored browser data?')) return;
  await api(`/sessions/${id}`, { method: 'DELETE' });
  toast('Session deleted.');
  load();
}

// ---------- modal ----------
function openModal() {
  $('modal-title').textContent = 'New session';
  $('session-form').reset();
  $('f-id').value = '';
  $('form-error').textContent = '';
  toggleUrlRow();
  $('modal').classList.remove('hidden');
  $('f-name').focus();
}
function closeModal() {
  $('modal').classList.add('hidden');
}
function editSession(id) {
  const s = CACHE.find((x) => x.id === id);
  if (!s) return;
  $('modal-title').textContent = 'Edit session';
  $('f-id').value = s.id;
  $('f-name').value = s.name;
  $('f-provider').value = s.provider;
  $('f-url').value = s.loginUrl || '';
  $('f-username').value = s.username || '';
  $('f-password').value = '';
  $('f-totp').value = '';
  $('f-note').value = s.note || '';
  $('form-error').textContent = '';
  toggleUrlRow();
  $('modal').classList.remove('hidden');
}

function toggleUrlRow() {
  $('url-row').classList.toggle('hidden', $('f-provider').value === 'google');
}
$('f-provider').addEventListener('change', toggleUrlRow);
$('new-btn').addEventListener('click', openModal);

$('session-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('f-id').value;
  const payload = {
    name: $('f-name').value,
    provider: $('f-provider').value,
    loginUrl: $('f-url').value,
    username: $('f-username').value,
    note: $('f-note').value,
  };
  const pw = $('f-password').value;
  const totp = $('f-totp').value;
  if (pw) payload.password = pw;
  if (id) {
    payload.totpSecret = totp; // editable; empty clears
    const r = await api(`/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    if (!r.ok) return ($('form-error').textContent = 'Save failed.');
  } else {
    if (totp) payload.totpSecret = totp;
    const r = await api('/sessions', { method: 'POST', body: JSON.stringify(payload) });
    if (!r.ok) return ($('form-error').textContent = 'Create failed.');
  }
  closeModal();
  toast('Saved.', 'ok');
  load();
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// expose for inline handlers
window.openModal = openModal;
window.closeModal = closeModal;
window.editSession = editSession;
window.doOpen = doOpen;
window.doLogin = doLogin;
window.doClose = doClose;
window.doDelete = doDelete;
window.copyText = copyText;
window.shareLink = shareLink;
window.toggleDrawer = toggleDrawer;
window.openStream = openStream;
window.closeWatch = closeWatch;
window.doTrust = doTrust;

// ---------- live session view (screencast stream) ----------
// Frames arrive as base64 JPEGs over SSE (/api/sessions/:id/stream?token=).
// Same modal as the pending-challenge tracker; a session id in the title is
// how closeWatch knows what to stop.
let _stream = null;      // EventSource or null
let _watchId = null;     // session id currently in the watch modal

const watchImg = () => $('watch-frame');
const watchNumbers = () => $('watch-numbers');
const watchMsg = () => $('watch-msg');
function openWatchShell(title, message, options) {
  $('watch-title').textContent = title;
  $('watch-modal').classList.remove('hidden');
  watchImg().classList.add('hidden');
  $('watch-live').classList.add('hidden');
  if (message !== undefined) {
    watchMsg().textContent = message;
    watchMsg().classList.remove('hidden');
  } else {
    watchMsg().classList.add('hidden');
  }
  if (options !== undefined) renderPending({ options });
  else watchNumbers().classList.add('hidden');
}

function openStream(id, name) {
  stopPending();
  _watchId = id;
  $('watch-title').textContent = `Live: ${name}`;
  watchMsg().classList.add('hidden');
  watchNumbers().classList.add('hidden');
  watchImg().src = '';
  watchImg().classList.remove('hidden');
  $('watch-live').classList.remove('hidden');
  $('watch-modal').classList.remove('hidden');
  closeStream();
  const es = new EventSource('/api/sessions/' + id + '/stream?token=' + encodeURIComponent(TOKEN));
  es.onmessage = (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (d.type === 'frame') {
      watchImg().src = 'data:image/jpeg;base64,' + d.frame;
    } else if (d.type === 'error') {
      watchMsg().textContent = 'Stream error: ' + d.message;
      watchMsg().classList.remove('hidden');
    }
  };
  es.onerror = () => { /* EventSource auto-reconnects */ };
  _stream = es;
}
function closeStream() {
  if (_stream) { _stream.close(); _stream = null; }
}
function closeWatch() {
  stopPending();
  closeStream();
  _watchId = null;
  $('watch-modal').classList.add('hidden');
  $('watch-live').classList.add('hidden');
  load(); // refresh card states (browser may have been closed)
}

// ---------- boot ----------
(async function boot() {
  if (TOKEN && (await checkToken(TOKEN))) {
    $('gate').classList.add('hidden');
    $('app').classList.remove('hidden');
    load();
    connectEvents();
  }
})();
