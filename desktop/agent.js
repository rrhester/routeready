// RouteReady Desktop · agentic browser-automation engine.
//
// Where scraper.js replays a fixed click-path the operator recorded,
// this module hands a *goal* to Claude and lets it drive the portal
// itself: it reads a structured snapshot of the live page (an
// accessibility-style tree with element refs), decides the next action
// (click / type / scroll / navigate), and extracts the records it was
// asked for. Because it reasons over the page instead of replaying
// brittle CSS selectors, it survives layout changes with no re-record.
//
// Pipeline this implements (the "what's next" RouteReady upload, agentic):
//   1. DSP signs into the portal  (main.js — headed login, saved session)
//   2. Agent crawls the page, finds the records  (this file)
//   3. Rows are written to CSV *and* (optionally) POSTed into RouteReady
//      via the public webhook-apply edge function → intake_applicant(),
//      which dedupes by email / source_ref per DSP.
//
// Transport note: inference runs through the operator's own Anthropic
// API key, stored encrypted in the OS keychain exactly like the portal
// session. callModel() is the single seam — point it at a RouteReady
// Supabase proxy later if we want RouteReady to hold the key + pay.

const { ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const Anthropic = require("@anthropic-ai/sdk");

let DEPS = null;

// ─── Tunables ───────────────────────────────────────────────────────
// Default to Sonnet, not Opus: an agent crawl is "read the page, click,
// extract" — not deep reasoning — so Sonnet handles it well at ~1.7x less
// than Opus (Haiku is cheaper still for simple/stable pages). Per-task
// overridable; reserve Opus for genuinely tricky portals. See ROADMAP.md
// (AI cost model).
const DEFAULT_MODEL = "claude-sonnet-4-6";   // was claude-opus-4-8 — cost
const DEFAULT_EFFORT = "medium";             // cost/quality balance for repetitive crawls
const MAX_STEPS = 40;                          // hard cap on agent tool-iterations per run
const MAX_TOKENS = 16000;                       // per-turn output cap (non-streaming, under HTTP timeout)
const TICK_MS = 30000;                          // scheduler cadence
const SEEN_LIMIT = 5000;                        // dedupe ring cap per task
const SNAPSHOT_CHAR_CAP = 14000;                // bound the page snapshot we feed the model

// ─── Disk paths ─────────────────────────────────────────────────────
function tasksDir() {
  const d = path.join(DEPS.userDataDir(), "agent-tasks");
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}
function runsDir() {
  const d = path.join(DEPS.userDataDir(), "agent-runs");
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}
function seenFile(id) { return path.join(DEPS.userDataDir(), `agent-seen-${id}.json`); }
function configFile() { return path.join(DEPS.userDataDir(), "agent-config.json"); }
function keyFile() { return path.join(DEPS.userDataDir(), "agent-key.enc"); }
function applySecretFile() { return path.join(DEPS.userDataDir(), "agent-apply-secret.enc"); }

// ─── Encrypted-secret helpers (mirror main.js session enc) ──────────
function writeSecret(file, str) {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(file, safeStorage.encryptString(str));
      // Drop any stale plaintext fallback so the two can't disagree.
      try { if (fs.existsSync(file + ".plain")) fs.unlinkSync(file + ".plain"); } catch {}
      return;
    }
  } catch (e) { DEPS.logLine("agent: encrypt failed, plaintext fallback:", String(e)); }
  fs.writeFileSync(file + ".plain", str);
}
function readSecret(file) {
  if (fs.existsSync(file) && safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(fs.readFileSync(file)); } catch {}
  }
  if (fs.existsSync(file + ".plain")) return fs.readFileSync(file + ".plain", "utf8");
  return null;
}
function clearSecret(file) {
  for (const f of [file, file + ".plain"]) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} }
}

// ─── Config (non-secret bits on disk; key + apply secret encrypted) ──
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), "utf8")) || {}; } catch { return {}; }
}
function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  try { fs.writeFileSync(configFile(), JSON.stringify(next, null, 2)); } catch (e) {
    DEPS.logLine("agent: config write failed:", String(e));
  }
  return next;
}
function effectiveModel(task) {
  return (task && task.model) || readConfig().model || DEFAULT_MODEL;
}
function effectiveEffort(task) {
  return (task && task.effort) || readConfig().effort || DEFAULT_EFFORT;
}

// ─── Task storage ───────────────────────────────────────────────────
function readTask(id) {
  const p = path.join(tasksDir(), `${id}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}
function writeTask(task) {
  fs.writeFileSync(path.join(tasksDir(), `${task.id}.json`), JSON.stringify(task, null, 2));
}
function listTasks() {
  ensureSeeded();
  const dir = tasksDir();
  const tasks = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; }
  }).filter(Boolean);
  tasks.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return { ok: true, tasks };
}
// ─── Scheduling: clock times (preferred) or interval (fallback) ─────
// dailyTimes are "HH:MM" in the machine's LOCAL time — and since the box
// sits at the DSP, local time IS the DSP's time, so "18:00" means their 6pm.
function normTimes(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const t of arr) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
    if (!m) continue;
    const h = +m[1], min = +m[2];
    if (h > 23 || min > 59) continue;
    out.push(`${String(h).padStart(2, "0")}:${m[2]}`);
  }
  // de-dupe + sort for stable display
  return [...new Set(out)].sort();
}

// Soonest upcoming Date for a set of daily clock times (today if still ahead,
// else tomorrow). Returns null if no valid times.
function nextRunForTimes(times) {
  const valid = normTimes(times);
  if (!valid.length) return null;
  const now = new Date();
  let best = null;
  for (const t of valid) {
    const [h, min] = t.split(":").map(Number);
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    if (!best || d < best) best = d;
  }
  return best;
}

// Next run for a task: clock times if set, otherwise the interval.
function computeNextRunAt(task) {
  if (Array.isArray(task.dailyTimes) && task.dailyTimes.length) {
    const d = nextRunForTimes(task.dailyTimes);
    return d ? d.toISOString() : null;
  }
  if (task.intervalMinutes > 0) {
    return new Date(Date.now() + task.intervalMinutes * 60000).toISOString();
  }
  return null;
}

function saveTask(patch) {
  if (!patch || !patch.id) return { ok: false, error: "missing_id" };
  const prev = readTask(patch.id);
  const merged = {
    id: patch.id,
    name: patch.name || prev?.name || "Untitled task",
    goal: patch.goal != null ? String(patch.goal) : (prev?.goal || ""),
    startUrl: patch.startUrl != null ? String(patch.startUrl).trim() : (prev?.startUrl || ""),
    intervalMinutes: Number(patch.intervalMinutes ?? prev?.intervalMinutes ?? 60),
    dailyTimes: patch.dailyTimes != null ? normTimes(patch.dailyTimes) : (prev?.dailyTimes || []),
    enabled: patch.enabled != null ? !!patch.enabled : !!prev?.enabled,
    downloadDir: patch.downloadDir != null ? String(patch.downloadDir).trim() : (prev?.downloadDir || ""),
    uploadToRouteReady: patch.uploadToRouteReady != null ? !!patch.uploadToRouteReady : !!prev?.uploadToRouteReady,
    visibleBrowser: patch.visibleBrowser != null ? !!patch.visibleBrowser : !!prev?.visibleBrowser,
    model: patch.model != null ? (String(patch.model).trim() || null) : (prev?.model ?? null),
    effort: patch.effort != null ? (String(patch.effort).trim() || null) : (prev?.effort ?? null),
    // Learn-once → replay: preserve the learned recipe across UI saves; replay
    // is on by default (set replayEnabled:false to force the AI every run).
    recipe: patch.recipe !== undefined ? patch.recipe : (prev?.recipe || null),
    replayEnabled: patch.replayEnabled != null ? !!patch.replayEnabled : (prev?.replayEnabled !== false),
    lastRunAt: prev?.lastRunAt || null,
    lastResult: prev?.lastResult || null,
    lastError: prev?.lastError || null,
    lastCount: prev?.lastCount ?? null,
    lastNewCount: prev?.lastNewCount ?? null,
    lastUploaded: prev?.lastUploaded ?? null,
    lastSummary: prev?.lastSummary || null,
    nextRunAt: prev?.nextRunAt || null,
    createdAt: prev?.createdAt || new Date().toISOString(),
  };
  // Re-arm next-run from the schedule (clock times if set, else interval)
  // whenever the task is enabled, so edits to times/interval take effect now.
  merged.nextRunAt = merged.enabled ? computeNextRunAt(merged) : null;
  writeTask(merged);
  return { ok: true, task: merged };
}
function deleteTask(id) {
  try { fs.unlinkSync(path.join(tasksDir(), `${id}.json`)); } catch {}
  clearSecretSeen(id);
  return { ok: true };
}
function clearSecretSeen(id) { try { if (fs.existsSync(seenFile(id))) fs.unlinkSync(seenFile(id)); } catch {} }

function ensureSeeded() {
  const dir = tasksDir();
  if (fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length > 0) return;
  // Benign shakedown task — a public, no-login demo site so a new operator
  // can validate the whole crawl→extract loop with just an API key, before
  // pointing it at a real portal with live PII. Upload stays OFF.
  writeTask({
    id: "shakedown-public-demo",
    name: "Shakedown — public demo (no login)",
    goal:
      "This is a TEST run on a public demo bookstore (no login needed). " +
      "Find every book listed on the current page. Use the `extract` tool: set " +
      "rowSelector to each book's container and a fields map with `name` → the " +
      "title selector and `price` → the price selector (relative to the row). " +
      "You do NOT need to paginate — just the books on this first page is enough " +
      "for the test. After extract returns a good sample, call done with status " +
      "'complete'. (Using extract here also lets future runs replay for free.)",
    startUrl: "https://books.toscrape.com/",
    intervalMinutes: 60,
    enabled: false,
    downloadDir: "",
    uploadToRouteReady: false,
    visibleBrowser: false,
    model: null,
    effort: null,
    lastRunAt: null, lastResult: null, lastError: null,
    lastCount: null, lastNewCount: null, lastUploaded: null, lastSummary: null,
    nextRunAt: null, createdAt: new Date().toISOString(),
  });
  writeTask({
    id: "indeed-applicants-agent",
    name: "Indeed — applicants (AI agent)",
    goal:
      "Find the list of job applicants/candidates on this page. For each " +
      "applicant, open or expand their entry as needed, reveal and read " +
      "their full name, email address, and phone number, then record them " +
      "with save_rows. Page through the whole list if it is paginated. " +
      "Only record people who are actually shown on the page — never guess " +
      "or fabricate contact details.",
    startUrl: "https://employers.indeed.com/candidates",
    intervalMinutes: 60,
    enabled: false,
    downloadDir: "",
    uploadToRouteReady: false,
    visibleBrowser: true,
    model: null,
    effort: null,
    lastRunAt: null, lastResult: null, lastError: null,
    lastCount: null, lastNewCount: null, lastUploaded: null, lastSummary: null,
    nextRunAt: null, createdAt: new Date().toISOString(),
  });
}

// ─── Dedupe / seen-set (shared shape with scraper.js) ───────────────
function readSeen(id) {
  try { return JSON.parse(fs.readFileSync(seenFile(id), "utf8")) || []; } catch { return []; }
}
function writeSeen(id, keys) {
  try { fs.writeFileSync(seenFile(id), JSON.stringify(keys.slice(-SEEN_LIMIT))); }
  catch (e) { DEPS.logLine("agent: writeSeen failed:", String(e)); }
}
function rowKey(row) {
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (row.email) return `email:${norm(row.email)}`;
  if (row.name && row.phone) return `np:${norm(row.name)}|${norm(row.phone)}`;
  if (row.name) return `name:${norm(row.name)}`;
  return null;
}

// ─── In-page snapshot (runs inside the portal page) ─────────────────
// Tags every interactive / named element with data-rr-ref and returns a
// compact, indented accessibility-ish tree. Refs are only valid for the
// snapshot that produced them — every action re-snapshots so the model
// always acts on fresh refs.
function snapshotScript() {
  return () => {
    document.querySelectorAll("[data-rr-ref]").forEach((e) => e.removeAttribute("data-rr-ref"));
    const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "PATH", "HEAD", "META", "LINK", "TEMPLATE"]);
    const lines = [];
    let counter = 0, truncated = false;
    const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
    function visible(el) {
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || s.display === "none" || s.opacity === "0") return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    }
    function role(el) {
      const r = el.getAttribute("role");
      if (r) return r;
      const t = el.tagName;
      if (t === "A") return "link";
      if (t === "BUTTON") return "button";
      if (t === "SELECT") return "combobox";
      if (t === "TEXTAREA") return "textbox";
      if (t === "INPUT") {
        const it = (el.getAttribute("type") || "text").toLowerCase();
        if (it === "checkbox") return "checkbox";
        if (it === "radio") return "radio";
        if (it === "button" || it === "submit") return "button";
        return "textbox";
      }
      if (/^H[1-6]$/.test(t)) return "heading";
      return null;
    }
    function interactive(el) {
      const t = el.tagName;
      if (t === "A" || t === "BUTTON" || t === "INPUT" || t === "SELECT" || t === "TEXTAREA") return true;
      const r = el.getAttribute("role");
      if (r && /button|link|checkbox|radio|tab|menuitem|option|switch/.test(r)) return true;
      if (el.hasAttribute("onclick")) return true;
      if (el.isContentEditable) return true;
      const ti = el.getAttribute("tabindex");
      if (ti != null && ti !== "-1") return true;
      return false;
    }
    function name(el) {
      const aria = el.getAttribute("aria-label");
      if (aria) return clip(aria, 120);
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        const v = el.value || el.getAttribute("placeholder") || "";
        return clip(v, 120);
      }
      const alt = el.getAttribute("alt") || el.getAttribute("title");
      if (alt) return clip(alt, 120);
      return clip(el.innerText || el.textContent || "", 120);
    }
    function directText(el) {
      let t = "";
      for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
      return clip(t, 200);
    }
    function walk(el, depth) {
      if (truncated) return;
      for (const child of el.children) {
        if (truncated) return;
        if (SKIP.has(child.tagName) || !visible(child)) continue;
        let emitted = false;
        if (interactive(child)) {
          const ref = "e" + ++counter;
          child.setAttribute("data-rr-ref", ref);
          const nm = name(child);
          lines.push("  ".repeat(depth) + `[${ref}] ${role(child) || "control"}${nm ? ' "' + nm + '"' : ""}`);
          emitted = true;
        } else {
          const r = role(child);
          const txt = directText(child);
          if (txt && (r === "heading" || !child.querySelector("*"))) {
            lines.push("  ".repeat(depth) + (r === "heading" ? `heading "${txt}"` : `text "${txt}"`));
            emitted = true;
          }
        }
        if (lines.join("\n").length > 14000) { truncated = true; return; }
        walk(child, emitted ? depth + 1 : depth);
      }
    }
    walk(document.body, 0);
    return { url: location.href, title: document.title, tree: lines.join("\n"), truncated, refs: counter };
  };
}

async function takeSnapshot(page) {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 4000 }).catch(() => {});
    const snap = await page.evaluate(snapshotScript());
    let tree = snap.tree || "(no visible interactive elements)";
    if (tree.length > SNAPSHOT_CHAR_CAP) tree = tree.slice(0, SNAPSHOT_CHAR_CAP) + "\n…(snapshot truncated)";
    return `URL: ${snap.url}\nTitle: ${snap.title}\n${snap.refs} interactive elements\n\n${tree}` +
      (snap.truncated ? "\n\n(page is large — scroll for more)" : "");
  } catch (e) {
    return `Snapshot failed: ${String(e?.message || e)}`;
  }
}

function refSel(ref) {
  // Defend against the model handing back "e12" vs "[ref=e12]" etc.
  const m = String(ref || "").match(/e\d+/);
  return m ? `[data-rr-ref="${m[0]}"]` : null;
}

// ─── Learn-once → replay-cheap (ROADMAP #5) ─────────────────────────
// In-page: compute a reasonably stable CSS selector for the element tagged
// with the given ephemeral ref. The ref itself is throwaway (reassigned every
// snapshot), so when the agent acts on an element we resolve it to a DURABLE
// selector (data-testid / id / class+nth path) and record THAT into the recipe
// — that's what makes a future run replayable without the model. Mirrors the
// recorder's cssPath logic in scraper.js.
function cssPathInPage(refValue) {
  const el = document.querySelector('[data-rr-ref="' + refValue + '"]');
  if (!el) return null;
  const esc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  const bad = (c) => !/^[A-Za-z][\w-]*$/.test(c) || /^(is-|js-|active|hover|focus|selected|highlight|css-)/i.test(c);
  if (el.dataset && el.dataset.testid) return '[data-testid="' + esc(el.dataset.testid) + '"]';
  if (el.id && !/^[0-9]/.test(el.id)) return "#" + esc(el.id);
  const parts = [];
  let node = el, depth = 0;
  while (node && node.nodeType === 1 && depth < 6) {
    if (node.dataset && node.dataset.testid) { parts.unshift('[data-testid="' + esc(node.dataset.testid) + '"]'); break; }
    if (node.id && !/^[0-9]/.test(node.id)) { parts.unshift("#" + esc(node.id)); break; }
    let part = node.tagName.toLowerCase();
    const classes = node.classList ? [...node.classList].filter((c) => !bad(c)).slice(0, 2) : [];
    if (classes.length) part += "." + classes.map(esc).join(".");
    if (node.parentElement) {
      const sibs = [...node.parentElement.children].filter((s) => s.tagName === node.tagName);
      if (sibs.length > 1) part += ":nth-of-type(" + (sibs.indexOf(node) + 1) + ")";
    }
    parts.unshift(part);
    if (!node.parentElement || node.parentElement === document.documentElement) break;
    node = node.parentElement; depth++;
  }
  return parts.join(" > ");
}

// In-page: deterministic, selector-driven extraction. For each element matching
// rowSelector, read each field via a selector RELATIVE to the row. Handles
// mailto:/tel: links and input values. Returns { rows, matched } or { error }.
function extractInPage(args) {
  const rowSelector = args.rowSelector, fields = args.fields || {};
  const clip = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  function readEl(el) {
    if (!el) return "";
    const tag = el.tagName;
    if (tag === "A") {
      const href = el.getAttribute("href") || "";
      if (/^mailto:/i.test(href)) return clip(decodeURIComponent(href.replace(/^mailto:/i, "").split("?")[0]));
      if (/^tel:/i.test(href)) return clip(href.replace(/^tel:/i, ""));
    }
    if (tag === "INPUT" || tag === "TEXTAREA") return clip(el.value || el.getAttribute("placeholder") || "");
    return clip(el.innerText || el.textContent || "");
  }
  let rowEls;
  try { rowEls = Array.from(document.querySelectorAll(rowSelector)); }
  catch (e) { return { error: "bad rowSelector: " + e.message }; }
  const out = [];
  for (const row of rowEls) {
    const rec = {};
    for (const k of Object.keys(fields)) {
      const sel = fields[k];
      let el = null;
      try { el = sel ? (row.querySelector(sel) || (row.matches(sel) ? row : null)) : null; }
      catch (e) { return { error: "bad field selector for " + k + ": " + e.message }; }
      rec[k] = readEl(el);
    }
    out.push(rec);
  }
  return { rows: out, matched: rowEls.length };
}

// Node-side: resolve an ephemeral ref to a durable selector (for the recipe).
async function stableSelectorForRef(page, ref) {
  const m = String(ref || "").match(/e\d+/);
  if (!m) return null;
  try { return await page.evaluate(cssPathInPage, m[0]); } catch { return null; }
}

// Map a raw extracted record (flat field→text) into our row shape: known
// fields at the top level, everything else under `extra`.
function shapeRow(rec) {
  const KNOWN = new Set(["name", "email", "phone"]);
  const row = { extra: {} };
  for (const k of Object.keys(rec)) { if (KNOWN.has(k)) row[k] = rec[k]; else row.extra[k] = rec[k]; }
  if (!Object.keys(row.extra).length) delete row.extra;
  return row;
}

// Node-side: run extractInPage, dedupe + collect, return a model-facing
// summary. Records the step into control.trace when learning (AI path).
async function runExtract(page, input, collected, control) {
  const rowSelector = String(input.rowSelector || "").trim();
  const fields = (input.fields && typeof input.fields === "object") ? input.fields : {};
  if (!rowSelector || !Object.keys(fields).length) return "extract needs a rowSelector and at least one field selector.";
  let res;
  try { res = await page.evaluate(extractInPage, { rowSelector, fields }); }
  catch (e) { return `extract failed: ${String(e?.message || e)}. Take a fresh snapshot.`; }
  if (res.error) return `extract: ${res.error}. Take a fresh snapshot and fix the selector.`;
  if (!res.matched) return `extract: rowSelector "${rowSelector}" matched 0 elements. Take a fresh snapshot and pick a selector that matches each record.`;
  let added = 0; const sample = [];
  for (const rec of res.rows) {
    const row = shapeRow(rec);
    if (sample.length < 3) sample.push(row);
    const key = rowKey(row);
    if (!key) continue;
    if (control.seen.has(key)) continue;
    control.seen.add(key);
    collected.push({ ...row, scrapedAt: new Date().toISOString() });
    added++;
  }
  if (Array.isArray(control.trace)) control.trace.push({ action: "extract", rowSelector, fields });
  return `extract matched ${res.matched} record(s); recorded ${added} new (rest duplicate/empty). Sample: ${JSON.stringify(sample)}`;
}

// Same registered-domain check (employers.indeed.com ↔ indeed.com ↔
// secure.indeed.com all match). Used to keep the agent from navigating off
// the portal — e.g. if a page carries prompt-injection text, or the model
// picks a bad URL — which could leak scraped data into a foreign URL.
function sameSite(targetUrl, baseUrl) {
  try {
    const root = (u) => new URL(u).host.replace(/^www\./, "").split(".").slice(-2).join(".");
    return root(targetUrl) === root(baseUrl);
  } catch { return false; }
}

// ─── Tool schema handed to Claude ───────────────────────────────────
const TOOLS = [
  { name: "navigate", description: "Load a URL in the browser and return the new page snapshot.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "snapshot", description: "Re-read the current page and return a fresh accessibility snapshot with element refs.",
    input_schema: { type: "object", properties: {} } },
  { name: "click", description: "Click the element with the given ref (from the most recent snapshot). Returns the updated snapshot.",
    input_schema: { type: "object", properties: { ref: { type: "string", description: "An element ref like e12 from the latest snapshot." } }, required: ["ref"] } },
  { name: "type", description: "Type text into the input/textarea with the given ref. Set submit:true to press Enter afterwards.",
    input_schema: { type: "object", properties: { ref: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" } }, required: ["ref", "text"] } },
  { name: "select_option", description: "Choose an option (by visible label or value) in the <select> with the given ref.",
    input_schema: { type: "object", properties: { ref: { type: "string" }, value: { type: "string" } }, required: ["ref", "value"] } },
  { name: "scroll", description: "Scroll the page up or down to reveal more content. Returns the updated snapshot.",
    input_schema: { type: "object", properties: { direction: { type: "string", enum: ["down", "up"] } }, required: ["direction"] } },
  { name: "back", description: "Go back to the previous page. Returns the updated snapshot.",
    input_schema: { type: "object", properties: {} } },
  { name: "save_rows", description: "Record one or more data rows you have read off the page. Dedup against prior runs is automatic. Use the exact text shown on the page; never invent values. Prefer `extract` for repeating lists/tables — only use save_rows for one-off or irregular data with no repeating structure.",
    input_schema: { type: "object", properties: { rows: { type: "array", items: { type: "object", properties: {
      name: { type: "string" }, email: { type: "string" }, phone: { type: "string" },
      extra: { type: "object", description: "Any other useful fields you read (city, role applied for, etc.)." },
    } } } }, required: ["rows"] } },
  { name: "extract", description:
      "PREFERRED for repeating data (a list or table of similar records). Instead of reading values yourself, give CSS selectors and the page is read deterministically: `rowSelector` matches EACH record's container; `fields` maps each output field to a CSS selector RELATIVE to the row (e.g. {\"name\":\".cand-name\",\"email\":\"a.email\",\"phone\":\".phone\"}). Known fields name/email/phone go to the row top level; any other keys go into `extra`. Returns the rows it extracted (recorded + deduped automatically). Because it's selector-based, this exact extraction can be REPLAYED on future runs with NO AI cost — so always prefer it when the data repeats. Verify the returned sample looks right; if selectors miss, take a fresh snapshot and adjust.",
    input_schema: { type: "object", properties: {
      rowSelector: { type: "string", description: "CSS selector matching each repeating record's container element." },
      fields: { type: "object", description: "Map of output field name (name|email|phone or any extra key) → CSS selector relative to the row container." },
    }, required: ["rowSelector", "fields"] } },
  { name: "done", description: "Finish the task. status 'complete' when you've recorded everything available, 'blocked' if you can't proceed (e.g. a login wall).",
    input_schema: { type: "object", properties: { status: { type: "string", enum: ["complete", "blocked"] }, summary: { type: "string" } }, required: ["status", "summary"] } },
];

function systemPrompt() {
  return [
    "You are RouteReady's browser-automation agent. You are driving a headless Chromium browser that is ALREADY signed in to the operator's hiring/logistics portal (the session is loaded for you).",
    "",
    "You perceive the page through `snapshot`, which returns an accessibility-style tree. Interactive elements are tagged with a ref like [e12]. Refs are ONLY valid for the most recent snapshot — after any action the page is re-snapshotted and refs are reassigned, so always act on refs from the latest snapshot you received.",
    "",
    "Work the goal methodically: read the snapshot, decide the single best next action, take it, read the result, repeat. If a list is paginated or lazily loaded, page/scroll through ALL of it before finishing.",
    "",
    "Collecting records — STRONGLY prefer `extract` over `save_rows` whenever the data repeats (a list or table of similar items). `extract` takes CSS selectors (a `rowSelector` for each record + a `fields` map of selectors relative to the row) and reads the page deterministically. The big win: a selector-based extraction is saved as a reusable recipe and REPLAYED on future runs with zero AI cost, so future pulls are essentially free. Inspect the snapshot to pick stable selectors (prefer data-testid, semantic classes, or roles over brittle :nth-child chains), call `extract`, then verify the returned sample looks correct. Use `save_rows` only for one-off or irregular data that has no repeating structure.",
    "",
    "Hard rules:",
    "- Only record data that is actually visible on the page. Never guess, infer, or fabricate names, emails, or phone numbers.",
    "- Don't navigate off the portal's own domain.",
    "- Be efficient — you have a limited number of steps. Don't re-snapshot needlessly; most actions already return a fresh snapshot.",
    "- When everything available has been recorded, call `done` with status 'complete'. If you hit a login wall or truly cannot proceed, call `done` with status 'blocked' and explain why.",
  ].join("\n");
}

// ─── The agent loop ─────────────────────────────────────────────────
const running = new Set();
const cancelFlags = new Map();

function emitStep(taskId, step) {
  try { DEPS.getMainWindow()?.webContents.send("agent:step", { taskId, ...step }); } catch {}
}
function emitTaskUpdated(taskId) {
  try { DEPS.getMainWindow()?.webContents.send("agent:taskUpdated", { id: taskId }); } catch {}
}

// Prompt caching for the agent loop. The system+tools prefix is cached via a
// breakpoint on the system block (tools render before system, so it covers
// both). Here we keep a single *rolling* breakpoint on the last block of the
// newest message, so the growing conversation prefix (all the prior page
// snapshots) is served from cache next step at ~0.1x instead of full price.
// Strip old breakpoints first so we never exceed the 4-breakpoint limit.
function markCache(messages) {
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) { if (b && typeof b === "object") delete b.cache_control; }
    }
  }
  const last = messages[messages.length - 1];
  if (!last) return;
  if (typeof last.content === "string") {
    last.content = [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }];
  } else if (Array.isArray(last.content) && last.content.length) {
    const lb = last.content[last.content.length - 1];
    if (lb && typeof lb === "object") lb.cache_control = { type: "ephemeral" };
  }
}

async function callModel(client, { model, effort, system, tools, messages }) {
  return client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system,
    tools,
    messages,
    thinking: { type: "adaptive" },
    output_config: { effort },
  });
}

// Build the Anthropic client. Prefers the CENTRAL key path: if the box is
// paired, route through RouteReady's ai-proxy edge function (which injects
// RouteReady's Anthropic key server-side) so no box ever holds a key and AI
// is billed centrally. Falls back to a box-local key if one is configured
// (dev / standalone). Returns null if neither is available.
async function makeAnthropic() {
  const localKey = readSecret(keyFile());
  if (localKey) return new Anthropic({ apiKey: localKey });
  if (DEPS.getAiAuth) {
    let auth = null;
    try { auth = await DEPS.getAiAuth(); } catch {}
    if (auth && auth.proxyUrl && auth.token) {
      return new Anthropic({
        apiKey: "rr-proxy", // ignored by the proxy; SDK just needs a non-empty value
        baseURL: auth.proxyUrl,
        defaultHeaders: {
          authorization: "Bearer " + auth.token, // RouteReady DSP session → proxy authorizes
          apikey: auth.anonKey || "",
        },
      });
    }
  }
  return null;
}

// Execute one tool call against the live page. Returns the string the
// model sees as the tool_result. Mutates `collected` for save_rows and
// sets control.finished/finishStatus/finishSummary for done.
async function runTool(page, name, input, collected, control) {
  switch (name) {
    case "navigate": {
      if (control.startUrl && !sameSite(input.url, control.startUrl)) {
        let host = "the portal"; try { host = new URL(control.startUrl).host; } catch {}
        return `Refused: ${input.url} is outside the portal domain (${host}). Stay on the portal — navigate only within that domain, or use click/scroll instead.`;
      }
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45000 });
      if (Array.isArray(control.trace)) control.trace.push({ action: "navigate", url: input.url });
      return await takeSnapshot(page);
    }
    case "snapshot":
      return await takeSnapshot(page);
    case "click": {
      const sel = refSel(input.ref);
      if (!sel) return `No element matched ref "${input.ref}". Take a fresh snapshot.`;
      // Resolve to a durable selector BEFORE clicking (the element may detach
      // when the page re-renders) so a successful click is replayable later.
      const stable = Array.isArray(control.trace) ? await stableSelectorForRef(page, input.ref) : null;
      try { await page.click(sel, { timeout: 8000 }); }
      catch (e) { return `Click failed (${String(e?.message || e)}). The element may have moved — take a fresh snapshot.`; }
      await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
      if (Array.isArray(control.trace)) {
        if (stable) control.trace.push({ action: "click", selector: stable });
        else control.traceBroken = true; // couldn't derive a durable selector → don't save a half-recipe
      }
      return await takeSnapshot(page);
    }
    case "type": {
      const sel = refSel(input.ref);
      if (!sel) return `No element matched ref "${input.ref}". Take a fresh snapshot.`;
      const stable = Array.isArray(control.trace) ? await stableSelectorForRef(page, input.ref) : null;
      try {
        await page.fill(sel, String(input.text ?? ""), { timeout: 8000 });
        if (input.submit) { await page.press(sel, "Enter"); await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {}); }
      } catch (e) { return `Type failed (${String(e?.message || e)}). Take a fresh snapshot.`; }
      if (Array.isArray(control.trace)) {
        if (stable) control.trace.push({ action: "type", selector: stable, text: String(input.text ?? ""), submit: !!input.submit });
        else control.traceBroken = true;
      }
      return await takeSnapshot(page);
    }
    case "select_option": {
      const sel = refSel(input.ref);
      if (!sel) return `No element matched ref "${input.ref}".`;
      const stable = Array.isArray(control.trace) ? await stableSelectorForRef(page, input.ref) : null;
      // Try matching by option value first, then by visible label.
      try { await page.selectOption(sel, input.value, { timeout: 8000 }); }
      catch {
        try { await page.selectOption(sel, { label: input.value }, { timeout: 8000 }); }
        catch (e) { return `Select failed (${String(e?.message || e)}).`; }
      }
      if (Array.isArray(control.trace)) {
        if (stable) control.trace.push({ action: "select_option", selector: stable, value: input.value });
        else control.traceBroken = true;
      }
      return await takeSnapshot(page);
    }
    case "extract":
      return await runExtract(page, input, collected, control);
    case "scroll": {
      const dy = input.direction === "up" ? -900 : 900;
      await page.evaluate((y) => window.scrollBy(0, y), dy);
      await page.waitForTimeout(500);
      if (Array.isArray(control.trace)) control.trace.push({ action: "scroll", direction: input.direction === "up" ? "up" : "down" });
      return await takeSnapshot(page);
    }
    case "back": {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      if (Array.isArray(control.trace)) control.trace.push({ action: "back" });
      return await takeSnapshot(page);
    }
    case "save_rows": {
      const rows = Array.isArray(input.rows) ? input.rows : [];
      let added = 0;
      for (const r of rows) {
        const key = rowKey(r);
        if (!key) continue;
        if (control.seen.has(key)) continue;
        control.seen.add(key);
        collected.push({ ...r, scrapedAt: new Date().toISOString() });
        added++;
      }
      return `Recorded ${added} new row(s). ${collected.length} new this run so far.`;
    }
    case "done": {
      control.finished = true;
      control.finishStatus = input.status || "complete";
      control.finishSummary = input.summary || "";
      return "Task finished.";
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

// Replay one recorded step deterministically. Returns {ok, reason?, matched?}.
async function replayStep(page, step, collected, control) {
  try {
    switch (step.action) {
      case "navigate":
        if (step.url && control.startUrl && !sameSite(step.url, control.startUrl)) return { ok: true }; // off-domain step shouldn't exist; skip safely
        if (step.url) await page.goto(step.url, { waitUntil: "domcontentloaded", timeout: 45000 });
        return { ok: true };
      case "click":
        if (!step.selector) return { ok: false, reason: "click step has no selector" };
        await page.click(step.selector, { timeout: 8000 });
        await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
        return { ok: true };
      case "type":
        if (!step.selector) return { ok: false, reason: "type step has no selector" };
        await page.fill(step.selector, String(step.text ?? ""), { timeout: 8000 });
        if (step.submit) { await page.press(step.selector, "Enter"); await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {}); }
        return { ok: true };
      case "select_option":
        if (!step.selector) return { ok: false, reason: "select step has no selector" };
        try { await page.selectOption(step.selector, step.value, { timeout: 8000 }); }
        catch { await page.selectOption(step.selector, { label: step.value }, { timeout: 8000 }); }
        return { ok: true };
      case "scroll":
        await page.evaluate((y) => window.scrollBy(0, y), step.direction === "up" ? -900 : 900);
        await page.waitForTimeout(500);
        return { ok: true };
      case "back":
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
        return { ok: true };
      case "extract": {
        const res = await page.evaluate(extractInPage, { rowSelector: step.rowSelector, fields: step.fields });
        if (res.error) return { ok: false, reason: res.error };
        if (!res.matched) return { ok: false, reason: `extract matched 0 rows for "${step.rowSelector}"` };
        for (const rec of res.rows) {
          const row = shapeRow(rec);
          const key = rowKey(row);
          if (!key || control.seen.has(key)) continue;
          control.seen.add(key);
          collected.push({ ...row, scrapedAt: new Date().toISOString() });
        }
        return { ok: true, matched: res.matched };
      }
      default:
        return { ok: true }; // unknown step type — ignore, don't fail the whole replay
    }
  } catch (e) {
    return { ok: false, reason: `${step.action}: ${String(e?.message || e)}` };
  }
}

// Deterministic replay of a learned recipe — NO model calls, so future runs of
// a known page cost ~$0. Returns {ok, reason?, extracted}. A miss (selector
// gone, zero rows) returns ok:false so the caller falls back to the AI and
// re-learns. Same anti-bot launch + session as the AI path.
async function replayRecipe(task, control, collected, errors) {
  const recipe = task.recipe;
  const browser = await DEPS.launchChromium({
    headless: !task.visibleBrowser,
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  const stateJson = DEPS.readSession();
  const context = await browser.newContext({
    storageState: stateJson ? JSON.parse(stateJson) : undefined,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  });
  const page = await context.newPage();
  let ok = true, reason = null, extracted = 0;
  try {
    await page.goto(task.startUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    for (const step of recipe.steps) {
      if (cancelFlags.get(task.id)) { ok = false; reason = "cancelled"; break; }
      const r = await replayStep(page, step, collected, control);
      if (!r.ok) { ok = false; reason = r.reason; break; }
      if (step.action === "extract") extracted += r.matched || 0;
    }
  } catch (e) {
    ok = false; reason = String(e?.message || e);
  } finally {
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
  if (ok && extracted === 0) { ok = false; reason = "recipe ran but extracted 0 rows"; }
  return { ok, reason, extracted };
}

async function runTask(id, { manual = false } = {}) {
  const task = readTask(id);
  if (!task) return { ok: false, error: "no_task" };
  if (!task.goal || !task.startUrl) return { ok: false, error: "task_incomplete", message: "Task needs a goal and a start URL." };

  const collected = [];
  const control = { finished: false, finishStatus: null, finishSummary: "", seen: new Set(readSeen(id)), startUrl: task.startUrl };
  const errors = [];
  let steps = 0;
  let usedReplay = false;
  let status = null, summary = null;

  // ── Phase 1: replay-first (learn once → replay cheap). If a prior AI run
  // learned a recipe, replay it deterministically with NO model cost. Only
  // fall through to the (expensive) AI when there's no recipe, replay is
  // disabled, or the recipe stopped matching the page (layout changed).
  const canReplay = !!(task.recipe && Array.isArray(task.recipe.steps) && task.recipe.steps.length
    && task.recipe.steps.some((s) => s.action === "extract") && task.replayEnabled !== false);
  if (canReplay) {
    emitStep(id, { kind: "start", text: `Replaying learned recipe (v${task.recipe.version || 1}) · no AI cost` });
    const rr = await replayRecipe(task, control, collected, errors);
    if (rr.ok) {
      usedReplay = true;
      status = "complete";
      summary = `Replayed recipe v${task.recipe.version || 1} · ${collected.length} new row(s) · $0 AI`;
      emitStep(id, { kind: "ok", text: summary });
    } else {
      emitStep(id, { kind: "info", text: `Replay didn't match (${rr.reason}) — re-learning with the AI.` });
      collected.length = 0;            // discard partial replay output
      control.seen = new Set(readSeen(id)); // reset dedupe to the persisted set
    }
  }

  // ── Phase 2: AI agent (only when replay didn't already do the job) ──
  if (!usedReplay) {
    // Central key (via the box's pairing) or a box-local key. No key on the
    // box is the normal case now — the proxy supplies RouteReady's key.
    const client = await makeAnthropic();
    if (!client) {
      if (canReplay) return { ok: false, error: "replay_broke_no_ai", message: "The learned recipe stopped matching the page and there's no AI access to re-learn it. Pair the box (central key) or add an Anthropic API key." };
      return { ok: false, error: "no_ai", message: "No AI access — pair this box to RouteReady (central key), or add an Anthropic API key in the agent settings." };
    }
    // A saved portal session is loaded when present, but not required — that
    // lets a benign no-login page (the shakedown task) run with just AI
    // access. On a real auth-walled page with no session the agent simply
    // lands on the login wall and reports done:"blocked", the right signal.
    const model = effectiveModel(task);
    const effort = effectiveEffort(task);
    control.trace = []; // record actions so a clean run becomes a $0 replay recipe

    // Visible browser when the task needs it. Sites with bot protection
    // (Cloudflare on Indeed, etc.) fingerprint a headless Chromium and serve
    // a "Request Blocked" wall, but let a real visible window through. We also
    // strip the usual automation tells to reduce bot-detection false positives.
    const browser = await DEPS.launchChromium({
      headless: !task.visibleBrowser,
      args: ["--disable-blink-features=AutomationControlled"],
      ignoreDefaultArgs: ["--enable-automation"],
    });
    const stateJson = DEPS.readSession();
    const context = await browser.newContext({
      storageState: stateJson ? JSON.parse(stateJson) : undefined,
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
    });
    const page = await context.newPage();

    emitStep(id, { kind: "start", text: `Agent starting · model ${model} · effort ${effort}${task.visibleBrowser ? " · visible browser" : ""}` });

    try {
      await page.goto(task.startUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      const firstSnap = await takeSnapshot(page);

      // System prompt + tool defs are identical every step — cache them so we
      // don't pay full input price re-sending them each iteration.
      const systemBlocks = [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }];
      const messages = [{
        role: "user",
        content:
          `GOAL:\n${task.goal}\n\nThe browser is already open at the start URL and signed in. ` +
          `Here is the initial page snapshot:\n\n${firstSnap}`,
      }];

      while (!control.finished && steps < MAX_STEPS) {
        if (cancelFlags.get(id)) { control.finishSummary = "Cancelled by operator."; control.finishStatus = "blocked"; break; }
        steps++;

        let resp;
        try {
          markCache(messages); // roll the conversation cache breakpoint to the newest turn
          resp = await callModel(client, { model, effort, system: systemBlocks, tools: TOOLS, messages });
        } catch (e) {
          const msg = String(e?.message || e);
          errors.push(msg);
          emitStep(id, { kind: "error", text: `Model call failed: ${msg}` });
          break;
        }

        // Surface any visible reasoning/preamble text to the live log.
        for (const block of resp.content) {
          if (block.type === "text" && block.text.trim()) emitStep(id, { kind: "think", text: block.text.trim() });
        }

        const toolUses = resp.content.filter((b) => b.type === "tool_use");
        // Preserve the full assistant turn (incl. thinking blocks) for the next request.
        messages.push({ role: "assistant", content: resp.content });

        if (toolUses.length === 0) {
          // No tool call and not done — nudge once, then bail to avoid a stall.
          emitStep(id, { kind: "info", text: "Model returned no action; asking it to continue or finish." });
          messages.push({ role: "user", content: "Continue with a tool call, or call done if you've finished." });
          continue;
        }

        const results = [];
        for (const tu of toolUses) {
          emitStep(id, { kind: "action", text: describeAction(tu.name, tu.input) });
          let out;
          try { out = await runTool(page, tu.name, tu.input || {}, collected, control); }
          catch (e) { out = `Tool error: ${String(e?.message || e)}`; errors.push(out); }
          results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
          if (control.finished) break;
        }
        messages.push({ role: "user", content: results });
      }
    } catch (e) {
      errors.push(String(e?.message || e));
      emitStep(id, { kind: "error", text: String(e?.message || e) });
    } finally {
      try { await page.close(); } catch {}
      try { await context.close(); } catch {}
      try { await browser.close(); } catch {}
    }

    const stoppedEarly = steps >= MAX_STEPS && !control.finished;
    status = control.finishStatus || (stoppedEarly ? "blocked" : "complete");
    summary = control.finishSummary || (stoppedEarly ? `Hit the ${MAX_STEPS}-step cap before finishing.` : "Finished.");

    // ── Learn: a clean run that extracted via selectors becomes a replay
    // recipe, so the NEXT run skips the AI entirely. Requires at least one
    // extract step and a fully-resolvable action trace (traceBroken means we
    // couldn't derive a durable selector for some click — don't save a recipe
    // that would only half-replay).
    if (status === "complete" && !control.traceBroken && Array.isArray(control.trace)
      && control.trace.some((s) => s.action === "extract")) {
      const recipe = {
        version: ((task.recipe && task.recipe.version) || 0) + 1,
        createdAt: new Date().toISOString(),
        startUrl: task.startUrl,
        steps: control.trace,
      };
      const t2 = readTask(id) || task;
      t2.recipe = recipe;
      writeTask(t2);
      emitStep(id, { kind: "ok", text: `Learned a replay recipe (v${recipe.version}, ${control.trace.length} steps) — future runs skip the AI.` });
    }
  }

  // Belt-and-suspenders for the shared finalize below.
  status = status || "complete";
  summary = summary || "Finished.";

  // ── Sink 1: CSV on disk (always — lets the operator verify output) ──
  const dir = task.downloadDir || DEPS.defaultDownloadDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const csvPath = path.join(dir, `${id}-${stamp}.csv`);
  writeCsv(csvPath, collected, errors);

  // ── Sink 2: RouteReady upload (optional) ──
  let uploaded = 0, uploadError = null, uploadFailed = 0;
  if (task.uploadToRouteReady && collected.length) {
    const up = await uploadToRouteReady(collected, task);
    uploaded = up.uploaded; uploadError = up.error;
    uploadFailed = (up.failed || []).length;
    // Rows that failed to upload are dropped from the dedupe set so the
    // next crawl re-scrapes and retries them. Otherwise a row that was
    // scraped but never reached RouteReady would be deduped out forever
    // and go silently missing.
    for (const fr of up.failed || []) { const k = rowKey(fr); if (k) control.seen.delete(k); }
    if (uploadError) errors.push("upload: " + uploadError + (uploadFailed > 1 ? ` (+${uploadFailed - 1} more failed)` : ""));
    emitStep(id, {
      kind: uploadFailed ? "error" : "ok",
      text: uploadFailed
        ? `RouteReady upload: ${uploaded} ok, ${uploadFailed} failed (will retry next run). ${uploadError || ""}`.trim()
        : `Uploaded ${uploaded} row(s) into RouteReady.`,
    });
  }

  // Persist the dedupe set AFTER upload, so any failed-upload rows we just
  // re-opened above actually get retried on the next run.
  writeSeen(id, [...control.seen]);

  // ── Persist run summary + task stats ──
  const ts = new Date().toISOString();
  const result = errors.length === 0 ? status : (collected.length ? "partial" : "error");
  try {
    fs.writeFileSync(path.join(runsDir(), `${id}-${stamp}.json`),
      JSON.stringify({ ts, taskId: id, steps, status, summary, newCount: collected.length, uploaded, errors, rows: collected, manual }, null, 2));
  } catch {}

  const next = readTask(id) || task;
  next.lastRunAt = ts;
  next.lastResult = result;
  next.lastError = errors.length ? errors[0] : null;
  next.lastCount = collected.length;
  next.lastNewCount = collected.length;
  next.lastUploaded = uploaded;
  next.lastSummary = summary;
  if (next.enabled) {
    next.nextRunAt = computeNextRunAt(next); // clock times if set, else interval
  }
  writeTask(next);
  emitTaskUpdated(id);

  DEPS.appendHistory({
    ts, url: task.startUrl, clickSelector: `agent:${task.name}`,
    filePath: csvPath, suggestedName: path.basename(csvPath),
    size: (collected.length || 0), source: manual ? "agent-manual" : "agent",
  });

  emitStep(id, { kind: "ok", text: `Done · ${collected.length} new row(s) · ${steps} steps · ${status}` });

  // Report this run to the box's health row (Supabase) so the dashboard can
  // show "last pull ok/failed + when". Non-fatal — main.js owns the client and
  // swallows errors; a box with no pairing session just no-ops.
  if (typeof DEPS.reportRun === "function") {
    try {
      DEPS.reportRun({
        at: ts,
        task: task.name || id,
        status: result,
        error: errors.length ? errors[0] : null,
        rows: collected.length,
      });
    } catch (e) { DEPS.logLine("agent: reportRun threw:", String(e)); }
  }

  return { ok: true, status, summary, newCount: collected.length, uploaded, steps, errors: errors.length, csvPath };
}

function describeAction(name, input) {
  switch (name) {
    case "navigate": return `navigate → ${input.url}`;
    case "click": return `click ${input.ref}`;
    case "type": return `type "${String(input.text || "").slice(0, 40)}" → ${input.ref}${input.submit ? " ⏎" : ""}`;
    case "select_option": return `select "${input.value}" → ${input.ref}`;
    case "scroll": return `scroll ${input.direction}`;
    case "save_rows": return `save_rows (${(input.rows || []).length})`;
    case "snapshot": return "snapshot";
    case "back": return "back";
    case "done": return `done (${input.status})`;
    default: return name;
  }
}

// ─── RouteReady upload (webhook-apply → intake_applicant) ───────────
async function uploadToRouteReady(rows, task) {
  // Central path (preferred): the box uploads via its pairing session to the
  // box-ingest function, which resolves the DSP server-side — no apply-secret
  // or short code on the box. Falls back to box-local config for standalone.
  let central = null;
  if (DEPS.getUploadAuth) { try { central = await DEPS.getUploadAuth(); } catch {} }

  const cfg = readConfig();
  const localUrl = cfg.uploadUrl;
  const localShort = cfg.dspShortCode;
  const localSecret = readSecret(applySecretFile());

  if (!central && (!localUrl || !localShort)) {
    // Not configured and not paired: treat every row as failed so the caller
    // re-opens them in the dedupe set and retries once upload is available,
    // rather than silently dropping them.
    return { uploaded: 0, failed: rows.slice(), error: "RouteReady upload not available — pair the box, or set URL + DSP short code in AI agent settings." };
  }

  const url = central ? central.url : localUrl;

  let uploaded = 0;
  const failed = [];
  let firstError = null;
  for (const r of rows) {
    const name = String(r.name || "").trim();
    const sp = name.split(/\s+/);
    const payload = {
      // central: server stamps dsp_short_code from the session; local: send it.
      ...(central ? {} : { dsp_short_code: localShort }),
      source: "agent",
      source_ref: r.email ? `agent:${String(r.email).toLowerCase()}` : (name ? `agent:${name.toLowerCase()}` : undefined),
      full_name: name || undefined,
      first_name: sp[0] || undefined,
      last_name: sp.length > 1 ? sp.slice(1).join(" ") : undefined,
      email: r.email || undefined,
      phone: r.phone || undefined,
      metadata: { scraped_via: task.name, ...(r.extra || {}) },
    };
    const headers = central
      ? { "content-type": "application/json", authorization: "Bearer " + central.token, apikey: central.anonKey || "" }
      : { "content-type": "application/json", ...(localSecret ? { "x-apply-secret": localSecret } : {}) };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (res.ok) { uploaded++; continue; }
      const text = await res.text().catch(() => "");
      failed.push(r);
      if (!firstError) firstError = `HTTP ${res.status} ${text.slice(0, 160)}`;
    } catch (e) {
      failed.push(r);
      if (!firstError) firstError = String(e?.message || e);
    }
  }
  return { uploaded, failed, error: failed.length ? firstError : null };
}

// ─── CSV ────────────────────────────────────────────────────────────
function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function writeCsv(p, rows, errors) {
  const header = "name,email,phone,extra,scraped_at";
  const body = rows.map((r) =>
    [r.name, r.email, r.phone, r.extra ? JSON.stringify(r.extra) : "", r.scrapedAt].map(csvCell).join(","));
  try { fs.writeFileSync(p, [header, ...body].join("\n")); }
  catch (e) { errors.push("write_csv: " + String(e?.message || e)); }
}

// ─── Scheduler ──────────────────────────────────────────────────────
let tickHandle = null;
async function tick() {
  const dir = tasksDir();
  const now = Date.now();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    let task;
    try { task = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
    if (!task.enabled || running.has(task.id)) continue;
    if (!task.intervalMinutes || task.intervalMinutes <= 0) continue;
    const due = !task.nextRunAt || new Date(task.nextRunAt).getTime() <= now;
    if (!due) continue;
    if (!readSecret(keyFile()) && !DEPS.getAiAuth) { DEPS.logLine("agent: skip", task.id, "(no AI access)"); continue; }
    // No portal-session guard here: runTask supports no-login tasks (the
    // seeded shakedown runs with just an API key). An auth-needing task with
    // no session simply lands on the login wall and reports "blocked".
    running.add(task.id);
    runTask(task.id, { manual: false })
      .catch((e) => DEPS.logLine("agent: run threw:", task.id, String(e)))
      .finally(() => running.delete(task.id));
  }
}
function startLoop() {
  if (tickHandle) return;
  tickHandle = setInterval(tick, TICK_MS);
  setTimeout(tick, 9000);
}

// On-demand sync (ROADMAP #4): run every enabled task NOW, sequentially.
// Driven by the box's sync-request poller (main.js) when an operator hits the
// dashboard's "Sync to portal" button. Skips tasks already running and tasks
// with no API key. Returns a per-task summary so the box can report the
// outcome back onto the sync request.
async function runAllEnabledNow() {
  const client = await makeAnthropic();
  if (!client) return { ok: false, error: "no_ai", ran: 0, results: [], message: "No AI access — pair the box (central key) or add an Anthropic API key." };
  const { tasks } = listTasks();
  const enabled = (tasks || []).filter((t) => t.enabled);
  const results = [];
  for (const t of enabled) {
    if (running.has(t.id)) { results.push({ id: t.id, name: t.name, skipped: "already_running" }); continue; }
    running.add(t.id);
    cancelFlags.delete(t.id);
    try {
      const r = await runTask(t.id, { manual: true });
      results.push({ id: t.id, name: t.name, status: r.status, rows: r.newCount, errors: r.errors, ok: r.ok });
    } catch (e) {
      results.push({ id: t.id, name: t.name, ok: false, error: String(e?.message || e) });
    } finally {
      running.delete(t.id);
      cancelFlags.delete(t.id);
    }
  }
  const totalRows = results.reduce((n, r) => n + (r.rows || 0), 0);
  const anyError = results.some((r) => r.ok === false || (r.errors && r.errors > 0));
  return { ok: true, ran: results.length, totalRows, status: anyError ? "partial" : "complete", results };
}

// ─── IPC ────────────────────────────────────────────────────────────
function init(deps) {
  DEPS = deps;
  ensureSeeded();
  startLoop();

  ipcMain.handle("agent:getConfig", async () => {
    const cfg = readConfig();
    return {
      ok: true,
      hasApiKey: !!readSecret(keyFile()),
      model: cfg.model || DEFAULT_MODEL,
      effort: cfg.effort || DEFAULT_EFFORT,
      defaultModel: DEFAULT_MODEL,
      uploadUrl: cfg.uploadUrl || "",
      dspShortCode: cfg.dspShortCode || "",
      hasApplySecret: !!readSecret(applySecretFile()),
    };
  });

  ipcMain.handle("agent:setConfig", async (_e, patch = {}) => {
    const cfgPatch = {};
    if (patch.model != null) cfgPatch.model = String(patch.model).trim() || DEFAULT_MODEL;
    if (patch.effort != null) cfgPatch.effort = String(patch.effort).trim() || DEFAULT_EFFORT;
    if (patch.uploadUrl != null) cfgPatch.uploadUrl = String(patch.uploadUrl).trim();
    if (patch.dspShortCode != null) cfgPatch.dspShortCode = String(patch.dspShortCode).trim();
    if (Object.keys(cfgPatch).length) writeConfig(cfgPatch);
    // Secrets: empty string clears; undefined leaves as-is.
    if (patch.apiKey != null) { const k = String(patch.apiKey).trim(); k ? writeSecret(keyFile(), k) : clearSecret(keyFile()); }
    if (patch.applySecret != null) { const s = String(patch.applySecret).trim(); s ? writeSecret(applySecretFile(), s) : clearSecret(applySecretFile()); }
    return { ok: true };
  });

  ipcMain.handle("agent:listTasks", async () => listTasks());
  ipcMain.handle("agent:getTask", async (_e, { id }) => { const t = readTask(id); return t ? { ok: true, task: t } : { ok: false, error: "no_task" }; });
  ipcMain.handle("agent:saveTask", async (_e, patch) => saveTask(patch));
  ipcMain.handle("agent:deleteTask", async (_e, { id }) => deleteTask(id));
  ipcMain.handle("agent:resetSeen", async (_e, { id }) => { clearSecretSeen(id); return { ok: true }; });
  ipcMain.handle("agent:clearRecipe", async (_e, { id }) => {
    const t = readTask(id);
    if (!t) return { ok: false, error: "no_task" };
    t.recipe = null;
    writeTask(t);
    emitTaskUpdated(id);
    return { ok: true };
  });
  ipcMain.handle("agent:setReplay", async (_e, { id, enabled }) => {
    const t = readTask(id);
    if (!t) return { ok: false, error: "no_task" };
    t.replayEnabled = !!enabled;
    writeTask(t);
    emitTaskUpdated(id);
    return { ok: true };
  });
  ipcMain.handle("agent:stop", async (_e, { id }) => { cancelFlags.set(id, true); return { ok: true }; });
  ipcMain.handle("agent:runNow", async (_e, { id }) => {
    if (running.has(id)) return { ok: false, error: "already_running" };
    running.add(id);
    cancelFlags.delete(id);
    try { return await runTask(id, { manual: true }); }
    catch (e) { const msg = String(e?.message || e); DEPS.logLine("agent:runNow threw:", msg); return { ok: false, error: "run_threw", message: msg }; }
    finally { running.delete(id); cancelFlags.delete(id); }
  });
}

// True while any task (scheduled, manual, or replay) is mid-run — the
// auto-updater uses this to avoid restarting the app during a crawl.
function isBusy() { return running.size > 0; }

// Mirror the DSP's central crawl_tasks (defined by platform_admin in the
// dashboard) into the local task store, so the existing scheduler + runner
// execute them. Local run stats + learned replay recipes are preserved across
// syncs (so we don't re-learn every 5 min). Central tasks are id-prefixed
// "central-" and flagged {central:true}; any local central-* task that no
// longer exists upstream is removed. (ROADMAP #4 Phase 2.)
function applyCentralTasks(list) {
  if (!Array.isArray(list)) return { ok: false, error: "bad_list" };
  const keep = new Set();
  for (const t of list) {
    if (!t || !t.id) continue;
    const id = `central-${t.id}`;
    keep.add(id);
    const prev = readTask(id);
    const merged = {
      ...(prev || {}),                       // keep lastRun*, recipe, replayEnabled, seen, etc.
      id,
      central: true,
      centralId: t.id,
      name: t.name || "Crawl task",
      goal: t.goal != null ? String(t.goal) : (prev?.goal || ""),
      startUrl: t.start_url != null ? String(t.start_url).trim() : (prev?.startUrl || ""),
      dailyTimes: normTimes(t.daily_times || []),
      intervalMinutes: Number(t.interval_minutes || 60),
      enabled: !!t.enabled,
      uploadToRouteReady: !!t.upload_to_routeready,
      visibleBrowser: !!t.visible_browser,
      model: t.model || null,
      effort: t.effort || null,
      createdAt: prev?.createdAt || new Date().toISOString(),
    };
    merged.nextRunAt = merged.enabled ? computeNextRunAt(merged) : null;
    writeTask(merged);
  }
  // Drop central tasks that were removed upstream.
  const { tasks } = listTasks();
  for (const t of tasks) {
    if (t && t.central && !keep.has(t.id)) {
      try { fs.unlinkSync(path.join(tasksDir(), `${t.id}.json`)); } catch {}
      clearSecretSeen(t.id);
    }
  }
  emitTaskUpdated("*");
  return { ok: true, count: keep.size };
}

module.exports = { init, runAllEnabledNow, isBusy, applyCentralTasks };
