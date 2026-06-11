// Visual-regression config · screenshots key pages and diffs them
// against committed baselines (tests/visual/baselines). Runs on every
// PR via .github/workflows/visual-regression.yml.
//
// Determinism notes:
// - External network is blocked per-test (see visual.spec.mjs), so
//   live.js dies early and every page renders its static state — the
//   same offline render in CI, locally, and in any sandbox.
// - Service workers are blocked (they triggered mid-test reloads).
// - Animations are disabled and the boot overlay removed before shots.
// - Inter is self-hosted (app/fonts), so type renders identically.
//
// Updating baselines after an INTENTIONAL visual change:
//   npm install --no-save @playwright/test http-server
//   npx playwright install chromium
//   npx playwright test --config tests/visual/playwright.config.mjs --update-snapshots
// then commit the changed PNGs alongside the CSS change.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 90_000,
  retries: 1,
  workers: 1,
  fullyParallel: false,
  expect: {
    toHaveScreenshot: {
      // Absorbs minor antialiasing differences across Linux hosts while
      // still catching real layout/color/typography drift.
      maxDiffPixelRatio: 0.02,
      animations: "disabled",
    },
  },
  snapshotPathTemplate: "{testDir}/baselines/{arg}{ext}",
  use: {
    viewport: { width: 1700, height: 1000 },
    deviceScaleFactor: 1,
    serviceWorkers: "block",
    launchOptions: {
      args: ["--no-sandbox"],
      // Local/sandbox override — CI uses Playwright's own install.
      ...(process.env.RR_CHROMIUM ? { executablePath: process.env.RR_CHROMIUM } : {}),
    },
  },
  webServer: {
    command: "npx http-server -p 8123 -s",
    port: 8123,
    reuseExistingServer: true,
    cwd: new URL("../..", import.meta.url).pathname,
  },
});
