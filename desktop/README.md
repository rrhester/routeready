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

## Building

You don't have to build this locally — GitHub Actions does it for you.

### CI builds (every push to `main`)

`.github/workflows/desktop-build.yml` runs on every push that touches
`desktop/`. It builds for Linux + Windows + macOS in parallel and
uploads the installers as workflow artifacts. To grab one:

1. Open the [Actions tab](https://github.com/rrhester/routeready/actions/workflows/desktop-build.yml).
2. Click the latest successful run.
3. Scroll to **Artifacts** at the bottom — `routeready-desktop-windows-latest`,
   `routeready-desktop-macos-latest`, `routeready-desktop-ubuntu-latest`.
4. Download the zip, unzip → installer inside.

### Release builds

Push a tag matching `desktop-v*` (e.g. `desktop-v0.1.0`) and the same
workflow creates a [GitHub Release](https://github.com/rrhester/routeready/releases)
with all three installers attached. Send DSPs the release page URL.

```bash
git tag desktop-v0.1.0
git push origin desktop-v0.1.0
```

### Local dev (optional)

If you do want to run it locally on a Linux box (or via Crostini on a
Chromebook):

```bash
cd desktop
npm install
npm start
```

`npm install` runs `playwright install chromium` post-install to fetch
the matching Chromium build. Adds ~150 MB.

### Running on a Chromebook (Crostini)

ChromeOS can't run `.exe` or `.dmg` and the bundled `.AppImage` won't
launch from the Files app. But every modern Chromebook can enable
**Linux development environment** (Crostini) which runs a minimal
Debian inside ChromeOS — Electron apps run fine there.

**One-time setup** (~10 min):

1. Open ChromeOS **Settings → About ChromeOS → Developers → Linux development environment** → click **Set up**. Pick the default disk size (or 10 GB+) and any username.
2. When done, the Terminal app appears in your launcher. Open it.
3. Install Node + git:

   ```bash
   sudo apt update
   sudo apt install -y nodejs npm git
   ```

4. Clone the repo and run the app:

   ```bash
   git clone https://github.com/rrhester/routeready.git
   cd routeready/desktop
   npm install
   npm start
   ```

The app window should pop up inside ChromeOS like any other Linux app.

**Quirks to know about**:

- First `npm install` takes 3-5 min while Playwright downloads
  Chromium.
- Electron windows render through a slower compositor on Crostini —
  expect a tiny amount of jank. Functional, not pretty.
- File-save dialogs sometimes default to the Linux home directory
  (`~/`), which appears in the ChromeOS Files app under **Linux files**.

**Alternative**: download the Linux `.AppImage` from the CI build
artifacts. From a Crostini terminal:

```bash
cd ~/Downloads   # or wherever you put it
chmod +x RouteReady\ Desktop-*.AppImage
./RouteReady\ Desktop-*.AppImage
```

## Files

- `main.js` — Electron main process. Owns the BrowserWindow + Playwright.
- `scraper.js` — record-and-replay scraping (recorder + headless replay).
- `agent.js` — AI agent crawler: Claude-driven browser-automation loop,
  DOM-snapshot tool surface, task scheduler, CSV + RouteReady upload sinks.
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
- **Generic report download** — paste a URL (and optional click selector),
  the app navigates with the saved session and saves the file. Works on
  any benign target for shake-down before pointing it at Amazon.
- Per-download history (last 20) with "show in folder" reveal.
- **Scheduled downloads** — named jobs (URL + optional click selector +
  save folder + interval) fire on their own, unattended, reusing the
  saved portal session in a headless browser. Indeed Applicants CSV is
  seeded as a disabled job on first run — point the click selector at
  Indeed's Export button, set an interval, flip it on. Jobs skip silently
  while no portal session is saved; loop resumes after sign-in.
- **Record-and-replay scrapers** (`scraper.js`) — when a portal has no
  usable Export button (Indeed gates CSV export behind paid plans), the
  app can scrape the candidate list DOM instead. Operator hits **Record**
  → a headed Chromium opens with a pink toolbar overlay → walks them
  through clicking the elements to scrape (row, name, email, phone,
  reveal buttons, close panel) → the resulting CSS selectors save as a
  recipe JSON file in `<userData>/recipes/`. Scheduled runs replay the
  recipe headlessly, walking each row, clicking reveal buttons,
  scraping into a deduped CSV. **When the portal changes layout the
  operator hits Re-record — no app reinstall, no waiting on a build.**
  Seeded with an empty `Indeed — New applicants` recipe on first run.
- **AI agent crawler** (`agent.js`) — the agentic successor to
  record-and-replay. Instead of a recorded click-path, the operator
  writes a plain-English **goal** ("find every applicant and record
  their name, email, phone"). The agent loop (Claude + Playwright)
  reads a structured accessibility snapshot of the live page — every
  interactive element tagged with a `[ref]` — decides the next action
  (click / type / scroll / navigate), extracts records via a `save_rows`
  tool, and pages through the whole list. Because it reasons over the
  page rather than replaying selectors, it survives layout changes with
  no re-record. Output goes two places: a deduped CSV on disk **and**
  (optionally) straight into RouteReady — each row is POSTed to the
  public `webhook-apply` edge function → `intake_applicant()`, which
  dedupes by email / source_ref per DSP. Inference runs on the
  operator's **own Anthropic API key**, stored encrypted via
  `safeStorage` exactly like the portal session — page content goes
  operator → Anthropic directly, never through RouteReady. `callModel()`
  is the single transport seam if we later want to route through a
  RouteReady Supabase proxy. Tasks live in `<userData>/agent-tasks/`,
  deduped against `<userData>/agent-seen-*.json`; seeded with a disabled
  `Indeed — applicants (AI agent)` task on first run.

## What's next

- **RouteReady-proxied inference** — optional transport that routes the
  agent's model calls through a Supabase edge function holding the
  Anthropic key, so RouteReady can own the key + bill (swap `callModel`).
- **Migrate recipes → agent tasks** — once the agent is proven, fold the
  record-and-replay recipes into goal-driven tasks and retire the picker.
- **Pre-baked Amazon report shortcuts** — same scheduler infra, named
  report presets (Route Plan, Driver Performance, Cycle 1 pick sheets…).
- **Driver assignment write-back** — POST RouteReady's planned assignments
  to MIDWAY.
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
