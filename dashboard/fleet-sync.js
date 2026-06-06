// Portal Sync panel — the dashboard-side companion to the desktop sync box.
//
// Shows the DSP's sync box health (from public.desktop_agents) and an
// on-demand "Sync to portal" button (writes a pending public.sync_requests
// row the box picks up). Pairs with desktop ROADMAP #3 (heartbeat/health) and
// #4 (on-demand sync).
//
// IMPORTANT — auth safety: this script creates NO Supabase client. A second
// GoTrueClient on a dashboard page broke sign-in once. It reuses the single
// shared client the dashboard already creates in live.js (window.sb). If that
// client never appears (signed out), the panel simply never renders.
(() => {
  "use strict";
  if (window.__rrFleetSyncLoaded) return;
  window.__rrFleetSyncLoaded = true;

  // Inside the desktop app the box IS this machine — no need for the panel.
  if (window.routeready && window.routeready.isDesktop) return;

  const HEARTBEAT_STALE_MS = 15 * 60 * 1000; // box heartbeats every 5m; 3 misses = dark
  const REFRESH_MS = 30 * 1000;

  // Wait for the dashboard's shared client + DSP context (live.js sets both).
  function whenReady(cb, tries) {
    tries = tries || 0;
    if (window.sb && typeof window.sb.from === "function") return cb(window.sb);
    if (tries > 150) return; // ~30s, then give up quietly (signed out / not loaded)
    setTimeout(() => whenReady(cb, tries + 1), 200);
  }

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function relTime(iso) {
    if (!iso) return "never";
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (isNaN(d)) return "—";
    if (d < 60) return "just now";
    if (d < 3600) return Math.floor(d / 60) + "m ago";
    if (d < 86400) return Math.floor(d / 3600) + "h ago";
    return Math.floor(d / 86400) + "d ago";
  }

  function injectStyles() {
    if (document.getElementById("rr-fleet-style")) return;
    const css = `
    #rr-fleet { position:fixed; left:16px; bottom:16px; z-index:2147483646; width:330px;
      max-width:calc(100vw - 32px); font:13px/1.45 Inter,system-ui,-apple-system,sans-serif;
      background:#fff; color:#0f172a; border:1px solid #e2e8f0; border-radius:14px;
      box-shadow:0 10px 30px rgba(2,6,23,.18); overflow:hidden; }
    #rr-fleet .rr-f-head { display:flex; align-items:center; gap:8px; padding:11px 13px;
      background:linear-gradient(180deg,#0F6CBD,#0B5BA1); color:#fff; cursor:pointer; }
    #rr-fleet .rr-f-head b { font-weight:700; font-size:13px; flex:1; }
    #rr-fleet .rr-f-dot { width:9px; height:9px; border-radius:50%; background:#94a3b8; }
    #rr-fleet .rr-f-dot.ok { background:#22c55e; } #rr-fleet .rr-f-dot.warn { background:#f59e0b; }
    #rr-fleet .rr-f-dot.err { background:#ef4444; }
    #rr-fleet .rr-f-caret { opacity:.85; font-size:12px; }
    #rr-fleet .rr-f-body { padding:11px 13px; max-height:46vh; overflow:auto; }
    #rr-fleet.rr-collapsed .rr-f-body { display:none; }
    #rr-fleet .rr-f-box { border:1px solid #eef2f7; border-radius:10px; padding:9px 10px; margin-bottom:9px; }
    #rr-fleet .rr-f-box .rr-f-row { display:flex; align-items:center; gap:7px; }
    #rr-fleet .rr-f-name { font-weight:600; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    #rr-fleet .rr-f-meta { color:#64748b; font-size:12px; margin-top:4px; }
    #rr-fleet .rr-f-pill { font-size:11px; font-weight:600; padding:1px 7px; border-radius:999px; }
    #rr-fleet .rr-f-pill.ok { background:#dcfce7; color:#166534; }
    #rr-fleet .rr-f-pill.warn { background:#fef3c7; color:#92400e; }
    #rr-fleet .rr-f-pill.err { background:#fee2e2; color:#991b1b; }
    #rr-fleet .rr-f-empty { color:#64748b; padding:6px 2px 10px; }
    #rr-fleet .rr-f-btn { width:100%; border:0; border-radius:10px; padding:10px; font:600 13px Inter,system-ui,sans-serif;
      background:#2563eb; color:#fff; cursor:pointer; }
    #rr-fleet .rr-f-btn:disabled { background:#cbd5e1; cursor:not-allowed; }
    #rr-fleet .rr-f-note { color:#64748b; font-size:11.5px; margin-top:7px; text-align:center; }
    `;
    const el = document.createElement("style");
    el.id = "rr-fleet-style"; el.textContent = css;
    document.head.appendChild(el);
  }

  function boxStatus(a) {
    const stale = !a.last_heartbeat_at || (Date.now() - new Date(a.last_heartbeat_at).getTime()) > HEARTBEAT_STALE_MS;
    if (stale) return { cls: "err", label: "Offline" };
    if (a.portal_session_ok === false) return { cls: "warn", label: "Portal login needed" };
    if (a.last_run_status === "error") return { cls: "warn", label: "Last pull failed" };
    return { cls: "ok", label: "Online" };
  }

  function overallDot(agents) {
    if (!agents.length) return "";
    const sts = agents.map(boxStatus);
    if (sts.some((s) => s.cls === "err")) return "err";
    if (sts.some((s) => s.cls === "warn")) return "warn";
    return "ok";
  }

  function renderBoxes(agents) {
    if (!agents.length) {
      return '<div class="rr-f-empty">No sync box connected yet. Install the RouteReady desktop app on your always-on machine and click “Connect desktop app”.</div>';
    }
    return agents.map((a) => {
      const st = boxStatus(a);
      const last = a.last_run_at
        ? `Last pull ${relTime(a.last_run_at)}` + (a.last_run_rows != null ? ` · ${a.last_run_rows} rows` : "") + (a.last_run_status ? ` · ${esc(a.last_run_status)}` : "")
        : "No pull yet";
      const err = (st.cls !== "ok" && a.last_run_error) ? `<div class="rr-f-meta" style="color:#b91c1c">${esc(a.last_run_error)}</div>` : "";
      return `<div class="rr-f-box">
        <div class="rr-f-row">
          <span class="rr-f-name" title="${esc(a.label || a.agent_id)}">${esc(a.label || "Sync box")}</span>
          <span class="rr-f-pill ${st.cls}">${st.label}</span>
        </div>
        <div class="rr-f-meta">Heartbeat ${relTime(a.last_heartbeat_at)}${a.app_version ? " · v" + esc(a.app_version) : ""}</div>
        <div class="rr-f-meta">${esc(last)}</div>
        ${err}
      </div>`;
    }).join("");
  }

  whenReady((sb) => {
    injectStyles();

    const panel = document.createElement("div");
    panel.id = "rr-fleet";
    panel.className = "rr-collapsed"; // start collapsed so we never cover the page
    panel.innerHTML = `
      <div class="rr-f-head" id="rr-f-head">
        <span class="rr-f-dot" id="rr-f-dot"></span>
        <b>Portal sync</b>
        <span class="rr-f-caret" id="rr-f-caret">▸</span>
      </div>
      <div class="rr-f-body">
        <div id="rr-f-boxes"><div class="rr-f-empty">Loading…</div></div>
        <button class="rr-f-btn" id="rr-f-sync" disabled>Sync to portal now</button>
        <div class="rr-f-note" id="rr-f-note"></div>
      </div>`;
    document.body.appendChild(panel);

    const head = panel.querySelector("#rr-f-head");
    const caret = panel.querySelector("#rr-f-caret");
    const dot = panel.querySelector("#rr-f-dot");
    const boxesEl = panel.querySelector("#rr-f-boxes");
    const syncBtn = panel.querySelector("#rr-f-sync");
    const note = panel.querySelector("#rr-f-note");

    head.addEventListener("click", () => {
      const collapsed = panel.classList.toggle("rr-collapsed");
      caret.textContent = collapsed ? "▸" : "▾";
      if (!collapsed) refresh();
    });

    async function refresh() {
      try {
        // RLS scopes desktop_agents to the signed-in DSP, so no filter needed.
        const { data, error } = await sb
          .from("desktop_agents")
          .select("agent_id,label,app_version,last_heartbeat_at,portal_session_ok,last_run_at,last_run_status,last_run_error,last_run_rows")
          .order("last_heartbeat_at", { ascending: false });
        if (error) { boxesEl.innerHTML = `<div class="rr-f-empty">Couldn’t load box status.</div>`; return; }
        const agents = data || [];
        boxesEl.innerHTML = renderBoxes(agents);
        const od = overallDot(agents);
        dot.className = "rr-f-dot" + (od ? " " + od : "");
        const anyOnline = agents.some((a) => boxStatus(a).cls !== "err");
        syncBtn.disabled = !agents.length || !anyOnline;
        if (!agents.length) note.textContent = "";
        else if (!anyOnline) note.textContent = "No box is online to take the request.";
        else note.textContent = "";
      } catch (e) {
        boxesEl.innerHTML = `<div class="rr-f-empty">Couldn’t load box status.</div>`;
      }
    }

    syncBtn.addEventListener("click", async () => {
      syncBtn.disabled = true;
      const prev = syncBtn.textContent;
      syncBtn.textContent = "Requesting…";
      try {
        let requested_by = null;
        try { const u = await sb.auth.getUser(); requested_by = u?.data?.user?.id || null; } catch {}
        // dsp_id + status default in the table; RLS checks dsp_id = current_dsp_id().
        const { error } = await sb.from("sync_requests").insert(requested_by ? { requested_by } : {});
        if (error) { note.textContent = "Couldn’t queue the sync. " + (error.message || ""); syncBtn.textContent = prev; syncBtn.disabled = false; return; }
        syncBtn.textContent = "Sync requested ✓";
        note.textContent = "Your box will pull shortly — watch the status above.";
        // Refresh a few times so the operator sees the box claim/finish it.
        let n = 0;
        const poll = setInterval(() => { refresh(); if (++n >= 8) { clearInterval(poll); syncBtn.textContent = prev; syncBtn.disabled = false; } }, 8000);
      } catch (e) {
        note.textContent = "Couldn’t queue the sync.";
        syncBtn.textContent = prev; syncBtn.disabled = false;
      }
    });

    refresh();
    setInterval(() => { if (!panel.classList.contains("rr-collapsed")) refresh(); }, REFRESH_MS);
    // Keep the header dot fresh even while collapsed so a dark box is visible.
    setInterval(refresh, REFRESH_MS * 2);
  });
})();
