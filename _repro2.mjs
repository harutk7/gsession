import { chromium } from 'playwright';
import * as bw from './lib/bitwarden.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-repro2-'));
bw.seedProfile(dir);
const context = await chromium.launchPersistentContext(dir, {
  headless: false,
  viewport: { width: 1440, height: 900 },
  ignoreDefaultArgs: ['--enable-automation','--disable-extensions','--disable-component-update','--disable-background-networking'],
  args: ['--start-maximized','--no-first-run','--no-default-browser-check','--disable-blink-features=AutomationControlled', ...bw.launchArgs()],
  channel: 'chrome',
});
await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
const page = context.pages()[0] || (await context.newPage());
page.on('close', () => console.log('PAGE CLOSED, url was', page.url()));

// step 1: goto google (like ensureOpen)
await page.bringToFront();
await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => console.log('goto1 err:', e.message));
// maximize CDP (like open())
try {
  const cdp = await context.newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
  await cdp.detach().catch(() => {});
  console.log('maximize OK');
} catch (e) { console.log('maximize failed:', e.message); }
console.log('after goto1 closed?', page.isClosed());

// 10s idle
await new Promise(r => setTimeout(r, 10000));
console.log('after idle closed?', page.isClosed(), 'url:', page.url());

// step 2: second goto (like wizardPhase username)
await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => console.log('goto2 err:', e.message));
await new Promise(r => setTimeout(r, 1200));
const email = page.locator('#identifierId, input[name="identifier"], input[type="email"]');
const n = await email.count().catch(e => 'count err: ' + e.message);
console.log('email count:', n, 'closed?', page.isClosed(), 'url:', page.url());
await context.close();
process.exit(0);
