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
const { chromium } = require("playwright");

// Where we keep the encrypted storage state + electron-store config.
const userDataDir = () => app.getPath("userData");
const sessionFile = () => path.join(userDataDir(), "portal-session.enc");
const historyFile = () => path.join(userDataDir(), "download-history.json");
const defaultDownloadDir = () => app.getPath("downloads");
const HISTORY_LIMIT = 20;

// Lazy-loaded so we can switch to a different portal URL later
// without recompiling. Override via the renderer's settings panel.
const DEFAULT_PORTAL_URL = "https://logistics.amazon.com/";

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

app.whenReady().then(createWindow);

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
  portalBrowser = await chromium.launch({ headless: !headed });
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
  await tearDownPortal();
  portalBrowser = await chromium.launch({ headless: false });
  portalContext = await portalBrowser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await portalContext.newPage();
  const url = portalUrl || DEFAULT_PORTAL_URL;
  await page.goto(url);

  // Wait for the operator to finish logging in. Heuristic:
  // navigation lands on a URL that's clearly post-login (anything
  // not under /ap/signin, the Amazon SSO host). Operator can click
  // "Done" in the renderer to confirm explicitly too — that path
  // bypasses heuristics.
  return { ok: true, message: "Login window open. Sign in, then click 'I'm signed in' here." };
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
    await page.goto(portalUrl || DEFAULT_PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
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
