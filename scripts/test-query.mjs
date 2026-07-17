#!/usr/bin/env node
// Tests for the QUERY function (Google Sheets query-language subset).
//   node scripts/test-query.mjs
import assert from "node:assert/strict";
import { __engine } from "../dashboard/workbook.js";
const { runQuery, evalFormula, parseCellRef } = __engine;

let n = 0;
const ok = (name, got, want) => { n++; assert.deepEqual(got, want, `${name}\n got ${JSON.stringify(got)}\n want ${JSON.stringify(want)}`); };

// header row (text) + numeric data ⇒ auto-detected as a header
const grid = { width: 3, rows: [
  ["Region", "Reps", "Sales"],
  ["East", 3, 100],
  ["West", 5, 250],
  ["East", 2, 50],
] };
const q = (s, h) => runQuery(grid, s, h);

ok("select all", q("select *"), [["Region", "Reps", "Sales"], ["East", 3, 100], ["West", 5, 250], ["East", 2, 50]]);
ok("select columns", q("select A, C"), [["Region", "Sales"], ["East", 100], ["West", 250], ["East", 50]]);
ok("where numeric", q("select A, C where C > 60"), [["Region", "Sales"], ["East", 100], ["West", 250]]);
ok("where >=", q("select A where B >= 5"), [["Region"], ["West"]]);
ok("where contains", q("select A where A contains 'es'"), [["Region"], ["West"]]);
ok("where starts with", q("select A where A starts with 'Ea'"), [["Region"], ["East"], ["East"]]);
ok("where and", q("select A where C > 40 and B < 3"), [["Region"], ["East"]]);
ok("where or", q("select C where A = 'West' or C = 50"), [["Sales"], [250], [50]]);
ok("order by desc", q("select A order by C desc"), [["Region"], ["West"], ["East"], ["East"]]);
ok("limit", q("select A limit 1"), [["Region"], ["East"]]);
ok("offset", q("select A offset 1"), [["Region"], ["West"], ["East"]]);
ok("aggregate group by", q("select A, sum(C) group by A"), [["Region", "sum Sales"], ["East", 150], ["West", 250]]);
ok("aggregate count", q("select count(A)"), [["count Region"], [3]]);
ok("aggregate avg", q("select avg(C)"), [["avg Sales"], [400 / 3]]);
ok("aggregate max/min", q("select max(C), min(C)"), [["max Sales", "min Sales"], [250, 50]]);

// explicit headers = 0 (no header row) — column labels fall back to A/B/C
const raw = { width: 2, rows: [["a", 10], ["b", 20]] };
ok("headers=0 keeps all rows", runQuery(raw, "select A, B", 0), [["A", "B"], ["a", 10], ["b", 20]]);
ok("headers=0 is null", runQuery({ width: 2, rows: [["a", 1], ["", 2]] }, "select B where A is null", 0), [["B"], [2]]);

// end-to-end through evalFormula
function sheetCtx(cells, rows = 100, cols = 26) {
  const map = new Map();
  for (const [ref, v] of Object.entries(cells || {})) { const rc = parseCellRef(ref); map.set(rc.row + "," + rc.col, v); }
  return { rowCount: rows, colCount: cols, getCell: (r, c) => (map.has(r + "," + c) ? map.get(r + "," + c) : null) };
}
ok("QUERY via evalFormula", (() => {
  const ctx = sheetCtx({ A1: "Region", B1: "Sales", A2: "East", B2: 100, A3: "West", B3: 250 });
  const arr = evalFormula('=QUERY(A1:B3, "select A where B > 150")', ctx);
  return arr.rows;
})(), [["Region"], ["West"]]);

// ── LABEL / FORMAT clauses (100-list #7) — columns are A/B/C ──────────────────
ok("label renames output headers", q("select A, C label A 'Zone', C 'Revenue'"),
  [["Zone", "Revenue"], ["East", 100], ["West", 250], ["East", 50]]);
ok("label on an aggregate", q("select A, sum(C) group by A label sum(C) 'Total'"),
  [["Region", "Total"], ["East", 150], ["West", 250]]);
ok("format applies a number format to a column", q("select A, C format C '$#,##0.00'"),
  [["Region", "Sales"], ["East", "$100.00"], ["West", "$250.00"], ["East", "$50.00"]]);
ok("label + format together", q("select C label C 'Rev' format C '#,##0'"),
  [["Rev"], ["100"], ["250"], ["50"]]);

console.log(`✓ QUERY: ${n} tests passed`);
