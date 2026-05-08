// Renderer (browser context). No Node access — uses window.rr from
// preload's contextBridge for everything that touches the OS or
// Playwright.

const $ = (sel) => document.querySelector(sel);

const els = {
  status: $("#session-status"),
  login: $("#btn-login"),
  confirmLogin: $("#btn-confirm-login"),
  logout: $("#btn-logout"),
  probe: $("#btn-probe"),
  pullRoutes: $("#btn-pull-routes"),
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

async function refreshSessionStatus() {
  const { hasSession } = await window.rr.portal.hasSession();
  if (hasSession) {
    setStatus("Session saved", "ok");
    els.pullRoutes.disabled = false;
  } else {
    setStatus("No session", "warn");
    els.pullRoutes.disabled = true;
  }
}

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

els.pullRoutes.addEventListener("click", async () => {
  els.pullRoutes.disabled = true;
  log("Pulling today's routes…");
  try {
    const r = await window.rr.routes.pullToday();
    if (r.ok) {
      log(`Pulled ${r.count || 0} routes.`, "ok");
    } else {
      log(`${r.message || r.error || "Unknown error"}`, "error");
    }
  } catch (e) {
    log(`Pull failed: ${e.message}`, "error");
  } finally {
    els.pullRoutes.disabled = false;
  }
});

// Initial state
refreshSessionStatus();
log("Ready.");
