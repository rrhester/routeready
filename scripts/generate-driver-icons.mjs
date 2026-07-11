// Driver-app PWA asset generator.
//
// Renders app/icon.svg (the single source of truth for the brand tile)
// into the full icon + iOS-splash set under app/icons/:
//
//   icon-192.png / icon-512.png        purpose "any" — the rounded tile as-is
//   icon-maskable-192/512.png          purpose "maskable" — full-bleed navy
//                                      background, mark scaled into the central
//                                      80% safe zone so Android's circle/squircle
//                                      mask never clips it
//   apple-touch-icon.png (180x180)     opaque, full-bleed — iOS applies its own
//                                      corner mask; transparency renders black
//   favicon-32.png                     small raster fallback for the tab icon
//   splash-{W}x{H}.png                 apple-touch-startup-image set (portrait)
//
// Run:  node scripts/generate-driver-icons.mjs
// Needs a resolvable `playwright` package (global install + NODE_PATH works)
// and a Chromium (PLAYWRIGHT_BROWSERS_PATH or /opt/pw-browsers). It prints the
// <link rel="apple-touch-startup-image"> block to paste into app/index.html.

import { createRequire } from "node:module";
import { readFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "app");
const outDir = join(appDir, "icons");
mkdirSync(outDir, { recursive: true });

const tileSvg = readFileSync(join(appDir, "icon.svg"), "utf8");

// Maskable variant: drop the tile's rounded corners (the launcher supplies
// the mask) and scale the mark to the central 80% — the mark spans 80..432,
// whose corners sit ~249px from center, outside the 204.8px safe-zone
// radius, so unscaled it would clip on circular masks.
const maskableSvg = tileSvg
  .replace('<rect width="512" height="512" rx="108" fill="url(#rrBg)"/>', '<rect width="512" height="512" fill="url(#rrBg)"/>')
  .replace('<rect width="512" height="512" rx="108" fill="url(#rrSheen)"/>', '<rect width="512" height="512" fill="url(#rrSheen)"/>')
  .replace("<!-- Dormant grid cells", '<g transform="translate(51.2,51.2) scale(0.8)"><!-- Dormant grid cells')
  .replace("</svg>", "</g></svg>");
if (!maskableSvg.includes('scale(0.8)') || maskableSvg.includes('rx="108"')) {
  throw new Error("icon.svg shape changed — update the maskable derivation in this script");
}

const dataUri = (svg) => "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
const iconHtml = (svg, size) =>
  `<!doctype html><style>*{margin:0}</style><img src="${dataUri(svg)}" width="${size}" height="${size}">`;
const splashHtml = (svg, size) =>
  `<!doctype html><style>*{margin:0}html,body{height:100%}body{display:flex;align-items:center;justify-content:center;background:#F9FAFB}</style><img src="${dataUri(svg)}" width="${size}" height="${size}">`;

// Portrait splash set: [device-width pt, device-height pt, pixel ratio].
// Covers iPhone SE2/8 → 16 Pro Max + common iPads (pwa-asset-generator's set).
const SPLASHES = [
  [440, 956, 3], [430, 932, 3], [428, 926, 3], [414, 896, 3], [414, 896, 2],
  [414, 736, 3], [402, 874, 3], [393, 852, 3], [390, 844, 3], [375, 812, 3],
  [375, 667, 2],
  [1024, 1366, 2], [834, 1194, 2], [834, 1112, 2], [810, 1080, 2], [768, 1024, 2],
];

let browser;
try {
  browser = await chromium.launch();
} catch {
  browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
}

async function shot(html, w, h, file, { transparent = false } = {}) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.setContent(html);
  const path = join(outDir, file);
  await page.screenshot({ path, omitBackground: transparent });
  await page.close();
  console.log(`  ${file}  ${(statSync(path).size / 1024).toFixed(1)}KB`);
}

console.log("icons:");
await shot(iconHtml(tileSvg, 512), 512, 512, "icon-512.png", { transparent: true });
await shot(iconHtml(tileSvg, 192), 192, 192, "icon-192.png", { transparent: true });
await shot(iconHtml(maskableSvg, 512), 512, 512, "icon-maskable-512.png");
await shot(iconHtml(maskableSvg, 192), 192, 192, "icon-maskable-192.png");
await shot(iconHtml(maskableSvg, 180), 180, 180, "apple-touch-icon.png");
await shot(iconHtml(tileSvg, 32), 32, 32, "favicon-32.png", { transparent: true });

console.log("splash:");
const links = [];
for (const [w, h, dpr] of SPLASHES) {
  const pw = w * dpr, ph = h * dpr;
  const file = `splash-${pw}x${ph}.png`;
  await shot(splashHtml(tileSvg, Math.round(Math.min(pw, ph) * 0.26)), pw, ph, file);
  links.push(
    `  <link rel="apple-touch-startup-image" media="(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait)" href="icons/${file}">`
  );
}

await browser.close();
console.log("\nPaste into app/index.html <head>:\n");
console.log(links.join("\n"));
