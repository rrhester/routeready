// Unit test for the in-selection navigation wrap math (selCycle) — the
// Excel behavior where Enter/Tab cycle inside a selected range and wrap.
import { __engine } from "../dashboard/workbook.js";
const { selCycle } = __engine;

let pass = 0, fail = 0;
function eq(got, want, msg) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.error(`✗ ${msg}: got ${g}, want ${w}`); }
}

// A 3-row x 2-col block: rows 1..3, cols 1..2 (0-based here: r0=1,r1=3,c0=1,c1=2)
const rect = { r0: 1, c0: 1, r1: 3, c1: 2 };

// Enter (axis v) walks down a column, then wraps to the next column's top,
// then wraps back to the top-left after the last cell.
eq(selCycle(rect, { r: 1, c: 1 }, "v", false), { r: 2, c: 1 }, "Enter down within column");
eq(selCycle(rect, { r: 3, c: 1 }, "v", false), { r: 1, c: 2 }, "Enter past last row → next column top");
eq(selCycle(rect, { r: 3, c: 2 }, "v", false), { r: 1, c: 1 }, "Enter past last cell → wrap to origin");
// Shift+Enter reverses.
eq(selCycle(rect, { r: 1, c: 2 }, "v", true), { r: 3, c: 1 }, "Shift+Enter up wraps to prev column bottom");
eq(selCycle(rect, { r: 1, c: 1 }, "v", true), { r: 3, c: 2 }, "Shift+Enter at origin wraps to last cell");

// Tab (axis h) walks right along a row, then wraps to the next row's start.
eq(selCycle(rect, { r: 1, c: 1 }, "h", false), { r: 1, c: 2 }, "Tab right within row");
eq(selCycle(rect, { r: 1, c: 2 }, "h", false), { r: 2, c: 1 }, "Tab past last col → next row start");
eq(selCycle(rect, { r: 3, c: 2 }, "h", false), { r: 1, c: 1 }, "Tab past last cell → wrap to origin");
// Shift+Tab reverses.
eq(selCycle(rect, { r: 2, c: 1 }, "h", true), { r: 1, c: 2 }, "Shift+Tab left wraps to prev row end");
eq(selCycle(rect, { r: 1, c: 1 }, "h", true), { r: 3, c: 2 }, "Shift+Tab at origin wraps to last cell");

// An active cell outside the rect is clamped in first.
eq(selCycle(rect, { r: 9, c: 9 }, "v", false), { r: 1, c: 1 }, "clamp out-of-range active (→3,2) then Enter wraps to origin");

// A single-cell rect always returns itself (degenerate wrap).
const one = { r0: 5, c0: 5, r1: 5, c1: 5 };
eq(selCycle(one, { r: 5, c: 5 }, "v", false), { r: 5, c: 5 }, "1x1 Enter stays put");
eq(selCycle(one, { r: 5, c: 5 }, "h", true), { r: 5, c: 5 }, "1x1 Shift+Tab stays put");

if (fail) { console.error(`\n✗ selCycle: ${fail} failed, ${pass} passed`); process.exit(1); }
console.log(`✓ in-selection navigation (selCycle): ${pass} tests passed`);
