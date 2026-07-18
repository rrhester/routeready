# Deploy runbook

RouteReady ships from GitHub Actions on merge to `main` — no local machine
is in the deploy path. This maps each surface to the workflow that ships it
and the one manual step that remains (database migrations).

## What ships automatically on merge to `main`

| Surface | Workflow | Target | Notes |
| --- | --- | --- | --- |
| Dashboard + driver app + public pages | (Netlify + Cloudflare Pages git integration) | CDN | Static. `?v=` cache tokens rewritten by `scripts/bust-cache.mjs` at build. |
| Edge functions | `deploy-migrations.yml` | Supabase | Deploys every function in the drift-checked lists. **DB migration step no-ops** (`SUPABASE_DB_URL` unset) — migrations are manual. |
| Solver service | `deploy-solver-service.yml` | Fly.io (`rr-solve-ready`) | pytest gates the deploy. |
| Document sealing worker | `deploy-document-sealing.yml` | Cloudflare Workers | `tsc --noEmit` gates the deploy. |
| Desktop app | `desktop-build.yml` | GitHub Releases | electron-updater; see the signing caveat in the workflow. |

## What is manual

- **Database migrations.** Applied by hand in the Supabase SQL Editor. See
  [LOCAL-DEV.md](LOCAL-DEV.md#database-changes). The auto-deploy's DB step is
  intentionally a no-op.
- **Edge function runtime secrets.** Set once per project with
  `supabase secrets set` — see [`../supabase/SECRETS.md`](../supabase/SECRETS.md).
- **apps-script.** Pasted into the container-bound Google project.

## CI gates (must be green before merge)

Path-filtered, so a given PR runs only the relevant ones. `ci-ok` is the
always-run aggregator that reports the combined result (require it in branch
protection).

| Workflow | Guards |
| --- | --- |
| `smoke-check` | Parse-checks every shipped JS file; header parity; eslint. |
| `edge-functions-check` | `deno check` on all functions + `deno test` shared helpers. |
| `migration-check` | Replays every migration from scratch; RLS/isolation SQL tests; ordinal-uniqueness gate; also runs weekly. |
| `engine-tests` / `flex-capacity-tests` | TS typecheck + tests + generated-bundle freshness. |
| `workbook-tests` | The `npm test` script suite. |
| `driver-app-tests` / `booking-e2e` / `visual-regression` | Playwright (stubbed Supabase). |
| `cache-bump-check` | Fails if a precached driver-shell asset changed without a `SHELL_CACHE` bump. |
| `design-lint` | Design-system ratchet (raw hex / !important / font-size counts may only decrease). |
| `deploy-*` (on PR) | The deploy workflows also run their test/typecheck job on PRs; the deploy job itself is `main`-only. |

### PRs that touch `.github/workflows/**`

Actions doesn't run workflows from a PR that modifies workflow files (from
this tooling's fork context), so ship workflow changes in a **separate tiny
PR** to keep code PRs on full CI.

## Convention

Squash-merge. Never merge red. The deploy-migrations function lists are
drift-checked — a new `supabase/functions/*` dir that isn't in a deploy list
(or the manual-only allowlist) fails the run, so functions can't silently
go un-deployed.
