# RouteReady Flex Capacity Engine

> **"If Amazon increased routes tomorrow, how many additional routes could this DSP realistically absorb?"**

An **operational planning** metric. It is **not** a staffing metric, **not** a headcount metric, and **not** an FT/PT metric. FT/PT composition is a separate concern and stays independent — flex capacity is driven purely by **availability, preferred days, 5th-day willingness, PTO, hour caps, certifications, and existing scheduled workload**.

---

## What it answers

Capacity is reported at three **operating tiers**, per day and rolled up for the week:

| Tier | Meaning | Rules layered on the hard constraints |
|------|---------|----------------------------------------|
| 🟢 **Comfortable** | Sustainable, retention-friendly. | Preferred day · not a 5th day · no pattern disruption |
| 🟡 **Stretch** | Temporary volume absorption (Prime Week, spikes). | Non-preferred days OK · 5th day only for **volunteers** |
| 🔴 **Maximum** | Theoretical ceiling, emergency only — **not sustainable**. | Hard constraints only; ignores comfort/retention |

**Hard constraints** (enforced at every tier): active · available that day · not on PTO · within the weekly hour cap · within the max-days cap · holds the cert the route type requires.

The tiers are **monotonic** (`comfortable ⊆ stretch ⊆ maximum`), so capacity numbers never invert.

---

## Architecture

```
flex-capacity/
  src/
    types.ts      // domain interfaces (FlexDriver, FlexRouteDay, FlexResult, …)
    helpers.ts    // hard-constraint + per-tier eligibility predicates (pure)
    engine.ts     // computeFlexCapacity(): daily + weekly + KPI calc
    whatif.ts     // runWhatIf(): non-mutating scenario simulation
    adapter.ts    // buildFlexInput(): live Supabase rows → engine input
    index.ts      // public surface
  test/           // node --test --experimental-strip-types
supabase/
  functions/flex-capacity/index.ts        // edge function (auth + load + run)
  migrations/0336_flex_capacity_snapshots.sql  // optional result cache
```

**Design principles**

- **Pure core.** `engine.ts` / `whatif.ts` have no I/O, no randomness, no mutation. Same code runs in a Supabase Edge Function today and on a Fly.io worker tomorrow (see below) with zero changes.
- **One source of truth for data shapes.** Only `adapter.ts` knows real table/column names. Swapping the data source means rewriting one file.
- **Simulations never touch live data.** `applyScenario()` deep-clones the input and applies temporary overrides only.

---

## Calculation (exactly as specified)

Per day:

```
requiredRoutes        = routeTarget[day]
comfortableFlexRoutes = max(0, comfortableDrivers − requiredRoutes)
stretchFlexRoutes     = max(0, stretchDrivers    − requiredRoutes)
maximumFlexRoutes     = max(0, maximumDrivers    − requiredRoutes)   // never negative
```

Per week:

```
weeklyComfortableFlex          = Σ comfortableDrivers − Σ requiredRoutes
weeklyComfortableRouteIncrease = weeklyComfortableFlex / 7           // driver-days → routes/day
```

KPI headline (peak day as the "current" baseline):

```
comfortableCapacity = currentRoutes + round(weeklyComfortableRouteIncrease)
```

### Coaching

| Status | Condition (vs. projected daily growth) | Message |
|--------|----------------------------------------|---------|
| 🟢 green  | growth ≤ comfortable increase | Absorb with preferred schedules / normal patterns. |
| 🟡 yellow | growth ≤ stretch increase     | Absorb via flexibility, non-preferred days, voluntary 5th days. |
| 🔴 red    | growth > stretch increase     | Insufficient capacity — plan to hire. |

---

## Usage

```ts
import { buildFlexInput, computeFlexCapacity, runWhatIf } from "@routeready/flex-capacity";

const input = buildFlexInput({
  weekStart, driverRows, timeOffRows, shiftRows, demandRows, settings,
});

const flex = computeFlexCapacity(input, /* growthRoutesPerDay */ 0);
// → flex.kpi.comfortableRoutesAvailable, flex.days[], flex.weekly

// What-If — Prime Week with +6 routes/day and two callouts:
const sim = runWhatIf(input, {
  kind: "prime_week",
  routeMultiplier: 1.0,
  addRoutesPerDay: 6,
  calloutDriverDays: [{ driverId: "abc", days: ["mon", "tue"] }],
});
// → sim.canCover, sim.status, sim.driversNeeded, sim.recommendedFtHires, …
```

### What-If scenarios

`route_growth` · `prime_week` · `peak_planning` · `hiring_plan` · `pto_event` · `callout_event` · `driver_attrition` · `certification_loss` · `attendance_risk` — all expressed as additive overrides on `Scenario` and applied non-destructively.

Outputs: `canCover`, `status` (green/yellow/red/**critical**), daily & weekly shortages, comfortable/stretch/maximum remaining, `driversNeeded`, recommended FT/PT hires (85% FT split — composition only), OT risk, schedule-disruption risk, and a 0–100 confidence score.

---

## Supabase integration

The edge function (`supabase/functions/flex-capacity`) follows the repo's standard pattern: `JWT → app_users → role gate (dispatcher/ops/owner)`, then loads the DSP-week with the service-role client and runs the pure engine.

Data sources (mapped in `adapter.ts`):

| Engine field | Source |
|---|---|
| `available` / `preferred` / `fifthDayOptIn` | `drivers.metadata.availability.{days,preferred_days,fifth_day_ok}` |
| `certifications` | `drivers.{dot_certified,xl_certified,edv_certified}` |
| `pto` | `time_off_requests` (status `approved`), expanded per day |
| `scheduledDays` / `scheduledHours` | assigned non-training `shifts` for the week |
| `routeTarget` | `okami_demand.target_routes` (cushion applied) |
| `blockHours` / `maxDaysPerWeek` / cushion | `scheduling_settings` |

### Schema suggestion (optional)

`migrations/0336_flex_capacity_snapshots.sql` adds `public.flex_capacity_snapshots` — a per-DSP-week cache of the latest `FlexResult` (denormalized headline columns + full `result` JSON) with same-DSP RLS for reads. Writes go through the edge function (service role). Use it to render the KPI without recomputing, and to chart capacity trends.

---

## Fly.io migration strategy

The core is intentionally portable. Today everything runs inline in the edge function (sub-millisecond for typical DSP sizes). When heavier workloads arrive — **Monte Carlo callout simulations, attrition forecasting, multi-week peak planning** — move *only the compute*, not the model:

1. **Stand up a Fly.io worker** (`rr-flex-sim`) exposing `POST /simulate`, importing the unchanged `flex-capacity/src` engine (it has zero Node/Deno-specific deps).
2. **Keep the edge function as the gateway** — same auth + row loading. For light requests it runs the engine inline; for `scenario.kind` flagged heavy (e.g. `monte_carlo`, large `iterations`), it forwards the already-shaped `FlexInput` to the worker over a shared-secret bearer token — exactly the pattern `dispatch-optimization-run` already uses for the CP-SAT solver (`RR_SOLVER_URL` / `RR_SOLVER_TOKEN`).
3. **No model fork.** The browser, the edge function, and the Fly.io worker all import the same `computeFlexCapacity` / `runWhatIf`, so results are identical regardless of where they run.

---

## Future enhancements (architecture is ready for)

The optional `attendanceScore` / `performanceScore` / `seniorityRank` / `affinity` driver signals and the `Scenario` surface are placeholders for: attendance/callout-probability models, route-growth & peak forecasting, hiring & attrition forecasting, driver-burnout modeling, and Monte Carlo simulation (Fly.io). Each plugs into the existing tier predicates without changing the public API.

---

## Develop

```bash
cd flex-capacity
npm test        # node --test --experimental-strip-types
npm run typecheck   # tsc (after `npm i`)
```
