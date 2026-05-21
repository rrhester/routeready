# RouteReady Driver Scheduling Engine — Specification v2

## 0. Scope

Build a deterministic, explainable, rule-based engine that assigns **drivers**
to **existing open shifts**.

**In scope**

- Driver-to-shift assignment based on eligibility, historical pattern,
  attendance, and DSP settings.

**Out of scope (v1)**

- Demand generation (open shifts already exist).
- Van assignment (driver-only scheduling).
- Performance scoring (reserved interface only — see R014).
- Route optimization, route grouping, communications, SMS.

---

## 1. Core Principles

1. **Deterministic.** Same inputs always produce byte-identical outputs.
2. **Explainable.** Every assignment, skip, and uncovered shift has a
   human-readable reason stored alongside the decision.
3. **Hard rules block. Soft rules score.**
4. **Manual overrides win.** A scheduler's locked assignment is never quietly
   removed; if it violates a hard rule, it is flagged — not deleted.
5. **Missing data fails safe.**
   - Missing license expiration + enforcement on → block + flag.
   - Missing certification flag → block for the cert-requiring route.
   - Missing attendance score → neutral (treated as median).
   - Missing performance data → ignored (R014 inactive).
   - New driver with insufficient history → neutral pattern affinity.

---

## 2. Implementation notes

This directory implements Specification v2 in full (Steps 1–10, rules
R001–R018). See the module map below; the authoritative behavioral contract
is the rule reference the spec was delivered with.

- One file per rule (`src/rules/rNNN_*.ts`).
- One file per algorithm step (`src/steps/stepN_*.ts`).
- `src/orchestrator.ts` is a thin sequencer.
- All rule evaluation is pure; mutation happens only via `src/plan.ts`.
- Determinism: no `Date.now()` / `Math.random()` in scoring or tie-breaking
  (`elapsed_ms` is the only wall-clock value and is excluded from the
  idempotency comparison). All `Set`/`Map` iteration is sorted by stable keys.

## 3. Module map

| Area | File |
|---|---|
| Public entry | `src/index.ts` → `runEngine(input)` |
| Orchestrator | `src/orchestrator.ts` |
| Types | `src/types.ts` |
| Settings validation | `src/settings.ts` |
| Input normalization | `src/normalize.ts` |
| Date helpers | `src/dates.ts` |
| Runtime queries | `src/runtime.ts` |
| Eligibility evaluator | `src/eligibility.ts` |
| Idempotency hash | `src/hash.ts` |
| Steps 1–10 | `src/steps/stepN_*.ts` |
| Rules R002–R011, R019 (hard) | `src/rules/r0NN_*.ts` |
| Rules R012/R013/R015/R017/R018 (score/order) | `src/rules/r0NN_*.ts` |

R019 (WOC — Working Hours Compliance) is a hard rule: it blocks a driver's
7th consecutive working day. The main assignment pass (Step 6) runs in two
phases — DOT-required routes first, then standard routes — so DOT-certified
drivers are never spent on a standard route while a DOT route is unfilled.
| Dashboard adapter | `src/adapters/dashboard.ts` → `planScheduleWeek()` |
| Browser bundle entry | `src/browser-entry.ts` |

## 3a. Dashboard integration

`dashboard/live.js` (the operator dashboard) drives the engine through
the "Smart Fill" / Auto-fill-week button:

1. `npm run build:dashboard` bundles `src/browser-entry.ts` (engine +
   adapter, no Node dependencies) into `dashboard/scheduling-engine.js`.
2. `live.js` imports `planScheduleWeek` from that bundle.
3. `planScheduleWeek(payload)` maps Supabase-shaped rows (drivers,
   shifts, service types, time-off, Smart Fill rule toggles) onto an
   `EngineInput`, runs the engine, and returns the `ScheduleResult`.

The bundle is committed; CI rebuilds it and fails if it drifts from
source. Re-run `npm run build:dashboard` after any engine change.

## 4. Usage

```ts
import { runEngine } from "./engine/src/index.ts";

const result = runEngine({
  schedule_week_start: "2026-05-24",
  shifts: [...],
  drivers: [...],
  history: [...],
  dsp: { dsp_week_start_day: 0, dsp_blackout_dates: [] },
  settings: { run_mode: "fill_empty_only" },
});
```

The engine returns a `ScheduleResult` with `assigned_shifts`,
`uncovered_shifts`, `driver_totals`, `violations`, `warnings`,
`explanations`, `summary_metrics`, and an `inputs_hash`.

## 5. Tests

```
cd engine
npm install
npm run check     # typecheck + test
```

Coverage includes per-rule fixtures, full-run scenarios, and a 10×
idempotency regression that diffs output (ignoring `elapsed_ms`).
