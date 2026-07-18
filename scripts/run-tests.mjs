#!/usr/bin/env node
// Parallel test runner (project-review PR#83, low-risk form).
//
// `npm test` used to chain 23 `node scripts/test-*.mjs` with && — the first
// failure hid every later suite's result, and nothing ran in parallel. This
// runs every scripts/test-*.mjs as a child process concurrently, prints a
// per-suite PASS/FAIL line, and exits non-zero if ANY failed — so one broken
// suite no longer masks the rest, and the wall-clock is the slowest suite,
// not the sum. It orchestrates the existing scripts unchanged (no rewrite of
// their internals), so it can't change what any individual test asserts.
//
//   npm test              # this runner
//   node scripts/run-tests.mjs --serial   # fall back to sequential
//   node scripts/run-tests.mjs test-cal   # filter by substring

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";

const dir = import.meta.dirname;
const serial = process.argv.includes("--serial");
const filters = process.argv.slice(2).filter((a) => !a.startsWith("--"));

// Suites that need non-Node toolchains and run in their own CI job — not
// part of the Node `npm test` set. test-conformance.mjs shells out to
// Python (pydantic/ortools) and is covered by engine-tests' conformance job.
const SKIP = new Set(["test-conformance.mjs"]);

const suites = fs.readdirSync(dir)
  .filter((f) => /^test-.*\.mjs$/.test(f))
  .filter((f) => !SKIP.has(f))
  .filter((f) => filters.length === 0 || filters.some((s) => f.includes(s)))
  .sort();

if (suites.length === 0) { console.error("no matching test suites"); process.exit(1); }

const limit = serial ? 1 : Math.max(1, Math.min(suites.length, os.cpus().length - 1));
const results = [];
let idx = 0;

function runOne(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(dir, file)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      resolve({ file, code, ms: Date.now() - started, out });
    });
  });
}

async function worker() {
  while (idx < suites.length) {
    const file = suites[idx++];
    const r = await runOne(file);
    results.push(r);
    const tag = r.code === 0 ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    console.log(`${tag}  ${file}  (${r.ms}ms)`);
    if (r.code !== 0) {
      // Show the failing suite's tail so the reason is visible inline.
      const tail = r.out.trim().split("\n").slice(-12).join("\n");
      console.log(tail.split("\n").map((l) => "      " + l).join("\n"));
    }
  }
}

await Promise.all(Array.from({ length: limit }, worker));

const failed = results.filter((r) => r.code !== 0);
console.log(`\n${results.length} suites · ${results.length - failed.length} passed · ${failed.length} failed`);
if (failed.length) {
  console.error("FAILED: " + failed.map((r) => r.file).join(", "));
  process.exit(1);
}
