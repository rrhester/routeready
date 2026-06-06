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

const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, shell, Tray } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// Tell Playwright to look for Chromium under node_modules/playwright-core/
// .local-browsers/ rather than the global ms-playwright cache. The build
// pipeline installs Chromium there using the same PLAYWRIGHT_BROWSERS_PATH=0
// env var, and asarUnpack in package.json keeps the binaries on the real
// filesystem so they can actually exec. Must be set BEFORE requiring playwright.
process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
const { chromium } = require("playwright");
const scraper = require("./scraper");
const agent = require("./agent");

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
  // We disable asar packaging in package.json, so node_modules sits under
  // resources/app/ as plain files.  Also check resources/app.asar.unpacked/
  // as a fallback in case the build config ever flips back to asar.
  const candidates = [
    path.join(process.resourcesPath, "app", "node_modules", "playwright-core", ".local-browsers"),
    path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "playwright-core", ".local-browsers"),
  ];
  let browsersRoot = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) { browsersRoot = c; break; }
  }
  if (!browsersRoot) {
    logLine("chromium: no browsers root found, tried:", candidates);
    return undefined;
  }
  const entries = fs.readdirSync(browsersRoot);
  // Prefer the full Chromium dir; fall back to headless_shell if that's all
  // we've got (some Playwright versions only ship the lighter one by default).
  let chromiumDir = entries.find((n) => n.startsWith("chromium-") && !n.includes("headless_shell"));
  if (!chromiumDir) chromiumDir = entries.find((n) => n.startsWith("chromium-"));
  if (!chromiumDir) {
    logLine("chromium: no chromium-* dir in", browsersRoot, "entries:", entries);
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
const schedulerFile = () => path.join(userDataDir(), "scheduler.json");
const defaultDownloadDir = () => app.getPath("downloads");
const HISTORY_LIMIT = 20;
const SCHEDULER_TICK_MS = 30000;

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
let tray = null;
// Background-agent lifecycle: closing the window hides to the tray so the
// scheduler keeps firing scheduled crawls/downloads unattended. The app
// only really exits when the operator picks "Quit" from the tray (or the
// OS issues a quit), which flips this flag.
app.isQuitting = false;

// ─── System tray (keeps the sync engine alive in the background) ─────
function trayImage() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, "build", "icon.png"));
    if (!img.isEmpty()) return img.resize({ width: 18, height: 18 });
  } catch (e) { logLine("tray: icon load failed:", String(e)); }
  return nativeImage.createEmpty();
}

function showWindow() {
  if (!mainWindow) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function buildTray() {
  if (tray) return;
  try {
    tray = new Tray(trayImage());
  } catch (e) {
    // Some headless Linux sessions have no status-notifier host; the app
    // still works, it just won't show a tray icon. Don't let that crash us.
    logLine("tray: create failed (no tray host?):", String(e));
    return;
  }
  tray.setToolTip("RouteReady Desktop — background sync");
  const menu = Menu.buildFromTemplate([
    { label: "Open RouteReady", click: showWindow },
    { type: "separator" },
    { label: "Quit RouteReady", click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", showWindow);
  tray.on("double-click", showWindow);
}

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

  // Hide to tray instead of quitting when the operator closes the window,
  // so background syncs keep running. Real exit goes through app.isQuitting.
  mainWindow.on("close", (e) => {
    // Only hide-to-tray if we actually have a tray to restore from —
    // otherwise (no status-notifier host) let the window close normally
    // so the app stays quittable.
    if (!app.isQuitting && tray) { e.preventDefault(); mainWindow.hide(); }
  });

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
  ensureSchedulerSeeded();
  startSchedulerLoop();
  scraper.init({
    userDataDir,
    defaultDownloadDir,
    logLine,
    launchChromium,
    tearDownPortal,
    readSession,
    appendHistory,
    getMainWindow: () => mainWindow,
  });
  agent.init({
    userDataDir,
    defaultDownloadDir,
    logLine,
    launchChromium,
    readSession,
    appendHistory,
    getMainWindow: () => mainWindow,
  });
  createWindow();
  buildTray();

  // Start with the OS at login so the sync engine is up after a reboot
  // without the operator thinking about it. Packaged only — we don't want
  // dev runs registering autostart. Linux support varies by desktop env;
  // best-effort, never fatal.
  if (app.isPackaged) {
    try { app.setLoginItemSettings({ openAtLogin: true }); }
    catch (e) { logLine("setLoginItemSettings failed:", String(e)); }
  }
});

// Background sync engine: with a tray present, don't quit when the window
// closes — it hides to the tray and the scheduler keeps firing. Without a
// tray (no status-notifier host), fall back to the normal quit-on-close so
// the app can't get stranded with no window and no tray icon.
app.on("window-all-closed", () => {
  if (!tray && process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  app.isQuitting = true;
  // Best-effort teardown of the persistent portal browser on the way out.
  tearDownPortal().catch(() => {});
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else showWindow();
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

    // Auto-save the session the moment the operator finishes signing
    // in — eliminates the "I'm signed in" button click that
    // non-technical users (the original report: the operator's
    // brother) routinely missed. Two triggers, whichever fires first:
    //   1. The headed page navigates to a URL that's clearly post-
    //      auth (host matches the portal, path is not a login path).
    //      We wait 2s after the transition so trailing cookies from
    //      the auth handshake make it into storageState.
    //   2. The operator closes the headed Chromium window. That's a
    //      strong "I'm done" signal even if we missed the URL
    //      transition (e.g. they cancelled and reopened).
    let autoSaved = false;
    const saveOnce = async (trigger) => {
      if (autoSaved || !portalContext) return;
      try {
        const state = await portalContext.storageState();
        const json = JSON.stringify(state);
        const { encrypted } = writeSession(json);
        autoSaved = true;
        logLine("portal:login auto-saved", trigger, "cookies=", (state.cookies || []).length, "encrypted=", encrypted);
        try {
          mainWindow?.webContents.send("portal:autoSaved", {
            trigger,
            cookieCount: (state.cookies || []).length,
            encrypted,
            url: page.isClosed() ? "(window closed)" : page.url(),
          });
        } catch {}
      } catch (e) {
        logLine("portal:login auto-save failed:", String(e));
      }
    };

    const isLoginUrl = (u) => /sign[-_]?in|signup|ap\/signin|login|auth|account\/?login|accounts\.|verify|2fa|otp|challenge/i.test(u || "");
    const hostMatch = (u) => {
      try {
        const a = new URL(u).host.replace(/^www\./, "");
        const b = new URL(url).host.replace(/^www\./, "");
        // Permissive — Indeed bounces between employers.indeed.com,
        // secure.indeed.com, accounts.indeed.com etc. during login;
        // we want to match anything on the same registered domain.
        const aRoot = a.split(".").slice(-2).join(".");
        const bRoot = b.split(".").slice(-2).join(".");
        return aRoot === bRoot;
      } catch { return false; }
    };

    let settleTimer = null;
    page.on("framenavigated", (frame) => {
      if (autoSaved) return;
      if (frame !== page.mainFrame()) return;
      const u = frame.url();
      if (!u || u === "about:blank") return;
      if (isLoginUrl(u)) return;
      if (!hostMatch(u)) return;
      if (settleTimer) clearTimeout(settleTimer);
      // 2s settle window — auth flows often set a flurry of cookies
      // in the seconds after the redirect; we want them all captured.
      settleTimer = setTimeout(() => { saveOnce("post-login navigation"); }, 2000);
    });
    page.on("close", () => {
      if (autoSaved) return;
      // Fallback — operator closed the window. We try once even if
      // they never made it through login; if they really didn't,
      // storageState will just be empty cookies and the probe will
      // catch it.
      saveOnce("window closed");
    });

    await page.goto(url);
    logLine("portal:login opened", url);
    return { ok: true, message: "Sign-in window open. Once you finish signing in, we'll save the session automatically — no extra click needed." };
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

async function performDownload({ url, clickSelector, downloadDir, timeoutMs = 60000, source = "manual" } = {}) {
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
      source,
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
      source,
    });
    return { ok: false, error: "download_failed", message: msg };
  } finally {
    try { await page.close(); } catch {}
  }
}

ipcMain.handle("reports:download", async (_evt, args = {}) => {
  return performDownload({ ...args, source: "manual" });
});

// ─── Scheduler ──────────────────────────────────────────────────────
// Persistent list of named download jobs. Each tick (30s) we walk
// the list and fire any enabled job whose `nextRunAt` has elapsed,
// reusing the same headless flow as a manual download. Skips silently
// when no portal session is persisted (would just bounce to login).

function readScheduler() {
  try {
    const raw = fs.readFileSync(schedulerFile(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { jobs: [] };
    return { jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [] };
  } catch {
    return { jobs: [] };
  }
}

function writeScheduler(state) {
  try {
    fs.writeFileSync(schedulerFile(), JSON.stringify(state, null, 2));
  } catch (e) {
    logLine("scheduler write failed:", String(e));
  }
}

function ensureSchedulerSeeded() {
  const s = readScheduler();
  if (s.jobs.length > 0) return s;
  // First-run seed: one disabled Indeed Applicants CSV job so the
  // operator sees the feature exists. They flip it on after pointing
  // the click selector at Indeed's actual Export button.
  const seed = {
    id: "indeed-applicants",
    name: "Indeed — Applicants CSV",
    url: "https://employers.indeed.com/candidates",
    clickSelector: "",
    downloadDir: "",
    intervalMinutes: 60,
    enabled: false,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    lastResult: null,
    lastError: null,
    lastFilePath: null,
    nextRunAt: null,
  };
  writeScheduler({ jobs: [seed] });
  return readScheduler();
}

let schedulerTimer = null;
const schedulerRunning = new Set();

function emitJobUpdated(jobId) {
  try { mainWindow?.webContents.send("scheduler:jobUpdated", { jobId }); } catch {}
}

async function runSchedulerJob(jobId, { manual = false } = {}) {
  if (schedulerRunning.has(jobId)) return { ok: false, error: "already_running" };
  const state = readScheduler();
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) return { ok: false, error: "no_job" };
  schedulerRunning.add(jobId);
  logLine("scheduler: running", jobId, "manual=", manual, "url=", job.url);
  try {
    const r = await performDownload({
      url: job.url,
      clickSelector: job.clickSelector,
      downloadDir: job.downloadDir,
      source: manual ? "scheduler-manual" : "scheduler",
    });
    const now = new Date();
    const nextRunAt = job.intervalMinutes > 0
      ? new Date(now.getTime() + job.intervalMinutes * 60000).toISOString()
      : null;
    const next = readScheduler();
    const i = next.jobs.findIndex((j) => j.id === jobId);
    if (i >= 0) {
      next.jobs[i] = {
        ...next.jobs[i],
        lastRunAt: now.toISOString(),
        lastResult: r.ok ? "ok" : "error",
        lastError: r.ok ? null : (r.message || r.error || "failed"),
        lastFilePath: r.ok ? r.filePath : null,
        nextRunAt,
      };
      writeScheduler(next);
    }
    emitJobUpdated(jobId);
    return r;
  } finally {
    schedulerRunning.delete(jobId);
  }
}

async function tickScheduler() {
  const { jobs } = readScheduler();
  const now = Date.now();
  for (const job of jobs) {
    if (!job.enabled) continue;
    if (schedulerRunning.has(job.id)) continue;
    if (!job.intervalMinutes || job.intervalMinutes <= 0) continue;
    if (!job.url) continue;
    const due = !job.nextRunAt || new Date(job.nextRunAt).getTime() <= now;
    if (!due) continue;
    // Without a portal session every job would bounce to login — skip
    // and pick it up on the next tick once the operator signs in.
    if (!readSession()) {
      logLine("scheduler: skip", job.id, "(no portal session)");
      continue;
    }
    runSchedulerJob(job.id).catch((e) => {
      logLine("scheduler: job", job.id, "threw:", String(e));
    });
  }
}

function startSchedulerLoop() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(tickScheduler, SCHEDULER_TICK_MS);
  // Short delay before the first tick so the renderer's "no session"
  // probe has a chance to settle on the right state first.
  setTimeout(tickScheduler, 5000);
}

ipcMain.handle("scheduler:list", async () => {
  const s = ensureSchedulerSeeded();
  return { ok: true, jobs: s.jobs };
});

ipcMain.handle("scheduler:saveJob", async (_evt, patch = {}) => {
  const s = readScheduler();
  const idx = patch.id ? s.jobs.findIndex((j) => j.id === patch.id) : -1;
  if (idx < 0) {
    const id = patch.id || `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const intervalMinutes = Number(patch.intervalMinutes) || 60;
    s.jobs.push({
      id,
      name: (patch.name || "Untitled job").trim(),
      url: (patch.url || "").trim(),
      clickSelector: (patch.clickSelector || "").trim(),
      downloadDir: (patch.downloadDir || "").trim(),
      intervalMinutes,
      enabled: !!patch.enabled,
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      lastResult: null,
      lastError: null,
      lastFilePath: null,
      nextRunAt: patch.enabled
        ? new Date(Date.now() + intervalMinutes * 60000).toISOString()
        : null,
    });
  } else {
    const prev = s.jobs[idx];
    const intervalMinutes = patch.intervalMinutes != null
      ? Number(patch.intervalMinutes) || prev.intervalMinutes
      : prev.intervalMinutes;
    const enabled = patch.enabled != null ? !!patch.enabled : prev.enabled;
    // Re-arm the next-run window when flipping a disabled job on so
    // it doesn't fire instantly the moment the toggle moves.
    let nextRunAt = prev.nextRunAt;
    if (enabled && !prev.enabled) {
      nextRunAt = new Date(Date.now() + intervalMinutes * 60000).toISOString();
    }
    s.jobs[idx] = {
      ...prev,
      name: patch.name != null ? String(patch.name).trim() : prev.name,
      url: patch.url != null ? String(patch.url).trim() : prev.url,
      clickSelector: patch.clickSelector != null ? String(patch.clickSelector).trim() : prev.clickSelector,
      downloadDir: patch.downloadDir != null ? String(patch.downloadDir).trim() : prev.downloadDir,
      intervalMinutes,
      enabled,
      nextRunAt: enabled ? nextRunAt : null,
    };
  }
  writeScheduler(s);
  return { ok: true, jobs: s.jobs };
});

ipcMain.handle("scheduler:deleteJob", async (_evt, { id } = {}) => {
  const s = readScheduler();
  s.jobs = s.jobs.filter((j) => j.id !== id);
  writeScheduler(s);
  return { ok: true, jobs: s.jobs };
});

ipcMain.handle("scheduler:runNow", async (_evt, { id } = {}) => {
  return runSchedulerJob(id, { manual: true });
});
