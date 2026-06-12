// RouteReady Desktop · scraper module.
//
// Record-and-replay scraping for portals (Indeed first). The operator
// records the click path in a headed Chromium via an injected picker
// overlay; the recipe is saved as a small JSON file (selectors only).
// Scheduled runs replay the recipe in headless Chromium, walk each row
// in the target list, click any reveal buttons, scrape text into a
// CSV, dedupe against prior runs.
//
// The point of doing this as data (recipes) instead of code (hardcoded
// selectors) is the operator can re-record when the portal changes
// without us shipping a new build.

const { ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// ─── Module state ───────────────────────────────────────────────────
// init(deps) wires us up to main.js — we don't import main.js back
// because that would be a circular require.

let DEPS = null;

const TICK_MS = 30000;       // scheduler loop cadence
const SEEN_LIMIT = 5000;     // dedupe ring cap per recipe
const ROW_PAUSE_MIN = 800;   // ms · min wait between rows when replaying
const ROW_PAUSE_MAX = 2400;  // ms · max wait — adds jitter so we don't hammer the portal

// Recipe schema. Every field is a CSS selector except startUrl + name.
// Optional fields may be empty strings — replay treats them as no-ops.
const RECIPE_SHAPE = {
  rowSelector: "Each applicant ROW in the list",
  rowOpenSelector: "Inside that row, what to CLICK to open the candidate detail (usually the name link)",
  revealEmailSelector: "OPTIONAL: \"Show email\" / \"View contact\" button (skip if email is visible right away)",
  revealPhoneSelector: "OPTIONAL: \"Show phone\" button (skip if phone is visible right away, or if your Indeed plan never shows phone)",
  nameSelector: "Applicant NAME text (on the detail panel)",
  emailSelector: "Applicant EMAIL text",
  phoneSelector: "OPTIONAL: Applicant PHONE text (skip if your Indeed plan doesn't surface phone)",
  closePanelSelector: "OPTIONAL: Close (X) button to return to the applicant list (skip if details open inline)",
};

// Ordered list of steps the page-injected recorder walks the operator
// through. Mirrors the schema above. Marked `optional:true` steps show
// a Skip button in the overlay.
const RECORDER_STEPS = [
  { key: "rowSelector",          label: RECIPE_SHAPE.rowSelector,          optional: false },
  { key: "rowOpenSelector",      label: RECIPE_SHAPE.rowOpenSelector,      optional: false },
  { key: "revealEmailSelector",  label: RECIPE_SHAPE.revealEmailSelector,  optional: true  },
  { key: "revealPhoneSelector",  label: RECIPE_SHAPE.revealPhoneSelector,  optional: true  },
  { key: "nameSelector",         label: RECIPE_SHAPE.nameSelector,         optional: false },
  { key: "emailSelector",        label: RECIPE_SHAPE.emailSelector,        optional: false },
  { key: "phoneSelector",        label: RECIPE_SHAPE.phoneSelector,        optional: true  },
  { key: "closePanelSelector",   label: RECIPE_SHAPE.closePanelSelector,   optional: true  },
];

// ─── Disk paths ─────────────────────────────────────────────────────

function recipesDir() {
  const d = path.join(DEPS.userDataDir(), "recipes");
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

function runsDir() {
  const d = path.join(DEPS.userDataDir(), "scraper-runs");
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

function seenFile(recipeId) {
  return path.join(DEPS.userDataDir(), `scraper-seen-${recipeId}.json`);
}

// ─── Recipe storage ─────────────────────────────────────────────────

function listRecipes() {
  ensureSeeded();
  const dir = recipesDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const recipes = files.map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); }
    catch { return null; }
  }).filter(Boolean);
  recipes.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return { ok: true, recipes };
}

function readRecipe(id) {
  const p = path.join(recipesDir(), `${id}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function writeRecipe(recipe) {
  fs.writeFileSync(path.join(recipesDir(), `${recipe.id}.json`), JSON.stringify(recipe, null, 2));
}

function saveRecipe(patch) {
  if (!patch || !patch.id) return { ok: false, error: "missing_id" };
  const prev = readRecipe(patch.id);
  const merged = {
    id: patch.id,
    name: patch.name || prev?.name || "Untitled scraper",
    startUrl: patch.startUrl || prev?.startUrl || "",
    intervalMinutes: Number(patch.intervalMinutes ?? prev?.intervalMinutes ?? 60),
    enabled: patch.enabled != null ? !!patch.enabled : !!prev?.enabled,
    downloadDir: patch.downloadDir != null ? String(patch.downloadDir).trim() : (prev?.downloadDir || ""),
    selectors: {
      ...(prev?.selectors || {}),
      ...(patch.selectors || {}),
    },
    lastRunAt: prev?.lastRunAt || null,
    lastResult: prev?.lastResult || null,
    lastError: prev?.lastError || null,
    lastCount: prev?.lastCount ?? null,
    lastNewCount: prev?.lastNewCount ?? null,
    nextRunAt: prev?.nextRunAt || null,
    createdAt: prev?.createdAt || new Date().toISOString(),
    recipeVersion: (prev?.recipeVersion || 0) + (patch.selectors ? 1 : 0),
  };
  // Re-arm next-run when enabling a previously paused recipe so it
  // doesn't fire instantly the moment the toggle moves.
  if (merged.enabled && !prev?.enabled) {
    merged.nextRunAt = new Date(Date.now() + merged.intervalMinutes * 60000).toISOString();
  } else if (!merged.enabled) {
    merged.nextRunAt = null;
  }
  writeRecipe(merged);
  return { ok: true, recipe: merged };
}

function deleteRecipe(id) {
  const p = path.join(recipesDir(), `${id}.json`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  const s = seenFile(id);
  if (fs.existsSync(s)) fs.unlinkSync(s);
  return { ok: true };
}

function ensureSeeded() {
  const dir = recipesDir();
  if (fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length > 0) return;
  // First-run seed: an empty Indeed recipe, paused. Operator records
  // the click path once, flips Enabled, sets an interval.
  const seed = {
    id: "indeed-applicants",
    name: "Indeed — New applicants",
    startUrl: "https://employers.indeed.com/candidates",
    intervalMinutes: 60,
    enabled: false,
    downloadDir: "",
    selectors: {
      rowSelector: "",
      rowOpenSelector: "",
      revealEmailSelector: "",
      revealPhoneSelector: "",
      nameSelector: "",
      emailSelector: "",
      phoneSelector: "",
      closePanelSelector: "",
    },
    lastRunAt: null,
    lastResult: null,
    lastError: null,
    lastCount: null,
    lastNewCount: null,
    nextRunAt: null,
    createdAt: new Date().toISOString(),
    recipeVersion: 0,
  };
  writeRecipe(seed);
}

// ─── Dedupe / seen-set ──────────────────────────────────────────────

function readSeen(recipeId) {
  try { return JSON.parse(fs.readFileSync(seenFile(recipeId), "utf8")) || []; }
  catch { return []; }
}

function writeSeen(recipeId, keys) {
  // Cap at SEEN_LIMIT keeping the most-recent. Newer keys at end.
  const trimmed = keys.slice(-SEEN_LIMIT);
  try { fs.writeFileSync(seenFile(recipeId), JSON.stringify(trimmed)); }
  catch (e) { DEPS.logLine("scraper: writeSeen failed:", String(e)); }
}

// Stable dedupe key for an applicant row. Email wins (unique +
// portable); fall back to name+phone, then bare name. Lowercased and
// whitespace-collapsed so casing/formatting changes don't break it.
function rowKey(row) {
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (row.email) return `email:${norm(row.email)}`;
  if (row.name && row.phone) return `np:${norm(row.name)}|${norm(row.phone)}`;
  if (row.name) return `name:${norm(row.name)}`;
  return null;
}

// ─── Page-injected recorder script ──────────────────────────────────
// Returns a self-contained IIFE the recorder injects into the page via
// addInitScript. It draws a fixed-position toolbar across the top,
// captures clicks (suppressing the page's own handlers), derives a
// CSS selector for the clicked element, and hands the result back to
// the Electron side via window.__rrRecord (exposeBinding).

function buildPickerScript() {
  return `
(() => {
  if (window.__rr_recorder_active) return;
  window.__rr_recorder_active = true;

  const STEPS = ${JSON.stringify(RECORDER_STEPS)};
  let idx = 0;
  const captured = {};

  // Build a reasonably-stable CSS selector for the element. Prefers
  // data-testid / id; falls back to a class+:nth-of-type path with a
  // depth cap so the selector doesn't get pathologically long.
  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/([!"#$%&'()*+,./:;<=>?@\\[\\\\\\]^\`{|}~])/g, "\\\\$1");
  }
  function badClass(c) {
    return !/^[A-Za-z][\\w-]*$/.test(c) ||
           /^(is-|js-|active|hover|focus|selected|highlight|css-)/i.test(c);
  }
  function cssPath(el) {
    if (!(el instanceof Element)) return "";
    if (el.dataset && el.dataset.testid) return '[data-testid="' + cssEscape(el.dataset.testid) + '"]';
    if (el.id && !/^[0-9]/.test(el.id)) return "#" + cssEscape(el.id);
    const parts = [];
    let node = el, depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      if (node.dataset && node.dataset.testid) { parts.unshift('[data-testid="' + cssEscape(node.dataset.testid) + '"]'); break; }
      if (node.id && !/^[0-9]/.test(node.id)) { parts.unshift("#" + cssEscape(node.id)); break; }
      let part = node.tagName.toLowerCase();
      const classes = node.classList ? [...node.classList].filter((c) => !badClass(c)).slice(0, 2) : [];
      if (classes.length) part += "." + classes.map(cssEscape).join(".");
      if (node.parentElement) {
        const sibs = [...node.parentElement.children].filter((s) => s.tagName === node.tagName);
        if (sibs.length > 1) part += ":nth-of-type(" + (sibs.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      if (!node.parentElement || node.parentElement === document.documentElement) break;
      node = node.parentElement;
      depth++;
    }
    return parts.join(" > ");
  }

  const BAR_ID = "__rr_recorder_bar";
  const bar = document.createElement("div");
  bar.id = BAR_ID;
  bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:linear-gradient(180deg,#2563EB,#0B5BA1);color:#fff;padding:14px 18px;font:14px/1.4 system-ui,-apple-system,sans-serif;display:flex;align-items:center;gap:12px;box-shadow:0 4px 18px rgba(0,0,0,.35);box-sizing:border-box;";
  document.documentElement.appendChild(bar);

  // Reserve space at top of page so the bar doesn't cover navigation
  // (Indeed's header is fixed). Re-applies on every render in case the
  // page mutates the body style.
  function reserveTop() {
    document.documentElement.style.paddingTop = "56px";
    document.documentElement.style.boxSizing = "border-box";
  }

  function render() {
    reserveTop();
    if (idx >= STEPS.length) {
      bar.innerHTML = '<span style="font-weight:600">Recipe captured ✓</span><span style="opacity:.9">Returning to RouteReady…</span>';
      try { window.__rrRecord({ kind: "done", captured }); } catch (e) {}
      return;
    }
    const step = STEPS[idx];
    const skipBtn = step.optional
      ? '<button data-rr="skip" style="background:rgba(255,255,255,.18);color:#fff;border:1px solid rgba(255,255,255,.4);padding:5px 12px;border-radius:6px;cursor:pointer;font:inherit">Skip</button>'
      : "";
    bar.innerHTML =
      '<span style="font-weight:700;letter-spacing:.02em">RouteReady recorder</span>' +
      '<span style="opacity:.7">' + (idx + 1) + " / " + STEPS.length + "</span>" +
      '<span style="flex:1;font-weight:500">Click the page element → ' + escapeHtml(step.label) + "</span>" +
      skipBtn +
      '<button data-rr="cancel" style="background:rgba(255,255,255,.1);color:#fff;border:1px solid rgba(255,255,255,.4);padding:5px 12px;border-radius:6px;cursor:pointer;font:inherit">Cancel</button>';
    const skipEl = bar.querySelector('[data-rr="skip"]');
    if (skipEl) skipEl.addEventListener("click", (e) => { e.stopPropagation(); captured[step.key] = ""; idx++; render(); });
    bar.querySelector('[data-rr="cancel"]').addEventListener("click", (e) => { e.stopPropagation(); try { window.__rrRecord({ kind: "cancel" }); } catch (err) {} });
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  render();

  // Hover outline so the operator can see what's about to be picked.
  let hovered = null;
  function clearHover() {
    if (hovered) { try { hovered.style.outline = hovered.__rrPrevOutline || ""; } catch (e) {} hovered = null; }
  }
  document.addEventListener("mouseover", (e) => {
    if (!e.target || e.target.closest("#" + BAR_ID)) return;
    clearHover();
    hovered = e.target;
    try { hovered.__rrPrevOutline = hovered.style.outline; hovered.style.outline = "2px solid #ff2d92"; } catch (err) {}
  }, true);
  document.addEventListener("mouseout", (e) => { clearHover(); }, true);

  // Capture-phase click handler. preventDefault + stopImmediatePropagation
  // so the page's own click handlers don't fire — we're just borrowing
  // the cursor, not actually navigating.
  document.addEventListener("click", (e) => {
    if (!e.target || e.target.closest("#" + BAR_ID)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const step = STEPS[idx];
    const sel = cssPath(e.target);
    captured[step.key] = sel;
    clearHover();
    idx++;
    render();
  }, true);
})();
`;
}

// ─── Recorder ───────────────────────────────────────────────────────
// Launch a headed browser pointed at the recipe's startUrl with the
// saved portal session, inject the picker, await results.

async function beginRecording(id) {
  const recipe = readRecipe(id);
  if (!recipe) return { ok: false, error: "no_recipe" };
  if (!recipe.startUrl) return { ok: false, error: "missing_start_url" };
  if (!DEPS.readSession()) {
    return { ok: false, error: "no_session", message: "Sign in to the portal first (section 1) — the recorder needs your session to land on the applicants page, not the login page." };
  }
  // Tear down any existing portal context so the headed launch can win
  // the focus + cookie scope without contention.
  try { await DEPS.tearDownPortal(); } catch {}

  const browser = await DEPS.launchChromium({ headless: false });
  const stateJson = DEPS.readSession();
  const context = await browser.newContext({
    storageState: stateJson ? JSON.parse(stateJson) : undefined,
    viewport: { width: 1280, height: 800 },
  });

  // exposeBinding gives the page a real callable that pipes its arg
  // back to us — used by the picker to ship the captured recipe out.
  let captured = null;
  let cancelled = false;
  const done = new Promise((resolve) => {
    context.exposeBinding("__rrRecord", (_src, payload) => {
      if (payload && payload.kind === "done") {
        captured = payload.captured || {};
        resolve("done");
      } else if (payload && payload.kind === "cancel") {
        cancelled = true;
        resolve("cancel");
      }
    });
  });

  // addInitScript fires on every new document — covers SPA navigations
  // inside Indeed without us re-injecting per page.
  await context.addInitScript({ content: buildPickerScript() });

  const page = await context.newPage();
  let navError = null;
  try {
    await page.goto(recipe.startUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    DEPS.logLine("scraper: recorder navigated to", page.url());
  } catch (e) {
    navError = String(e?.message || e);
    DEPS.logLine("scraper: recorder goto failed:", navError);
  }

  // Belt-and-suspenders: also evaluate the picker on the loaded page.
  // addInitScript SHOULD have already injected on document creation, but
  // when the operator reports "page loaded, no pink toolbar," the only
  // remaining failure mode is the init script didn't take. A second
  // evaluate() runs against the document we can see, no race. The
  // picker's own __rr_recorder_active guard makes this idempotent.
  try {
    await page.evaluate(buildPickerScript());
    DEPS.logLine("scraper: recorder picker re-injected via evaluate()");
  } catch (e) {
    DEPS.logLine("scraper: re-inject evaluate threw:", String(e?.message || e));
  }

  // Race against the page being closed (operator just hit the X).
  const onClose = new Promise((resolve) => page.on("close", () => resolve("closed")));
  const outcome = await Promise.race([done, onClose]);

  try { await context.close(); } catch {}
  try { await browser.close(); } catch {}

  if (cancelled || outcome === "closed") {
    return { ok: false, cancelled: true, error: "cancelled" };
  }
  if (!captured) {
    return { ok: false, error: "no_capture", message: navError || "Recorder closed without capturing a recipe." };
  }

  const next = saveRecipe({ id, selectors: captured });
  emitRecipeUpdated(id);
  return { ok: true, recipe: next.recipe };
}

// ─── Replay ─────────────────────────────────────────────────────────
// Headless walk: load startUrl, find rows via rowSelector, for each row
// click rowOpenSelector, optionally click reveal-{email,phone} buttons,
// pull text from name/email/phone selectors, optionally click close.

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jitter() { return Math.floor(ROW_PAUSE_MIN + Math.random() * (ROW_PAUSE_MAX - ROW_PAUSE_MIN)); }

async function safeText(page, selector) {
  if (!selector) return "";
  try {
    const t = await page.textContent(selector, { timeout: 4000 });
    return (t || "").replace(/\s+/g, " ").trim();
  } catch { return ""; }
}

async function safeClick(page, selector, opts = {}) {
  if (!selector) return false;
  try { await page.click(selector, { timeout: opts.timeout || 4000 }); return true; }
  catch { return false; }
}

async function runRecipe(id, { manual = false } = {}) {
  const recipe = readRecipe(id);
  if (!recipe) return { ok: false, error: "no_recipe" };
  const sel = recipe.selectors || {};
  if (!sel.rowSelector || !sel.nameSelector || !sel.emailSelector) {
    return { ok: false, error: "recipe_incomplete", message: "Recipe needs at least row, name, and email selectors. Hit Re-record." };
  }
  if (!DEPS.readSession()) {
    return { ok: false, error: "no_session", message: "No saved portal session — sign in first." };
  }
  const browser = await DEPS.launchChromium({ headless: true });
  const stateJson = DEPS.readSession();
  const context = await browser.newContext({
    storageState: stateJson ? JSON.parse(stateJson) : undefined,
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const rows = [];
  const errors = [];
  try {
    await page.goto(recipe.startUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    // Wait for the row selector to appear at least once before
    // assuming the page hasn't rendered yet.
    try { await page.waitForSelector(sel.rowSelector, { timeout: 12000 }); }
    catch { /* fall through — we'll just get zero rows */ }

    // Snapshot the row count up front. Re-querying inside the loop
    // because clicking a row often re-renders the list and detaches
    // the prior NodeList.
    const initialCount = await page.locator(sel.rowSelector).count();
    for (let i = 0; i < initialCount; i++) {
      try {
        const row = page.locator(sel.rowSelector).nth(i);
        if (sel.rowOpenSelector) {
          await row.locator(sel.rowOpenSelector).first().click({ timeout: 6000 });
        } else {
          await row.click({ timeout: 6000 });
        }
        await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
        await safeClick(page, sel.revealEmailSelector);
        await safeClick(page, sel.revealPhoneSelector);
        await sleep(400);
        const entry = {
          name: await safeText(page, sel.nameSelector),
          email: await safeText(page, sel.emailSelector),
          phone: await safeText(page, sel.phoneSelector),
          scrapedAt: new Date().toISOString(),
        };
        if (entry.name || entry.email) rows.push(entry);
        await safeClick(page, sel.closePanelSelector);
        await sleep(jitter());
      } catch (e) {
        errors.push({ row: i, error: String(e?.message || e) });
      }
    }
  } catch (e) {
    errors.push({ row: -1, error: String(e?.message || e) });
  } finally {
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }

  // Dedupe against seen-set
  const seen = new Set(readSeen(id));
  const newRows = [];
  for (const r of rows) {
    const k = rowKey(r);
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    newRows.push(r);
  }
  writeSeen(id, [...seen]);

  // Write CSV — always one per run, even if zero new rows, so the
  // operator can see history. Empty file gets just the header.
  const dir = recipe.downloadDir || DEPS.defaultDownloadDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const csvPath = path.join(dir, `${id}-${stamp}.csv`);
  const csv = ["name,email,phone,scraped_at"]
    .concat(newRows.map((r) =>
      [r.name, r.email, r.phone, r.scrapedAt].map(csvCell).join(",")
    )).join("\n");
  try { fs.writeFileSync(csvPath, csv); } catch (e) {
    errors.push({ row: -1, error: "write_csv: " + String(e?.message || e) });
  }

  // Persist run summary + update recipe stats
  const summary = {
    ts: new Date().toISOString(),
    recipeId: id,
    total: rows.length,
    newCount: newRows.length,
    errors: errors.length,
    csvPath,
    manual,
  };
  try {
    const sumPath = path.join(runsDir(), `${id}-${stamp}.json`);
    fs.writeFileSync(sumPath, JSON.stringify({ ...summary, rows: newRows, errorDetail: errors }, null, 2));
  } catch {}

  const updatedRecipe = saveRecipe({ id });  // touch
  const next = readRecipe(id);
  next.lastRunAt = summary.ts;
  next.lastResult = errors.length === 0 ? "ok" : (rows.length === 0 ? "error" : "partial");
  next.lastError = errors.length === 0 ? null : (errors[0]?.error || "see run log");
  next.lastCount = rows.length;
  next.lastNewCount = newRows.length;
  if (next.intervalMinutes > 0 && next.enabled) {
    next.nextRunAt = new Date(Date.now() + next.intervalMinutes * 60000).toISOString();
  }
  writeRecipe(next);
  emitRecipeUpdated(id);

  // Push a row into the existing download-history so the main app's
  // history list reflects scraper output too.
  DEPS.appendHistory({
    ts: summary.ts,
    url: recipe.startUrl,
    clickSelector: `scrape:${recipe.name}`,
    filePath: csvPath,
    suggestedName: path.basename(csvPath),
    size: (csv && csv.length) || 0,
    source: manual ? "scraper-manual" : "scraper",
  });

  return { ok: true, ...summary };
}

// ─── Scheduler ──────────────────────────────────────────────────────

const running = new Set();
let tickHandle = null;

function emitRecipeUpdated(id) {
  try { DEPS.getMainWindow()?.webContents.send("scraper:recipeUpdated", { id }); } catch {}
}

async function tick() {
  const dir = recipesDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const now = Date.now();
  for (const f of files) {
    let recipe;
    try { recipe = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); }
    catch { continue; }
    if (!recipe.enabled) continue;
    if (running.has(recipe.id)) continue;
    if (!recipe.intervalMinutes || recipe.intervalMinutes <= 0) continue;
    const due = !recipe.nextRunAt || new Date(recipe.nextRunAt).getTime() <= now;
    if (!due) continue;
    if (!DEPS.readSession()) {
      DEPS.logLine("scraper: skip", recipe.id, "(no portal session)");
      continue;
    }
    running.add(recipe.id);
    runRecipe(recipe.id, { manual: false })
      .catch((e) => DEPS.logLine("scraper: run threw:", recipe.id, String(e)))
      .finally(() => running.delete(recipe.id));
  }
}

function startLoop() {
  if (tickHandle) return;
  tickHandle = setInterval(tick, TICK_MS);
  setTimeout(tick, 8000);
}

// ─── IPC wiring ─────────────────────────────────────────────────────

function init(deps) {
  DEPS = deps;
  ensureSeeded();
  startLoop();

  ipcMain.handle("scraper:list", async () => listRecipes());
  ipcMain.handle("scraper:get", async (_e, { id }) => {
    const r = readRecipe(id);
    return r ? { ok: true, recipe: r } : { ok: false, error: "no_recipe" };
  });
  ipcMain.handle("scraper:save", async (_e, patch) => saveRecipe(patch));
  ipcMain.handle("scraper:delete", async (_e, { id }) => deleteRecipe(id));
  ipcMain.handle("scraper:record", async (_e, { id }) => {
    // Wrap so any uncaught throw from beginRecording (Chromium launch
    // failure, addInitScript failure, etc.) returns as a structured
    // result instead of an unhandled IPC rejection — otherwise the
    // renderer just sees a thrown error with no message in the
    // activity log and the operator has no idea what went wrong.
    try {
      return await beginRecording(id);
    } catch (e) {
      const msg = String(e?.message || e);
      DEPS.logLine("scraper:record threw:", msg, e?.stack || "");
      return { ok: false, error: "record_threw", message: msg };
    }
  });
  ipcMain.handle("scraper:runNow", async (_e, { id }) => {
    if (running.has(id)) return { ok: false, error: "already_running" };
    running.add(id);
    try { return await runRecipe(id, { manual: true }); }
    finally { running.delete(id); }
  });
  ipcMain.handle("scraper:resetSeen", async (_e, { id }) => {
    const s = seenFile(id);
    if (fs.existsSync(s)) fs.unlinkSync(s);
    return { ok: true };
  });
}

// ─── CSV escaping ───────────────────────────────────────────────────

function csvCell(v) {
  const s = String(v == null ? "" : v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

module.exports = { init };
