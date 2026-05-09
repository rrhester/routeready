// RouteReady · Platform admin surface
//
// Cross-tenant DSP account management.  Only users with role
// 'platform_admin' (granted via 0124_platform_admin.sql + bootstrap SQL)
// are allowed past the auth gate; everyone else gets bounced back to
// the regular dispatcher dashboard.
//
// Phase 2 (this file): auth gate, top bar wiring, stats overview cards.
// Phase 3: search/filter/sort table, CSV export.
// Phase 4: Add-DSP modal, Manage-Users slide-over, toasts, confirms.

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const cfg = window.RR_CONFIG;
if (!cfg) throw new Error("RR_CONFIG missing — load config.js before admin.js");

const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
window.RR_ADMIN = { sb, user: null };

// ── Toast helper ──────────────────────────────────────────────────
// Lightweight stacked notifications for success / error feedback.
// Auto-dismisses after a few seconds; no dependency on toastify-style
// libs so admin.js stays a single small module.
function toast(message, kind = "info", ttlMs = 4500) {
  const stack = document.getElementById("rr-admin-toasts");
  if (!stack) return;
  const el = document.createElement("div");
  el.className = "toast" + (kind === "err" ? " toast--err" : kind === "ok" ? " toast--ok" : "");
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity 200ms ease, transform 200ms ease";
    el.style.opacity = "0";
    el.style.transform = "translateY(4px)";
    setTimeout(() => el.remove(), 220);
  }, ttlMs);
}

// ── Force-relogin helper ─────────────────────────────────────────
// Same shape as the dispatcher dashboard's _forceRelogin (PR #602):
// when a JWT is rejected mid-session, clean up and bounce to login
// with a clear error code instead of leaving a half-broken UI.
function forceRelogin(reason) {
  const next = encodeURIComponent(location.pathname + location.search);
  try { sb.auth.signOut().catch(() => {}); } catch {}
  try { localStorage.clear(); sessionStorage.clear(); } catch {}
  location.replace(`./login.html?err=${encodeURIComponent(reason || "session_expired")}&next=${next}`);
  throw new Error(`force relogin: ${reason}`);
}
function isAuthError(err) {
  if (!err) return false;
  if (err.status === 401 || err.status === 403) return true;
  if (err.code === "PGRST301") return true;
  const m = (err.message || "").toLowerCase();
  return /jwt|unauthor|expired/.test(m);
}

// ── Auth gate ────────────────────────────────────────────────────
// 1. Confirm session exists (else login).
// 2. Load app_users row and verify role === 'platform_admin'.
// 3. Anything else → bounce to /dashboard/index.html.
const { data: { session } } = await sb.auth.getSession();
if (!session) {
  const next = encodeURIComponent(location.pathname + location.search);
  location.replace(`./login.html?next=${next}`);
  throw new Error("redirecting to login");
}

const { data: profile, error: profileErr } = await sb.from("app_users")
  .select("id, dsp_id, email, full_name, role, active")
  .eq("id", session.user.id)
  .maybeSingle();

if (profileErr) {
  if (isAuthError(profileErr)) forceRelogin("session_expired");
  console.error("admin profile load failed:", profileErr);
  forceRelogin("profile_load_failed");
}
if (!profile) {
  await sb.auth.signOut();
  location.replace("./login.html?err=no_profile");
  throw new Error("no app_users row");
}
if (profile.role !== "platform_admin" || !profile.active) {
  // Not a platform admin — kick them back to the regular dashboard.
  // The regular dashboard's auth gate will handle anything else.
  location.replace("./index.html");
  throw new Error("not platform admin");
}

window.RR_ADMIN.user = profile;

// Auth-state listener · same pattern as live.js.
sb.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT") forceRelogin("session_expired");
});

// Reveal the page now that auth has cleared.
document.body.dataset.rrGate = "ready";

// ── Top bar wiring ───────────────────────────────────────────────
document.getElementById("rr-admin-email").textContent =
  profile.full_name ? `${profile.full_name} (${profile.email})` : profile.email;

document.getElementById("rr-admin-signout").addEventListener("click", async () => {
  try {
    await sb.auth.signOut();
  } catch (e) {
    // signOut errors are non-fatal here; we're navigating away regardless.
  }
  location.replace("./login.html");
});

// ── Stats overview ───────────────────────────────────────────────
// admin_kpis() returns { total, active, pending, suspended }.  RPC is
// SECURITY DEFINER and re-checks role inside the function body, so
// any PostgREST client with EXECUTE on the function works — we don't
// need a separate is-admin grant on the table layer.
async function loadStats() {
  const { data, error } = await sb.rpc("admin_kpis");
  if (error) {
    if (isAuthError(error)) forceRelogin("session_expired");
    console.error("admin_kpis failed:", error);
    toast(`Couldn't load stats: ${error.message}`, "err", 8000);
    // Show em-dash placeholders so the cards don't sit on skeletons forever.
    document.querySelectorAll("[data-rr-stat-value]").forEach((el) => { el.textContent = "—"; });
    return;
  }
  paintStats(data || {});
}

function paintStats(kpis) {
  const map = {
    total:     kpis.total ?? 0,
    active:    kpis.active ?? 0,
    pending:   kpis.pending ?? 0,
    suspended: kpis.suspended ?? 0,
  };
  for (const [key, value] of Object.entries(map)) {
    const card = document.querySelector(`[data-rr-stat="${key}"]`);
    if (!card) continue;
    const slot = card.querySelector("[data-rr-stat-value]");
    if (!slot) continue;
    slot.textContent = String(value);
  }
}

// ── Placeholder CTAs · real wiring lands in Phase 4 ──────────────
document.getElementById("rr-admin-add-dsp").addEventListener("click", () => {
  toast("Add-DSP modal lands in Phase 4.", "info");
});
document.getElementById("rr-admin-invite-user").addEventListener("click", () => {
  toast("Invite-user flow lands in Phase 4.", "info");
});

// ── Boot ─────────────────────────────────────────────────────────
loadStats();
