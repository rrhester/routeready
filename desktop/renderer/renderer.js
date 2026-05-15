// Renderer (browser context). No Node access — uses window.rr from
// preload's contextBridge for everything that touches the OS or
// Playwright.

const $ = (sel) => document.querySelector(sel);

const els = {
  status: $("#session-status"),
  welcome: $("#welcome"),
  welcomeOther: $("#welcome-other"),
  welcomeButtons: document.querySelectorAll("[data-quick-portal]"),
  signinCard: $("#card-signin"),
  portalUrl: $("#portal-url"),
  login: $("#btn-login"),
  confirmLogin: $("#btn-confirm-login"),
  logout: $("#btn-logout"),
  probe: $("#btn-probe"),
  download: $("#btn-download"),
  pickDir: $("#btn-pick-dir"),
  dlUrl: $("#dl-url"),
  dlSelector: $("#dl-selector"),
  dlDir: $("#dl-dir"),
  historyList: $("#dl-history-list"),
  log: $("#log"),
};

function log(msg, kind = "info") {
  const ts = new Date().toLocaleTimeString();
  const tag = kind === "error" ? "✗" : kind === "ok" ? "✓" : "·";
  els.log.textContent = `[${ts}] ${tag} ${msg}\n` + els.log.textContent;
}

function setStatus(text, tone = "neutral") {
  els.status.textContent = text;
  els.status.dataset.tone = tone;
}

async function loadConfig() {
  const r = await window.rr.config.get();
  els.portalUrl.value = r.portalUrl || "";
  els.portalUrl.placeholder = r.defaultPortalUrl || "https://…";
}

let portalUrlSaveTimer = null;
els.portalUrl.addEventListener("input", () => {
  clearTimeout(portalUrlSaveTimer);
  portalUrlSaveTimer = setTimeout(async () => {
    const portalUrl = els.portalUrl.value.trim();
    await window.rr.config.set({ portalUrl });
    log(`Portal URL → ${portalUrl || "(default)"}`);
  }, 600);
});

async function refreshSessionStatus() {
  const { hasSession } = await window.rr.portal.hasSession();
  setStatus(hasSession ? "Session saved" : "No session", hasSession ? "ok" : "warn");
  // First-run: no saved session → surface the quick-pick welcome panel
  // so the operator's path-to-portal is a single click instead of three.
  if (els.welcome) els.welcome.hidden = hasSession;
}

// One-click sign in: pick a portal → set its URL → immediately launch
// the headed login browser. Collapses the manual "type URL, click
// 'Open portal & sign in'" sequence into a single button.
async function quickSignIn(portalUrl, label) {
  els.welcomeButtons.forEach(b => { b.disabled = true; });
  els.portalUrl.value = portalUrl;
  log(`Starting sign-in for ${label}…`);
  try {
    await window.rr.config.set({ portalUrl });
    const r = await window.rr.portal.login({ portalUrl });
    if (!r.ok) throw new Error(r.error || "login_failed");
    log(`${label} opened in a managed browser. Sign in, then click "I'm signed in" below.`, "ok");
    els.confirmLogin.disabled = false;
    // Scroll the "I'm signed in" button into view so the next step is
    // obvious once the operator returns from the portal.
    els.confirmLogin.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (e) {
    log(`Couldn't start sign-in: ${e.message}`, "error");
  } finally {
    els.welcomeButtons.forEach(b => { b.disabled = false; });
  }
}

els.welcomeButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    const url = btn.getAttribute("data-quick-portal");
    const name = btn.getAttribute("data-quick-name") || "portal";
    quickSignIn(url, name);
  });
});

if (els.welcomeOther) {
  els.welcomeOther.addEventListener("click", () => {
    // Reveal the manual portal URL section; hide the welcome card.
    if (els.welcome) els.welcome.hidden = true;
    els.portalUrl.focus();
    log("Paste your portal URL in section 1, then click 'Open portal & sign in'.");
  });
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

async function refreshHistory() {
  const { entries } = await window.rr.reports.listHistory();
  if (!entries || entries.length === 0) {
    els.historyList.innerHTML = '<li class="empty">No downloads yet.</li>';
    return;
  }
  els.historyList.innerHTML = entries.map((e) => {
    const ts = new Date(e.ts).toLocaleString();
    const host = (() => { try { return new URL(e.url).host; } catch { return e.url; } })();
    if (e.error) {
      return `<li class="failed">
        <div class="hi-row"><span class="hi-name">✗ ${escapeHtml(host)}</span>
        <span class="hi-meta">${escapeHtml(ts)}</span></div>
        <div class="hi-err">${escapeHtml(e.error)}</div>
      </li>`;
    }
    return `<li>
      <div class="hi-row">
        <span class="hi-name">${escapeHtml(e.suggestedName || "download")}</span>
        <span class="hi-meta">${formatSize(e.size)} · ${escapeHtml(ts)}</span>
      </div>
      <div class="hi-row">
        <span class="hi-host">${escapeHtml(host)}</span>
        <button class="link" data-path="${escapeHtml(e.filePath)}">Show in folder</button>
      </div>
    </li>`;
  }).join("");
}

els.historyList.addEventListener("click", async (evt) => {
  const btn = evt.target.closest("button.link[data-path]");
  if (!btn) return;
  await window.rr.reports.openInFolder({ filePath: btn.dataset.path });
});

els.login.addEventListener("click", async () => {
  els.login.disabled = true;
  log("Opening DSP portal in a managed browser window…");
  try {
    const r = await window.rr.portal.login({});
    if (!r.ok) throw new Error(r.error || "login_failed");
    log(r.message, "ok");
    els.confirmLogin.disabled = false;
  } catch (e) {
    log(`Login failed: ${e.message}`, "error");
  } finally {
    els.login.disabled = false;
  }
});

els.confirmLogin.addEventListener("click", async () => {
  els.confirmLogin.disabled = true;
  log("Capturing session…");
  try {
    const r = await window.rr.portal.saveSession();
    if (!r.ok) throw new Error(r.error || "save_failed");
    log(`Session saved (${r.cookieCount} cookies${r.encrypted ? ", encrypted" : ", plaintext"}).`, "ok");
    await refreshSessionStatus();
  } catch (e) {
    log(`Save failed: ${e.message}`, "error");
  }
});

els.logout.addEventListener("click", async () => {
  if (!confirm("Forget the saved DSP portal session? You'll need to sign in again.")) return;
  log("Clearing session…");
  await window.rr.portal.logout();
  log("Session cleared.", "ok");
  await refreshSessionStatus();
});

els.probe.addEventListener("click", async () => {
  els.probe.disabled = true;
  log("Probing portal headlessly…");
  try {
    const r = await window.rr.portal.probe({});
    if (!r.ok) throw new Error(r.error);
    if (r.isLogin) {
      log(`Probe landed on login page (${r.finalUrl}). Session expired — sign in again.`, "error");
      setStatus("Session expired", "warn");
    } else {
      log(`Probe ok: "${r.title}" @ ${r.finalUrl}`, "ok");
      setStatus("Session valid", "ok");
    }
  } catch (e) {
    log(`Probe failed: ${e.message}`, "error");
  } finally {
    els.probe.disabled = false;
  }
});

els.pickDir.addEventListener("click", async () => {
  const r = await window.rr.reports.pickDownloadDir();
  if (r.ok) {
    els.dlDir.value = r.dir;
    log(`Save folder set: ${r.dir}`);
  }
});

els.download.addEventListener("click", async () => {
  const url = els.dlUrl.value.trim();
  if (!url) {
    log("Enter a URL first.", "error");
    return;
  }
  const clickSelector = els.dlSelector.value.trim();
  const downloadDir = els.dlDir.value.trim() || undefined;
  els.download.disabled = true;
  log(`Downloading from ${url}…`);
  try {
    const r = await window.rr.reports.download({ url, clickSelector, downloadDir });
    if (r.ok) {
      log(`Saved ${r.suggestedName} (${formatSize(r.size)}) → ${r.filePath}`, "ok");
    } else {
      log(`${r.message || r.error || "Download failed"}`, "error");
    }
    await refreshHistory();
  } catch (e) {
    log(`Download failed: ${e.message}`, "error");
  } finally {
    els.download.disabled = false;
  }
});

// Initial state
loadConfig();
refreshSessionStatus();
refreshHistory();
log("Ready.");
