# Fleet system — audit & build record (2026-07-25)

Operator directive: *"a top of the line tool that tracks fleet inventory —
ground a van, store information, preventative maintenance schedules,
inventory. I want a world class fleet system."*

This document records the audit of the existing fleet surfaces, the gaps
found, and what the fleet-inventory push built. It stays the reference
for the Fleet page + PM + parts-stock architecture.

---

## 1 · What already existed (audit summary)

The fleet domain was already deep in four places:

| System | Depth |
|---|---|
| **Grounding** | `vehicles.operational_status` with ONE mutation path (`vehicle_set_operational_status`, 0308), trigger-maintained `vehicle_grounding_events` ledger (0228), Amazon 2 BD / 14 BD clocks, assignment clearing + blocking (0230), service-window grounding via the fleet calendar (0340), un-ground alerts |
| **Repair Center** | 9 phases (0486–0492): cases → quotes → authorizations → shop visits → email AI → invoices → reconciliation → reporting. See docs/REPAIR-CENTER.md |
| **Issues / inspections** | `vehicle_issues` (driver self-report forms, DVIC AI review 0242–0248), repair orders from issues |
| **Parts sourcing** | Parts Intelligence (0485, docs/PARTS-INTELLIGENCE.md) — search / fitment / compare / purchase. **Sourcing only — no on-hand stock** |
| **Scorecard** | FEM / VORR (0301/0302) on the roster + exec KPI strip |

## 2 · Gaps found (and closed by this push)

1. **`vehicles_roster()` regression (0345)** — the latest revision was
   rebuilt from 0213's body and silently dropped every decoration added
   by 0239/0297/0301/0308: `is_branded`, `fem_status`,
   `days_since_deployed`, grounded metadata, doc badges, active-RO
   fields, `driver_reported_open_count`, backup driver. Because
   `fleet_execution_summary()` filters on `is_branded`, the FEM/VORR
   strip was starved too. (This was the standing hazard note in
   docs/REPAIR-CENTER.md §1.) **Fixed in 0537** — re-issued from the
   full 0308 body + `van_type` + `expected_return_on`. Any future
   redefinition must start from 0537's body.
2. **PM was a manually-typed date** (`vehicles.next_service_due_at`)
   with nothing rendering off it. No service programs, no
   mileage/time intervals, no due engine, no alerts.
3. **Thin vehicle records** — documents limited to
   insurance/registration; no acquisition, warranty, lease/rental,
   telematics/fuel-card/toll-tag/tire data; the drawer's Service
   history tab was unreachable dead code (its only writer,
   `vehicle_service_log_save`, had no UI).
4. **Grounding captured only category + note** — no expected-return
   date, no un-ground note, no repair-case handoff.
5. **No parts room** — nothing tracked stock on hand.
6. **No per-van cost picture** — repair reporting aggregates per-shop
   and fleet-wide only.
7. prompt()-chain UX for service/mileage/inspection logging.

## 3 · What shipped

### Migration 0537 · `fleet_inventory_foundation`
- `vehicles` columns: `fuel_type, tire_size, telematics_id, fuel_card,
  toll_tag, acquired_on, acquired_cost_cents, warranty_expires_on,
  warranty_miles, lease_provider, lease_expires_on,
  lease_monthly_cents, metadata jsonb`.
- `vehicle_documents.kind` broadened: + `title, lease, warranty, other`
  (`vehicle_document_save` re-issued to match; only
  insurance/registration ever drive the roster exception badge).
- Grounding: `vehicle_grounding_events.expected_return_on` +
  `unground_note`; `vehicle_set_operational_status` gains
  `p_expected_return_on` (5-arg; old 4-arg dropped first — internal
  callers use positional args and still resolve).
- `vehicle_record_save` re-issued with 13 new params **including
  `van_type`** (previously a raw client-side table UPDATE).
  Full-record PUT semantics unchanged.
- **`vehicles_roster()` consolidated re-issue** (the regression fix).
- `fleet_execution_summary(p_station_id default null)` — the master
  station lens reaches FEM/VORR (no-arg = DSP-wide, unchanged).
- **PM engine**: `fleet_pm_rules` (interval_miles and/or
  interval_months + warn windows + optional van_type scope),
  `fleet_pm_completions` (date, odometer, cost, vendor; feeds the
  mileage ledger + `last_service_at`), RPCs
  `fleet_pm_install_defaults` (Oil/Tires/Brakes/Fluids/DOT),
  `fleet_pm_rule_save`, `fleet_pm_log_completion`,
  `fleet_pm_board(p_station_id)` — per van × rule: last done, due
  (both axes), status `overdue | due_soon | ok | no_baseline`.
  The status math is mirrored in `dashboard/fleet-pm-core.mjs`
  (tested, `scripts/test-fleet-pm.mjs`) — keep the two in sync.
- `vehicle_cost_summary(p_vehicle_id, p_months=12)` — settled repair
  invoices + un-cased legacy ROs + service logs + PM completions +
  part purchases, and cost-per-mile from `vehicle_mileage_log`.
  Optional tables fail soft (undefined_table → 0).

### Migration 0538 · `parts_stock_inventory`
- `parts_stock_items` (bins, min-qty reorder points, moving-average
  `unit_cost_cents`, optional station + canonical-part links) +
  `parts_stock_movements` (append-only; receive / consume / return /
  adjust; optional `vehicle_id` / `repair_case_id`).
- Quantity moves ONLY through `parts_stock_move` (row-locked; refuses
  negative stock; `adjust` takes the new absolute count; costed
  receives shift the moving average). `parts_stock_item_save` edits
  descriptive fields only (opening balance books a receive).
- `parts_stock_list` (low-stock flags, value on hand, station lens:
  station-tied items scope, null-station items show everywhere — the
  DSP-wide-channels convention), `parts_stock_movements_list`.

### Client
- **Fleet → Maintenance tab** (`fl-sub-maint`): summary pills, worst-
  first van × rule board (status chips with due-in copy + tooltips),
  attention filter, click-a-chip → log completion, Manage program
  modal (add/edit/retire rules), Install-standard-program empty state,
  stale-odometer flag. Roster identity cells get `PM overdue` /
  `PM due` chips (board cached 5 min; silent pre-0537).
- **Grounding**: modal gains expected-back date + "also open a repair
  case" (hands off to `RRRepair.createForVehicle`); un-ground now goes
  through a small return-to-service modal that captures an optional
  note; roster badge tooltip + VORR drill-down surface the
  expected-return plan ("Expected back Jul 30" / red "Was due back").
- **Drawer**: Service tab wired back in (was unreachable); new Profile
  sections (Specs & equipment; Acquisition, warranty & lease — money
  entered in dollars, stored in cents); prompt() chains replaced by a
  shared form modal (`_fdFormModal`); Vehicle-history tab tops with
  the per-van cost card (12-mo spend, breakdown, cost/mile).
- **Parts tab**: "On-hand inventory" section — stock table with bins /
  low-stock badges / value, receive-use-adjust modals (consume links a
  van), per-item movement ledger modal.
- All new RPC calls degrade gracefully pre-migration (PGRST202 →
  legacy retry or setup notice).

## 4 · Conventions that must hold

- `vehicles_roster()` edits start from **0537's body**. Never rebuild
  from an older migration (that's how the 0345 regression happened).
- `vehicle_set_operational_status()` stays the ONLY op-status writer.
- PM due math changes go to BOTH `fleet_pm_board` (SQL) and
  `fleet-pm-core.mjs` (JS) — the node suite pins the JS half.
- Stock quantities move only through `parts_stock_move`.
- Money is integer cents everywhere; dollars only at the input edge.
- New live.js markup is class-only (design-lint inline-style ratchet).

## 5 · Deferred / follow-ups

- **Driver-app odometer capture** (product-audit #90): map a numeric
  `odometer` answer in the DVIC form into `vehicle_inspections.mileage`
  + `vehicle_mileage_log` server-side (`driver_submit_form` re-issue —
  risky function, own PR). Until then mileage arrives via manual
  readings, PM completions, and repair return-to-service.
- Telematics (GeoTab) mileage sync — `vehicle_mileage_log.source`
  already supports `geotab`; needs an integration.
- Stock station picker in the item editor (schema supports
  `station_id`; UI defaults to the shared room).
- Repair-case parts consumption from the case drawer (movements
  already accept `repair_case_id`).
- Cost summary in a fleet-wide report (per-van table, sortable).
