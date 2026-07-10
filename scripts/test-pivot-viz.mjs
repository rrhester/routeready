#!/usr/bin/env node
// Tests for pivot "show values as" modes + Top-N, and chart moving-average /
// target-line rendering.  node scripts/test-pivot-viz.mjs
import assert from "node:assert/strict";
import { __engine } from "../dashboard/workbook.js";
const { computePivot, pivotTableHtml, chartSvg, pivotEffectiveSpec, pivotDrillRecords, pivotChartSvg } = __engine;

let n = 0;
const ok = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`✗ ${name}`); console.error("  " + (e && e.message)); process.exit(1); } };

// Build a sheet the way workbook.js expects: cells Map keyed "r,c" → cell obj,
// header row 0.  Region / Amount, four rows.
function sheetFrom(rows) {
  const cells = new Map();
  rows.forEach((row, r) => row.forEach((v, c) => cells.set(r + "," + c, { value: v, type: typeof v === "number" ? "number" : "text" })));
  return { rowCount: rows.length, colCount: rows[0].length, cells, meta: {} };
}

const sheet = sheetFrom([
  ["Region", "Amount"],
  ["East", 100],
  ["West", 250],
  ["South", 50],
  ["North", 100],
]);
// spec covers A1:B5, group by Region, sum Amount.  Grand total = 500.
const baseSpec = { r0: 0, c0: 0, r1: 4, c1: 1, rows: ["Region"], cols: [], values: [{ field: "Amount", agg: "sum" }] };

ok("computePivot groups + totals correctly", () => {
  const p = computePivot(sheet, baseSpec);
  assert.equal(p.rowKeys.length, 4);
  assert.equal(p.aggOf("East", "", 0), 100);
  assert.equal(p.aggOf(null, "", 0), 500); // grand total
});

ok("raw mode renders the aggregate", () => {
  const html = pivotTableHtml(sheet, baseSpec);
  assert.ok(html.includes(">250<"), "expected West's 250 in output");
  assert.ok(html.includes("Grand total"), "expected a grand-total row");
});

ok("% of total mode divides by the column grand total", () => {
  const spec = { ...baseSpec, values: [{ field: "Amount", agg: "sum", show: "pct" }] };
  const html = pivotTableHtml(sheet, spec);
  assert.ok(html.includes("50%"), "West 250/500 should read 50%");
  assert.ok(html.includes("20%"), "East 100/500 should read 20%");
  assert.ok(html.includes("100%"), "grand-total row should read 100%");
});

ok("running total accumulates down the rows", () => {
  const spec = { ...baseSpec, values: [{ field: "Amount", agg: "sum", show: "running" }] };
  const html = pivotTableHtml(sheet, spec);
  // rows sort alphabetically: East(100),North(100),South(50),West(250)
  // running: 100,200,250,500 → final 500 present, and 250 as a running step
  assert.ok(html.includes(">200<"), "running total should reach 200");
  assert.ok(html.includes(">500<"), "running total should reach the grand total 500");
});

ok("rank mode ranks largest = 1", () => {
  const spec = { ...baseSpec, values: [{ field: "Amount", agg: "sum", show: "rank" }] };
  const html = pivotTableHtml(sheet, spec);
  // West=250 is rank 1; South=50 is rank 4
  const rh = html.slice(html.indexOf("<tbody>"));
  assert.ok(rh.includes(">1<"), "top value should rank 1");
  assert.ok(rh.includes(">4<"), "lowest value should rank 4");
});

ok("Top-N keeps only the highest rows", () => {
  const spec = { ...baseSpec, topN: 2 };
  const html = pivotTableHtml(sheet, spec);
  assert.ok(html.includes("East") === false || html.includes("South") === false, "a low row should be dropped");
  assert.ok(html.includes("West"), "West (250) must survive Top-2");
  assert.ok(html.includes("top 2"), "grand-total row should note the Top-2 truncation");
});

// ── charts ───────────────────────────────────────────────────────────────────
const chartSheet = sheetFrom([
  ["Day", "Routes"],
  ["Mon", 10],
  ["Tue", 20],
  ["Wed", 12],
  ["Thu", 24],
  ["Fri", 18],
]);
const chartRange = { r0: 0, c0: 0, r1: 5, c1: 1 };

ok("moving average draws a dashed overlay path", () => {
  const ch = { ...chartRange, type: "line", theme: "route", movavg: 3 };
  const { svg } = chartSvg(chartSheet, ch, { W: 480, H: 220 });
  assert.ok(/moving average/i.test(svg), "expected a moving-average <title>");
});

ok("no moving average when window < 2", () => {
  const ch = { ...chartRange, type: "line", theme: "route", movavg: 0 };
  const { svg } = chartSvg(chartSheet, ch, { W: 480, H: 220 });
  assert.ok(!/moving average/i.test(svg), "movavg=0 should draw nothing");
});

ok("target line renders with a label", () => {
  const ch = { ...chartRange, type: "column", theme: "route", target: 15 };
  const { svg } = chartSvg(chartSheet, ch, { W: 480, H: 220 });
  assert.ok(/Target/.test(svg), "expected a Target label on the reference line");
});

ok("charts without target/movavg still render normally", () => {
  const ch = { ...chartRange, type: "column", theme: "route" };
  const { svg } = chartSvg(chartSheet, ch, { W: 480, H: 220 });
  assert.ok(svg.includes("<svg"), "chart should still render");
  assert.ok(!/Target/.test(svg), "no stray target label");
});

// ── interactive: drill + collapse + pivot-chart ──────────────────────────────
ok("drill returns the source rows behind a cell", () => {
  const { records } = pivotDrillRecords(sheet, baseSpec, "West", "", false);
  assert.equal(records.length, 1);
  assert.equal(records[0].Amount, 250);
});

const twoLevel = sheetFrom([
  ["Region", "Rep", "Amount"],
  ["East", "Ann", 100],
  ["East", "Bob", 40],
  ["West", "Cy", 250],
]);
const twoSpec = { r0: 0, c0: 0, r1: 3, c1: 2, rows: ["Region", "Rep"], cols: [], values: [{ field: "Amount", agg: "sum" }] };

ok("collapsed spec drops the second row dimension", () => {
  assert.deepEqual(pivotEffectiveSpec({ ...twoSpec, collapsed: true }).rows, ["Region"]);
});

ok("collapsed pivot shows first-level subtotals only", () => {
  const html = pivotTableHtml(twoLevel, { ...twoSpec, collapsed: true });
  assert.ok(html.includes(">140<"), "East should subtotal to 140 when collapsed");
  assert.ok(!html.includes("Ann"), "collapsed view hides the second level");
});

ok("expanded pivot shows the leaf rows", () => {
  const html = pivotTableHtml(twoLevel, twoSpec);
  assert.ok(html.includes("Ann") && html.includes("Bob"), "expanded shows the leaves");
});

ok("drill on a collapsed 2-level cell returns both leaf rows", () => {
  const { records } = pivotDrillRecords(twoLevel, { ...twoSpec, collapsed: true }, "East", "", false);
  assert.equal(records.length, 2);
});

ok("pivot chart renders an svg from pivot output", () => {
  const svg = pivotChartSvg(twoLevel, twoSpec, 520, 260);
  assert.ok(svg.includes("<svg"), "expected a chart svg from the pivot");
});

console.log(`✓ pivot-viz + chart-viz: ${n} checks passed`);
