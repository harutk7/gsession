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
  const labels = { 'logged-in': 'logged in', trusted: 'passkey ✓', pending: 'needs 2FA', error: 'error', new: 'new' };
  return `<span class="badge ${s.status}">${labels[s.status] || s.status}</span>`;
}

function card(s) {
  const chips = [];
  chips.push(`<span class="chip">${s.provider}</span>`);
  if (s.hasPassword) chips.push('<span class="chip">password ✓</span>');
  if (s.hasTotp) chips.push('<span class="chip">2FA ✓</span>');
  if (s.deviceTrusted) chips.push('<span class="chip trusted">🔑 passkey ✓</span>');
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
      <button class="primary" onclick="doOpen('${s.id}')">Open</button>
      ${s.open ? `<button onclick="openStream('${s.id}','${escapeHtml(s.name)}')">📺 Watch</button>` : ''}
      ${s.open ? `<button onclick="doClose('${s.id}')">Close</button>` : ''}
      <button onclick="editSession('${s.id}')">Edit</button>
      <button class="danger" onclick="doDelete('${s.id}')">Delete</button>
    </div>
    ${s.open ? `
    <div class="agent-box">
      <div class="agent-row">
        <input id="agent-in-${s.id}" placeholder="Tell the agent… e.g. &lsquo;sign in with the stored credentials&rsquo;" onkeydown="if(event.key==='Enter')doAgent('${s.id}')" />
        <button class="primary" id="agent-run-${s.id}" onclick="doAgent('${s.id}')">🤖 Run</button>
      </div>
      <div class="agent-log" id="agent-log-${s.id}"></div>
    </div>` : ''}
  </div>`;
}

let CACHE = [];
async function load() {
  if (agentBusy.size) return; // don't wipe a live agent transcript mid-run
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
    // wizard activity should refresh the session cards
    if (evt.type && evt.type.startsWith('wizard')) load();
    // live agent progress -> the session card's transcript
    if (evt.type === 'agent.step' && evt.sessionId) agentLog(evt.sessionId, evt.message);
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
  toast('Launching browser + agent…');
  const r = await api(`/sessions/${id}/open`, { method: 'POST' });
  const d = await r.json();
  if (d.ok) {
    toast(d.agent && d.agent.ok ? (d.message || 'Browser opened. Agent ready.')
      : 'Browser opened (agent: ' + ((d.agent && d.agent.error) || 'warming up') + ').', 'ok');
  } else toast(d.error || 'Failed to open', 'err');
  load();
}

// ---------- agent (LLM computer-use) ----------
const agentBusy = new Set();
function agentLog(id, text) {
  const el = $('agent-log-' + id);
  if (!el) return;
  const div = document.createElement('div');
  div.className = 'agent-line';
  div.textContent = text;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}
async function doAgent(id) {
  const input = $('agent-in-' + id);
  const instruction = (input ? input.value : '').trim();
  if (!instruction || agentBusy.has(id)) return;
  agentBusy.add(id);
  if (input) { input.value = ''; input.disabled = true; }
  const btn = $('agent-run-' + id);
  if (btn) btn.disabled = true;
  agentLog(id, '▶ ' + instruction);
  try {
    const r = await api(`/sessions/${id}/agent`, { method: 'POST', body: JSON.stringify({ instruction }) });
    const d = await r.json();
    if (d.ok) toast('Agent: ' + (d.summary || 'done').slice(0, 140), 'ok');
    else toast(d.error || 'Agent failed', 'err');
  } catch (e) {
    toast('Agent error: ' + e.message, 'err');
  } finally {
    agentBusy.delete(id);
    if (input) input.disabled = false;
    if (btn) btn.disabled = false;
    load();
  }
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

// One-time Bitwarden template login: opens a Chrome window where we log into
// OUR vault by hand; afterwards every session browser carries it.
$('bw-btn').addEventListener('click', async () => {
  toast('Opening Bitwarden template window — log in there once…');
  const r = await api('/bitwarden/template', { method: 'POST' });
  const d = await r.json();
  toast(d.message || (d.ok ? 'Started.' : 'Failed'), d.ok ? 'ok' : 'err');
});

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
window.doAgent = doAgent;
window.doClose = doClose;
window.doDelete = doDelete;
window.copyText = copyText;
window.shareLink = shareLink;
window.toggleDrawer = toggleDrawer;
window.openStream = openStream;
window.closeWatch = closeWatch;

// ---------- live session view (screencast stream) ----------
// Frames arrive as base64 JPEGs over SSE (/api/sessions/:id/stream?token=).
// Same modal as the pending-challenge tracker; a session id in the title is
// how closeWatch knows what to stop.
let _stream = null;      // EventSource or null
let _watchId = null;     // session id currently in the watch modal

const watchImg = () => $('watch-frame');
const watchMsg = () => $('watch-msg');
function openWatchShell(title, message) {
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
}

function openStream(id, name) {
  _watchId = id;
  $('watch-title').textContent = `Live: ${name}`;
  watchMsg().classList.add('hidden');
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
