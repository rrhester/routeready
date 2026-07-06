---
name: verify
description: Run and drive the RouteReady dashboard locally (no real Supabase login) to verify dashboard/schedule UI changes end-to-end with Playwright.
---

# Verify the dashboard locally

The dashboard is a static site (no build step) that hard-requires a
Supabase session at boot (`dashboard/live.js` top-level auth gate).
You can boot it fully **without credentials** by seeding a fake session
and stubbing the Supabase API at the network layer.

## Recipe

1. **Serve the repo root** (frag paths are relative to it):
   `python3 -m http.server 8123 --bind 127.0.0.1` → open
   `http://127.0.0.1:8123/dashboard/index.html`.

2. **supabase-js can't come from the CDN in sandboxes** (jsdelivr is
   often blocked). Bundle it locally and serve it via route interception:
   `npm i playwright esbuild @supabase/supabase-js@2.45.4` (match the
   version in live.js line ~10), then
   `npx esbuild --bundle node_modules/@supabase/supabase-js/dist/module/index.js --format=esm --outfile=supabase-esm.js`.

3. **Playwright** (use `executablePath: "/opt/pw-browsers/chromium"` in
   remote sandboxes; `--no-sandbox`):
   - `addInitScript`: `localStorage.setItem("sb-doiwrhkirgblcvuskhno-auth-token", JSON.stringify(session))`
     where `session` = `{ access_token: <fake 3-part JWT with far-future exp>,
     token_type: "bearer", expires_at: <now + 1y, seconds>, refresh_token: "x",
     user: { id: <uuid>, aud: "authenticated", role: "authenticated", email } }`.
     Also set `window.__rrSchedOrientFlash = true` (kills a flaky 1.5s highlight).
   - Routes — **register the catch-all abort FIRST** (Playwright matches
     newest-first): abort everything off-host; then fulfill
     `cdn.jsdelivr.net/*@supabase/supabase-js*` with the local bundle
     (`text/javascript`); then stub `https://doiwrhkirgblcvuskhno.supabase.co/*`:
     - `/rest/v1/app_users` → `{ id: <uuid>, dsp_id: <uuid>, email, full_name, role: "owner", allowed_pages: null }`
     - `/rest/v1/dsps` (GET) → `{ id: <same dsp_id>, name, short_code, timezone, metadata: {} }`
       — **must** have a real `id` or boot force-redirects to login.
     - any `/rest/v1/rpc/*` and other `/rest/v1/*` → `[]` (or the object
       when the `Accept` header contains `pgrst.object`, i.e. `.single()`).
       Special-case RPCs your feature reads (e.g. `checklist_form_list`).
     - `/auth/v1/token*` → the session JSON; other `/auth/v1/*` → `{}`.
   - Realtime websockets fail (proxy) — harmless, supabase-js retries quietly.

4. After `goto`, wait ~4s, then
   `document.getElementById("rr-boot-overlay")?.remove()`.

## What's worth driving

- Right utility rail: `#rr-util-rail-mount .sched-util-btn` (Notes /
  My Tasks / Checklists / Contacts / Ops Health / Forms / Recognition).
  Panels are `.sched-notes-panel` siblings in the mount; one open at a
  time (`.is-open`); toggles are `[data-rr-<name>-toggle]`.
- Notes/Tasks/Contacts persist in localStorage keyed
  `rr-sched-<kind>:<dsp_id>` — survives reload within one browser context.

## Gotchas

- `npm run smoke` is the pre-push parse gate for live.js — run it after
  any live.js edit, but it is NOT verification.
- The visual-regression suite (`tests/visual/`) hides the rail + rail
  panels by id; a new rail panel aside must be added to its hide list
  AND to the `_rrHoistUtilRail` id list in live.js (~line 118), or it
  renders as unstyled flow content at the bottom of the schedule.
- Any deploy-worthy change should bump `SW_DEPLOY_NONCE` in
  dashboard/sw.js (see the log there).
