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
const DEFAULT_MODEL = "claude-opus-4-8";     // skill-mandated default; per-task override allowed
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
function saveTask(patch) {
  if (!patch || !patch.id) return { ok: false, error: "missing_id" };
  const prev = readTask(patch.id);
  const merged = {
    id: patch.id,
    name: patch.name || prev?.name || "Untitled task",
    goal: patch.goal != null ? String(patch.goal) : (prev?.goal || ""),
    startUrl: patch.startUrl != null ? String(patch.startUrl).trim() : (prev?.startUrl || ""),
    intervalMinutes: Number(patch.intervalMinutes ?? prev?.intervalMinutes ?? 60),
    enabled: patch.enabled != null ? !!patch.enabled : !!prev?.enabled,
    downloadDir: patch.downloadDir != null ? String(patch.downloadDir).trim() : (prev?.downloadDir || ""),
    uploadToRouteReady: patch.uploadToRouteReady != null ? !!patch.uploadToRouteReady : !!prev?.uploadToRouteReady,
    model: patch.model != null ? (String(patch.model).trim() || null) : (prev?.model ?? null),
    effort: patch.effort != null ? (String(patch.effort).trim() || null) : (prev?.effort ?? null),
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
  if (merged.enabled && !prev?.enabled) {
    merged.nextRunAt = new Date(Date.now() + merged.intervalMinutes * 60000).toISOString();
  } else if (!merged.enabled) {
    merged.nextRunAt = null;
  }
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
  { name: "save_rows", description: "Record one or more data rows you have read off the page. Dedup against prior runs is automatic. Use the exact text shown on the page; never invent values.",
    input_schema: { type: "object", properties: { rows: { type: "array", items: { type: "object", properties: {
      name: { type: "string" }, email: { type: "string" }, phone: { type: "string" },
      extra: { type: "object", description: "Any other useful fields you read (city, role applied for, etc.)." },
    } } } }, required: ["rows"] } },
  { name: "done", description: "Finish the task. status 'complete' when you've recorded everything available, 'blocked' if you can't proceed (e.g. a login wall).",
    input_schema: { type: "object", properties: { status: { type: "string", enum: ["complete", "blocked"] }, summary: { type: "string" } }, required: ["status", "summary"] } },
];

function systemPrompt() {
  return [
    "You are RouteReady's browser-automation agent. You are driving a headless Chromium browser that is ALREADY signed in to the operator's hiring/logistics portal (the session is loaded for you).",
    "",
    "You perceive the page through `snapshot`, which returns an accessibility-style tree. Interactive elements are tagged with a ref like [e12]. Refs are ONLY valid for the most recent snapshot — after any action the page is re-snapshotted and refs are reassigned, so always act on refs from the latest snapshot you received.",
    "",
    "Work the goal methodically: read the snapshot, decide the single best next action, take it, read the result, repeat. To collect records, read them off the page and call `save_rows` with structured fields. If a list is paginated or lazily loaded, page/scroll through ALL of it before finishing.",
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

// Execute one tool call against the live page. Returns the string the
// model sees as the tool_result. Mutates `collected` for save_rows and
// sets control.finished/finishStatus/finishSummary for done.
async function runTool(page, name, input, collected, control) {
  switch (name) {
    case "navigate": {
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45000 });
      return await takeSnapshot(page);
    }
    case "snapshot":
      return await takeSnapshot(page);
    case "click": {
      const sel = refSel(input.ref);
      if (!sel) return `No element matched ref "${input.ref}". Take a fresh snapshot.`;
      try { await page.click(sel, { timeout: 8000 }); }
      catch (e) { return `Click failed (${String(e?.message || e)}). The element may have moved — take a fresh snapshot.`; }
      await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
      return await takeSnapshot(page);
    }
    case "type": {
      const sel = refSel(input.ref);
      if (!sel) return `No element matched ref "${input.ref}". Take a fresh snapshot.`;
      try {
        await page.fill(sel, String(input.text ?? ""), { timeout: 8000 });
        if (input.submit) { await page.press(sel, "Enter"); await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {}); }
      } catch (e) { return `Type failed (${String(e?.message || e)}). Take a fresh snapshot.`; }
      return await takeSnapshot(page);
    }
    case "select_option": {
      const sel = refSel(input.ref);
      if (!sel) return `No element matched ref "${input.ref}".`;
      // Try matching by option value first, then by visible label.
      try { await page.selectOption(sel, input.value, { timeout: 8000 }); }
      catch {
        try { await page.selectOption(sel, { label: input.value }, { timeout: 8000 }); }
        catch (e) { return `Select failed (${String(e?.message || e)}).`; }
      }
      return await takeSnapshot(page);
    }
    case "scroll": {
      const dy = input.direction === "up" ? -900 : 900;
      await page.evaluate((y) => window.scrollBy(0, y), dy);
      await page.waitForTimeout(500);
      return await takeSnapshot(page);
    }
    case "back": {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
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

async function runTask(id, { manual = false } = {}) {
  const task = readTask(id);
  if (!task) return { ok: false, error: "no_task" };
  if (!task.goal || !task.startUrl) return { ok: false, error: "task_incomplete", message: "Task needs a goal and a start URL." };

  const apiKey = readSecret(keyFile());
  if (!apiKey) return { ok: false, error: "no_api_key", message: "Add an Anthropic API key in the AI agent settings first." };
  if (!DEPS.readSession()) return { ok: false, error: "no_session", message: "No saved portal session — sign in first." };

  const client = new Anthropic({ apiKey });
  const model = effectiveModel(task);
  const effort = effectiveEffort(task);

  const browser = await DEPS.launchChromium({ headless: true });
  const stateJson = DEPS.readSession();
  const context = await browser.newContext({
    storageState: stateJson ? JSON.parse(stateJson) : undefined,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  const collected = [];
  const control = { finished: false, finishStatus: null, finishSummary: "", seen: new Set(readSeen(id)) };
  const errors = [];
  let steps = 0;

  emitStep(id, { kind: "start", text: `Agent starting · model ${model} · effort ${effort}` });

  try {
    await page.goto(task.startUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    const firstSnap = await takeSnapshot(page);

    const system = systemPrompt();
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
        resp = await callModel(client, { model, effort, system, tools: TOOLS, messages });
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
  const status = control.finishStatus || (stoppedEarly ? "blocked" : "complete");
  const summary = control.finishSummary || (stoppedEarly ? `Hit the ${MAX_STEPS}-step cap before finishing.` : "Finished.");

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
  if (next.intervalMinutes > 0 && next.enabled) {
    next.nextRunAt = new Date(Date.now() + next.intervalMinutes * 60000).toISOString();
  }
  writeTask(next);
  emitTaskUpdated(id);

  DEPS.appendHistory({
    ts, url: task.startUrl, clickSelector: `agent:${task.name}`,
    filePath: csvPath, suggestedName: path.basename(csvPath),
    size: (collected.length || 0), source: manual ? "agent-manual" : "agent",
  });

  emitStep(id, { kind: "ok", text: `Done · ${collected.length} new row(s) · ${steps} steps · ${status}` });

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
  const cfg = readConfig();
  const url = cfg.uploadUrl;
  const dspShortCode = cfg.dspShortCode;
  const secret = readSecret(applySecretFile());
  if (!url || !dspShortCode) {
    // Misconfigured but the task asked to upload: treat every row as failed
    // so the caller re-opens them in the dedupe set and retries once upload
    // is configured, rather than silently dropping them.
    return { uploaded: 0, failed: rows.slice(), error: "RouteReady upload not configured (set URL + DSP short code in AI agent settings)." };
  }

  let uploaded = 0;
  const failed = [];
  let firstError = null;
  for (const r of rows) {
    const name = String(r.name || "").trim();
    const sp = name.split(/\s+/);
    const payload = {
      dsp_short_code: dspShortCode,
      source: "agent",
      source_ref: r.email ? `agent:${String(r.email).toLowerCase()}` : (name ? `agent:${name.toLowerCase()}` : undefined),
      full_name: name || undefined,
      first_name: sp[0] || undefined,
      last_name: sp.length > 1 ? sp.slice(1).join(" ") : undefined,
      email: r.email || undefined,
      phone: r.phone || undefined,
      metadata: { scraped_via: task.name, ...(r.extra || {}) },
    };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(secret ? { "x-apply-secret": secret } : {}) },
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
    if (!readSecret(keyFile())) { DEPS.logLine("agent: skip", task.id, "(no API key)"); continue; }
    if (!DEPS.readSession()) { DEPS.logLine("agent: skip", task.id, "(no portal session)"); continue; }
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

module.exports = { init };
