#!/usr/bin/env node
// Tests for version-history snapshot serialize/restore round-trip.
//   node scripts/test-snapshot.mjs
import assert from "node:assert/strict";
import { __engine } from "../dashboard/workbook.js";
const { snapshotSheet, applySheetSnapshot, recalcSheet, parseCellRef } = __engine;

let n = 0;
const ok = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`✗ ${name}`); console.error("  " + (e && e.message)); process.exit(1); } };

function mkSheet() {
  const cells = new Map();
  const put = (ref, v, isF, fmt) => { const rc = parseCellRef(ref); cells.set(rc.row + "," + rc.col, { value: isF ? null : String(v), formula: isF ? v : null, type: isF ? null : (isFinite(Number(v)) ? "number" : "text"), computed: null, err: null, format: fmt || {} }); };
  put("A1", "Region"); put("B1", "Amount", false, { bold: true });
  put("A2", "East"); put("B2", 100);
  put("A3", "West"); put("B3", 250);
  put("C1", "=SUM(B2:B3)", true);
  return { id: "s", blockId: null, name: "Sheet1", position: 0, rowCount: 200, colCount: 26, frozenRows: 1, frozenCols: 0, colWidths: { 0: 140 }, rowHeights: {}, meta: { tables: [{ name: "T", r0: 0, c0: 0, r1: 2, c1: 1 }] }, hiddenRows: new Set([5]), hiddenCols: new Set(), cells, spill: new Map() };
}

const snapKeys = (s) => [...s.cells.entries()].map(([k, c]) => [k, c.value, c.formula, c.type, JSON.stringify(c.format)]).sort();

ok("snapshot → apply is a faithful round-trip", () => {
  const sheet = mkSheet();
  recalcSheet(sheet);
  const before = snapKeys(sheet);
  const snap = JSON.parse(JSON.stringify(snapshotSheet(sheet))); // survives a JSON trip (as it would in the DB)
  // mutate the sheet destructively
  sheet.cells.clear(); sheet.frozenRows = 0; sheet.colWidths = {}; sheet.meta = {}; sheet.hiddenRows = new Set();
  // restore
  applySheetSnapshot(sheet, snap);
  assert.deepEqual(snapKeys(sheet), before, "cells restored");
  assert.equal(sheet.frozenRows, 1, "frozen restored");
  assert.deepEqual(sheet.colWidths, { 0: 140 }, "widths restored");
  assert.deepEqual(sheet.meta.tables, [{ name: "T", r0: 0, c0: 0, r1: 2, c1: 1 }], "meta.tables restored");
  assert.deepEqual([...sheet.hiddenRows], [5], "hidden rows restored");
});

ok("restored formulas recompute correctly", () => {
  const sheet = mkSheet();
  const snap = JSON.parse(JSON.stringify(snapshotSheet(sheet)));
  sheet.cells.clear();
  applySheetSnapshot(sheet, snap);
  recalcSheet(sheet);
  assert.equal(sheet.cells.get("0,2").computed, 350); // C1 = SUM(B2:B3)
});

ok("format is preserved", () => {
  const sheet = mkSheet();
  const snap = JSON.parse(JSON.stringify(snapshotSheet(sheet)));
  sheet.cells.clear();
  applySheetSnapshot(sheet, snap);
  assert.deepEqual(sheet.cells.get("0,1").format, { bold: true });
});

ok("empty cells stay empty (no phantom cells)", () => {
  const sheet = mkSheet();
  const snap = snapshotSheet(sheet);
  assert.ok(!snap.cells.some((c) => c.r === 9 && c.c === 9), "no cell at Z9");
});

console.log(`✓ version-history snapshots: ${n} tests passed`);
