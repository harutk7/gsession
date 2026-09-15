import { chromium } from 'playwright';
import path from 'path';
const dir = path.join(process.cwd(), 'diag-inspect');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(headless) {
  console.log(`\n######## headless=${headless} ########`);
  const ctx = await chromium.launchPersistentContext(dir + '-' + headless, {
    headless,
    channel: 'chrome',
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2500);
  console.log('flow URL:', page.url().slice(0, 90));
  const inputs = await page.evaluate(() =>
    [...document.querySelectorAll('input')].map((i) => ({ type: i.type, name: i.name, id: i.id, aria: i.getAttribute('aria-label') }))
  );
  const buttons = await page.evaluate(() =>
    [...document.querySelectorAll('button, [role=button], input[type=submit]')].map((b) => ({ id: b.id, text: (b.innerText || b.value || '').slice(0, 20), type: b.type }))
  );
  console.log('INPUTS:', JSON.stringify(inputs));
  console.log('BUTTONS:', JSON.stringify(buttons.filter((b) => b.text || b.id)));
  await ctx.close();
}

await run(true);
await run(false);
process.exit(0);
