import { chromium } from 'playwright';
const token = 'fb6d36f28fcd82ba411c4b64248af777fa8e98ce521cdcf3';
const url = `http://127.0.0.1:3002/vnc/vnc.html?autoconnect=true&resize=scale&reconnect=true&cursor=auto&token=${token}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('console', (msg) => { const t=msg.text(); if(/error|fail|connect/i.test(t)) console.log('console', msg.type(), t); });
page.on('pageerror', (err) => console.log('pageerror', err.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(10000);
const state = await page.evaluate(() => ({
  err: document.getElementById('noVNC_fallback_errormsg')?.innerText || '',
  status: document.getElementById('noVNC_status')?.innerText || '',
  canvas: !!document.getElementById('noVNC_canvas'),
  container: !!document.getElementById('noVNC_container'),
  hasRfb: typeof window.rfb !== 'undefined'
}));
console.log(JSON.stringify(state, null, 2));
await browser.close();
