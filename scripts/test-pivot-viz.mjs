#!/usr/bin/env node
// Tests for pivot "show values as" modes + Top-N, and chart moving-average /
// target-line rendering.  node scripts/test-pivot-viz.mjs
import assert from "node:assert/strict";
import { __engine } from "../dashboard/workbook.js";
const { computePivot, pivotTableHtml, chartSvg, pivotEffectiveSpec, pivotDrillRecords, pivotChartSvg,
  ooxmlChartXml, ooxmlDrawingXml, pivotToExportSheet, buildXlsxBytes, parseXlsxBytes } = __engine;

// Minimal XML well-formedness check (tag balance) — a guard against malformed
// chart/drawing parts that would make Excel refuse to open the file.
function wellFormed(xml) {
  const body = xml.replace(/<\?[^>]*\?>/g, "");
  const re = /<(\/?)([a-zA-Z][\w:.-]*)(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/g;
  const stack = []; let m;
  while ((m = re.exec(body))) {
    if (m[1] === "/") { if (stack.pop() !== m[2]) return false; }
    else if (m[3] !== "/") stack.push(m[2]);
  }
  return stack.length === 0;
}

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

// ── OOXML export: chart parts + pivot values sheet ───────────────────────────
ok("ooxml column chart has barChart + category & value axes + a series", () => {
  const cd = { categories: ["Mon", "Tue"], series: [{ name: "Routes", values: [10, 20] }] };
  const xml = ooxmlChartXml({ type: "column", r0: 0, c0: 0, r1: 2, c1: 1 }, "Ops", cd);
  assert.ok(xml.includes("<c:barChart>") && xml.includes("<c:catAx>") && xml.includes("<c:valAx>"));
  assert.ok(xml.includes("<c:ser>") && xml.includes("<c:numCache>"));
});

ok("ooxml combo emits both a bar and a line chart", () => {
  const cd = { categories: ["Mon", "Tue"], series: [{ name: "Routes", values: [10, 20] }, { name: "Cov", values: [80, 90] }] };
  const xml = ooxmlChartXml({ type: "combo", r0: 0, c0: 0, r1: 2, c1: 2 }, "Ops", cd);
  assert.ok(xml.includes("<c:barChart>") && xml.includes("<c:lineChart>"), "combo needs both plot groups");
});

ok("ooxml pie emits a pieChart with no cartesian axes", () => {
  const cd = { categories: ["East", "West"], series: [{ name: "Routes", values: [22, 20] }] };
  const xml = ooxmlChartXml({ type: "pie", r0: 0, c0: 0, r1: 2, c1: 1 }, "Ops", cd);
  assert.ok(xml.includes("<c:pieChart>") && !xml.includes("<c:valAx>"));
});

ok("ooxml scatter emits a real scatterChart (xVal/yVal), not a line chart", () => {
  const cd = { categories: ["1", "2", "3"], series: [{ name: "Y", values: [10, 20, 30] }] };
  const xml = ooxmlChartXml({ type: "scatter", r0: 0, c0: 0, r1: 3, c1: 1 }, "Ops", cd);
  assert.ok(xml.includes("<c:scatterChart>") && xml.includes("<c:xVal>") && xml.includes("<c:yVal>"));
  assert.ok(!xml.includes("<c:lineChart>"), "scatter must not fall back to a categorical line chart");
});

ok("ooxml single-column scatter is skipped rather than misleading", () => {
  const cd = { categories: ["1", "2"], series: [{ name: "Y", values: [10, 20] }] };
  assert.equal(ooxmlChartXml({ type: "scatter", r0: 0, c0: 0, r1: 2, c1: 0 }, "Ops", cd), null);
});

ok("chart formulas reference the (exported) sheet name passed in", () => {
  const cd = { categories: ["A", "B"], series: [{ name: "S", values: [1, 2] }] };
  const xml = ooxmlChartXml({ type: "column", r0: 0, c0: 0, r1: 2, c1: 1 }, "Renamed Sheet", cd);
  assert.ok(xml.includes("'Renamed Sheet'!"), "series formulas must use the passed export name");
});

ok("ooxml chart + drawing parts are well-formed XML", () => {
  const cd = { categories: ["A", "B"], series: [{ name: "S", values: [1, 2] }] };
  const combo = { categories: ["A", "B"], series: [{ name: "S", values: [1, 2] }, { name: "T", values: [3, 4] }] };
  assert.ok(wellFormed(ooxmlChartXml({ type: "column", r0: 0, c0: 0, r1: 2, c1: 1 }, "Ops", cd)), "column");
  assert.ok(wellFormed(ooxmlChartXml({ type: "line", r0: 0, c0: 0, r1: 2, c1: 1 }, "Ops", cd)), "line");
  assert.ok(wellFormed(ooxmlChartXml({ type: "area", r0: 0, c0: 0, r1: 2, c1: 1 }, "Ops", cd)), "area");
  assert.ok(wellFormed(ooxmlChartXml({ type: "pie", r0: 0, c0: 0, r1: 2, c1: 1 }, "Ops", cd)), "pie");
  assert.ok(wellFormed(ooxmlChartXml({ type: "combo", r0: 0, c0: 0, r1: 2, c1: 2 }, "Ops", combo)), "combo");
  assert.ok(wellFormed(ooxmlChartXml({ type: "scatter", r0: 0, c0: 0, r1: 2, c1: 1 }, "Ops", cd)), "scatter");
  assert.ok(wellFormed(ooxmlDrawingXml([{ fromCol: 3, fromRow: 0, toCol: 11, toRow: 16, relId: "rIdCh1", name: "Chart 1", id: 2 }])), "drawing");
});

ok("pivotToExportSheet materializes the grand total as a cell", () => {
  const syn = pivotToExportSheet(sheet, baseSpec, "By Region", 1);
  assert.ok(syn && syn.rowCount >= 2, "expected a values sheet");
  assert.ok([...syn.cells.values()].some((c) => c.value === 500), "grand total 500 should be a cell");
});

// Async round-trip: a workbook with a chart + a pivot must build a valid .xlsx
// (parseXlsxBytes proves the zip/worksheet are well-formed) and gain a pivot
// values sheet.
const okA = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error(`✗ ${name}`); console.error("  " + (e && e.message)); process.exit(1); } };

await okA("charts + pivots survive the .xlsx round-trip", async () => {
  const src = sheetFrom([
    ["Day", "Routes", "Region"],
    ["Mon", 10, "East"],
    ["Tue", 20, "West"],
    ["Wed", 12, "East"],
  ]);
  src.name = "Ops";
  src.meta = {
    charts: [{ id: "c1", type: "column", theme: "route", r0: 0, c0: 0, r1: 3, c1: 1 }],
    pivots: [{ id: "p1", r0: 0, c0: 0, r1: 3, c1: 2, rows: ["Region"], cols: [], values: [{ field: "Routes", agg: "sum" }], title: "By Region" }],
  };
  const bytes = buildXlsxBytes([src]); // must not throw with chart + pivot present
  const parsed = await parseXlsxBytes(bytes);
  assert.equal(parsed.sheets.length, 2, "original sheet + a pivot values sheet");
  assert.equal(parsed.sheets[1].name, "By Region");
  // East = 10 + 12 = 22 must appear in the pivot values sheet (parse returns numbers as strings)
  assert.ok(parsed.sheets[1].cells.some((c) => Number(c.value) === 22), "East subtotal 22 exported");
  // original data still intact on sheet 1
  assert.ok(parsed.sheets[0].cells.some((c) => c.value === "Mon"));
});

await okA("cross-sheet chart export resolves its source sheet by srcSheetId", async () => {
  const data = sheetFrom([["Day", "Routes"], ["Mon", 10], ["Tue", 20]]);
  data.name = "Data"; data.id = "sD";
  // the chart lives on an empty dashboard sheet but sources "Data"
  const dash = { id: "sX", name: "Dash", rowCount: 1, colCount: 1, cells: new Map(), colWidths: {}, meta: { charts: [{ id: "c9", type: "column", r0: 0, c0: 0, r1: 2, c1: 1, srcSheetId: "sD" }] } };
  const bytes = buildXlsxBytes([dash, data]); // must not throw — reads Data, not the empty Dash grid
  const parsed = await parseXlsxBytes(bytes);
  assert.ok(parsed.sheets.some((s) => s.name === "Data") && parsed.sheets.some((s) => s.name === "Dash"), "both sheets present");
});

console.log(`✓ pivot-viz + chart-viz: ${n} checks passed`);
