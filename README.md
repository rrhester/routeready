# RouteReady

The operating system Amazon DSPs run on — hiring, scheduling, performance,
fleet, compliance, signed documents, and AI vehicle inspection, in one app.

This is a monorepo. There is **no build step for the web app** — the
dashboard and driver PWA are vanilla JS served statically. Optional tooling
(engine bundles, tests, linters) is Node/Deno.

## What's where

| Path | What it is | Deploys via |
| --- | --- | --- |
| `dashboard/` | The operator dashboard SPA. `live.js` (~90k lines) is the main app; `workbook.js`/`reports.js`/`meet.js`/`parts/`/`repair/` are lazy feature modules; `views/*.frag` are cached view partials. | Netlify + Cloudflare Pages (static) |
| `app/` | The driver PWA (`app.js`, service worker `sw.js`, manifest). Wrapped natively via Capacitor. | Static + Capacitor for the native shells |
| `*.html` (root) | Marketing + public pages (landing, download, terms, privacy, verify). | Static |
| `supabase/migrations/` | Postgres schema — applied **by hand** in the Supabase SQL Editor (see below). | Manual (SQL Editor) |
| `supabase/functions/` | ~57 Deno edge functions (webhooks, OAuth, AI proxies, send-sms/email, push). | `deploy-migrations.yml` on merge to `main` |
| `engine/` | Deterministic scheduling engine (TS). Builds `dashboard/scheduling-engine.js`. | `engine-tests.yml` verifies the bundle is fresh |
| `flex-capacity/` | Flex-capacity engine (TS). Imported directly by its edge function. | via `deploy-migrations.yml` (paths include `flex-capacity/src`) |
| `solver-service/` | Python CP-SAT solver (the Smart Fill backend). | `deploy-solver-service.yml` → Fly.io |
| `services/document-sealing/` | Cloudflare Worker that seals signed PDFs (ECDSA + RFC 3161). | `deploy-document-sealing.yml` → Cloudflare |
| `desktop/` | Electron desktop wrapper (auto-update via electron-updater). | `desktop-build.yml` |
| `apps-script/` | Google Apps Script automation (pasted into a container-bound project). | Manual |
| `scripts/` | Node dev tooling: `test-*.mjs` (run by `npm test`), `smoke-check-live.mjs`, `check-*`, `gen-*`, `bust-cache.mjs`. | — |
| `tests/` | Playwright suites (`booking-e2e`, `driver-app`, `visual`) + fixtures. | per-suite workflows |
| `docs/` | Architecture notes, audits, runbooks. Start with `docs/LOCAL-DEV.md`. | — |

## Quick start

```bash
npm install          # dev tooling (acorn, eslint, capacitor cli, …)
npm run smoke        # parse-check shipped JS + header parity (run before every push)
npm run lint         # eslint no-undef gate over shipped JS
npm test             # the node:test-ish script suite (engine, workbook, calendar, …)
```

To run the dashboard locally against a stubbed backend, see
[`docs/LOCAL-DEV.md`](docs/LOCAL-DEV.md).

## Key conventions

- **Migrations are applied by hand.** Add a file under
  `supabase/migrations/` (idempotent — `create or replace`, `if not exists`,
  guarded `do $$…$$`), then paste its SQL into the Supabase SQL Editor. New
  ordinals must be unique (`scripts/check-migration-ordinals.mjs` enforces
  it). Anon-facing RPCs must add an explicit `grant execute … to anon;`
  since migration 0504 revoked the anon default.
- **Cache busting is automatic.** `?v=` tokens on JS/CSS are rewritten to
  the deploy commit by `scripts/bust-cache.mjs`; never hand-bump them. The
  driver PWA shell is versioned separately by `SHELL_CACHE` in `app/sw.js`
  (`cache-bump-check.yml` enforces a bump when a precached asset changes).
- **Security headers are maintained twice** (`_headers` for Cloudflare,
  `netlify.toml` for Netlify) and kept identical by
  `scripts/check-headers-parity.mjs` (part of `npm run smoke`).
- **Squash-merge** PRs. CI must be green (`ci-ok` aggregates the checks).

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full workflow and
[`docs/DEPLOY.md`](docs/DEPLOY.md) for what each workflow ships.
