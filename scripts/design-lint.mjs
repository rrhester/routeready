#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Design-system ratchet.
//
// World-class UIs read as one system because they are ruthlessly consistent.
// RouteReady defines 284 design tokens but bypasses them with hundreds of
// raw hex colors, thousands of !important overrides, and dozens of one-off
// font sizes. You cannot safely un-pick all of that in one pass — but you
// CAN stop it from growing. This is a ratchet: it measures the current
// counts against a committed baseline (design-baseline.json) and FAILS if
// any metric goes up. Every PR can only hold the line or improve it; as the
// team migrates raw values to tokens, re-run with --update to lower the bar.
//
//   node scripts/design-lint.mjs            # check against baseline (CI)
//   node scripts/design-lint.mjs --update   # rewrite the baseline (after a
//                                            # deliberate reduction)
//
// Scope: the shipped stylesheets. Inline style="" in frags/JS is a separate
// axis we can add later; this targets the biggest, most measurable surface.
// ─────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILES = [
  "dashboard/inline-styles.css",
  "dashboard/schedule-rrx.css",
  "dashboard/onboarding-rrx.css",
  "dashboard/tcp.css",
  "app/styles.css",
  "app/rr-system.css",
];
const BASELINE = path.join(ROOT, "scripts/design-baseline.json");

// A raw hex usage = a #hex NOT on a custom-property definition line
// (`--token: #hex;`). That leaves hex sitting in real property values —
// exactly what should be a var(--token) instead.
function scan(css) {
  let rawHex = 0, important = 0, rawFontSize = 0;
  for (const line of css.split("\n")) {
    const isTokenDef = /^\s*--[a-z0-9-]+\s*:/.test(line);
    if (!isTokenDef) {
      rawHex += (line.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length;
    }
    important += (line.match(/!important/g) || []).length;
    // font-size with a literal length instead of a token
    for (const m of line.matchAll(/font-size\s*:\s*([^;]+);/g)) {
      if (!/var\(/.test(m[1])) rawFontSize += 1;
    }
  }
  return { rawHex, important, rawFontSize };
}

const totals = { rawHex: 0, important: 0, rawFontSize: 0 };
const perFile = {};
for (const rel of FILES) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  const c = scan(fs.readFileSync(p, "utf8"));
  perFile[rel] = c;
  for (const k of Object.keys(totals)) totals[k] += c[k];
}

const update = process.argv.includes("--update");
if (update) {
  fs.writeFileSync(BASELINE, JSON.stringify(totals, null, 2) + "\n");
  console.log("✓ design baseline updated:", JSON.stringify(totals));
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
  console.error("✗ no baseline — run `node scripts/design-lint.mjs --update` first.");
  process.exit(1);
}
const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));

let failed = false;
const label = { rawHex: "raw hex colors", important: "!important", rawFontSize: "literal font-sizes" };
for (const k of Object.keys(totals)) {
  const now = totals[k], was = base[k] ?? 0;
  if (now > was) {
    failed = true;
    console.error(`✗ ${label[k]}: ${now} (baseline ${was}) — up ${now - was}. Use tokens instead, or justify + --update.`);
  } else {
    console.log(`✓ ${label[k]}: ${now} (baseline ${was})${now < was ? ` — improved by ${was - now}, run --update to lock it in` : ""}`);
  }
}

if (failed) {
  console.error("\n✗ design ratchet: a raw-value count increased. World-class = fewer, not more.");
  process.exit(1);
}
console.log("\n✓ design ratchet: held or improved.");
