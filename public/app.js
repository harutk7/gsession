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
  const labels = { 'logged-in': 'logged in', pending: 'needs 2FA', error: 'error', new: 'new' };
  return `<span class="badge ${s.status}">${labels[s.status] || s.status}</span>`;
}

function card(s) {
  const chips = [];
  chips.push(`<span class="chip">${s.provider}</span>`);
  if (s.hasPassword) chips.push('<span class="chip">password ✓</span>');
  if (s.hasTotp) chips.push('<span class="chip">2FA ✓</span>');
  const driver = [];
  if (s.driverName) driver.push(`<span class="chip driver">👤 ${escapeHtml(s.driverName)}</span>`);
  if (s.licensePlate) driver.push(`<span class="chip driver">🚚 <b>${escapeHtml(s.licensePlate)}</b></span>`);
  if (s.phone) driver.push(`<span class="chip driver">📞 ${escapeHtml(s.phone)}</span>`);
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
  type === 'wizard.opened' ? 'opened'
  : type === 'wizard.completed' || type === 'wizard.logged-in' ? 'completed'
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
  if (d.ok) toast('Browser opened.', 'ok');
  else toast(d.error || 'Failed to open', 'err');
  load();
}

async function doLogin(id) {
  toast('Opening browser and signing in…');
  const r = await api(`/sessions/${id}/login`, { method: 'POST' });
  const d = await r.json();
  if (d.ok) toast(d.message || 'Done', d.status === 'error' ? 'err' : 'ok');
  else toast(d.error || 'Login failed', 'err');
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

// ---------- boot ----------
(async function boot() {
  if (TOKEN && (await checkToken(TOKEN))) {
    $('gate').classList.add('hidden');
    $('app').classList.remove('hidden');
    load();
    connectEvents();
  }
})();
