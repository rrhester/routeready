#!/usr/bin/env node
// Validates the "Operations Command Center" workbook template end-to-end:
// materializes its sheets exactly the way createWorkbook does (header on
// row 0, data from row 1), then drives the real formula engine to a
// fixed point with a sheet-name-aware context — the same cross-sheet read
// path the grid uses — and asserts the dashboard math.
//
//   node scripts/test-ops-command-center.mjs

import assert from "node:assert/strict";
import { __engine } from "../dashboard/workbook.js";

const { evalFormula, parseCellRef, FormulaError } = __engine;

const tpl = __engine.WB_TEMPLATES.find((t) => t.key === "ops-command-center");
assert.ok(tpl, "ops-command-center template is registered");
const spec = tpl.build();

// createWorkbook puts every template sheet in one block, so they are
// siblings and cross-sheet refs resolve. Mirror that here.
const sheetSpecs = spec.blocks.filter((b) => b.type === "sheet").flatMap((b) => b.sheets);

const NUM_RE = /^-?\$?\s*-?[\d,]*\.?\d+%?$/;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})$|^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/;
function detectType(raw) {
  const s = String(raw ?? "").trim();
  if (s === "") return null;
  if (/^(true|false)$/i.test(s)) return "boolean";
  if (DATE_RE.test(s)) return "date";
  if (NUM_RE.test(s)) return s.includes("%") ? "percent" : s.includes("$") ? "currency" : "number";
  return "text";
}
function cellNumeric(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return raw;
  const n = Number(String(raw).replace(/[$,%\s]/g, ""));
  return isFinite(n) && String(raw).trim() !== "" ? n : null;
}

// Build the in-memory sheets. Each cell: { formula, value, type, computed, err }.
const sheets = sheetSpecs.map((ss) => {
  const cells = new Map();
  const rowCount = Math.max(200, (ss.rows ? ss.rows.length : 0) + 40);
  const colCount = Math.max(26, ss.cols ? ss.cols.length : 0);
  (ss.cols || []).forEach((label, c) => {
    cells.set(`0,${c}`, { formula: null, value: label, type: "text", computed: label, err: null });
  });
  (ss.rows || []).forEach((r, ri) => {
    r.forEach((v, ci) => {
      if (v === "" || v == null) return;
      const isFormula = typeof v === "string" && v.startsWith("=");
      cells.set(`${ri + 1},${ci}`, {
        formula: isFormula ? v : null,
        value: isFormula ? null : String(v),
        type: isFormula ? "formula" : detectType(String(v)),
        computed: null,
        err: null,
      });
    });
  });
  return { name: ss.name, cells, rowCount, colCount };
});
const byName = new Map(sheets.map((s) => [s.name.trim().toLowerCase(), s]));

// engineValue, faithfully mirrored from workbook.js.
function engineValue(sheet, r, c) {
  const cell = sheet.cells.get(`${r},${c}`);
  if (!cell) return null;
  if (cell.formula) {
    if (cell.err) throw new FormulaError(cell.err, "referenced cell has an error");
    return cell.computed;
  }
  const n = cellNumeric(cell.value);
  if (n != null && cell.type !== "text") {
    if (cell.type === "percent") return n / 100;
    return n;
  }
  if (cell.type === "boolean") return /^true$/i.test(String(cell.value));
  return cell.value;
}
function crossSheetValue(sheetName, r, c) {
  const t = byName.get(String(sheetName).trim().toLowerCase());
  if (!t) throw new FormulaError("#REF", `no sheet named ${sheetName}`);
  if (r < 0 || c < 0 || r >= t.rowCount || c >= t.colCount) throw new FormulaError("#REF", "out of range");
  return engineValue(t, r, c);
}
const ctxFor = (sheet) => ({
  rowCount: sheet.rowCount,
  colCount: sheet.colCount,
  getCell: (r, c, sheetName) => (sheetName ? crossSheetValue(sheetName, r, c) : engineValue(sheet, r, c)),
});

// Iterate all formula cells to a fixed point (cross-sheet deps settle in a
// few passes; the grid uses the same two-pass idea).
const formulaCells = [];
for (const sheet of sheets) for (const [key, cell] of sheet.cells) if (cell.formula) formulaCells.push({ sheet, key, cell });
for (let pass = 0; pass < 8; pass++) {
  for (const { sheet, cell } of formulaCells) {
    cell.err = null;
    try {
      let v = evalFormula(cell.formula, ctxFor(sheet));
      if (v && v.rows) v = v.rows[0][0]; // array result displays top-left
      cell.computed = v;
    } catch (e) {
      if (e instanceof FormulaError) { cell.err = e.code; cell.computed = null; }
      else throw e;
    }
  }
}

// ── assertions ────────────────────────────────────────────────────────────────
const S = (name) => byName.get(name.toLowerCase());
const cellAt = (sheetName, ref) => {
  const rc = parseCellRef(ref);
  const c = S(sheetName).cells.get(`${rc.row},${rc.col}`);
  return c ? (c.err ? c.err : c.computed) : null;
};

let n = 0;
const ok = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`✗ ${name}\n  ${e && e.message}`); process.exit(1); } };

// No cell anywhere resolved to an error.
ok("no formula errors across all six sheets", () => {
  const errs = [];
  for (const sheet of sheets) for (const [key, cell] of sheet.cells) if (cell.err) errs.push(`${sheet.name}!${key}=${cell.err}: ${cell.formula}`);
  assert.equal(errs.length, 0, "errors:\n  " + errs.join("\n  "));
});

// Roster tenure is a positive whole number of months for a past hire date.
ok("Roster tenure math computes", () => {
  const t = cellAt("Roster", "D2");
  assert.ok(typeof t === "number" && t > 0, `tenure was ${t}`);
});

// Coverage: Available is pulled live from the Roster (active + Y that day).
ok("Coverage Available pulls from Roster (Mon=8, Sun=5)", () => {
  assert.equal(cellAt("Coverage", "C2"), 8); // Monday
  assert.equal(cellAt("Coverage", "C8"), 5); // Sunday
});
ok("Coverage totals + gap flags", () => {
  assert.equal(cellAt("Coverage", "B9"), 49); // planned total
  assert.equal(cellAt("Coverage", "D9"), 45); // confirmed total
  assert.equal(cellAt("Coverage", "E9"), 4);  // gap total
  assert.equal(cellAt("Coverage", "G9"), 4);  // bench total
  assert.equal(cellAt("Coverage", "F2"), "Short 1"); // Monday short by 1
  assert.equal(cellAt("Coverage", "F3"), "On plan");  // Tuesday even
});

// Payroll: scheduled days pulled from Roster, OT split at 40h.
ok("Payroll per-driver + totals", () => {
  assert.equal(cellAt("Payroll", "C2"), 5);   // Marcus scheduled days
  assert.equal(cellAt("Payroll", "F2"), 45);  // weekly hours = 5*9
  assert.equal(cellAt("Payroll", "G2"), 40);  // regular capped at 40
  assert.equal(cellAt("Payroll", "H2"), 5);   // overtime
  assert.equal(cellAt("Payroll", "F14"), 504); // total scheduled hours
  assert.equal(cellAt("Payroll", "H14"), 81);  // total OT
  assert.equal(Math.round(cellAt("Payroll", "I14")), 12277); // total gross
});

// Compliance: days-left is numeric, status is one of the three flags.
ok("Compliance days-left + status flags", () => {
  assert.equal(typeof cellAt("Compliance", "C2"), "number");
  assert.ok(["OK", "Renew soon", "EXPIRED", "—"].includes(cellAt("Compliance", "D2")));
  // Sara's license (2025-12-31) is in the past → EXPIRED regardless of today.
  assert.equal(cellAt("Compliance", "D5"), "EXPIRED");
});

// Scorecard: the dashboard reads across every sheet.
ok("Scorecard roster health", () => {
  assert.equal(cellAt("Scorecard", "B3"), 9);  // Active
  assert.equal(cellAt("Scorecard", "B4"), 2);  // Onboarding
  assert.equal(cellAt("Scorecard", "B5"), 1);  // Inactive
  assert.equal(cellAt("Scorecard", "B6"), 12); // Total roster
  assert.ok(cellAt("Scorecard", "B7") > 0);    // Avg tenure
});
ok("Scorecard coverage + labor rollups", () => {
  assert.equal(cellAt("Scorecard", "B9"), 49);   // planned
  assert.equal(cellAt("Scorecard", "B10"), 45);  // confirmed
  assert.equal(cellAt("Scorecard", "B11"), 91.8); // coverage %
  assert.equal(cellAt("Scorecard", "B12"), 4);   // days short
  assert.equal(cellAt("Scorecard", "B13"), 4);   // open gap
  assert.equal(cellAt("Scorecard", "B16"), 504); // scheduled hours
  assert.equal(cellAt("Scorecard", "B17"), 81);  // OT hours
  assert.equal(cellAt("Scorecard", "B19"), 272.83); // avg cost/route = 12277/45
});
ok("Scorecard compliance rollups are numbers", () => {
  for (const ref of ["B21", "B22", "B23"]) assert.equal(typeof cellAt("Scorecard", ref), "number", `${ref} not numeric`);
  // At least one expired credential exists in the sample (Sara / Nina).
  assert.ok(cellAt("Scorecard", "B23") >= 1);
});

console.log(`✓ ops-command-center template: ${n} checks passed`);
