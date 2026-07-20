// Re-encode PNG captures to responsive WebP via Chromium canvas
// (no native image tooling in this sandbox). Also builds a 1200x630
// JPEG og-image from the schedule capture.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const IN = path.join(DIR, "out");
const OUT = path.join(DIR, "webp");
fs.mkdirSync(OUT, { recursive: true });

// name → [widths]
const PLAN = {
  "schedule-week": [2600, 1300],
  "today-plan": [2400, 1200],
  "targets": [2400, 1200],
  "fleet": [2400, 1200],
  "drivers": [2400, 1200],
  "messages": [2400, 1200],
  "driver-app-today": [900, 450],
  "driver-app-schedule": [900, 450],
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox", "--headless=new"] });
const page = await browser.newPage();
await page.goto("about:blank");

async function encode(pngPath, width, quality = 0.82) {
  const b64 = fs.readFileSync(pngPath).toString("base64");
  return await page.evaluate(async ([b64, width, quality]) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const scale = Math.min(1, width / img.naturalWidth);
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);
    return c.toDataURL("image/webp", quality).split(",")[1];
  }, [b64, width, quality]);
}

for (const [name, widths] of Object.entries(PLAN)) {
  const src = path.join(IN, name + ".png");
  if (!fs.existsSync(src)) { console.log("SKIP missing", name); continue; }
  for (const w of widths) {
    const out = path.join(OUT, `${name}-${w}w.webp`);
    const b64 = await encode(src, w);
    fs.writeFileSync(out, Buffer.from(b64, "base64"));
    console.log(path.basename(out), Math.round(fs.statSync(out).size / 1024) + "KB");
  }
}

// og-image: 1200x630 cover-crop of the schedule capture (top-left focus).
{
  const b64 = fs.readFileSync(path.join(IN, "schedule-week.png")).toString("base64");
  const jpg = await page.evaluate(async ([b64]) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const W = 1200, H = 630;
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    // cover: scale so the full width fits, crop from the top
    const scale = W / img.naturalWidth;
    const h = img.naturalHeight * scale;
    ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, W, h);
    return c.toDataURL("image/jpeg", 0.85).split(",")[1];
  }, [b64]);
  fs.writeFileSync(path.join(OUT, "og-schedule.jpg"), Buffer.from(jpg, "base64"));
  console.log("og-schedule.jpg", Math.round(fs.statSync(path.join(OUT, "og-schedule.jpg")).size / 1024) + "KB");
}

await browser.close();
