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
      window.location.href = `routeready://connect?code=${encodeURIComponent(body.code)}`;
      btn.textContent = "Opening the app…";
      setTimeout(() => reset(), 5000);
    } catch (e) {
      alert("Pairing error: " + (e && e.message || e));
      reset();
    }
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
