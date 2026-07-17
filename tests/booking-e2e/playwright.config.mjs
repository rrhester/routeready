// Booking-page end-to-end tests (calendar 100-list #95) · drives the real
// dashboard/booking.html against a fully stubbed Supabase (route
// interception), so the candidate flow — load → pick a slot → intake →
// confirm → booked — is exercised on every PR without any credentials.
//
// Supabase-js can't come from the CDN in CI/sandboxes, so the spec fulfills
// the jsdelivr import with a locally built bundle. Build it once:
//   npm install --no-save @playwright/test http-server esbuild @supabase/supabase-js@2.45.4
//   npx esbuild --bundle node_modules/@supabase/supabase-js/dist/module/index.js \
//     --format=esm --outfile=tests/booking-e2e/.supabase-esm.js
//   npx playwright install chromium        (or set RR_CHROMIUM to a local binary)
//   npx playwright test --config tests/booking-e2e/playwright.config.mjs
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  retries: 1,
  workers: 1,
  use: {
    viewport: { width: 900, height: 1100 },
    serviceWorkers: "block",
    launchOptions: {
      args: ["--no-sandbox"],
      ...(process.env.RR_CHROMIUM ? { executablePath: process.env.RR_CHROMIUM } : {}),
    },
  },
  webServer: {
    command: "npx http-server -p 8124 -s",
    port: 8124,
    reuseExistingServer: true,
    cwd: new URL("../..", import.meta.url).pathname,
  },
});
