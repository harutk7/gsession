// List all CDP windows + targets of the gession browser, plus passkey count on the Google page.
import http from 'http';

const CDP_PORT = 9333;

function get(path) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => res(d));
    }).on('error', rej);
  });
}

// minimal ws client (no deps) — use the built-in WebSocket in node 24
const wins = JSON.parse(await get('/json/list'));
const windowIds = [...new Set(wins.map((t) => t.windowId).filter(Boolean))];

const out = { windows: [], targets: [] };
// get window bounds via a CDP session on the first target
import ws from 'ws';
const anyT = wins.find((t) => t.type === 'page');
const sock = new ws(anyT.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((res) => {
    const myId = ++id;
    pending.set(myId, res);
    sock.send(JSON.stringify({ id: myId, method, params }));
  });
}
sock.on('message', (m) => {
  const msg = JSON.parse(m);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result || {});
    pending.delete(msg.id);
  }
});
await new Promise((r) => sock.on('open', r));

for (const wid of windowIds) {
  const b = await send('Browser.getWindowBounds', { windowId: Number(wid) });
  out.windows.push({ id: Number(wid), ...b.windowBounds });
}
out.targets = wins.map((t) => ({ id: t.id.slice(0, 8), type: t.type, win: t.windowId, title: (t.title || '').slice(0, 70), url: (t.url || '').slice(0, 90) }));

// count passkey entries on the google page
const g = wins.find((t) => /myaccount\.google\.com/.test(t.url || ''));
if (g) {
  const s2 = new ws(g.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id2 = 0;
  const p2 = new Map();
  s2.on('message', (m) => {
    const msg = JSON.parse(m);
    if (msg.id && p2.has(msg.id)) { p2.get(msg.id)(msg); p2.delete(msg.id); }
  });
  await new Promise((r) => s2.on('open', r));
  const expr = `(() => {
    const t = document.body ? document.body.innerText : '';
    const lines = t.split('\\n').map(s => s.trim()).filter(Boolean);
    const names = lines.filter(l => /Keychain|POCO|Passkey|Security key/i.test(l));
    return JSON.stringify({ url: location.href, names, hasCreate: /Create a passkey/i.test(t), hasDone: /Done/i.test(t) });
  })()`;
  const r = await new Promise((res) => {
    const myId = ++id2;
    p2.set(myId, res);
    s2.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  });
  out.google = JSON.parse((r.result && r.result.result && r.result.result.value) || 'null');
  s2.close();
}
sock.close();
console.log(JSON.stringify(out, null, 1));
