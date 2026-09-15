import { chromium } from 'playwright';
import * as bw from './lib/bitwarden.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-repro-'));
bw.seedProfile(dir);
const context = await chromium.launchPersistentContext(dir, {
  headless: false,
  viewport: { width: 1440, height: 900 },
  ignoreDefaultArgs: ['--enable-automation','--disable-extensions','--disable-component-update','--disable-background-networking'],
  args: ['--start-maximized','--no-first-run','--no-default-browser-check','--disable-blink-features=AutomationControlled', ...bw.launchArgs()],
  channel: 'chrome',
});
const page = context.pages()[0] || (await context.newPage());
console.log('initial page url:', page.url(), 'pid?', process.pid);
page.on('close', () => console.log('PAGE CLOSED at', new Date().toISOString(), 'url was', page.url()));
context.on('page', p => { console.log('NEW PAGE:', p.url()); p.on('close', () => console.log('NEW PAGE CLOSED')); });
context.on('close', () => console.log('CONTEXT CLOSED'));
for (let i = 0; i < 12; i++) {
  await new Promise(r => setTimeout(r, 2000));
  const pages = context.pages();
  console.log(`t=${(i+1)*2}s pages=${pages.length}`, pages.map(p => `${p.url()}${p.isClosed()?' (closed)':''}`));
}
await context.close();
process.exit(0);
