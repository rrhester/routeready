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
    const reset = (t) => { btn.disabled = false; btn.textContent = t || "Connect desktop app"; };
    const tok = accessToken();
    if (!tok) { alert("Please sign in first, then connect the desktop app."); return; }
    try {
      btn.disabled = true; btn.textContent = "Connecting…";
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

  // Show the one-time pairing code + a copy-paste terminal command. This is
  // what makes pairing possible on a Chromebook: run the link from inside the
  // Linux container so it reaches the desktop app.
  function showPairPanel(code, link) {
    document.getElementById("rr-pair-panel")?.remove();
    const cmd = `xdg-open "${link}"`;
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
       <div style="color:#94a3b8;margin:6px 0 2px">If the app opened and connected, you're done. <b>On a Chromebook</b> the app won't open from here — open your <b>Linux Terminal</b> and run:</div>
       ${codeBox(cmd)}
       <div style="color:#94a3b8;margin:10px 0 2px">Or paste just the code if the app asks for one:</div>
       ${codeBox(code)}
       <div style="color:#64748b;margin-top:10px;font-size:12px">The box must be running. This code is one-time and expires in a few minutes — click "Connect desktop app" again for a fresh one.</div>`;
    document.body.appendChild(wrap);
    wrap.querySelector("#rr-pair-close").addEventListener("click", () => wrap.remove());
    wrap.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(b.getAttribute("data-copy")); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1200); } catch {}
    }));
  }

  function addButton() {
    if (inDesktopApp) return;
    if (!accessToken()) return;                 // signed-in operators only
    if (document.getElementById("rr-connect-desktop")) return;
    const btn = document.createElement("button");
    btn.id = "rr-connect-desktop";
    btn.type = "button";
    btn.textContent = "Connect desktop app";
    btn.title = "Link the installed RouteReady desktop app to this account";
    btn.style.cssText = [
      "position:fixed", "right:16px", "bottom:16px", "z-index:2147483646",
      "background:#2563eb", "color:#fff", "border:0", "border-radius:10px",
      "padding:10px 14px", "font:600 13px/1 Inter,system-ui,-apple-system,sans-serif",
      "box-shadow:0 4px 14px rgba(0,0,0,.25)", "cursor:pointer",
    ].join(";");
    btn.addEventListener("click", () => mintAndOpen(btn));
    document.body.appendChild(btn);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addButton);
  else addButton();
})();
