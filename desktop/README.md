# RouteReady Desktop

Electron app DSPs install on a workstation. Drives the Amazon DSP portal
under the operator's corporate SSO inside a managed Chromium, pulls route
data + pick sheets, ships them to RouteReady's Supabase.

## Why a desktop app

Amazon's DSP portal sits behind corporate SSO + MFA. Sharing those creds
with a third-party server is a non-starter for most DSPs. A local desktop
app:

- Keeps creds on the operator's machine (Amazon collects them in their own
  login UI inside the app's headed Chromium — we never see the password).
- Persists the session as encrypted cookies via the OS keychain (Electron
  `safeStorage` → macOS Keychain / Windows DPAPI / libsecret on Linux).
- Runs scheduled syncs in the background without keeping a browser open.

## Tech

- **Electron** — main/renderer + safeStorage for the cookie jar.
- **Playwright** (bundled Chromium) — drives the portal headed (login) and
  headless (scheduled syncs).
- **Supabase JS** — uploads parsed reports to RouteReady.
- **electron-store** — local config (portal URL, scheduler, etc.).

## Dev setup

```bash
cd desktop
npm install
npm start
```

`npm install` runs `playwright install chromium` post-install to fetch the
matching Chromium build. Adds ~150 MB.

## Files

- `main.js` — Electron main process. Owns the BrowserWindow + Playwright.
- `preload.js` — `contextBridge` surface exposed to the renderer.
- `renderer/` — local UI (HTML/CSS/JS only, no framework).
  - `index.html` — three-step shell: sign in → verify session → pull routes.
  - `renderer.js` — UI logic, talks to main via `window.rr`.
  - `styles.css` — tokens matched to the web dashboard.

## Auth flow

1. **First run**: operator clicks _Open portal & sign in_. We launch a
   visible Chromium pointed at `https://logistics.amazon.com/`. They sign in
   normally with SSO + MFA.
2. They click _I'm signed in_ in the desktop UI. We call
   `BrowserContext.storageState()` and persist it (encrypted) to
   `userData/portal-session.enc`.
3. **Subsequent runs**: we launch headless Chromium with the saved state.
   The session reuses the existing login.
4. **Probe** verifies the session is live (lands on the portal home, not
   the login page).
5. **Logout** wipes the persisted state and forces re-auth.

## What's wired

- Manual login flow (button → headed browser → operator signs in → save).
- Encrypted session persistence (safeStorage with plaintext fallback).
- Headless probe to detect expired sessions.
- IPC scaffolding for future report endpoints.

## What's next

- **MIDWAY route plan scrape** — `routes:pullToday` IPC handler currently
  returns `not_implemented`. Hook up Playwright to read the route table for
  today's date.
- **Driver assignment write-back** — POST RouteReady's planned assignments
  to MIDWAY.
- **Pick sheet download** — trigger the portal's print/export flow, save
  PDFs to disk and to Supabase storage.
- **Scheduled background sync** — `node-cron` style scheduler in the main
  process, configurable from settings.
- **Supabase auth** — link the Electron client to a RouteReady DSP account
  via magic-link or device code flow.
- **Auto-update** — `electron-updater` + a release pipeline (probably
  GitHub Releases). Code-signing certs (Apple Developer + Windows EV)
  before public distribution.

## Packaging

```bash
npm run build:mac    # → dist/RouteReady Desktop-0.1.0.dmg
npm run build:win    # → dist/RouteReady Desktop Setup 0.1.0.exe
```

Unsigned builds work for internal testing. Signed + notarized builds
require Apple Developer ($99/yr) and a Windows EV cert ($200-400/yr) when
you're ready to ship to DSPs.
