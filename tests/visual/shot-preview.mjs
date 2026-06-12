// Preview helper: renders the dashboard offline the same way
// visual.spec.mjs does and saves a full-viewport screenshot, so shell /
// chrome changes can be compared as real images before shipping.
//   RR_CHROMIUM=... node tests/visual/shot-preview.mjs /tmp/out.png
// Pass "wco" as a second arg to simulate the installed-app Window
// Controls Overlay state (title-bar band + cleared paddings):
//   RR_CHROMIUM=... node tests/visual/shot-preview.mjs /tmp/out.png wco
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";

const out = process.argv[2] || "/tmp/dashboard-preview.png";

const server = spawn("npx", ["http-server", "-p", "8123", "-s"], {
  cwd: new URL("../..", import.meta.url).pathname,
  stdio: "ignore",
  detached: true,
});
await new Promise((r) => setTimeout(r, 1500));

const browser = await chromium.launch({
  args: ["--no-sandbox"],
  ...(process.env.RR_CHROMIUM ? { executablePath: process.env.RR_CHROMIUM } : {}),
});
const page = await browser.newPage({
  viewport: { width: 1700, height: 1000 },
  serviceWorkers: "block",
});
await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
await page.addInitScript(() => { window.__rrSchedOrientFlash = true; });
page.on("pageerror", () => {});
await page.goto("http://127.0.0.1:8123/dashboard/index.html", { waitUntil: "domcontentloaded" });
await page.addStyleTag({
  content:
    "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" +
    "#rr-hdr-install{display:none!important}",
});
if (process.argv[3] === "wco") {
  // Simulate the installed-app Window Controls Overlay state: replicate
  // the @media (display-mode: window-controls-overlay) rules (env()
  // falls back to 33px outside a real WCO window).
  await page.addStyleTag({
    content: `
      .sidebar{padding-top:33px}
      .view > .page{padding-top:37px!important}
      body::before{
        content:"";position:fixed;top:0;left:0;right:0;height:33px;z-index:55;
        --rr-tb-rail-w:212px;
        background:linear-gradient(90deg,
          var(--sidebar-bg,#0F6CBD) 0 var(--rr-tb-rail-w),
          #F7F8FA var(--rr-tb-rail-w));
      }
      body:has(.sidebar.collapsed)::before,
      html.rr-sidebar-collapsed-boot body::before{--rr-tb-rail-w:64px}
    `,
  });
}
await page.waitForTimeout(1500);
await page.evaluate(() => document.getElementById("rr-boot-overlay")?.remove());
await page.waitForTimeout(300);
await page.screenshot({ path: out });
await browser.close();
process.kill(-server.pid, "SIGTERM");
console.log("saved", out);
