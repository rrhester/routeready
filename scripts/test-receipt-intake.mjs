#!/usr/bin/env node
// Tests for the receipt-intake on-device field extractor.
//   node scripts/test-receipt-intake.mjs
//
// When a driver taps "Auto-fill" on a scanned receipt, RouteReady runs the
// on-device OCR text through pure heuristics (_receiptGuessFields /
// _receiptNormalizeDate in app/app.js) to prefill amount, date, and vendor —
// which the driver then confirms. app/app.js is the PWA entry module and
// isn't importable in Node, so we slice the two pure functions out of source
// and exercise them directly. These must never throw and must degrade to
// nulls, because a bad guess is only a prefill the driver corrects — but an
// exception would break the whole receipt form.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "app", "app.js"), "utf8");

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `could not find function ${name} in app/app.js`);
  const after = src.slice(start + name.length + 10);
  const m = after.search(/\n(?:async )?function /);
  assert.ok(m >= 0, `could not find end of ${name}`);
  return src.slice(start, start + name.length + 10 + m);
}

const bundle = extract("_receiptGuessFields") + "\n" + extract("_receiptNormalizeDate") +
  "\nreturn { _receiptGuessFields, _receiptNormalizeDate };";
// eslint-disable-next-line no-new-func
const { _receiptGuessFields, _receiptNormalizeDate } = new Function(bundle)();

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

// ── amount: a "Total" line wins over other currency on the receipt ──
{
  const g = _receiptGuessFields(
    ["SHELL OIL", "123 Main St", "Fuel 12.401 GAL", "Subtotal   45.00",
     "Tax         3.60", "TOTAL      $48.60", "VISA ****1234"].join("\n"));
  ok(g.amount === 48.60, `total wins → 48.60, got ${g.amount}`);
  ok(g.vendor === "SHELL OIL", `vendor from first text line, got ${g.vendor}`);
  ok(g.date === null, `no date present → null, got ${g.date}`);
}

// ── amount: no total keyword → falls back to the largest currency value ──
{
  const g = _receiptGuessFields("Corner Cafe\n3.50\n5.00\n2.00");
  ok(g.amount === 5.00, `fallback max → 5.00, got ${g.amount}`);
  ok(g.vendor === "Corner Cafe", `vendor → Corner Cafe, got ${g.vendor}`);
}

// ── amount: thousands separators parse correctly ──
{
  const g = _receiptGuessFields("Big Fleet Supply\nTotal Due  $1,234.56");
  ok(g.amount === 1234.56, `thousands → 1234.56, got ${g.amount}`);
}

// ── date: US and ISO shapes normalize to YYYY-MM-DD ──
{
  const g = _receiptGuessFields("AutoZone\nDate 07/04/2026\nTotal 19.99");
  ok(g.date === "2026-07-04", `US date → 2026-07-04, got ${g.date}`);
}
ok(_receiptNormalizeDate("2026-07-04".match(/\b(\d{4})-(\d{2})-(\d{2})\b/)) === "2026-07-04", "ISO date passthrough");
ok(_receiptNormalizeDate("07/04/26".match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/)) === "2026-07-04", "2-digit year → 2026");
ok(_receiptNormalizeDate("13/40/2026".match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/)) === null, "out-of-range date → null");

// ── robustness: empty / junk input never throws, returns nulls ──
{
  const g = _receiptGuessFields("");
  ok(g.amount === null && g.date === null && g.vendor === null, "empty → all null");
  const g2 = _receiptGuessFields("!!!\n@@@\n####");
  ok(g2.amount === null, "no currency → null amount");
}

console.log(`receipt-intake: ${passed} assertions passed`);
