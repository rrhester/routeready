// TS-side conformance dump (plan item #4). Runs the REAL in-browser
// engine (engine/src) on every (driver, shift) fixture pair as a 1×1
// solve — eligibility manifests as assigned vs uncovered-with-reason —
// and prints one verdict per pair as JSON on stdout.
//
// Run: node --experimental-strip-types tests/conformance/ts-dump.ts
//
// Settings pin the shared static-gate surface: stateful rules (max
// days, weekly cap, rest, WOC) are off — the Python side's per-pair
// gate doesn't model them (they're global CP-SAT constraints there).
import { readFileSync } from "node:fs";
import { runEngine } from "../../engine/src/index.ts";
import type { EngineInput } from "../../engine/src/types.ts";

const fx = JSON.parse(
  readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"),
);

function availability(dows: number[] | null) {
  if (dows === null || dows === undefined) return null;
  const av: Record<string, { start: string; end: string }[]> = {};
  for (const d of dows) av[String(d)] = [{ start: "00:00", end: "48:00" }];
  return av;
}

const verdicts: Record<string, { eligible: boolean; rule: string | null }> = {};

for (const d of fx.drivers) {
  for (const s of fx.shifts) {
    const input: EngineInput = {
      schedule_week_start: fx.week_start,
      shifts: [{
        shift_id: s.id,
        date: s.date,
        start_time: `${s.date}T09:00`,
        route_type: s.route_type,
      }],
      drivers: [{
        driver_id: d.id,
        first_name: d.id,
        last_name: d.id,
        status: d.status,
        employment_type: "full_time",
        hire_date: "2020-01-01",
        license_expiration_date: d.dl_expires_on ?? null,
        dot_certified: d.dot_certified === true,
        xl_certified: d.xl_certified === true,
        edv_certified: d.edv_certified === true,
        saved_availability: availability(d.available_dows),
        pto_records: (d.pto ?? []).map((date: string) => ({ date })),
      }],
      settings: {
        eligible_driver_status: fx.eligible_driver_status,
        license_enforcement: true,
        license_protection_days: 0,
        certification_enforcement: true,
        pto_protection: true,
        availability_enforcement: true,
        availability_required: false,
        max_days_enforcement: false,
        weekly_hour_cap_enforcement: false,
        min_rest_enforcement: false,
        woc_enforcement: false,
        same_day_multi_shift: "block",
      },
    };
    const r = runEngine(input);
    const eligible = r.assigned_shifts.length === 1;
    const rule = eligible
      ? null
      : (r.uncovered_shifts[0]?.top_block_reasons?.[0]?.rule ?? "NO_REASON");
    verdicts[`${d.id}|${s.id}`] = { eligible, rule };
  }
}

process.stdout.write(JSON.stringify(verdicts, null, 2) + "\n");
