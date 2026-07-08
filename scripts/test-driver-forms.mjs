#!/usr/bin/env node
// Tests for the driver-form CLIENT validator (app/form-validation.js).
//   node scripts/test-driver-forms.mjs
//
// Two layers:
//   1. Targeted unit checks for each field-type rule.
//   2. The shared fixture set in tests/driver-forms/validation-cases.json —
//      the SAME cases the SQL suite (supabase/tests/driver_forms_test.sql)
//      runs through the server validator. Both engines must agree; if this
//      file's validator drifts from the SQL in migration 0439, one suite goes
//      red.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateFormAnswer } from "../app/form-validation.js";

const __dir = dirname(fileURLToPath(import.meta.url));
let n = 0;

// valid(field, value) → true when the answer is accepted (no error string).
const valid = (f, v) => validateFormAnswer(f, v) === null;

const okValid = (name, f, v) => { n++; assert.equal(valid(f, v), true, `${name}: expected VALID, got "${validateFormAnswer(f, v)}"`); };
const okInvalid = (name, f, v) => { n++; assert.equal(valid(f, v), false, `${name}: expected INVALID, got accepted`); };

// ── 1. Unit checks ───────────────────────────────────────────────────
// required / empty
okInvalid("required empty", { id: "q", type: "short_text", required: true }, "");
okValid("optional empty", { id: "q", type: "short_text", required: false }, "");
okValid("optional empty array", { id: "q", type: "multi_choice", required: false, options: ["a"] }, []);
okInvalid("required empty array", { id: "q", type: "multi_choice", required: true, options: ["a"] }, []);

// email
okValid("email ok", { id: "q", type: "email" }, "a@b.com");
okInvalid("email no domain dot", { id: "q", type: "email" }, "a@b");
okInvalid("email whitespace", { id: "q", type: "email" }, "a b@c.com");

// phone (>= 7 digits, non-digits stripped)
okValid("phone 10 digits", { id: "q", type: "phone" }, "555-123-4567");
okInvalid("phone 6 digits", { id: "q", type: "phone" }, "12-34-56");

// date (ISO + real calendar date) / time (24h HH:MM[:SS])
okValid("date iso", { id: "q", type: "date" }, "2026-07-08");
okValid("date leap day", { id: "q", type: "date" }, "2024-02-29");
okInvalid("date impossible", { id: "q", type: "date" }, "2026-02-30");
okInvalid("date non-leap feb29", { id: "q", type: "date" }, "2026-02-29");
okInvalid("date loose", { id: "q", type: "date" }, "2026-7-8");
okValid("time hh:mm", { id: "q", type: "time" }, "09:30");
okValid("time hh:mm:ss", { id: "q", type: "time" }, "08:15:30");
okInvalid("time hour 24", { id: "q", type: "time" }, "24:00");
okInvalid("time min 60", { id: "q", type: "time" }, "12:60");

// number + range
okValid("number in range", { id: "q", type: "number", validation: { min: 1, max: 10 } }, "5");
okInvalid("number below min", { id: "q", type: "number", validation: { min: 1 } }, "0");
okInvalid("number above max", { id: "q", type: "number", validation: { max: 10 } }, "11");
okInvalid("number NaN", { id: "q", type: "number" }, "abc");

// rating 1..5
okValid("rating 3", { id: "q", type: "rating" }, "3");
okInvalid("rating 0", { id: "q", type: "rating" }, "0");
okInvalid("rating 6", { id: "q", type: "rating" }, "6");

// text length
okInvalid("too short", { id: "q", type: "short_text", validation: { minLen: 3 } }, "ab");
okInvalid("too long", { id: "q", type: "long_text", validation: { maxLen: 4 } }, "hello");
okValid("length ok", { id: "q", type: "short_text", validation: { minLen: 2, maxLen: 5 } }, "abc");

// choice membership
okValid("single in options", { id: "q", type: "single_choice", options: ["a", "b"] }, "a");
okInvalid("single not in options", { id: "q", type: "single_choice", options: ["a", "b"] }, "c");
okValid("empty options accepts anything", { id: "q", type: "dropdown", options: [] }, "Van 42");
okValid("multi subset", { id: "q", type: "multi_choice", options: ["a", "b", "c"] }, ["a", "c"]);
okInvalid("multi unknown member", { id: "q", type: "multi_choice", options: ["a", "b"] }, ["a", "z"]);

// ── 2. Shared fixture parity (JS side) ───────────────────────────────
const fixture = JSON.parse(readFileSync(join(__dir, "..", "tests", "driver-forms", "validation-cases.json"), "utf8"));
for (const c of fixture.cases) {
  n++;
  assert.equal(
    valid(c.field, c.value),
    c.valid,
    `fixture "${c.name}": expected ${c.valid ? "VALID" : "INVALID"}, JS said ${valid(c.field, c.value) ? "VALID" : "INVALID"}`
  );
}

console.log(`driver-forms validator: ${n} assertions passed (${fixture.cases.length} shared fixtures).`);
