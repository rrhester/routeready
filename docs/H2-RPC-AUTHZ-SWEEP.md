# H-2 · SECURITY DEFINER RPC authorization sweep

**Finding (from `CUSTOMER_READINESS_AUDIT.md`, High H-2):** the pre-0504 revoke
made new `public` functions non-anon-executable, but hundreds of existing
SECURITY DEFINER RPCs remained callable by any `authenticated` user and gate
only on the caller's **tenant** (`private.current_dsp_id()`), not their **role**.
Because all dashboard logins are the same Postgres `authenticated` role
regardless of app-role, a low-privilege **driver-role** app_user could call a
dispatcher-only function.

## Method (reproducible)

The schema was loaded in full (all 574 migrations applied to a local
PostgreSQL 16) and `pg_proc` was queried directly — so this reflects each
function's **real final definition**, not a grep of migration text.

```sql
-- SECURITY DEFINER functions in public that reference the tenant helper but
-- no role/admin/resource gate and no driver-token check, that perform a write.
with f as (
  select p.oid, p.proname, pg_get_functiondef(p.oid) as src, p.proacl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
)
select proname from f
where src ~* 'current_dsp_id'
  and src !~* 'is_staff|is_owner|has_role|require_owner|require_staff|is_platform_admin'
  and src !~* 'notebook_require|_require\(|can_edit|has_access|_acl|assert_|is_member|membership'
  and src !~* 'driver_validate_token'
  and src ~* 'insert\s+into\s+public\.|update\s+public\.|delete\s+from\s+public\.'
  and (proacl is null or array_to_string(proacl, ',') ~ 'authenticated=[A-Za-z]*X|=X/');
```

## Numbers

| Set | Count |
|---|---|
| SECURITY DEFINER functions in `public` | 688 |
| Already role-gated (`is_staff`/`is_owner`/`is_platform_admin`/…) | 407 |
| Reference `current_dsp_id` (tenant) | 512 |
| Tenant-referencing but **no** role gate | 108 |
| …of those: privileged **writes**, callable by `authenticated`, no resource/token gate | **31** |
| **Fixed in migration 0541** (role gate added) | **23** |
| Intentionally any-member / needs product review (deferred) | 8 |

The role hierarchy is `driver < dispatcher < ops < owner < platform_admin`, and
`is_staff(dsp,'dispatcher')` is true for everything **except** `driver`. So the
standard guard added to each fixed function —

```sql
if not private.is_staff(private.current_dsp_id(), 'dispatcher') then
  raise exception 'forbidden' using errcode = '42501';
end if;
```

— excludes exactly the driver role and no legitimate staff.

## Fixed in 0541 (23)

Disciplinary / approval: `coaching_resolve`, `coaching_archive`,
`dispatch_time_off_decide`. Fleet: `vehicle_set_operational_status`,
`vehicle_quick_set_ro_code`, `vehicle_dvic_review_save`, `repair_order_save`,
`repair_order_complete`, `repair_order_open_from_issue`, `vendor_save`.
Compliance: `fmcsa_record_save`, `fmcsa_safer_record_observation`.
Hiring/interview config: `interview_schedule_save`, `interview_schedule_delete`,
`interview_schedule_activate`, `interview_session_add`, `interview_session_update`,
`interview_session_remove`, `interview_availability_set`, `interview_override_set`,
`interview_override_remove`, `interview_reminders_set`, `interview_reminders_config_set`.

21 were re-issued verbatim from the live definition with the guard as the first
statement; the 2 `LANGUAGE sql` functions (`interview_override_remove`,
`interview_session_remove`) were converted to plpgsql to carry it.
`create or replace` preserves each function's existing grants.

**Validated against the fully-migrated schema:** all 23 apply; a driver-role
caller is refused (42501); a dispatcher passes the guard.
`supabase/tests/rpc_role_gate_test.sql` locks a representative sample into
migration-check CI.

## Deferred — intentionally any-member or needs product review (8)

| Function | Why not gated at `dispatcher` |
|---|---|
| `device_push_register`, `staff_push_register` | Self-service: register the **caller's own** push device. Any authenticated member should be able to. |
| `call_log_event`, `touch_dsp_activity` | Telemetry / activity heartbeat — no privileged mutation; benign for any member. |
| `dispatch_poll_vote` | Casting a vote in a dispatch poll is intended for any tenant member. |
| `vehicle_dvic_request_ai` | Plausibly a legitimate **driver** flow (request AI review of one's own DVIC). Gating at `dispatcher` could break a driver feature — confirm the caller model first. |
| `fleet_bridge_ensure_folders` | Idempotent storage-folder housekeeping, low severity — review the caller before gating. |
| `notebook_share_set` | The notebook family is protected by resource-level `notebook_require` ACLs elsewhere; sharing is likely notebook-owner-scoped, not a global role. Gating at `dispatcher` could block a legitimate non-dispatcher owner. Confirm the notebook permission model before gating. |

None of the deferred perform a high-severity privileged mutation; they are
either self-service, telemetry, or resource-ACL-scoped. Revisit `notebook_share_set`
and `vehicle_dvic_request_ai` once their intended caller is confirmed.

## Caveat

This sweep targets the highest-signal class: privileged **writes** with a tenant
gate and no role gate. A residual class exists — SECURITY DEFINER **reads** that
return sensitive data with only a tenant gate — which RLS may already cover but
which a future pass should review with the same query (drop the write predicate).
