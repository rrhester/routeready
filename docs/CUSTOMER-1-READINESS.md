# Customer #1 Readiness Runbook

**What this is:** the checklist to safely onboard RouteReady's first *second* tenant —
a real paying DSP whose HR/PII data will live alongside yours. It captures the
hardening work that landed, the ops steps only you can do, and the gaps that are
deliberately deferred (with the reasoning, so they read as decisions, not misses).

The framing that matters: **customer #1 = your first second tenant.** Almost
everything below is about one question — *can two DSPs coexist without leaking into
each other, can you bill them, and will you know when it breaks.*

---

## 1. What shipped (the readiness work)

| Area | Change | PR |
|---|---|---|
| Security perimeter | Auth-gated `send-email`/`send-sms` (+ fixed the `%stop%` opt-out over-match); metered + gated `ai-proxy` (membership, per-DSP daily cap, model/path allow-list); staff-gated `cal-availability` (was fully unauthenticated) | #3762 |
| Tenant isolation (RLS) | Finished intra-tenant role gates on 32 HR/hiring/compliance/fleet/messaging tables — migration `0468` | #3762 |
| Isolation **proof** | `cross_tenant_isolation_test.sql` — stands up two tenants, proves neither can read/write the other; wired into `migration-check` CI (runs on every migration PR) | #3769 |
| Session safety | Idle-timeout logout on the dashboard (`RR_CONFIG.IDLE_TIMEOUT_MINUTES`, default 30) | #3772 |
| Observability | Public `health` edge function (up/down + latency, no tenant data) for an uptime monitor | #3772 |
| Data portability | Owner-only `export_my_dsp_data()` RPC — migration `0472` — with a CI test; one-click **Settings → Workspace → Export your data** button | #3773, #3774 |

**New migrations to apply:** `0468`, `0469`, `0472`.
**New/changed edge functions:** `send-email`, `send-sms`, `ai-proxy`, `cal-availability`, `health`.

---

## 2. Go-live checklist

Do these in order. Steps 3–5 are the ones only you can do and the real gate.

### 2.1 Apply the migrations

The `Deploy Supabase` workflow (`.github/workflows/deploy-migrations.yml`) auto-applies
new migrations via `scripts/apply-migrations.sh` **only if the `SUPABASE_DB_URL`
secret is set**. If you still apply by hand in the SQL Editor, run these in order:

1. **`0468` — role gates.** ⚠ **Run the preflight first** so you don't lock out a
   real operator who's stuck at `role='driver'`:
   ```sql
   select email, role, active from public.app_users where active order by role, email;
   -- promote anyone who should edit HR/schedule/compliance data:
   update public.app_users set role = 'dispatcher' where email = 'person@example.com';
   ```
   Then run `supabase/migrations/0468_role_gate_remaining_tables.sql`.
2. **`0469`** — `supabase/migrations/0469_ai_proxy_metering.sql`.
3. **`0472`** — `supabase/migrations/0472_tenant_data_export.sql`.

All three are idempotent (safe to re-run).

### 2.2 Deploy the edge functions

The `Deploy Supabase` workflow redeploys edge functions on every push to `main`
under `supabase/**`, so merging the PRs above **already redeployed** `health`,
`cal-availability`, `ai-proxy`, `send-email`, `send-sms`. Confirm the run went green
(Actions → Deploy Supabase). If you deploy manually: `cal-availability` and `health`
belong in the `--no-verify-jwt` group (they auth in-code).

### 2.3 ⚠ Turn on PITR and TEST A RESTORE  *(hard blocker — only you can do this)*

You're about to become the custodian of another business's I-9s and driver PII.
In the Supabase dashboard → Database → Backups, enable **Point-in-Time Recovery**,
then **actually perform a restore once** to a scratch project. A backup you've never
restored is a hope, not a backup. Do not put a customer's data in until this is done.

### 2.4 Point an uptime monitor at `/health`

Free tier of UptimeRobot / Better Stack / Cronitor → monitor
`https://<project>.functions.supabase.co/health` → alert on any non-200. Now an
outage pages you, not your customer.

### 2.5 Create the second tenant and eyeball isolation

Create the DSP + owner via the platform-admin RPC:
```sql
select public.admin_create_dsp(
  'Their DSP Name', null, 'owner@theirdsp.com', 'Owner Name', null, null, 'starter', null
);
```
The owner binds on their first magic-link login (`pending_owner` metadata → auto-linked).
Then log in **as that owner** and confirm you see only their data across a few modules.
The CI test proves the mechanism; this is your gut-check on the live project.

### 2.6 Bill them manually

A Stripe invoice or payment link. You do **not** need self-serve/metered billing for
one customer. (See `docs/` pricing model / the pricing artifact for the recommended
per-van tiers.)

---

## 3. Fulfilling a data-export request

Owner-role user → **Settings → Workspace → Export your data** → downloads
`routeready-export-<dsp>-<date>.json`. Or call it directly:
```sql
select public.export_my_dsp_data();   -- must be run in an owner's session/JWT context
```
Returns dsp profile, team, drivers, driver-document **metadata**, applicants,
coachings, shifts, time-off.

For the document **files** themselves, use **Settings → Workspace → Export files
(links)** (owner only). It downloads a JSON manifest of fresh, 1-hour signed
download links to every driver-document file, via the `export-tenant-files` edge
function. (A single ZIP bundle is a reasonable v2.)

---

## 4. Deferred — deliberate, not forgotten

| Gap | Why it's deferred | When to do it |
|---|---|---|
| **MFA (TOTP)** | Rewrites the login flow; the failure mode is locking the owner out. Needs a live-tested enroll→challenge→verify pass, not a blind ship. | Before onboarding *several* HR-data customers. Build behind a flag with a written test plan. |
| **Staging environment** | The single prod project auto-deploys on merge. `migration-check` validates SQL from scratch, but there's no non-prod smoke of a full deploy. Mostly infra/ops. | Before you're deploying frequently against live customers. |
| **Anon storage path-scoping** | The driver PWA authenticates with a custom token → the identity-less `anon` role in Postgres, which RLS can't scope per-tenant. Real fix = a token-validated signing RPC + driver-app loader rewrite (needs driver-app testing). | When hardening the driver-file path. |
| **SRI on CDN imports** | Browsers don't support `integrity` on dynamic `import()`; deps are already exact-version-pinned. Real fix = vendoring the libs (like `supabase-js` already is). | Supply-chain hardening pass. |
| **Server-side entitlement enforcement** | Entitlements are UI-gated today. Fine at one tenant. | When tiers diverge across many tenants. |

---

## 5. Watch after deploy (high blast radius)

- **`send-email` / `send-sms` auth gate (#3762).** These now require the service-role
  bearer. Both callers (the `0007` insert trigger and the cron drainer) pass it, and
  `dvic-ai-review` already runs the identical gate in prod — but **watch the first
  send after deploy.** If sends 401, the `FUNCTION_INTERNAL_TOKEN` override
  (`_shared/supabase.ts`) is the escape hatch: set it to the value the drain cron
  passes.
- **`0468` role gates.** If a legitimate operator can suddenly no longer edit the
  schedule/roster, they're stuck at `role='driver'` — promote them (§2.1 preflight).
- **`ai-proxy` cap.** Over-cap tenants get a 429; the default is 5000 requests/DSP/day.
  Override per tenant via `dsps.metadata -> 'ai' ->> 'daily_request_cap'`. Metering
  failures fail open (AI keeps working), so a counter error won't break the box.

---

*Prepared as the closing artifact of the customer-#1 hardening pass. The product side
is ready for one paying tenant; §2.3 (PITR + restore) is the last thing standing
between "ready" and "go."*
