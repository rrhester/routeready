// RouteReady Desktop · Electron main process.
//
// Owns the BrowserWindow that renders the local UI, plus the
// Playwright-driven Chromium that drives the operator's Amazon DSP
// portal session. IPC bridges the two.
//
// Auth model: manual first login. We launch a headed Playwright
// browser, the operator signs into Amazon with their corporate
// SSO + MFA, and Playwright captures the storageState (cookies +
// localStorage). We encrypt that with Electron's safeStorage (OS
// keychain) and persist to userData. Future runs reuse the state;
// when it's expired, the portal redirects to login and we surface
// "session expired" in the UI so the operator can re-auth.
//
// Nothing here ever sees the operator's password — Amazon collects
// it in their own login UI inside the headed Chromium.

const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// Tell Playwright to look for Chromium under node_modules/playwright-core/
// .local-browsers/ rather than the global ms-playwright cache. The build
// pipeline installs Chromium there using the same PLAYWRIGHT_BROWSERS_PATH=0
// env var, and asarUnpack in package.json keeps the binaries on the real
// filesystem so they can actually exec. Must be set BEFORE requiring playwright.
process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
const { chromium } = require("playwright");

// ─── Diagnostic logging ─────────────────────────────────────────────
// Writes a line to <userData>/desktop.log every time we touch Playwright
// or hit an error.  When something breaks on a customer's machine they
// can find this file and send it to support — way better than asking
// them to run from a terminal.
function logFile() { return path.join(app.getPath("userData"), "desktop.log"); }
function logLine(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map(p => typeof p === "string" ? p : JSON.stringify(p)).join(" ")}\n`;
  try { fs.appendFileSync(logFile(), line); } catch {}
  console.log(line.trim());
}

// ─── Resolve Chromium executable inside the packaged app ────────────
// In a packaged Electron app, node_modules lives inside app.asar — but
// native binaries can't exec from inside an asar archive.  Our
// package.json `asarUnpack` extracts Playwright's browsers to
// app.asar.unpacked.  Playwright's own path-resolution logic relies on
// reading from disk relative to __dirname, which Electron's asar shim
// is supposed to redirect — but in practice the redirection is unreliable
// for child_process.spawn().  Safest move: resolve the path ourselves and
// pass executablePath explicitly to chromium.launch().
function resolveChromiumExecutable() {
  if (!app.isPackaged) return undefined; // dev → let Playwright find it
  const browsersRoot = path.join(
    process.resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "playwright-core",
    ".local-browsers",
  );
  if (!fs.existsSync(browsersRoot)) {
    logLine("chromium: browsers root not found at", browsersRoot);
    return undefined;
  }
  const entries = fs.readdirSync(browsersRoot);
  const chromiumDir = entries.find((n) => n.startsWith("chromium-") && !n.endsWith("headless_shell"));
  if (!chromiumDir) {
    logLine("chromium: no chromium-* dir inside", browsersRoot, "entries:", entries);
    return undefined;
  }
  const platformSubpath = process.platform === "win32"
    ? path.join("chrome-win", "chrome.exe")
    : process.platform === "darwin"
      ? path.join("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium")
      : path.join("chrome-linux", "chrome");
  const exe = path.join(browsersRoot, chromiumDir, platformSubpath);
  if (!fs.existsSync(exe)) {
    logLine("chromium: executable missing at", exe);
    return undefined;
  }
  logLine("chromium: resolved", exe);
  return exe;
}

let CHROMIUM_EXEC_PATH = null;

async function launchChromium(opts = {}) {
  if (CHROMIUM_EXEC_PATH === null) CHROMIUM_EXEC_PATH = resolveChromiumExecutable() || undefined;
  const launchOpts = { ...opts };
  if (CHROMIUM_EXEC_PATH) launchOpts.executablePath = CHROMIUM_EXEC_PATH;
  try {
    return await chromium.launch(launchOpts);
  } catch (err) {
    logLine("chromium.launch threw:", String(err && err.stack || err));
    throw err;
  }
}

// Where we keep the encrypted storage state + electron-store config.
const userDataDir = () => app.getPath("userData");
const sessionFile = () => path.join(userDataDir(), "portal-session.enc");
const historyFile = () => path.join(userDataDir(), "download-history.json");
const configFile = () => path.join(userDataDir(), "config.json");
const defaultDownloadDir = () => app.getPath("downloads");
const HISTORY_LIMIT = 20;

// Default Portal URL. Operator can override per-install via the
// "Portal URL" input in section 1 — useful for testing against any
// portal (Indeed, Workday, etc.) before pointing at Amazon.
const DEFAULT_PORTAL_URL = "https://logistics.amazon.com/";

// ─── Config (portal URL + future settings) ──────────────────────────
// Tiny JSON-on-disk store. electron-store v10 is ESM-only so we
// hand-roll this — only one or two keys for now.

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), "utf8")); } catch { return {}; }
}

function writeConfig(patch) {
  const cur = readConfig();
  const next = { ...cur, ...patch };
  try { fs.writeFileSync(configFile(), JSON.stringify(next, null, 2)); } catch (e) {
    console.warn("config write failed:", e);
  }
  return next;
}

function effectivePortalUrl() {
  const cfg = readConfig();
  return (cfg.portalUrl && cfg.portalUrl.trim()) || DEFAULT_PORTAL_URL;
}

let mainWindow = null;
let portalContext = null; // Playwright BrowserContext, kept alive between actions.
let portalBrowser = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    title: "RouteReady Desktop",
    backgroundColor: "#F8FAFC",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Open DevTools in dev only.
  if (!app.isPackaged) mainWindow.webContents.openDevTools({ mode: "detach" });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  logLine("app ready, version=", app.getVersion(), "packaged=", app.isPackaged, "platform=", process.platform);
  // Resolve Chromium up-front so its discovery is recorded in the log
  // before the operator clicks anything.  Failures here aren't fatal —
  // the launch path will surface a dialog if it actually breaks.
  resolveChromiumExecutable();
  createWindow();
});

app.on("window-all-closed", async () => {
  await tearDownPortal();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── Session persistence (encrypted storageState) ───────────────────
// Playwright's `storageState` is { cookies, origins }. We JSON-stringify,
// encrypt via OS keychain, and write to disk. On launch we attempt to
// decrypt; failures are non-fatal — operator just signs in again.

function writeSession(stateJson) {
  if (!safeStorage.isEncryptionAvailable()) {
    // Fallback to plaintext if the OS doesn't support encryption.
    // Keychain access is unavailable in some headless environments.
    fs.writeFileSync(sessionFile() + ".plain", stateJson);
    return { encrypted: false };
  }
  const buf = safeStorage.encryptString(stateJson);
  fs.writeFileSync(sessionFile(), buf);
  return { encrypted: true };
}

function readSession() {
  // Prefer the encrypted file; fall back to plaintext on systems
  // without keychain support.
  const enc = sessionFile();
  if (fs.existsSync(enc) && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(fs.readFileSync(enc));
    } catch (e) {
      console.warn("session decrypt failed, falling back:", e);
    }
  }
  const plain = enc + ".plain";
  if (fs.existsSync(plain)) return fs.readFileSync(plain, "utf8");
  return null;
}

function clearSession() {
  for (const f of [sessionFile(), sessionFile() + ".plain"]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

// ─── Playwright browser lifecycle ───────────────────────────────────

async function ensurePortal({ headed = false } = {}) {
  if (portalContext) return portalContext;
  portalBrowser = await launchChromium({ headless: !headed });
  const stateJson = readSession();
  portalContext = await portalBrowser.newContext({
    storageState: stateJson ? JSON.parse(stateJson) : undefined,
    viewport: { width: 1280, height: 800 },
  });
  return portalContext;
}

async function tearDownPortal() {
  try { if (portalContext) await portalContext.close(); } catch {}
  try { if (portalBrowser) await portalBrowser.close(); } catch {}
  portalContext = null;
  portalBrowser = null;
}

// ─── IPC handlers ───────────────────────────────────────────────────
// Exposed to the renderer via preload's contextBridge.

ipcMain.handle("portal:login", async (_evt, { portalUrl } = {}) => {
  // Tear down any previous (headless) context so we can launch a
  // visible browser the operator can interact with.
  try {
    await tearDownPortal();
    logLine("portal:login starting, url=", portalUrl || effectivePortalUrl());
    portalBrowser = await launchChromium({ headless: false });
    portalContext = await portalBrowser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await portalContext.newPage();
    const url = portalUrl || effectivePortalUrl();
    await page.goto(url);
    logLine("portal:login opened", url);
    return { ok: true, message: "Login window open. Sign in, then click 'I'm signed in' here." };
  } catch (err) {
    const msg = String(err && err.message || err);
    logLine("portal:login FAILED:", msg);
    // Surface the failure prominently. The renderer also logs the error
    // in its in-app log strip, but customers don't always look there.
    const detail = [
      "RouteReady couldn't open the sign-in browser.",
      "",
      "Error: " + msg,
      "",
      "Diagnostics log: " + logFile(),
    ].join("\n");
    dialog.showErrorBox("Sign-in failed", detail);
    return { ok: false, error: msg };
  }
});

ipcMain.handle("portal:saveSession", async () => {
  if (!portalContext) return { ok: false, error: "no_portal_context" };
  const state = await portalContext.storageState();
  const json = JSON.stringify(state);
  const { encrypted } = writeSession(json);
  return { ok: true, encrypted, cookieCount: (state.cookies || []).length };
});

ipcMain.handle("portal:logout", async () => {
  await tearDownPortal();
  clearSession();
  return { ok: true };
});

ipcMain.handle("portal:hasSession", async () => {
  return { hasSession: !!readSession() };
});

// Diagnostic: open the DSP portal headless using the persisted session
// and report what we land on. If we get bounced to a login URL the
// session has expired.
ipcMain.handle("portal:probe", async (_evt, { portalUrl } = {}) => {
  const ctx = await ensurePortal({ headed: false });
  const page = await ctx.newPage();
  try {
    await page.goto(portalUrl || effectivePortalUrl(), { waitUntil: "domcontentloaded", timeout: 30000 });
    const finalUrl = page.url();
    const title = await page.title();
    const isLogin = /signin|ap\/signin|login/i.test(finalUrl);
    return { ok: true, finalUrl, title, isLogin };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    await page.close();
  }
});

ipcMain.handle("config:get", async () => {
  return { ok: true, portalUrl: effectivePortalUrl(), defaultPortalUrl: DEFAULT_PORTAL_URL };
});

ipcMain.handle("config:set", async (_evt, { portalUrl } = {}) => {
  const patch = {};
  if (typeof portalUrl === "string") patch.portalUrl = portalUrl.trim();
  writeConfig(patch);
  return { ok: true, portalUrl: effectivePortalUrl() };
});

// ─── Report download ────────────────────────────────────────────────
// Generic file-download flow that reuses the persisted portal session.
// Operator gives us a URL (and optionally a click-selector for a page
// where the file sits behind a button). We navigate with whatever
// storageState we have on disk and wait for a download event.
//
// This is deliberately portal-agnostic so we can shake it down against
// any benign target (a plain-text file URL, a CSV download page, etc.)
// before pointing it at the Amazon DSP reports console.

function readHistory() {
  try {
    const raw = fs.readFileSync(historyFile(), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function appendHistory(entry) {
  const list = readHistory();
  list.unshift(entry);
  const trimmed = list.slice(0, HISTORY_LIMIT);
  try {
    fs.writeFileSync(historyFile(), JSON.stringify(trimmed, null, 2));
  } catch (e) {
    console.warn("history write failed:", e);
  }
  return trimmed;
}

ipcMain.handle("reports:listHistory", async () => {
  return { ok: true, entries: readHistory() };
});

ipcMain.handle("reports:pickDownloadDir", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose download folder",
    defaultPath: defaultDownloadDir(),
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  return { ok: true, dir: result.filePaths[0] };
});

ipcMain.handle("reports:openInFolder", async (_evt, { filePath } = {}) => {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: "missing_file" };
  shell.showItemInFolder(filePath);
  return { ok: true };
});

ipcMain.handle("reports:download", async (_evt, args = {}) => {
  const { url, clickSelector, downloadDir, timeoutMs = 60000 } = args;
  if (!url || typeof url !== "string") {
    return { ok: false, error: "missing_url", message: "Give me a URL to fetch." };
  }
  const dir = downloadDir || defaultDownloadDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}

  const ctx = await ensurePortal({ headed: false });
  // acceptDownloads is on by default for contexts created with
  // newContext(), so no extra wiring needed.
  const page = await ctx.newPage();
  try {
    const downloadPromise = page.waitForEvent("download", { timeout: timeoutMs });

    if (clickSelector && clickSelector.trim()) {
      // Two-step: load the page, then click the thing that triggers
      // the download. This is the typical Amazon-reports shape.
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      await page.click(clickSelector.trim(), { timeout: timeoutMs });
    } else {
      // Direct file URL. Chromium aborts the navigation once it
      // recognises a download — that throw is expected, so swallow.
      page.goto(url, { timeout: timeoutMs }).catch(() => {});
    }

    const download = await downloadPromise;
    const suggested = download.suggestedFilename() || "download.bin";
    // Stamp the filename so consecutive pulls don't clobber each
    // other (Amazon reports often have identical default names).
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = path.parse(suggested);
    const finalName = `${base.name}-${stamp}${base.ext || ""}`;
    const savePath = path.join(dir, finalName);
    await download.saveAs(savePath);

    const stat = fs.statSync(savePath);
    const entry = {
      ts: new Date().toISOString(),
      url,
      clickSelector: clickSelector || null,
      filePath: savePath,
      suggestedName: suggested,
      size: stat.size,
    };
    appendHistory(entry);
    return { ok: true, ...entry };
  } catch (e) {
    const msg = String(e?.message || e);
    appendHistory({
      ts: new Date().toISOString(),
      url,
      clickSelector: clickSelector || null,
      error: msg,
    });
    return { ok: false, error: "download_failed", message: msg };
  } finally {
    try { await page.close(); } catch {}
  }
});
