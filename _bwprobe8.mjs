import { chromium } from 'playwright';
const ctx = await chromium.launchPersistentContext('/tmp/bwp-c', {
  headless: false, channel: 'chrome', viewport: { width: 1100, height: 800 },
  args: ['--no-first-run', '--no-default-browser-check'],
});
await new Promise(r => setTimeout(r, 3000));
console.log('launched, keeping alive 20s');
await new Promise(r => setTimeout(r, 20000));
await ctx.close();
