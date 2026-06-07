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
const { pathToFileURL } = require("node:url");

// The one bundled local UI file that is allowed to load in-app and receive
// the full (powerful) bridge. Anything else — including other file:// paths
// — is untrusted. Used by hardenNavigation + the trusted-origins handshake.
const localUiHref = () => pathToFileURL(path.join(__dirname, "renderer", "index.html")).href;
const stripFragment = (u) => String(u || "").split("#")[0].split("?")[0];

// Tell Playwright to look for Chromium under node_modules/playwright-core/
// .local-browsers/ rather than the global ms-playwright cache. The build
// pipeline installs Chromium there using the same PLAYWRIGHT_BROWSERS_PATH=0
// env var, and asarUnpack in package.json keeps the binaries on the real
// filesystem so they can actually exec. Must be set BEFORE requiring playwright.
process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
const { chromium } = require("playwright");
const scraper = require("./scraper");
const agent = require("./agent");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("node:crypto");
const os = require("node:os");
// electron-updater is optional at require-time so a dev checkout without the
// dep installed still boots; packaged builds always ship it.
let autoUpdater = null;
try { ({ autoUpdater } = require("electron-updater")); } catch { /* dev without dep */ }

// Public Supabase project config — the anon (publishable) key is safe to
// embed; it's the same one shipped in the dashboard's config.js. Used for the
// box's health reporting (it authenticates as the DSP via the pairing session).
const SUPABASE_URL = "https://doiwrhkirgblcvuskhno.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_HvRuTWdEOrYlJPPIp4CLog_UNC3vNdI";

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
    // Primary: bundled via electron-builder `extraResources` (a direct copy
    // that, unlike the files-glob, reliably ships Playwright's dotfolder).
    path.join(process.resourcesPath, "pw-browsers"),
    // Fallbacks for older/asar layouts.
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
const boxSessionFile = () => path.join(userDataDir(), "box-session.enc");
const defaultDownloadDir = () => app.getPath("downloads");
const HISTORY_LIMIT = 20;
const SCHEDULER_TICK_MS = 30000;

// Default Portal URL. Operator can override per-install via the
// "Portal URL" input in section 1 — useful for testing against any
// portal (Indeed, Workday, etc.) before pointing at Amazon.
const DEFAULT_PORTAL_URL = "https://logistics.amazon.com/";

// Option B: the app's front door is the live DSP dashboard. The bundled
// local UI (renderer/index.html) is the offline fallback + portal-sync
// settings surface. Overridable per-install via config.dashboardUrl.
// Keep the host in sync with preload.js's `isDashboard` gate.
const DEFAULT_DASHBOARD_URL = "https://gorouteready.com/dashboard/";
function effectiveDashboardUrl() {
  const cfg = readConfig();
  return (cfg.dashboardUrl && cfg.dashboardUrl.trim()) || DEFAULT_DASHBOARD_URL;
}

// Supabase Edge Functions base — used for the desktop-pair "redeem" call in
// the browser-pairing flow. Overridable via config.supabaseFunctionsUrl
// (staging); defaults to the production project.
const DEFAULT_SUPABASE_FUNCTIONS_URL = "https://doiwrhkirgblcvuskhno.supabase.co/functions/v1";
function effectiveFunctionsUrl() {
  const cfg = readConfig();
  return (cfg.supabaseFunctionsUrl && cfg.supabaseFunctionsUrl.trim()) || DEFAULT_SUPABASE_FUNCTIONS_URL;
}

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

function showWindow(opts) {
  if (!mainWindow) { createWindow(); return; }
  const wasHidden = !mainWindow.isVisible() || mainWindow.isMinimized();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  // Auto-refresh on restore · closing the window only hides it to the tray
  // (background sync keeps running), so the BrowserWindow keeps whatever page
  // it loaded at startup and never re-fetches — which is why reopening didn't
  // show new deploys. When the operator reopens the app, pull the latest
  // build. Scoped so it's not disruptive:
  //   · only when the CALLER asks for it (tray / dock / relaunch — the
  //     deliberate "I'm coming back to the app" gestures; NOT deep-link
  //     pairing or the explicit settings-UI shows), AND
  //   · only when the window was actually hidden (skips already-visible
  //     re-focuses and the very first show), AND
  //   · only on the live dashboard, never the local settings UI.
  // reloadIgnoringCache() also bypasses any stale Electron disk cache.
  if (opts && opts.refresh && wasHidden && mainWindow.webContents) {
    try {
      const url = mainWindow.webContents.getURL() || "";
      if (/^https?:/i.test(url)) mainWindow.webContents.reloadIgnoringCache();
    } catch (e) { logLine("auto-reload on show failed:", String(e)); }
  }
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
  // The tray menu carries the actions that used to live in the (now hidden)
  // top menu bar, so the app shows nothing but the dashboard.
  const menu = Menu.buildFromTemplate([
    { label: "Open RouteReady", click: () => showWindow({ refresh: true }) },
    { label: "Dashboard", click: () => { showWindow(); loadDashboard(); } },
    { label: "Portal sync settings", click: () => { showWindow(); loadLocalUI(); } },
    { label: "Reload", click: () => { showWindow(); mainWindow?.webContents.reload(); } },
    { label: "Check for updates", click: () => { checkForUpdatesNow(); } },
    { type: "separator" },
    { label: "Quit RouteReady", click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => showWindow({ refresh: true }));
  tray.on("double-click", () => showWindow({ refresh: true }));
}

// ─── Window content: dashboard front door + local fallback ──────────
function loadDashboard() {
  if (!mainWindow) return;
  const url = effectiveDashboardUrl();
  logLine("loading dashboard:", url);
  mainWindow.loadURL(url).catch((e) => {
    logLine("loadURL dashboard threw:", String(e), "→ local UI");
    loadLocalUI();
  });
}
function loadLocalUI() {
  if (!mainWindow) return;
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"))
    .catch((e) => logLine("loadFile local threw:", String(e)));
}

// Keep the in-app context (which holds the native bridge) locked to trusted
// content. The dashboard origin (and our bundled file://) may load in-app;
// every other navigation or window.open is bounced to the system browser so
// untrusted pages never run with the bridge present.
function hardenNavigation(wc) {
  const allowedOrigin = (() => { try { return new URL(effectiveDashboardUrl()).origin; } catch { return null; } })();
  const allowed = (url) => {
    if (!url) return false;
    // Only the exact bundled UI file — NOT arbitrary file:// paths. Otherwise
    // the dashboard (or XSS on it) could navigate to an attacker-controlled
    // local file, which the preload would then treat as trusted-local and
    // hand the full window.rr API (arbitrary download, show-in-folder).
    if (stripFragment(url) === localUiHref()) return true;
    try { return !!allowedOrigin && new URL(url).origin === allowedOrigin; } catch { return false; }
  };
  wc.setWindowOpenHandler(({ url }) => {
    try { if (/^https?:/i.test(url)) shell.openExternal(url); } catch {}
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, url) => {
    if (allowed(url)) return;
    e.preventDefault();
    try { if (/^https?:/i.test(url)) shell.openExternal(url); } catch {}
  });
}

// (Native menu bar intentionally removed — see Menu.setApplicationMenu(null)
// in app.whenReady. Menu actions moved to the tray so the window shows only
// the dashboard.)

// ─── routeready:// deep-link → "Connect from browser" pairing ───────
// The OS hands us routeready://connect?code=… (opened by the dashboard's
// "Connect desktop app" button). We redeem the one-time code with the
// desktop-pair function for a Supabase session, then sign the dashboard
// window in via the helper the dashboard exposes (window.__rrApplySession).
// We never persist the web session ourselves — the dashboard owns it.
function handleDeepLink(link) {
  let u;
  try { u = new URL(link); } catch { logLine("deep-link: bad url", String(link)); return; }
  const action = u.hostname || u.pathname.replace(/^\/+/, "");
  if (action === "connect") {
    const code = u.searchParams.get("code");
    if (code) { redeemPairing(code); return; }
    logLine("deep-link: connect without code");
    return;
  }
  logLine("deep-link: unhandled", link);
}

async function redeemPairing(code) {
  showWindow();
  try {
    logLine("pairing: redeeming code");
    const res = await fetch(`${effectiveFunctionsUrl()}/desktop-pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "redeem", code }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token || !body.refresh_token) {
      const err = body.error || `HTTP ${res.status}`;
      logLine("pairing: redeem failed", err);
      try { dialog.showErrorBox("Couldn't connect", `Pairing failed: ${err}\n\nIn the dashboard, click "Connect desktop app" again to get a fresh code.`); } catch {}
      return;
    }
    logLine("pairing: redeemed for", body.email || "(unknown)");
    applyDashboardSession(body.access_token, body.refresh_token);
    // Persist the session for the box's own health reporting (separate from
    // the dashboard window session). Reset any cached client so the next
    // report re-auths with the fresh tokens, then heartbeat right away so the
    // box shows up in the dashboard immediately after pairing.
    writeBoxSession({ access_token: body.access_token, refresh_token: body.refresh_token });
    boxSupabase = null;
    startHeartbeat();
    startSyncWatcher();
    startCentralTasks();
    heartbeatTick();
    syncCentralTasks(); // pull this DSP's tasks right after pairing
  } catch (e) {
    logLine("pairing: redeem threw", String(e?.message || e));
    try { dialog.showErrorBox("Couldn't connect", `Pairing error: ${String(e?.message || e)}`); } catch {}
  }
}

// Hand the redeemed tokens to the dashboard window's own Supabase client
// (the dashboard exposes window.__rrApplySession). If the window isn't on
// the dashboard yet (offline fallback), load it first, then apply.
function applyDashboardSession(accessToken, refreshToken) {
  if (!mainWindow) return;
  const apply = () => {
    const js = `(window.__rrApplySession ? (window.__rrApplySession(${JSON.stringify(accessToken)}, ${JSON.stringify(refreshToken)}), "ok") : "no_helper")`;
    mainWindow.webContents.executeJavaScript(js, true)
      .then((r) => { if (r === "no_helper") logLine("pairing: dashboard has no __rrApplySession helper yet"); })
      .catch((e) => logLine("pairing: applySession exec failed", String(e)));
  };
  let onDash = false;
  try { onDash = new URL(mainWindow.webContents.getURL()).origin === new URL(effectiveDashboardUrl()).origin; } catch {}
  if (onDash) apply();
  else { mainWindow.webContents.once("did-finish-load", apply); loadDashboard(); }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    title: "RouteReady Desktop",
    backgroundColor: "#F8FAFC",
    icon: path.join(__dirname, "build", "icon.png"),
    autoHideMenuBar: true, // no white menu strip above the dashboard
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Front door: load the live dashboard. Falls back to the local UI if it
  // can't be reached (see did-fail-load below).
  loadDashboard();

  // Open DevTools in dev only.
  if (!app.isPackaged) mainWindow.webContents.openDevTools({ mode: "detach" });

  hardenNavigation(mainWindow.webContents);

  // If the dashboard can't load (offline / DNS / 5xx), drop to the bundled
  // local UI so the operator isn't staring at a blank window — and so
  // portal sign-in + agent controls stay reachable offline.
  mainWindow.webContents.on("did-fail-load", (_e, errorCode, errorDesc, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (!validatedURL || validatedURL.startsWith("file:")) return; // already local, don't loop
    if (errorCode === -3) return; // ERR_ABORTED — navigation superseded, not a real failure
    logLine("dashboard load failed:", errorCode, errorDesc, validatedURL, "→ falling back to local UI");
    loadLocalUI();
  });

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

// ─── Single instance + routeready:// deep-link routing ──────────────
// Browser pairing needs the OS to deliver routeready://connect?code=… to
// the one running app. Without the single-instance lock, the link would
// spawn a second copy instead of reaching the live window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const link = argv.find((a) => typeof a === "string" && a.startsWith("routeready://"));
    // A plain relaunch-to-reopen refreshes to the latest deploy; a pairing
    // deep link must NOT reload (it would wipe the session being applied).
    showWindow({ refresh: !link });
    if (link) handleDeepLink(link);
  });
  // macOS delivers the deep-link as an event rather than argv.
  app.on("open-url", (e, url) => { e.preventDefault(); handleDeepLink(url); });
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
    reportRun: reportAgentRun,
    getAiAuth, // central key via RouteReady's ai-proxy (no key on the box)
    getUploadAuth, // central applicant upload via the box's DSP session
  });
  createWindow();
  buildTray();
  Menu.setApplicationMenu(null); // hide the native menu bar; actions live in the tray

  // Start health reporting + on-demand sync watching if this box is already
  // paired (returning install). A fresh, never-paired box no-ops until the
  // operator connects it (both restart on redeemPairing).
  startHeartbeat();
  startSyncWatcher();
  startCentralTasks();

  // Keep the box on the latest build automatically (installs when idle).
  setupAutoUpdates();

  // Start with the OS at login so the sync engine is up after a reboot
  // without the operator thinking about it. Packaged only — we don't want
  // dev runs registering autostart. Linux support varies by desktop env;
  // best-effort, never fatal.
  if (app.isPackaged) {
    try { app.setLoginItemSettings({ openAtLogin: true }); }
    catch (e) { logLine("setLoginItemSettings failed:", String(e)); }
  }

  // Register routeready:// so the OS routes pairing deep-links to us. In dev
  // (unpackaged) we must point the registration at electron + this script.
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient("routeready", process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient("routeready");
    }
  } catch (e) { logLine("protocol register failed:", String(e)); }

  // Cold-start deep link (Windows/Linux deliver it in argv on first launch).
  const initialLink = process.argv.find((a) => typeof a === "string" && a.startsWith("routeready://"));
  if (initialLink) handleDeepLink(initialLink);
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
  else showWindow({ refresh: true });
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

// ─── Box health reporting (ROADMAP #3) ──────────────────────────────
// The desktop app — when run as an always-on "sync box" — reports its
// liveness, portal-session health, and last-run summary to Supabase so the
// dashboard can show "is my box alive and pulling?" and alert on silent
// failure. It authenticates as the DSP using the SAME pairing session the
// "Connect from browser" flow redeems (access + refresh token), persisted
// here separately from the dashboard window's own session (which the
// dashboard owns and we never touch).
//
// Everything in this section is best-effort: a box that was never paired,
// or that's offline, simply no-ops. Health reporting must never break the
// crawler or the UI.

// Stable per-install id, stored in config.json. Identifies this box's row in
// public.desktop_agents (primary key). Survives restarts; one per machine.
function agentId() {
  const cfg = readConfig();
  if (cfg.agentId) return cfg.agentId;
  const id = crypto.randomUUID();
  writeConfig({ agentId: id });
  return id;
}

// Persist / load the box's pairing session (the Supabase access+refresh
// tokens), encrypted with the OS keychain like the portal session. Stored
// SEPARATELY from the dashboard window session so signing the box in for
// reporting never disturbs (or depends on) what's loaded in the window.
function writeBoxSession(obj) {
  try {
    const json = JSON.stringify(obj);
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(boxSessionFile(), safeStorage.encryptString(json));
    } else {
      fs.writeFileSync(boxSessionFile() + ".plain", json);
    }
  } catch (e) { logLine("box-session: write failed:", String(e)); }
}
function readBoxSession() {
  try {
    const enc = boxSessionFile();
    if (fs.existsSync(enc) && safeStorage.isEncryptionAvailable()) {
      return JSON.parse(safeStorage.decryptString(fs.readFileSync(enc)));
    }
    const plain = enc + ".plain";
    if (fs.existsSync(plain)) return JSON.parse(fs.readFileSync(plain, "utf8"));
  } catch (e) { logLine("box-session: read failed:", String(e)); }
  return null;
}

// Lazily build a Supabase client authenticated as the DSP from the stored
// pairing session. We disable the client's own persistence (no localStorage in
// main) and instead persist refreshed tokens ourselves via onAuthStateChange,
// so the box stays signed in across token rotations and restarts.
let boxSupabase = null;
async function getBoxSupabase() {
  if (boxSupabase) return boxSupabase;
  const sess = readBoxSession();
  if (!sess || !sess.access_token || !sess.refresh_token) return null;
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
  });
  client.auth.onAuthStateChange((_event, session) => {
    if (session?.access_token && session?.refresh_token) {
      writeBoxSession({ access_token: session.access_token, refresh_token: session.refresh_token });
    }
  });
  const { error } = await client.auth.setSession({
    access_token: sess.access_token,
    refresh_token: sess.refresh_token,
  });
  if (error) {
    logLine("box-session: setSession failed:", error.message);
    // Don't cache a broken client; a re-pair will replace the stored tokens.
    return null;
  }
  boxSupabase = client;
  return boxSupabase;
}

// Upsert a patch onto this box's desktop_agents row. dsp_id is filled by the
// table default (private.current_dsp_id()) on insert and never sent from here.
async function reportStatus(patch) {
  try {
    const sb = await getBoxSupabase();
    if (!sb) return; // not paired → nothing to report to
    const row = { agent_id: agentId(), updated_at: new Date().toISOString(), ...patch };
    const { error } = await sb.from("desktop_agents").upsert(row, { onConflict: "agent_id" });
    if (error) logLine("health: upsert failed:", error.message);
  } catch (e) { logLine("health: report threw:", String(e)); }
}

// Heartbeat loop: every 5 minutes tell Supabase the box is alive, what
// version it's on, and whether the portal session looks present. The dashboard
// alerts when last_heartbeat_at goes stale (box dark) or portal_session_ok is
// false (needs re-login on the box).
let heartbeatTimer = null;
function heartbeatTick() {
  reportStatus({
    label: os.hostname(),
    app_version: app.getVersion(),
    last_heartbeat_at: new Date().toISOString(),
    portal_session_ok: !!readSession(),
    last_portal_check_at: new Date().toISOString(),
  });
}
function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTick(); // fire one immediately on boot
  heartbeatTimer = setInterval(heartbeatTick, 5 * 60 * 1000);
}

// ─── On-demand "Sync to portal" (ROADMAP #4) ────────────────────────
// The dashboard's "Sync to portal" button inserts a pending row into
// public.sync_requests (scoped to the DSP by RLS). This box polls for pending
// requests, atomically claims one (so two boxes for the same DSP don't both
// run it), runs all enabled crawl tasks now, then marks the request done/error
// with a short result summary the dashboard can surface. Poll (vs realtime) is
// simpler and plenty fast for an on-demand button; ~15s feels instant enough.
let syncWatchTimer = null;
let syncBusy = false;
async function syncWatchTick() {
  if (syncBusy) return; // a prior request is still crawling
  let sb;
  try { sb = await getBoxSupabase(); } catch { return; }
  if (!sb) return; // not paired
  try {
    const { data: pending, error } = await sb
      .from("sync_requests")
      .select("id, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1);
    if (error) { logLine("sync: poll failed:", error.message); return; }
    if (!pending || !pending.length) return;
    const req = pending[0];

    // Atomic-ish claim: only succeeds if the row is still pending. If another
    // box (same DSP) grabbed it first, the filtered update returns no rows.
    const claimedAt = new Date().toISOString();
    const { data: claimed, error: claimErr } = await sb
      .from("sync_requests")
      .update({ status: "claimed", claimed_by: agentId(), claimed_at: claimedAt })
      .eq("id", req.id)
      .eq("status", "pending")
      .select("id");
    if (claimErr) { logLine("sync: claim failed:", claimErr.message); return; }
    if (!claimed || !claimed.length) return; // lost the race; leave it

    logLine("sync: claimed on-demand request", req.id, "→ running enabled tasks");
    syncBusy = true;
    let summary;
    try {
      await syncCentralTasks(); // pull the latest admin-defined tasks before running
      summary = await agent.runAllEnabledNow();
    } catch (e) {
      summary = { ok: false, error: String(e?.message || e) };
    } finally {
      syncBusy = false;
    }

    const done = {
      status: summary.ok === false ? "error" : (summary.status || "complete"),
      done_at: new Date().toISOString(),
      result_rows: typeof summary.totalRows === "number" ? summary.totalRows : null,
      result_tasks: typeof summary.ran === "number" ? summary.ran : null,
      error: summary.ok === false ? (summary.error || "run_failed") : null,
    };
    const { error: doneErr } = await sb.from("sync_requests").update(done).eq("id", req.id);
    if (doneErr) logLine("sync: mark-done failed:", doneErr.message);
    else logLine("sync: request", req.id, "→", done.status, `(${done.result_rows ?? "?"} rows)`);

    // Push a fresh heartbeat so the dashboard reflects the just-finished run.
    heartbeatTick();
  } catch (e) {
    logLine("sync: watch threw:", String(e));
  }
}
function startSyncWatcher() {
  if (syncWatchTimer) return;
  syncWatchTimer = setInterval(syncWatchTick, 15 * 1000);
  setTimeout(syncWatchTick, 8000); // first check shortly after boot
}

// ─── Central AI key (proxy) ─────────────────────────────────────────
// So no box ever holds an Anthropic key: the agent routes its model calls
// through RouteReady's ai-proxy edge function, which injects RouteReady's key
// server-side and is billed centrally. We hand the agent the proxy URL + the
// box's current (auto-refreshed) DSP session token so the proxy can authorize
// the call. Returns null if the box isn't paired (then the agent falls back to
// any box-local key, or reports "no AI").
async function getAiAuth() {
  try {
    const sb = await getBoxSupabase();
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) return null;
    return { proxyUrl: `${effectiveFunctionsUrl()}/ai-proxy`, token, anonKey: SUPABASE_ANON_KEY };
  } catch (e) { logLine("ai-auth: failed", String(e?.message || e)); return null; }
}

// Central upload auth: the box posts crawled applicants to box-ingest using its
// DSP pairing session (no apply-secret / short code on the box; the function
// resolves the DSP server-side). Returns null if the box isn't paired.
async function getUploadAuth() {
  try {
    const sb = await getBoxSupabase();
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) return null;
    return { url: `${effectiveFunctionsUrl()}/box-ingest`, token, anonKey: SUPABASE_ANON_KEY };
  } catch (e) { logLine("upload-auth: failed", String(e?.message || e)); return null; }
}

// ─── Central crawl tasks (ROADMAP #4 Phase 2) ───────────────────────
// The DSP's crawl tasks are defined centrally by platform_admin in the
// dashboard (public.crawl_tasks). The box fetches its DSP's tasks (RLS scopes
// to the paired DSP) and mirrors them into the agent's local store, so the
// existing scheduler + on-demand runner execute them. Periodic + on-demand.
let centralTasksTimer = null;
async function syncCentralTasks() {
  let sb;
  try { sb = await getBoxSupabase(); } catch { return; }
  if (!sb) return; // not paired
  try {
    const { data, error } = await sb.from("crawl_tasks").select("*"); // RLS → this DSP's rows
    if (error) { logLine("central tasks: fetch failed:", error.message); return; }
    const r = agent.applyCentralTasks(data || []);
    logLine("central tasks: synced", (r && r.count) || 0, "task(s)");
  } catch (e) {
    logLine("central tasks: sync threw:", String(e));
  }
}
function startCentralTasks() {
  if (centralTasksTimer) return;
  centralTasksTimer = setInterval(syncCentralTasks, 5 * 60 * 1000);
  setTimeout(syncCentralTasks, 9000); // shortly after boot
}

// ─── Auto-update (ROADMAP #6) ───────────────────────────────────────
// So an always-on sync box maintains itself: install once, never reinstall —
// the box checks GitHub Releases and self-updates when idle.
// electron-updater reads the GitHub Release's latest.yml (electron-builder
// generates it from the `publish` config), downloads the new installer, and
// installs it — but only when the box is IDLE, so we never kill a crawl
// mid-run. AppImage + Windows nsis support this; .deb/ChromeOS does not
// (the Windows mini-PC is the appliance target anyway).
let updateReady = false;
let autoUpdateStarted = false;
function maybeInstallUpdate() {
  if (!updateReady || !autoUpdater) return;
  let busy = false;
  try { busy = (agent.isBusy && agent.isBusy()) || syncBusy; } catch {}
  if (busy) { logLine("update: downloaded but box is busy — deferring install"); return; }
  logLine("update: idle — installing and relaunching");
  try { autoUpdater.quitAndInstall(true, true); } // silent install, relaunch after
  catch (e) { logLine("update: quitAndInstall threw:", String(e?.message || e)); }
}
function checkForUpdatesNow() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.checkForUpdates().catch((e) => logLine("update: check threw:", String(e?.message || e)));
}
function setupAutoUpdates() {
  if (autoUpdateStarted) return;
  if (!autoUpdater) { logLine("update: electron-updater not available; skipping"); return; }
  if (!app.isPackaged) { logLine("update: dev build, auto-update disabled"); return; }
  autoUpdateStarted = true;
  autoUpdater.logger = {
    info: (m) => logLine("update:", typeof m === "string" ? m : JSON.stringify(m)),
    warn: (m) => logLine("update warn:", typeof m === "string" ? m : JSON.stringify(m)),
    error: (m) => logLine("update error:", typeof m === "string" ? m : JSON.stringify(m)),
    debug: () => {},
  };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // fallback: install on next manual quit
  autoUpdater.on("update-available", (info) => logLine("update: available", info && info.version));
  autoUpdater.on("update-not-available", () => logLine("update: up to date"));
  autoUpdater.on("error", (e) => logLine("update: error", String(e && e.message || e)));
  autoUpdater.on("update-downloaded", (info) => {
    updateReady = true;
    logLine("update: downloaded", info && info.version, "— will install when idle");
    maybeInstallUpdate();
  });
  setTimeout(checkForUpdatesNow, 20000);                 // shortly after boot
  setInterval(checkForUpdatesNow, 6 * 60 * 60 * 1000);   // every 6h
  setInterval(maybeInstallUpdate, 5 * 60 * 1000);        // retry idle-install every 5m
}

// Called by the agent after each crawl with a run summary — records the
// last-run outcome on the box's health row so the dashboard can show
// "last pull: 18:00 · 42 rows · ok" and alert on failures.
function reportAgentRun(summary = {}) {
  reportStatus({
    last_run_at: summary.at || new Date().toISOString(),
    last_run_task: summary.task || null,
    last_run_status: summary.status || null,
    last_run_error: summary.error || null,
    last_run_rows: typeof summary.rows === "number" ? summary.rows : null,
  });
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
  return {
    ok: true,
    portalUrl: effectivePortalUrl(),
    defaultPortalUrl: DEFAULT_PORTAL_URL,
    dashboardUrl: effectiveDashboardUrl(),
    defaultDashboardUrl: DEFAULT_DASHBOARD_URL,
  };
});

ipcMain.handle("config:set", async (_evt, { portalUrl, dashboardUrl, supabaseFunctionsUrl } = {}) => {
  const patch = {};
  if (typeof portalUrl === "string") patch.portalUrl = portalUrl.trim();
  if (typeof dashboardUrl === "string") patch.dashboardUrl = dashboardUrl.trim();
  if (typeof supabaseFunctionsUrl === "string") patch.supabaseFunctionsUrl = supabaseFunctionsUrl.trim();
  writeConfig(patch);
  return { ok: true, portalUrl: effectivePortalUrl(), dashboardUrl: effectiveDashboardUrl() };
});

// Installed app version — used by the dashboard bridge to gate features
// that need a newer native side.
ipcMain.handle("app:getVersion", async () => ({ ok: true, version: app.getVersion() }));

// Synchronous handshake the preload uses to decide capability gating — the
// trusted origins come from config (so a custom config.dashboardUrl works),
// not a hard-coded host. Returns the exact bundled UI file (full bridge) and
// the configured dashboard origin (minimal bridge).
ipcMain.on("app:trustedOrigins", (e) => {
  let dashboardOrigin = null;
  try { dashboardOrigin = new URL(effectiveDashboardUrl()).origin; } catch {}
  e.returnValue = { dashboardOrigin, localUiHref: localUiHref() };
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
