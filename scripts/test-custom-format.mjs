#!/usr/bin/env node
// Tests for Excel/Sheets custom number-format codes (applyCustomFormat).
//   node scripts/test-custom-format.mjs
import assert from "node:assert/strict";
import { __engine } from "../dashboard/workbook.js";
const { applyCustomFormat, dateToSerial } = __engine;

let n = 0;
const ok = (name, got, want) => { n++; assert.equal(got, want, `${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
const f = (v, code) => applyCustomFormat(v, code, null);

// grouping + decimals
ok("thousands + 2dp", f(1234567.5, "#,##0.00"), "1,234,567.50");
ok("no grouping int", f(1234, "0"), "1234");
ok("min integer digits", f(7, "000"), "007");
ok("hide leading zeros", f(0.5, "#.##"), ".5");
ok("plain 2dp no group", f(1234.5, "0.00"), "1234.50");

// percent
ok("percent 1dp", f(0.1234, "0.0%"), "12.3%");
ok("percent whole", f(0.5, "0%"), "50%");

// scaling with trailing commas (K / M)
ok("thousands scale K", f(1500, '#,##0,"K"'), "2K");            // 1500/1000 = 1.5 → rounds to 2 at 0dp
ok("thousands scale K 1dp", f(1500, '#,##0.0,"K"'), "1.5K");
ok("millions scale", f(2500000, '#,##0.0,,"M"'), "2.5M");

// literals: prefix/suffix, quoted text, symbols
ok("currency prefix", f(1250, '"$"#,##0.00'), "$1,250.00");
ok("suffix units", f(42, '0" units"'), "42 units");
ok("bare dollar sign", f(1250, "$#,##0"), "$1,250");

// sections: positive; negative; zero
ok("negative in parens", f(-1234, "#,##0;(#,##0)"), "(1,234)");
ok("negative single section gets sign", f(-1234, "#,##0"), "-1,234");
ok("zero section", f(0, "0.00;-0.00;\"—\""), "—");
ok("positive picks first section", f(5, "0\"+\";0\"-\""), "5+");

// conditional sections
ok("condition picks section", f(150, "[>100]\"big\";0"), "big");
ok("condition falls through", f(50, "[>100]\"big\";0"), "50");

// dates
const s = dateToSerial(new Date(2026, 6, 4)); // 2026-07-04, a Saturday
ok("date m/d/yyyy", f(s, "m/d/yyyy"), "7/4/2026");
ok("date mmm d, yyyy", f(s, "mmm d, yyyy"), "Jul 4, 2026");
ok("date mmmm dddd", f(s, "mmmm dddd"), "July Saturday");
ok("date yy-mm-dd", f(s, "yy-mm-dd"), "26-07-04");
// time (serial with fractional day = 13:30)
const st = dateToSerial(new Date(2026, 6, 4)) + (13 * 60 + 30) / 1440;
ok("time h:mm 24h", f(st, "h:mm"), "13:30");
ok("time h:mm AM/PM", f(st, "h:mm AM/PM"), "1:30 PM");
ok("month vs minute disambiguation", f(st, "mm/dd h:mm"), "07/04 13:30");

// text section with @
ok("text passthrough via @", applyCustomFormat("hello", "0;;;@\" (note)\"", "text"), "hello (note)");

console.log(`✓ custom number formats: ${n} tests passed`);
