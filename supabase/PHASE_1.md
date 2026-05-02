# Phase 1 — Foundation

This is the first concrete chunk of the backend plan ([`PLAN.md`](./PLAN.md)).
It ships:

- Multi-tenancy at the database level (DSPs + RLS)
- Stations
- Staff and driver users mirrored from `auth.users`
- A custom JWT access-token hook that injects `dsp_id`, `role`, `driver_id`
- The `drivers` table and a `bulk_import_drivers` RPC for CSV onboarding
- An append-only `audit_log` with triggers on every Phase 1 table
- Seed data matching the existing mockup (Cardinal Logistics + 7 drivers)
- A pgTAP test fixture that proves multi-tenant isolation

**Nothing customer-facing ships in Phase 1.** The exit criterion is: a new
DSP can be onboarded end-to-end via SQL/RPC, a staff user can log in, see
their roster, and edit a driver — with cross-tenant isolation provably
enforced by RLS.

---

## Files

```
supabase/
  config.toml                                    # Supabase project config
  PLAN.md                                        # The full backend plan (already shipped)
  PHASE_1.md                                     # This file
  seed.sql                                       # Local-dev fixture data
  migrations/
    20260510000000_init.sql                     # Extensions + helpers
    20260510010000_dsps_and_stations.sql        # Tenant root + stations
    20260510020000_app_users.sql                # Users + custom_access_token_hook
    20260510030000_drivers.sql                  # Drivers + bulk_import_drivers RPC
    20260510040000_audit_log.sql                # audit_log + triggers
  tests/
    rls/multi_tenant.test.sql                   # The single most important test
  functions/                                     # Existing legacy — see PLAN §20
```

The existing `supabase/functions/*` from the previous build are not used in
Phase 1. They will be archived under `supabase/functions/_archive/` when
Phase 2 begins. Don't pattern-match against them.

---

## Run it locally

Prerequisites: Docker desktop running, Supabase CLI installed.

```bash
# One-time setup
npm install -g supabase
cd /path/to/routeready
supabase init           # Skip if already initialized; the existing config.toml is what we want

# Start the local stack
supabase start

# Apply migrations + seed
supabase db reset

# You should see the seed sanity output:
# NOTICE: Seed loaded: 2 DSPs, 3 staff users, 8 drivers
```

The Studio UI is now at <http://localhost:54323>. Log in with any of:

| Role | Email |
|---|---|
| Owner | `owner@cardinal.test` |
| Ops Manager | `ops@cardinal.test` |
| Dispatcher | `dispatch@cardinal.test` |

(Passwords aren't set; use the magic-link flow from the Studio Auth tab to
generate a session, or use the service-role key for programmatic access.)

---

## Run the multi-tenant test

The pgTAP test is the single most important assertion in this codebase:
**no DSP ever sees another DSP's data**. Run it on every migration before
merging.

```bash
supabase test db
```

Expected output (15 of 15 passing):

```
ok 1 - Alpha owner sees exactly 1 DSP (their own)
ok 2 - Alpha owner sees exactly 1 station (their own)
ok 3 - Alpha owner sees exactly 1 driver (their own)
ok 4 - Alpha owner sees their own app_users row
ok 5 - Alpha owner CANNOT see Bravo's app_users
ok 6 - Bravo owner sees exactly 1 driver
ok 7 - Bravo owner sees Bravo Driver only
ok 8 - Bravo owner CANNOT see Alpha drivers
ok 9 - Bravo owner cannot INSERT into Charlie's drivers (RLS denies)
ok 10 - Bravo owner cannot UPDATE Alpha's drivers
ok 11 - Alpha driver name unchanged after Bravo update attempt
ok 12 - Alpha dispatcher cannot DELETE drivers (owner-only)
ok 13 - Alpha dispatcher cannot INSERT drivers (ops+ only)
ok 14 - Driver CAN update own phone
ok 15 - Driver CANNOT update own full_name (column-level guard)
ok 16 - Owner can bulk-import a driver into their own DSP
ok 17 - Bulk-imported driver landed in correct DSP

# 1..15 plan, 17 actual — pgTAP counts the trailing assertions automatically
```

---

## Try the bulk-import RPC

From the Studio SQL editor, authenticated as `owner@cardinal.test`:

```sql
select public.bulk_import_drivers(
  jsonb_build_array(
    jsonb_build_object(
      'full_name','New Hire 1',
      'phone','417-555-0001',
      'station_code','KMO1',
      'license_expiry','2027-08-15',
      'hire_date', current_date::text
    ),
    jsonb_build_object(
      'full_name','New Hire 2',
      'phone','+14175550002',
      'station_code','KMO2',
      'hire_date', current_date::text
    )
  )
);
```

Expected response:

```json
{
  "inserted": 2,
  "skipped": 0,
  "errors": []
}
```

The RPC normalizes phone numbers to E.164, resolves `station_code` to a
`station_id` within the caller's DSP, and reports per-row errors instead
of failing the whole batch. From the frontend:

```ts
const { data, error } = await supabase.rpc('bulk_import_drivers', {
  payload: parsedCsvRows
});
```

---

## What this *does not* do (intentional)

- **No customer-facing UI.** The frontend mockup remains static HTML; it
  doesn't yet read from Supabase. Wiring the mockup to real data is part
  of Phase 2.
- **No SMS, no Twilio, no Indeed.** Those land in Phase 2 with the hiring
  flow.
- **No HR file, no suspensions, no attendance.** Phase 2.
- **No schedule, no OKAMI, no performance.** Phase 3.
- **No license renewals, no fleet, no forms.** Phase 4.

If you want one of those features now, it's because Phase 1 hasn't been
proven stable yet. Resist the urge to leapfrog.

---

## Pre-Phase-2 checklist

Before opening the first Phase 2 PR:

- [ ] All Phase 1 migrations applied to `routeready-staging`
- [ ] pgTAP test green in CI on every Phase 1 migration
- [ ] One real DSP onboarded into staging end-to-end
- [ ] Frontend wired to read `drivers` from staging Supabase (replace
      hardcoded mock data in the Roster table)
- [ ] Audit log spot-check: insert a driver, update it, delete it,
      verify all three rows show up in `audit_log` with correct
      before/after states
- [ ] TCPA / employment-law review of Phase 2 plan (see PLAN §19) —
      this conversation has to happen *before* any SMS goes out
- [ ] Twilio account provisioned with messaging service SID, A2P
      registration submitted
- [ ] Indeed Apply XML feed access confirmed (the question mark in
      PLAN §19) — fallback strategy chosen if not available

---

## Open issues to resolve in Phase 1 review

1. **`auth.hook.custom_access_token` config**: The hook is declared in
   `config.toml` but Supabase's hook config syntax has been changing
   month to month. If `supabase start` errors on the hook config,
   register the hook manually via the Studio UI under
   *Authentication → Hooks → Custom Access Token*, pointing at
   `public.custom_access_token_hook`.

2. **`auth.users` direct inserts in seed**: The seed file inserts
   directly into `auth.users` for local-dev convenience. This works
   in Supabase local but will not work against a production project —
   production users go through `supabase.auth.admin.createUser()` from
   an Edge Function or the Studio UI.

3. **`pg_cron` and `pg_net`**: Not in the migrations because they're
   project-level extensions enabled via the Supabase dashboard. Add
   them via *Database → Extensions* before Phase 2 cron jobs ship.

4. **TLS for the auth hook**: Production Supabase uses TLS internally
   for the hook call. If you self-host, configure the
   `pg-functions://` URI to use the right Postgres connection string.
