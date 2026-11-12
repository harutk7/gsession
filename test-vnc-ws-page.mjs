import { chromium } from 'playwright';
const token = 'fb6d36f28fcd82ba411c4b64248af777fa8e98ce521cdcf3';
const url = `http://127.0.0.1:3002/vnc/vnc.html?autoconnect=true&resize=scale&token=${token}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const result = await page.evaluate(async () => {
  return await new Promise((resolve) => {
    const ws = new WebSocket('ws://' + location.host + '/websockify');
    ws.onopen = () => { ws.send('ping'); resolve({ ok: true, ready: ws.readyState }); ws.close(); };
    ws.onerror = (e) => resolve({ ok: false, error: 'ws error' });
    ws.onclose = (e) => resolve({ ok: ws.readyState === 1, closeCode: e.code, reason: e.reason });
    setTimeout(() => resolve({ ok: false, timeout: true }), 5000);
  });
});
console.log(JSON.stringify(result));
await browser.close();
