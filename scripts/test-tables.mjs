#!/usr/bin/env node
// Tests for Excel-style Tables / structured references.
//   node scripts/test-tables.mjs
import assert from "node:assert/strict";
import { __engine } from "../dashboard/workbook.js";
const { evalFormula, parseFormula, parseCellRef, recalcSheet } = __engine;

let n = 0;
const ok = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`✗ ${name}`); console.error("  " + (e && e.message)); process.exit(1); } };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !~ ${b}`);

// A sheet: row 0 = headers, rows 1..3 = data.
//   A: Region   B: Reps   C: Amount
const grid = {
  "0,0": "Region", "0,1": "Reps", "0,2": "Amount",
  "1,0": "East", "1,1": 3, "1,2": 100,
  "2,0": "West", "2,1": 5, "2,2": 250,
  "3,0": "East", "3,1": 2, "3,2": 50,
};
const cells = new Map();
for (const [k, v] of Object.entries(grid)) { const [r, c] = k.split(","); cells.set(+r + "," + +c, v); }
const tables = new Map([["SALES", {
  name: "Sales", r0: 0, c0: 0, r1: 3, c1: 2, totalRow: false,
  cols: new Map([["REGION", 0], ["REPS", 1], ["AMOUNT", 2]]),
}]]);
const ctx = (cur) => ({ rowCount: 100, colCount: 26, tables, cur, getCell: (r, c) => (cells.has(r + "," + c) ? cells.get(r + "," + c) : null) });
const ev = (src, cur) => evalFormula(src, ctx(cur));

// ── parsing ──────────────────────────────────────────────────────────────────
ok("parses Table[Col] to a tref node", () => {
  const ast = parseFormula("=Sales[Amount]");
  assert.equal(ast.k, "tref"); assert.equal(ast.table, "Sales"); assert.equal(ast.column, "Amount"); assert.equal(ast.section, "data");
});
ok("parses [@Col] to an implicit this-row tref", () => {
  const ast = parseFormula("=[@Amount]");
  assert.equal(ast.k, "tref"); assert.equal(ast.table, null); assert.equal(ast.section, "thisrow"); assert.equal(ast.column, "Amount");
});
ok("parses [[#Data],[Col]]", () => {
  const ast = parseFormula("=Sales[[#Data],[Amount]]");
  assert.equal(ast.section, "data"); assert.equal(ast.column, "Amount");
});

// ── evaluation ───────────────────────────────────────────────────────────────
ok("SUM over a table column", () => near(ev("=SUM(Sales[Amount])"), 400));
ok("AVERAGE over a table column", () => near(ev("=AVERAGE(Sales[Amount])"), 400 / 3));
ok("COUNTA over a text column", () => assert.equal(ev("=COUNTA(Sales[Region])"), 3));
ok("MAX over #Data,[Col]", () => near(ev("=MAX(Sales[[#Data],[Amount]])"), 250));
ok("SUMIF across two table columns", () => near(ev('=SUMIF(Sales[Region],"East",Sales[Amount])'), 150));
ok("header cell via #Headers", () => assert.equal(ev("=Sales[[#Headers],[Amount]]"), "Amount"));
ok("whole table #All is a grid (top-left = header)", () => assert.equal(ev("=INDEX(Sales[#All],1,1)"), "Region"));

// ── this-row (implicit) refs need ctx.cur ────────────────────────────────────
ok("[@Col] resolves to the current row's cell", () => assert.equal(ev("=[@Amount]", { r: 2, c: 0 }), 250));
ok("arithmetic across [@a]*[@b]", () => near(ev("=[@Reps]*[@Amount]", { r: 1, c: 0 }), 300));
ok("explicit table [@] also works", () => near(ev("=Sales[@Amount]", { r: 3, c: 0 }), 50));

// ── errors ───────────────────────────────────────────────────────────────────
const evErr = (src, cur) => { try { ev(src, cur); } catch (e) { return e.code; } return null; };
ok("unknown table → #REF", () => assert.equal(evErr("=SUM(Nope[Amount])"), "#REF"));
ok("unknown column → #REF", () => assert.equal(evErr("=SUM(Sales[Nope])"), "#REF"));
ok("[@] with no current table → #REF", () => assert.equal(evErr("=[@Amount]", { r: 50, c: 20 }), "#REF"));

// ── end-to-end through recalcSheet (real registry build + bind + recalc) ─────
ok("recalcSheet resolves structured refs from meta.tables", () => {
  const c = new Map();
  const put = (ref, v, isF) => { const rc = parseCellRef(ref); c.set(rc.row + "," + rc.col, { value: isF ? null : String(v), formula: isF ? v : null, type: isF ? null : (isFinite(Number(v)) ? "number" : "text"), computed: null, err: null, format: {} }); };
  put("A1", "Region"); put("B1", "Amount");
  put("A2", "East", false); put("B2", 100);
  put("A3", "West", false); put("B3", 250);
  put("D1", "=SUM(Sales[Amount])", true);
  put("D2", "=SUMIF(Sales[Region],\"East\",Sales[Amount])", true);
  const sheet = { id: "s", blockId: null, name: "S", rowCount: 50, colCount: 26, cells: c, spill: new Map(), meta: { tables: [{ name: "Sales", r0: 0, c0: 0, r1: 2, c1: 1 }] } };
  recalcSheet(sheet);
  near(sheet.cells.get("0,3").computed, 350);
  near(sheet.cells.get("1,3").computed, 100);
});

console.log(`✓ tables / structured refs: ${n} tests passed`);
