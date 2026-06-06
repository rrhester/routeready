// Admin-only "Crawl tasks" manager (Phase 1 of central crawl config).
//
// Lets platform_admin (support@gorouteready.com) define each DSP's crawl
// task — goal, start URL, schedule — centrally. DSP customers never see this;
// their boxes just fetch + run whatever is assigned. Mounts into the Admin
// view (#view-admin), which is already gated to platform_admin in the nav;
// the REAL enforcement is RLS on public.crawl_tasks (admin-only writes).
//
// Auth-safe: creates NO Supabase client — reuses the shared window.sb.
(() => {
  "use strict";
  if (window.__rrCrawlAdminLoaded) return;
  window.__rrCrawlAdminLoaded = true;

  function whenReady(cb, tries) {
    tries = tries || 0;
    const host = document.getElementById("view-admin");
    if (window.sb && typeof window.sb.from === "function" && host) return cb(window.sb, host);
    if (tries > 200) return; // ~40s then give up
    setTimeout(() => whenReady(cb, tries + 1), 200);
  }

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function injectStyles() {
    if (document.getElementById("rr-ct-style")) return;
    const css = `
    #rr-ct { margin:24px 0; border:1px solid var(--border,#e2e8f0); border-radius:14px; padding:18px 20px; background:var(--surface,#fff); }
    #rr-ct h2 { margin:0 0 2px; font-size:17px; }
    #rr-ct .rr-ct-sub { color:var(--muted,#64748b); font-size:13px; margin-bottom:14px; }
    #rr-ct label { display:block; font-size:12px; font-weight:600; color:var(--muted,#475569); margin:10px 0 4px; }
    #rr-ct input, #rr-ct select, #rr-ct textarea { width:100%; box-sizing:border-box; border:1px solid var(--border,#cbd5e1); border-radius:8px; padding:8px 10px; font:13px Inter,system-ui,sans-serif; }
    #rr-ct textarea { min-height:90px; resize:vertical; }
    #rr-ct .rr-ct-row { display:flex; gap:14px; flex-wrap:wrap; }
    #rr-ct .rr-ct-row > div { flex:1; min-width:160px; }
    #rr-ct .rr-ct-check { display:flex; align-items:center; gap:8px; margin-top:12px; font-size:13px; }
    #rr-ct .rr-ct-check input { width:auto; }
    #rr-ct .rr-ct-btn { border:0; border-radius:9px; padding:9px 15px; font:600 13px Inter,system-ui,sans-serif; cursor:pointer; }
    #rr-ct .rr-ct-btn.primary { background:#2563eb; color:#fff; }
    #rr-ct .rr-ct-btn.ghost { background:#f1f5f9; color:#334155; }
    #rr-ct .rr-ct-btn.danger { background:#fee2e2; color:#991b1b; }
    #rr-ct .rr-ct-actions { display:flex; gap:8px; margin-top:14px; }
    #rr-ct .rr-ct-list { margin:6px 0 16px; }
    #rr-ct .rr-ct-item { border:1px solid #eef2f7; border-radius:10px; padding:10px 12px; margin-bottom:8px; display:flex; align-items:flex-start; gap:10px; }
    #rr-ct .rr-ct-item .rr-ct-it-main { flex:1; }
    #rr-ct .rr-ct-it-name { font-weight:600; }
    #rr-ct .rr-ct-it-meta { color:#64748b; font-size:12px; margin-top:2px; }
    #rr-ct .rr-ct-pill { font-size:11px; font-weight:600; padding:1px 7px; border-radius:999px; }
    #rr-ct .rr-ct-pill.on { background:#dcfce7; color:#166534; }
    #rr-ct .rr-ct-pill.off { background:#f1f5f9; color:#64748b; }
    #rr-ct .rr-ct-note { font-size:12.5px; margin-top:8px; min-height:16px; }
    #rr-ct .rr-ct-divider { border:0; border-top:1px solid #eef2f7; margin:16px 0; }
    `;
    const el = document.createElement("style");
    el.id = "rr-ct-style"; el.textContent = css;
    document.head.appendChild(el);
  }

  whenReady((sb, host) => {
    injectStyles();
    if (document.getElementById("rr-ct")) return;

    const card = document.createElement("div");
    card.id = "rr-ct";
    card.innerHTML = `
      <h2>Crawl tasks</h2>
      <div class="rr-ct-sub">Define what each DSP's sync box pulls. Only you (platform admin) can edit this; DSPs just receive the data.</div>
      <label>DSP</label>
      <select id="rr-ct-dsp"><option value="">Loading DSPs…</option></select>
      <div id="rr-ct-body" hidden>
        <hr class="rr-ct-divider">
        <div id="rr-ct-list" class="rr-ct-list"></div>
        <h2 style="font-size:15px" id="rr-ct-form-title">Add a crawl task</h2>
        <input type="hidden" id="rr-ct-id">
        <label>Task name</label>
        <input id="rr-ct-name" placeholder="e.g. Indeed applicants">
        <label>Start URL (the portal page to crawl)</label>
        <input id="rr-ct-url" placeholder="https://employers.indeed.com/candidates">
        <label>Goal — describe in plain English what to find</label>
        <textarea id="rr-ct-goal" placeholder="Find the list of applicants. For each one, open their profile and read their full name, email, and phone, then save them. Page through the whole list. Never guess values."></textarea>
        <div class="rr-ct-row">
          <div>
            <label>Run at times (HH:MM, comma-separated — box local time)</label>
            <input id="rr-ct-times" placeholder="06:00, 18:00">
          </div>
          <div>
            <label>…or every N minutes (used if no times set)</label>
            <input id="rr-ct-interval" type="number" min="5" placeholder="60">
          </div>
        </div>
        <label class="rr-ct-check"><input type="checkbox" id="rr-ct-enabled" checked> Enabled (box will run it on schedule)</label>
        <label class="rr-ct-check"><input type="checkbox" id="rr-ct-upload" checked> Upload results into RouteReady</label>
        <label class="rr-ct-check"><input type="checkbox" id="rr-ct-visible"> Use a visible browser (for bot-protected portals)</label>
        <div class="rr-ct-actions">
          <button class="rr-ct-btn primary" id="rr-ct-save">Save task</button>
          <button class="rr-ct-btn ghost" id="rr-ct-clear" type="button">Clear / new</button>
        </div>
        <div class="rr-ct-note" id="rr-ct-note"></div>
      </div>`;
    // Put it at the top of the admin page content if there's a .page wrapper, else into the view.
    const mountPoint = host.querySelector(".page") || host;
    mountPoint.appendChild(card);

    const $ = (id) => card.querySelector(id);
    const dspSel = $("#rr-ct-dsp");
    const body = $("#rr-ct-body");
    const note = $("#rr-ct-note");

    function setNote(msg, ok) { note.textContent = msg || ""; note.style.color = ok ? "#166534" : "#b91c1c"; }

    async function loadDsps() {
      try {
        const { data, error } = await sb.from("dsps").select("id,name").order("name");
        if (error) { dspSel.innerHTML = `<option value="">Couldn't load DSPs (${esc(error.message)})</option>`; return; }
        const rows = data || [];
        if (!rows.length) { dspSel.innerHTML = `<option value="">No DSPs found (are you signed in as platform admin?)</option>`; return; }
        dspSel.innerHTML = `<option value="">Select a DSP…</option>` +
          rows.map((d) => `<option value="${esc(d.id)}">${esc(d.name || d.id)}</option>`).join("");
      } catch (e) {
        dspSel.innerHTML = `<option value="">Couldn't load DSPs</option>`;
      }
    }

    function clearForm() {
      $("#rr-ct-id").value = "";
      $("#rr-ct-name").value = "";
      $("#rr-ct-url").value = "";
      $("#rr-ct-goal").value = "";
      $("#rr-ct-times").value = "";
      $("#rr-ct-interval").value = "";
      $("#rr-ct-enabled").checked = true;
      $("#rr-ct-upload").checked = true;
      $("#rr-ct-visible").checked = false;
      $("#rr-ct-form-title").textContent = "Add a crawl task";
      setNote("");
    }

    function fillForm(t) {
      $("#rr-ct-id").value = t.id;
      $("#rr-ct-name").value = t.name || "";
      $("#rr-ct-url").value = t.start_url || "";
      $("#rr-ct-goal").value = t.goal || "";
      $("#rr-ct-times").value = (t.daily_times || []).join(", ");
      $("#rr-ct-interval").value = t.interval_minutes || "";
      $("#rr-ct-enabled").checked = !!t.enabled;
      $("#rr-ct-upload").checked = !!t.upload_to_routeready;
      $("#rr-ct-visible").checked = !!t.visible_browser;
      $("#rr-ct-form-title").textContent = "Edit crawl task";
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    async function loadTasks(dspId) {
      const list = $("#rr-ct-list");
      list.innerHTML = "Loading…";
      const { data, error } = await sb.from("crawl_tasks").select("*").eq("dsp_id", dspId).order("name");
      if (error) { list.innerHTML = `<div class="rr-ct-it-meta">Couldn't load tasks: ${esc(error.message)}</div>`; return; }
      const tasks = data || [];
      if (!tasks.length) { list.innerHTML = `<div class="rr-ct-it-meta">No crawl tasks for this DSP yet — add one below.</div>`; return; }
      list.innerHTML = tasks.map((t) => {
        const sched = (t.daily_times && t.daily_times.length) ? `at ${t.daily_times.join(", ")}` : `every ${t.interval_minutes || 0} min`;
        return `<div class="rr-ct-item">
          <div class="rr-ct-it-main">
            <div class="rr-ct-it-name">${esc(t.name)} <span class="rr-ct-pill ${t.enabled ? "on" : "off"}">${t.enabled ? "enabled" : "off"}</span></div>
            <div class="rr-ct-it-meta">${esc(t.start_url)} · runs ${esc(sched)}${t.upload_to_routeready ? " · → RouteReady" : ""}</div>
          </div>
          <button class="rr-ct-btn ghost" data-edit="${esc(t.id)}">Edit</button>
          <button class="rr-ct-btn danger" data-del="${esc(t.id)}">Delete</button>
        </div>`;
      }).join("");
      list.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => {
        const t = tasks.find((x) => x.id === b.getAttribute("data-edit"));
        if (t) fillForm(t);
      }));
      list.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
        if (!confirm("Delete this crawl task? The box will stop running it.")) return;
        const { error } = await sb.from("crawl_tasks").delete().eq("id", b.getAttribute("data-del"));
        if (error) { setNote("Delete failed: " + error.message); return; }
        clearForm(); loadTasks(dspId);
      }));
    }

    dspSel.addEventListener("change", () => {
      const id = dspSel.value;
      if (!id) { body.hidden = true; return; }
      body.hidden = false;
      clearForm();
      loadTasks(id);
    });

    $("#rr-ct-clear").addEventListener("click", clearForm);

    $("#rr-ct-save").addEventListener("click", async () => {
      const dspId = dspSel.value;
      if (!dspId) { setNote("Pick a DSP first."); return; }
      const name = $("#rr-ct-name").value.trim();
      const start_url = $("#rr-ct-url").value.trim();
      const goal = $("#rr-ct-goal").value.trim();
      if (!name || !start_url || !goal) { setNote("Name, start URL, and goal are all required."); return; }
      const times = $("#rr-ct-times").value.split(",").map((s) => s.trim()).filter(Boolean);
      const badTime = times.find((t) => !/^\d{1,2}:\d{2}$/.test(t));
      if (badTime) { setNote(`"${badTime}" isn't a valid time — use 24h HH:MM, e.g. 06:00.`); return; }
      const interval = Number($("#rr-ct-interval").value) || 60;
      if (!times.length && interval < 5) { setNote("Set run-times, or an interval of at least 5 minutes."); return; }

      const row = {
        dsp_id: dspId, name, start_url, goal,
        daily_times: times,
        interval_minutes: interval,
        enabled: $("#rr-ct-enabled").checked,
        upload_to_routeready: $("#rr-ct-upload").checked,
        visible_browser: $("#rr-ct-visible").checked,
        updated_at: new Date().toISOString(),
      };
      const id = $("#rr-ct-id").value;
      if (id) row.id = id;

      const { error } = await sb.from("crawl_tasks").upsert(row);
      if (error) { setNote("Save failed: " + error.message); return; }
      setNote("Saved ✓", true);
      clearForm();
      loadTasks(dspId);
    });

    loadDsps();
  });
})();
