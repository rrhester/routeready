# Contributing to RouteReady

## Setup

```bash
npm install
npm run smoke   # run this before every push (the pre-push hook also runs it)
```

See [docs/LOCAL-DEV.md](docs/LOCAL-DEV.md) to run the app locally.

## The rules that aren't obvious

- **No build step for the web app.** `dashboard/` and `app/` are vanilla JS
  served as-is. Don't introduce a bundler for them. Optional Node/Deno
  tooling (engine bundles, tests, linters) is fine.
- **Migrations are idempotent and applied by hand.** New file under
  `supabase/migrations/` with the next unused 4-digit ordinal; paste the SQL
  into the Supabase SQL Editor after merge. Anon-facing RPCs need an explicit
  `grant execute … to anon;` (the anon default was revoked in 0504). Details
  in [docs/LOCAL-DEV.md](docs/LOCAL-DEV.md#database-changes).
- **Never hand-edit `?v=` cache tokens** — `scripts/bust-cache.mjs` rewrites
  them at deploy. When you change a driver-shell asset (`app/app.js`,
  `sw.js`, `styles.css`, …), **bump `SHELL_CACHE`** in `app/sw.js` or
  `cache-bump-check` fails.
- **Security headers live in two files** (`_headers`, `netlify.toml`) and
  must stay byte-identical — `scripts/check-headers-parity.mjs` (part of
  `npm run smoke`) enforces it.
- **New cross-file globals** must be added to `SHARED_APP_GLOBALS` in
  `eslint.config.mjs`, or the `no-undef` gate fails.
- **workbook.js contains one intentional `\0` escape** (a QUERY group-key
  separator). Keep it as `\0`; don't reintroduce a raw NUL byte (it makes
  `grep` treat the file as binary).
- **Ship workflow changes in a separate PR** from code changes — Actions
  won't run CI on a PR that edits `.github/workflows/**`.

## Pull requests

1. Branch, commit, `npm run smoke` (+ `npm test` if you touched tested code).
2. Open a PR against `main`. CI is path-filtered; `ci-ok` aggregates the
   result — wait for it to be green.
3. **Squash-merge.** Never merge red.

There's a PR template at `.github/pull_request_template.md`.

## Where things are

See the [README](README.md) table. Tests: `npm test` (script suite),
`engine/` and `flex-capacity/` (`npm test`), `solver-service/`
(`pytest tests/`), `tests/` (Playwright).
