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

// ─── Scheduled downloads ────────────────────────────────────────────

const schedEls = {
  list: $("#sched-list"),
  addBtn: $("#btn-job-add"),
  editor: $("#job-editor"),
  title: $("#job-editor-title"),
  name: $("#job-name"),
  url: $("#job-url"),
  selector: $("#job-selector"),
  dir: $("#job-dir"),
  pickDir: $("#btn-job-pick-dir"),
  clearDir: $("#btn-job-clear-dir"),
  interval: $("#job-interval"),
  enabled: $("#job-enabled"),
  save: $("#btn-job-save"),
  cancel: $("#btn-job-cancel"),
};

// id of the job currently being edited; null when adding a new one.
let editingJobId = null;

function relTime(iso) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  const diff = t - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  if (mins < 1) return diff < 0 ? "just now" : "in <1 min";
  if (mins < 60) return diff < 0 ? `${mins} min ago` : `in ${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return diff < 0 ? `${hrs} hr ago` : `in ${hrs} hr`;
  const days = Math.round(hrs / 24);
  return diff < 0 ? `${days} d ago` : `in ${days} d`;
}

function jobStatusPill(job) {
  if (!job.enabled) return `<span class="pill pill-off">Paused</span>`;
  if (job.lastResult === "error") return `<span class="pill pill-err">Last run failed</span>`;
  if (job.lastResult === "ok") return `<span class="pill pill-ok">Last run ok</span>`;
  return `<span class="pill pill-warm">Armed</span>`;
}

function renderJobs(jobs) {
  if (!jobs || jobs.length === 0) {
    schedEls.list.innerHTML = '<li class="empty">No scheduled jobs yet. Add one to fire downloads unattended.</li>';
    return;
  }
  schedEls.list.innerHTML = jobs.map((job) => {
    const lastRun = job.lastRunAt ? `${relTime(job.lastRunAt)}` : "never";
    const nextRun = job.enabled && job.nextRunAt ? relTime(job.nextRunAt) : "—";
    const interval = `${job.intervalMinutes || 0} min`;
    const errLine = job.lastResult === "error" && job.lastError
      ? `<div class="job-err">${escapeHtml(job.lastError)}</div>`
      : "";
    return `
      <li class="job" data-job-id="${escapeHtml(job.id)}">
        <div class="job-head">
          <div class="job-title">
            <span class="job-name">${escapeHtml(job.name || "(unnamed)")}</span>
            ${jobStatusPill(job)}
          </div>
          <div class="job-actions">
            <button class="btn btn-sm" data-job-run="${escapeHtml(job.id)}">Run now</button>
            <button class="btn btn-sm" data-job-edit="${escapeHtml(job.id)}">Edit</button>
            <button class="btn btn-sm btn-ghost" data-job-delete="${escapeHtml(job.id)}">Delete</button>
          </div>
        </div>
        <div class="job-meta">
          <span title="${escapeHtml(job.url)}">${escapeHtml(job.url || "(no URL)")}</span>
        </div>
        <div class="job-meta job-meta-grid">
          <span>Every <strong>${escapeHtml(interval)}</strong></span>
          <span>Last run: <strong>${escapeHtml(lastRun)}</strong></span>
          <span>Next run: <strong>${escapeHtml(nextRun)}</strong></span>
        </div>
        ${errLine}
      </li>`;
  }).join("");
}

async function refreshJobs() {
  const r = await window.rr.scheduler.list();
  renderJobs(r.jobs || []);
}

function openJobEditor(job) {
  editingJobId = job ? job.id : null;
  schedEls.title.textContent = job ? `Edit · ${job.name || "(unnamed)"}` : "New scheduled job";
  schedEls.name.value = job?.name || "";
  schedEls.url.value = job?.url || "";
  schedEls.selector.value = job?.clickSelector || "";
  schedEls.dir.value = job?.downloadDir || "";
  schedEls.interval.value = job?.intervalMinutes || 60;
  schedEls.enabled.checked = !!job?.enabled;
  schedEls.editor.hidden = false;
  schedEls.editor.scrollIntoView({ behavior: "smooth", block: "center" });
}

function closeJobEditor() {
  editingJobId = null;
  schedEls.editor.hidden = true;
}

schedEls.addBtn.addEventListener("click", () => openJobEditor(null));
schedEls.cancel.addEventListener("click", closeJobEditor);

schedEls.pickDir.addEventListener("click", async () => {
  const r = await window.rr.reports.pickDownloadDir();
  if (r.ok) schedEls.dir.value = r.dir;
});

schedEls.clearDir.addEventListener("click", () => {
  schedEls.dir.value = "";
});

schedEls.save.addEventListener("click", async () => {
  const patch = {
    id: editingJobId || undefined,
    name: schedEls.name.value.trim(),
    url: schedEls.url.value.trim(),
    clickSelector: schedEls.selector.value.trim(),
    downloadDir: schedEls.dir.value.trim(),
    intervalMinutes: Number(schedEls.interval.value) || 60,
    enabled: schedEls.enabled.checked,
  };
  if (!patch.name) { log("Job needs a name.", "error"); return; }
  if (!patch.url) { log("Job needs a URL.", "error"); return; }
  if (patch.intervalMinutes < 5) {
    log("Minimum interval is 5 minutes.", "error");
    return;
  }
  schedEls.save.disabled = true;
  try {
    const r = await window.rr.scheduler.saveJob(patch);
    if (r.ok) {
      log(`Saved scheduled job: ${patch.name}`, "ok");
      renderJobs(r.jobs);
      closeJobEditor();
    }
  } finally {
    schedEls.save.disabled = false;
  }
});

schedEls.list.addEventListener("click", async (evt) => {
  const t = evt.target.closest("button[data-job-run], button[data-job-edit], button[data-job-delete]");
  if (!t) return;
  const runId = t.getAttribute("data-job-run");
  const editId = t.getAttribute("data-job-edit");
  const delId = t.getAttribute("data-job-delete");

  if (runId) {
    t.disabled = true;
    log(`Running scheduled job…`);
    try {
      const r = await window.rr.scheduler.runNow(runId);
      if (r && r.ok) {
        log(`Job ran: saved ${r.suggestedName} (${formatSize(r.size)}).`, "ok");
      } else {
        log(`Job failed: ${r?.message || r?.error || "unknown error"}`, "error");
      }
      await refreshJobs();
      await refreshHistory();
    } finally {
      t.disabled = false;
    }
    return;
  }

  if (editId) {
    const r = await window.rr.scheduler.list();
    const job = (r.jobs || []).find((j) => j.id === editId);
    if (job) openJobEditor(job);
    return;
  }

  if (delId) {
    if (!confirm("Delete this scheduled job? Running downloads won't be affected.")) return;
    const r = await window.rr.scheduler.deleteJob(delId);
    if (r.ok) {
      log("Scheduled job deleted.", "ok");
      renderJobs(r.jobs);
    }
  }
});

// Main process pushes us an update after every automatic run so the
// "last run" / "next run" labels stay live without us polling.
window.rr.scheduler.onJobUpdated(() => {
  refreshJobs();
  refreshHistory();
});

// Initial state
loadConfig();
refreshSessionStatus();
refreshHistory();
refreshJobs();
log("Ready.");
