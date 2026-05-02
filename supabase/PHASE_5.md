# Phase 5 — Compliance

License renewals + auto-SMS + DOT inspections + recurring checklists +
the inbound `webhook-twilio` handler that finally completes the SMS loop.

## Files added

```
migrations/
  20260510200000_compliance.sql           # license_policies + reminders + form_templates/submissions + checklists
  20260510210000_phase5_rpcs.sql          # set_license_policy, send_license_reminder, mark_license_renewed, submit_form, complete_checklist_run
  20260510220000_phase5_audit.sql         # audit triggers
functions/
  run-license-reminders/index.ts          # cron-triggered: scans drivers, queues SMS for matched thresholds
  webhook-twilio/index.ts                 # inbound STOP/HELP/replies + status callbacks
tests/rls/
  compliance.test.sql                     # 12 assertions
seed.sql                                  # extended: 2 license policies, 2 form templates, 1 checklist template
PHASE_5.md
```

## What ships

### License renewals
- **`license_policies`** — per-DSP config: enabled, days_before array, template, notify_owner, block_scheduling.
- **`license_reminders`** — log of every fired reminder (dedupe, history).
- **`set_license_policy(...)`** RPC — owner only.
- **`send_license_reminder(driver)`** RPC — manual resend; queues SMS + writes HR file entry.
- **`mark_license_renewed(driver, new_expiry, license_number, doc_path)`** — bumps expiry, logs to HR.
- **`run-license-reminders`** Edge Function — cron-triggered daily 06:00. Scans drivers, finds expirations matching policy thresholds today, dedupes against prior reminders, calls `enqueue_sms` + writes log + HR event.
- **Auto-block scheduling** — when `block_scheduling=true`, a trigger on `shifts` rejects assignment of drivers with expired licenses to future shifts. DOT compliance.

### Forms / inspections
- **`form_templates`** — pre_trip, post_trip, incident, maintenance, onboarding, custom.
- **`form_submissions`** — driver/staff submitted, with photos (Storage paths), GPS, flagged=true for review queue.
- **`submit_form(template, responses, ...)`** RPC — driver self or staff on behalf.

### Checklists
- **`checklist_templates`** — daily/weekly/monthly/shift_open/shift_close cadence.
- **`checklist_runs`** — one per (template × due_date), unique. Tracks completion.
- **`complete_checklist_run(run_id, responses)`** RPC.

### `webhook-twilio` (the missing piece for full SMS compliance)
- Inbound message: detects STOP/UNSUBSCRIBE/CANCEL/QUIT/END/STOPALL → calls `handle_opt_out`.
- START/UNSTOP/YES → removes from opt-out list.
- HELP/INFO → returns standard help reply.
- Other inbound → records as `sms_messages` row (direction=inbound) for dispatcher view.
- Status callbacks (delivered, failed, etc.) → updates the matching `sms_messages` row.
- DSP routing: lookup by `dsps.settings.twilio_from_number`, fallback to last 7d outbound.

## TCPA-required: STOP/HELP responses are now wired
- An inbound STOP from any opted-in driver/applicant is processed within seconds, marks the phone in `sms_opt_outs`, and cancels any queued outbound to that phone (via the trigger from Phase 4).
- HELP returns a standard "Reply STOP to unsubscribe. Msg & data rates may apply." response.
- Both are TCPA carrier-level requirements.

## Run + tests

```bash
supabase db reset
supabase test db
```

Combined: **116 pgTAP assertions** across 8 test files (Phase 1–5).

## Pre-Phase-6 checklist

- [ ] All 116 pgTAP green
- [ ] `run-license-reminders` deployed; cron scheduled; dry-run verified
- [ ] `webhook-twilio` deployed; URL configured in Twilio console for the test number
- [ ] Send a test SMS to the Twilio number with body "STOP" → opt-out row appears
- [ ] Frontend License renewals page wired to `set_license_policy` + `mark_license_renewed`
- [ ] Frontend pre-trip inspection wired to `submit_form`

## Open issues

1. **Status callback signature verification.** `webhook-twilio` currently doesn't validate the `X-Twilio-Signature` header. Add HMAC validation before production.
2. **Quiet hours.** No-send-before-X / no-send-after-Y per DSP. Add to `dsps.settings`.
3. **Threshold-day timezone math.** `run-license-reminders` uses UTC `today`. For DSPs in non-UTC timezones, this could fire ~1 hour early or late. Honor `dsps.timezone`.
4. **DOT medical card.** `drivers.dot_medical_card_expiry` exists but no policy / reminders yet. Mirror license_policies if needed.
5. **Auto-block on expired license** is at insert/update time only. If a license expires mid-week with already-assigned shifts, those shifts remain. Consider a daily cron that flips them to `open` on the day of expiry.
