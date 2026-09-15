import { chromium } from 'playwright';
import * as bw from './lib/bitwarden.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-repro3-'));
bw.seedProfile(dir);
const context = await chromium.launchPersistentContext(dir, {
  headless: false, viewport: { width: 1440, height: 900 },
  ignoreDefaultArgs: ['--enable-automation','--disable-extensions','--disable-component-update','--disable-background-networking'],
  args: ['--start-maximized','--no-first-run','--no-default-browser-check','--disable-blink-features=AutomationControlled', ...bw.launchArgs()],
  channel: 'chrome',
});
const page = context.pages()[0] || (await context.newPage());
context.on('page', p => console.log('NEW TAB:', p.url()));
page.on('close', () => console.log('PAGE CLOSED'));

// land on identifier
await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
await new Promise(r => setTimeout(r, 3000));
console.log('on:', page.url().slice(0, 80));

// variant A: about:blank first, then google
await page.goto('about:blank', { timeout: 15000 }).catch(e => console.log('A1 err:', e.message));
console.log('A: after about:blank closed?', page.isClosed());
if (!page.isClosed()) {
  await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => console.log('A2 err:', e.message));
  await new Promise(r => setTimeout(r, 2000));
  console.log('A: after google closed?', page.isClosed(), 'url:', page.url().slice(0, 80));
}
process.exit(0);
