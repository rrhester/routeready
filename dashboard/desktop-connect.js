// Desktop "Connect from browser" pairing (Option B).
//
// Two jobs:
//   1. window.__rrApplySession(accessToken, refreshToken) — the installed
//      desktop app calls this (via the routeready:// redeem flow) to sign
//      THIS window in once it has a session. We just hand the tokens to
//      Supabase and land on the dashboard.
//   2. A "Connect desktop app" button (browser only, signed-in operators) —
//      mints a one-time pairing code from the desktop-pair function and opens
//      routeready://connect?code=… so the installed app can redeem it.
//
// Self-contained: it makes its own Supabase client, which shares the stored
// session with the dashboard's client (same project ⇒ same storage key), so
// getSession()/setSession() here are the same session the dashboard uses.

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const cfg = window.RR_CONFIG || {};
const FUNCTIONS_BASE = String(cfg.SUPABASE_URL || "").replace(/\/+$/, "") + "/functions/v1";

const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

// ── Called by the desktop app after it redeems a pairing code ──────
window.__rrApplySession = async (accessToken, refreshToken) => {
  try {
    const { error } = await sb.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    if (error) { console.warn("[rr-pair] setSession failed:", error.message); return false; }
    // Land on the authenticated dashboard (works whether we were on the
    // login page or already in the app shell).
    location.replace("./index.html");
    return true;
  } catch (e) {
    console.warn("[rr-pair] applySession threw:", e);
    return false;
  }
};

// ── "Connect desktop app" button (browser, signed-in only) ─────────
const inDesktopApp = !!(window.routeready && window.routeready.isDesktop);

async function mintAndOpen(btn) {
  const reset = (txt) => { btn.disabled = false; btn.textContent = txt || "Connect desktop app"; };
  try {
    btn.disabled = true; btn.textContent = "Connecting…";
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { alert("Please sign in first, then connect the desktop app."); reset(); return; }
    const res = await fetch(`${FUNCTIONS_BASE}/desktop-pair`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ action: "mint" }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.code) { alert("Couldn't start pairing: " + (body.error || ("HTTP " + res.status))); reset(); return; }
    // Hand the one-time code to the installed desktop app.
    window.location.href = `routeready://connect?code=${encodeURIComponent(body.code)}`;
    btn.textContent = "Opening the app…";
    setTimeout(() => reset(), 5000);
  } catch (e) {
    alert("Pairing error: " + (e && e.message || e));
    reset();
  }
}

async function maybeAddButton() {
  if (inDesktopApp) return;                       // already the app
  if (document.getElementById("rr-connect-desktop")) return;
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;                          // signed-in operators only
  } catch { return; }
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

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", maybeAddButton);
else maybeAddButton();
