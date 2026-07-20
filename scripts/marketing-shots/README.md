# Marketing screenshots — capture harness

The product screenshots on the landing page (`/marketing/*.webp`) are
**genuine captures of the real dashboard and driver app**, booted locally
against a fully stubbed Supabase API with fictional demo data ("Blue Ridge
Logistics", invented driver names, 555-01xx phone numbers). No real
operator, driver, or station data is ever involved.

To regenerate after a product UI change:

```sh
# 1. Serve the repo root
python3 -m http.server 8123 --bind 127.0.0.1 &

# 2. Install playwright next to these scripts (not in the repo package.json)
#    and make sure a chromium is available (CI/sandbox: /opt/pw-browsers).
npm i playwright

# 3. Capture (writes PNGs to ./out)
node harness.mjs schedule-week
node harness.mjs today-plan
node harness.mjs targets
node harness.mjs fleet
node harness.mjs drivers
node harness.mjs messages
node harness.mjs driver-app-today
node harness.mjs driver-app-schedule

# 4. Re-encode to responsive WebP + og-image (writes ./webp)
node optimize.mjs

# 5. Copy into the repo
cp webp/*.webp webp/og-schedule.jpg ../../marketing/
```

Notes:
- The browser clock is frozen (10:35 AM ET dashboard / 3:45 PM ET driver
  app) so captures are reproducible at any time of day.
- `demo-data.mjs` generates the roster/schedule/fleet dataset; keep names
  fictional and phones in the 555-01xx reserved range.
- The stub layer answers `schedule_grid`, `okami_grid`, `today_roster`,
  `today_attendance`, `today_plan`, `vehicles_roster`,
  `dispatch_chat_threads`/`_thread`, `driver_my_schedule`,
  `driver_checkin_status`, and friends — if a view gains a new required
  RPC, add a handler or the view renders empty.
- Marketing `<img>` tags reference the exact `-1200w/-2400w` (and phone
  `-450w/-900w`) filenames — keep the width suffixes in sync if you change
  the plan in `optimize.mjs`.
