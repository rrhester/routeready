#!/usr/bin/env node
// Tests for smart fill series + F4 reference-anchor cycling.
//   node scripts/test-fill.mjs
import assert from "node:assert/strict";
import { __engine } from "../dashboard/workbook.js";
const { fillSeries, cycleRefAnchor } = __engine;

let n = 0;
const ok = (name, got, want) => { n++; assert.deepEqual(got, want, `${name}\n got ${JSON.stringify(got)}\n want ${JSON.stringify(want)}`); };
const vals = (r) => r && r.map((x) => x.value);

// ── fillSeries ───────────────────────────────────────────────────────────────
ok("single number copies (null)", fillSeries(["5"], 3), null);
ok("numeric linear", vals(fillSeries(["1", "2"], 3)), ["3", "4", "5"]);
ok("numeric step of 5", vals(fillSeries(["10", "15"], 2)), ["20", "25"]);
ok("numeric non-constant ⇒ copy", fillSeries(["1", "2", "4"], 2), null);
ok("single date increments a day", vals(fillSeries(["2026-07-04"], 2)), ["2026-07-05", "2026-07-06"]);
ok("date step of 7", vals(fillSeries(["2026-07-01", "2026-07-08"], 2)), ["2026-07-15", "2026-07-22"]);
ok("weekday short cycles+wraps", vals(fillSeries(["Fri"], 3)), ["Sat", "Sun", "Mon"]);
ok("weekday full", vals(fillSeries(["Monday"], 2)), ["Tuesday", "Wednesday"]);
ok("month short", vals(fillSeries(["Jan"], 3)), ["Feb", "Mar", "Apr"]);
ok("month full wraps", vals(fillSeries(["November"], 3)), ["December", "January", "February"]);
ok("text+number single", vals(fillSeries(["Item1"], 3)), ["Item2", "Item3", "Item4"]);
ok("text+number with space", vals(fillSeries(["Week 1", "Week 2"], 2)), ["Week 3", "Week 4"]);
ok("text+number Q prefix step", vals(fillSeries(["Q1", "Q3"], 2)), ["Q5", "Q7"]);
ok("plain text copies (null)", fillSeries(["hello"], 3), null);
ok("mixed types copy (null)", fillSeries(["East", "5"], 2), null);
ok("type is tagged", fillSeries(["Mon"], 1)[0].type, "text");
ok("date type is tagged", fillSeries(["2026-01-01"], 1)[0].type, "date");

// ── cycleRefAnchor (F4) ──────────────────────────────────────────────────────
// A1 → $A$1 → A$1 → $A1 → A1
ok("A1 → $A$1", cycleRefAnchor("=A1", 3).text, "=$A$1");
ok("$A$1 → A$1", cycleRefAnchor("=$A$1", 5).text, "=A$1");
ok("A$1 → $A1", cycleRefAnchor("=A$1", 4).text, "=$A1");
ok("$A1 → A1", cycleRefAnchor("=$A1", 4).text, "=A1");
ok("cycles the ref the caret is on", cycleRefAnchor("=A1+B2", 6).text, "=A1+$B$2");
ok("caret not on a ref ⇒ null", cycleRefAnchor('="hi"', 4), null);
ok("caret returned after the ref", cycleRefAnchor("=A1", 3).caret, 5); // "=$A$1".length

// ── error hints (hover tooltips) ─────────────────────────────────────────────
const { errorHint, columnSuggestion, parseCellRef } = __engine;
ok("errorHint #REF", /reference is invalid/.test(errorHint("#REF")), true);
ok("errorHint strips !", errorHint("#DIV/0!"), errorHint("#DIV/0"));
ok("errorHint circular", /Circular/.test(errorHint("#CIRCULAR")), true);
ok("errorHint unknown ⇒ generic", errorHint("#WHAT"), "This cell has a formula error.");
ok("errorHint empty ⇒ empty", errorHint(""), "");

// ── column value autocomplete ────────────────────────────────────────────────
function colSheet() {
  const cells = new Map();
  const put = (ref, v, type) => { const rc = parseCellRef(ref); cells.set(rc.row + "," + rc.col, { value: v, formula: null, type: type || "text", computed: null, err: null, format: {} }); };
  put("A1", "East"); put("A2", "West"); put("A3", "East Coast"); put("A4", "42", "number");
  return { cells };
}
const cs = (r, typed) => columnSuggestion(colSheet(), r, 0, typed);
ok("suggests a matching column value", cs(1, "Ea"), "East");                 // A1 'East', dist 1 (ties beat farther A3)
ok("prefers the closest row", cs(4, "Ea"), "East Coast");                    // A3 'East Coast' dist 2 beats A1 'East' dist 4
ok("case-insensitive", cs(5, "wes"), "West");
ok("no match ⇒ null", cs(5, "xyz"), null);
ok("numeric typed ⇒ null", cs(5, "4"), null);
ok("formula typed ⇒ null", cs(5, "=A"), null);
ok("skips numeric cells", columnSuggestion(colSheet(), 5, 0, "4"), null);

console.log(`✓ fill series + F4: ${n} tests passed`);
