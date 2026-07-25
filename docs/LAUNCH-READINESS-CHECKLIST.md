# RouteReady — pre-customer launch checklist

Single source of truth for what must happen before the first paying customer
gets access. Derived from `CUSTOMER_READINESS_AUDIT.md` (verdict: **NOT READY**
until the blockers below are cleared). Supersedes the migration numbers in
PR #4123's description, which were renumbered during merge — **the numbers here
are the ones actually on `main`.**

> Migrations are applied **by hand in the Supabase SQL Editor** (the deploy
> workflow's DB step is a no-op). Every migration below is idempotent and, on
> its own, backward-safe — new gates are opt-in and default off.

---

## 1 · Apply the shipped migrations (SQL Editor)

All eight from PR #4123 are on `main` at these numbers. The ownership RPC may
already be applied (you ran its SQL earlier under an older number — it is
byte-identical, so `driver_can_read_file` already exists if so).

**Apply now — any order (all idempotent, opt-in/graceful):**

- [ ] `0560_edv_and_license_buffer_gates` — EDV-cert + licence-protection-window enforcement in the 3 server compliance gates (H-4/H-5)
- [ ] `0561_driver_file_ownership` — `driver_can_read_file` ownership RPC (**must be live** — the deployed `driver-file-sign` edge function calls it; likely already applied)
- [ ] `0563_driver_schedule_publish_gate` — opt-in draft/publish gate for the driver schedule (H-3)
- [ ] `0564_rpc_role_gates` — 23 privileged RPCs now refuse the driver role (H-2)
- [ ] `0565_mfa_server_enforcement` — `mfa_ok()` primitive + opt-in MFA on settings mutators (H-1)
- [ ] `0566_vehicle_vin_dedup` — blocks duplicate VINs within a DSP (#37)
- [ ] `0567_drop_receipts_anon_read` — closes the receipts-bucket cross-tenant leak (B-1 sibling; safe any time)

**Apply LAST — only after driver-app device-QA (next section):**

- [ ] `0562_drop_anon_storage_reads` — **this is the migration that actually closes Blocker B-1.** It removes the bucket-wide anon read on the three driver buckets. Do not apply until the driver app is proven reading through `driver-file-sign` on a real device, or drivers can't open their own photos/licences/attachments.

---

## 2 · Clear the blockers (the real gate to "ready")

### B-1 · Cross-tenant storage — finish it
- [ ] On a real phone logged in as a driver, confirm each loads: profile photo, teammate photos, driver-licence images (front/back), a DVIC/uploaded doc, a chat attachment. Uploads still work. (Full checklist: `docs/B1-STORAGE-SIGNING-RUNBOOK.md`.)
- [ ] Optional strong check: with a driver token, `driver-file-sign` for another driver's path in another DSP returns **403**.
- [ ] Only once green → apply `0562` (above). Re-run the driver checks with the anon policies gone.

### B-2 · Backups + a tested restore — **biggest remaining risk**
- [ ] Enable Supabase **PITR**; confirm the earliest-recoverable timestamp is advancing.
- [ ] Run one **non-destructive restore drill** (dump prod → restore into a throwaway target → verify row counts + policies/functions → measure recovery time → delete the PII dump). Full steps: `docs/B2-BACKUP-RESTORE-DRILL.md`.
- [ ] Write down the retention window + measured RTO.

### B-3 · Migration drift — reconcile
- [ ] Apply every pending migration (section 1), then confirm `rr_schema_version()` reflects the head. The global drift banner will stop showing once the DB is caught up.

---

## 3 · Clear the Highs (before a normal launch)

- [ ] **H-6 monitoring** — point an uptime monitor at `/health` (`docs/H6-UPTIME-MONITORING.md`); test that the alert reaches your phone.
- [ ] **H-1 MFA** — decide whether to switch on `require_mfa` for owner/admin users (opt-in; enrol before enabling — the gate fail-safes for un-enrolled users).
- [ ] **H-3 publish gate** — decide whether to require finalised schedules before drivers see them (opt-in per DSP).
- [ ] **H-7 / H-8** — already shipped (support channel in Help; corrected legal sub-processors). Confirm the support destination reaches you.

---

## 4 · The go/no-go line

Per `CUSTOMER_READINESS_AUDIT.md`: **do not give a customer access** until, at
minimum —
1. **B-2** is done (PITR on + one tested restore),
2. **B-1** is fully closed (device-QA green **and** `0562` applied),
3. **H-6** monitoring is live.

Until those three are true, treat customer data as unrecoverable and the app as
unmonitored. Everything else in the audit is either shipped or opt-in.
