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

const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");

// Where we keep the encrypted storage state + electron-store config.
const userDataDir = () => app.getPath("userData");
const sessionFile = () => path.join(userDataDir(), "portal-session.enc");

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

// Stub: the future "pull today's routes" call. Once you reverse-
// engineer the MIDWAY / RoutePlan endpoints (or DOM selectors), this
// is where the scrape lands. Returns a placeholder for now so the
// renderer can wire up the UI without waiting on the implementation.
ipcMain.handle("routes:pullToday", async () => {
  return {
    ok: false,
    error: "not_implemented",
    message: "MIDWAY scraper not wired yet — this is where today's routes will come back.",
  };
});
