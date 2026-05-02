# Phase 2 — Operations Core

Builds the operational heart of the platform on top of Phase 1's tenancy
foundation: **attendance**, **HR file**, **coaching**, and the
**suspension cascade** that ties them together. No external integrations
yet — Twilio, Indeed, and Cal.com all land in Phase 4.

---

## Why Operations Core before Hiring

The original `PLAN.md` had hiring as Phase 2. Building Operations Core
first is a strategic override:

| Reason | Impact |
|---|---|
| No external integrations required | Doesn't block on Twilio A2P approval, Indeed feed access, or Cal.com setup |
| HR file is the legally-significant core | Get the immutability pattern right *before* high-volume coaching SMS uses it |
| TCPA-deferred | Compliance review happens in calendar time, not engineer time. Don't ship SMS until that's done |
| Platform usable end-to-end | A DSP that bulk-imports drivers can run check-in, coach, and document the file from day one |

Phase 4 picks up Hiring with the SMS infrastructure ready and the legal
review complete.

---

## Files added

```
supabase/
  migrations/
    20260510050000_attendance.sql           # attendance_policies + attendance_events + RLS
    20260510060000_hr_file.sql              # hr_events + coaching_events + sync trigger
    20260510070000_phase2_rpcs.sql          # record_attendance, process_suspension, ...
    20260510080000_phase2_audit.sql         # audit triggers on the new tables
  tests/rls/
    hr_immutability.test.sql                # 20 assertions on append-only HR file
    attendance.test.sql                     # 12 assertions on attendance flow + driver self-access
  seed.sql                                  # extended with attendance events + 1 written warning
  PHASE_2.md                                # this file
```

---

## What's enforced at the database level

### Attendance events
- Per-DSP `attendance_policies` singleton row with full default policy
  (mode, per-event severity, callout window, late grace, decay days,
  thresholds, exempt categories).
- One event per (driver, date, event_type) — re-recording the same
  callout doesn't duplicate.
- Column-level guard via trigger: only `exempt`, `exempt_category`,
  and `notes` can be updated after insert. Everything else is fixed.
- `record_attendance(p_driver_id, p_event_type, ...)` RPC:
  - Idempotent — re-records replace prior same-day event
  - `'present'` clears any prior same-day disruption (mirrors mockup
    behavior)
  - Validates DSP scope manually (security definer) so the unique
    index works without conflicts
  - Returns `{ event_id, was_replaced, message }`
- `mark_attendance_exempt(p_event_id, p_exempt, ...)` RPC for ops+
  to retroactively exempt an event.

### HR file (`hr_events`)
- **Strictly append-only.** No UPDATE policy. No DELETE policy.
  RLS denies both — even ops staff cannot modify rows.
- **Voiding is a new row.** `event_type = 'void'` with
  `superseded_by` referencing the original. Original is preserved.
- **Driver-readable.** Drivers can SELECT their own HR file (RLS allows
  via `private.current_driver_id()`).
- **Active suspensions view** (`public.active_suspensions`) computes
  current state by filtering out voided + expired + reinstated rows.
- **Driver-status sync trigger** auto-flips `drivers.status` between
  `active` ↔ `suspended` ↔ `terminated` based on HR events. The
  scheduling subsystem (Phase 3) reads `drivers.status` and the rest of
  the platform Just Works.

### Coaching events (`coaching_events`)
- Mutable log — typo correction allowed for ops+. Owner-only delete.
- Categories: attendance, safety, quality, behavior, license, other
- Channels: sms, in_person, pull_route, suspend
- Optional FK to a related HR event so coaching tied to a suspension or
  written warning reads as one record in the dashboard drawer.

### High-level RPCs

| RPC | Auth | Effect |
|---|---|---|
| `record_attendance(driver, type, date, notes, replace)` | dispatcher+ | Insert event; replace same-day if needed |
| `mark_attendance_exempt(event, exempt, category, notes)` | ops+ | Toggle exempt flag |
| `process_suspension(driver, dates, category, detail, evidence, files)` | ops+ | Insert HR event + coaching event + cascade driver status |
| `process_reinstatement(driver, reason)` | ops+ | Insert reinstate HR event + coaching event + flip status back |
| `void_hr_event(event, reason)` | **owner only** | Insert void event with `superseded_by`; original preserved |
| `log_coaching(driver, category, channel, body, context)` | dispatcher+ | Plain coaching log entry (non-suspend) |

---

## Run it locally

```bash
supabase db reset
supabase test db
```

Expected:

```
NOTICE:  Seed loaded: 2 DSPs, 3 staff users, 8 drivers,
         11 attendance events, 1 HR events, 1 coaching events

# multi_tenant.test.sql:    15 of 15 passing
# hr_immutability.test.sql: 20 of 20 passing
# attendance.test.sql:      12 of 12 passing
# Total:                    47 of 47 passing
```

---

## Try it from the SQL editor

Authenticated as `ops@cardinal.test`:

```sql
-- Suspend Marcus Davidson for 5 days due to attendance
select public.process_suspension(
  'dddd0001-0000-0000-0000-000000000001'::uuid,    -- Marcus Davidson
  current_date,
  current_date + 5,
  false,                                            -- not pending term
  'attendance',
  'Driver crossed attendance threshold: 4 events in 30 days including ' ||
  '1 no-show on (date). Coaching plan: Monday 1:1 for 4 weeks.',
  jsonb_build_object('attendance_event_count', 4)
);

-- Verify driver status flipped
select id, full_name, status from public.drivers where full_name like 'Marcus%';
-- Expected: status = 'suspended'

-- Verify the HR file
select event_type, severity, effective_date, return_date, reason_detail
  from public.hr_events
 where driver_id = 'dddd0001-0000-0000-0000-000000000001'
 order by created_at desc;

-- Reinstate
select public.process_reinstatement(
  'dddd0001-0000-0000-0000-000000000001'::uuid,
  'Suspension period completed; coaching plan in effect.'
);

-- Driver back to active
select status from public.drivers where id = 'dddd0001-0000-0000-0000-000000000001';
-- Expected: 'active'
```

---

## What's intentionally NOT in Phase 2

- **No SMS yet.** `process_suspension` writes the HR record but does not
  send the driver an SMS notice. That's Phase 4 once Twilio + TCPA review
  is complete.
- **No shifts / open-shift release.** When a driver is suspended, the
  cascade should also flip future `shifts.status` to `'open'`. The
  trigger leaves a comment marker; the actual logic ships in Phase 3
  with the schedule tables.
- **No license renewal sweep.** Phase 5.
- **No PDF export of the HR file.** That's an Edge Function (Phase 5);
  the data is queryable now via the standard PostgREST endpoint.
- **No frontend wiring.** The mockup's Coach drawer + Today's check-in
  + Performance Management views still render mock data. Phase 2's job
  is to make the backend endpoints exist. Wiring the frontend to them
  is a separate piece of work that can happen during or after Phase 2.

---

## Pre-Phase-3 checklist

- [ ] `supabase test db` green on all 47 assertions in CI
- [ ] Migrations applied to `routeready-staging`
- [ ] Manual smoke test: suspend → verify driver status, verify HR row,
      verify coaching row, reinstate → verify status back
- [ ] Manual void test: process_suspension as ops, void as owner,
      verify status is 'active' and original row preserved
- [ ] Frontend wired to `record_attendance` (replaces `ciMark()` in
      check-in flow). This is the first user-visible Phase 2 change
- [ ] Audit log spot-check: insert 1 attendance event, void 1 HR event,
      verify both show up in `audit_log`

---

## Open issues to resolve in Phase 2 review

1. **Sync trigger performance.** The driver-status sync trigger runs
   on every `hr_events` insert. With high write volume (e.g. 1000 license
   reminders blasted nightly), this could slow inserts. Consider
   conditioning the trigger to only fire on suspension/termination/
   reinstatement event types.

2. **"Reinstatement supersedes suspension" logic.** The
   `active_suspensions` view treats any reinstatement after a
   suspension as cancelling it, regardless of whether that
   reinstatement is for that specific suspension. This is fine for
   single-suspension flows but breaks if a DSP suspends → reinstates →
   suspends → reinstates within a short window. Consider adding a
   `parent_event_id` column on reinstatement rows in Phase 3.

3. **`process_suspension` shift release.** The function intentionally
   does NOT release future shifts to `status='open'` because the
   `shifts` table doesn't exist yet. When Phase 3 ships, extend the
   function or add a separate trigger to do this. Test coverage:
   suspend a driver who has 5 future shifts → all 5 flip to open.

4. **License-reminder events**. `hr_event_type` includes
   `'license_reminder_sent'` but no RPC creates these yet. That comes
   in Phase 5. No action needed in Phase 2.

5. **Document signatures**. `hr_events.acknowledged_at` /
   `acknowledged_by` are unused in Phase 2. They're populated by the
   driver app's "Sign acknowledgment" flow which is Phase 6. The
   columns are forward-compatible — no migration needed when that
   ships.
