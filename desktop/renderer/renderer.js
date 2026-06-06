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

// Main process auto-saves the session once it detects a successful
// post-login navigation (or the operator closes the headed window).
// We flip the UI to "Session saved" immediately so the operator
// doesn't have to know to click "I'm signed in" — the original UX
// gap that the brother running this for the first time hit.
window.rr.portal.onAutoSaved((payload) => {
  log(`Session auto-saved (${payload.cookieCount} cookies${payload.encrypted ? ", encrypted" : ", plaintext"}, ${payload.trigger}).`, "ok");
  setStatus("Session saved", "ok");
  if (els.welcome) els.welcome.hidden = true;
  els.confirmLogin.disabled = true;
  refreshSessionStatus();
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

// ─── Scrapers (record-and-replay) ───────────────────────────────────

const scEls = {
  list: $("#scraper-list"),
  addBtn: $("#btn-sc-add"),
  edit: $("#scraper-edit"),
  title: $("#scraper-edit-title"),
  name: $("#sc-name"),
  url: $("#sc-url"),
  dir: $("#sc-dir"),
  pickDir: $("#btn-sc-pick-dir"),
  clearDir: $("#btn-sc-clear-dir"),
  interval: $("#sc-interval"),
  enabled: $("#sc-enabled"),
  preview: $("#sc-selectors-preview"),
  save: $("#btn-sc-save"),
  cancel: $("#btn-sc-cancel"),
};

let editingRecipeId = null;

function recipeStatusPill(r) {
  if (!r.enabled) return `<span class="pill pill-off">Paused</span>`;
  if (r.lastResult === "error") return `<span class="pill pill-err">Last run failed</span>`;
  if (r.lastResult === "partial") return `<span class="pill pill-warm">Partial</span>`;
  if (r.lastResult === "ok") return `<span class="pill pill-ok">Last run ok</span>`;
  return `<span class="pill pill-warm">Armed</span>`;
}

function recipeReady(r) {
  const s = r.selectors || {};
  return !!(s.rowSelector && s.rowOpenSelector && s.nameSelector && s.emailSelector);
}

function renderRecipes(recipes) {
  if (!recipes || recipes.length === 0) {
    scEls.list.innerHTML = '<li class="empty">No scrapers yet. Add one and hit Record to teach it the click path.</li>';
    return;
  }
  scEls.list.innerHTML = recipes.map((r) => {
    const ready = recipeReady(r);
    const lastRun = r.lastRunAt ? relTime(r.lastRunAt) : "never";
    const nextRun = r.enabled && r.nextRunAt ? relTime(r.nextRunAt) : "—";
    const interval = `${r.intervalMinutes || 0} min`;
    const counts = r.lastCount != null
      ? `${r.lastNewCount || 0} new / ${r.lastCount} scraped`
      : "—";
    const errLine = r.lastResult === "error" && r.lastError
      ? `<div class="job-err">${escapeHtml(r.lastError)}</div>`
      : "";
    const readyLine = ready
      ? ""
      : `<div class="job-warn">No recipe yet — hit Record to teach it the click path.</div>`;
    return `
      <li class="job" data-recipe-id="${escapeHtml(r.id)}">
        <div class="job-head">
          <div class="job-title">
            <span class="job-name">${escapeHtml(r.name || "(unnamed)")}</span>
            ${recipeStatusPill(r)}
          </div>
          <div class="job-actions">
            <button class="btn btn-sm btn-primary" data-recipe-record="${escapeHtml(r.id)}">${ready ? "Re-record" : "Record"}</button>
            <button class="btn btn-sm" data-recipe-run="${escapeHtml(r.id)}" ${ready ? "" : "disabled"}>Run now</button>
            <button class="btn btn-sm" data-recipe-edit="${escapeHtml(r.id)}">Edit</button>
            <button class="btn btn-sm btn-ghost" data-recipe-delete="${escapeHtml(r.id)}">Delete</button>
          </div>
        </div>
        <div class="job-meta">
          <span title="${escapeHtml(r.startUrl || "")}">${escapeHtml(r.startUrl || "(no URL)")}</span>
        </div>
        <div class="job-meta job-meta-grid">
          <span>Every <strong>${escapeHtml(interval)}</strong></span>
          <span>Last run: <strong>${escapeHtml(lastRun)}</strong></span>
          <span>Next run: <strong>${escapeHtml(nextRun)}</strong></span>
          <span>Result: <strong>${escapeHtml(counts)}</strong></span>
        </div>
        ${readyLine}
        ${errLine}
      </li>`;
  }).join("");
}

async function refreshRecipes() {
  const r = await window.rr.scraper.list();
  renderRecipes(r.recipes || []);
}

function renderSelectorPreview(selectors) {
  const s = selectors || {};
  const rows = [
    ["Row", s.rowSelector],
    ["Row open", s.rowOpenSelector],
    ["Reveal email", s.revealEmailSelector],
    ["Reveal phone", s.revealPhoneSelector],
    ["Name", s.nameSelector],
    ["Email", s.emailSelector],
    ["Phone", s.phoneSelector],
    ["Close", s.closePanelSelector],
  ];
  const lines = rows.map(([label, sel]) => {
    if (!sel) return `<div class="sel-row sel-empty">${escapeHtml(label)}: <em>not set</em></div>`;
    return `<div class="sel-row"><strong>${escapeHtml(label)}:</strong> <code>${escapeHtml(sel)}</code></div>`;
  });
  scEls.preview.innerHTML = `<div class="sel-head">Captured selectors</div>${lines.join("")}`;
}

function openRecipeEditor(recipe) {
  editingRecipeId = recipe ? recipe.id : null;
  scEls.title.textContent = recipe ? `Edit · ${recipe.name || "(unnamed)"}` : "New scraper";
  scEls.name.value = recipe?.name || "";
  scEls.url.value = recipe?.startUrl || "";
  scEls.dir.value = recipe?.downloadDir || "";
  scEls.interval.value = recipe?.intervalMinutes || 60;
  scEls.enabled.checked = !!recipe?.enabled;
  renderSelectorPreview(recipe?.selectors);
  scEls.edit.hidden = false;
  scEls.edit.scrollIntoView({ behavior: "smooth", block: "center" });
}

function closeRecipeEditor() {
  editingRecipeId = null;
  scEls.edit.hidden = true;
}

scEls.addBtn.addEventListener("click", () => {
  // New scraper — we still need an id; reuse a slug derived from the
  // name on save, defaulting to a generated id if name is empty.
  openRecipeEditor(null);
});
scEls.cancel.addEventListener("click", closeRecipeEditor);

scEls.pickDir.addEventListener("click", async () => {
  const r = await window.rr.reports.pickDownloadDir();
  if (r.ok) scEls.dir.value = r.dir;
});
scEls.clearDir.addEventListener("click", () => { scEls.dir.value = ""; });

scEls.save.addEventListener("click", async () => {
  const name = scEls.name.value.trim();
  const startUrl = scEls.url.value.trim();
  if (!name) { log("Scraper needs a name.", "error"); return; }
  if (!startUrl) { log("Scraper needs a start URL.", "error"); return; }
  const interval = Number(scEls.interval.value) || 60;
  if (interval < 5) { log("Minimum interval is 5 minutes.", "error"); return; }
  const id = editingRecipeId || slugifyId(name);
  scEls.save.disabled = true;
  try {
    const r = await window.rr.scraper.save({
      id,
      name,
      startUrl,
      downloadDir: scEls.dir.value.trim(),
      intervalMinutes: interval,
      enabled: scEls.enabled.checked,
    });
    if (r.ok) {
      log(`Saved scraper: ${name}`, "ok");
      closeRecipeEditor();
      await refreshRecipes();
    }
  } finally {
    scEls.save.disabled = false;
  }
});

function slugifyId(s) {
  const base = String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${base || "scraper"}-${Date.now().toString(36)}`;
}

scEls.list.addEventListener("click", async (evt) => {
  const t = evt.target.closest("button[data-recipe-record], button[data-recipe-run], button[data-recipe-edit], button[data-recipe-delete]");
  if (!t) return;
  const recId =
    t.getAttribute("data-recipe-record") ||
    t.getAttribute("data-recipe-run") ||
    t.getAttribute("data-recipe-edit") ||
    t.getAttribute("data-recipe-delete");

  if (t.hasAttribute("data-recipe-record")) {
    t.disabled = true;
    log("Opening the recorder… sign in to the portal first if you haven't.");
    try {
      const r = await window.rr.scraper.record(recId);
      if (r.ok) {
        log(`Recipe captured for ${recId}.`, "ok");
        await refreshRecipes();
      } else if (r.cancelled) {
        log("Recording cancelled.");
      } else {
        log(`Recorder failed: ${r.message || r.error || "unknown error"}`, "error");
      }
    } catch (err) {
      // Catch the IPC promise rejection that the previous version
      // dropped on the floor — without this, the operator sees no
      // log line at all when the recorder throws and has no idea
      // why nothing happened.
      log(`Recorder threw: ${err && err.message || err}`, "error");
    } finally {
      t.disabled = false;
    }
    return;
  }

  if (t.hasAttribute("data-recipe-run")) {
    t.disabled = true;
    log("Running scraper headlessly…");
    try {
      const r = await window.rr.scraper.runNow(recId);
      if (r && r.ok) {
        log(`Scrape ok: ${r.newCount} new / ${r.total} scraped → ${r.csvPath}`, "ok");
      } else {
        log(`Scrape failed: ${r?.message || r?.error || "unknown"}`, "error");
      }
      await refreshRecipes();
      await refreshHistory();
    } finally {
      t.disabled = false;
    }
    return;
  }

  if (t.hasAttribute("data-recipe-edit")) {
    const r = await window.rr.scraper.get(recId);
    if (r.ok) openRecipeEditor(r.recipe);
    return;
  }

  if (t.hasAttribute("data-recipe-delete")) {
    if (!confirm("Delete this scraper and its recipe? The CSVs it already wrote stay on disk.")) return;
    await window.rr.scraper.delete(recId);
    log("Scraper deleted.", "ok");
    await refreshRecipes();
  }
});

window.rr.scraper.onRecipeUpdated(() => {
  refreshRecipes();
  refreshHistory();
});

// ─── AI agent crawler ───────────────────────────────────────────────

const agEls = {
  settings: $("#agent-settings"),
  settingsState: $("#agent-settings-state"),
  key: $("#ag-key"),
  model: $("#ag-model"),
  effort: $("#ag-effort"),
  uploadUrl: $("#ag-upload-url"),
  dspCode: $("#ag-dsp-code"),
  applySecret: $("#ag-apply-secret"),
  saveConfig: $("#btn-ag-save-config"),
  list: $("#agent-list"),
  addBtn: $("#btn-ag-add"),
  edit: $("#agent-edit"),
  title: $("#agent-edit-title"),
  name: $("#ag-name"),
  url: $("#ag-url"),
  goal: $("#ag-goal"),
  dir: $("#ag-dir"),
  pickDir: $("#btn-ag-pick-dir"),
  clearDir: $("#btn-ag-clear-dir"),
  times: $("#ag-times"),
  interval: $("#ag-interval"),
  enabled: $("#ag-enabled"),
  upload: $("#ag-upload"),
  visible: $("#ag-visible"),
  save: $("#btn-ag-save"),
  cancel: $("#btn-ag-cancel"),
  live: $("#agent-live"),
  trace: $("#agent-trace"),
  stop: $("#btn-ag-stop"),
};

let editingTaskId = null;
let liveTaskId = null;

async function refreshAgentConfig() {
  const c = await window.rr.agent.getConfig();
  if (!c || !c.ok) return;
  agEls.model.value = c.model || "claude-opus-4-8";
  agEls.effort.value = c.effort || "medium";
  agEls.uploadUrl.value = c.uploadUrl || "";
  agEls.dspCode.value = c.dspShortCode || "";
  agEls.key.placeholder = c.hasApiKey ? "•••••• (saved — leave blank to keep)" : "sk-ant-… (required)";
  agEls.applySecret.placeholder = c.hasApplySecret ? "•••••• (saved — leave blank to keep)" : "(optional)";
  const bits = [c.hasApiKey ? "key ✓" : "no key", c.uploadUrl && c.dspShortCode ? "upload ✓" : "upload off"];
  agEls.settingsState.textContent = `· ${bits.join(" · ")}`;
}

agEls.saveConfig.addEventListener("click", async () => {
  agEls.saveConfig.disabled = true;
  try {
    // Blank secret fields mean "keep what's saved" — only send them when
    // the operator actually typed a value (omitted = unchanged in main).
    const patch = {
      model: agEls.model.value,
      effort: agEls.effort.value,
      uploadUrl: agEls.uploadUrl.value.trim(),
      dspShortCode: agEls.dspCode.value.trim(),
    };
    if (agEls.key.value.trim()) patch.apiKey = agEls.key.value.trim();
    if (agEls.applySecret.value.trim()) patch.applySecret = agEls.applySecret.value.trim();
    await window.rr.agent.setConfig(patch);
    agEls.key.value = "";
    agEls.applySecret.value = "";
    log("Agent settings saved.", "ok");
    await refreshAgentConfig();
  } finally {
    agEls.saveConfig.disabled = false;
  }
});

function agentStatusPill(t) {
  if (!t.enabled) return `<span class="pill pill-off">Paused</span>`;
  if (t.lastResult === "error") return `<span class="pill pill-err">Last run failed</span>`;
  if (t.lastResult === "blocked") return `<span class="pill pill-err">Blocked</span>`;
  if (t.lastResult === "partial") return `<span class="pill pill-warm">Partial</span>`;
  if (t.lastResult === "complete" || t.lastResult === "ok") return `<span class="pill pill-ok">Last run ok</span>`;
  return `<span class="pill pill-warm">Armed</span>`;
}

function renderTasks(tasks) {
  if (!tasks || tasks.length === 0) {
    agEls.list.innerHTML = '<li class="empty">No agent tasks yet. Add one, write a goal, and hit Run.</li>';
    return;
  }
  agEls.list.innerHTML = tasks.map((t) => {
    const lastRun = t.lastRunAt ? relTime(t.lastRunAt) : "never";
    const nextRun = t.enabled && t.nextRunAt ? relTime(t.nextRunAt) : "—";
    const counts = t.lastCount != null ? `${t.lastNewCount || 0} found` : "—";
    const up = t.uploadToRouteReady ? ` · ${t.lastUploaded || 0} uploaded` : "";
    const errLine = (t.lastResult === "error" || t.lastResult === "blocked") && t.lastError
      ? `<div class="job-err">${escapeHtml(t.lastError)}</div>` : "";
    const sumLine = t.lastSummary ? `<div class="job-meta job-summary">${escapeHtml(t.lastSummary)}</div>` : "";
    return `
      <li class="job" data-task-id="${escapeHtml(t.id)}">
        <div class="job-head">
          <div class="job-title">
            <span class="job-name">${escapeHtml(t.name || "(unnamed)")}</span>
            ${agentStatusPill(t)}
            ${t.uploadToRouteReady ? '<span class="pill pill-upload">→ RouteReady</span>' : ''}
          </div>
          <div class="job-actions">
            <button class="btn btn-sm btn-primary" data-task-run="${escapeHtml(t.id)}">Run now</button>
            <button class="btn btn-sm" data-task-edit="${escapeHtml(t.id)}">Edit</button>
            <button class="btn btn-sm btn-ghost" data-task-delete="${escapeHtml(t.id)}">Delete</button>
          </div>
        </div>
        <div class="job-meta"><span title="${escapeHtml(t.startUrl || "")}">${escapeHtml(t.startUrl || "(no URL)")}</span></div>
        <div class="job-meta job-meta-grid">
          <span>Runs <strong>${escapeHtml((t.dailyTimes && t.dailyTimes.length) ? `at ${t.dailyTimes.join(", ")}` : `every ${t.intervalMinutes || 0} min`)}</strong></span>
          <span>Last run: <strong>${escapeHtml(lastRun)}</strong></span>
          <span>Next run: <strong>${escapeHtml(nextRun)}</strong></span>
          <span>Result: <strong>${escapeHtml(counts + up)}</strong></span>
        </div>
        ${sumLine}
        ${errLine}
      </li>`;
  }).join("");
}

async function refreshTasks() {
  const r = await window.rr.agent.listTasks();
  renderTasks(r.tasks || []);
}

function openTaskEditor(task) {
  editingTaskId = task ? task.id : null;
  agEls.title.textContent = task ? `Edit · ${task.name || "(unnamed)"}` : "New agent task";
  agEls.name.value = task?.name || "";
  agEls.url.value = task?.startUrl || "";
  agEls.goal.value = task?.goal || "";
  agEls.dir.value = task?.downloadDir || "";
  agEls.times.value = (task?.dailyTimes || []).join(", ");
  agEls.interval.value = task?.intervalMinutes || 60;
  agEls.enabled.checked = !!task?.enabled;
  agEls.upload.checked = !!task?.uploadToRouteReady;
  agEls.visible.checked = !!task?.visibleBrowser;
  agEls.edit.hidden = false;
  agEls.edit.scrollIntoView({ behavior: "smooth", block: "center" });
}
function closeTaskEditor() { editingTaskId = null; agEls.edit.hidden = true; }

agEls.addBtn.addEventListener("click", () => openTaskEditor(null));
agEls.cancel.addEventListener("click", closeTaskEditor);
agEls.pickDir.addEventListener("click", async () => { const r = await window.rr.reports.pickDownloadDir(); if (r.ok) agEls.dir.value = r.dir; });
agEls.clearDir.addEventListener("click", () => { agEls.dir.value = ""; });

agEls.save.addEventListener("click", async () => {
  const name = agEls.name.value.trim();
  const startUrl = agEls.url.value.trim();
  const goal = agEls.goal.value.trim();
  if (!name) { log("Task needs a name.", "error"); return; }
  if (!startUrl) { log("Task needs a start URL.", "error"); return; }
  if (!goal) { log("Task needs a goal — tell the agent what to find.", "error"); return; }
  const dailyTimes = agEls.times.value.split(",").map((s) => s.trim()).filter(Boolean);
  const badTime = dailyTimes.find((t) => !/^\d{1,2}:\d{2}$/.test(t));
  if (badTime) { log(`"${badTime}" isn't a valid time — use 24h HH:MM, e.g. 06:00 or 18:30.`, "error"); return; }
  const interval = Number(agEls.interval.value) || 60;
  if (!dailyTimes.length && interval < 5) { log("Set run-times, or use an interval of at least 5 minutes.", "error"); return; }
  const id = editingTaskId || slugifyId(name);
  agEls.save.disabled = true;
  try {
    const r = await window.rr.agent.saveTask({
      id, name, startUrl, goal,
      downloadDir: agEls.dir.value.trim(),
      dailyTimes,
      intervalMinutes: interval,
      enabled: agEls.enabled.checked,
      uploadToRouteReady: agEls.upload.checked,
      visibleBrowser: agEls.visible.checked,
    });
    if (r.ok) { log(`Saved agent task: ${name}`, "ok"); closeTaskEditor(); await refreshTasks(); }
  } finally { agEls.save.disabled = false; }
});

function pushTrace(line, kind) {
  const ts = new Date().toLocaleTimeString();
  const tag = kind === "error" ? "✗" : kind === "ok" ? "✓" : kind === "action" ? "→" : kind === "think" ? "…" : "·";
  agEls.trace.textContent = `[${ts}] ${tag} ${line}\n` + agEls.trace.textContent;
}

window.rr.agent.onStep((p) => {
  if (!p) return;
  if (p.kind === "start") { agEls.trace.textContent = ""; agEls.live.hidden = false; }
  pushTrace(p.text || "", p.kind);
});

window.rr.agent.onTaskUpdated(() => { refreshTasks(); refreshHistory(); });

agEls.stop.addEventListener("click", async () => {
  if (liveTaskId) { await window.rr.agent.stop(liveTaskId); log("Asked the agent to stop.", "ok"); }
});

agEls.list.addEventListener("click", async (evt) => {
  const t = evt.target.closest("button[data-task-run], button[data-task-edit], button[data-task-delete]");
  if (!t) return;
  const runId = t.getAttribute("data-task-run");
  const editId = t.getAttribute("data-task-edit");
  const delId = t.getAttribute("data-task-delete");

  if (runId) {
    const cfg = await window.rr.agent.getConfig();
    if (!cfg.hasApiKey) { log("Add an Anthropic API key in agent settings first.", "error"); agEls.settings.open = true; return; }
    t.disabled = true;
    liveTaskId = runId;
    agEls.live.hidden = false;
    agEls.trace.textContent = "";
    log("Agent task running… watch the live trace below.");
    try {
      const r = await window.rr.agent.runNow(runId);
      if (r && r.ok) {
        log(`Agent done: ${r.newCount} found${r.uploaded ? `, ${r.uploaded} uploaded` : ""} · ${r.status} (${r.steps} steps).`, r.status === "complete" ? "ok" : "info");
      } else {
        log(`Agent failed: ${r?.message || r?.error || "unknown"}`, "error");
      }
      await refreshTasks();
      await refreshHistory();
    } finally { t.disabled = false; liveTaskId = null; }
    return;
  }
  if (editId) { const r = await window.rr.agent.getTask(editId); if (r.ok) openTaskEditor(r.task); return; }
  if (delId) {
    if (!confirm("Delete this agent task? CSVs it already wrote stay on disk.")) return;
    await window.rr.agent.deleteTask(delId);
    log("Agent task deleted.", "ok");
    await refreshTasks();
  }
});

// Initial state
loadConfig();
refreshSessionStatus();
refreshHistory();
refreshJobs();
refreshRecipes();
refreshAgentConfig();
refreshTasks();
log("Ready.");
