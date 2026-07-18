// Tests for dashboard/rr-dates.mjs (project-review PR#9/#15).
import assert from "node:assert/strict";
import { fmtIsoDate, startOfWeek, addDays, isoWeek } from "../dashboard/rr-dates.mjs";

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log("  ✓ " + name); };

console.log("fmtIsoDate · local, not UTC");
t("formats local calendar date", () => {
  assert.equal(fmtIsoDate(new Date(2026, 6, 4, 9, 30)), "2026-07-04"); // Jul 4
});
t("late-evening local stays on the same local day (the bug)", () => {
  // 2026-07-04 23:30 local. The old toISOString().slice(0,10) would roll
  // to 07-05 for any negative UTC offset. Local formatting must not.
  const d = new Date(2026, 6, 4, 23, 30);
  assert.equal(fmtIsoDate(d), "2026-07-04");
});
t("single-digit month/day zero-padded", () => {
  assert.equal(fmtIsoDate(new Date(2026, 0, 5)), "2026-01-05");
});

console.log("startOfWeek · Sunday-anchored, midnight");
t("Wednesday backs up to Sunday", () => {
  const wed = new Date(2026, 6, 8, 15, 0); // Wed Jul 8 2026
  const sow = startOfWeek(wed);
  assert.equal(fmtIsoDate(sow), "2026-07-05"); // Sun Jul 5
  assert.equal(sow.getHours(), 0);
  assert.equal(sow.getMinutes(), 0);
});
t("Sunday maps to itself", () => {
  const sun = new Date(2026, 6, 5, 20, 0);
  assert.equal(fmtIsoDate(startOfWeek(sun)), "2026-07-05");
});

console.log("addDays");
t("adds across month boundary", () => {
  assert.equal(fmtIsoDate(addDays(new Date(2026, 6, 30), 3)), "2026-08-02");
});
t("subtracts with negative n", () => {
  assert.equal(fmtIsoDate(addDays(new Date(2026, 6, 1), -1)), "2026-06-30");
});
t("does not mutate its input", () => {
  const d = new Date(2026, 6, 1);
  addDays(d, 5);
  assert.equal(fmtIsoDate(d), "2026-07-01");
});

console.log("isoWeek");
t("first Thursday rule (2026-01-01 is a Thursday → week 1)", () => {
  assert.equal(isoWeek(new Date(2026, 0, 1)), 1);
});
t("mid-year week", () => {
  assert.equal(isoWeek(new Date(2026, 6, 8)), 28);
});
t("Jan 1 2027 (Friday) belongs to week 53 of 2026", () => {
  assert.equal(isoWeek(new Date(2027, 0, 1)), 53);
});

console.log(`\nrr-dates: ${pass} tests passed`);
