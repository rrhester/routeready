// Workbook functional smoke (100-list #98) · runs the workbook module in a
// REAL browser via Playwright — no screenshots, no baselines, fully offline.
//
// workbook.js has no external imports, so the fixture loads it with the network
// blocked and exercises the formula engine, custom formatting, the XLSX writer,
// and HTML-escaping inside Chromium. This catches browser-only regressions the
// Node suites can't see (a Node-only global, a syntax feature Chromium rejects,
// a module that throws on load) and guards the escape helper against XSS.
import { test, expect } from "@playwright/test";

const BASE = "http://127.0.0.1:8123/";

test("workbook · engine loads and computes in-browser", async ({ page }) => {
  // Block everything off-host so the run is deterministic and offline.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(BASE + "tests/visual/wb-fixture.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__wbReady === true, { timeout: 30_000 });

  const res = await page.evaluate(() => window.__wbResults);

  // The module loaded and ran without throwing.
  expect(res.error, res.error || "").toBeNull();
  expect(res.ok).toBe(true);
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);

  // Formula engine results computed inside Chromium.
  expect(res.checks.sum).toBe(12);
  expect(res.checks.upper).toBe("HI!");
  expect(res.checks.ifLogic).toBe(10);
  expect(res.checks.cellRef).toBe(12);
  expect(res.checks.fmt).toBe("1,234.50");
  expect(res.checks.xlsxBytes).toBe(true);

  // esc() neutralizes markup: the payload became inert text, no <img> node.
  expect(res.checks.escNoInjection).toBe(true);
  expect(res.checks.escText).toContain("<img");
});
