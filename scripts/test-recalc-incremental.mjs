#!/usr/bin/env node
// Equivalence tests for the incremental (dirty-cone) recalc path.
//
// For each scenario we build a sheet, full-recalc it, apply an edit and run the
// INCREMENTAL path (recalcSheet with dirty keys), then build the same post-edit
// sheet from scratch and FULL-recalc it. The two must agree cell-for-cell — the
// fast path is only correct if it is indistinguishable from a full recompute.
//
//   node scripts/test-recalc-incremental.mjs

import assert from "node:assert/strict";
import { __engine } from "../dashboard/workbook.js";

const { recalcSheet, parseCellRef } = __engine;

let n = 0;
function ok(name, fn) {
  try { fn(); n++; }
  catch (e) { console.error(`✗ ${name}`); console.error("  " + (e && e.message)); process.exit(1); }
}

// spec: { "A1": "5", "A2": "=A1+1", ... }  ('=' prefix ⇒ formula)
function mkSheet(spec) {
  const cells = new Map();
  for (const [ref, raw] of Object.entries(spec)) {
    const { row, col } = parseCellRef(ref);
    const isF = typeof raw === "string" && raw.startsWith("=");
    cells.set(row + "," + col, {
      value: isF ? null : String(raw),
      formula: isF ? raw : null,
      type: isF ? null : (isFinite(Number(raw)) ? "number" : "text"),
      computed: null, err: null, format: {},
    });
  }
  return { id: "s1", blockId: null, name: "S", rowCount: 200, colCount: 26, cells, spill: new Map() };
}

// snapshot of every cell's observable result (computed value, error, spill)
function snap(sheet) {
  const out = {};
  for (const [k, c] of sheet.cells) out[k] = { v: c.formula ? c.computed : c.value, e: c.err || null };
  if (sheet.spill) for (const [k, sp] of sheet.spill) out["spill:" + k] = sp.value;
  return out;
}

// Apply an edit to a live sheet's cell map (mirrors setCells' cell replacement).
function edit(sheet, ref, raw) {
  const { row, col } = parseCellRef(ref);
  const key = row + "," + col;
  if (raw == null) { sheet.cells.delete(key); return [key]; }
  const isF = typeof raw === "string" && raw.startsWith("=");
  sheet.cells.set(key, {
    value: isF ? null : String(raw), formula: isF ? raw : null,
    type: isF ? null : (isFinite(Number(raw)) ? "number" : "text"),
    computed: null, err: null, format: {},
  });
  return [key];
}

// Core check: incremental(edit) === full(post-edit spec)
function equiv(name, spec, ref, raw) {
  ok(name, () => {
    const inc = mkSheet(spec);
    recalcSheet(inc);                     // establish baseline
    const keys = edit(inc, ref, raw);
    recalcSheet(inc, keys);               // INCREMENTAL path

    const post = { ...spec };
    if (raw == null) delete post[ref]; else post[ref] = raw;
    const full = mkSheet(post);
    recalcSheet(full);                    // FULL from scratch

    assert.deepEqual(snap(inc), snap(full));
  });
}

// 1. simple chain — editing the root updates the whole chain
equiv("chain: edit constant root", { A1: "5", A2: "=A1+1", A3: "=A2*2" }, "A1", "10");
// 2. range aggregate
equiv("range SUM updates on member edit", { A1: "1", A2: "2", A3: "3", B1: "=SUM(A1:A3)" }, "A2", "20");
// 3. sibling cell that does NOT depend on the edit must keep its value
equiv("independent cell unaffected", { A1: "5", A2: "=A1+1", D1: "=99", D2: "=D1+1" }, "A1", "7");
// 4. edit a formula into a different formula
equiv("formula cell rewritten", { A1: "5", A2: "=A1+1", A3: "=A2*2" }, "A2", "=A1*10");
// 5. formula cell turned into a constant — dependents recompute
equiv("formula → constant", { A1: "5", A2: "=A1+1", A3: "=A2*2" }, "A2", "100");
// 6. deleting a cell that others reference
equiv("delete referenced cell", { A1: "5", A2: "=A1+1" }, "A1", null);
// 7. edit introduces a cycle
equiv("edit creates a cycle", { A1: "1", B1: "=A1", C1: "=B1" }, "A1", "=C1");
// 8. edit breaks an existing cycle
equiv("edit breaks a cycle", { A1: "=B1", B1: "=A1", C1: "=A1+1" }, "A1", "5");
// 9. deep chain (well within stack limits)
(() => {
  const spec = { A1: "1" };
  for (let i = 2; i <= 60; i++) spec["A" + i] = `=A${i - 1}+1`;
  equiv("deep 60-cell chain", spec, "A1", "100");
})();
// 10. multi-hop diamond dependency
equiv("diamond deps", { A1: "2", B1: "=A1*3", C1: "=A1+1", D1: "=B1+C1" }, "A1", "5");
// 11. string + text formula path
equiv("text concat updates", { A1: "hi", B1: '=A1&" there"' }, "A1", "yo");

// ── fallback safety: array/spill and dynamic refs must match full recompute ──
// 12. an array formula present ⇒ cone path bails to full; spill stays correct
equiv("array/spill forces full recompute", { A1: "1", B1: "=SEQUENCE(3)", C1: "=A1+1" }, "A1", "9");
// 13. dynamic ref (INDIRECT) ⇒ cone path bails to full
equiv("dynamic INDIRECT forces full recompute", { A1: "7", A2: "=A1", B1: '=INDIRECT("A1")' }, "A1", "42");
// 14. editing the cell an array formula spills near
equiv("array origin edited", { B1: "=SEQUENCE({n})".replace("{n}", "3"), A1: "5" }, "B1", "=SEQUENCE(4)");
// 15. OFFSET is a dynamic ref ⇒ cone path must bail; editing a cell the OFFSET
//     resolves to still updates its dependent (only the full path sees it).
equiv("dynamic OFFSET forces full recompute", { A1: "1", A2: "2", A3: "9", B1: "=OFFSET(A1,2,0)", C1: "=B1+1" }, "A3", "50");
// 16. INDIRECT target edited by name — the value the pointer resolves to changes
equiv("INDIRECT target edited", { A1: "5", B1: "A1", C1: "=INDIRECT(B1)", D1: "=C1*2" }, "A1", "11");
// 17. edit turns a plain formula INTO a dynamic-ref formula (bail must kick in)
equiv("edit introduces INDIRECT", { A1: "3", A2: "=A1+1", B1: "=A2*2" }, "A2", '=INDIRECT("A1")+100');

console.log(`✓ incremental recalc equivalence: ${n} scenarios matched full recompute`);
