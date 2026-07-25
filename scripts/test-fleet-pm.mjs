// Tests for dashboard/fleet-pm-core.mjs — the PM due engine. The same
// logic lives in SQL (fleet_pm_board, migration 0537); these cases pin
// the JS half of that contract.
import assert from "node:assert/strict";
import { pmDueState, worstPmStatus, addMonthsIso, diffDaysIso } from "../dashboard/fleet-pm-core.mjs";

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log("  ✓ " + name); };

console.log("addMonthsIso · Postgres month semantics");
t("plain month add", () => {
  assert.equal(addMonthsIso("2026-03-15", 6), "2026-09-15");
});
t("clamps to end of shorter month (Jan 31 + 1mo = Feb 28)", () => {
  assert.equal(addMonthsIso("2026-01-31", 1), "2026-02-28");
});
t("leap-year Feb 29 target", () => {
  assert.equal(addMonthsIso("2028-01-31", 1), "2028-02-29");
});
t("crosses year boundary", () => {
  assert.equal(addMonthsIso("2026-11-10", 3), "2027-02-10");
});

console.log("diffDaysIso");
t("forward span", () => assert.equal(diffDaysIso("2026-07-01", "2026-07-25"), 24));
t("negative span", () => assert.equal(diffDaysIso("2026-07-25", "2026-07-01"), -24));

console.log("pmDueState · baselines");
t("never completed → no_baseline", () => {
  const r = pmDueState({ intervalMonths: 6, today: "2026-07-25" });
  assert.equal(r.status, "no_baseline");
  assert.equal(r.dueOn, null);
});
t("miles-only rule with no odometer at completion → no_baseline", () => {
  const r = pmDueState({
    lastDoneOn: "2026-05-01", lastDoneMiles: null,
    intervalMiles: 6000, today: "2026-07-25", currentMiles: 42000,
  });
  assert.equal(r.status, "no_baseline");
});

console.log("pmDueState · date axis");
t("well inside the interval → ok", () => {
  const r = pmDueState({ lastDoneOn: "2026-07-01", intervalMonths: 6, today: "2026-07-25" });
  assert.equal(r.status, "ok");
  assert.equal(r.dueOn, "2027-01-01");
  assert.equal(r.daysRemaining, 160);
});
t("inside the warn window → due_soon", () => {
  const r = pmDueState({ lastDoneOn: "2026-01-20", intervalMonths: 6, warnDays: 14, today: "2026-07-10" });
  assert.equal(r.status, "due_soon"); // due 2026-07-20, 10 days out
  assert.equal(r.daysRemaining, 10);
});
t("due day itself is due_soon, not overdue (SQL: today > due)", () => {
  const r = pmDueState({ lastDoneOn: "2026-01-25", intervalMonths: 6, today: "2026-07-25" });
  assert.equal(r.status, "due_soon");
  assert.equal(r.daysRemaining, 0);
});
t("past due → overdue", () => {
  const r = pmDueState({ lastDoneOn: "2025-12-01", intervalMonths: 6, today: "2026-07-25" });
  assert.equal(r.status, "overdue");
  assert.equal(r.daysRemaining, -54);
});

console.log("pmDueState · mileage axis");
t("far from due mileage → ok", () => {
  const r = pmDueState({
    lastDoneOn: "2026-06-01", lastDoneMiles: 40000, intervalMiles: 6000,
    warnMiles: 500, today: "2026-07-25", currentMiles: 42000,
  });
  assert.equal(r.status, "ok");
  assert.equal(r.dueMiles, 46000);
  assert.equal(r.milesRemaining, 4000);
});
t("inside warn miles → due_soon", () => {
  const r = pmDueState({
    lastDoneOn: "2026-06-01", lastDoneMiles: 40000, intervalMiles: 6000,
    warnMiles: 500, today: "2026-07-25", currentMiles: 45600,
  });
  assert.equal(r.status, "due_soon");
});
t("past due mileage → overdue", () => {
  const r = pmDueState({
    lastDoneOn: "2026-06-01", lastDoneMiles: 40000, intervalMiles: 6000,
    today: "2026-07-25", currentMiles: 46200,
  });
  assert.equal(r.status, "overdue");
  assert.equal(r.milesRemaining, -200);
});
t("unknown current odometer → mileage axis silent, date axis governs", () => {
  const r = pmDueState({
    lastDoneOn: "2026-06-01", lastDoneMiles: 40000, intervalMiles: 6000,
    intervalMonths: 6, today: "2026-07-25", currentMiles: null,
  });
  assert.equal(r.status, "ok");
  assert.equal(r.milesRemaining, null);
});

console.log("pmDueState · dual axis (worse wins)");
t("date ok but miles overdue → overdue", () => {
  const r = pmDueState({
    lastDoneOn: "2026-07-01", lastDoneMiles: 40000,
    intervalMonths: 6, intervalMiles: 6000,
    today: "2026-07-25", currentMiles: 47000,
  });
  assert.equal(r.status, "overdue");
});
t("miles ok but date due_soon → due_soon", () => {
  const r = pmDueState({
    lastDoneOn: "2026-01-20", lastDoneMiles: 40000,
    intervalMonths: 6, intervalMiles: 6000, warnDays: 14,
    today: "2026-07-10", currentMiles: 41000,
  });
  assert.equal(r.status, "due_soon");
});

console.log("worstPmStatus");
t("overdue beats everything", () => {
  assert.equal(worstPmStatus(["ok", "due_soon", "overdue", "no_baseline"]), "overdue");
});
t("no_baseline beats ok", () => {
  assert.equal(worstPmStatus(["ok", "no_baseline"]), "no_baseline");
});
t("empty → null", () => {
  assert.equal(worstPmStatus([]), null);
});

console.log(`\nfleet-pm-core: ${pass} tests passed`);
