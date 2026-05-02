# Phase 6 — Fleet

Vehicles, assets (phones / fuel cards / toll tags / key fobs / scanners /
uniforms), maintenance records, and general DSP documents. Closes the
`form_submissions.vehicle_id` FK from Phase 5 — pre/post-trip
inspections are now linked to a real vehicle.

## Files

```
migrations/
  20260510230000_fleet.sql                # vehicles + assets + assignments + maintenance + documents
  20260510240000_phase6_rpcs_audit.sql    # assign_asset / return_asset / record_maintenance / bulk_import_vehicles + audit triggers
tests/rls/
  fleet.test.sql                          # 11 assertions
seed.sql                                  # extended: 3 vehicles + 3 assets
PHASE_6.md
```

## What ships

### Vehicles (`vehicles`)
- `van_number` (human ID, unique per DSP), `vin`, `plate`, `make/model/year`
- `status` enum: active / maintenance / out_of_service / retired
- `mileage`, `dot_inspection_at`, `insurance_doc`, `registration_doc`
- Indexes for status, station, DOT inspection lookups

### Assets (`assets`) + assignment history
- `asset_type` enum: phone / fuel_card / toll_tag / key_fob / uniform / scanner / other
- Unique on `(dsp, asset_type, identifier)` — same IMEI never two assets
- `asset_assignments` history with **exclusion constraint** preventing more than one open assignment per asset
- `assign_asset` auto-closes the prior open assignment when reassigning
- `return_asset` records condition + notes

### Maintenance (`maintenance_records`)
- Per-vehicle history with service_type, mileage, cost, vendor, files
- `record_maintenance(...)` updates vehicle mileage if higher and bumps `dot_inspection_at` when `service_type='dot_inspection'`

### Documents (`documents`)
- General-purpose document store with category + related entity
- `expiry_date` indexed for the renewal-reminder scheduler
- Polymorphic `(related_kind, related_id)` so docs can attach to vehicles, drivers, or DSP-level items

### Bulk import
- `bulk_import_vehicles(payload jsonb)` — same shape as `bulk_import_drivers`. Validates van_number, resolves station_code, returns per-row errors.

## Total: 127 pgTAP assertions across 9 test files (Phases 1–6).
