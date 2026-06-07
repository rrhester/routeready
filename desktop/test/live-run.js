#!/usr/bin/env node
/**
 * live-run.js · run the REAL agentic crawler against a REAL site, locally.
 *
 * Unlike agent-harness.js (which scripts the model and uses local fixtures),
 * this uses the REAL Claude model and a REAL browser against a URL you choose,
 * so you can judge the agent's actual decisions. Only `electron` is stubbed so
 * it runs under plain `node`; the Anthropic SDK + Playwright are the real deps.
 *
 * Setup (once), from the desktop/ folder:
 *   npm install                 # installs @anthropic-ai/sdk + playwright (+ chromium via postinstall)
 *   npx playwright install chromium   # if the postinstall didn't fetch it
 *
 * Run:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   node test/live-run.js "<startUrl>" "<goal>" [options]
 *
 * Options:
 *   --visible            show the browser window (recommended for sites with bot
 *                        protection, e.g. Indeed/Cloudflare; default headless)
 *   --session <file>     a Playwright storageState JSON to load (for logged-in
 *                        portals — export it from a signed-in session)
 *   --model <id>         override the model (default: agent's DEFAULT_MODEL)
 *   --effort <low|medium|high>
 *   --out <dir>          where to write the CSV (default ./rr-live-out)
 *   --max <n>            (info only) the agent's own step cap still applies
 *
 * Examples:
 *   node test/live-run.js "https://books.toscrape.com/" \
 *     "List every book on this page. Use extract: rowSelector = each book card, fields name=title, price=price."
 *
 *   node test/live-run.js --visible --session ~/indeed-session.json \
 *     "https://employers.indeed.com/candidates" \
 *     "For each applicant, reveal name/email/phone and save_rows them. Page through the list."
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const Module = require("node:module");

// ── args ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opts = { visible: false, session: null, model: null, effort: null, out: path.resolve("rr-live-out") };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--visible") opts.visible = true;
  else if (a === "--session") opts.session = argv[++i];
  else if (a === "--model") opts.model = argv[++i];
  else if (a === "--effort") opts.effort = argv[++i];
  else if (a === "--out") opts.out = path.resolve(argv[++i]);
  else if (a === "--max") opts.max = argv[++i];
  else positional.push(a);
}
const [startUrl, goal] = positional;

function die(msg) { console.error("\n✖ " + msg + "\n"); process.exit(1); }
if (!startUrl || !goal) {
  console.error("\nUsage: node test/live-run.js \"<startUrl>\" \"<goal>\" [--visible] [--session file] [--model id] [--effort low|medium|high] [--out dir]\n");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) die("Set ANTHROPIC_API_KEY first:  export ANTHROPIC_API_KEY=sk-ant-...");
let sessionJson = null;
if (opts.session) {
  try { sessionJson = fs.readFileSync(path.resolve(opts.session), "utf8"); }
  catch (e) { die(`Couldn't read --session file: ${e.message}`); }
}

// ── real Playwright (chromium) ─────────────────────────────────────────
let chromium;
try { ({ chromium } = require("playwright")); }
catch { die("Playwright not installed. From the desktop/ folder run:  npm install  (then: npx playwright install chromium)"); }

// ── stub only electron (Anthropic SDK + Playwright stay real) ──────────
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
  return origLoad.apply(this, arguments);
};

// ── temp userData; chosen output dir ───────────────────────────────────
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "rr-live-"));
fs.mkdirSync(opts.out, { recursive: true });

const KIND_ICON = { start: "▶", think: "💭", action: "→", ok: "✓", info: "·", error: "✗" };
const deps = {
  userDataDir: () => USERDATA,
  defaultDownloadDir: () => opts.out,
  logLine: (...a) => console.error("   [agent]", ...a),
  readSession: () => sessionJson, // null unless --session given
  launchChromium: async (o = {}) => chromium.launch({
    headless: o.headless !== false,
    args: o.args || [],
    ...(o.ignoreDefaultArgs ? { ignoreDefaultArgs: o.ignoreDefaultArgs } : {}),
  }),
  // Live progress: print each agent step as it happens.
  getMainWindow: () => ({
    webContents: {
      send: (channel, payload) => {
        if (channel === "agent:step" && payload && payload.text) {
          const icon = KIND_ICON[payload.kind] || "·";
          console.log(`  ${icon} ${payload.text}`);
        }
      },
    },
  }),
  appendHistory: () => {},
  reportRun: () => {},
};

(async () => {
  const agent = require(path.join(__dirname, "..", "agent.js"));
  agent.init(deps);

  await ipcHandlers["agent:setConfig"]({}, {
    apiKey: process.env.ANTHROPIC_API_KEY,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
  });

  const saved = await ipcHandlers["agent:saveTask"]({}, {
    id: "live-run",
    name: "Live run",
    goal,
    startUrl,
    enabled: false,
    replayEnabled: false,         // always use the real model (this is a live test)
    visibleBrowser: opts.visible,
    downloadDir: opts.out,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
  });
  if (!saved.ok) die("saveTask failed: " + JSON.stringify(saved));

  console.log(`\nLive agent run`);
  console.log(`  url:    ${startUrl}`);
  console.log(`  goal:   ${goal}`);
  console.log(`  model:  ${opts.model || "(agent default)"}   effort: ${opts.effort || "(default)"}`);
  console.log(`  browser:${opts.visible ? " visible" : " headless"}   session:${opts.session ? " loaded" : " none"}`);
  console.log(`  out:    ${opts.out}\n`);
  console.log("Steps:");

  const res = await ipcHandlers["agent:runNow"]({}, { id: "live-run" });

  console.log("\nResult:", JSON.stringify({
    ok: res.ok, status: res.status, newRows: res.newCount, steps: res.steps, errors: res.errors,
  }));
  if (res.summary) console.log("Summary:", res.summary);

  // Show the extracted rows.
  if (res.csvPath && fs.existsSync(res.csvPath)) {
    const csv = fs.readFileSync(res.csvPath, "utf8");
    const lines = csv.trim().split(/\r?\n/);
    console.log(`\nCSV: ${res.csvPath}  (${Math.max(0, lines.length - 1)} data row(s))`);
    console.log(lines.slice(0, 11).join("\n"));   // header + up to 10 rows
    if (lines.length > 11) console.log(`… (+${lines.length - 11} more)`);
  }
  console.log("");
  process.exit(res.ok ? 0 : 2);
})().catch((e) => { console.error("\nLive run crashed:", e); process.exit(1); });
