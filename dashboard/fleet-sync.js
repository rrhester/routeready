// Portal Sync — dashboard-side companion to the desktop sync box.
//
// Shows each sync box's health (public.desktop_agents) and an on-demand
// "Sync to portal" button (writes a pending public.sync_requests row the box
// picks up). Pairs with desktop ROADMAP #3 (heartbeat/health) and #4
// (on-demand sync).
//
// Placement: mounts as a proper "Portal sync" subsection inside the existing
// Settings view (Settings → Portal sync), reusing the dashboard's own
// settings-nav / settings-section pattern + setSettingsSection() handler and
// native styles. If that DOM isn't present (different build / not signed in
// on the dashboard) it falls back to a small docked card so nothing is lost.
//
// IMPORTANT — auth safety: this script creates NO Supabase client. A second
// GoTrueClient on a dashboard page broke sign-in once. It reuses the single
// shared client the dashboard already creates in live.js (window.sb). If that
// client never appears (signed out), nothing renders.
(() => {
  "use strict";
  if (window.__rrFleetSyncLoaded) return;
  window.__rrFleetSyncLoaded = true;

  // Inside the desktop app the box IS this machine — no panel needed.
  if (window.routeready && window.routeready.isDesktop) return;

  const HEARTBEAT_STALE_MS = 15 * 60 * 1000; // box beats every 5m; 3 misses = dark
  const REFRESH_MS = 30 * 1000;

  function whenReady(cb, tries) {
    tries = tries || 0;
    if (window.sb && typeof window.sb.from === "function") return cb(window.sb);
    if (tries > 150) return; // ~30s then give up quietly
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
    if (document.getElementById("rr-ps-style")) return;
    const css = `
    .rr-ps-box { border:1px solid var(--border,#e2e8f0); border-radius:10px; padding:11px 13px; margin-bottom:10px; }
    .rr-ps-row { display:flex; align-items:center; gap:8px; }
    .rr-ps-name { font-weight:600; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .rr-ps-meta { color:var(--muted,#64748b); font-size:12.5px; margin-top:4px; }
    .rr-ps-pill { font-size:11px; font-weight:600; padding:2px 8px; border-radius:999px; white-space:nowrap; }
    .rr-ps-pill.ok { background:#dcfce7; color:#166534; }
    .rr-ps-pill.warn { background:#fef3c7; color:#92400e; }
    .rr-ps-pill.err { background:#fee2e2; color:#991b1b; }
    .rr-ps-empty { color:var(--muted,#64748b); padding:6px 0 12px; }
    .rr-ps-note { color:var(--muted,#64748b); font-size:12.5px; margin-top:8px; }
    /* docked fallback only */
    #rr-ps-dock { position:fixed; left:16px; bottom:16px; z-index:2147483646; width:330px;
      max-width:calc(100vw - 32px); font:13px/1.45 Inter,system-ui,sans-serif; background:#fff; color:#0f172a;
      border:1px solid #e2e8f0; border-radius:14px; box-shadow:0 10px 30px rgba(2,6,23,.18); overflow:hidden; }
    #rr-ps-dock .rr-ps-head { display:flex; align-items:center; gap:8px; padding:11px 13px;
      background:linear-gradient(180deg,#0F6CBD,#0B5BA1); color:#fff; cursor:pointer; }
    #rr-ps-dock .rr-ps-head b { flex:1; }
    #rr-ps-dock .rr-ps-dot { width:9px; height:9px; border-radius:50%; background:#94a3b8; }
    #rr-ps-dock .rr-ps-dot.ok{background:#22c55e}#rr-ps-dock .rr-ps-dot.warn{background:#f59e0b}#rr-ps-dock .rr-ps-dot.err{background:#ef4444}
    #rr-ps-dock .rr-ps-body { padding:11px 13px; max-height:46vh; overflow:auto; }
    #rr-ps-dock.rr-collapsed .rr-ps-body { display:none; }
    .rr-ps-btn { width:100%; border:0; border-radius:10px; padding:10px; font:600 13px Inter,system-ui,sans-serif; background:#2563eb; color:#fff; cursor:pointer; }
    .rr-ps-btn:disabled { background:#cbd5e1; cursor:not-allowed; }
    `;
    const el = document.createElement("style");
    el.id = "rr-ps-style"; el.textContent = css;
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
      return '<div class="rr-ps-empty">No sync box connected yet. Install the RouteReady desktop app on your always-on machine and click “Connect desktop app”.</div>';
    }
    return agents.map((a) => {
      const st = boxStatus(a);
      const last = a.last_run_at
        ? `Last pull ${relTime(a.last_run_at)}` + (a.last_run_rows != null ? ` · ${a.last_run_rows} rows` : "") + (a.last_run_status ? ` · ${esc(a.last_run_status)}` : "")
        : "No pull yet";
      const err = (st.cls !== "ok" && a.last_run_error) ? `<div class="rr-ps-meta" style="color:#b91c1c">${esc(a.last_run_error)}</div>` : "";
      return `<div class="rr-ps-box">
        <div class="rr-ps-row">
          <span class="rr-ps-name" title="${esc(a.label || a.agent_id)}">${esc(a.label || "Sync box")}</span>
          <span class="rr-ps-pill ${st.cls}">${st.label}</span>
        </div>
        <div class="rr-ps-meta">Heartbeat ${relTime(a.last_heartbeat_at)}${a.app_version ? " · v" + esc(a.app_version) : ""}</div>
        <div class="rr-ps-meta">${esc(last)}</div>
        ${err}
      </div>`;
    }).join("");
  }

  // Shared controller: given the boxes container, sync button and note
  // elements, wire up loading + the on-demand sync action.
  function wireController(sb, els, onAfterRender) {
    async function refresh() {
      try {
        // RLS scopes desktop_agents to the signed-in DSP — no client filter.
        const { data, error } = await sb
          .from("desktop_agents")
          .select("agent_id,label,app_version,last_heartbeat_at,portal_session_ok,last_run_at,last_run_status,last_run_error,last_run_rows")
          .order("last_heartbeat_at", { ascending: false });
        if (error) { els.boxes.innerHTML = `<div class="rr-ps-empty">Couldn’t load box status.</div>`; return; }
        const agents = data || [];
        els.boxes.innerHTML = renderBoxes(agents);
        const anyOnline = agents.some((a) => boxStatus(a).cls !== "err");
        els.btn.disabled = !agents.length || !anyOnline;
        els.note.textContent = !agents.length ? "" : (!anyOnline ? "No box is online to take the request." : "");
        if (onAfterRender) onAfterRender(agents);
      } catch (e) {
        els.boxes.innerHTML = `<div class="rr-ps-empty">Couldn’t load box status.</div>`;
      }
    }

    els.btn.addEventListener("click", async () => {
      els.btn.disabled = true;
      const prev = els.btn.textContent;
      els.btn.textContent = "Requesting…";
      try {
        let requested_by = null;
        try { const u = await sb.auth.getUser(); requested_by = u?.data?.user?.id || null; } catch {}
        const { error } = await sb.from("sync_requests").insert(requested_by ? { requested_by } : {});
        if (error) { els.note.textContent = "Couldn’t queue the sync. " + (error.message || ""); els.btn.textContent = prev; els.btn.disabled = false; return; }
        els.btn.textContent = "Sync requested ✓";
        els.note.textContent = "Your box will pull shortly — watch the status above.";
        let n = 0;
        const poll = setInterval(() => { refresh(); if (++n >= 8) { clearInterval(poll); els.btn.textContent = prev; els.btn.disabled = false; } }, 8000);
      } catch (e) {
        els.note.textContent = "Couldn’t queue the sync.";
        els.btn.textContent = prev; els.btn.disabled = false;
      }
    });

    return refresh;
  }

  // Preferred: a proper subsection in Settings → Portal sync.
  function mountAsSettingsSection(sb) {
    const nav = document.querySelector("#view-settings .settings-nav");
    const wrap = document.querySelector('#view-settings .settings-section[data-set="workspace"]');
    if (!nav || !wrap || !wrap.parentElement) return false;
    if (document.querySelector('.settings-section[data-set="portal-sync"]')) return true;

    const navBtn = document.createElement("button");
    navBtn.className = "settings-nav-item";
    navBtn.setAttribute("data-set", "portal-sync");
    navBtn.textContent = "Portal sync";
    navBtn.addEventListener("click", () => {
      if (typeof window.setSettingsSection === "function") window.setSettingsSection(navBtn);
      refresh();
    });
    nav.appendChild(navBtn);

    const section = document.createElement("div");
    section.className = "settings-section hidden";
    section.setAttribute("data-set", "portal-sync");
    section.innerHTML = `
      <div class="settings-section-head">
        <h2 class="settings-section-title">Portal sync</h2>
        <p class="settings-section-sub">Your always-on sync box pulls portal data on schedule and uploads it to RouteReady. Check its health and trigger a pull on demand.</p>
      </div>
      <div id="rr-ps-boxes"><div class="rr-ps-empty">Loading…</div></div>
      <div style="max-width:360px">
        <button class="rr-ps-btn" id="rr-ps-sync" disabled>Sync to portal now</button>
        <div class="rr-ps-note" id="rr-ps-note"></div>
      </div>`;
    wrap.parentElement.appendChild(section);

    const refresh = wireController(sb, {
      boxes: section.querySelector("#rr-ps-boxes"),
      btn: section.querySelector("#rr-ps-sync"),
      note: section.querySelector("#rr-ps-note"),
    });
    refresh();
    setInterval(() => { if (!section.classList.contains("hidden")) refresh(); }, REFRESH_MS);
    return true;
  }

  // Fallback: a small docked card (only if the Settings DOM isn't there).
  function mountDocked(sb) {
    const dock = document.createElement("div");
    dock.id = "rr-ps-dock";
    dock.className = "rr-collapsed";
    dock.innerHTML = `
      <div class="rr-ps-head" id="rr-ps-dhead">
        <span class="rr-ps-dot" id="rr-ps-ddot"></span><b>Portal sync</b><span id="rr-ps-dcaret">▸</span>
      </div>
      <div class="rr-ps-body">
        <div id="rr-ps-boxes"><div class="rr-ps-empty">Loading…</div></div>
        <button class="rr-ps-btn" id="rr-ps-sync" disabled>Sync to portal now</button>
        <div class="rr-ps-note" id="rr-ps-note"></div>
      </div>`;
    document.body.appendChild(dock);
    const dot = dock.querySelector("#rr-ps-ddot");
    const refresh = wireController(sb, {
      boxes: dock.querySelector("#rr-ps-boxes"),
      btn: dock.querySelector("#rr-ps-sync"),
      note: dock.querySelector("#rr-ps-note"),
    }, (agents) => { const od = overallDot(agents); dot.className = "rr-ps-dot" + (od ? " " + od : ""); });
    dock.querySelector("#rr-ps-dhead").addEventListener("click", () => {
      const collapsed = dock.classList.toggle("rr-collapsed");
      dock.querySelector("#rr-ps-dcaret").textContent = collapsed ? "▸" : "▾";
      if (!collapsed) refresh();
    });
    refresh();
    setInterval(refresh, REFRESH_MS * 2);
  }

  whenReady((sb) => {
    injectStyles();
    if (!mountAsSettingsSection(sb)) mountDocked(sb);
  });
})();
