// Driver-app E2E config · drives the real driver PWA (app/) in a headless
// browser with a stubbed Supabase client, so the untested client-side form
// logic — conditional visibility, field validation, draft autosave, and the
// offline submission queue — is exercised end-to-end. Runs on every PR via
// .github/workflows/driver-app-tests.yml.
//
// Hermetic: no network. The supabase-js ESM import is fulfilled with a tiny
// in-page stub (see form-fill.spec.mjs), every RPC is answered by an in-page
// mock, and all off-localhost requests are aborted. RR_CONFIG still comes
// from the real dashboard/config.js (served locally) — only the client is faked.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    viewport: { width: 390, height: 780 },
    serviceWorkers: "block",
    launchOptions: {
      args: ["--no-sandbox"],
      // Local/sandbox override — CI uses Playwright's own chromium install.
      ...(process.env.RR_CHROMIUM ? { executablePath: process.env.RR_CHROMIUM } : {}),
    },
  },
  webServer: {
    command: "npx http-server -p 8123 -s -c-1",
    port: 8123,
    reuseExistingServer: true,
    cwd: new URL("../..", import.meta.url).pathname,
  },
});
