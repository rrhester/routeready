#!/usr/bin/env node
/**
 * agent-harness.js · local test harness for the agentic crawler (agent.js).
 *
 * Drives the REAL agent pipeline end-to-end against local fixture pages,
 * faking only two things:
 *   1. electron            — agent.js requires { ipcMain, safeStorage }.
 *   2. @anthropic-ai/sdk   — replaced with a scripted "model". The script
 *      reads the actual page snapshot (like the real model would) and returns
 *      tool calls, so runs are deterministic and need no API key or network.
 * Everything else is the real code: takeSnapshot, runTool (click/extract/…),
 * runExtract/extractInPage (run in a real headless Chromium), the dedupe set,
 * CSV writing, recipe-learning, and the $0 replay path.
 *
 * Scenarios
 *   A · List extract        — pull a repeating list; verify dedupe + CSV.
 *   B · Detail + reveal      — click "Open details" → click "Reveal email" →
 *                              extract; verify multi-step nav + a learned recipe.
 *   C · Learn → replay       — run once (AI learns a recipe), then run again and
 *                              verify it REPLAYS with zero model calls.
 *
 * Run: node desktop/test/agent-harness.js   (exit 0 = pass, 1 = failure)
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const Module = require("node:module");

// ── Playwright + Chromium ──────────────────────────────────────────────
function loadPlaywright() {
  for (const id of ["playwright", "/opt/node22/lib/node_modules/playwright"]) {
    try { return require(id); } catch {}
  }
  throw new Error("Playwright not found (tried 'playwright' and the global install).");
}
function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  try {
    for (const d of fs.readdirSync(base)) {
      if (d.startsWith("chromium-") && !d.includes("headless")) {
        const p = path.join(base, d, "chrome-linux", "chrome");
        if (fs.existsSync(p)) return p;
      }
    }
  } catch {}
  return null;
}
const { chromium } = loadPlaywright();
const CHROMIUM_PATH = findChromium();

// ── Scripted Anthropic SDK ─────────────────────────────────────────────
let MODEL_CALLS = 0;
let MODEL_SCRIPT = () => ({ content: [{ type: "tool_use", id: "t0", name: "done", input: { status: "complete" } }] });
let TOOL_ID = 0;
class FakeAnthropic {
  constructor(opts) { this.opts = opts; this.messages = { create: async (req) => { MODEL_CALLS++; return MODEL_SCRIPT(req, MODEL_CALLS); } }; }
}

// Helpers a script uses to act like the real model: read the latest page
// snapshot out of the conversation and resolve element refs by their label.
function latestSnapshot(messages) {
  const isSnap = (s) => typeof s === "string" && s.includes("interactive elements");
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isSnap(m.content)) return m.content;
    if (Array.isArray(m.content)) {
      for (let j = m.content.length - 1; j >= 0; j--) {
        const b = m.content[j];
        if (b && b.type === "tool_result" && isSnap(b.content)) return b.content;
        if (b && b.type === "text" && isSnap(b.text)) return b.text;
      }
    }
  }
  return "";
}
function lastToolResultText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (Array.isArray(m.content)) {
      for (let j = m.content.length - 1; j >= 0; j--) {
        const b = m.content[j];
        if (b && b.type === "tool_result") return typeof b.content === "string" ? b.content : "";
      }
    }
  }
  return "";
}
function refByName(snap, pred) {
  const re = /\[(e\d+)\]\s+\S+\s+"([^"]*)"/g;
  let m;
  while ((m = re.exec(snap))) { if (pred(m[2])) return m[1]; }
  return null;
}
const tool = (name, input, text) => ({
  content: [...(text ? [{ type: "text", text }] : []), { type: "tool_use", id: `t${++TOOL_ID}`, name, input }],
});

// ── Fake electron ──────────────────────────────────────────────────────
const ipcHandlers = {};
const fakeElectron = {
  ipcMain: { handle: (name, fn) => { ipcHandlers[name] = fn; }, on: () => {} },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(String(s), "utf8"),
    decryptString: (b) => Buffer.from(b).toString("utf8"),
  },
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") return fakeElectron;
  if (request === "@anthropic-ai/sdk") return FakeAnthropic;
  return origLoad.apply(this, arguments);
};

// ── Temp dirs + DEPS ───────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rr-agent-harness-"));
const USERDATA = path.join(TMP, "userData");
const DOWNLOADS = path.join(TMP, "downloads");
fs.mkdirSync(USERDATA, { recursive: true });
fs.mkdirSync(DOWNLOADS, { recursive: true });

let stepLog = [];
const deps = {
  userDataDir: () => USERDATA,
  defaultDownloadDir: () => DOWNLOADS,
  logLine: () => {},
  readSession: () => null,
  launchChromium: async (opts = {}) => chromium.launch({
    ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
    headless: opts.headless !== false,
    args: opts.args || [],
    ...(opts.ignoreDefaultArgs ? { ignoreDefaultArgs: opts.ignoreDefaultArgs } : {}),
  }),
  getMainWindow: () => ({ webContents: { send: (_c, p) => { if (p && p.text) stepLog.push(p.text); } } }),
  appendHistory: () => {},
  reportRun: () => {},
};

// ── Static fixture server ──────────────────────────────────────────────
const F = (n) => fs.readFileSync(path.join(__dirname, "fixtures", n), "utf8");
const ROUTES = {
  "/list": F("applicants.html"),
  "/detail": F("detail.html"),
  "/login": F("login.html"),
  "/irregular": F("irregular.html"),
  "/scroll": F("scroll.html"),
};
const server = http.createServer((req, res) => {
  const body = ROUTES[req.url] || ROUTES["/list"];
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
});

// ── Assertions ─────────────────────────────────────────────────────────
let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`    ✓ ${label}`);
  else { failures++; console.log(`    ✗ ${label}${detail ? "  — " + detail : ""}`); }
}
function readCsv(p) {
  if (!p || !fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf8").trim().split(/\r?\n/);
  const header = lines.shift().split(",").map((h) => h.replace(/"/g, ""));
  return lines.map((ln) => {
    const cells = ln.split(",");
    const row = {}; header.forEach((h, i) => (row[h] = (cells[i] || "").replace(/^"|"$/g, "")));
    return row;
  });
}

// ── Scenario runner ────────────────────────────────────────────────────
async function run(taskPatch) {
  stepLog = [];
  const saved = await ipcHandlers["agent:saveTask"]({}, taskPatch);
  if (!saved.ok) throw new Error("saveTask failed: " + JSON.stringify(saved));
  return ipcHandlers["agent:runNow"]({}, { id: taskPatch.id });
}

(async () => {
  const agent = require(path.join(__dirname, "..", "agent.js"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`\nAgentic crawler harness`);
  console.log(`  chromium: ${CHROMIUM_PATH || "(playwright default)"}`);
  console.log(`  fixtures: ${base}/list , ${base}/detail\n`);

  agent.init(deps);
  await ipcHandlers["agent:setConfig"]({}, { apiKey: "harness-test-key", model: "mock-model", effort: "low" });

  // ── Scenario A · list extract ────────────────────────────────────────
  console.log("Scenario A · list extract");
  MODEL_CALLS = 0;
  MODEL_SCRIPT = (_req, n) => n === 1
    ? tool("extract", { rowSelector: ".applicant", fields: { name: ".name", email: ".email", phone: ".phone" } }, "Extracting the applicant list.")
    : tool("done", { status: "complete", summary: "Done." });
  let res = await run({ id: "scA", name: "List extract", goal: "Extract all applicants.", startUrl: `${base}/list`, enabled: false, replayEnabled: false, downloadDir: DOWNLOADS });
  check("status complete", res.status === "complete", res.status);
  check("3 unique rows (4 in, repeat email deduped)", res.newCount === 3, `newCount=${res.newCount}`);
  check("model driven (extract + done)", MODEL_CALLS === 2, `calls=${MODEL_CALLS}`);
  let rows = readCsv(res.csvPath);
  check("CSV emails correct", JSON.stringify(rows.map((r) => (r.email || "").toLowerCase()).sort()) ===
    JSON.stringify(["aisha.khan@example.com", "jane.doe@example.com", "john.smith@example.com"]), JSON.stringify(rows.map((r) => r.email)));

  // ── Scenario B · detail + reveal (multi-step) ────────────────────────
  console.log("\nScenario B · click into detail + reveal email");
  MODEL_CALLS = 0;
  MODEL_SCRIPT = (req) => {
    if (lastToolResultText(req.messages).startsWith("extract matched")) return tool("done", { status: "complete", summary: "Extracted detail." });
    const snap = latestSnapshot(req.messages);
    const reveal = refByName(snap, (t) => /reveal email/i.test(t));
    if (reveal) return tool("click", { ref: reveal }, "Revealing the email.");
    const open = refByName(snap, (t) => /open details/i.test(t));
    if (open) return tool("click", { ref: open }, "Opening the detail panel.");
    return tool("extract", { rowSelector: ".detail", fields: { name: ".d-name", email: ".d-email", phone: ".d-phone" } }, "Extracting the revealed detail.");
  };
  res = await run({ id: "scB", name: "Detail reveal", goal: "Open each applicant, reveal the email, and record name/email/phone.", startUrl: `${base}/detail`, enabled: false, replayEnabled: false, downloadDir: DOWNLOADS });
  check("status complete", res.status === "complete", res.status);
  check("1 row extracted from the panel", res.newCount === 1, `newCount=${res.newCount}`);
  check("multi-step run (open, reveal, extract, done)", MODEL_CALLS === 4, `calls=${MODEL_CALLS}`);
  rows = readCsv(res.csvPath);
  check("revealed email + name + phone captured", rows[0] && rows[0].email === "jane.doe@example.com" && rows[0].name === "Jane Doe" && rows[0].phone === "555-0101", JSON.stringify(rows[0]));
  const tB = (await ipcHandlers["agent:getTask"]({}, { id: "scB" })).task;
  const recipeKinds = (tB.recipe && tB.recipe.steps || []).map((s) => s.action).join(",");
  check("learned a durable recipe (click,click,extract)", recipeKinds === "click,click,extract", recipeKinds || "(no recipe)");

  // ── Scenario C · learn → replay (zero model calls 2nd run) ───────────
  console.log("\nScenario C · learn once, then replay with no AI");
  MODEL_CALLS = 0;
  MODEL_SCRIPT = (_req, n) => n === 1
    ? tool("extract", { rowSelector: ".applicant", fields: { name: ".name", email: ".email", phone: ".phone" } })
    : tool("done", { status: "complete" });
  // Run 1: AI path learns the recipe (replay ON by default).
  let r1 = await run({ id: "scC", name: "Replay", goal: "Extract all applicants.", startUrl: `${base}/list`, enabled: false, downloadDir: DOWNLOADS });
  const callsAfterLearn = MODEL_CALLS;
  check("run 1 learned a recipe", !!(await ipcHandlers["agent:getTask"]({}, { id: "scC" })).task.recipe, "no recipe");
  // Reset dedupe so the replay re-collects the same rows, and reset the call counter.
  await ipcHandlers["agent:resetSeen"]({}, { id: "scC" });
  MODEL_CALLS = 0;
  let r2 = await ipcHandlers["agent:runNow"]({}, { id: "scC" });
  check("run 1 used the AI", callsAfterLearn === 2, `calls=${callsAfterLearn}`);
  check("run 2 made ZERO model calls (replayed)", MODEL_CALLS === 0, `calls=${MODEL_CALLS}`);
  check("run 2 status complete", r2.status === "complete", r2.status);
  check("run 2 re-extracted 3 rows via the recipe", r2.newCount === 3, `newCount=${r2.newCount}`);

  // ── Scenario D · login wall → blocked ────────────────────────────────
  console.log("\nScenario D · login wall → blocked");
  MODEL_CALLS = 0;
  MODEL_SCRIPT = () => tool("done", { status: "blocked", summary: "Hit a sign-in wall; no session." }, "This is a login wall — I can't proceed.");
  res = await run({ id: "scD", name: "Login wall", goal: "Extract applicants.", startUrl: `${base}/login`, enabled: false, replayEnabled: false, downloadDir: DOWNLOADS });
  check("status blocked", res.status === "blocked", res.status);
  check("ok:true with 0 rows", res.ok === true && res.newCount === 0, `ok=${res.ok} newCount=${res.newCount}`);
  check("no recipe learned on a blocked run", !(await ipcHandlers["agent:getTask"]({}, { id: "scD" })).task.recipe, "recipe present");

  // ── Scenario E · save_rows (irregular, non-tabular data) ─────────────
  console.log("\nScenario E · save_rows (irregular data)");
  MODEL_CALLS = 0;
  MODEL_SCRIPT = (_req, n) => n === 1
    ? tool("save_rows", { rows: [
        { name: "Maria Lopez", email: "maria.lopez@example.com", phone: "555-0200" },
        { name: "Sam Rivera", email: "sam.rivera@example.com" },
        { name: "Maria Lopez (dup)", email: "MARIA.LOPEZ@example.com" }, // dedupes by email
      ] }, "Reading the two contacts from the notes.")
    : tool("done", { status: "complete", summary: "Saved contacts." });
  res = await run({ id: "scE", name: "Irregular", goal: "Record any contacts mentioned in the notes.", startUrl: `${base}/irregular`, enabled: false, replayEnabled: false, downloadDir: DOWNLOADS });
  check("status complete", res.status === "complete", res.status);
  check("2 rows saved (3 in, dup email collapsed)", res.newCount === 2, `newCount=${res.newCount}`);
  rows = readCsv(res.csvPath);
  check("save_rows emails correct", JSON.stringify(rows.map((r) => (r.email || "").toLowerCase()).sort()) ===
    JSON.stringify(["maria.lopez@example.com", "sam.rivera@example.com"]), JSON.stringify(rows.map((r) => r.email)));

  // ── Scenario F · scroll to reveal lazy-loaded rows ───────────────────
  console.log("\nScenario F · scroll / lazy pagination");
  MODEL_CALLS = 0;
  MODEL_SCRIPT = (_req, n) => {
    if (n === 1) return tool("scroll", { direction: "down" }, "Scrolling to load more rows.");
    if (n === 2) return tool("extract", { rowSelector: ".applicant", fields: { name: ".name", email: ".email", phone: ".phone" } }, "Extracting the full list.");
    return tool("done", { status: "complete", summary: "Got all rows." });
  };
  res = await run({ id: "scF", name: "Scroll", goal: "Extract every applicant, scrolling as needed.", startUrl: `${base}/scroll`, enabled: false, replayEnabled: false, downloadDir: DOWNLOADS });
  check("status complete", res.status === "complete", res.status);
  check("4 rows after scroll (2 lazy-loaded)", res.newCount === 4, `newCount=${res.newCount}`);

  // ── Scenario G · off-domain navigate is refused (safety guard) ───────
  console.log("\nScenario G · off-domain navigate refusal");
  MODEL_CALLS = 0;
  let offDomainRefused = false;
  MODEL_SCRIPT = (req, n) => {
    if (n === 1) return tool("navigate", { url: "https://evil.example.com/steal" }, "Trying to open an external page.");
    if (n === 2) {
      if (/^Refused:/.test(lastToolResultText(req.messages))) offDomainRefused = true;
      return tool("extract", { rowSelector: ".applicant", fields: { name: ".name", email: ".email", phone: ".phone" } }, "Staying on the portal and extracting.");
    }
    return tool("done", { status: "complete", summary: "Done on-portal." });
  };
  res = await run({ id: "scG", name: "Off-domain", goal: "Extract applicants.", startUrl: `${base}/list`, enabled: false, replayEnabled: false, downloadDir: DOWNLOADS });
  check("off-domain navigate was refused", offDomainRefused === true, "navigate was not refused");
  check("stayed on portal + extracted 3 rows", res.status === "complete" && res.newCount === 3, `status=${res.status} newCount=${res.newCount}`);

  await new Promise((r) => server.close(r));
  console.log(failures === 0 ? "\n✅ All scenarios passed.\n" : `\n❌ ${failures} assertion(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("\nHarness crashed:", e);
  try { server.close(); } catch {}
  process.exit(1);
});
