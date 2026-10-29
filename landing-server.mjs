// TransLogistX landing page server (port 3005).
// Serves the static clone of translogistx.com and proxies the driver
// registration wizard (/w/*, /wizard.*, /api/wizard/*) to the main gsession
// server, so the landing works as a self-contained site behind its own tunnel.
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UP = process.env.GSESSION_URL || 'http://127.0.0.1:3002';
const PORT = process.env.LANDING_PORT || 3005;

const app = express();
// 30mb: the driver step carries optional document uploads as base64 before
// this proxy forwards the body to the main gsession server.
app.use(express.json({ limit: '30mb' }));

const PROXY = ['/signin', '/w/', '/api/wizard/', '/wizard.css', '/wizard.js'];
app.use(async (req, res, next) => {
  if (!PROXY.some((p) => req.path === p || req.path.startsWith(p))) return next();
  try {
    const upstream = await fetch(UP + req.originalUrl, {
      method: req.method,
      headers: { 'content-type': req.headers['content-type'] || 'application/json' },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
      redirect: 'manual',
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.set('content-type', ct);
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: 'ups unreachable: ' + e.message });
  }
});

app.use(express.static(path.join(__dirname, 'public', 'landing')));

app.listen(PORT, '0.0.0.0', () => console.log(`\n  TransLogistX landing:  http://localhost:${PORT}\n`));
