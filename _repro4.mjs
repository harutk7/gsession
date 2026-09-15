import { chromium } from 'playwright';
import * as bw from './lib/bitwarden.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-repro4-'));
bw.seedProfile(dir);
const context = await chromium.launchPersistentContext(dir, {
  headless: false, viewport: { width: 1440, height: 900 },
  ignoreDefaultArgs: ['--enable-automation','--disable-extensions','--disable-component-update','--disable-background-networking'],
  args: ['--start-maximized','--no-first-run','--no-default-browser-check','--disable-blink-features=AutomationControlled', ...bw.launchArgs()],
  channel: 'chrome',
});
await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
const page = context.pages()[0] || (await context.newPage());
page.on('close', () => { console.log('PAGE CLOSED, url was', page.url()); console.trace('close stack'); });
context.on('page', p => { console.log('NEW TAB:', p.url()); });

// ensureOpen: goto LANDING
await page.bringToFront();
await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => console.log('gotoA err:', e.message));
try {
  const cdp = await context.newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getTargetInfo');
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
  await cdp.detach().catch(() => {});
  console.log('maximize OK');
} catch (e) { console.log('maximize failed:', e.message); }
console.log('t0 closed?', page.isClosed());

// 12s idle
await new Promise(r => setTimeout(r, 12000));
console.log('t12 closed?', page.isClosed(), 'url:', page.url().slice(0,60), 'tabs:', context.pages().length);

// username: about:blank -> google
await page.goto('about:blank', { timeout: 15000 }).catch(e => console.log('gotoB err:', e.message));
console.log('after about:blank closed?', page.isClosed());
await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => console.log('gotoC err:', e.message));
await new Promise(r => setTimeout(r, 1200));
console.log('final closed?', page.isClosed(), 'tabs:', context.pages().length);
const email = page.locator('#identifierId, input[name="identifier"], input[type="email"]');
console.log('email count:', await email.count().catch(e => 'ERR ' + e.message));
await context.close();
process.exit(0);
