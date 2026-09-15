const bw = await import('./lib/bitwarden.js');
const { chromium } = await import('playwright');
const path = await import('path');
const ID = 'nngceckbapebfimnlniiiahkandclblb';
const TPL = 'sessions/_bw_template';
const ctx = await chromium.launchPersistentContext(TPL, {
  headless: false, channel: 'chrome', viewport: { width: 1100, height: 800 },
  ignoreDefaultArgs: ['--enable-automation', '--disable-extensions', '--disable-component-update', '--disable-background-networking'],
  args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled', '--start-maximized'],
});
// wait for extension
let page = null;
for (let i = 0; i < 20 && !page; i++) {
  await new Promise(r => setTimeout(r, 3000));
  const p = await ctx.newPage().catch(() => null);
  if (!p) continue;
  const ok = await p.goto(`chrome-extension://${ID}/popup/index.html`, { waitUntil: 'domcontentloaded', timeout: 8000 }).then(() => true).catch(() => false);
  if (ok) page = p; else await p.close().catch(() => {});
}
if (!page) { console.log('extension never appeared'); process.exit(1); }
console.log('popup open, watching with screenshots…');
const fs = await import('fs');
fs.mkdirSync('shots', { recursive: true });
let unlocked = false;
for (let i = 0; i < 60; i++) { // 30 min
  await new Promise(r => setTimeout(r, 30000));
  try {
    if (page.isClosed()) {
      page = await ctx.newPage();
      await page.goto(`chrome-extension://${ID}/popup/index.html`, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
    }
    await page.screenshot({ path: 'shots/repair-live.png' });
    const hash = page.url().split('#').pop() || '';
    const text = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
    console.log(`[${i}] hash=${hash.slice(0, 40)} text=${text.slice(0, 120).replace(/\n+/g, ' | ')}`);
    if (/\/vault/.test(hash) || /my vault|all vaults|search vault/.test(text)) { unlocked = true; break; }
  } catch (e) { console.log('tick err', e.message.slice(0, 60)); }
}
console.log('unlocked:', unlocked);
if (unlocked) {
  // set vault timeout Never via Settings tab
  try {
    const tab = page.getByRole('tab', { name: /settings/i }).first();
    if (await tab.isVisible({ timeout: 4000 }).catch(() => false)) await tab.click();
    else await page.getByText(/settings/i).first().click().catch(() => {});
    await page.waitForTimeout(3000);
    const picked = await page.evaluate(() => {
      for (const s of document.querySelectorAll('select')) {
        let n = s;
        for (let k = 0; k < 6 && n.parentElement; k++) n = n.parentElement;
        if (/vault timeout/i.test(n.textContent || '')) {
          const opt = [...s.options].find((o) => /never/i.test(o.text));
          if (opt) { s.value = opt.value; s.dispatchEvent(new Event('change', { bubbles: true })); return opt.text; }
        }
      }
      return null;
    });
    console.log('timeout Never set:', picked);
    await page.screenshot({ path: 'shots/repair-settings.png' }).catch(() => {});
    await page.waitForTimeout(3000);
  } catch (e) { console.log('timeout set failed:', e.message.slice(0, 80)); }
  await ctx.close().catch(() => {});
  // wipe + reseed
  const fs2 = await import('fs');
  const EXT = 'nngceckbapebfimnlniiiahkandclblb';
  let wiped = 0;
  for (const name of fs2.readdirSync('sessions')) {
    if (name === '_bw_template') continue;
    const def = `sessions/${name}/Default`;
    try {
      if (!fs2.statSync(def).isDirectory()) continue;
      fs2.rmSync(`${def}/Local Extension Settings/${EXT}`, { recursive: true, force: true });
      const idb = `${def}/IndexedDB`;
      if (fs2.existsSync(idb)) for (const sub of fs2.readdirSync(idb)) if (/chrome-extension_/.test(sub)) fs2.rmSync(`${idb}/${sub}`, { recursive: true, force: true });
      wiped++;
    } catch {}
  }
  const seeded = bw.seedExistingProfiles(() => false);
  console.log(`wiped ${wiped}, re-seeded ${seeded}`);
}
process.exit(0);
