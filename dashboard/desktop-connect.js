// Desktop "Connect from browser" — the dashboard-side Connect button.
//
// IMPORTANT: this script creates NO Supabase client (a second client broke
// sign-in once). It only reads the already-stored session token from
// localStorage to mint a pairing code, and opens routeready://connect?code=…
// so the installed desktop app can redeem it. The session-setting side lives
// in login.html, reusing that page's existing client.
(() => {
  const cfg = window.RR_CONFIG || {};
  const url = String(cfg.SUPABASE_URL || "");
  const ref = (url.match(/^https?:\/\/([^.]+)\./) || [])[1];
  if (!ref) return;
  const FUNCTIONS_BASE = url.replace(/\/+$/, "") + "/functions/v1";
  const STORAGE_KEY = `sb-${ref}-auth-token`;

  // Read the current access token straight from supabase-js's stored session
  // (handles both the flat and the legacy { currentSession } shapes).
  function accessToken() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      return p.access_token || (p.currentSession && p.currentSession.access_token) || null;
    } catch { return null; }
  }

  // Inside the desktop app there's nothing to connect — hide the button.
  const inDesktopApp = !!(window.routeready && window.routeready.isDesktop);

  async function mintAndOpen(btn) {
    // The button is a quiet sidebar-footer icon — busy/idle is conveyed
    // via disabled state + title, never textContent (which would wipe
    // the icon).
    const reset = () => { btn.disabled = false; btn.title = BTN_TITLE; };
    const tok = accessToken();
    if (!tok) { alert("Please sign in first, then connect the desktop app."); return; }
    try {
      btn.disabled = true; btn.title = "Connecting…";
      const res = await fetch(`${FUNCTIONS_BASE}/desktop-pair`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
        body: JSON.stringify({ action: "mint" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.code) { alert("Couldn't start pairing: " + (body.error || ("HTTP " + res.status))); reset(); return; }
      const link = `routeready://connect?code=${encodeURIComponent(body.code)}`;
      // On Windows/Mac the OS hands this link to the installed app. It's a
      // no-op on ChromeOS (the link can't cross from Chrome into the Linux
      // container), so we ALSO show the code + a manual terminal command.
      try { window.location.href = link; } catch {}
      showPairPanel(body.code, link);
      reset();
    } catch (e) {
      alert("Pairing error: " + (e && e.message || e));
      reset();
    }
  }

  // Show the one-time connect key to paste into the desktop app's "Connect
  // key" field. (No terminal, no deep link — the app reads the key directly.)
  function showPairPanel(code, link) {
    document.getElementById("rr-pair-panel")?.remove();
    const wrap = document.createElement("div");
    wrap.id = "rr-pair-panel";
    wrap.style.cssText = [
      "position:fixed", "right:16px", "bottom:64px", "z-index:2147483647",
      "width:380px", "max-width:calc(100vw - 32px)",
      "background:#0f172a", "color:#e5e7eb", "border:1px solid #334155",
      "border-radius:12px", "padding:14px 16px",
      "font:13px/1.45 Inter,system-ui,-apple-system,sans-serif",
      "box-shadow:0 10px 30px rgba(0,0,0,.45)",
    ].join(";");
    const codeBox = (txt) =>
      `<div style="display:flex;gap:6px;align-items:center;margin-top:4px">
         <code style="flex:1;background:#020617;border:1px solid #334155;border-radius:6px;padding:7px 9px;white-space:nowrap;overflow:auto;color:#93c5fd">${txt.replace(/</g, "&lt;")}</code>
         <button data-copy="${txt.replace(/"/g, "&quot;")}" style="background:#2563eb;border:0;color:#fff;border-radius:6px;padding:7px 10px;cursor:pointer;font-weight:600">Copy</button>
       </div>`;
    wrap.innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:center">
         <b style="font-size:14px">Connect your desktop box</b>
         <button id="rr-pair-close" style="background:transparent;border:0;color:#94a3b8;font-size:18px;cursor:pointer;line-height:1">×</button>
       </div>
       <div style="color:#94a3b8;margin:6px 0 2px">Copy this key, then paste it into the desktop app's <b>“Connect key”</b> box and click <b>Connect</b>. You only do this once.</div>
       ${codeBox(code)}
       <div style="color:#64748b;margin-top:10px;font-size:12px">The box must be running. This key is one-time and good for 24 hours — click "Connect desktop app" again for a fresh one if needed.</div>`;
    document.body.appendChild(wrap);
    wrap.querySelector("#rr-pair-close").addEventListener("click", () => wrap.remove());
    wrap.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(b.getAttribute("data-copy")); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1200); } catch {}
    }));
  }

  const BTN_TITLE = "Connect desktop app — link the installed RouteReady app to this account";

  function addButton() {
    if (inDesktopApp) return;
    if (!accessToken()) return;                 // signed-in operators only
    if (document.getElementById("rr-connect-desktop")) return;
    const btn = document.createElement("button");
    btn.id = "rr-connect-desktop";
    btn.type = "button";
    btn.title = BTN_TITLE;
    btn.setAttribute("aria-label", "Connect desktop app");
    // Cohesion pass · lives in the sidebar footer as a quiet icon
    // button (reusing the theme/collapse button cosmetics) instead of
    // a permanent floating pill covering page content bottom-right.
    const foot = document.querySelector(".sidebar-foot");
    if (foot) {
      btn.className = "sidebar-theme-btn";
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
      foot.insertBefore(btn, foot.firstChild);
    } else {
      // Fallback (no sidebar in DOM for some reason): the old pill.
      btn.textContent = "Connect desktop app";
      btn.style.cssText = [
        "position:fixed", "right:16px", "bottom:16px", "z-index:2147483646",
        "background:#2563eb", "color:#fff", "border:0", "border-radius:8px",
        "padding:10px 14px", "font:600 13px/1 Inter,system-ui,-apple-system,sans-serif",
        "box-shadow:0 1px 2px rgba(15,23,42,.15)", "cursor:pointer",
      ].join(";");
      document.body.appendChild(btn);
    }
    btn.addEventListener("click", () => mintAndOpen(btn));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addButton);
  else addButton();
})();
