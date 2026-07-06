#!/usr/bin/env node
// Tests for the Goal Seek solver, including end-to-end through a real sheet recalc.
//   node scripts/test-goalseek.mjs
import assert from "node:assert/strict";
import { __engine } from "../dashboard/workbook.js";
const { solveGoalSeek, recalcSheet, parseCellRef } = __engine;

let n = 0;
const ok = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`✗ ${name}`); console.error("  " + (e && e.message)); process.exit(1); } };
const near = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

// ── pure solver ──────────────────────────────────────────────────────────────
ok("linear exact", () => near(solveGoalSeek((x) => 2 * x + 3, 13, 0), 5));
ok("linear from far start", () => near(solveGoalSeek((x) => 40 * 15 * x, 6000, 1), 10)); // weekly hrs
ok("quadratic positive root", () => near(solveGoalSeek((x) => x * x, 16, 1), 4));
ok("nonlinear compound growth", () => near(solveGoalSeek((x) => 1000 * Math.pow(1 + x, 5), 1610.51, 0.05), 0.1, 1e-3));
ok("already at goal", () => near(solveGoalSeek((x) => x, 7, 7), 7));
ok("no solution → null", () => assert.equal(solveGoalSeek((x) => x * x + 1, -5, 1), null));

// ── end-to-end through a live sheet recalc ───────────────────────────────────
// Model: A1 = hours (input), B1 = =A1*15*40 (weekly gross). Seek gross = 12000.
ok("goal seek through recalc", () => {
  const cells = new Map();
  const put = (ref, v, isF) => { const rc = parseCellRef(ref); cells.set(rc.row + "," + rc.col, { value: isF ? null : String(v), formula: isF ? v : null, type: isF ? null : "number", computed: null, err: null, format: {} }); };
  put("A1", "1"); put("B1", "=A1*15*40", true);
  const sheet = { id: "s", blockId: null, name: "S", rowCount: 50, colCount: 26, cells, spill: new Map() };
  recalcSheet(sheet);
  const inputKey = "0,0", targetKey = "0,0".replace("0,0", "0,1");
  const probe = (x) => {
    sheet.cells.get(inputKey).value = String(x);
    recalcSheet(sheet, [inputKey]);
    return sheet.cells.get("0,1").computed;
  };
  const x0 = Number(sheet.cells.get(inputKey).value);
  const sol = solveGoalSeek(probe, 12000, x0);
  near(sol, 20); // 20 hrs * 15 * 40 = 12000
  // and the sheet ends at the solved state
  probe(sol);
  near(sheet.cells.get("0,1").computed, 12000, 1e-2);
});

console.log(`✓ goal seek: ${n} tests passed`);
