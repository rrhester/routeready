#!/usr/bin/env node
/**
 * agent-harness.js · local test harness for the agentic crawler (agent.js).
 *
 * What it does
 *   Drives the REAL agent pipeline end-to-end against a local fixture page,
 *   with only two things faked:
 *     1. electron            — agent.js requires { ipcMain, safeStorage }.
 *     2. @anthropic-ai/sdk   — replaced with a scripted "model" so the run is
 *                              deterministic and costs nothing / needs no key
 *                              or network. The model returns one `extract`
 *                              tool call, then `done`.
 *   Everything else is the real code: takeSnapshot, runTool, runExtract /
 *   extractInPage (run in a real headless Chromium against the fixture),
 *   the dedupe set, CSV writing, and recipe-learning.
 *
 * Why
 *   The portal-facing DOM logic (snapshot + extract selectors + dedupe) is the
 *   part most likely to break and the hardest to eyeball. This exercises it
 *   for real without needing the Electron app, a live portal, or auth.
 *
 * Run
 *   node desktop/test/agent-harness.js
 *   (exit code 0 = all assertions passed, 1 = a failure)
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const Module = require("node:module");

// ── Locate Playwright + a Chromium binary ──────────────────────────────
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
  return null; // let Playwright use its default resolution
}
const { chromium } = loadPlaywright();
const CHROMIUM_PATH = findChromium();

// ── Scripted stand-in for the Anthropic SDK ────────────────────────────
// agent.js does: const Anthropic = require("@anthropic-ai/sdk"); new Anthropic(..)
// then callModel() -> client.messages.create(...). We return a fixed two-turn
// script: extract the applicant list, then finish.
let MODEL_CALLS = 0;
class FakeAnthropic {
  constructor(opts) {
    this.opts = opts;
    this.messages = { create: async (req) => this._create(req) };
  }
  async _create() {
    MODEL_CALLS++;
    if (MODEL_CALLS === 1) {
      return {
        content: [
          { type: "text", text: "Reading the applicant list and extracting each row." },
          {
            type: "tool_use",
            id: "tool_extract_1",
            name: "extract",
            input: {
              rowSelector: ".applicant",
              fields: { name: ".name", email: ".email", phone: ".phone" },
            },
          },
        ],
      };
    }
    return {
      content: [
        { type: "text", text: "All applicants recorded." },
        { type: "tool_use", id: "tool_done_1", name: "done", input: { status: "complete", summary: "Extracted all applicants." } },
      ],
    };
  }
}

// ── Fake electron (ipcMain records handlers; safeStorage round-trips) ───
const ipcHandlers = {};
const fakeElectron = {
  ipcMain: { handle: (name, fn) => { ipcHandlers[name] = fn; }, on: () => {} },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(String(s), "utf8"),
    decryptString: (b) => Buffer.from(b).toString("utf8"),
  },
};

// Intercept the two requires before agent.js loads.
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return fakeElectron;
  if (request === "@anthropic-ai/sdk") return FakeAnthropic;
  return origLoad.apply(this, arguments);
};

// ── Temp dirs + fake DEPS ──────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rr-agent-harness-"));
const USERDATA = path.join(TMP, "userData");
const DOWNLOADS = path.join(TMP, "downloads");
fs.mkdirSync(USERDATA, { recursive: true });
fs.mkdirSync(DOWNLOADS, { recursive: true });

const steps = [];
const deps = {
  userDataDir: () => USERDATA,
  defaultDownloadDir: () => DOWNLOADS,
  logLine: (...a) => console.log("   [agent]", ...a),
  readSession: () => null, // no portal auth needed for the local fixture
  launchChromium: async (opts = {}) =>
    chromium.launch({
      ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
      headless: opts.headless !== false,
      args: opts.args || [],
      ...(opts.ignoreDefaultArgs ? { ignoreDefaultArgs: opts.ignoreDefaultArgs } : {}),
    }),
  getMainWindow: () => null, // emitStep no-ops
  appendHistory: () => {},
  reportRun: () => {},
};

// Capture emitted steps so the harness can print them (optional visibility).
deps.getMainWindow = () => ({
  webContents: { send: (_channel, payload) => { if (payload && payload.text) steps.push(payload); } },
});

// ── Tiny static server for the fixture ─────────────────────────────────
const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "applicants.html"), "utf8");
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(FIXTURE);
});

// ── Assertions ─────────────────────────────────────────────────────────
let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail ? "  — " + detail : ""}`); }
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift().split(",");
  return lines.map((ln) => {
    // naive CSV split is fine for this fixture (no embedded commas/quotes)
    const cells = ln.split(",");
    const row = {};
    header.forEach((h, i) => (row[h.replace(/"/g, "")] = (cells[i] || "").replace(/^"|"$/g, "")));
    return row;
  });
}

(async () => {
  const agent = require(path.join(__dirname, "..", "agent.js"));

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const startUrl = `http://127.0.0.1:${port}/`;
  console.log(`\nAgentic crawler harness`);
  console.log(`  fixture:  ${startUrl}`);
  console.log(`  chromium: ${CHROMIUM_PATH || "(playwright default)"}`);
  console.log(`  userData: ${USERDATA}\n`);

  agent.init(deps);

  // Local API key so makeAnthropic() builds our FakeAnthropic client.
  await ipcHandlers["agent:setConfig"]({}, { apiKey: "harness-test-key", model: "mock-model", effort: "low" });

  const saved = await ipcHandlers["agent:saveTask"]({}, {
    id: "harness-task",
    name: "Harness — applicant extract",
    goal: "Extract every applicant's name, email and phone from the list.",
    startUrl,
    enabled: false,        // don't let the scheduler loop also run it
    replayEnabled: false,  // always exercise the AI path (not a learned recipe)
    downloadDir: DOWNLOADS,
  });
  check("task saved", saved && saved.ok, JSON.stringify(saved));

  console.log("\nRunning the agent against the fixture...\n");
  const res = await ipcHandlers["agent:runNow"]({}, { id: "harness-task" });

  console.log("\nResult:", JSON.stringify({ ...res, csvPath: res && res.csvPath ? path.basename(res.csvPath) : null }));
  console.log("\nAssertions:");
  check("run ok", res && res.ok === true, JSON.stringify(res));
  check("status complete", res && res.status === "complete", res && res.status);
  check("extracted 3 unique rows (dedupes the repeat email)", res && res.newCount === 3, `newCount=${res && res.newCount}`);
  check("model was actually driven (2 turns: extract, done)", MODEL_CALLS === 2, `calls=${MODEL_CALLS}`);

  // CSV sink
  let csvRows = [];
  if (res && res.csvPath && fs.existsSync(res.csvPath)) {
    csvRows = parseCsv(fs.readFileSync(res.csvPath, "utf8"));
  }
  check("CSV written", res && res.csvPath && fs.existsSync(res.csvPath), res && res.csvPath);
  check("CSV has 3 data rows", csvRows.length === 3, `rows=${csvRows.length}`);
  const emails = csvRows.map((r) => (r.email || "").toLowerCase()).sort();
  check(
    "CSV emails correct",
    JSON.stringify(emails) === JSON.stringify(["aisha.khan@example.com", "jane.doe@example.com", "john.smith@example.com"]),
    JSON.stringify(emails)
  );
  const jane = csvRows.find((r) => (r.email || "").toLowerCase() === "jane.doe@example.com");
  check("name + phone extracted", jane && jane.name === "Jane Doe" && jane.phone === "555-0101", JSON.stringify(jane));

  console.log("\nAgent step log:");
  for (const s of steps) console.log(`   · ${s.text}`);

  await server.close();
  console.log(failures === 0 ? "\n✅ All assertions passed.\n" : `\n❌ ${failures} assertion(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("\nHarness crashed:", e);
  try { server.close(); } catch {}
  process.exit(1);
});
