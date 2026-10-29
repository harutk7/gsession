import { chromium } from 'playwright';

const token = 'fb6d36f28fcd82ba411c4b64248af777fa8e98ce521cdcf3';
const url = `http://127.0.0.1:3002/vnc/vnc.html?autoconnect=true&resize=scale&reconnect=true&cursor=auto&token=${token}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (err) => console.log('pageerror', err.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForSelector('#noVNC_canvas', { timeout: 30000 });
await page.waitForTimeout(6000);
const canvas = page.locator('#noVNC_canvas');
const box = await canvas.boundingBox();
console.log('canvas box', JSON.stringify(box));
if (box) {
  const x = box.x + box.width * 0.5;
  const y = box.y + Math.min(70, box.height * 0.08);
  console.log('click at', x, y);
  await page.mouse.click(x, y);
  await page.waitForTimeout(500);
  await page.keyboard.type('example.com', { delay: 50 });
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
}
await page.waitForTimeout(8000);
await page.screenshot({ path: '/tmp/opencode/vnc-input.png' });
const res = await fetch(`http://127.0.0.1:3002/api/sessions/153ea5aa-2c29-437c-bca7-e060e2ee3d5d/tabs`, { headers: { Authorization: `Bearer ${token}` } });
const tabs = await res.json();
console.log('tabs', JSON.stringify(tabs, null, 2));
await browser.close();