// Portal Sync + setup — dashboard-side companion to the desktop sync box.
//
// Three things live here:
//   1. Box health (public.desktop_agents) + on-demand "Sync to portal now"
//      (public.sync_requests). Pairs with desktop ROADMAP #3 + #4.
//   2. A setup area (Settings → Portal sync) with:
//        • "Set up sync box"  → a step-by-step mini-PC guide incl. the
//          download link (the crawler installs ON the box, not here).
//        • "Install Advanced Web App" → installs the dashboard itself as a
//          PWA (its own app window).
//   3. A prominent, dismissible "finish setup" banner for new DSPs that
//      auto-hides once a box is connected.
//
// IMPORTANT — auth safety: this script creates NO Supabase client. A second
// GoTrueClient on a dashboard page broke sign-in once. It reuses the single
// shared client the dashboard already creates in live.js (window.sb).
(() => {
  "use strict";
  if (window.__rrFleetSyncLoaded) return;
  window.__rrFleetSyncLoaded = true;

  const HEARTBEAT_STALE_MS = 15 * 60 * 1000; // box beats every 5m; 3 misses = dark
  const REFRESH_MS = 30 * 1000;
  const DOWNLOAD_URL = "/download"; // marketing download page (auto-detects OS)

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
    .rr-ps-btn { display:inline-flex; align-items:center; justify-content:center; gap:8px; border:0; border-radius:10px; padding:11px 16px; font:600 13.5px Inter,system-ui,sans-serif; cursor:pointer; }
    .rr-ps-btn.primary { background:#2563eb; color:#fff; }
    .rr-ps-btn.ghost { background:#eef2ff; color:#1e3a8a; }
    .rr-ps-btn:disabled { background:#cbd5e1; color:#fff; cursor:not-allowed; }
    .rr-ps-setup { display:flex; gap:10px; flex-wrap:wrap; margin:4px 0 18px; }
    .rr-ps-setup-sub { color:var(--muted,#64748b); font-size:12.5px; margin:-10px 0 16px; }
    /* setup guide modal */
    #rr-ps-modal { position:fixed; inset:0; z-index:2147483647; background:rgba(2,6,23,.5); display:flex; align-items:center; justify-content:center; padding:20px; }
    #rr-ps-modal .rr-ps-card { background:#fff; color:#0f172a; width:560px; max-width:100%; max-height:88vh; overflow:auto; border-radius:16px; box-shadow:0 24px 60px rgba(2,6,23,.4); font:14px/1.5 Inter,system-ui,sans-serif; }
    #rr-ps-modal .rr-ps-card-head { display:flex; align-items:flex-start; gap:12px; padding:20px 22px 8px; }
    #rr-ps-modal h2 { margin:0; font-size:19px; flex:1; }
    #rr-ps-modal .rr-ps-x { border:0; background:#f1f5f9; border-radius:8px; width:30px; height:30px; font-size:18px; cursor:pointer; color:#475569; }
    #rr-ps-modal .rr-ps-card-body { padding:4px 22px 22px; }
    #rr-ps-modal ol { padding-left:20px; margin:14px 0; }
    #rr-ps-modal li { margin-bottom:12px; }
    #rr-ps-modal .rr-ps-warn { background:#fffbeb; border:1px solid #fde68a; color:#92400e; border-radius:10px; padding:10px 12px; font-size:12.5px; margin-top:8px; }
    /* setup banner */
    #rr-ps-banner { position:fixed; top:64px; left:50%; transform:translateX(-50%); z-index:2147483640; width:min(720px,calc(100vw - 32px));
      background:linear-gradient(180deg,#1d4ed8,#1e40af); color:#fff; border-radius:14px; box-shadow:0 12px 34px rgba(2,6,23,.35);
      display:flex; align-items:center; gap:14px; padding:13px 16px; font:14px/1.4 Inter,system-ui,sans-serif; }
    #rr-ps-banner .rr-ps-b-text { flex:1; }
    #rr-ps-banner .rr-ps-b-text b { display:block; font-size:14.5px; }
    #rr-ps-banner .rr-ps-b-text span { opacity:.85; font-size:12.5px; }
    #rr-ps-banner .rr-ps-b-actions { display:flex; gap:8px; flex-wrap:wrap; }
    #rr-ps-banner .rr-ps-b-btn { border:0; border-radius:9px; padding:8px 12px; font:600 12.5px Inter,system-ui,sans-serif; cursor:pointer; white-space:nowrap; }
    #rr-ps-banner .rr-ps-b-btn.solid { background:#fff; color:#1e3a8a; }
    #rr-ps-banner .rr-ps-b-btn.outline { background:rgba(255,255,255,.15); color:#fff; border:1px solid rgba(255,255,255,.5); }
    #rr-ps-banner .rr-ps-b-x { background:transparent; border:0; color:#fff; opacity:.8; font-size:18px; cursor:pointer; align-self:flex-start; }
    /* docked fallback */
    #rr-ps-dock { position:fixed; left:16px; bottom:16px; z-index:2147483646; width:330px; max-width:calc(100vw - 32px); font:13px/1.45 Inter,system-ui,sans-serif; background:#fff; color:#0f172a; border:1px solid #e2e8f0; border-radius:14px; box-shadow:0 10px 30px rgba(2,6,23,.18); overflow:hidden; }
    #rr-ps-dock .rr-ps-dhead { display:flex; align-items:center; gap:8px; padding:11px 13px; background:linear-gradient(180deg,#0F6CBD,#0B5BA1); color:#fff; cursor:pointer; }
    #rr-ps-dock .rr-ps-dhead b { flex:1; }
    #rr-ps-dock .rr-ps-body { padding:11px 13px; max-height:46vh; overflow:auto; }
    #rr-ps-dock.rr-collapsed .rr-ps-body { display:none; }
    `;
    const el = document.createElement("style");
    el.id = "rr-ps-style"; el.textContent = css;
    document.head.appendChild(el);
  }

  // ── Setup guide modal ─────────────────────────────────────────────
  function openSetupGuide() {
    if (document.getElementById("rr-ps-modal")) return;
    const ov = document.createElement("div");
    ov.id = "rr-ps-modal";
    ov.innerHTML = `
      <div class="rr-ps-card" role="dialog" aria-modal="true" aria-label="Set up your sync box">
        <div class="rr-ps-card-head">
          <h2>Set up your sync box</h2>
          <button class="rr-ps-x" aria-label="Close">×</button>
        </div>
        <div class="rr-ps-card-body">
          <p>The <b>sync box</b> is an always-on computer that signs into your delivery portal and pulls your data into RouteReady automatically — so you don't re-key it by hand. Setup takes about 15 minutes.</p>
          <ol>
            <li><b>Get an always-on mini-PC.</b> Any small Windows mini-PC that can stay powered on 24/7 works (about $120–180). It lives at your station/office. <span style="color:#64748b">(You can also use any spare always-on Windows/Mac/Linux machine.)</span></li>
            <li><b>On that machine, install the app.</b> Open a browser on the mini-PC, go to <b>gorouteready.com/download</b>, and install RouteReady Desktop.
              <div style="margin-top:8px"><a class="rr-ps-btn ghost" href="${DOWNLOAD_URL}" target="_blank" rel="noopener">Open the download page ↗</a></div>
            </li>
            <li><b>Pair it to your account.</b> Once installed, come back to this dashboard and click <b>"Connect desktop app"</b> (bottom-right). That links the box to your RouteReady account.</li>
            <li><b>Sign into your portal once.</b> In the app, sign into your Amazon/Indeed portal with your credentials. The box securely remembers the session.</li>
            <li><b>Choose what to pull &amp; when</b> (e.g. daily at 6:00pm), and you're done — the box pulls on schedule and whenever you click <b>"Sync to portal now"</b>.</li>
          </ol>
          <div class="rr-ps-warn">First launch only: the app isn't code-signed yet, so your OS may warn you. <b>Windows:</b> "More info" → "Run anyway". <b>macOS:</b> System Settings → Privacy &amp; Security → "Open anyway".</div>
        </div>
      </div>`;
    const close = () => ov.remove();
    ov.addEventListener("click", (e) => { if (e.target === ov || e.target.closest(".rr-ps-x")) close(); });
    document.addEventListener("keydown", function onEsc(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); } });
    document.body.appendChild(ov);
  }

  // ── Install the dashboard as a PWA (reuses the header install flow) ──
  function triggerPwaInstall() {
    const hdr = document.getElementById("rr-hdr-install");
    if (hdr && !hdr.hidden) { hdr.click(); return; } // fires the existing beforeinstallprompt flow
    alert("To install the Advanced Web App (the dashboard in its own window):\n\n" +
      "• Chrome / Edge: click the install icon (a small monitor with a down-arrow) at the right end of the address bar — or open the ⋮ menu and choose “Install RouteReady”.\n" +
      "• If you don't see it, the app may already be installed.\n" +
      "• Safari (Mac): use the Share menu → “Add to Dock”.");
  }

  // Setup buttons block (shared by the settings section).
  function setupButtonsHtml() {
    return `
      <div class="rr-ps-setup">
        <button class="rr-ps-btn primary" data-rr-ps="setup">Set up sync box</button>
        <button class="rr-ps-btn ghost" data-rr-ps="pwa">Install Advanced Web App</button>
      </div>
      <div class="rr-ps-setup-sub">“Set up sync box” walks you through the always-on crawler machine. “Advanced Web App” installs this dashboard as its own desktop app (no crawler).</div>`;
  }
  function wireSetupButtons(root) {
    root.querySelectorAll('[data-rr-ps="setup"]').forEach((b) => b.addEventListener("click", openSetupGuide));
    root.querySelectorAll('[data-rr-ps="pwa"]').forEach((b) => b.addEventListener("click", triggerPwaInstall));
  }

  // ── Box health rendering ──────────────────────────────────────────
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
      return '<div class="rr-ps-empty">No sync box connected yet — use <b>“Set up sync box”</b> above to get one running.</div>';
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

  async function fetchAgents(sb) {
    const { data, error } = await sb
      .from("desktop_agents")
      .select("agent_id,label,app_version,last_heartbeat_at,portal_session_ok,last_run_at,last_run_status,last_run_error,last_run_rows")
      .order("last_heartbeat_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  function wireController(sb, els, onAfterRender) {
    async function refresh() {
      try {
        const agents = await fetchAgents(sb);
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

  // ── Settings → Portal sync section ────────────────────────────────
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
        <p class="settings-section-sub">Set up the always-on sync box that pulls your portal data into RouteReady, check its health, and trigger a pull on demand.</p>
      </div>
      ${setupButtonsHtml()}
      <div id="rr-ps-boxes"><div class="rr-ps-empty">Loading…</div></div>
      <div style="max-width:360px">
        <button class="rr-ps-btn primary" id="rr-ps-sync" style="width:100%" disabled>Sync to portal now</button>
        <div class="rr-ps-note" id="rr-ps-note"></div>
      </div>`;
    wrap.parentElement.appendChild(section);
    wireSetupButtons(section);

    const refresh = wireController(sb, {
      boxes: section.querySelector("#rr-ps-boxes"),
      btn: section.querySelector("#rr-ps-sync"),
      note: section.querySelector("#rr-ps-note"),
    });
    refresh();
    setInterval(() => { if (!section.classList.contains("hidden")) refresh(); }, REFRESH_MS);
    return true;
  }

  // ── "Finish setup" banner (new DSPs, until a box is connected) ────
  function mountBanner(sb) {
    if (localStorage.getItem("rr-ps-banner-dismissed") === "1") return;
    let banner = null;
    function build() {
      if (banner) return;
      banner = document.createElement("div");
      banner.id = "rr-ps-banner";
      banner.innerHTML = `
        <div class="rr-ps-b-text">
          <b>Finish setting up RouteReady</b>
          <span>Connect your portal sync box to pull route &amp; applicant data automatically.</span>
        </div>
        <div class="rr-ps-b-actions">
          <button class="rr-ps-b-btn solid" data-rr-ps="setup">Set up sync box</button>
          <button class="rr-ps-b-btn outline" data-rr-ps="pwa">Install Web App</button>
        </div>
        <button class="rr-ps-b-x" aria-label="Dismiss">×</button>`;
      wireSetupButtons(banner);
      banner.querySelector(".rr-ps-b-x").addEventListener("click", () => {
        localStorage.setItem("rr-ps-banner-dismissed", "1");
        banner.remove(); banner = null;
      });
      document.body.appendChild(banner);
    }
    async function tick() {
      let agents = [];
      try { agents = await fetchAgents(sb); } catch { return; } // signed out / not migrated → don't nag
      if (agents.length) { if (banner) { banner.remove(); banner = null; } return; } // box exists → hide
      build();
    }
    tick();
    setInterval(tick, 60 * 1000);
  }

  // ── Docked fallback (only if the Settings DOM isn't present) ───────
  function mountDocked(sb) {
    const dock = document.createElement("div");
    dock.id = "rr-ps-dock";
    dock.className = "rr-collapsed";
    dock.innerHTML = `
      <div class="rr-ps-dhead" id="rr-ps-dhead"><b>Portal sync</b><span id="rr-ps-dcaret">▸</span></div>
      <div class="rr-ps-body">
        ${setupButtonsHtml()}
        <div id="rr-ps-boxes"><div class="rr-ps-empty">Loading…</div></div>
        <button class="rr-ps-btn primary" id="rr-ps-sync" style="width:100%" disabled>Sync to portal now</button>
        <div class="rr-ps-note" id="rr-ps-note"></div>
      </div>`;
    document.body.appendChild(dock);
    wireSetupButtons(dock);
    const refresh = wireController(sb, {
      boxes: dock.querySelector("#rr-ps-boxes"),
      btn: dock.querySelector("#rr-ps-sync"),
      note: dock.querySelector("#rr-ps-note"),
    });
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
    mountBanner(sb);
  });
})();
