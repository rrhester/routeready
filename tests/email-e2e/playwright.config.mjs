// Email (Fleet Bridge) e2e (Email review EM#100) · drives the real
// dashboard against a stubbed Supabase and guards the page's
// load-bearing behaviors: the lazy boot (EM#96), read-state patching
// (EM#94), client search + scopes (EM#68/69), and the composer
// draft-autosave chip-snap regression (the operator-reported bug).
//
//   npm install --no-save @playwright/test http-server
//   npx playwright install chromium        (or set RR_CHROMIUM)
//   npx playwright test --config tests/email-e2e/playwright.config.mjs
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 90_000,
  retries: 1,
  workers: 1,
  use: {
    viewport: { width: 1500, height: 950 },
    serviceWorkers: "block",
    launchOptions: {
      args: ["--no-sandbox"],
      ...(process.env.RR_CHROMIUM ? { executablePath: process.env.RR_CHROMIUM } : {}),
    },
  },
  webServer: {
    command: "npx http-server -p 8127 -s",
    port: 8127,
    reuseExistingServer: true,
    cwd: new URL("../..", import.meta.url).pathname,
  },
});
