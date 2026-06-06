# RouteReady Desktop — Roadmap & State

_Last updated: 2026-06-06. This file is the durable handoff so work resumes
cleanly — read it first when picking this back up._

## Where we are (shipped + working)

- **AI agent crawler** (`agent.js`) — give it a plain-English goal; a Claude +
  Playwright loop reads a `[ref]`-tagged accessibility snapshot of the live
  page, decides each action, extracts records, writes a deduped CSV, and
  (optionally) uploads to RouteReady. **Verified working** (books.toscrape.com
  shakedown: 20/20 records, 2 steps).
- **Visible-browser mode** — bot-protected portals (Indeed/Cloudflare) get a
  real visible window; benign sites stay headless. Strips automation tells.
- **Background sync engine** — system tray + launch-at-login; closing the
  window hides to tray so scheduled crawls keep firing.
- **Option B — the app IS the dashboard** — the desktop app loads the live
  dashboard (`gorouteready.com/dashboard/`) in its window via a hardened,
  origin-gated native bridge. The bundled local UI is the offline fallback /
  "Portal sync settings".
- **"Connect from browser" pairing** — `desktop_pairings` table +
  `desktop-pair` edge function (mint/redeem) + `routeready://` deep-link +
  dashboard "Connect desktop app" button. **Verified working live** — the app
  signs into the dashboard as the DSP with no in-app magic-link.
- **Releases:** `desktop-v0.4.0` (standalone agent) and **`desktop-v0.5.0`**
  (Option B, current). The dashboard `/download` page serves "latest".

## The architecture we committed to: the appliance model

- **Operators live in the WEB app** (the dashboard PWA) on their own
  laptops/Chromebooks for all day-to-day work.
- **A dedicated always-on mini-PC** at the DSP (Windows, ~$120–180) runs the
  desktop app **headless** as a sync engine: signs into the portal, crawls on
  schedule, uploads to RouteReady → data shows up in the web app.
- **Why a box, not the cloud:** keeps the portal session on the DSP's side and
  crawls from the DSP's **real IP** (datacenter IPs get bot-blocked by
  Amazon/Indeed — the exact problem the desktop app exists to avoid), and
  guarantees fixed-time pulls regardless of anyone's laptop being open.
- **Headless box ⇒** the polished "dashboard-in-a-window" (Option B) is mainly
  for setup/monitoring; the box's real job is the **headless crawler**.
- **Two distinct logins:** (1) RouteReady dashboard login = the pairing
  (one-time-ish); (2) portal login (Amazon/Indeed) = the session the agent
  uses — it **expires** and needs occasional re-auth **on the box** (via
  Chrome Remote Desktop). Plan for a "session expired → re-login" alert.
- **Box ↔ web app never talk directly** — they communicate through RouteReady
  (Supabase). That's how the on-demand "Sync to portal" button works.

## v0.6.0 build plan (in recommended order)

1. ✅ **Quick wins** *(done — shipped in v0.6.0 work)*
   - Default new agent tasks → **Sonnet 4.6** (was Opus); per-task overridable.
   - **Prompt caching** in the agent loop (system+tools breakpoint + rolling
     conversation breakpoint via `markCache`).
   - **Hid the native menu bar** (actions moved to the tray); set the Linux
     launcher **icon** (may need a Crostini relaunch to refresh the cache).
2. ✅ **Multiple daily run-times** *(done)* — per task, a list of clock
   times (`06:00, 12:00, 18:00`) in the box's **local** timezone (= the DSP's).
   Fire at each; if the box was asleep at a slot, run it **once** on wake
   (catch-up), then continue. Replaces/augments the current interval scheduler.
3. ✅ **Heartbeat + health monitoring** *(box + Supabase — box side done;
   dashboard widget deferred)* — `desktop_agents` table (migration 0363, RLS
   DSP-scoped via `private.current_dsp_id()`). The box authenticates to Supabase
   with its **pairing session** (persisted as `box-session.enc`, separate from
   the dashboard window session), then **heartbeats every 5 min** (alive +
   app_version + `portal_session_ok` + label=hostname) and upserts a **last-run
   summary** after each crawl (status/error/rows). Stable per-install `agent_id`
   in config. _Still to do (preview-gated):_ the dashboard widget that reads
   `desktop_agents` and alerts when a box goes dark / a pull fails / the portal
   session expired.
4. **On-demand "Sync to portal"** *(web + Supabase + box)* — web button writes
   a request row to Supabase; the box watches (realtime/poll) and runs that
   DSP's pull now. The pairing gives the box the DSP identity to scope this.
5. **"Learn once → replay cheap"** *(desktop app)* — AI figures out a page and
   saves an extraction recipe; deterministic **replay** (the existing
   record-replay engine, `scraper.js`) runs routine pulls **for ~$0**, and the
   AI only re-fires when replay breaks (layout changed). 10–100× AI savings on
   high-frequency pulls.
6. **Auto-update** *(electron-updater + GitHub Releases)* — so boxes maintain
   themselves; install once, never reinstall. (Note: AppImage auto-updates;
   `.deb`/ChromeOS does not — Windows mini-PC is the target anyway.)

## Product decisions to make (not code)

- **AI cost model.** Opus on every pull ≈ **$200–700/mo per DSP**; with
  Haiku + caching + learn-then-replay it's **single-digit $/mo per DSP**.
  Decide: which model, who pays (DSP's Anthropic key vs RouteReady's), and bake
  a per-DSP AI budget into pricing. Rates (per 1M tokens): Opus 4.8 $5/$25,
  Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5.
- **ToS / legal.** Automating Amazon DSP / Indeed access may breach their
  terms — accept this consciously.
- **Box security + onboarding.** The box holds live sessions (encrypted at
  rest); think physical security / remote wipe. For scale, zero-touch
  onboarding (pre-imaged boxes) beats per-customer terminal setup.

## Known follow-ups / tech debt

- **macOS build dropped** (electron-builder can't pack the newer Playwright
  "Chrome for Testing" framework symlinks). `download.html` Mac card marked
  "Coming soon". To restore: pin Playwright + fix `main.js`'s mac Chromium path
  resolver (still expects the old `chrome-mac/Chromium.app` layout).
- **Supabase:** `0362_desktop_pairings` migration is applied manually (operator
  runs SQL by hand); `desktop-pair` deploys via `deploy-migrations.yml`'s
  no-verify-jwt loop on merge to `main`.
- **Pairing UI** was re-added **client-less** (reads the stored token, no second
  `GoTrueClient`) after a duplicate-client outage. Don't reintroduce a second
  Supabase client on dashboard pages.
- **Version label:** package.json is `0.6.0`.

## How to resume

Branch fresh from `main`, start at **v0.6.0 #1 (quick wins)**, work down the
order. The reliability item (#3, heartbeat/health) is the highest-leverage for
the appliance model after the quick wins + scheduling.
