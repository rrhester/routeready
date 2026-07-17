#!/usr/bin/env node
// TS ↔ Python eligibility conformance test (plan item #4).
//
// The static hard gates exist twice — engine/src (TypeScript, in-browser
// preview) and solver-service/rr_solver/eligibility.py (CP-SAT server) —
// hand-synced with no shared code. This harness runs BOTH on the same
// fixtures and fails when they disagree, so drift can't ship silently.
//
//   · eligible/blocked boolean must match on EVERY pair
//   · the blocking gate must match wherever the fixture has a single
//     violation (drivers tagged multi:true are boolean-only — the two
//     engines check gates in a different documented order)
//
// Run from the repo root:  node scripts/test-conformance.mjs
// Requires: node ≥22 (--experimental-strip-types) and python3 + pydantic.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const fx = JSON.parse(readFileSync("tests/conformance/fixtures.json", "utf8"));

function run(cmd, args) {
  try {
    return JSON.parse(execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (e) {
    console.error(`✗ conformance: failed to run ${cmd} ${args.join(" ")}`);
    console.error(String(e.stderr || e.message).slice(0, 2000));
    process.exit(1);
  }
}

const ts = run(process.execPath, ["--experimental-strip-types", "tests/conformance/ts-dump.ts"]);
const py = run("python3", ["tests/conformance/py_dump.py"]);

// TS rule → Python code, per route type for the certification family.
function tsRuleToCode(rule, shiftId) {
  if (rule === "R002") return "STATUS_FAIL";
  if (rule === "R003") return "LICENSE_FAIL";
  if (rule === "R005") return "PTO_FAIL";
  if (rule === "R006") return "AVAILABILITY_FAIL";
  if (rule === "R004") {
    const shift = fx.shifts.find((s) => s.id === shiftId);
    return { step_van: "DOT_FAIL", xl: "XL_FAIL", edv: "EDV_FAIL" }[shift?.route_type] ?? "R004?";
  }
  return rule;
}

const multiDrivers = new Set(fx.drivers.filter((d) => d.multi).map((d) => d.id));
let checked = 0, mismatches = 0;

for (const key of Object.keys(ts)) {
  const [driverId, shiftId] = key.split("|");
  const t = ts[key];
  const p = py[key];
  checked += 1;
  if (!p) {
    console.error(`✗ ${key}: missing from the Python dump`);
    mismatches += 1;
    continue;
  }
  if (t.eligible !== p.eligible) {
    console.error(`✗ ${key}: TS says ${t.eligible ? "eligible" : `blocked (${t.rule})`}, ` +
      `Python says ${p.eligible ? "eligible" : `blocked (${p.code})`}`);
    mismatches += 1;
    continue;
  }
  if (!t.eligible && !multiDrivers.has(driverId)) {
    const want = tsRuleToCode(t.rule, shiftId);
    if (want !== p.code) {
      console.error(`✗ ${key}: gate mismatch — TS ${t.rule} (≙ ${want}) vs Python ${p.code}`);
      mismatches += 1;
    }
  }
}

if (Object.keys(py).length !== Object.keys(ts).length) {
  console.error(`✗ pair-count mismatch: TS ${Object.keys(ts).length} vs Python ${Object.keys(py).length}`);
  mismatches += 1;
}

if (mismatches > 0) {
  console.error(`\n✗ conformance: ${mismatches} disagreement(s) across ${checked} pairs — ` +
    "the TS engine and the CP-SAT eligibility gate have drifted.");
  process.exit(1);
}
console.log(`✓ conformance: TS and Python agree on all ${checked} (driver, shift) pairs`);
