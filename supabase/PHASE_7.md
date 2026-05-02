# Phase 7 — Finance

Vendor invoice ingestion, line-item reconciliation, dispute filing, and
recovery tracking. Roll-up trigger keeps `invoices.amount_disputed` and
`amount_recovered` synced from the disputes table automatically.

## Files

```
migrations/
  20260510250000_finance.sql              # invoices + line_items + disputes + reconciliation_rules
  20260510260000_phase7_rpcs_audit.sql    # import_invoice / flag_invoice_line / file_dispute / resolve_dispute / submit_dispute + roll-up trigger + audit
tests/rls/
  finance.test.sql                        # 10 assertions
PHASE_7.md
```

## What ships

### Invoices (`invoices`)
- `source` enum: amazon_variable / amazon_fmp / insurance / rental_3p / fuel / tolls / maintenance / other
- `status` enum: imported → reviewed → disputed → closed
- Computed-but-stored: `amount_disputed_cents`, `amount_recovered_cents` (kept fresh by trigger)
- Unique on `(dsp, source, invoice_number)` to prevent re-import dupes

### Line items (`invoice_line_items`)
- One row per billed line, with `category` (damages, late_returns, scan_compliance, dcr, etc.)
- `rule_check` JSONB stores reconciliation result: `{rule, expected, actual, match: bool, evidence}`
- `flagged` boolean → "worth disputing"; `disputed` boolean → already in disputes

### Disputes (`disputes`)
- `resolution` enum: pending / won / partial / lost / withdrawn
- `drafted_letter` text (AI-generated in Phase 8 via `generate-dispute-letter`)
- `evidence_refs` JSONB linking back to attendance / shifts / form_submissions / dashcam clips
- `submission_method`: amazon_portal / email / letter / other
- `recovered_cents` populated on resolution

### Reconciliation rules (`reconciliation_rules`)
- Per-DSP toggle table: `rule_key` + `enabled` + `config` JSONB
- Rules: scan_compliance, route_count, late_return, damage_at_fault, dcr_tier, safety_misclassification, etc.
- The actual rule logic runs in the dispute-drafting Edge Function (Phase 8) — this table just configures *which* rules to apply.

### Roll-up trigger
After every `disputes` insert/update/delete:
- Recomputes `invoices.amount_disputed_cents` = sum of all dispute amounts
- Recomputes `invoices.amount_recovered_cents` = sum of `recovered_cents` where resolution ∈ (won, partial)
- Auto-flips invoice status:
  - `disputed` if any dispute exists
  - `closed` if no pending disputes remain AND recovery > 0

## RPCs

| RPC | Auth | Effect |
|---|---|---|
| `import_invoice(...)` | ops+ | Insert invoice + bulk-insert line items in one call |
| `flag_invoice_line(line, flagged, rule_check)` | ops+ | Mark line worth disputing + record reconciliation result |
| `file_dispute(invoice, line, amount, letter, evidence)` | ops+ | Create dispute, mark line disputed, trigger fires roll-up |
| `submit_dispute(dispute)` | ops+ | Record submitted_at |
| `resolve_dispute(dispute, resolution, recovered, notes)` | ops+ | Set resolution + recovered_cents, trigger fires roll-up |

## Total: 137 pgTAP assertions across 10 test files (Phases 1–7).

## What's NOT in Phase 7

- **No AI dispute drafting yet.** `drafted_letter` is a plain text column. Phase 8 adds the `generate-dispute-letter` Edge Function that calls Claude API to draft a letter from `evidence_refs`.
- **No automatic reconciliation runs.** A nightly job that compares Amazon invoice line items against own delivery records is also Phase 8.
