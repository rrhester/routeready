# Local development

RouteReady's web surfaces are static — no build step. You can run and edit
the dashboard, driver app, and public pages with nothing but a static file
server. The backend (Supabase Postgres + edge functions) is remote; for UI
work you stub it, and for backend work you apply migrations by hand.

## Prerequisites

```bash
npm install    # dev tooling: acorn (smoke-check), eslint, playwright, capacitor cli
```

Node 22+ recommended (matches CI). Deno 2 is needed only to typecheck edge
functions locally (`deno check supabase/functions/*/index.ts`).

## Run the dashboard against a stubbed backend

The dashboard hard-requires a Supabase session at boot (`live.js` top-level
auth gate), so "just open the file" redirects to login. Two options:

**Option A — the `verify` skill (recommended).** `.claude/skills/verify/`
has a ready Playwright recipe that seeds a fake session, bundles supabase-js
locally, and stubs every `/rest/v1/*` route so the dashboard boots with no
credentials. It's the fastest way to click through a change.

**Option B — by hand.** Mirror the recipe:

1. Serve the repo **root** (view fragments resolve relative to it):
   ```bash
   python3 -m http.server 8123 --bind 127.0.0.1
   # → http://127.0.0.1:8123/dashboard/index.html
   ```
2. In DevTools, seed a fake session before load:
   ```js
   localStorage.setItem("sb-doiwrhkirgblcvuskhno-auth-token", JSON.stringify({
     access_token: "<a 3-part JWT with a far-future exp>",
     token_type: "bearer", expires_at: <now + 1y in seconds>,
     refresh_token: "x",
     user: { id: "<uuid>", aud: "authenticated", role: "authenticated", email: "you@example.com" },
   }));
   ```
3. Stub the network (or point at a real project). The Supabase host is
   `https://doiwrhkirgblcvuskhno.supabase.co`; `/rest/v1/app_users` and
   `/rest/v1/dsps` must return a row with a real `id`/`dsp_id` or boot
   force-redirects to login. See the `verify` skill for the exact shapes.

The driver app (`app/index.html`) and public pages (`booking.html`,
`rsvp.html`, `verify.html`, root `index.html`) are simpler — they boot
without a dashboard session; serve the root and open them directly.

## Tests, lint, smoke

```bash
npm run smoke   # parse-check every shipped JS file + header parity — pre-push gate
npm run lint    # eslint no-undef + no-op detectors over shipped JS
npm test        # the scripts/test-*.mjs suite (engine, workbook, calendar, meet, parts, …)
```

Package-level suites: `cd engine && npm test`, `cd flex-capacity && npm test`,
`cd solver-service && pytest tests/`. Playwright:
`npx playwright test --config tests/<suite>/playwright.config.mjs`
(use `executablePath: /opt/pw-browsers/chromium` in the remote sandbox).

## Database changes

Migrations are **applied by hand** in the Supabase SQL Editor — there is no
`supabase db push` in the operator's loop. Workflow:

1. Add `supabase/migrations/05NN_description.sql` with the **next unused**
   4-digit ordinal (`node scripts/check-migration-ordinals.mjs` enforces
   uniqueness). Write it **idempotent**: `create or replace`, `if not
   exists`, `drop … if exists` before `create trigger`, guarded
   `do $$ begin … exception when duplicate_object then null; end $$` for
   enums/publications.
2. Anon-facing RPCs (driver app, public pages) must include an explicit
   `grant execute on function public.X to anon;` — migration 0504 revoked
   the Supabase anon default, so a new function is staff-only unless granted.
3. `migration-check.yml` replays every migration from scratch on the PR.
4. After merge, paste the SQL into the Supabase SQL Editor and Run. The
   dashboard shows a schema-version banner (`rr_schema_version()`) until the
   expected ordinal is applied.

## Edge functions

Typecheck locally with Deno 2:
`deno check --config supabase/functions/deno.json supabase/functions/*/index.ts`.
They auto-deploy on merge to `main` (see [DEPLOY.md](DEPLOY.md)). Runtime
secrets are set once on the Supabase project — see
[`../supabase/SECRETS.md`](../supabase/SECRETS.md) and the generated
[`../supabase/SECRETS-INVENTORY.md`](../supabase/SECRETS-INVENTORY.md).
