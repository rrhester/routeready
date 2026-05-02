# Phase 4 — Hiring + SMS infrastructure

The hiring funnel + the SMS layer that powers it. **The actual outbound
SMS is feature-flagged behind `dsps.settings.sms_enabled`** so the
schema, RPCs, and queue are live without sending any messages until
TCPA review is complete and Twilio A2P registration is approved.

This phase ships the entry point of the flywheel — applicants land
here, get screened, get hired, become drivers — closing the cycle that
started with operations in Phases 2 and 3.

---

## Files added

```
supabase/
  migrations/
    20260510140000_applicants.sql                    # applicants + screening_questions + screening_responses
    20260510150000_referrals.sql                     # referral_payouts
    20260510160000_sms.sql                           # sms_messages + sms_opt_outs
    20260510170000_phase4_rpcs.sql                   # the hiring lifecycle verbs
    20260510180000_phase4_triggers.sql               # score recompute, hire guard, opt-out enforcement
    20260510190000_phase4_audit.sql                  # audit triggers
  functions/
    _archive/                                        # legacy functions moved here per PLAN §20
      cal-schedule/  claude-ai/  finalize-application/
      record-config/  send-sms/  README.md
    send-driver-sms/index.ts                         # NEW — TCPA-gated Twilio sender
  tests/rls/
    applicants.test.sql                              # 15 assertions
    sms_and_referrals.test.sql                       # 12 assertions
  seed.sql                                           # extended with 7 screening questions + 5 applicants
  PHASE_4.md                                         # this file
```

---

## What ships

### Applicant funnel

- **`applicants`** with stage enum: `new / screening / passed / booked / hired / rejected / filtered / no_show`
- Source dedup via `(dsp_id, source_ref)` unique index — same Indeed apply ID never lands twice
- **`screening_questions`** per-DSP catalog. Field types: `yes_no / single / multi / text / number / date`. Each has optional `hard_filter` (auto-fail) and `scoring` (point map by answer).
- **`screening_responses`** — one row per (applicant × question). Score and hard-filter flag computed at write time.
- Drivers can see applicants **only if they referred them** (per-driver visibility).

### Hiring lifecycle RPCs

| RPC | Auth | Effect |
|---|---|---|
| `create_applicant(...)` | dispatcher+ | Insert + dedup on `source_ref` |
| `record_screening_response(...)` | dispatcher+ | Score lookup + hard-filter check; trigger recomputes total |
| `advance_applicant_stage(...)` | dispatcher+ | Enforces allowed transitions (filtered → screening allowed; filtered → hired blocked) |
| `book_interview(...)` | dispatcher+ | Sets `cal_event_id` + `interview_at`, flips stage to `booked` |
| `hire_applicant(applicant, hire_date, station, amounts)` | **ops+** | Creates `drivers` row, flips applicant stage, creates 4 referral payouts if attributed |
| `mark_referral_paid(payout, paid_via)` | ops+ | Sets `paid_at` |

### Triggers

- **Score auto-recompute** — every screening_response insert/update sums the score across all of that applicant's responses
- **Stage auto-advance** — first response flips `new → screening`; hard-filter answer flips to `filtered`
- **Hire safety net** — direct `UPDATE applicants SET stage='hired'` is blocked unless `hired_driver_id` is set. Forces use of `hire_applicant()` RPC.
- **SMS opt-out enforcement** — outbound `sms_messages` insert to a phone in `sms_opt_outs` raises `restrict_violation`. TCPA-required.

### SMS infrastructure

- **`sms_messages`** queue. Frontend never inserts directly — calls `enqueue_sms` RPC which is `security_definer` and writes the row.
- **`sms_opt_outs`** — phones that have opted out of SMS for this DSP. Auto-populated by `handle_opt_out` (called from the inbound webhook on `STOP`).
- **`enqueue_sms(...)`** — XOR validation: exactly one of `driver_id` or `applicant_id` must be set. Phone normalized to E.164 by the trigger; rejected if invalid.
- **`handle_opt_out(phone, reason)`** — adds to opt-out list, marks any pending queued messages to that phone as `opted_out`. Called by `webhook-twilio` on inbound STOP.

### Referral payouts

On `hire_applicant()` for a referrer-attributed applicant, the system auto-creates 4 payout rows:

| Milestone | Default amount | Due date |
|---|---|---|
| `hire` | $500 | hire_date |
| `tenure_30` | $250 | hire_date + 30d |
| `tenure_60` | $250 | hire_date + 60d |
| `tenure_90` | $500 | hire_date + 90d |

Total $1,250 per successful referral by default; per-DSP override via the `p_referral_amounts` JSONB arg.

The referrer driver can SELECT their own payouts. Ops sees all DSP payouts.

---

## TCPA gate (the most important Phase 4 design choice)

The `send-driver-sms` Edge Function reads `dsps.settings.sms_enabled` for every message. If false, the row stays `queued` and the function returns `tcpa_gated` for that message. Until counsel signs off and Twilio A2P registration is approved, **every DSP defaults to `sms_enabled=false`** — no message goes out, even though the schema and RPCs are fully wired.

To enable for a DSP after compliance is complete:

```sql
update public.dsps
   set settings = jsonb_set(settings, '{sms_enabled}', 'true'::jsonb)
 where id = '<dsp_uuid>';
```

This is a deliberate manual flip per DSP — there is no UI for it.

---

## Legacy functions archived

The previous Phase 0 Edge Functions (`claude-ai`, `send-sms`,
`finalize-application`, `record-config`, `cal-schedule`) have been
moved to `supabase/functions/_archive/` per PLAN.md §20. They are
**reference only** — do not extend them. Their replacements:

| Legacy | Replacement (when it lands) |
|---|---|
| `send-sms` | `send-driver-sms` (Phase 4 — this PR) |
| `finalize-application` | `webhook-cal` + applicant insertion via service role (Phase 4 follow-up) |
| `cal-schedule` | folded into `webhook-cal` |
| `record-config` | kept as-is to serve the public `record.html` page (still alive, just relocated) |
| `claude-ai` | re-purposed into `generate-coaching-sms` (Phase 7) |

Do not deploy archived functions to staging or production.

---

## Run it locally

```bash
supabase db reset
supabase test db
```

Expected:

```
Seed loaded: 2 DSPs, 3 staff, 8 drivers, 11 att, 1 HR, 1 coach,
             6 routes, 30+ shifts, 1 OKAMI, 5 applicants, 7 screening questions

# multi_tenant.test.sql:        15 of 15 passing
# hr_immutability.test.sql:     20 of 20 passing
# attendance.test.sql:          12 of 12 passing
# schedule.test.sql:            15 of 15 passing
# swap_timeoff_okami.test.sql:  15 of 15 passing
# applicants.test.sql:          15 of 15 passing
# sms_and_referrals.test.sql:   12 of 12 passing
# Total:                        104 of 104 passing
```

---

## Try it from the SQL editor

```sql
-- as ops@cardinal.test:

-- Create an applicant from the manual flow
do $$
declare v_app_id uuid;
begin
  v_app_id := public.create_applicant(
    'New Hire Test', 'newhire@example.com', '+14175550000',
    'walkin', null,
    'dddd0001-0000-0000-0000-000000000003'::uuid    -- referred by Kerwin
  );

  -- Answer screening question 1: "When can you start?" → "This week" (3 pts)
  perform public.record_screening_response(
    v_app_id, 'q0000001-0000-0000-0000-000000000005', 'This week'
  );

  -- Advance through stages
  perform public.advance_applicant_stage(v_app_id, 'passed');
  perform public.advance_applicant_stage(v_app_id, 'booked');

  -- Book an interview
  perform public.book_interview(v_app_id, 'cal-event-xyz', now() + interval '1 day');

  -- Hire (creates driver + 4 referral payouts)
  perform public.hire_applicant(v_app_id);
end $$;

-- Verify
select stage, hired_driver_id, score
  from public.applicants where full_name = 'New Hire Test';
-- → hired, <uuid>, 3

select milestone, amount_cents, due_at
  from public.referral_payouts
  join public.applicants a on a.id = referral_payouts.applicant_id
 where a.full_name = 'New Hire Test'
 order by due_at;
-- → 4 rows: hire / tenure_30 / tenure_60 / tenure_90

-- Try an SMS (it will queue, but won't actually send because sms_enabled=false)
select public.enqueue_sms(
  '+14175550000',
  'Welcome to Cardinal Logistics! Your first orientation is tomorrow at 9am.',
  null,
  (select id from public.applicants where full_name = 'New Hire Test'),
  'interview_confirm'
);

select status from public.sms_messages
 where applicant_id = (select id from public.applicants where full_name = 'New Hire Test');
-- → 'queued' (won't flip to 'sent' until sms_enabled=true and the
--    send-driver-sms Edge Function runs)
```

---

## What's intentionally NOT in Phase 4

- **No live SMS sends.** Schema + queue + Edge Function ready, but
  `sms_enabled=false` per DSP keeps everything queued. Flip the flag
  per DSP after TCPA review.
- **No Indeed XML poller.** The schema supports Indeed-sourced
  applicants (via `source='indeed'`, `source_ref=<apply id>`) but the
  poller Edge Function is deferred. Manual entry works today.
- **No Cal.com webhook handler.** `book_interview` works today via
  manual call. Auto-booking on Cal.com event creation is deferred to
  Phase 4.5.
- **No Interview Day mode.** That's a frontend feature; backend is
  ready (`advance_applicant_stage` to `hired/no_show/rejected`).
- **No video screening.** The legacy `record.html` + `record-config`
  Edge Function still serves applicant video uploads. Integration with
  the new `applicants.video_urls` array is a Phase 4.5 task.

---

## Pre-Phase-5 checklist

- [ ] All 104 pgTAP green in CI
- [ ] Migrations applied to `routeready-staging`
- [ ] **TCPA review complete** (counsel sign-off, opt-in language audit, quiet-hours policy approved)
- [ ] Twilio A2P registration submitted and approved for at least one
      pilot DSP
- [ ] At least one pilot DSP has `sms_enabled=true` set in `dsps.settings`
- [ ] `send-driver-sms` deployed to staging, exercised end-to-end with
      a test message, status updates flowing back to `sms_messages.status`
- [ ] `webhook-twilio` deployed (inbound STOP/HELP handling) — Phase 5
      includes this as a sub-task because it's needed for license
      reminder replies
- [ ] Frontend Pipeline view wired to `applicants` rows + RPCs
- [ ] Frontend Coach drawer's SMS tab calls `enqueue_sms` with
      `related_kind='coaching'`

---

## Open issues to resolve in Phase 4 review

1. **`enqueue_sms` from_phone defaulting.** The current default
   `+15555555555` is a placeholder. Real impl: read from
   `dsps.settings.twilio_from_number` in the RPC. Update before any
   DSP flips `sms_enabled=true`.

2. **Idempotency on `webhook-cal`.** When a Cal.com event is
   rescheduled, we get a new event with same `cal_event_id`. The
   handler (Phase 4.5) needs to UPDATE the applicant row, not
   double-book.

3. **Quiet hours.** The schema doesn't currently store quiet hours
   per DSP. PLAN §3.4 mentioned this. Add to `dsps.settings` or a
   new `dsps.sms_settings` JSONB column. Critical TCPA compliance
   item.

4. **Hard-filter check robustness.** The current check matches
   `hard_filter->>'answer'` against the literal answer string. For
   multi-select questions, this won't catch cases where the user
   selects multiple values including the disqualifying one. Extend
   to handle array containment.

5. **Stage transition audit trail.** Stage changes are captured in
   `audit_log` (table-level), but a flat audit row doesn't show the
   sequence. Consider a dedicated `applicant_stage_changes` table
   for the timeline view in the UI.

6. **Bulk import for applicants.** No equivalent of
   `bulk_import_drivers` for applicants. If a DSP wants to import
   their existing pipeline from a spreadsheet, build that next.
