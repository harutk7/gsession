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

async function launch(id) {
  const dir = userDataDir(id);
  // Headed + real Chrome + these flags are what let Google's sign-in through:
  // - headed (never headless): headless is what triggers "browser may not be secure"
  // - channel 'chrome': the real installed Chrome, most trusted fingerprint
  // - hide the automation banner/flag so navigator.webdriver is false
  const baseOpts = {
    headless: false,
    viewport: null,
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
  const page = context.pages()[0] || (await context.newPage());
  const entry = { context, page };
  active.set(id, entry);
  context.on('close', () => active.delete(id));
  return entry;
}

// Open the session's browser (or focus it if already open) and navigate to a URL.
export async function open(id, url) {
  let entry = active.get(id);
  if (!entry) entry = await launch(id);
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
  // signed in: post-login pages (account home, the "add recovery info" /
  // "protect your account" interstitials, or bounced back to the app)
  if (/myaccount\.google\.com|gds\.google\.com\/web|\/signin\/(continue|oauth\/consent)|ManageAccount/.test(url)) {
    return { status: 'logged-in', message: 'Signed in successfully — session saved.' };
  }
  return null;
}

async function googleLogin(page, session, secrets) {
  try {
    await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(2000);

    // already signed in?
    const pre = classify(page.url());
    if (pre?.status === 'logged-in') return { status: 'logged-in', message: 'Already signed in.' };

    // --- email --- (lite flow: name="identifier", type text)
    const email = page.locator('#identifierId, input[name="identifier"], input[type="email"]');
    if (await email.count()) {
      await email.first().fill(session.username);
      await clickNext(page, 'Next');
      await sleep(3500);
    }

    const afterEmail = classify(page.url());
    if (afterEmail?.status === 'error') return afterEmail;

    // --- password --- (only the visible password field, not hiddenPassword)
    const pw = page.locator('input[type="password"][name="Passwd"], input[type="password"]:visible');
    await pw.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    if (await pw.count()) {
      if (!secrets.password) {
        return { status: 'new', message: 'No stored password. Finish signing in manually in the browser window.' };
      }
      await pw.first().fill(secrets.password);
      await clickNext(page, 'Next');
      await sleep(5000);
    }

    // --- 2FA / TOTP ---
    const totp = page.locator('input[name="totpPin"], input#totpPin, input[type="tel"]');
    if ((await totp.count()) && secrets.totpSecret) {
      const code = authenticator.generate(secrets.totpSecret);
      await totp.first().fill(code);
      await clickNext(page, 'Next');
      await sleep(4000);
    }

    const final = classify(page.url());
    if (final) return final;

    return {
      status: 'pending',
      message:
        'Credentials submitted. A verification step (2FA code, device confirmation, captcha or "protect your account") is waiting in the browser window — finish it there and the session is saved.',
    };
  } catch (e) {
    return {
      status: 'error',
      message: `Auto-login could not complete (${e.message}). Finish sign-in manually in the browser window.`,
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
