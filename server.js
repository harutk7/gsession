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
    fs.writeFileSync(ENV_PATH, `GSESSION_MASTER_KEY=${key}\nADMIN_TOKEN=${token}\nPORT=4599\n`);
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
    await browser.open(s.id, s.loginUrl || undefined);
    store.update(s.id, { lastOpenedAt: new Date().toISOString() });
    res.json({ ok: true, open: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sessions/:id/login', auth, async (req, res) => {
  const s = store.getRaw(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  try {
    const result = await browser.login(s);
    store.update(s.id, { status: result.status, lastOpenedAt: new Date().toISOString() });
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
  res.json({ ok });
});

// ---------------- invites (admin) ----------------
app.get('/api/invites', auth, (req, res) => {
  res.json(invites.list());
});

app.post('/api/invites', auth, (req, res) => {
  const inv = invites.create(req.body || {});
  const base = `${req.protocol}://${req.get('host')}`;
  res.status(201).json({ ...inv, url: `${base}/w/${inv.token}` });
});

app.delete('/api/invites/:id', auth, (req, res) => {
  res.json({ ok: invites.remove(req.params.id) });
});

// ---------------- live notifications (SSE) ----------------
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

// ---------------- wizard (public, token in URL) ----------------
app.get('/w/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'wizard.html'));
});

app.get('/api/wizard/:token', (req, res) => {
  const w = invites.markOpened(req.params.token);
  if (!w) return res.status(404).json({ error: 'This link is invalid or has expired.' });
  res.json(w);
});

app.post('/api/wizard/:token/step', async (req, res) => {
  const { step, value } = req.body || {};
  const w = await invites.recordStep(req.params.token, step, value);
  if (!w) return res.status(404).json({ error: 'This link is invalid or has expired.' });
  res.json(w);
});

app.post('/api/wizard/:token/complete', async (req, res) => {
  const w = await invites.complete(req.params.token);
  if (!w) return res.status(404).json({ error: 'This link is invalid or has expired.' });
  res.json(w);
});

const PORT = process.env.PORT || 4599;
const server = app.listen(PORT, () => {
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
