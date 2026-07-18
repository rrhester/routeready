// Login-flow end-to-end tests (project-review PR#82) · drives the real
// dashboard/login.html against a stubbed Supabase auth endpoint. Guards the
// behaviours that must never regress: mode switching, and — critically —
// the ?next= open-redirect sanitization added in the security wave (a
// cross-origin next must never survive to location.replace).
//
// login.html imports the VENDORED supabase-js (/dashboard/vendor/...), which
// http-server serves directly — no CDN bundle needed. We just stub the
// Supabase auth/REST calls the client makes.
//
//   npm install --no-save @playwright/test http-server
//   npx playwright install chromium        (or set RR_CHROMIUM)
//   npx playwright test --config tests/login-e2e/playwright.config.mjs
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  retries: 1,
  workers: 1,
  use: {
    viewport: { width: 900, height: 1000 },
    serviceWorkers: "block",
    launchOptions: {
      args: ["--no-sandbox"],
      ...(process.env.RR_CHROMIUM ? { executablePath: process.env.RR_CHROMIUM } : {}),
    },
  },
  webServer: {
    command: "npx http-server -p 8126 -s",
    port: 8126,
    reuseExistingServer: true,
    cwd: new URL("../..", import.meta.url).pathname,
  },
});
