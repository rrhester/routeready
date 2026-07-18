#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Design-system + a11y ratchet.
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
//                                            # deliberate reduction, OR when
//                                            # a legitimate new value is
//                                            # unavoidable — justify in the PR)
//
// Scope (project-review PR#93): the shipped stylesheets, the driver render
// layer (app/app.js), the DASHBOARD render layer (dashboard/live.js — the
// 99k-line monolith that composes UI from template strings, previously the
// single largest ungoverned styling surface), and the PUBLIC HTML pages
// (booking/rsvp/login/index/… — each carries inline <style> blocks and
// style="" attributes that grew invisibly to CI). All JS/HTML surfaces are
// scanned with a markup-aware pass that also counts inline style="" attrs
// (fewer = more on-system).
//
// A11y axes (project-review PR#94): the same ratchet now also holds the line
// on two text-detectable accessibility anti-patterns —
//   • positive tabindex (breaks the natural focus order; 0 / -1 are fine)
//   • <img> with no alt attribute (screen readers announce the file name)
// These only ever appear in the JS/HTML surfaces; CSS contributes 0.
//
// NOTE for concurrent work on dashboard/live.js: this file is now gated, so
// a PR that adds a raw #hex / !important / inline style / positive tabindex /
// alt-less <img> to live.js will fail here. Prefer a var(--token) or an alt
// attribute; if a new raw value is genuinely unavoidable, run --update and
// say why in the PR. The counts only ratchet DOWN.
// ─────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Pure stylesheets — hex on a `--token: #hex;` definition line is the token
// system itself, so it's not counted; hex anywhere else is a raw value.
const CSS_FILES = [
  "dashboard/inline-styles.css",
  "dashboard/schedule-rrx.css",
  "dashboard/onboarding-rrx.css",
  "dashboard/tcp.css",
  "app/styles.css",
  "app/rr-system.css",
];
// JS render layers — markup composed from template strings.
const JS_FILES = [
  "app/app.js",
  "dashboard/live.js",
];
// Public + shell HTML — inline <style> blocks (token defs skipped, like CSS)
// plus inline style="" attributes and a11y-relevant markup.
const HTML_FILES = [
  "index.html",
  "download.html",
  "installed.html",
  "privacy.html",
  "terms.html",
  "verify.html",
  "404.html",
  "dashboard/index.html",
  "dashboard/login.html",
  "dashboard/booking.html",
  "dashboard/rsvp.html",
  "dashboard/coaching.html",
  "dashboard/meet.html",
  "dashboard/refer.html",
  "dashboard/screening.html",
  "dashboard/shop.html",
];
const BASELINE = path.join(ROOT, "scripts/design-baseline.json");

const AXES = ["rawHex", "important", "rawFontSize", "inlineStyle", "positiveTabindex", "imgNoAlt"];

// One scanner, three flavours via options:
//   skipTokenDefs  — don't count hex on a `--token: #hex;` line (CSS/inline <style>)
//   markup         — also count inline style="" attrs, a11y axes; font-size
//                    may end at ; " or '; and full-line comments are skipped
//                    (a `<img>` / #hex / !important MENTIONED in a JS or HTML
//                    comment is documentation, not shipped markup — counting
//                    it would fail CI for prose).
function scan(text, { skipTokenDefs = false, markup = false } = {}) {
  const c = Object.fromEntries(AXES.map((k) => [k, 0]));
  const fontRe = markup ? /font-size\s*:\s*([^;"']+)[;"']/g : /font-size\s*:\s*([^;]+);/g;
  const commentRe = /^\s*(\/\/|\*|\/\*|<!--|-->)/;
  for (const raw of text.split("\n")) {
    if (markup && commentRe.test(raw)) continue;
    // Strip inline /* … */ block comments so an `<img>` / #hex mentioned in
    // one (e.g. `catch { /* fall through to <img> */ }`) isn't miscounted.
    const line = markup ? raw.replace(/\/\*.*?\*\//g, "") : raw;
    const isTokenDef = /^\s*--[a-z0-9-]+\s*:/.test(line);
    if (!(skipTokenDefs && isTokenDef)) {
      c.rawHex += (line.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length;
    }
    c.important += (line.match(/!important/g) || []).length;
    if (markup) {
      c.inlineStyle += (line.match(/style="/g) || []).length;
      // positive tabindex only (tabindex="0" keeps natural order, "-1" is
      // programmatic-focus). First non-quote char 1-9 ⇒ a positive value.
      c.positiveTabindex += (line.match(/tabindex\s*=\s*["']?[1-9]/g) || []).length;
      // <img …> with no alt= before the closing >. Single-line tags only —
      // consistent, not exhaustive; that's all a ratchet needs.
      c.imgNoAlt += (line.match(/<img\b(?![^>]*\balt\s*=)[^>]*>/g) || []).length;
    }
    for (const m of line.matchAll(fontRe)) {
      if (!/var\(/.test(m[1])) c.rawFontSize += 1;
    }
  }
  return c;
}

const totals = Object.fromEntries(AXES.map((k) => [k, 0]));
const perFile = {};
function add(rel, opts) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return;
  const c = scan(fs.readFileSync(p, "utf8"), opts);
  perFile[rel] = c;
  for (const k of AXES) totals[k] += c[k];
}
for (const rel of CSS_FILES) add(rel, { skipTokenDefs: true });
for (const rel of JS_FILES) add(rel, { markup: true });
for (const rel of HTML_FILES) add(rel, { skipTokenDefs: true, markup: true });

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
const label = {
  rawHex: "raw hex colors",
  important: "!important",
  rawFontSize: "literal font-sizes",
  inlineStyle: 'inline style="" attrs',
  positiveTabindex: "positive tabindex (a11y)",
  imgNoAlt: "<img> without alt (a11y)",
};
for (const k of AXES) {
  const now = totals[k], was = base[k] ?? 0;
  if (now > was) {
    failed = true;
    console.error(`✗ ${label[k]}: ${now} (baseline ${was}) — up ${now - was}. Use tokens / add alt, or justify + --update.`);
  } else {
    console.log(`✓ ${label[k]}: ${now} (baseline ${was})${now < was ? ` — improved by ${was - now}, run --update to lock it in` : ""}`);
  }
}

if (failed) {
  console.error("\n✗ design/a11y ratchet: a raw-value count increased. World-class = fewer, not more.");
  process.exit(1);
}
console.log("\n✓ design/a11y ratchet: held or improved.");
