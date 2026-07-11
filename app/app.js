// RouteReady Driver PWA · client logic
//
// v1 scope: app shell + invite-code login (stubbed for now) + tabbed
// navigation with placeholder screens. Real auth + data + chat land in
// follow-up PRs. The structure here is intentionally light — single
// file, hash routing, no framework. Add a router/state lib only when
// the feature set forces it.

// supabase-js is vendored same-origin (scripts: npm i @supabase/supabase-js
// && esbuild --bundle) — the old https://esm.sh import was the one cross-
// origin module in the shell, so even a fully-cached PWA died at module
// resolution when launched offline.
import { createClient } from "./vendor/supabase-js.mjs";
import { validateFormAnswer as _validateFormAnswer } from "./form-validation.js";

const cfg = window.RR_CONFIG;
if (!cfg || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
  // ../dashboard/config.js failed to load or is incomplete (404 while a
  // deploy shuffles files, blocked request, rename). Without this guard
  // the createClient line below threw at the top of the module and the
  // driver sat on the boot spinner forever with no signal why. Show a
  // calm, retryable screen instead — styles.css is already on the page.
  const app = document.getElementById("app");
  if (app) {
    app.innerHTML = `
      <div class="login-screen">
        <div class="brand"><div class="brand-icon"><img src="Icon.png" alt="RouteReady"></div></div>
        <div class="empty-state" style="max-width:280px;text-align:center;line-height:1.55">
          Couldn't start the app.<br><br>
          <span style="color:var(--text-subtle)">Check your connection, then try again. If this keeps happening, contact dispatch.</span><br><br>
          <button class="btn btn-primary" id="rr-boot-retry" style="width:auto;padding:0 24px">Try again</button>
        </div>
      </div>`;
    document.getElementById("rr-boot-retry")?.addEventListener("click", () => location.reload());
  }
  throw new Error("RR_CONFIG missing — dashboard/config.js failed to load");
}
const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, storageKey: "rr.driver.auth" },
});
window.RR_DRIVER = { sb, driver: null };

// ── Preview mode ────────────────────────────────────────────────────
// A dispatcher can open this app *inside the dashboard* (in a phone-shaped
// frame) to see exactly what a given driver sees, for troubleshooting. The
// dashboard mints a short-lived preview token (driver_preview_token RPC) and
// loads us at ?preview=<token>. In that mode the session lives in memory
// only (never persisted to localStorage), the service worker / push are not
// touched, and every write RPC + storage upload is short-circuited so the
// preview can look at everything but can't act as the driver.
const PREVIEW_TOKEN = (() => { try { return new URLSearchParams(location.search).get("preview") || null; } catch { return null; } })();
const PREVIEW = !!PREVIEW_TOKEN;
let _previewSession = null;
// Driver-app preview sessions are fully interactive (operator opted in):
// the dispatcher's in-frame driver app writes through to the real driver
// record exactly as the driver's own app would — no RPC or storage blocking.
// NOTE: this means dispatcher-performed acknowledgements / e-signatures / I-9
// submissions persist under the driver's identity. Kept intentionally per
// product direction; revert this block to restore the read-only preview.

// ── Service worker registration ─────────────────────────────────────
if ("serviceWorker" in navigator && !PREVIEW) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js")
      .then((reg) => {
        syncSwSession(readSession());
        // Force the SW to check for an updated sw.js on every load.
        // iOS otherwise holds onto a stale SW for 24h+, which leaves
        // home-screen PWA installs stuck on whatever SW shipped at
        // install time.
        try { reg.update(); } catch (_) {}
      })
      .catch((err) => console.warn("SW reg failed:", err));
  });
}

// ── On-screen keyboard tracking ─────────────────────────────────────
// iOS Safari's layout viewport doesn't shrink when the soft keyboard
// rises, so a `position:absolute; bottom:0` composer disappears under
// the keys. Mirror visualViewport.height into a --rr-kbd CSS variable
// and let the layout (main, chat) subtract it so the input always
// stays visible. Mobile Safari fires `resize` and `scroll` on the
// visualViewport when the keyboard opens/closes — we listen to both.
if (typeof window !== "undefined" && window.visualViewport) {
  const vv = window.visualViewport;
  const updateKeyboard = () => {
    const kbd = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty("--rr-kbd", kbd + "px");
  };
  vv.addEventListener("resize", updateKeyboard);
  vv.addEventListener("scroll", updateKeyboard);
  updateKeyboard();
}

// ── Push notifications + home-screen badge ──────────────────────────
// We send the driver's session token + Supabase config to the service
// worker so it can fetch fresh chat data (preview + unread count) when
// a payloadless push arrives. Permission is requested the first time
// the user opens the Chat tab — that's the moment the value is obvious.
async function syncSwSession(session) {
  if (PREVIEW) return;
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sw = reg.active || navigator.serviceWorker.controller;
    if (!sw) return;
    if (session?.token) {
      sw.postMessage({
        type: "rr:set-session",
        token: session.token,
        supabaseUrl: cfg.SUPABASE_URL,
        anonKey: cfg.SUPABASE_ANON_KEY,
      });
    } else {
      sw.postMessage({ type: "rr:clear-session" });
    }
  } catch {}
}

function setAppBadge(n, source) {
  if ("setAppBadge" in navigator) {
    if (n > 0) navigator.setAppBadge(n).catch(() => {});
    else navigator.clearAppBadge().catch(() => {});
  }
  // Also ask the SW to clear — on iOS PWAs the badge set from inside the
  // SW push handler won't reliably clear when called from the page, so
  // we fire clearAppBadge from both contexts. Wait on serviceWorker.ready
  // so the postMessage doesn't no-op when the SW isn't yet controlling.
  if (n <= 0 && "serviceWorker" in navigator) {
    navigator.serviceWorker.ready.then((reg) => {
      const sw = reg.active || navigator.serviceWorker.controller;
      sw?.postMessage({ type: "rr:clear-badge", source: source || "page" });
    }).catch(() => {});
  }
}

// In-app unread badge on the Chat tab in the bottom nav. The OS-level
// app icon badge above only shows when the app isn't focused; the
// tab badge is what the driver sees while they're inside the app and
// haven't tapped the Chat tab yet. We compute the count from the
// per-message is_unread flag driver_chat_list already returns.
function _setChatTabBadge(n) {
  document.querySelectorAll('.tab[data-c="chat"]').forEach((tab) => {
    let ic = tab.querySelector(".tab-ic");
    if (!ic) return;
    let badge = ic.querySelector(".rr-tab-badge");
    if (n > 0) {
      // Position the icon's parent so the badge can absolutely-position
      // over the top-right corner of the glyph.
      if (getComputedStyle(ic).position === "static") ic.style.position = "relative";
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "rr-tab-badge";
        badge.style.cssText = "position:absolute;top:-4px;right:-8px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#dc2626;color:#fff;font-size:10px;font-weight:700;line-height:16px;text-align:center;box-shadow:0 0 0 2px var(--bg, #fff);box-sizing:border-box";
        ic.appendChild(badge);
      }
      badge.textContent = n > 99 ? "99+" : String(n);
    } else if (badge) {
      badge.remove();
    }
  });
}

async function refreshChatBadge() {
  if (PREVIEW) return;
  const session = readSession();
  if (!session?.token) { _setChatTabBadge(0); return; }
  try {
    const { data, error } = await sb.rpc("driver_chat_list", { p_token: session.token, p_limit: 50 });
    if (error) return;
    const messages = data?.messages || [];
    const unread = messages.reduce((n, m) => n + (m.is_unread ? 1 : 0), 0);
    _setChatTabBadge(unread);
    setAppBadge(unread, "chat-badge");
  } catch {}
}

// In-app badge on the Tasks tab · a single count that sums everything
// waiting for the driver there: pending (unacknowledged) coachings plus
// open checklists. Forms + Checklists used to be two separate bottom-nav
// tabs each with their own badge; now they're one "Tasks" hub, so the
// two counters below feed one badge painter and can't clobber each other.
let _tasksBadgeCoaching = 0;
let _tasksBadgeChecklists = 0;
function _paintTasksTabBadge() {
  const n = (_tasksBadgeCoaching || 0) + (_tasksBadgeChecklists || 0);
  document.querySelectorAll('.tab[data-c="tasks"]').forEach((tab) => {
    const ic = tab.querySelector(".tab-ic");
    if (!ic) return;
    let badge = ic.querySelector(".rr-tab-badge");
    if (n > 0) {
      if (getComputedStyle(ic).position === "static") ic.style.position = "relative";
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "rr-tab-badge";
        badge.style.cssText = "position:absolute;top:-4px;right:-8px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#dc2626;color:#fff;font-size:10px;font-weight:700;line-height:16px;text-align:center;box-shadow:0 0 0 2px var(--bg, #fff);box-sizing:border-box";
        ic.appendChild(badge);
      }
      badge.textContent = n > 99 ? "99+" : String(n);
    } else if (badge) {
      badge.remove();
    }
  });
}
// Coaching count → Tasks tab badge.
function _setFormsTabBadge(n) { _tasksBadgeCoaching = n || 0; _paintTasksTabBadge(); }

async function refreshFormsBadge() {
  if (PREVIEW) return;
  const session = readSession();
  if (!session?.token) { _setFormsTabBadge(0); return; }
  try {
    // driver_list_coachings already returns only pending (unacknowledged)
    // rows server-side, so its length is the "new Coaching" count.
    const { data, error } = await sb.rpc("driver_list_coachings", { p_token: session.token });
    if (error) return;
    _setFormsTabBadge(Array.isArray(data) ? data.length : 0);
  } catch {}
}

// Any time the driver app becomes visible (open from home screen, tab
// focus, etc.) drop the badge to zero on the server side too — the
// driver is clearly looking at the app, so unread should reset.
async function clearBadgeOnFocus() {
  if (PREVIEW) return;
  // Only clear the chat-related badges if the driver is actively
  // looking at the Chat tab. If they're sitting on Tasks or Schedule,
  // refresh the badge so any new dispatch messages still show a count
  // — clearing here was the old behavior, but it hid the welcome
  // message badge from a fresh-activation driver who never opened
  // Chat. Mark-read still fires when the chat screen itself renders.
  if (currentRoute() === "/chat") {
    setAppBadge(0);
    _setChatTabBadge(0);
    const session = readSession();
    if (session?.token) {
      try { await sb.rpc("driver_chat_mark_read", { p_token: session.token }); } catch {}
    }
  } else {
    refreshChatBadge();
    refreshFormsBadge();
  }
}
if (typeof window !== "undefined") {
  window.addEventListener("focus",  clearBadgeOnFocus);
  window.addEventListener("pageshow", clearBadgeOnFocus);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) clearBadgeOnFocus();
  });
}

function urlBase64ToUint8Array(b64url) {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

let _pushAttempted = false;
async function ensurePushSubscription(session, { interactive = false } = {}) {
  if (PREVIEW) return;
  if (!("serviceWorker" in navigator)) return;
  if (!("PushManager" in window) || !("Notification" in window)) return;
  if (Notification.permission === "denied") return;
  if (!session?.token) return;

  if (Notification.permission === "default") {
    // Only ask inside a real user gesture (the "Turn on" button in Chat).
    // iOS rejects requestPermission() outside transient activation, and
    // the old automatic ask latched _pushAttempted on that silent failure,
    // blocking push for the whole session.
    if (!interactive) return;
    const perm = await Notification.requestPermission().catch(() => "default");
    if (perm !== "granted") return;
  }
  // Permission granted — subscribe/register once per session.
  if (_pushAttempted) return;
  _pushAttempted = true;

  let reg;
  try { reg = await navigator.serviceWorker.ready; } catch { return; }

  let sub = await reg.pushManager.getSubscription().catch(() => null);
  if (!sub) {
    const { data: vapidKey } = await sb.rpc("driver_push_vapid_key");
    if (!vapidKey) return; // Server not configured yet — silently skip.
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
    } catch (err) {
      console.warn("Push subscribe failed:", err);
      return;
    }
  }

  const json = sub.toJSON();
  const { error } = await sb.rpc("driver_push_register", {
    p_token:      session.token,
    p_endpoint:   sub.endpoint,
    p_p256dh:     json.keys?.p256dh,
    p_auth:       json.keys?.auth,
    p_user_agent: navigator.userAgent || null,
  });
  if (error) console.warn("driver_push_register failed:", error.message);
}

// Slim, dismissible "Turn on notifications" strip above the chat scroller.
// Notification.requestPermission() must run inside a user gesture on iOS,
// so the ask lives on this button instead of firing automatically at render.
function _mountPushNudge(session) {
  if (PREVIEW) return;
  if (!("PushManager" in window) || !("Notification" in window)) return;
  if (Notification.permission !== "default") {
    // Already granted → make sure the subscription is registered server-side.
    if (Notification.permission === "granted") ensurePushSubscription(session);
    return;
  }
  let dismissed = false;
  try { dismissed = !!sessionStorage.getItem("rr.pushNudgeDismissed"); } catch {}
  if (dismissed) return;
  const msgs = document.getElementById("chat-msgs");
  if (!msgs || document.getElementById("chat-push-nudge")) return;
  const el = document.createElement("div");
  el.id = "chat-push-nudge";
  el.className = "chat-push-nudge";
  el.innerHTML = `
    <span class="chat-push-nudge-txt">Get notified when dispatch messages you</span>
    <button type="button" class="btn btn-primary btn-sm" id="chat-push-on">Turn on</button>
    <button type="button" class="chat-push-nudge-x" aria-label="Dismiss">×</button>`;
  msgs.parentElement.insertBefore(el, msgs);
  el.querySelector("#chat-push-on").addEventListener("click", async () => {
    await ensurePushSubscription(session, { interactive: true });
    if (Notification.permission === "granted") {
      toast("Notifications on", "ok");
      el.remove();
    } else if (Notification.permission === "denied") {
      toast("Notifications are blocked in your phone's settings", "warn");
      el.remove();
    }
  });
  el.querySelector(".chat-push-nudge-x").addEventListener("click", () => {
    try { sessionStorage.setItem("rr.pushNudgeDismissed", "1"); } catch {}
    el.remove();
  });
}

async function teardownPushSubscription(session) {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      if (session?.token) {
        try { await sb.rpc("driver_push_unregister", { p_token: session.token, p_endpoint: sub.endpoint }); } catch {}
      }
      try { await sub.unsubscribe(); } catch {}
    }
  } catch {}
  setAppBadge(0);
}

// ── Local session state ─────────────────────────────────────────────
// For v1 the "session" is a single localStorage entry holding the
// driver's id + display name. Real auth (invite code → SMS verify →
// long-lived Supabase session) lands in PR 2; this just lets the user
// install the app and feel the layout.
const SESSION_KEY = "rr.driver.session";
// ═══════════════════════════════════════════════════════════════════
// Interaction primitives — bottom sheets, pull-to-refresh, haptics,
// scroll-aware header, and directional page transitions. These are
// the behavioral spine that makes the app feel native rather than
// "a web view in a frame". Each primitive is tiny and stateless;
// renderers wire them in via the helper APIs below.
// ═══════════════════════════════════════════════════════════════════

// ── Haptics ─────────────────────────────────────────────────────
// Web Vibration API is supported on Android Chrome / Firefox, no-op
// on iOS Safari. We still call it everywhere — the no-op cost is
// zero and the value lands the moment a driver is on Android. Kinds
// roughly map to "what just happened":
//   tap     — light feedback for a confirmed tap
//   select  — same as tap, used on toggles / chips
//   success — slightly longer pulse for a completed action
//   warn    — double-tap pulse for a denied / failed action
//   strong  — full confirmation (check-in done, message sent)
function _haptic(kind) {
  try {
    if (!navigator.vibrate) return;
    const pat = (
      kind === "tap"     ? 8 :
      kind === "select"  ? 6 :
      kind === "success" ? 14 :
      kind === "warn"    ? [12, 60, 12] :
      kind === "strong"  ? [16, 30, 22] :
      10
    );
    navigator.vibrate(pat);
  } catch (_) { /* feature missing — silent */ }
}

// ── Bottom sheet primitive ──────────────────────────────────────
// One DOM root is created lazily on first open() and reused. The
// sheet body accepts arbitrary HTML; the .rr-sheet-actions area
// is for action buttons whose handlers resolve the open() promise.
// Drag-to-dismiss: touch on the handle or above scrollTop=0 of the
// body pans the sheet down; releasing past 25% of its height OR
// with downward velocity fires close().
let _sheetRoot = null;
let _sheetResolve = null;
let _sheetEscBound = false;
function _ensureSheetRoot() {
  if (_sheetRoot) return _sheetRoot;
  _sheetRoot = document.createElement("div");
  _sheetRoot.className = "rr-sheet-root";
  _sheetRoot.innerHTML = `
    <div class="rr-sheet-backdrop" data-rr-sheet-close></div>
    <section class="rr-sheet" role="dialog" aria-modal="true">
      <div class="rr-sheet-handle" aria-hidden="true"></div>
      <div class="rr-sheet-body" id="rr-sheet-body"></div>
      <div class="rr-sheet-actions" id="rr-sheet-actions"></div>
    </section>`;
  document.body.appendChild(_sheetRoot);
  _sheetRoot.addEventListener("click", (e) => {
    if (e.target.matches("[data-rr-sheet-close]")) _closeSheet(null);
  });
  // Drag-to-dismiss wiring.
  const sheet = _sheetRoot.querySelector(".rr-sheet");
  let startY = 0, currentY = 0, lastY = 0, lastT = 0, vel = 0, dragging = false;
  const onDown = (e) => {
    // Only drag if the touch started on the handle, the title area,
    // or while the body is scrolled to its top. Otherwise let the
    // body scroll normally.
    const body = _sheetRoot.querySelector(".rr-sheet-body");
    const onHandle = e.target.closest(".rr-sheet-handle") != null;
    const bodyAtTop = body && body.scrollTop <= 0;
    const onActions = e.target.closest(".rr-sheet-actions") != null;
    if (!onHandle && !bodyAtTop) return;
    if (onActions) return; // never start a drag from inside the actions row
    const t = e.touches ? e.touches[0] : e;
    startY = t.clientY; currentY = startY; lastY = startY; lastT = performance.now();
    dragging = true;
    _sheetRoot.classList.add("dragging");
  };
  const onMove = (e) => {
    if (!dragging) return;
    const t = e.touches ? e.touches[0] : e;
    currentY = t.clientY;
    const dy = Math.max(0, currentY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
    const now = performance.now();
    const dt = Math.max(1, now - lastT);
    vel = (currentY - lastY) / dt; // px/ms
    lastY = currentY; lastT = now;
    // Fade backdrop with travel.
    const h = sheet.offsetHeight || 1;
    const op = Math.max(.15, 1 - (dy / h));
    _sheetRoot.querySelector(".rr-sheet-backdrop").style.opacity = String(op);
    if (e.cancelable) e.preventDefault();
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    _sheetRoot.classList.remove("dragging");
    const dy = Math.max(0, currentY - startY);
    const h = sheet.offsetHeight || 1;
    const fast = vel > 0.6;          // px/ms downward
    const far  = dy > h * 0.28;      // 28% of height
    sheet.style.transform = "";
    _sheetRoot.querySelector(".rr-sheet-backdrop").style.opacity = "";
    if (fast || far) _closeSheet(null);
  };
  sheet.addEventListener("touchstart", onDown, { passive: true });
  sheet.addEventListener("touchmove",  onMove, { passive: false });
  sheet.addEventListener("touchend",   onUp);
  sheet.addEventListener("touchcancel", onUp);
  return _sheetRoot;
}
// Hardware/browser Back closes an open sheet instead of navigating the
// page underneath it — the sheet is this app's confirm() for destructive
// actions, so Back-while-open must read as "dismiss", not "leave screen".
// openSheet pushes a same-URL history entry; popping it (Back) closes the
// sheet, and closing by any other means consumes the entry via
// history.back() with the flag cleared first so the popstate is a no-op.
let _sheetPopArmed = false;
window.addEventListener("popstate", () => {
  if (!_sheetPopArmed) return;
  _sheetPopArmed = false;
  if (_sheetRoot?.classList.contains("open")) _closeSheet(null);
});

let _sheetReturnFocus = null;
function _closeSheet(value) {
  try { document.getElementById("app")?.removeAttribute("inert"); } catch {}
  if (_sheetPopArmed) { _sheetPopArmed = false; try { history.back(); } catch {} }
  if (!_sheetRoot) { if (_sheetResolve) { _sheetResolve(value); _sheetResolve = null; } return; }
  _sheetRoot.classList.remove("open");
  const resolver = _sheetResolve;
  const returnTo = _sheetReturnFocus;
  _sheetResolve = null;
  _sheetReturnFocus = null;
  setTimeout(() => {
    if (_sheetRoot && !_sheetRoot.classList.contains("open")) {
      _sheetRoot.querySelector(".rr-sheet-body").innerHTML = "";
      _sheetRoot.querySelector(".rr-sheet-actions").innerHTML = "";
    }
    if (resolver) resolver(value);
    // Return focus to the element that opened the sheet so keyboard
    // / assistive users don't lose their place.
    if (returnTo && document.contains(returnTo)) {
      try { returnTo.focus({ preventScroll: true }); } catch {}
    }
  }, 320);
}
function openSheet({ title = "", body = "", actions = [] } = {}) {
  // actions: [{ label, kind: "primary"|"danger"|"ghost", value, autofocus }]
  // Returns a Promise that resolves with the chosen action's `value`,
  // or null if the user dismissed without choosing.
  const root = _ensureSheetRoot();
  const bodyEl = root.querySelector("#rr-sheet-body");
  const actEl  = root.querySelector("#rr-sheet-actions");
  bodyEl.innerHTML = `
    ${title ? `<div class="rr-sheet-title" id="rr-sheet-title">${escapeHtml(title)}</div>` : ""}
    ${typeof body === "string" ? body : ""}`;
  // Name the dialog for assistive tech, and freeze the page behind it so
  // Tab / screen-reader focus can't wander into obscured content.
  const dialogEl = root.querySelector(".rr-sheet");
  if (title) { dialogEl.setAttribute("aria-labelledby", "rr-sheet-title"); dialogEl.removeAttribute("aria-label"); }
  else { dialogEl.setAttribute("aria-label", "Menu"); dialogEl.removeAttribute("aria-labelledby"); }
  try { document.getElementById("app")?.setAttribute("inert", ""); } catch {}
  if (!_sheetPopArmed) {
    try { history.pushState({ rrSheet: true }, ""); _sheetPopArmed = true; } catch {}
  }
  actEl.innerHTML = actions.map((a, i) => {
    const cls = a.kind === "primary" ? "btn btn-primary" :
                a.kind === "danger"  ? "btn btn-danger" :
                a.kind === "ghost"   ? "btn btn-ghost"  : "btn";
    return `<button type="button" class="${cls}" data-rr-sheet-idx="${i}"${a.autofocus ? " data-autofocus" : ""}>${escapeHtml(a.label)}</button>`;
  }).join("");
  if (typeof body !== "string" && body instanceof Node) bodyEl.appendChild(body);
  return new Promise((resolve) => {
    _sheetResolve = resolve;
    _sheetReturnFocus = document.activeElement;
    actEl.querySelectorAll("[data-rr-sheet-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const a = actions[+btn.dataset.rrSheetIdx];
        _haptic(a?.kind === "danger" ? "warn" : "tap");
        _closeSheet(a?.value ?? null);
      });
    });
    // Open on next frame so the entry transition plays from the
    // off-screen starting state.
    requestAnimationFrame(() => {
      root.classList.add("open");
      const fb = actEl.querySelector("[data-autofocus]");
      if (fb) fb.focus({ preventScroll: true });
    });
    if (!_sheetEscBound) {
      _sheetEscBound = true;
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && _sheetRoot?.classList.contains("open")) _closeSheet(null);
      });
    }
  });
}
// Native-feeling confirm. Drop-in replacement for window.confirm().
//   const ok = await confirmSheet({ title, message, confirmText, danger });
function confirmSheet({ title = "Confirm", message = "", confirmText = "Confirm", cancelText = "Cancel", danger = false } = {}) {
  return openSheet({
    title,
    body: message ? `<p class="rr-sheet-msg">${escapeHtml(message)}</p>` : "",
    actions: [
      { label: confirmText, kind: danger ? "danger" : "primary", value: true, autofocus: true },
      { label: cancelText,  kind: "ghost",                       value: false },
    ],
  }).then(v => v === true);
}

// promptSheet — the app's window.prompt() replacement: the same bottom
// sheet with an optional free-text reason. Resolves { text } on confirm,
// null on dismiss. Keeps the two flows that used raw prompt() (missed
// day, document decline) visually native to the installed PWA.
function promptSheet({ title = "Confirm", message = "", placeholder = "", confirmText = "Send", cancelText = "Cancel", danger = false, maxlength = 500 } = {}) {
  const body = document.createElement("div");
  body.innerHTML = `
    ${message ? `<p class="rr-sheet-msg">${escapeHtml(message)}</p>` : ""}
    <textarea class="field rr-sheet-textarea" rows="3" maxlength="${maxlength}" placeholder="${escapeHtml(placeholder)}"></textarea>`;
  const ta = body.querySelector("textarea");
  return openSheet({
    title,
    body,
    actions: [
      { label: confirmText, kind: danger ? "danger" : "primary", value: true },
      { label: cancelText,  kind: "ghost",                       value: false },
    ],
  }).then((v) => (v === true ? { text: (ta.value || "").trim() } : null));
}

// ── Pull-to-refresh ─────────────────────────────────────────────
// One handler attached to #main; a per-route refresh callback is
// registered via setRefresh(fn). The handler converts a downward
// pan at scrollTop=0 into a translate3d on #main and a spinner
// pill. Past the threshold, fires the callback and snaps back.
let _ptrCb = null;
let _ptrEl = null;
let _ptrWired = false;
const PTR_THRESHOLD = 64;     // px the user must pull
const PTR_RESIST    = 0.55;   // resistance factor (drag feels heavy)
function setRefresh(fn) { _ptrCb = fn || null; }
function _ptrEnsureIndicator() {
  if (_ptrEl) return _ptrEl;
  _ptrEl = document.createElement("div");
  _ptrEl.className = "rr-ptr";
  _ptrEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
  // The indicator lives in #app (a sibling of #main + header) so it
  // stays put while #main translates underneath.
  document.getElementById("app")?.appendChild(_ptrEl);
  return _ptrEl;
}
function _wirePullToRefresh() {
  const main = document.getElementById("main");
  if (!main || _ptrWired) return;
  _ptrWired = true;
  let startY = 0, dy = 0, dragging = false, armed = false, refreshing = false;
  const onStart = (e) => {
    if (refreshing || !_ptrCb) return;
    if (main.scrollTop > 0) return;
    const t = e.touches ? e.touches[0] : e;
    startY = t.clientY; dy = 0; dragging = true; armed = false;
    _ptrEnsureIndicator();
  };
  const onMove = (e) => {
    if (!dragging) return;
    const t = e.touches ? e.touches[0] : e;
    dy = (t.clientY - startY) * PTR_RESIST;
    if (dy < 0) { dragging = false; main.removeAttribute("data-ptr-active"); _ptrEl?.classList.remove("visible","armed"); return; }
    // Past threshold the indicator settles at the top; further
    // pulling adds diminishing return.
    const clamped = Math.min(dy, PTR_THRESHOLD + (dy - PTR_THRESHOLD) * 0.25);
    main.style.setProperty("--rr-ptr-y", clamped + "px");
    main.setAttribute("data-ptr-active", "dragging");
    const ind = _ptrEnsureIndicator();
    ind.classList.add("visible");
    const ratio = Math.min(1, dy / PTR_THRESHOLD);
    ind.style.transform = `translate(-50%, ${-32 + Math.min(60, clamped) * 0.9}px) scale(${0.85 + 0.15 * ratio})`;
    if (dy >= PTR_THRESHOLD && !armed) { armed = true; ind.classList.add("armed"); _haptic("select"); }
    if (dy <  PTR_THRESHOLD &&  armed) { armed = false; ind.classList.remove("armed"); }
    if (e.cancelable && dy > 4) e.preventDefault();
  };
  const onEnd = async () => {
    if (!dragging) return;
    dragging = false;
    const ind = _ptrEl;
    if (armed && _ptrCb && !refreshing) {
      refreshing = true;
      ind?.classList.add("refreshing");
      ind?.classList.remove("armed");
      ind && (ind.style.transform = `translate(-50%, 24px) scale(1)`);
      main.style.setProperty("--rr-ptr-y", "56px");
      main.setAttribute("data-ptr-active", "settled");
      _haptic("tap");
      try { await _ptrCb(); }
      catch (e) { console.warn("ptr refresh failed:", e); _haptic("warn"); }
      refreshing = false;
      ind?.classList.remove("refreshing");
    }
    // Release.
    main.style.setProperty("--rr-ptr-y", "0px");
    main.setAttribute("data-ptr-active", "settled");
    if (ind) {
      ind.style.transform = `translate(-50%, -32px) scale(.85)`;
      setTimeout(() => { ind.classList.remove("visible","armed"); }, 260);
    }
    setTimeout(() => { main.removeAttribute("data-ptr-active"); }, 320);
  };
  main.addEventListener("touchstart", onStart, { passive: true });
  main.addEventListener("touchmove",  onMove,  { passive: false });
  main.addEventListener("touchend",   onEnd);
  main.addEventListener("touchcancel", onEnd);
}

// ── Scroll-aware header ─────────────────────────────────────────
let _scrollHeadWired = false;
function _wireScrollAwareHeader() {
  const main = document.getElementById("main");
  if (!main || _scrollHeadWired) return;
  _scrollHeadWired = true;
  let lastScrolled = false;
  main.addEventListener("scroll", () => {
    const head = document.querySelector(".app-head");
    if (!head) return;
    const scrolled = main.scrollTop > 4;
    if (scrolled !== lastScrolled) {
      head.classList.toggle("scrolled", scrolled);
      lastScrolled = scrolled;
    }
  }, { passive: true });
}

// ── Directional page transitions ────────────────────────────────
// Track which way the next render is going. Sub-routes that have a
// `back` target are "forward" entries; navigating to that back
// target is "back". Top-level tab switches stay neutral (default
// page-enter fade+lift).
let _navDir = null;   // "forward" | "back" | null
let _navStack = [];   // simple history for direction inference
function _trackNav(path) {
  if (_navStack[_navStack.length - 1] === path) return;
  const i = _navStack.lastIndexOf(path);
  if (i >= 0) {
    _navStack = _navStack.slice(0, i + 1);
    _navDir = "back";
  } else {
    _navStack.push(path);
    if (_navStack.length > 1) _navDir = "forward";
    else _navDir = null;
  }
}

// ── Field-readiness helpers ─────────────────────────────────────
// Calm, specific error messaging.  Maps the raw Postgres / RPC /
// network errors that bubble out of supabase-js into a user-facing
// sentence that tells the driver what happened, what was saved (if
// anything), and what they can do next.  Falls back to a calm
// generic when we don't recognize the shape — never exposes the
// raw error text in the UI.
function _friendlyError(err, fallback) {
  const raw = (typeof err === "string" ? err : (err?.message || err?.error_description || ""));
  const m = String(raw).toLowerCase();
  if (!m) return fallback || "Something went wrong. Try again in a moment.";
  // Network-layer signals from fetch / supabase-js.
  if (/networkerror|failed to fetch|load failed|err_network|err_internet/.test(m)
      || (typeof navigator !== "undefined" && navigator.onLine === false)) {
    return "You're offline. We'll try this again when you're back online.";
  }
  if (/aborted|timeout/.test(m)) {
    return "That took too long. Check your signal and try again.";
  }
  // Driver-session signals — caller usually handles sign-out elsewhere,
  // but the toast that surfaces should still read human.
  if (/unauthorized|revoked|inactive|session/.test(m)) {
    return "Your session ended. Sign in again to continue.";
  }
  // Known RPC error codes the dashboard / driver RPCs throw.
  if (/preview_read_only/.test(m))          return "This is a read-only preview — actions are disabled.";
  if (/shift_already_taken/.test(m))        return "Someone got there first. The shift's taken.";
  if (/already_submitted/.test(m))          return "You've already submitted this.";
  if (/already_checked_in/.test(m))         return "You're already checked in.";
  if (/no_shift_today/.test(m))             return "No shift scheduled today.";
  if (/out_of_geofence/.test(m))            return "You're not close enough to the station yet.";
  if (/too_early_to_checkin/.test(m))       return "Check-in window isn't open yet.";
  if (/geofence_not_configured/.test(m))    return "Your dispatcher hasn't set the station's geofence yet.";
  if (/invalid_or_expired_code/.test(m))    return "Code not recognized. Ask dispatch for a new one.";
  if (/driver_inactive/.test(m))            return "This account isn't active. Contact dispatch.";
  // Storage / upload errors.
  if (/payload too large|file too large|413/.test(m)) return "That file's too large. Try a smaller image.";
  if (/storage|bucket/.test(m))             return "Upload couldn't finish. Try again in a moment.";
  // Generic Postgres signals — we don't expose them.
  if (/^pgrst|^pg_|duplicate key|violates|denied|permission/.test(m)) {
    return fallback || "Action couldn't complete. Try again.";
  }
  // When supabase returns its own human-ish messages ("Network error",
  // "JWT expired", etc.) capitalize the first letter and use it as-is.
  if (m.length > 0 && m.length < 90 && !/[{}]/.test(m)) {
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }
  return fallback || "Something went wrong. Try again in a moment.";
}

// ── Drafts ───────────────────────────────────────────────────────
// Lightweight per-key persistence for in-flight composition (form
// answers, chat composer body, etc.).  Lives in localStorage so it
// survives an app restart on the home screen, a tab navigation, or
// a forced reload after a poor-signal moment.  Stale entries (>14d)
// are reaped on next read.
const DRAFT_PREFIX = "rr.draft.";
const DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
function _draftKey(k) { return DRAFT_PREFIX + k; }
function getDraft(k) {
  try {
    const raw = localStorage.getItem(_draftKey(k));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    if (Date.now() - (obj.t || 0) > DRAFT_MAX_AGE_MS) {
      try { localStorage.removeItem(_draftKey(k)); } catch {}
      return null;
    }
    return obj.v;
  } catch { return null; }
}
function setDraft(k, v) {
  try {
    if (v == null || v === "" || (typeof v === "object" && Object.keys(v).length === 0)) {
      localStorage.removeItem(_draftKey(k));
      return;
    }
    localStorage.setItem(_draftKey(k), JSON.stringify({ t: Date.now(), v }));
  } catch { /* quota / private-mode — drafts just don't persist */ }
}
function clearDraft(k) {
  try { localStorage.removeItem(_draftKey(k)); } catch {}
}

// ── Scroll-position preservation ─────────────────────────────────
// Save #main.scrollTop on every nav-away; restore on render.  Lives
// in memory only (sessionStorage would also work; in-memory matches
// the implicit lifetime of an installed PWA session).
const _scrollPositions = new Map();
let _scrollSaveTimer = null;
function _wireScrollSave() {
  const main = document.getElementById("main");
  if (!main || main._rrScrollSaveWired) return;
  main._rrScrollSaveWired = true;
  main.addEventListener("scroll", () => {
    clearTimeout(_scrollSaveTimer);
    _scrollSaveTimer = setTimeout(() => {
      const path = currentRoute();
      _scrollPositions.set(path, main.scrollTop);
    }, 120);
  }, { passive: true });
}
function _restoreScroll(path) {
  const main = document.getElementById("main");
  if (!main) return;
  const y = _scrollPositions.get(path) || 0;
  // Restore on next frame so the new content has laid out.
  requestAnimationFrame(() => {
    main.scrollTop = y;
  });
}

// ── Calm error states ───────────────────────────────────────────
// Replaces every "Couldn't load X." inline banner with a single
// premium empty-state pattern: alert icon + plain-language title +
// the friendly mapping of the raw error.  Used by every screen
// that has a "couldn't load" branch.
function errorStateHtml(title, err) {
  const sub = escapeHtml(_friendlyError(err, "Pull down to retry."));
  return `<div class="rr-empty">
    <div class="rr-empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
    <div class="rr-empty-title">${escapeHtml(title)}</div>
    <div class="rr-empty-sub">${sub}</div>
  </div>`;
}

function readSession() {
  if (PREVIEW) return _previewSession;
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
}
function writeSession(s) {
  if (PREVIEW) { _previewSession = s || null; return; }
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else {
    localStorage.removeItem(SESSION_KEY);
    // Reset activation state so the next login screen recalibrates
    // from URL + LAST_PHONE_KEY instead of replaying stale state.
    try { _loginState = null; } catch {}
  }
}

// ── Toast ───────────────────────────────────────────────────────────
function toast(msg, kind = "default") {
  // Normalize kind aliases: a dozen call sites say "success"/"info" but
  // only "warn"/"ok" have styles — "success" used to render unstyled on
  // exactly the highest-emotion confirmations (shift accepted, signed).
  if (kind === "success") kind = "ok";
  else if (kind === "info") kind = "default";
  let el = document.getElementById("rr-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "rr-toast";
    el.className = "toast";
    // aria-live so screen readers announce status changes without
    // hijacking focus. "polite" for ok/info, "assertive" for warn.
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.setAttribute("aria-atomic", "true");
    document.body.appendChild(el);
  }
  el.setAttribute("aria-live", kind === "warn" ? "assertive" : "polite");
  el.textContent = msg;
  el.className = `toast show ${kind === "warn" ? "warn" : kind === "ok" ? "ok" : ""}`.trim();
  clearTimeout(el._t);
  // Errors / warnings stay on screen ~3.5s so drivers in motion have
  // time to read them; confirmations clear faster at ~2.2s.
  el._t = setTimeout(() => el.classList.remove("show"), kind === "warn" ? 3500 : 2200);
}

// ── Helpers ─────────────────────────────────────────────────────────
// Skeleton placeholders — used in place of a bare spinner whenever a
// screen has a stable layout we can hint at while data loads. The
// shimmer rhythm matches .chat-skeleton-bubble so the whole app
// breathes together. n controls how many rows the skeleton stamps.
function shiftSkeletonHtml(n = 3){
  let out = "";
  for (let i = 0; i < n; i++){
    out += `<div class="skel-shift">
      <span class="skel skel-date"></span>
      <div class="skel-body">
        <span class="skel skel-line-lg" style="width:55%"></span>
        <span class="skel skel-line" style="width:35%"></span>
      </div>
    </div>`;
  }
  return out;
}
function taskSkeletonHtml(n = 3){
  let out = "";
  for (let i = 0; i < n; i++){
    out += `<div class="skel-task">
      <span class="skel skel-square"></span>
      <div class="skel-body">
        <span class="skel skel-line-lg" style="width:60%"></span>
        <span class="skel skel-line-sm" style="width:40%"></span>
      </div>
    </div>`;
  }
  return out;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}
// Wrap http(s) URLs in an ALREADY-ESCAPED chat body with clickable
// anchors.  Must run after escapeHtml (and any \n→<br> pass) so the
// regex never sees raw user HTML; [^\s<] stops the match at whitespace
// and at our inserted <br> tags.  Trailing punctuation stays outside
// the href so a sentence-ending period isn't part of the link.
// `onAccent` flips the link to inherit its color — for white-on-accent
// bubbles where var(--accent) would vanish into the background.
function linkifyEscaped(escaped, onAccent) {
  return String(escaped || "").replace(/(https?:\/\/[^\s<]+)/gi, (raw) => {
    const href = raw.replace(/[.,;:!?)\]>]+$/, "");
    const tail = raw.slice(href.length);
    const color = onAccent ? "color:inherit" : "color:var(--accent)";
    return `<a href="${href}" target="_blank" rel="noopener" style="${color};text-decoration:underline;font-weight:600;word-break:break-all">${href}</a>${tail}`;
  });
}
function initialsOf(name) {
  return (name || "").split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
}
function homeGreeting(date = new Date()) {
  const h = date.getHours();
  if (h < 5) return "Good evening";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}
function homeTodayLabel(date = new Date()) {
  return date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}
// ── Hash router ─────────────────────────────────────────────────────
// Top-level tabs: /profile, /schedule, /tasks, /chat.
// Sub-routes branch off (e.g. /settings, /tasks/availability).
const routes = {
  "/schedule":          { render: renderSchedule,        tab: "/schedule" },
  "/welcome":           { render: renderCelebrationRoute, tab: "/schedule" },
  "/tasks":             { render: renderTasksHub,        tab: "/tasks" },
  "/tasks/onboarding":  { render: renderOnboarding,      tab: "/tasks", back: "/tasks", title: "Onboarding" },
  "/tasks/onboarding/step": { render: renderOnboardingStep, tab: "/tasks", back: "/tasks/onboarding", title: "Onboarding step" },
  "/tasks/form":        { render: renderFormFill,        tab: "/tasks", back: "/tasks", title: "Form" },
  "/checklists":        { render: renderChecklistsHub,   tab: "/tasks", back: "/tasks", title: "Checklists" },
  "/tasks/checklist":   { render: renderChecklistFill,   tab: "/tasks", back: "/tasks", title: "Checklist" },
  "/tasks/coaching":    { render: renderCoachingFeed,    tab: "/tasks", back: "/tasks", title: "Coaching" },
  "/tasks/coaching/one":{ render: renderCoachingDetail,  tab: "/tasks", back: "/tasks/coaching", title: "Coaching" },
  "/tasks/documents":   { render: renderDocumentsList,   tab: "/tasks", back: "/tasks", title: "Documents" },
  "/tasks/documents/sign":{ render: renderDocumentSign,  tab: "/tasks", back: "/tasks/documents", title: "Sign document" },
  "/tasks/i9":          { render: renderI9Section1,      tab: "/tasks", back: "/tasks", title: "Form I-9" },
  "/tasks/scan":        { render: renderDocumentScanner, tab: "/tasks", back: "/tasks", title: "Scan a document" },
  "/tasks/scan/receipt":{ render: renderReceiptForm,      tab: "/tasks", back: "/tasks/scan", title: "Submit a receipt" },
  "/settings/profile":      { render: renderSettingsProfile, tab: "/profile", back: "/settings", title: "Profile" },
  "/settings/license":      { render: renderSettingsLicense, tab: "/profile", back: "/settings", title: "Driver's license" },
  "/settings/pin":          { render: renderSettingsPin,     tab: "/profile", back: "/settings", title: "Sign-in PIN" },
  "/settings/availability": { render: renderAvailability,    tab: "/profile", back: "/settings", title: "Availability" },
  "/settings/attendance":   { render: renderAttendance,      tab: "/profile", back: "/settings", title: "Attendance" },
  "/settings/time-off":     { render: renderTimeOff,         tab: "/profile", back: "/settings", title: "Time off" },
  "/chat":              { render: renderChat,            tab: "/chat" },
  "/chat/channels":     { render: renderChatChannelsList, tab: "/chat" },
  "/chat/channel":      { render: renderChatChannelThread, tab: "/chat", back: "/chat/channels" },
  "/team":              { render: renderTeam,            tab: "/team" },
  "/profile":           { render: renderProfileHub,      tab: "/profile" },
  "/settings":          { render: renderSettings,        tab: "/profile", back: "/profile", title: "Settings" },
};
function currentRoute() {
  const h = (location.hash || "").replace(/^#/, "").split("?")[0];
  if (routes[h]) return h;
  return "/profile";
}
function routeQuery() {
  const h = (location.hash || "").replace(/^#/, "");
  const i = h.indexOf("?");
  if (i < 0) return new URLSearchParams("");
  return new URLSearchParams(h.slice(i + 1));
}
function navigate(path) {
  if (location.hash !== "#" + path) location.hash = "#" + path;
  else render();
}
window.addEventListener("hashchange", render);

// ── Render entrypoint ───────────────────────────────────────────────
function render() {
  const session = readSession();
  if (!session) { (PREVIEW ? renderPreviewExpired : renderLogin)(); return; }
  // Onboarding lock — until dispatch flips status to 'active', the
  // driver should only see the Onboarding tasks + Settings. Any other
  // route (Schedule, Chat, Tasks hub, Profile hub, etc.) redirects to
  // /tasks/onboarding so we don't accidentally surface schedule data
  // before the operator's marked them active.
  if (session.status === "onboarding") {
    // Chat stays unlocked during onboarding — drivers receive
    // instructions / welcome messages from dispatch while they work
    // through the sequential onboarding flow.
    const allowed = (path) => path === "/tasks/onboarding"
      || path === "/tasks/onboarding/step"
      || path === "/tasks/documents"
      || path === "/tasks/documents/sign"
      || path === "/tasks/i9"
      // /chat plus its sub-routes — channels moved onto real routes
      // (/chat/channels, /chat/channel), and onboarding drivers use
      // Chat to receive dispatch instructions.
      || path === "/chat"
      || path.startsWith("/chat/")
      // Schedule stays unlocked during onboarding so the driver can
      // see any training shifts the dispatcher slots in before they
      // flip to "active". Without this, manually-added training
      // shifts assigned to an onboarding driver landed in the DB but
      // the driver never saw them — every /schedule visit got
      // redirected back to /tasks/onboarding.
      || path === "/schedule"
      || path === "/settings"
      || path.startsWith("/settings/");
    const path = currentRoute();
    if (!allowed(path)) {
      navigate("/tasks/onboarding");
      return;
    }
  }
  renderShell(session);
  // Re-stamp the Chat tab badge with the latest unread count every
  // time the shell mounts so a newly-arrived dispatch message (e.g.
  // the welcome message from migration 0266) shows up on the icon
  // without the driver having to open Chat first.
  refreshChatBadge();
  // Forms tab badge · surface a freshly-sent Coaching on app open.
  refreshFormsBadge();
  // Checklists tab badge · count of open (not-completed) checklists.
  refreshChecklistsBadge();
  // Check for queued Recognition Celebration Events.  Fires immediately
  // so the celebration is the first thing the driver sees on app open
  // — no perceptible shell flash before the overlay lands.
  //
  // Note: iOS PWAs and Safari back/forward cache hold the JS state
  // alive across app suspend/resume.  When the driver taps the home-
  // screen icon, render() may NOT re-fire — they're just unfreezing
  // the previous tab.  visibilitychange + pageshow listeners (set up
  // once below) re-fire the check on every foreground so a freshly-
  // queued celebration lands when the driver returns to the app.
  checkAndShowPendingRecognition(session).catch((e) => {
    console.warn("recognition check failed:", e);
  });
  const path = currentRoute();
  const r = routes[path];
  // Header back button on sub-routes; clear it on top-level tabs.
  // During onboarding the normal back targets (/tasks, /profile) are
  // blocked routes, so override: hide back on the onboarding home and
  // route /settings back to the onboarding home instead of /profile.
  const back = document.getElementById("head-back");
  const isOnboarding = session.status === "onboarding";
  let backTarget = r.back;
  if (isOnboarding) {
    if (path === "/tasks/onboarding") backTarget = null;
    else if (path === "/settings")            backTarget = "/tasks/onboarding";
    else if (path === "/tasks/i9")            backTarget = "/tasks/onboarding";
    else if (path === "/tasks/documents")     backTarget = "/tasks/onboarding";
    else if (path === "/tasks/documents/sign") backTarget = "/tasks/onboarding";
  }
  if (back) back.style.display = backTarget ? "inline-flex" : "none";
  if (back && backTarget) back.onclick = () => navigate(backTarget);
  if (r.title) setHeader(r.title, "");
  // The home (Profile) page swaps the standard header for a full-bleed
  // blue gradient hero. Toggle a body class so CSS can hide .app-head
  // and lift main to the top of the viewport on /profile only.
  document.body.classList.toggle("is-home", path === "/profile");
  // Reset per-route side-channels so a stale refresh callback from a
  // previous screen can't fire under the new one's pull-to-refresh.
  setRefresh(null);
  // Save scroll position of the route we're leaving (if any).
  const _leavingMain = document.getElementById("main");
  if (_leavingMain && _navStack.length > 0) {
    const _leaving = _navStack[_navStack.length - 1];
    if (_leaving && _leaving !== path) _scrollPositions.set(_leaving, _leavingMain.scrollTop);
  }
  // Track nav direction for directional page transitions.
  _trackNav(path);
  r.render();
  // Premium page-enter — toggle [data-page-enter] on #main so each top-
  // level child fades + lifts in. Reset on every render so the animation
  // re-fires when a route is re-entered. Cheap (CSS-only) and skipped
  // automatically under prefers-reduced-motion. Direction comes from
  // _navDir so drilling deeper slides right→left and back slides
  // left→right; tab-level navigation gets the default fade.
  const _main = document.getElementById("main");
  if (_main) {
    _main.removeAttribute("data-page-enter");
    _main.removeAttribute("data-nav-dir");
    // Force reflow so the re-added attribute restarts the animation.
    void _main.offsetWidth;
    _main.setAttribute("data-page-enter", "1");
    if (_navDir) _main.setAttribute("data-nav-dir", _navDir);
    // Header starts un-scrolled; the scroll listener flips it.
    document.querySelector(".app-head")?.classList.remove("scrolled");
    _wireScrollAwareHeader();
    _wirePullToRefresh();
    _wireScrollSave();
    // Restore scroll on back-navigation — drilling forward starts at
    // the top, returning to a list lands you where you left off.
    if (_navDir === "back") _restoreScroll(path);
  }
  document.querySelectorAll(".tab").forEach((t) => {
    // In onboarding the Onboarding tab points directly at
    // /tasks/onboarding; in the normal tabbar the Tasks tab uses /tasks.
    // Match either by exact data-route or by the route definition's
    // declared `tab` so both shells highlight correctly.
    const route = t.dataset.route;
    const isActive = route === r.tab || route === currentRoute();
    t.classList.toggle("active", isActive);
    // aria-selected + aria-current so screen readers narrate which tab
    // is current, independent of color cues.
    t.setAttribute("aria-selected", isActive ? "true" : "false");
    if (isActive) t.setAttribute("aria-current", "page");
    else          t.removeAttribute("aria-current");
  });
  _updateTabLens();
  // Refresh the cached photo URL from the server in the background.
  // Cheap way to pick up a photo set on another device without forcing
  // the user to do anything.
  refreshDriverProfile(session);
}

// Throttle the driver_me hit to once per minute. We call this on every
// navigation, every focus, and every visibilitychange so the header
// brand, profile photo, and display name flip as soon as dispatch
// changes them — without hammering the server while the driver is
// flicking between tabs. The session cache is the source of truth for
// the UI; this keeps it fresh.
let _profileRefreshedAt = 0;
async function refreshDriverProfile(session, { force } = {}) {
  if (!session?.token) return;
  const now = Date.now();
  if (!force && now - _profileRefreshedAt < 60_000) return;
  _profileRefreshedAt = now;
  try {
    // Fire driver_me + driver_get_profile in parallel. The first gets
    // us the public-facing brand bits (display name, photo URL, dsp);
    // the second carries the lifecycle status that gates the whole UI
    // when a driver is still in 'onboarding'. Treat status as authoritative
    // so dispatch flipping someone to 'active' lands within a minute.
    const [meRes, profRes] = await Promise.all([
      sb.rpc("driver_me", { p_token: session.token }),
      sb.rpc("driver_get_profile", { p_token: session.token }),
    ]);
    const data = meRes?.data;
    const profile = profRes?.data;
    if (meRes?.error || !data) return;
    const status = profile?.status ?? null;
    const cur = readSession();
    if (!cur) return;
    // driver-photos is private (migration 0446) — sign the driver's own photo.
    // Re-sign only when the path changed or we have no cached URL; the 7-day
    // expiry outlives a session so we don't re-sign on every driver_me tick.
    let photoUrl = cur.photo_url || null;
    if (!data.photo_path) {
      photoUrl = null;
    } else if (data.photo_path !== cur.photo_path || !photoUrl) {
      try {
        const { data: _ps } = await sb.storage.from("driver-photos").createSignedUrl(data.photo_path, 7 * 24 * 60 * 60);
        photoUrl = _ps?.signedUrl || null;
      } catch (_) { photoUrl = null; }
    }
    const dspName  = data.dsp_name  || cur.dsp_name  || "";
    const dspPhone = data.dsp_phone || cur.dsp_phone || "";
    const dspId    = data.dsp_id    || cur.dsp_id    || null;
    const drvId    = data.id        || cur.driver_id || null;
    // Which request features the DSP exposes (Settings → Requests in dispatch).
    // Empty object ⇒ everything on. Fall back to the cached copy when the RPC
    // predates migration 0393 so we never blank a feature on stale data.
    const reqFeat  = (data.request_features && typeof data.request_features === "object")
      ? data.request_features
      : (cur.request_features || {});
    if ((cur.photo_url || null) === (photoUrl || null) &&
        (cur.name || "")        === (data.name || "") &&
        (cur.dsp_name || "")    === dspName &&
        (cur.dsp_phone || "")   === dspPhone &&
        (cur.dsp_id || null)    === dspId &&
        (cur.driver_id || null) === drvId &&
        JSON.stringify(cur.request_features || {}) === JSON.stringify(reqFeat) &&
        (cur.status || null)    === (status || null)) return;
    writeSession({ ...cur,
      name:       data.name || cur.name,
      photo_url:  photoUrl,
      photo_path: data.photo_path,
      dsp_name:   dspName,
      dsp_phone:  dspPhone,
      dsp_id:     dspId,
      driver_id:  drvId,
      request_features: reqFeat,
      status,
    });
    // Re-render so the header brand picks up the new dsp_name and the
    // Profile screen shows a freshly-uploaded photo. Also catches an
    // onboarding → active flip and unlocks the rest of the app.
    render();
  } catch {}
}

// Driver-app request features the DSP toggles in dispatch (Settings →
// Requests). Persisted to dsps.metadata.request_features, surfaced via
// driver_me → session.request_features. Defaults every key ON when unset, so
// an older session or a DSP that never opened Settings keeps the full app.
//   time_off · availability · preferred_days · start_time · fifth_day
function driverFeatureOn(key) {
  const f = readSession()?.request_features;
  if (!f || typeof f !== "object") return true;
  return f[key] !== false; // anything but an explicit false ⇒ ON
}

// Friendly placeholder when a driver lands on a feature their DSP turned off
// (e.g. an old bookmark / direct hash). Keeps the back button working.
function _featureOffHtml(name) {
  return `
    <div class="settings-section" style="text-align:center;padding:44px 18px">
      <div class="settings-section-title">${escapeHtml(name)} isn't available</div>
      <div class="settings-section-sub" style="margin-top:6px">Your DSP has turned this off. Message dispatch if you have questions.</div>
    </div>`;
}

// Refresh on focus so a DSP name change in dispatcher Settings shows
// up in the driver header without a full reload. Pairs with the
// once-per-minute throttle above so it stays cheap.
if (typeof window !== "undefined") {
  const refreshOnFocus = () => {
    const s = readSession();
    if (s?.token) refreshDriverProfile(s, { force: true });
  };
  window.addEventListener("focus", refreshOnFocus);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshOnFocus();
  });
}

// ── Activation / login ───────────────────────────────────────────────
// One screen, three modes:
//
//   activate  — first-tap landing from the welcome SMS (?code=...).
//               We look the code up server-side, render the driver's
//               name + masked phone, ask them to confirm the phone and
//               pick a 4-digit PIN.  Phone becomes their long-term
//               sign-in identity; the PIN replaces the one-shot code.
//
//   signin    — returning driver.  Phone + PIN.  We remember the last
//               phone they activated with so it's pre-filled on every
//               subsequent return.
//
//   chooser   — neither a code in the URL nor a remembered phone.  Two
//               quiet buttons: "I have an activation code" / "Sign in".
//
// Mode is held in module-scoped state so the screen can transition
// without unwinding through the hash router.
const LAST_PHONE_KEY = "rr.driver.last_phone";
let _loginState = null;   // { mode, code?, lookup?, phoneInput?, pinInput?, errorMsg?, busy }

function _readLastPhone() {
  try { return localStorage.getItem(LAST_PHONE_KEY) || ""; } catch { return ""; }
}
function _writeLastPhone(p) {
  try { if (p) localStorage.setItem(LAST_PHONE_KEY, p); else localStorage.removeItem(LAST_PHONE_KEY); } catch {}
}

// Display "(555) 123-4567" from a 10-digit string.
function _formatPhone(p) {
  const d = String(p || "").replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === "1") return `(${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  return p || "";
}

function _commitSession(data) {
  const newSession = {
    token:      data.token,
    driver_id:  data.driver?.id || null,
    dsp_id:     data.driver?.dsp_id || data.dsp?.id || null,
    name:       data.driver?.name || "Driver",
    station_id: data.driver?.station_id || null,
    status:     data.driver?.status || null,
    dsp_name:   data.driver?.dsp_name || data.dsp?.name || "",
  };
  writeSession(newSession);
  syncSwSession(newSession);
  return newSession;
}

function renderLogin(errorMsg) {
  // First call: figure out which mode we land in.
  if (!_loginState) {
    let code = "";
    try {
      const qs = new URLSearchParams(location.search);
      code = (qs.get("code") || qs.get("invite") || "").trim().toUpperCase();
    } catch (_) { /* malformed URL — ignore */ }
    if (code) {
      _loginState = { mode: "activate-loading", code, errorMsg: null, busy: false };
    } else if (_readLastPhone()) {
      _loginState = { mode: "signin", phoneInput: _readLastPhone(), pinInput: "", errorMsg: null, busy: false };
    } else {
      _loginState = { mode: "chooser", errorMsg: null, busy: false };
    }
  }
  if (errorMsg) _loginState.errorMsg = errorMsg;

  // Kick off the activation lookup once when we land here with a code.
  if (_loginState.mode === "activate-loading" && !_loginState._lookupStarted) {
    _loginState._lookupStarted = true;
    sb.rpc("driver_activation_lookup", { p_code: _loginState.code }).then(({ data, error }) => {
      if (error || !data) {
        // Fall back to chooser with a clear error.
        const m = error?.message || "";
        const msg = m.includes("invalid_or_expired_code")
          ? "That activation link has expired. Ask dispatch for a new one."
          : "Couldn't open that activation link. Try the new one from dispatch.";
        _loginState = { mode: "chooser", errorMsg: msg, busy: false };
      } else {
        _loginState = {
          mode: "activate",
          code: _loginState.code,
          lookup: data,
          phoneInput: data.phone_hint ? "" : "",  // user types it; hint shows what we have on file
          pinInput: "",
          pinConfirm: "",
          errorMsg: null,
          busy: false,
        };
      }
      renderLogin();
    });
  }

  const root = document.getElementById("app");
  if (_loginState.mode === "activate-loading") {
    root.innerHTML = `
      <div class="login-screen">
        <div class="brand"><div class="brand-icon"><img src="Icon.png" alt="RouteReady"></div></div>
        <div style="text-align:center;color:var(--text-subtle);margin-top:8px">Opening your activation…</div>
        <div class="loader" style="margin:40px auto"></div>
      </div>`;
    return;
  }

  if (_loginState.mode === "chooser") {
    root.innerHTML = `
      <div class="login-screen">
        <div class="brand"><div class="brand-icon"><img src="Icon.png" alt="RouteReady"></div></div>
        <div style="text-align:center;margin-bottom:32px">
          <div style="font-size:22px;font-weight:700;letter-spacing:-.02em">RouteReady</div>
          <div style="font-size:var(--fs-md);color:var(--text-subtle);margin-top:6px">Your driver hub.</div>
        </div>
        <div class="form">
          ${_loginState.errorMsg ? `<div class="err">${escapeHtml(_loginState.errorMsg)}</div>` : ""}
          <button class="btn btn-primary btn-block" type="button" id="rr-login-signin">Sign in</button>
          <button class="btn btn-block" type="button" id="rr-login-activate" style="margin-top:10px;background:transparent;border:1px solid var(--border)">I have an activation code</button>
        </div>
      </div>`;
    document.getElementById("rr-login-signin").addEventListener("click", () => {
      _loginState = { mode: "signin", phoneInput: _readLastPhone(), pinInput: "", errorMsg: null, busy: false };
      renderLogin();
    });
    document.getElementById("rr-login-activate").addEventListener("click", () => {
      _loginState = { mode: "code-entry", codeInput: "", errorMsg: null, busy: false };
      renderLogin();
    });
    return;
  }

  if (_loginState.mode === "code-entry") {
    root.innerHTML = `
      <div class="login-screen">
        <div class="brand"><div class="brand-icon"><img src="Icon.png" alt="RouteReady"></div></div>
        <div style="text-align:center;margin-bottom:24px">
          <div style="font-size:20px;font-weight:700;letter-spacing:-.02em">Activate your driver profile</div>
          <div style="font-size:var(--fs-md);color:var(--text-subtle);margin-top:6px;line-height:1.5">Enter the activation code from your welcome message.</div>
        </div>
        <form class="form" id="rr-code-form">
          ${_loginState.errorMsg ? `<div class="err">${escapeHtml(_loginState.errorMsg)}</div>` : ""}
          <label class="field-label">Activation code</label>
          <input class="field" id="rr-code-input" autocomplete="one-time-code" inputmode="latin" autocapitalize="characters" maxlength="10" placeholder="ABCD1234" required value="${escapeHtml(_loginState.codeInput || "")}" />
          <div style="margin-top:18px">
            <button class="btn btn-primary btn-block" type="submit" ${_loginState.busy ? "disabled" : ""}>${_loginState.busy ? "Checking…" : "Continue"}</button>
          </div>
          <div style="text-align:center;margin-top:14px">
            <button type="button" class="btn" id="rr-code-back" style="background:transparent;border:0;color:var(--text-subtle);font-size:var(--fs-sm)">Back</button>
          </div>
        </form>
      </div>`;
    document.getElementById("rr-code-back").addEventListener("click", () => {
      _loginState = { mode: "chooser", errorMsg: null, busy: false };
      renderLogin();
    });
    document.getElementById("rr-code-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = (document.getElementById("rr-code-input").value || "").trim().toUpperCase();
      if (code.length < 4) { _loginState.errorMsg = "That code looks too short."; renderLogin(); return; }
      _loginState.busy = true; renderLogin();
      const { data, error } = await sb.rpc("driver_activation_lookup", { p_code: code });
      if (error || !data) {
        _loginState.busy = false;
        _loginState.codeInput = code;
        _loginState.errorMsg = "Code not recognized. Check the message from dispatch.";
        renderLogin();
        return;
      }
      _loginState = { mode: "activate", code, lookup: data, phoneInput: "", pinInput: "", pinConfirm: "", errorMsg: null, busy: false };
      renderLogin();
    });
    return;
  }

  if (_loginState.mode === "activate") {
    const lk = _loginState.lookup || {};
    const phoneHint = lk.phone_hint || "";
    const greet = `Welcome${lk.name ? `, ${lk.name}` : ""}`;

    // Already-activated driver re-tapping the link from a new device
    // (e.g., home-screen PWA after activating in Safari).  One tap to
    // sign in — no PIN re-entry needed because the code itself is the
    // credential for the rest of the 14-day window.
    if (lk.already_activated) {
      root.innerHTML = `
        <div class="login-screen">
          <div class="brand"><div class="brand-icon"><img src="Icon.png" alt="RouteReady"></div></div>
          <div style="text-align:center;margin-bottom:22px;margin-top:24px">
            <div style="font-size:22px;font-weight:700;letter-spacing:-.02em">Welcome back${lk.name ? `, ${escapeHtml(lk.name)}` : ""}</div>
            <div style="font-size:var(--fs-md);color:var(--text-subtle);margin-top:8px;line-height:1.55">Your driver profile is ready. Tap below to sign in on this device.</div>
          </div>
          <div class="form">
            ${_loginState.errorMsg ? `<div class="err">${escapeHtml(_loginState.errorMsg)}</div>` : ""}
            <button class="btn btn-primary btn-block" type="button" id="rr-activate-resume" ${_loginState.busy ? "disabled" : ""}>${_loginState.busy ? "Signing in…" : "Sign in"}</button>
            <div class="help" style="margin-top:14px;line-height:1.5">Forgot your PIN? Contact dispatch to send a fresh link.</div>
          </div>
        </div>`;
      document.getElementById("rr-activate-resume").addEventListener("click", async () => {
        _loginState.busy = true; _loginState.errorMsg = null; renderLogin();
        const { data, error } = await sb.rpc("driver_activate", {
          p_code: _loginState.code,
          p_phone: "",
          p_pin: "",
          p_user_agent: navigator.userAgent || null,
        });
        if (error || !data?.token) {
          _loginState.busy = false;
          const m = error?.message || "";
          _loginState.errorMsg =
            m.includes("invalid_or_expired_code") ? "This link has expired. Ask dispatch for a new one." :
            m.includes("driver_inactive")         ? "This profile isn't active. Contact dispatch." :
            "Couldn't sign you in. Try again.";
          renderLogin();
          return;
        }
        _writeLastPhone(data.driver?.phone_normalized || "");
        const sess = _commitSession(data);
        try { history.replaceState({}, "", location.pathname); } catch {}
        _loginState = null;
        toast(`Welcome, ${data.driver?.name || "driver"}`, "ok");
        navigate(sess.status === "onboarding" ? "/tasks/onboarding" : "/profile");
      });
      return;
    }

    // First-time activation: pick a 4-digit PIN now so it's already on
    // file when the driver installs the home-screen PWA (the PWA on
    // iOS launches in its own auth sandbox; tap-from-email re-activates
    // automatically, but a fresh PWA install always lands on the
    // sign-in screen and needs phone+PIN). Phone stays whatever the
    // dispatcher already has on file — they edit it from Settings if
    // it's wrong. We deliberately don't show a phone-edit input here
    // anymore: every additional field on this screen is one more
    // chance to fat-finger something during onboarding.
    root.innerHTML = `
      <div class="login-screen">
        <div class="brand"><div class="brand-icon"><img src="Icon.png" alt="RouteReady"></div></div>
        <div style="text-align:center;margin-bottom:22px">
          <div style="font-size:22px;font-weight:700;letter-spacing:-.02em">${escapeHtml(greet)}!</div>
          <div style="font-size:var(--fs-md);color:var(--text-subtle);margin-top:8px;line-height:1.55">We found your info from your ${lk.dsp_name ? escapeHtml(lk.dsp_name) + " " : ""}onboarding invite.${phoneHint ? ` Phone on file: ${escapeHtml(phoneHint)}.` : ""} Pick a 4-digit PIN — you'll use this to sign in when you install the app on your phone.</div>
        </div>
        <form class="form" id="rr-activate-form" style="margin-top:8px">
          ${_loginState.errorMsg ? `<div class="err">${escapeHtml(_loginState.errorMsg)}</div>` : ""}

          <label class="field-label">Create a 4-digit PIN</label>
          <input class="field" id="rr-activate-pin" type="password" inputmode="numeric" autocomplete="new-password" pattern="[0-9]*" maxlength="6" placeholder="••••" style="letter-spacing:.5em;text-align:center" value="${escapeHtml(_loginState.pinInput || "")}" />

          <label class="field-label" style="margin-top:14px">Confirm PIN</label>
          <input class="field" id="rr-activate-pin2" type="password" inputmode="numeric" autocomplete="new-password" pattern="[0-9]*" maxlength="6" placeholder="••••" style="letter-spacing:.5em;text-align:center" value="${escapeHtml(_loginState.pinConfirm || "")}" />

          <div style="margin-top:20px">
            <button class="btn btn-primary btn-block" type="submit" ${_loginState.busy ? "disabled" : ""}>${_loginState.busy ? "Activating…" : "Activate"}</button>
          </div>
          <div class="help" style="margin-top:14px;line-height:1.5">Phone or other details wrong? You can edit them in Settings once you're signed in.</div>
        </form>
      </div>`;
    document.getElementById("rr-activate-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const pin  = document.getElementById("rr-activate-pin").value.trim();
      const pin2 = document.getElementById("rr-activate-pin2").value.trim();
      _loginState.pinInput = pin; _loginState.pinConfirm = pin2;
      if (pin.length < 4 || pin.length > 6 || !/^\d+$/.test(pin)) {
        _loginState.errorMsg = "PIN must be 4 to 6 digits."; renderLogin(); return;
      }
      if (pin !== pin2) {
        _loginState.errorMsg = "PINs don't match. Try again."; renderLogin(); return;
      }
      _loginState.busy = true; _loginState.errorMsg = null; renderLogin();
      // Empty p_phone tells the server "keep what we have on file".
      const { data, error } = await sb.rpc("driver_activate", {
        p_code: _loginState.code,
        p_phone: "",
        p_pin: pin,
        p_user_agent: navigator.userAgent || null,
      });
      if (error || !data?.token) {
        _loginState.busy = false;
        const m = error?.message || "";
        _loginState.errorMsg =
          m.includes("invalid_or_expired_code") ? "Activation link expired. Ask dispatch for a new one." :
          m.includes("driver_inactive")          ? "This profile isn't active. Contact dispatch." :
          m.includes("phone_required")           ? "Your dispatcher needs to add your phone number first. Text them to add it." :
          m.includes("pin_must_be")              ? "PIN must be 4 to 6 digits." :
          "Couldn't activate. Try again.";
        renderLogin();
        return;
      }
      _writeLastPhone(data.driver?.phone_normalized || "");
      const sess = _commitSession(data);
      // Clear the ?code= from the URL so refreshes don't try to re-activate.
      try { history.replaceState({}, "", location.pathname); } catch {}
      _loginState = null;
      toast(`Welcome, ${data.driver?.name || "driver"}`, "ok");
      navigate(sess.status === "onboarding" ? "/tasks/onboarding" : "/profile");
    });
    return;
  }

  if (_loginState.mode === "signin") {
    root.innerHTML = `
      <div class="login-screen">
        <div class="brand"><div class="brand-icon"><img src="Icon.png" alt="RouteReady"></div></div>
        <div style="text-align:center;margin-bottom:24px">
          <div style="font-size:22px;font-weight:700;letter-spacing:-.02em">Welcome back</div>
          <div style="font-size:var(--fs-md);color:var(--text-subtle);margin-top:8px">Sign in with your number and PIN.</div>
        </div>
        <form class="form" id="rr-signin-form">
          ${_loginState.errorMsg ? `<div class="err">${escapeHtml(_loginState.errorMsg)}</div>` : ""}
          ${_loginState.infoMsg ? `<div style="background:rgba(37,99,235,.08);color:var(--accent);font-size:var(--fs-md);padding:var(--s-2-5) var(--s-3-5);border-radius:8px;text-align:center;margin-bottom:12px;line-height:1.45">${escapeHtml(_loginState.infoMsg)}</div>` : ""}
          <label class="field-label">Mobile number</label>
          <input class="field" id="rr-signin-phone" type="tel" inputmode="tel" autocomplete="tel" autocapitalize="off" maxlength="20" placeholder="(555) 123-4567" style="letter-spacing:0;text-align:left;text-transform:none" value="${escapeHtml(_formatPhone(_loginState.phoneInput || ""))}" />

          <label class="field-label" style="margin-top:18px">PIN</label>
          <input class="field" id="rr-signin-pin" type="password" inputmode="numeric" autocomplete="current-password" pattern="[0-9]*" maxlength="6" placeholder="••••" style="letter-spacing:.5em;text-align:center" value="${escapeHtml(_loginState.pinInput || "")}" />

          <div style="margin-top:20px">
            <button class="btn btn-primary btn-block" type="submit" ${_loginState.busy ? "disabled" : ""}>${_loginState.busy ? "Signing in…" : "Sign in"}</button>
          </div>
          <div style="text-align:center;margin-top:14px;display:flex;flex-direction:column;gap:8px">
            <button type="button" class="btn" id="rr-signin-send-link" style="background:transparent;border:0;color:var(--accent);font-size:var(--fs-sm);font-weight:600">First time, or forgot your PIN? Send me a link</button>
            <button type="button" class="btn" id="rr-signin-have-code" style="background:transparent;border:0;color:var(--text-subtle);font-size:var(--fs-sm)">I have an activation code</button>
          </div>
        </form>
      </div>`;
    const phEl2 = document.getElementById("rr-signin-phone");
    phEl2.addEventListener("input", () => {
      const raw = phEl2.value.replace(/\D/g, "").slice(0, 11);
      phEl2.value = _formatPhone(raw);
    });
    document.getElementById("rr-signin-have-code").addEventListener("click", () => {
      _loginState = { mode: "code-entry", codeInput: "", errorMsg: null, busy: false };
      renderLogin();
    });
    document.getElementById("rr-signin-send-link").addEventListener("click", async () => {
      const phone = document.getElementById("rr-signin-phone").value.trim();
      const phoneDigits = phone.replace(/\D/g, "");
      if (phoneDigits.length < 10) {
        _loginState.phoneInput = phone;
        _loginState.errorMsg = "Enter your mobile number and we'll send you a fresh activation link.";
        renderLogin();
        return;
      }
      _loginState.phoneInput = phone; _loginState.busy = true; _loginState.errorMsg = null; _loginState.infoMsg = null; renderLogin();
      const { data, error } = await sb.rpc("driver_request_activation", { p_phone: phoneDigits, p_channel: null });
      _loginState.busy = false;
      if (error) {
        _loginState.errorMsg = "Couldn't send a link. Try again or contact dispatch.";
        renderLogin();
        return;
      }
      // Always positive — server obfuscates whether the phone matched
      // so we can't enumerate.  If `channel` came back populated, the
      // link really was queued and we can show the masked destination.
      const sentTo = data?.sent_to;
      const channel = data?.channel;
      _loginState.infoMsg = channel
        ? `We just ${channel === "email" ? "emailed" : "texted"} a link${sentTo ? ` to ${sentTo}` : ""}. Tap it to activate, then come back here.`
        : "If your number is on file, we just sent you a link. Tap it to activate, then come back here.";
      renderLogin();
    });
    document.getElementById("rr-signin-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const phone = document.getElementById("rr-signin-phone").value.trim();
      const pin   = document.getElementById("rr-signin-pin").value.trim();
      _loginState.phoneInput = phone; _loginState.pinInput = pin;
      const phoneDigits = phone.replace(/\D/g, "");
      if (phoneDigits.length < 10) { _loginState.errorMsg = "Enter your mobile number."; renderLogin(); return; }
      if (pin.length < 4) { _loginState.errorMsg = "Enter your PIN."; renderLogin(); return; }
      _loginState.busy = true; _loginState.errorMsg = null; _loginState.infoMsg = null; renderLogin();
      const { data, error } = await sb.rpc("driver_signin_with_phone", {
        p_phone: phoneDigits,
        p_pin: pin,
        p_user_agent: navigator.userAgent || null,
      });
      if (error || !data?.token) {
        _loginState.busy = false;
        const m = error?.message || "";
        // Keep the underlying error visible when none of our known cases
        // match — a missing rate-limit table shouldn't hide behind a
        // generic "Sign-in failed" — but lead with human copy and demote
        // the raw text to a parenthetical diagnostic.
        _loginState.errorMsg =
          m.includes("too_many_attempts")     ? "Too many tries. Wait 15 minutes or contact dispatch." :
          m.includes("invalid_phone_or_pin")  ? "Number or PIN didn't match. Try again." :
          m ? `Couldn't sign you in. Try again, or contact dispatch. (${m})` :
          "Sign-in failed. Try again.";
        renderLogin();
        return;
      }
      _writeLastPhone(phoneDigits);
      const sess = _commitSession(data);
      _loginState = null;
      toast(`Welcome, ${data.driver?.name || "driver"}`, "ok");
      navigate(sess.status === "onboarding" ? "/tasks/onboarding" : "/profile");
    });
    return;
  }
}

// Shown instead of the login screen when a dispatcher's preview token has
// expired (they auto-expire after a couple hours). There's nothing to do
// from inside the frame — they reopen it from the roster.
function renderPreviewExpired() {
  document.getElementById("app").innerHTML = `
    <div class="login-screen">
      <div class="brand"><div class="brand-icon"><img src="Icon.png" alt="RouteReady"></div></div>
      <div class="empty-state" style="max-width:280px;text-align:center;line-height:1.55">
        This preview has expired.<br><br>
        <span style="color:var(--text-subtle)">Close it and open the driver's app view again from the roster.</span>
      </div>
    </div>`;
}

// ── Shell (header + tabs) ───────────────────────────────────────────
// Render the avatar for a driver — a real photo if we have one,
// otherwise the initials. The photo URL has a cache-buster appended at
// upload time so a newly-changed photo doesn't keep serving the old
// cached image.
function avatarHtml(session, sizeClass) {
  const name = session?.name || "Driver";
  const url  = session?.photo_url;
  if (url) {
    return `<span class="${sizeClass}" style="background-image:url('${escapeHtml(url)}');background-size:cover;background-position:center"></span>`;
  }
  return `<span class="${sizeClass}">${escapeHtml(initialsOf(name))}</span>`;
}

function renderShell(session) {
  const name = session?.name || "Driver";
  // While the driver is in 'onboarding', the bottom tabbar is pared
  // down to Onboarding + Chat so they can receive instructions from
  // dispatch while they work through the sequential onboarding flow.
  const isOnboarding = session?.status === "onboarding";
  const onboardingTabs = `<nav class="tabbar" role="tablist">
      <button class="tab" data-route="/tasks/onboarding" data-c="tasks" role="tab" aria-label="Onboarding">
        <span class="tab-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg></span>
        Onboarding
      </button>
      <button class="tab" data-route="/schedule" data-c="schedule" role="tab" aria-label="Schedule">
        <span class="tab-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg></span>
        Schedule
      </button>
      <button class="tab" data-route="/chat" data-c="chat" role="tab" aria-label="Chat">
        <span class="tab-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>
        Chat
      </button>
    </nav>`;
  const activeTabs = `<nav class="tabbar" role="tablist">
      <button class="tab" data-route="/profile" data-c="profile" role="tab" aria-label="Profile">
        <span class="tab-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span>
        Profile
      </button>
      <button class="tab" data-route="/schedule" data-c="schedule" role="tab" aria-label="Schedule">
        <span class="tab-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg></span>
        Schedule
      </button>
      <button class="tab" data-route="/tasks" data-c="tasks" role="tab" aria-label="Tasks">
        <span class="tab-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="m9 14 2 2 4-4"/></svg></span>
        Tasks
      </button>
      <button class="tab" data-route="/chat" data-c="chat" role="tab" aria-label="Chat">
        <span class="tab-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>
        Chat
      </button>
      <button class="tab" data-route="/team" data-c="team" role="tab" aria-label="Team">
        <span class="tab-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span>
        Team
      </button>
    </nav>`;
  document.getElementById("app").innerHTML = `
    <header class="app-head">
      <button class="head-back" id="head-back" type="button" aria-label="Back" style="display:none">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <div style="flex:1;min-width:0">
        <div class="title" id="head-title">${escapeHtml(session?.dsp_name || "Driver")}</div>
        <div class="sub" id="head-sub"></div>
      </div>
      <button class="head-gear" id="head-gear" type="button" aria-label="Settings" title="Settings">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>
      </button>
    </header>
    <div id="rr-offline" class="rr-offline" aria-live="polite" role="status">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12" y2="20"/></svg>
      <span id="rr-offline-text">Offline — changes will sync when you're back</span>
    </div>
    <main id="main"><div class="loader"></div></main>
    ${isOnboarding ? onboardingTabs : activeTabs}`;

  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => { _haptic("select"); navigate(t.dataset.route); });
  });
  document.getElementById("head-gear").addEventListener("click", () => { _haptic("tap"); navigate("/settings"); });

  // Wire the offline pill — flips on `offline`, briefly shows a green
  // "back online" confirmation on `online`. Idempotent; safe to call
  // on every shell re-render.
  _wireOfflineBanner();
}

// Position the translucent glass lens behind the active tab's icon.
// Measured from the DOM so the lens lands exactly on the active icon
// regardless of viewport width, safe-area inset, or how many tabs the
// current shell shows (onboarding has 3, the active shell has 5). The
// lens itself is a plain absolutely-positioned element that animates
// transform/width/height — GPU-friendly and respects reduced-motion
// via CSS.
//
// renderShell() wipes #app's innerHTML on every route render, so the
// tabbar (and the lens with it) is destroyed and recreated on each
// tab switch. To keep the slide animation visible across that rebuild
// we cache the previous lens geometry here and, on a freshly mounted
// shell, paint the new lens at the *previous* tab's spot first, then
// move it to the new active tab on the next frame so the CSS
// transition has something to interpolate from.
let _lensState = { x: null, y: null, w: null, h: null };

function _updateTabLens() {
  const bar = document.querySelector(".tabbar");
  if (!bar) return;
  let lens = bar.querySelector(".tab-lens");
  const isFresh = !lens;
  if (isFresh) {
    lens = document.createElement("span");
    lens.className = "tab-lens";
    lens.setAttribute("aria-hidden", "true");
    const inner = document.createElement("span");
    inner.className = "tab-lens-inner";
    lens.appendChild(inner);
    bar.prepend(lens);
  }
  const ic = bar.querySelector(".tab.active .tab-ic");
  if (!ic) {
    lens.classList.remove("ready", "moving");
    return;
  }
  const barRect = bar.getBoundingClientRect();
  const icRect  = ic.getBoundingClientRect();
  // Slightly larger than the icon container so the lens reads as a
  // "magnifier" sitting around the icon, not a flat chip behind it.
  const padX = 3, padY = 2;
  const w = Math.round(icRect.width  + padX * 2);
  const h = Math.round(icRect.height + padY * 2);
  const x = Math.round(icRect.left - barRect.left - padX);
  const y = Math.round(icRect.top  - barRect.top  - padY);

  const applyTarget = () => {
    const prevX = lens._x;
    lens.style.width  = w + "px";
    lens.style.height = h + "px";
    lens.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    lens._x = x;
    if (lens.classList.contains("ready") && prevX != null && Math.abs(prevX - x) > 2) {
      lens.classList.remove("moving");
      void lens.offsetWidth;
      lens.classList.add("moving");
    }
    _lensState = { x, y, w, h };
  };

  if (isFresh && _lensState.x != null) {
    // Seed the new lens at the *previous* active tab's geometry with
    // transitions disabled, then re-enable transitions and move it to
    // the new target on the next frame. The result is a visible slide
    // instead of a teleport on every tab tap.
    lens.style.transition = "none";
    lens.style.width  = _lensState.w + "px";
    lens.style.height = _lensState.h + "px";
    lens.style.transform = `translate3d(${_lensState.x}px, ${_lensState.y}px, 0)`;
    lens._x = _lensState.x;
    lens.classList.add("ready");
    void lens.offsetWidth; // flush the initial paint
    lens.style.transition = "";
    requestAnimationFrame(applyTarget);
    return;
  }

  applyTarget();
  // Reveal on the next frame so the very first paint of a brand-new
  // session doesn't render the lens at 0,0 before snapping into place.
  requestAnimationFrame(() => lens.classList.add("ready"));
}

// Re-align the lens after viewport changes (rotation, on-screen
// keyboard, dev-tools resizes). Wired exactly once.
if (!window._rrTabLensWired) {
  window._rrTabLensWired = true;
  const onResize = () => _updateTabLens();
  window.addEventListener("resize", onResize, { passive: true });
  window.addEventListener("orientationchange", onResize, { passive: true });
}

// Module-scoped so the listeners attach exactly once across re-renders.
let _rrOfflineWired = false;
function _wireOfflineBanner(){
  const set = (state) => {
    const el = document.getElementById("rr-offline");
    const tx = document.getElementById("rr-offline-text");
    if (!el || !tx) return;
    if (state === "offline") {
      el.classList.remove("ok");
      tx.textContent = "Offline — changes will sync when you're back";
      el.classList.add("show");
    } else if (state === "online-briefly") {
      el.classList.add("ok");
      tx.textContent = "Back online";
      el.classList.add("show");
      clearTimeout(el._t);
      el._t = setTimeout(() => el.classList.remove("show"), 1800);
    } else {
      el.classList.remove("show");
    }
  };
  // Paint the initial state.
  if (!navigator.onLine) set("offline");
  if (_rrOfflineWired) return;
  _rrOfflineWired = true;
  window.addEventListener("offline", () => set("offline"));
  window.addEventListener("online",  () => set("online-briefly"));
}

// ── Schedule ────────────────────────────────────────────────────────
async function renderSchedule() {
  setHeader("Schedule", "");
  // Pull-to-refresh: pulling the schedule list re-fetches shifts and
  // any cover offers. Returning the promise lets the indicator spin
  // until the data lands.
  setRefresh(() => renderSchedule());
  const main = document.getElementById("main");
  // Skeleton with a 140ms delay — fast loads never flash a shimmer,
  // slow loads still get a meaningful placeholder. Skip entirely if
  // the page already has rendered content (pull-to-refresh case);
  // the PTR indicator + existing cards are a better story than
  // wiping the screen for a beat.
  const _hadContent = !!main.querySelector(".shift-card, .empty-state");
  const _skelTimer = _hadContent ? null : setTimeout(() => {
    if (currentRoute() === "/schedule") main.innerHTML = shiftSkeletonHtml(3);
  }, 140);
  const _clearSkel = () => { if (_skelTimer) clearTimeout(_skelTimer); };

  // Reset any leftover Cover-offer poller from a previous schedule view.
  _coverOfferTeardown();
  _pickupListTeardown();
  _swapInboxTeardown();
  _shiftConfirmTeardown();

  try {
    const session = readSession();
    if (!session?.token) { writeSession(null); render(); return; }

    const { data, error } = await sb.rpc("driver_my_schedule", { p_token: session.token, p_weeks: 2 });
    if (error) {
      if ((error.message || "").includes("unauthorized") || (error.message || "").includes("revoked") || (error.message || "").includes("inactive")) {
        writeSession(null);
        toast("Signed out — please sign in again", "warn");
        render();
        return;
      }
      _clearSkel();
      main.innerHTML = `<div class="rr-empty"><div class="rr-empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div><div class="rr-empty-title">Couldn't load your schedule</div><div class="rr-empty-sub">${escapeHtml(_friendlyError(error, "Pull down to retry."))}</div></div>`;
      return;
    }

    const rawShifts = Array.isArray(data?.shifts) ? data.shifts : [];
    // Training Day 1 + Day 2 land in the schedule on consecutive dates
    // — when both are present, the second one carries a "Day 2" suffix
    // so the trainee can tell them apart at a glance.
    const trainingByIso = new Map();
    for (const s of rawShifts) {
      if (s.shift_kind === "training") trainingByIso.set(s.date, (trainingByIso.get(s.date) || 0) + 1);
    }
    const trainingDates = rawShifts
      .filter(s => s.shift_kind === "training")
      .map(s => s.date)
      .sort();
    const trainingDayIndex = new Map();
    trainingDates.forEach((d, i) => { if (!trainingDayIndex.has(d)) trainingDayIndex.set(d, i + 1); });
    const shifts = rawShifts.map((s) => ({
      id:        s.id,
      date:      new Date(s.date + "T12:00:00"),
      iso:       s.date,
      starts_at: s.starts_at,
      ends_at:   s.ends_at,
      // wave_starts_at = the actual route departure time. starts_at is
      // when the driver clocks in (= wave - report_lead_minutes). When
      // the DSP hasn't set a lead, the two are equal and the app
      // collapses the display back to a single time.
      wave_starts_at:     s.wave_starts_at || s.starts_at,
      reportLeadMinutes:  s.report_lead_minutes || 0,
      station:   s.station_code || "",
      status:    s.status,
      type:      s.service_type_code || "",
      typeColor: s.service_type_color || "",
      isCushion: !!s.is_cushion,
      shiftKind: s.shift_kind || "regular",
      trainerName: s.trainer_name || "",
      trainingDay: s.shift_kind === "training" ? (trainingDayIndex.get(s.date) || 1) : 0,
      stationLat: Number(s.station_latitude),
      stationLng: Number(s.station_longitude),
    })).filter((s) => ["scheduled", "completed"].includes(s.status));

    const todayIso = fmtIsoDate(new Date());
    const todayShifts    = shifts.filter((s) => s.iso === todayIso);
    const upcomingShifts = shifts.filter((s) => s.iso > todayIso);

    // Which van you're on, by date — from the dispatch van-assignment
    // chains, resolved against the schedule (primary when scheduled and
    // in service; the backup picks it up when the primary isn't).
    // vanByIso: date → { name, isRotation }. `isRotation` is true
    // when the assigned van isn't part of the driver's standing
    // chain — i.e., they got a non-default van today via FEM
    // rescue, pool fill, or a manual rotation. Surfaced as a
    // calm "(rotation)" sub-note on the shift card so the
    // driver knows why they're not on their usual van.
    const vanByIso = new Map();
    try {
      const vRes = await sb.rpc("driver_vehicle_days", { p_token: session.token });
      for (const r of (Array.isArray(vRes?.data) ? vRes.data : [])) {
        if (r && r.date && r.vehicle) {
          // is_chain_match may be missing on older RPC builds;
          // treat undefined as "true" so we don't false-flag
          // chain assignments as rotations.
          const isRotation = (r.is_chain_match === false) || r.via === "rotation";
          vanByIso.set(r.date, { name: r.vehicle, isRotation });
        }
      }
    } catch (e) { /* no van data — schedule renders without it */ }

    if (shifts.length === 0) {
      // Always show *something* so the page is never blank — explain
      // what would land here and what to do if the driver expects
      // shifts that aren't showing up. The Cover-offer card still
      // mounts above so a pending offer is visible even on an empty week.
      _clearSkel();
      main.innerHTML = `
        <div id="rr-cover-offer-slot"></div>
        <div class="empty-state" style="padding:48px 20px;text-align:center">
          <div style="font-size:var(--fs-lg);font-weight:600;color:var(--text);margin-bottom:6px">No shifts scheduled</div>
          <div style="color:var(--text-subtle);line-height:1.5;max-width:320px;margin:0 auto">
            Your dispatcher hasn't published a schedule yet for the next two weeks, or you haven't been assigned to any of the open shifts.  Check back tomorrow or message dispatch.
          </div>
        </div>
        <div id="rr-pickup-slot"></div>`;
      _coverOfferStart(session.token);
      _pickupListStart(session.token);
      _rrLiveStart(session.driver_id);
      return;
    }

    _clearSkel();
    // Split the upcoming shifts at the end of the current calendar week
    // (Saturday) so the list reads as "This week" / "Next week" instead
    // of one long undifferentiated "Upcoming" run.
    const _todayD = new Date(todayIso + "T12:00:00");
    const _satEnd = new Date(_todayD);
    _satEnd.setDate(_todayD.getDate() + (6 - _todayD.getDay()));
    const _satIso = fmtIsoDate(_satEnd);
    const thisWeek = upcomingShifts.filter((s) => s.iso <= _satIso);
    const nextWeek = upcomingShifts.filter((s) => s.iso >  _satIso);
    const groupHtml = (label, arr) => arr.length
      ? `<div class="section-title">${label}</div>${arr.map((s) => shiftCardHtml(s, false, vanByIso.get(s.iso), { swappable: true })).join("")}`
      : "";
    main.innerHTML = `
      <div id="rr-shift-confirm-slot"></div>
      <div id="rr-cover-offer-slot"></div>
      <div id="rr-swap-incoming-slot"></div>
      ${_schedStripHtml(shifts, todayIso)}
      ${todayShifts.map((s) => _schedSpotlightHtml(s, vanByIso.get(s.iso))).join("")}
      ${groupHtml("This week", thisWeek)}
      ${groupHtml("Next week", nextWeek)}
      ${(!todayShifts.length && !upcomingShifts.length) ? `<div class="empty-state">No upcoming shifts.</div>` : ""}
      <div id="rr-pickup-slot"></div>`;

    // Pinned cards at the top — Cover offers, swap incoming, AND
    // any pending 5th-day-pass shift offers waiting on the driver's
    // confirm/decline. Each fetches separately so a single failure
    // never blocks the rest of the render. Cards self-hide when
    // empty so they take up zero space the rest of the time.
    _shiftConfirmStart(session.token);
    _coverOfferStart(session.token);
    _pickupListStart(session.token);
    _swapInboxStart(session.token);
    _rrLiveStart(session.driver_id);
    _hydrateShiftWeather([...todayShifts, ...upcomingShifts]);
  } catch (err) {
    // A thrown error inside renderSchedule used to kill the whole
    // render and leave main empty.  Surface it instead.
    console.error("renderSchedule failed:", err);
    _clearSkel();
    main.innerHTML = errorStateHtml("Schedule couldn't load", err);
  }
}

// ── Cover-offer pinned card ──────────────────────────────────────────
// When dispatch sends a "cover this shift" offer to this driver, it
// surfaces as an Accept / Pass card pinned above the schedule list.
// We poll driver_offer_list while the schedule view is active (drivers
// don't have a Supabase auth.uid so postgres_changes won't deliver
// ─── 5th-day pass · pending shift confirmation requests ─────────
// Operator runs the 5th-day overtime pass with "Send for
// confirmation" mode → the dashboard files a shift_confirmation_
// requests row per proposed assignment. Driver app fetches the
// pending ones here and surfaces Accept/Decline cards above the
// regular schedule. On Accept the migration's RPC creates the
// actual shifts row; the next schedule refresh shows it.
let _shiftConfirmTimer = null;
function _shiftConfirmTeardown() {
  if (_shiftConfirmTimer) { clearInterval(_shiftConfirmTimer); _shiftConfirmTimer = null; }
}
function _shiftConfirmStart(token) {
  _shiftConfirmTeardown();
  const tick = async () => {
    const slot = document.getElementById("rr-shift-confirm-slot");
    if (!slot) { _shiftConfirmTeardown(); return; }
    try {
      const { data, error } = await sb.rpc("driver_pending_shift_confirmations", { p_token: token });
      if (error) { _shiftConfirmTeardown(); return; }
      const reqs = Array.isArray(data?.requests) ? data.requests : [];
      if (reqs.length === 0) { slot.innerHTML = ""; return; }
      slot.innerHTML = `
        <div class="section-title">Shift offers · please confirm</div>
        ${reqs.map((r) => {
          const sh = r.proposed_shift || {};
          const dateLabel = sh.date
            ? new Date(sh.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
            : "";
          const timeLabel = (sh.starts_at && sh.ends_at)
            ? `${new Date(sh.starts_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} – ${new Date(sh.ends_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
            : "";
          const expiresHrs = Math.max(1, Math.round((new Date(r.expires_at).getTime() - Date.now()) / 3600000));
          return `
            <div class="shift-card shift-card-confirm" data-rr-confirm-id="${escapeHtml(r.id)}">
              <div class="shift-card-body">
                <div class="shift-card-line shift-card-title">Extra shift offered</div>
                <div class="shift-card-line shift-card-sub">${escapeHtml(dateLabel)}${timeLabel ? ` · ${escapeHtml(timeLabel)}` : ""}${sh.route_code ? ` · ${escapeHtml(sh.route_code)}` : ""}</div>
                <div class="shift-card-line shift-card-meta">Confirm within ${expiresHrs} hour${expiresHrs === 1 ? "" : "s"} or this offer expires.</div>
                <div class="shift-card-confirm-actions">
                  <button type="button" class="btn btn-primary btn-sm" data-rr-confirm-accept="${escapeHtml(r.id)}">Accept</button>
                  <button type="button" class="btn btn-ghost btn-sm" data-rr-confirm-decline="${escapeHtml(r.id)}">Decline</button>
                </div>
              </div>
            </div>`;
        }).join("")}`;
    } catch (err) { /* swallow — try again next tick */ }
  };
  tick();
  _shiftConfirmTimer = setInterval(tick, 30000);
}

// ── Live updates · instant delivery instead of 15–30s polling ────────
// Drivers have no Supabase auth.uid, so RLS-filtered postgres_changes
// can't reach them (that's why the pinned cards poll). Instead the server
// broadcasts a content-free "refresh" ping to the public topic
// rr-driver-live-<driver_id> whenever a cover offer / swap / confirmation
// is created for this driver (migration 0426). We subscribe once per
// session and re-run the pollers' fetches the instant a ping arrives, so
// the card shows up immediately instead of on the next tick. The pollers
// keep running as a fallback — if Realtime is unavailable this is simply a
// no-op and nothing regresses.
let _rrLiveChannel = null;
function _rrLiveStart(driverId) {
  if (!driverId || _rrLiveChannel) return;
  try {
    _rrLiveChannel = sb
      .channel("rr-driver-live-" + driverId, { config: { broadcast: { self: false } } })
      .on("broadcast", { event: "refresh" }, () => _rrLiveRefresh())
      .subscribe();
  } catch { _rrLiveChannel = null; }
}
function _rrLiveStop() {
  if (_rrLiveChannel) { try { sb.removeChannel(_rrLiveChannel); } catch {} _rrLiveChannel = null; }
}
function _rrLiveRefresh() {
  const token = (typeof readSession === "function" ? readSession() : null)?.token;
  if (!token) return;
  // Re-fetch whatever pinned cards are mounted. Each refresher no-ops if
  // its slot isn't on screen, so calling all of them is safe and cheap.
  try { _coverOfferRefresh(token); } catch {}
  try { _pickupListRefresh(token); } catch {}
  try { _swapInboxRefresh(token); } catch {}
  try { _shiftConfirmStart(token); } catch {}
}

// Delegated handler — Accept / Decline buttons on the confirm cards.
// Installed once at module load.
document.addEventListener("click", async (e) => {
  const accept = e.target.closest("[data-rr-confirm-accept]");
  const decline = e.target.closest("[data-rr-confirm-decline]");
  if (!accept && !decline) return;
  e.preventDefault();
  const session = readSession();
  if (!session?.token) return;
  const id = (accept || decline).getAttribute(accept ? "data-rr-confirm-accept" : "data-rr-confirm-decline");
  const decision = accept ? "accept" : "decline";
  const btn = accept || decline;
  btn.disabled = true;
  try {
    const { error } = await sb.rpc("driver_respond_to_shift_confirmation", {
      p_token: session.token,
      p_request_id: id,
      p_decision: decision,
    });
    if (error) { toast(_friendlyError(error, "Couldn't update offer. Try again."), "warn"); btn.disabled = false; return; }
    toast(decision === "accept" ? "Shift added to your schedule" : "Offer declined", decision === "accept" ? "success" : "info");
    // Refresh confirmation list AND main schedule so the new
    // shift (if accepted) shows up immediately.
    if (typeof renderSchedule === "function") renderSchedule();
    else { const card = document.querySelector(`[data-rr-confirm-id="${id}"]`); if (card) card.remove(); }
  } catch (err) {
    console.warn("respond to shift offer:", err);
    toast("Couldn't update offer · try again", "warn");
    btn.disabled = false;
  }
});

// ─── Cover-offer pinned card ──────────────────────────────────
let _coverOfferTimer = null;
let _coverOfferKnown = null;   // last fetched offer (cached for re-paint)
function _coverOfferTeardown() {
  if (_coverOfferTimer) { clearInterval(_coverOfferTimer); _coverOfferTimer = null; }
  _coverOfferKnown = null;
}
function _coverOfferStart(token) {
  _coverOfferTeardown();
  const pull = () => _coverOfferRefresh(token);
  pull();
  _coverOfferTimer = setInterval(pull, 15000);
}
async function _coverOfferRefresh(token) {
  const slot = document.getElementById("rr-cover-offer-slot");
  if (!slot) { _coverOfferTeardown(); return; }
  try {
    const { data, error } = await sb.rpc("driver_offer_list", { p_token: token });
    if (error) return;   // soft fail; the schedule itself still renders
    const offers = Array.isArray(data?.offers) ? data.offers : [];
    const offer = offers[0] || null;   // one pending at a time
    _coverOfferKnown = offer;
    _coverOfferPaint(slot, offer, token);
  } catch { /* network blip — try again on next tick */ }
}
function _coverOfferPaint(slot, offer, token) {
  if (!offer) { slot.innerHTML = ""; return; }
  const date = new Date(offer.date + "T12:00:00");
  const dateLbl = date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const start = offer.starts_at ? new Date(offer.starts_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
  const end   = offer.ends_at   ? new Date(offer.ends_at).toLocaleTimeString(undefined,   { hour: "numeric", minute: "2-digit" }) : "";
  const time  = start && end ? `${start} – ${end}` : start;
  const ms = Math.max(0, new Date(offer.expires_at).getTime() - Date.now());
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const timer = `${m}:${String(s).padStart(2, "0")}`;

  slot.innerHTML = `
    <div class="rr-cover-card" style="background:var(--surface);border:1px solid var(--accent);border-radius:14px;padding:16px;margin-bottom:18px;box-shadow:0 4px 18px -8px rgba(37,99,235,.25)">
      <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)">Dispatch offer</div>
      <div style="margin-top:4px;font-size:18px;font-weight:700;color:var(--text)">Cover ${escapeHtml(offer.route_code || "a route")}</div>
      <div style="margin-top:2px;font-size:var(--fs-sm);color:var(--text-muted)">${escapeHtml(dateLbl)}${time ? " · " + escapeHtml(time) : ""}${offer.station_code ? " · " + escapeHtml(offer.station_code) : ""}</div>
      <div style="margin-top:10px;font-size:var(--fs-xs);color:var(--text-subtle);font-variant-numeric:tabular-nums">Respond within <strong id="rr-cover-offer-timer" style="color:var(--text)">${timer}</strong></div>
      <div style="display:flex;gap:10px;margin-top:14px">
        <button class="btn btn-primary" style="flex:1" data-rr-cover-accept="${offer.id}">Accept</button>
        <button class="btn btn-ghost"   style="flex:1" data-rr-cover-pass="${offer.id}">Pass</button>
      </div>
    </div>`;

  slot.querySelector("[data-rr-cover-accept]").addEventListener("click", (e) => _coverOfferRespond(e.currentTarget.getAttribute("data-rr-cover-accept"), true, token));
  slot.querySelector("[data-rr-cover-pass]"  ).addEventListener("click", (e) => _coverOfferRespond(e.currentTarget.getAttribute("data-rr-cover-pass"),   false, token));
}
async function _coverOfferRespond(offerId, accept, token) {
  const btns = document.querySelectorAll(".rr-cover-card button");
  btns.forEach((b) => (b.disabled = true));
  const { data, error } = await sb.rpc("driver_offer_respond", {
    p_token: token, p_offer_id: offerId, p_accept: accept, p_reason: null,
  });
  if (error) {
    btns.forEach((b) => (b.disabled = false));
    toast(_friendlyError(error, "Couldn't send response. Try again."), "warn");
    return;
  }
  toast(accept ? "Shift accepted" : "Passed", accept ? "success" : "warn");
  _coverOfferTeardown();
  // Re-render the schedule so any newly assigned shift appears.
  renderSchedule();
}


// ── Open-shift pickup ────────────────────────────────────────────────
// When the driver's DSP has enabled self-service pickup, eligible open
// shifts surface as a list at the bottom of /schedule. One tap opens
// a confirm; on confirm the shift atomically reassigns to the driver
// (or returns a friendly error if someone else got there first).
// Polled while /schedule is mounted; same cadence as Cover offers.
let _pickupTimer = null;
function _pickupListTeardown() {
  if (_pickupTimer) { clearInterval(_pickupTimer); _pickupTimer = null; }
}
function _pickupListStart(token) {
  _pickupListTeardown();
  const pull = () => _pickupListRefresh(token);
  pull();
  _pickupTimer = setInterval(pull, 20000);
}
async function _pickupListRefresh(token) {
  const slot = document.getElementById("rr-pickup-slot");
  if (!slot) { _pickupListTeardown(); return; }
  try {
    const { data, error } = await sb.rpc("driver_open_shifts_list", { p_token: token });
    if (error) return;
    if (!data?.enabled) { slot.innerHTML = ""; return; }
    const shifts = Array.isArray(data.shifts) ? data.shifts : [];
    _pickupListPaint(slot, shifts, token);
  } catch { /* network blip — try again on next tick */ }
}
function _pickupListPaint(slot, shifts, token) {
  if (!shifts.length) { slot.innerHTML = ""; return; }
  slot.innerHTML = `
    <div class="section-title" style="margin-top:24px">Available shifts</div>
    <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin:-4px 0 10px">Open routes you're eligible for. First to claim wins.</div>
    ${shifts.map((s) => {
      const d = new Date(s.date + "T12:00:00");
      const dateLbl = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      const start = s.starts_at ? new Date(s.starts_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
      const end   = s.ends_at   ? new Date(s.ends_at).toLocaleTimeString(undefined,   { hour: "numeric", minute: "2-digit" }) : "";
      const time  = start && end ? `${start} – ${end}` : start;
      return `
        <div class="rr-pickup-row" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;background:var(--surface);border:1px solid var(--border);border-radius:12px;margin-bottom:10px">
          <div style="min-width:0;flex:1">
            <div style="font-weight:700;color:var(--text);font-size:var(--fs-md)">${escapeHtml(s.route_code || "Route")} · ${escapeHtml(dateLbl)}</div>
            <div style="margin-top:2px;font-size:var(--fs-xs);color:var(--text-subtle)">${escapeHtml(time || "")}${s.station_code ? " · " + escapeHtml(s.station_code) : ""}${s.block_hours ? " · " + s.block_hours + "h" : ""}</div>
          </div>
          <button class="btn btn-primary" data-rr-pickup="${s.id}">Pick up</button>
        </div>`;
    }).join("")}`;
  slot.querySelectorAll("[data-rr-pickup]").forEach((b) => {
    b.addEventListener("click", () => _pickupConfirm(b.getAttribute("data-rr-pickup"), token, b));
  });
}
async function _pickupConfirm(shiftId, token, btn) {
  const ok = await confirmSheet({
    title: "Pick up this shift?",
    message: "Dispatch will be notified and the shift becomes yours.",
    confirmText: "Yes, pick it up",
  });
  if (!ok) return;
  _haptic("tap");
  if (btn) { btn.disabled = true; btn.textContent = "Claiming…"; }
  const { data, error } = await sb.rpc("driver_open_shift_pickup", {
    p_token: token, p_shift_id: shiftId,
  });
  if (error) {
    if (btn) { btn.disabled = false; btn.textContent = "Pick up"; }
    const msg = (error.message || "").includes("shift_already_taken")
      ? "Someone got there first"
      : _friendlyError(error, "Couldn't pick up that shift. Try again.");
    toast(msg, "warn");
    // Refresh the list — the taken shift will drop off automatically.
    _pickupListRefresh(token);
    return;
  }
  toast("Shift added to your schedule", "success");
  _pickupListTeardown();
  renderSchedule();
}


// ── Shift swaps ──────────────────────────────────────────────────────
// Driver A offers their assigned shift in exchange for Driver B's
// upcoming shift. B sees a pinned request card on their schedule
// (driver_swap_list); on accept the server runs a compliance check
// and either flips both shifts atomically or rejects with a reason.
let _swapInboxTimer = null;
function _swapInboxTeardown() {
  if (_swapInboxTimer) { clearInterval(_swapInboxTimer); _swapInboxTimer = null; }
}
function _swapInboxStart(token) {
  _swapInboxTeardown();
  const pull = () => _swapInboxRefresh(token);
  pull();
  _swapInboxTimer = setInterval(pull, 20000);
}
async function _swapInboxRefresh(token) {
  const slot = document.getElementById("rr-swap-incoming-slot");
  if (!slot) { _swapInboxTeardown(); return; }
  try {
    const { data, error } = await sb.rpc("driver_swap_list", { p_token: token });
    if (error) return;
    const reqs = Array.isArray(data?.requests) ? data.requests : [];
    _swapInboxPaint(slot, reqs, token);
  } catch { /* network blip */ }
}
function _swapInboxPaint(slot, reqs, token) {
  if (!reqs.length) { slot.innerHTML = ""; return; }
  const fmtShiftLine = (sh) => {
    const d = new Date(sh.date + "T12:00:00");
    const dateLbl = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const start = sh.starts_at ? new Date(sh.starts_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
    const end   = sh.ends_at   ? new Date(sh.ends_at).toLocaleTimeString(undefined,   { hour: "numeric", minute: "2-digit" }) : "";
    const time  = start && end ? `${start} – ${end}` : start;
    return `${escapeHtml(sh.route_code || "Route")} · ${escapeHtml(dateLbl)}${time ? " · " + escapeHtml(time) : ""}`;
  };
  slot.innerHTML = reqs.map((r) => `
    <div class="rr-swap-card" data-rr-swap-id="${escapeHtml(r.id)}" style="background:var(--surface);border:1px solid var(--accent);border-radius:14px;padding:16px;margin-bottom:14px;box-shadow:0 4px 18px -8px rgba(37,99,235,.18)">
      <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)">Swap request</div>
      <div style="margin-top:4px;font-size:var(--fs-md);font-weight:700;color:var(--text)">${escapeHtml(r.requester_name || "A driver")} wants to swap</div>
      <div style="margin-top:10px;display:grid;grid-template-columns:1fr;gap:8px;font-size:var(--fs-sm);color:var(--text-muted)">
        <div><strong style="color:var(--text);font-size:var(--fs-xs);font-weight:700;letter-spacing:.06em;text-transform:uppercase">They give you</strong><br>${fmtShiftLine(r.their_shift)}</div>
        <div><strong style="color:var(--text);font-size:var(--fs-xs);font-weight:700;letter-spacing:.06em;text-transform:uppercase">You give them</strong><br>${fmtShiftLine(r.your_shift_to_give)}</div>
      </div>
      ${r.message ? `<div style="margin-top:10px;padding:10px 12px;background:var(--canvas);border-radius:8px;font-size:var(--fs-xs);color:var(--text-muted);font-style:italic">"${escapeHtml(r.message)}"</div>` : ""}
      <div style="display:flex;gap:10px;margin-top:14px">
        <button class="btn btn-primary" style="flex:1" data-rr-swap-accept="${escapeHtml(r.id)}">Accept</button>
        <button class="btn btn-ghost"   style="flex:1" data-rr-swap-decline="${escapeHtml(r.id)}">Decline</button>
      </div>
    </div>`).join("");
  slot.querySelectorAll("[data-rr-swap-accept]").forEach((b) => b.addEventListener("click", (e) => _swapRespond(e.currentTarget.getAttribute("data-rr-swap-accept"), true,  token)));
  slot.querySelectorAll("[data-rr-swap-decline]").forEach((b) => b.addEventListener("click", (e) => _swapRespond(e.currentTarget.getAttribute("data-rr-swap-decline"), false, token)));
}
async function _swapRespond(reqId, accept, token) {
  const card = document.querySelector(`[data-rr-swap-id="${CSS.escape(reqId)}"]`);
  if (card) card.querySelectorAll("button").forEach((b) => (b.disabled = true));
  const { data, error } = await sb.rpc("driver_swap_respond", {
    p_token: token, p_request_id: reqId, p_accept: accept,
  });
  if (error) {
    if (card) card.querySelectorAll("button").forEach((b) => (b.disabled = false));
    toast(_friendlyError(error, "Couldn't respond. Try again."), "warn");
    return;
  }
  if (data?.status === "blocked") {
    const reason = ({
      shift_missing:        "One of the shifts isn't there anymore.",
      your_shift_changed:   "Your shift changed before you could accept.",
      their_shift_changed:  "Their shift changed before you could accept.",
      shift_in_past:        "One of the shifts is no longer in the future.",
      compliance_failed:    "Compliance check blocked the swap (license, certs, hours, or rest).",
    })[data?.reason] || "The swap was blocked.";
    toast(reason, "warn");
  } else {
    toast(accept ? "Swap completed" : "Declined", accept ? "success" : "warn");
  }
  _swapInboxTeardown();
  renderSchedule();
}

// Outgoing — driver opens "Offer swap" on one of their upcoming shifts,
// picks a target shift from the swap pool, and submits. Modal renders
// inline; cancelled on backdrop tap.
async function openSwapModal(myShiftId, token) {
  let m = document.getElementById("rr-swap-modal");
  if (m) m.remove();
  m = document.createElement("div");
  m.id = "rr-swap-modal";
  m.style.cssText = "position:fixed;inset:0;background:var(--overlay);z-index:200;display:flex;align-items:flex-end;justify-content:center";
  m.innerHTML = `
    <div style="background:var(--surface);width:100%;max-width:480px;max-height:85vh;border-top-left-radius:18px;border-top-right-radius:18px;display:flex;flex-direction:column;overflow:hidden">
      <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
        <div style="font-weight:700;font-size:var(--fs-md)">Offer a swap</div>
        <button type="button" data-rr-swap-close style="appearance:none;background:transparent;border:0;color:var(--text-subtle);cursor:pointer;padding:6px"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div id="rr-swap-modal-body" style="flex:1;overflow-y:auto;padding:14px 18px"><div class="loader" style="margin:24px auto"></div></div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-rr-swap-close]")) m.remove(); });

  const { data, error } = await sb.rpc("driver_swap_pool", { p_token: token });
  const body = document.getElementById("rr-swap-modal-body");
  if (!body) return;
  if (error) {
    body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--red)">${escapeHtml(_friendlyError(error, "Couldn't load the swap pool. Try again in a moment."))}</div>`;
    return;
  }
  if (!data?.enabled) {
    body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-subtle);line-height:1.55">Shift swaps aren't enabled at your DSP. Talk to dispatch if you'd like to use them.</div>`;
    return;
  }
  const shifts = Array.isArray(data.shifts) ? data.shifts : [];
  if (!shifts.length) {
    body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-subtle);line-height:1.55">No other drivers have an upcoming shift you can swap for right now.</div>`;
    return;
  }
  body.innerHTML = `
    <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-bottom:10px">Pick the shift you'd like in exchange for yours.</div>
    ${shifts.map((s) => {
      const d = new Date(s.date + "T12:00:00");
      const dateLbl = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      const start = s.starts_at ? new Date(s.starts_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
      const end   = s.ends_at   ? new Date(s.ends_at).toLocaleTimeString(undefined,   { hour: "numeric", minute: "2-digit" }) : "";
      const time  = start && end ? `${start} – ${end}` : start;
      return `
        <button class="rr-swap-pool-row" data-rr-swap-target="${escapeHtml(s.shift_id)}" style="display:flex;align-items:center;justify-content:space-between;width:100%;gap:12px;padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:12px;margin-bottom:8px;text-align:left;cursor:pointer">
          <div style="min-width:0;flex:1">
            <div style="font-weight:700;color:var(--text);font-size:var(--fs-md)">${escapeHtml(s.driver_name || "Driver")}</div>
            <div style="margin-top:2px;font-size:var(--fs-xs);color:var(--text-muted)">${escapeHtml(s.route_code || "Route")} · ${escapeHtml(dateLbl)}${time ? " · " + escapeHtml(time) : ""}${s.station_code ? " · " + escapeHtml(s.station_code) : ""}</div>
          </div>
          <span style="font-size:var(--fs-xs);font-weight:600;color:var(--accent)">Pick →</span>
        </button>`;
    }).join("")}`;
  body.querySelectorAll("[data-rr-swap-target]").forEach((b) => {
    b.addEventListener("click", () => _swapSubmit(myShiftId, b.getAttribute("data-rr-swap-target"), token, m));
  });
}
async function _swapSubmit(myShiftId, targetShiftId, token, modal) {
  const ok = await confirmSheet({
    title: "Send swap request?",
    message: "The other driver gets notified. They can accept or decline.",
    confirmText: "Send request",
  });
  if (!ok) return;
  _haptic("tap");
  const { data, error } = await sb.rpc("driver_swap_request", {
    p_token: token, p_my_shift_id: myShiftId, p_target_shift_id: targetShiftId, p_message: null,
  });
  if (error) {
    toast(_friendlyError(error, "Couldn't send. Try again."), "warn");
    return;
  }
  toast("Swap request sent", "success");
  if (modal) modal.remove();
}

// Delegate "Offer swap" link clicks anywhere on the schedule view.
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-rr-swap-from]");
  if (!a) return;
  e.preventDefault();
  const token = readSession()?.token;
  if (!token) return;
  openSwapModal(a.getAttribute("data-rr-swap-from"), token);
});


// Shift card · date block on the left, time/station in the middle. No
// chevron (cards aren't tappable yet) and no "Scheduled" tag (every
// non-completed shift is scheduled — redundant). Only badges that
// carry information appear: Completed, service type, EX cushion.
function shiftCardHtml(s, isToday, vanInfo, opts) {
  // Back-compat: callers passed a plain string for vanName before
  // the chain-match RPC change. Accept either shape.
  const vanName     = (vanInfo && typeof vanInfo === "object") ? vanInfo.name : vanInfo;
  const isRotation  = !!(vanInfo && typeof vanInfo === "object" && vanInfo.isRotation);
  const dow = s.date.toLocaleDateString(undefined, { weekday: "short" });
  const day = s.date.getDate();
  const month = s.date.toLocaleDateString(undefined, { month: "short" });

  const startTxt = s.starts_at ? fmtTime(s.starts_at) : "";
  const endTxt   = s.ends_at   ? fmtTime(s.ends_at)   : "";
  const timeTxt  = startTxt && endTxt ? `${startTxt} – ${endTxt}` : (startTxt || endTxt || "");

  const isTraining = s.shiftKind === "training";
  const isRideAlong = s.shiftKind === "ride_along";
  const isOnboardingShift = isTraining || isRideAlong;

  // ── Scannable row ─────────────────────────────────────────────────
  // The date + hours are the signal that changes day to day, so they
  // carry the weight. Everything constant (station · van · type · wave)
  // collapses to one quiet line — a driver on the same van/station all
  // week isn't made to re-read it on every card. Anything *exceptional*
  // (a rotation van, training, a cushion shift, a completed day) breaks
  // out as a colored chip so the eye catches it.
  const lineBits = [];
  if (s.station) lineBits.push(escapeHtml(s.station));
  if (vanName && !isRotation) lineBits.push(escapeHtml(vanName));
  if (s.type && s.type !== "SP") lineBits.push(escapeHtml(s.type));
  const line = lineBits.join(" · ");

  const chips = [];
  if (isRotation && vanName) chips.push(`<span class="sc-chip sc-chip-rot">${escapeHtml(vanName)} · rotation</span>`);
  if (isTraining) chips.push(`<span class="sc-chip sc-chip-train">Class · Day ${escapeHtml(String(s.trainingDay || 1))}</span>`);
  else if (isRideAlong) { const tn = s.trainerName ? s.trainerName.split(/\s+/)[0] : ""; chips.push(`<span class="sc-chip sc-chip-road">${tn ? `Road · ${escapeHtml(tn)}` : "Road"}</span>`); }
  if (s.isCushion) chips.push(`<span class="sc-chip sc-chip-cushion">Cushion</span>`);
  if (s.status === "completed") chips.push(`<span class="sc-chip sc-chip-done">Completed</span>`);

  // Weather chip is filled in async after render — see _hydrateShiftWeather.
  const wxSlot = s.iso && s.status === "scheduled"
    ? `<div class="shift-weather" data-wx-iso="${escapeHtml(s.iso)}" hidden></div>`
    : "";
  return `
    <div class="shift-card ${isToday ? "is-today" : ""}">
      <div class="date-block">
        <div class="date-dow">${dow}</div>
        <div class="date-day">${day}</div>
        <div class="date-month">${month}</div>
      </div>
      <div class="sc-main">
        <div class="sc-time">${escapeHtml(timeTxt)}</div>
        ${line ? `<div class="sc-line">${line}</div>` : ""}
        ${chips.length ? `<div class="sc-chips">${chips.join("")}</div>` : ""}
        ${wxSlot}
        ${opts?.swappable && s.status === "scheduled" && !isOnboardingShift ? `
          <div class="sc-swap"><a href="#" class="rr-text-link" data-rr-swap-from="${escapeHtml(s.id)}">Offer swap</a></div>
        ` : ""}
      </div>
    </div>`;
}

// ── Schedule · shared meta cells ────────────────────────────────────
// The labeled value cells (Station · Van · Wave · Type · Training ·
// Cushion) shared by the "today" spotlight card. Mirrors the contract
// in shiftCardHtml so both surfaces read as one system.
function _shiftMetaCells(s, vanInfo, { withStation } = {}) {
  const vanName    = (vanInfo && typeof vanInfo === "object") ? vanInfo.name : vanInfo;
  const isRotation = !!(vanInfo && typeof vanInfo === "object" && vanInfo.isRotation);
  const hasLead = s.reportLeadMinutes > 0 && s.wave_starts_at
    && new Date(s.wave_starts_at).getTime() !== new Date(s.starts_at).getTime();
  const waveTxt = hasLead ? fmtTime(s.wave_starts_at) : "";
  const isTraining = s.shiftKind === "training";
  const isRideAlong = s.shiftKind === "ride_along";
  const cells = [];
  if (withStation && s.station) {
    cells.push(`<div class="sc-cell"><div class="sc-cell-l">Station</div><div class="sc-cell-v">${escapeHtml(s.station)}</div></div>`);
  }
  if (vanName) {
    const rot = isRotation ? ` <span class="sc-cell-rotation">Rotation</span>` : "";
    cells.push(`<div class="sc-cell"><div class="sc-cell-l">Van</div><div class="sc-cell-v sc-cell-v--van">${escapeHtml(vanName)}${rot}</div></div>`);
  }
  if (waveTxt) {
    cells.push(`<div class="sc-cell"><div class="sc-cell-l">Wave</div><div class="sc-cell-v">${escapeHtml(waveTxt)}</div></div>`);
  }
  if (s.type && s.type !== "SP") {
    const stStyle = s.typeColor ? ` style="color:${escapeHtml(s.typeColor)}"` : "";
    cells.push(`<div class="sc-cell"><div class="sc-cell-l">Type</div><div class="sc-cell-v"${stStyle}>${escapeHtml(s.type)}</div></div>`);
  }
  if (isTraining) {
    cells.push(`<div class="sc-cell"><div class="sc-cell-l">Training</div><div class="sc-cell-v sc-cell-v--train">Class · Day ${escapeHtml(String(s.trainingDay || 1))}</div></div>`);
  } else if (isRideAlong) {
    const tn = s.trainerName ? s.trainerName.split(/\s+/)[0] : "";
    cells.push(`<div class="sc-cell"><div class="sc-cell-l">Training</div><div class="sc-cell-v sc-cell-v--road">${tn ? `Road · ${escapeHtml(tn)}` : "Road"}</div></div>`);
  }
  if (s.isCushion) {
    cells.push(`<div class="sc-cell"><div class="sc-cell-l">Shift</div><div class="sc-cell-v sc-cell-v--ex">Cushion</div></div>`);
  }
  return cells.join("");
}

// ── Schedule · two-week overview strip ──────────────────────────────
// A calendar-aligned mini-grid of the current + next week. Working days
// fill accent-soft (today solid accent); off days stay quiet; past days
// dim. Gives the driver the *shape* of their fortnight at a glance — the
// answer to "when am I off?" without scrolling the card list.
function _schedStripHtml(shifts, todayIso) {
  const onIso = new Map(shifts.map((s) => [s.iso, s.shiftKind || "regular"]));
  const today = new Date(todayIso + "T12:00:00");
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay()); // back up to Sunday
  const cell = (i) => {
    const d = new Date(weekStart); d.setDate(weekStart.getDate() + i);
    const iso = fmtIsoDate(d);
    const kind = onIso.get(iso);
    const on = !!kind;
    const isToday = iso === todayIso;
    const isPast = iso < todayIso;
    const isTrain = kind === "training" || kind === "ride_along";
    const cls = ["ss-cell", on ? "ss-on" : "ss-off", isToday ? "ss-today" : "", isPast ? "ss-past" : "", isTrain ? "ss-train" : ""].filter(Boolean).join(" ");
    return `<div class="${cls}" aria-hidden="true"><span class="ss-num">${d.getDate()}</span></div>`;
  };
  const cells = Array.from({ length: 14 }, (_, i) => cell(i));
  const dowH = ["S", "M", "T", "W", "T", "F", "S"].map((x) => `<div class="ss-dow">${x}</div>`).join("");
  const remaining = shifts.filter((s) => s.iso >= todayIso).length;
  return `
    <section class="sched-strip" aria-label="Two-week overview">
      <div class="ss-cap">
        <span class="ss-cap-title">Next two weeks</span>
        <span class="ss-cap-count">${remaining} shift${remaining === 1 ? "" : "s"}</span>
      </div>
      <div class="ss-grid ss-head">${dowH}</div>
      <div class="ss-grid">${cells.slice(0, 7).join("")}</div>
      <div class="ss-grid">${cells.slice(7, 14).join("")}</div>
    </section>`;
}

// ── Schedule · "today" spotlight ────────────────────────────────────
// Today's shift, elevated into a hero card so the driver's most
// relevant shift anchors the screen. Larger time, accent frame, the
// same labeled meta cells + weather slot the list cards use.
function _schedSpotlightHtml(s, vanInfo) {
  const startTxt = s.starts_at ? fmtTime(s.starts_at) : "";
  const endTxt   = s.ends_at   ? fmtTime(s.ends_at)   : "";
  const timeTxt  = startTxt && endTxt ? `${startTxt} – ${endTxt}` : (startTxt || endTxt || "");
  const dateLbl  = s.date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  const cells    = _shiftMetaCells(s, vanInfo, { withStation: true });
  const wxSlot   = s.iso && s.status === "scheduled"
    ? `<div class="shift-weather" data-wx-iso="${escapeHtml(s.iso)}" hidden></div>` : "";
  const doneTag  = s.status === "completed" ? `<span class="sched-spot-done">Completed</span>` : "";
  return `
    <section class="sched-spot" aria-label="Today's shift">
      <div class="sched-spot-eyebrow">Today · ${escapeHtml(dateLbl)}${doneTag}</div>
      <div class="sched-spot-time">${escapeHtml(timeTxt)}</div>
      ${cells ? `<div class="sc-meta sched-spot-meta">${cells}</div>` : ""}
      ${wxSlot}
    </section>`;
}

function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function fmtIsoDate(d) {
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
function fmtTime(iso) {
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")}${ampm}`;
}

// ── Countdown · "STARTS IN 45m" / "STARTS IN 2h 10m" ────────────────
// Renders the gap between now and a target time as a short, ticking
// label. Returns null once the target is in the past so callers can
// hide the badge.
function _countdownText(targetMs) {
  const ms = targetMs - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const totalMin = Math.ceil(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return m === 0 ? `${h}h` : `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh === 0 ? `${d}d` : `${d}d ${hh}h`;
}

// ── Weather · NWS forecast lookup for shift cards ────────────────────
// One fetch per (lat,lng) per app session, cached in-memory. Returns a
// Map<isoDate, {tempF, conditions, precipPct}> for the *daytime* period
// of each available day in the forecast (NWS gives ~7 days). On any
// failure we return null and callers silently omit the weather chip —
// weather is informational, never a hard dependency.
const _wxCache = new Map();
async function _fetchForecastByLatLng(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  const cached = _wxCache.get(key);
  if (cached && (Date.now() - cached.fetchedAt) < 30 * 60 * 1000) return cached.byIso;
  const inflight = _wxCache.get(key)?.inflight;
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const headers = { "User-Agent": "RouteReady-Driver/1.0", "Accept": "application/geo+json" };
      const pointsRes = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`, { headers });
      if (!pointsRes.ok) throw new Error("nws points");
      const points = await pointsRes.json();
      const forecastUrl = points?.properties?.forecast;
      if (!forecastUrl) throw new Error("no forecast url");
      const fRes = await fetch(forecastUrl, { headers });
      if (!fRes.ok) throw new Error("nws forecast");
      const forecast = await fRes.json();
      const periods = forecast?.properties?.periods || [];
      const byIso = new Map();
      for (const pd of periods) {
        if (!pd.isDaytime) continue;
        const iso = (pd.startTime || "").slice(0, 10);
        if (!iso || byIso.has(iso)) continue;
        byIso.set(iso, {
          tempF: pd.temperature,
          conditions: pd.shortForecast || "",
          precipPct: pd.probabilityOfPrecipitation?.value || 0,
        });
      }
      _wxCache.set(key, { fetchedAt: Date.now(), byIso });
      return byIso;
    } catch {
      _wxCache.set(key, { fetchedAt: Date.now(), byIso: new Map() });
      return new Map();
    }
  })();
  _wxCache.set(key, { fetchedAt: Date.now(), byIso: cached?.byIso || new Map(), inflight: p });
  return p;
}

// Compact "partly cloudy" → ⛅ glyph picker. Matches NWS shortForecast
// vocabulary; falls back to the generic sun-cloud glyph.
function _weatherIcon(conditions) {
  const t = (conditions || "").toLowerCase();
  if (t.includes("thunder"))                         return "⛈";
  if (t.includes("snow") || t.includes("sleet"))     return "❄";
  if (t.includes("rain") || t.includes("shower") || t.includes("drizzle")) return "🌧";
  if (t.includes("partly")) return "⛅";
  if (t.includes("cloud") || t.includes("overcast")) return "☁";
  if (t.includes("fog") || t.includes("haze") || t.includes("mist")) return "🌫";
  if (t.includes("wind"))                            return "💨";
  if (t.includes("sun") || t.includes("clear"))      return "☀";
  return "🌤";
}

// Walks the rendered .shift-weather slots and fills each one with the
// matching NWS daytime forecast for that shift's station + date.
// Cards with no station coords, no matching forecast (date beyond
// NWS's 7-day window), or a fetch failure stay hidden — never partly
// rendered.
async function _hydrateShiftWeather(shifts) {
  if (!Array.isArray(shifts) || shifts.length === 0) return;
  const groups = new Map();
  for (const s of shifts) {
    if (!s?.iso || s.status !== "scheduled") continue;
    if (!Number.isFinite(s.stationLat) || !Number.isFinite(s.stationLng)) continue;
    const key = `${s.stationLat.toFixed(3)},${s.stationLng.toFixed(3)}`;
    if (!groups.has(key)) groups.set(key, { lat: s.stationLat, lng: s.stationLng, isos: new Set() });
    groups.get(key).isos.add(s.iso);
  }
  for (const { lat, lng } of groups.values()) {
    const byIso = await _fetchForecastByLatLng(lat, lng);
    if (!byIso || byIso.size === 0) continue;
    document.querySelectorAll(".shift-weather[data-wx-iso]").forEach((el) => {
      if (el.dataset.wxHydrated) return;
      const iso = el.dataset.wxIso;
      const wx = byIso.get(iso);
      if (!wx) return;
      el.dataset.wxHydrated = "1";
      el.hidden = false;
      el.innerHTML = `
        <span class="shift-weather-icon" aria-hidden="true">${_weatherIcon(wx.conditions)}</span>
        <span class="shift-weather-temp">${wx.tempF}°</span>
        <span class="shift-weather-text">${escapeHtml(wx.conditions || "")}</span>`;
    });
  }
}

// ── Tasks hub ───────────────────────────────────────────────────────
// One screen, four cards. Each card represents a workflow the driver
// completes during their shift. Status pills (Required / Pending /
// Done) make the day's open work obvious at a glance.
function renderTasksHub() {
  setHeader("Tasks", "");
  setRefresh(() => renderTasksHub());
  const main = document.getElementById("main");

  // Render the always-on cards FIRST so the page never stays on the
  // loader even when a network call hangs or a migration's missing.
  // The Onboarding card (driver_get_profile) and Forms cards
  // (driver_list_forms) are fetched in the background and spliced in
  // when their responses land.
  // Availability and Attendance both moved into Settings (driver gear
  // icon) — they're things the driver checks/sets infrequently, not
  // daily tasks.  The Tasks hub is for onboarding steps + assigned forms.
  const baseCards = [];
  // A short shimmer above the real slots so the page never paints empty
  // for the half-second between mount and the first RPC landing. The
  // skeleton auto-clears on a timer — fast enough that drivers on
  // good connections never see it stick, slow enough that flaky
  // networks don't flash a "you're all caught up" message that's
  // about to be replaced by real content.
  main.innerHTML = `
    <div id="rr-tasks-skel">${taskSkeletonHtml(2)}</div>
    <div id="rr-tasks-onboarding-slot"></div>
    <div id="rr-tasks-assignments-slot"></div>
    ${baseCards.map(taskCardHtml).join("")}
    <div id="rr-tasks-forms-slot"></div>
    <div id="rr-tasks-checklists-slot"></div>
    <div id="rr-tasks-tools-slot">
      <div class="wt-sec">Tools</div>
      ${taskCardHtml({
        route: "/tasks/scan",
        title: "Scan a document",
        sub: "Snap photos with your phone → PDF you can send",
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="8" width="10" height="8" rx="1"/></svg>',
      })}
    </div>
    <div class="rr-empty-inline" id="rr-tasks-empty" style="padding:48px 20px;color:var(--text-subtle);font-size:var(--fs-md);display:none">Nothing to do right now — you're all set.</div>`;
  // Skeleton-removal strategy:
  //   • The instant the first real card lands, drop the skeleton.
  //     That avoids the previous "two phantom cards visible above the
  //     real task" flicker, where a fixed 800ms setTimeout pulled the
  //     skeleton at one fixed moment regardless of whether content
  //     had arrived or not.
  //   • If every RPC settles with nothing to show, drop the skeleton
  //     and reveal the "Nothing to do" empty state instead.
  //   • 3 s safety net for genuinely-stuck networks.
  const TASKS_RPC_COUNT = 7;
  let _tasksPending = TASKS_RPC_COUNT;
  let _tasksRevealed = false;
  // Any RPC failure lands here so the reveal step can tell "no tasks"
  // apart from "couldn't load tasks" — a driver in a dead zone used to
  // be shown the all-clear when every fetch had actually failed.
  let _tasksErrCount = 0;
  let _tasksFirstErr = null;
  const rpcFailed = (err) => { _tasksErrCount++; if (!_tasksFirstErr && err) _tasksFirstErr = err; };
  const slotHasContent = () => {
    // Real task content only — the always-on Tools section (and the
    // skeleton) don't count, and the "Documents to sign" / I-9 cards
    // are inserted AFTER the forms slot, so look at #main as a whole.
    const mainEl = document.getElementById("main");
    if (!mainEl) return false;
    return [...mainEl.querySelectorAll(".task-card, .wt-sec")].some(
      (el) => !el.closest("#rr-tasks-tools-slot") && !el.closest("#rr-tasks-skel")
    );
  };
  const revealTasks = () => {
    if (_tasksRevealed) return;
    _tasksRevealed = true;
    if (currentRoute() !== "/tasks") return;
    document.getElementById("rr-tasks-skel")?.remove();
    maybeShowEmpty();
  };
  // The empty-vs-error decision is separate from the skeleton reveal and
  // only fires once every RPC has settled: the 3s safety net can drop the
  // skeleton while fetches are still in flight on a slow connection, and
  // a "Nothing to do" that's about to be buried under late-arriving task
  // cards would read as a glitch. Content can't arrive after the last
  // settle (each handler inserts before its finally()), so the decision
  // is final when it runs.
  const maybeShowEmpty = () => {
    if (_tasksPending > 0 || currentRoute() !== "/tasks") return;
    const empty = document.getElementById("rr-tasks-empty");
    if (!empty || slotHasContent()) return;
    if (_tasksErrCount > 0) empty.outerHTML = errorStateHtml("Couldn't load your tasks", _tasksFirstErr);
    else empty.style.display = "";
  };
  // Call after a slot is populated to drop the skeleton immediately.
  const onContent = () => { if (!_tasksRevealed && slotHasContent()) revealTasks(); };
  const rpcSettled = () => {
    _tasksPending--;
    if (_tasksPending <= 0) { revealTasks(); maybeShowEmpty(); }
  };
  setTimeout(revealTasks, 3000);
  main.querySelectorAll("[data-task-route]").forEach((el) => {
    el.addEventListener("click", () => navigate(el.dataset.taskRoute));
  });

  const session = readSession();
  if (!session?.token) { _tasksPending = 0; revealTasks(); return; }

  // Onboarding card — only when status === 'onboarding'.
  sb.rpc("driver_get_profile", { p_token: session.token }).then(({ data, error }) => {
    if (error) { rpcFailed(error); return; }
    if (!data || data.status !== "onboarding") return;
    const slot = document.getElementById("rr-tasks-onboarding-slot");
    if (!slot) return;
    slot.innerHTML = taskCardHtml({
      route: "/tasks/onboarding", title: "Onboarding", sub: "Steps to get hired",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
    });
    slot.querySelectorAll("[data-task-route]").forEach(el => el.addEventListener("click", () => navigate(el.dataset.taskRoute)));
    onContent();
  }).catch(rpcFailed).finally(rpcSettled);

  // Operational assignments — rows assigned to this driver on the DSP's
  // Workspaces boards.  Incomplete ones surface as cards with a
  // completion action (label / photo / note rules come from the board's
  // config — migration 0183).  driver_assignments_list returns [] when
  // there are none or the migration's still deploying.
  sb.rpc("driver_assignments_list", { p_token: session.token }).then(({ data, error }) => {
    if (error) { rpcFailed(error); return; }
    const open = (Array.isArray(data) ? data : []).filter(a => a && !a.completed_at);
    const slot = document.getElementById("rr-tasks-assignments-slot");
    if (!slot || !open.length) return;
    slot.innerHTML = `<div class="wt-sec">Assignments<span class="wt-sec-n">${open.length}</span></div>` + open.map(_wtCardHtml).join("");
    _wtBindSlot(slot);
    onContent();
  }).catch(rpcFailed).finally(rpcSettled);

  // Coaching feed — single card that opens the unified /tasks/coaching
  // list.  Any coaching with delivery_required = ack/sign that's
  // unacknowledged counts toward the "X to acknowledge" badge.
  // Coaching card — driver_list_coachings now returns only pending
  // (acknowledged_at IS NULL) rows server-side.  If the response is
  // empty, the driver has nothing to address — hide the card.
  sb.rpc("driver_list_coachings", { p_token: session.token }).then(({ data, error }) => {
    if (error) { rpcFailed(error); return; }
    const list = Array.isArray(data) ? data : [];
    if (list.length === 0) return;
    const slot = document.getElementById("rr-tasks-onboarding-slot");
    if (!slot) return;
    const sub = `${list.length} to review`;
    slot.insertAdjacentHTML("beforeend", taskCardHtml({
      route: "/tasks/coaching",
      title: "Coaching",
      sub,
      badge: list.length,   // red count pill — signals a new Coaching to review
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    }));
    // Keep the Forms tab badge in sync with what we just rendered.
    if (typeof _setFormsTabBadge === "function") _setFormsTabBadge(list.length);
    slot.querySelectorAll("[data-task-route]").forEach(el => {
      if (el.dataset.rrBound) return;
      el.dataset.rrBound = "1";
      el.addEventListener("click", () => navigate(el.dataset.taskRoute));
    });
    onContent();
  }).catch(rpcFailed).finally(rpcSettled);

  // Published forms — append one card per form when the RPC returns.
  // Failures surface as an inline diagnostic instead of being
  // swallowed; "no forms yet" stays silent (no visual noise on
  // tenants that haven't published anything).
  // Flush any submissions queued while offline now that the hub — and
  // likely the network — is available again (guarded + silent).
  _formFlushQueue({ silent: true });

  sb.rpc("driver_list_forms", { p_token: session.token }).then(async ({ data, error }) => {
    const slot = document.getElementById("rr-tasks-forms-slot");
    if (!slot) return;
    if (error) {
      console.warn("driver_list_forms error:", error);
      // Don't shout per-fetch — but count the failure so the reveal
      // step shows an error state instead of a false "Nothing to do".
      rpcFailed(error);
      return;
    }
    const forms = Array.isArray(data) ? data : [];
    let queued = 0;
    try { queued = await _formQueueCount(); } catch {}
    if (forms.length === 0 && queued === 0) return;
    const queuedNote = queued > 0
      ? `<div class="wt-form-pending">${queued} form${queued === 1 ? "" : "s"} waiting to sync — will submit automatically.</div>`
      : "";
    slot.innerHTML = `<div class="wt-sec">Forms<span class="wt-sec-n">${forms.length}</span></div>` + queuedNote + forms.map(f => {
      const oncePer = !!f.settings?.once_per_driver;
      const done = oncePer && f.submission_count > 0;
      if (done) {
        // Completed once-per-driver form: render as done and NOT tappable.
        // The server rejects a second submit anyway; this spares the driver
        // the confusing open → refill → "already submitted" round-trip.
        const when = f.last_submitted_at ? new Date(f.last_submitted_at).toLocaleDateString() : "";
        return `
          <div class="task-card is-done" aria-disabled="true">
            <span class="task-icon" style="color:var(--green,var(--rr-green-600))"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>
            <div class="task-text">
              <div class="task-title">${escapeHtml(f.title || "Untitled form")}</div>
              <div class="task-sub">Submitted${when ? " · " + escapeHtml(when) : ""}</div>
            </div>
          </div>`;
      }
      return taskCardHtml({
        route: `/tasks/form?id=${encodeURIComponent(f.id)}`,
        title: f.title || "Untitled form",
        sub:   f.description || `${f.field_count} question${f.field_count === 1 ? "" : "s"}`,
        icon:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>',
      });
    }).join("");
    slot.querySelectorAll("[data-task-route]").forEach(el => el.addEventListener("click", () => navigate(el.dataset.taskRoute)));
    onContent();
  }).catch((err) => {
    // Network / runtime failure — log, count, and let the reveal step
    // decide. The Tasks hub still shows what loaded; PTR re-tries.
    console.warn("driver_list_forms rejected:", err);
    rpcFailed(err);
  }).finally(rpcSettled);

  // Checklists — folded into the Tasks hub (they used to live in a
  // separate bottom-nav tab). Open ones render under a "Checklists"
  // section header; completed ones stay in the dedicated /checklists
  // view to keep the hub focused on what still needs doing.
  sb.rpc("driver_list_checklists", { p_token: session.token }).then(({ data, error }) => {
    const slot = document.getElementById("rr-tasks-checklists-slot");
    if (!slot) return;
    if (error) { console.warn("driver_list_checklists error:", error); rpcFailed(error); return; }
    const lists = Array.isArray(data) ? data : [];
    const todo = lists.filter((c) => c.status !== "completed");
    const completed = lists.filter((c) => c.status === "completed");
    _setChecklistsTabBadge(todo.length);
    if (todo.length === 0) return;
    slot.innerHTML = `<div class="wt-sec">Checklists<span class="wt-sec-n">${todo.length}</span></div>`
      + todo.map(_clkCardHtml).join("")
      + (completed.length ? `<a class="rr-hub-link" data-task-route="/checklists">View ${completed.length} completed</a>` : "");
    slot.querySelectorAll("[data-task-route]").forEach(el => el.addEventListener("click", () => navigate(el.dataset.taskRoute)));
    onContent();
  }).catch((err) => { console.warn("driver_list_checklists rejected:", err); rpcFailed(err); }).finally(rpcSettled);

  // Documents to sign — single card surfacing the count of pending
  // envelopes the dispatcher has sent for this driver.
  sb.rpc("driver_envelopes_list", { p_token: session.token }).then(({ data, error }) => {
    if (error) { rpcFailed(error); return; }
    const pending = Array.isArray(data?.pending) ? data.pending : [];
    if (pending.length === 0) return;
    const slot = document.getElementById("rr-tasks-forms-slot");
    if (!slot) return;
    slot.insertAdjacentHTML("afterend", taskCardHtml({
      route: "/tasks/documents",
      title: "Documents to sign",
      sub: `${pending.length} pending`,
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>',
    }));
    document.querySelectorAll("[data-task-route='/tasks/documents']").forEach((el) => {
      if (el.dataset.rrBound) return;
      el.dataset.rrBound = "1";
      el.addEventListener("click", () => navigate(el.dataset.taskRoute));
    });
    onContent();
  }).catch(rpcFailed).finally(rpcSettled);

  // Form I-9 (Section 1) — only surfaced when the operator explicitly
  // re-opens the form for a correction. The "not_started" case lives
  // inside the Onboarding card's step list, and once Section 1 is
  // submitted dispatch handles Section 2. Surfacing a standalone task
  // for "not_started" duplicated the onboarding step in the active-
  // driver Tasks hub (operator: "Thats not needed when its completed
  // in the on boarding process"); the only case where the driver
  // legitimately needs a re-entry point with no onboarding card
  // around is the "needs_correction" path.
  sb.rpc("driver_i9_get", { p_token: session.token }).then(({ data, error }) => {
    if (error) { rpcFailed(error); return; }
    if (!data?.record) return;
    if (data.record.status !== "needs_correction") return;
    const slot = document.getElementById("rr-tasks-forms-slot");
    if (!slot) return;
    slot.insertAdjacentHTML("afterend", taskCardHtml({
      route: "/tasks/i9",
      title: "Form I-9 — Section 1",
      sub: "Needs a correction",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15l2 2 4-4"/></svg>',
    }));
    document.querySelectorAll("[data-task-route='/tasks/i9']").forEach((el) => {
      if (el.dataset.rrBound) return;
      el.dataset.rrBound = "1";
      el.addEventListener("click", () => navigate(el.dataset.taskRoute));
    });
    onContent();
  }).catch(rpcFailed).finally(rpcSettled);
}
function taskCardHtml(c) {
  // Optional alert signal next to the title — a red count pill (number)
  // or a "NEW" pill (boolean). Used to flag a freshly-sent Coaching.
  const badge = c.badge
    ? `<span class="task-card-badge" aria-label="New" style="display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 6px;margin-left:8px;border-radius:9px;background:var(--rr-red-600);color:var(--rr-white);font-size:10px;font-weight:700;letter-spacing:.02em;vertical-align:middle">${(typeof c.badge === "number" && c.badge > 0) ? (c.badge > 99 ? "99+" : c.badge) : "NEW"}</span>`
    : "";
  return `
    <div class="task-card" data-task-route="${c.route}">
      <span class="task-icon">${c.icon}</span>
      <div class="task-text">
        <div class="task-title">${escapeHtml(c.title)}${badge}</div>
        <div class="task-sub">${escapeHtml(c.sub)}</div>
      </div>
      <svg class="chev" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </div>`;
}

// ── Document scanner ────────────────────────────────────────────────
// Turn phone photos into a shareable PDF, entirely on-device. The
// driver captures one page at a time with the rear camera (or picks
// existing photos), we downscale each shot on a canvas and re-encode
// it as a baseline JPEG, then hand-assemble a PDF that embeds those
// JPEGs via /DCTDecode — no third-party library, no build step, which
// keeps the vanilla-module shell dependency-free. The finished PDF can
// be sent straight to dispatch (reusing the chat-attachment bucket +
// driver_chat_send) or saved / shared through the OS share sheet.
//
// State lives at module scope so an accidental tab-away doesn't wipe
// captured pages; it's cleared explicitly after a successful send or
// via "Start over".
let _scanPages = [];          // [{ id, jpeg: Uint8Array, w, h, thumb }]
let _scanBusy  = false;       // guards the capture/process pipeline

// Max long-edge (px) we downscale each page to before JPEG encoding.
// 2000px keeps text legible at Letter size while holding file size
// down so uploads succeed on a phone's cellular connection.
const _SCAN_MAX_EDGE = 2000;
const _SCAN_JPEG_Q   = 0.82;

// PDF page size (points, 72/in). Letter is the default; A4 is opt-in and
// remembered across sessions. Kept as a small module registry so the
// send/share paths and the builder all agree.
const _SCAN_PAGE_SIZES = {
  letter: { w: 612, h: 792 },
  a4:     { w: 595, h: 842 },
};
function _scanGetPageSize() {
  let v = "letter";
  try { v = localStorage.getItem("rr.scan.pagesize") || "letter"; } catch {}
  return _SCAN_PAGE_SIZES[v] ? v : "letter";
}
function _scanSetPageSize(v) {
  if (!_SCAN_PAGE_SIZES[v]) return;
  try { localStorage.setItem("rr.scan.pagesize", v); } catch {}
}
function _scanGetOcr() {
  try { return localStorage.getItem("rr.scan.ocr") === "1"; } catch { return false; }
}
function _scanSetOcr(on) {
  try { localStorage.setItem("rr.scan.ocr", on ? "1" : "0"); } catch {}
}

// Decode a captured file to something drawImage() accepts, honoring
// EXIF orientation so portrait phone shots aren't rotated sideways.
// createImageBitmap with imageOrientation:"from-image" handles this in
// one step where supported (Chrome/Android, recent Safari); the <img>
// fallback covers the rest (modern browsers auto-apply orientation to
// <img> by default).
async function _scanLoadBitmap(file) {
  if (typeof createImageBitmap === "function") {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch { /* fall through to <img> */ }
  }
  return await new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode failed")); };
    img.src = url;
  });
}

// Downscale a captured image to a sane max edge and JPEG-encode it before
// upload, so multi-MB phone photos don't crawl over a weak connection.
// Non-images and already-small shots pass through untouched; any failure
// falls back to the original file. Reuses _scanLoadBitmap for EXIF-correct
// orientation so portrait shots aren't rotated.
async function _downscaleImageFile(file, maxEdge = 1600, quality = 0.8) {
  if (!file || !/^image\//.test(file.type || "")) return file;
  try {
    const bmp = await _scanLoadBitmap(file);
    const sw = bmp.width, sh = bmp.height;
    const scale = Math.min(1, maxEdge / Math.max(sw, sh || 1));
    if (scale >= 1 && (file.size || 0) < 1_200_000) { if (bmp.close) bmp.close(); return file; }
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", quality));
    if (!blob || blob.size >= (file.size || Infinity)) return file;  // no win → keep original
    const name = (file.name || "photo").replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg" });
  } catch { return file; }
}

// A capture (from the file picker or the live camera) becomes a page
// whose *source* — the downscaled color image — is kept immutable. The
// exported JPEG + thumbnail are derived from that source plus the page's
// current crop + filter, so edits stay non-destructive and re-editable:
// pull the crop back out, switch the filter off, and you're back to the
// original with no quality loss beyond the one capture-time downscale.
async function _scanProcessFile(file) {
  const bmp = await _scanLoadBitmap(file);
  const page = await _scanMakePage(bmp, bmp.width, bmp.height);
  if (typeof bmp.close === "function") bmp.close();
  return page;
}

// Shared page builder for any drawable source (ImageBitmap, <img>,
// <video>, or a <canvas>). White-fills first so transparency (e.g. a
// PNG from the gallery) flattens to white rather than black in JPEG.
async function _scanMakePage(drawable, sw, sh) {
  const scale = Math.min(1, _SCAN_MAX_EDGE / Math.max(sw, sh));
  const ow = Math.max(1, Math.round(sw * scale));
  const oh = Math.max(1, Math.round(sh * scale));

  const src = document.createElement("canvas");
  src.width = ow; src.height = oh;
  const sctx = src.getContext("2d");
  sctx.fillStyle = "#fff";
  sctx.fillRect(0, 0, ow, oh);
  sctx.drawImage(drawable, 0, 0, ow, oh);

  // Master copy at higher quality — every edit re-derives from this, so
  // it's encoded once, generously, and only the *export* uses the
  // tighter quality knob.
  const origBlob = await new Promise((r) => src.toBlob(r, "image/jpeg", 0.92));
  const origJpeg = new Uint8Array(await origBlob.arrayBuffer());

  // Auto-detect the document boundary and pre-crop to it, scanner-style.
  // Detection is conservative (returns null unless confident), and the
  // crop is non-destructive — the editor can reset to full frame or
  // re-detect at any time.
  let autoCrop = null;
  try { autoCrop = _scanDetectQuad(src); } catch { autoCrop = null; }

  const page = {
    id: "p" + Date.now() + Math.random().toString(36).slice(2, 6),
    origJpeg, ow, oh,
    filter: "original",   // original | auto | gray | bw
    crop: autoCrop,       // null = full frame, else [[x,y] ×4] TL,TR,BR,BL in source px
    autoCropped: !!autoCrop,
    rotate: 0,            // 0 | 90 | 180 | 270 (clockwise), applied at export
    warn: _scanQualityWarnings(src),   // ["Blurry"], ["Glare"], … — non-blocking hints
    jpeg: null, w: ow, h: oh, thumb: "",
  };
  await _scanComputeOutput(page, src);    // reuse the canvas we already drew
  return page;
}

// Re-derive a page's exported JPEG + thumbnail from its source, current
// crop (perspective dewarp), and current filter. Runs at capture and
// after every edit. Pass the freshly-decoded source canvas when you
// already have it to skip a re-decode.
async function _scanComputeOutput(page, srcCanvas) {
  const src = srcCanvas || await _scanDecodeToCanvas(page.origJpeg, page.ow, page.oh);
  const cropped = page.crop ? _scanWarp(src, page.crop) : src;
  if (page.filter && page.filter !== "original") _scanApplyFilter(cropped, page.filter);
  // Rotation is applied last, after crop + filter, so it never disturbs
  // the crop geometry (which stays defined in the un-rotated source).
  const finalC = _scanRotateCanvas(cropped, page.rotate || 0);
  const w = finalC.width, h = finalC.height;

  const blob = await new Promise((res) => finalC.toBlob(res, "image/jpeg", _SCAN_JPEG_Q));
  if (!blob) throw new Error("encode failed");
  page.jpeg = new Uint8Array(await blob.arrayBuffer());
  page.w = w; page.h = h;

  const tScale = Math.min(1, 220 / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * tScale));
  const th = Math.max(1, Math.round(h * tScale));
  const tc = document.createElement("canvas");
  tc.width = tw; tc.height = th;
  tc.getContext("2d").drawImage(finalC, 0, 0, tw, th);
  page.thumb = tc.toDataURL("image/jpeg", 0.7);
}

// Rotate a canvas by a multiple of 90° (clockwise). Returns the input
// unchanged for 0°; swaps dimensions for 90°/270°.
function _scanRotateCanvas(canvas, deg) {
  const d = ((deg % 360) + 360) % 360;
  if (d === 0) return canvas;
  const swap = d === 90 || d === 270;
  const out = document.createElement("canvas");
  out.width = swap ? canvas.height : canvas.width;
  out.height = swap ? canvas.width : canvas.height;
  const ctx = out.getContext("2d");
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(d * Math.PI / 180);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

// Quick capture-quality heuristics on a small grayscale downsample:
//   • blur  — variance of the Sobel edge response (a sharp page has
//     lots of high-frequency edge energy; a blurry one is flat).
//   • glare — fraction of blown-out near-white pixels clustered enough
//     to be a reflection rather than plain white paper.
// Both are conservative so we rarely nag on a good shot; the result is a
// non-blocking hint, never a block. Returns e.g. ["Blurry"] or [].
function _scanQualityWarnings(srcCanvas) {
  const warns = [];
  try {
    const W0 = srcCanvas.width, H0 = srcCanvas.height;
    const scale = Math.min(1, 400 / Math.max(W0, H0));
    const w = Math.max(1, Math.round(W0 * scale)), h = Math.max(1, Math.round(H0 * scale));
    if (w < 24 || h < 24) return warns;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(srcCanvas, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;

    const g = new Float32Array(w * h);
    let blown = 0;
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      g[i] = d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114;
      if (d[p] > 250 && d[p + 1] > 250 && d[p + 2] > 250) blown++;
    }
    // Sobel response variance (sharpness).
    let sum = 0, sum2 = 0, cnt = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = -g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] + g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1];
        const gy = -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
        const m = Math.abs(gx) + Math.abs(gy);
        sum += m; sum2 += m * m; cnt++;
      }
    }
    const mean = sum / cnt;
    const variance = sum2 / cnt - mean * mean;
    if (variance < 90) warns.push("Blurry");            // conservative floor
    if (blown / (w * h) > 0.10) warns.push("Glare");     // >10% blown-out
  } catch { /* quality hints are best-effort */ }
  return warns;
}

async function _scanDecodeToCanvas(jpegBytes, w, h) {
  const blob = new Blob([jpegBytes], { type: "image/jpeg" });
  let bmp;
  if (typeof createImageBitmap === "function") {
    bmp = await createImageBitmap(blob);
  } else {
    bmp = await new Promise((res, rej) => {
      const img = new Image(); const url = URL.createObjectURL(blob);
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("decode failed")); };
      img.src = url;
    });
  }
  const c = document.createElement("canvas");
  c.width = w || bmp.width; c.height = h || bmp.height;
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  if (typeof bmp.close === "function") bmp.close();
  return c;
}

// ── Perspective dewarp ──────────────────────────────────────────────
// Map the user's four source corners onto a straight rectangle, so a
// page shot at an angle comes out flat and cropped to the document. We
// inverse-map (destination pixel → source sample) with bilinear
// filtering, sampling white outside the source. The output size is the
// longer of each opposing edge pair so nothing is squashed.
function _scanWarp(srcCanvas, corners) {
  const [tl, tr, br, bl] = corners;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let outW = Math.max(1, Math.round(Math.max(dist(tl, tr), dist(bl, br))));
  let outH = Math.max(1, Math.round(Math.max(dist(tl, bl), dist(tr, br))));
  const cap = 1800, s = Math.min(1, cap / Math.max(outW, outH));
  outW = Math.max(1, Math.round(outW * s));
  outH = Math.max(1, Math.round(outH * s));

  // Homography mapping the destination rectangle → the source quad, so
  // each output pixel reads back into the original photo.
  const dst = [[0, 0], [outW, 0], [outW, outH], [0, outH]];
  const [a, b, c, d, e, f, g, h, i] = _scanHomography(dst, [tl, tr, br, bl]);

  const sctx = srcCanvas.getContext("2d");
  const sW = srcCanvas.width, sH = srcCanvas.height;
  const sd = sctx.getImageData(0, 0, sW, sH).data;
  const out = document.createElement("canvas");
  out.width = outW; out.height = outH;
  const octx = out.getContext("2d");
  const oImg = octx.createImageData(outW, outH);
  const od = oImg.data;

  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      const den = g * ox + h * oy + i;
      const sx = (a * ox + b * oy + c) / den;
      const sy = (d * ox + e * oy + f) / den;
      const oi = (oy * outW + ox) * 4;
      if (sx < 0 || sy < 0 || sx >= sW - 1 || sy >= sH - 1) {
        od[oi] = od[oi + 1] = od[oi + 2] = od[oi + 3] = 255;
        continue;
      }
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const p00 = (y0 * sW + x0) * 4, p10 = p00 + 4, p01 = p00 + sW * 4, p11 = p01 + 4;
      for (let k = 0; k < 3; k++) {
        const top = sd[p00 + k] * (1 - fx) + sd[p10 + k] * fx;
        const bot = sd[p01 + k] * (1 - fx) + sd[p11 + k] * fx;
        od[oi + k] = (top * (1 - fy) + bot * fy) | 0;
      }
      od[oi + 3] = 255;
    }
  }
  octx.putImageData(oImg, 0, 0);
  return out;
}

// Solve the 3×3 homography H (h33 fixed to 1) mapping `from[i]` → `to[i]`
// for four correspondences, via an 8×8 linear system.
function _scanHomography(from, to) {
  const A = [], bv = [];
  for (let k = 0; k < 4; k++) {
    const [X, Y] = from[k], [x, y] = to[k];
    A.push([X, Y, 1, 0, 0, 0, -X * x, -Y * x]); bv.push(x);
    A.push([0, 0, 0, X, Y, 1, -X * y, -Y * y]); bv.push(y);
  }
  const hh = _scanSolve8(A, bv);
  return [hh[0], hh[1], hh[2], hh[3], hh[4], hh[5], hh[6], hh[7], 1];
}

// Gaussian elimination with partial pivoting for an 8×8 system.
function _scanSolve8(A, b) {
  const n = 8;
  const M = A.map((row, idx) => row.concat(b[idx]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const pv = M[col][col] || 1e-9;
    for (let c2 = col; c2 <= n; c2++) M[col][c2] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (!factor) continue;
      for (let c2 = col; c2 <= n; c2++) M[r][c2] -= factor * M[col][c2];
    }
  }
  return M.map((row) => row[n]);
}

// ── Enhancement filters ─────────────────────────────────────────────
function _scanApplyFilter(canvas, filter) {
  const ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  _scanFilterImageData(img, filter);
  ctx.putImageData(img, 0, 0);
}

function _scanFilterImageData(img, filter) {
  if (filter === "gray") {
    const d = img.data;
    for (let p = 0; p < d.length; p += 4) {
      const gray = (d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114) | 0;
      d[p] = d[p + 1] = d[p + 2] = gray;
    }
  } else if (filter === "auto") {
    _scanAutoLevels(img.data);
  } else if (filter === "bw") {
    _scanAdaptiveThreshold(img);
  }
}

// Per-channel contrast stretch: clip the darkest/brightest 1% and
// expand the rest to full range. Cheap "auto enhance" that lifts flat,
// low-contrast phone photos.
function _scanAutoLevels(d) {
  const total = d.length / 4, cut = total * 0.01;
  for (let ch = 0; ch < 3; ch++) {
    const hist = new Uint32Array(256);
    for (let p = ch; p < d.length; p += 4) hist[d[p]]++;
    let c = 0, minv = 0;
    for (let v = 0; v < 256; v++) { c += hist[v]; if (c >= cut) { minv = v; break; } }
    c = 0; let maxv = 255;
    for (let v = 255; v >= 0; v--) { c += hist[v]; if (c >= cut) { maxv = v; break; } }
    if (maxv <= minv) { minv = 0; maxv = 255; }
    const scl = 255 / (maxv - minv);
    for (let p = ch; p < d.length; p += 4) {
      const val = (d[p] - minv) * scl;
      d[p] = val < 0 ? 0 : val > 255 ? 255 : val | 0;
    }
  }
}

// Adaptive mean threshold — the "document B&W" look. Each pixel is
// compared against the mean of a local window (via an integral image
// for O(1) window sums), so shadows and uneven lighting don't blow out
// half the page the way a single global threshold would. Text stays
// crisp; the paper goes pure white; file size drops sharply.
function _scanAdaptiveThreshold(img) {
  const W = img.width, H = img.height, d = img.data;
  const g = new Float64Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    g[i] = d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114;
  }
  const IW = W + 1;
  const S = new Float64Array(IW * (H + 1));
  for (let y = 1; y <= H; y++) {
    let rowSum = 0;
    for (let x = 1; x <= W; x++) {
      rowSum += g[(y - 1) * W + (x - 1)];
      S[y * IW + x] = S[(y - 1) * IW + x] + rowSum;
    }
  }
  const rad = Math.max(8, Math.round(Math.min(W, H) / 16));
  const bias = 0.90;   // keep a pixel white only if it beats 90% of the local mean
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - rad), y1 = Math.min(H - 1, y + rad);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - rad), x1 = Math.min(W - 1, x + rad);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = S[(y1 + 1) * IW + (x1 + 1)] - S[y0 * IW + (x1 + 1)]
                - S[(y1 + 1) * IW + x0] + S[y0 * IW + x0];
      const mean = sum / area;
      const i = y * W + x, p = i * 4;
      const val = g[i] > mean * bias ? 255 : 0;
      d[p] = d[p + 1] = d[p + 2] = val;
    }
  }
}

const _SCAN_FILTERS = [
  { key: "original", label: "Color" },
  { key: "auto",     label: "Enhance" },
  { key: "gray",     label: "Grayscale" },
  { key: "bw",       label: "B&W" },
];
function _scanFilterLabel(key) {
  return (_SCAN_FILTERS.find((f) => f.key === key) || _SCAN_FILTERS[0]).label;
}

// ── Automatic document detection ────────────────────────────────────
// Find the document's four corners with a lightweight, dependency-free
// pipeline: downscale → grayscale → Sobel edge magnitude → adaptive
// threshold + speckle denoise → take the extreme corner points
// (min/max of x±y) → validate the quad is large, convex, and roughly
// rectangular. Returns corners [TL, TR, BR, BL] in the INPUT canvas's
// coordinate space, or null when there's no confident boundary — in
// which case the caller simply leaves the page uncropped. Guards are
// deliberately strict: a missed detection (full page kept) is a far
// gentler failure than a wrong auto-crop, and either is one tap to fix
// in the editor.
function _scanDetectQuad(srcCanvas) {
  const W0 = srcCanvas.width, H0 = srcCanvas.height;
  const scale = Math.min(1, 320 / Math.max(W0, H0));
  const w = Math.max(1, Math.round(W0 * scale));
  const h = Math.max(1, Math.round(H0 * scale));
  if (w < 16 || h < 16) return null;

  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(srcCanvas, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    g[i] = data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
  }

  // Light 3×3 box blur before edge detection — suppresses paper texture,
  // print noise, and JPEG blocking that would otherwise fire spurious
  // edges and fragment the document outline.
  const gb = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          s += g[yy * w + xx]; c++;
        }
      }
      gb[y * w + x] = s / c;
    }
  }

  const mag = new Float32Array(w * h);
  let sum = 0, sum2 = 0, cnt = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -gb[i - w - 1] - 2 * gb[i - 1] - gb[i + w - 1] + gb[i - w + 1] + 2 * gb[i + 1] + gb[i + w + 1];
      const gy = -gb[i - w - 1] - 2 * gb[i - w] - gb[i - w + 1] + gb[i + w - 1] + 2 * gb[i + w] + gb[i + w + 1];
      const m = Math.abs(gx) + Math.abs(gy);
      mag[i] = m; sum += m; sum2 += m * m; cnt++;
    }
  }
  const mean = sum / cnt;
  const std = Math.sqrt(Math.max(0, sum2 / cnt - mean * mean));
  const thr = mean + 1.1 * std;

  const edge = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) edge[i] = mag[i] > thr ? 1 : 0;

  // ── Largest connected edge component ────────────────────────────────
  // The document's border is one big connected outline that spans the
  // frame; background clutter (desk text, other objects, hands) forms
  // separate, smaller blobs. We label 8-connected edge components and
  // keep the one with the largest bounding box — a thin page outline
  // that spans the frame beats a dense-but-compact text block — then
  // read the corners from just that component's extremes. Isolating the
  // dominant outline is what makes detection robust to a messy
  // background, where taking extremes over *all* edge pixels would let a
  // stray blob in a corner drag the quad off the document.
  const label = new Int32Array(w * h);   // 0 = unlabeled
  const stack = [];
  let best = null, lbl = 0;
  for (let i0 = 0; i0 < w * h; i0++) {
    if (!edge[i0] || label[i0]) continue;
    lbl++;
    label[i0] = lbl;
    stack.length = 0; stack.push(i0);
    let count = 0, minx = w, maxx = 0, miny = h, maxy = 0;
    let tl = null, tr = null, br = null, bl = null;
    while (stack.length) {
      const p = stack.pop();
      const x = p % w, y = (p / w) | 0;
      count++;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      const s = x + y, d = x - y;
      if (!tl || s < tl[0] + tl[1]) tl = [x, y];
      if (!br || s > br[0] + br[1]) br = [x, y];
      if (!tr || d > tr[0] - tr[1]) tr = [x, y];
      if (!bl || d < bl[0] - bl[1]) bl = [x, y];
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          const ni = yy * w + xx;
          if (edge[ni] && !label[ni]) { label[ni] = lbl; stack.push(ni); }
        }
      }
    }
    if (count < 40) continue;                    // ignore speckle
    const area = (maxx - minx + 1) * (maxy - miny + 1);
    if (!best || area > best.area) best = { area, tl, tr, br, bl };
  }
  if (!best) return null;
  const quad = [best.tl, best.tr, best.br, best.bl];
  if (!_scanQuadValid(quad, w, h)) return null;
  return quad.map((p) => [p[0] / scale, p[1] / scale]);
}

// A candidate quad passes only if it's sizeable, convex, and its corner
// angles are within a rectangle-ish range — rejecting slivers, noise
// hulls, and near-full-frame boxes.
function _scanQuadValid(q, w, h) {
  const dist = (p, r) => Math.hypot(p[0] - r[0], p[1] - r[1]);
  const minSide = Math.min(dist(q[0], q[1]), dist(q[1], q[2]), dist(q[2], q[3]), dist(q[3], q[0]));
  if (minSide < 0.10 * Math.max(w, h)) return false;

  let area = 0;
  for (let i = 0; i < 4; i++) { const p = q[i], r = q[(i + 1) % 4]; area += p[0] * r[1] - r[0] * p[1]; }
  const frac = Math.abs(area) / 2 / (w * h);
  if (frac < 0.12 || frac > 0.99) return false;

  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const p0 = q[(i + 3) % 4], p1 = q[i], p2 = q[(i + 1) % 4];
    const v1 = [p0[0] - p1[0], p0[1] - p1[1]], v2 = [p2[0] - p1[0], p2[1] - p1[1]];
    const cross = v1[0] * v2[1] - v1[1] * v2[0];
    const s = Math.sign(cross);
    if (sign === 0) sign = s; else if (s !== 0 && s !== sign) return false;   // non-convex
    const mag1 = Math.hypot(v1[0], v1[1]), mag2 = Math.hypot(v2[0], v2[1]);
    if (!mag1 || !mag2) return false;
    const ang = Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (mag1 * mag2)))) * 180 / Math.PI;
    if (ang < 42 || ang > 138) return false;
  }
  return true;
}

// Assemble a PDF (as a Blob) that embeds each page's JPEG on its own
// US-Letter page, scaled to fit within a small margin and centered.
// We build the file as raw bytes because the JPEG streams are binary —
// a JS string would corrupt them. Object byte-offsets are tracked as
// we go to write a valid xref table.
function _scanBuildPdfBlob(pages, opts) {
  const enc   = (s) => new TextEncoder().encode(s);
  const parts = [];
  let length  = 0;
  const push    = (u8) => { parts.push(u8); length += u8.length; };
  const pushStr = (s)  => push(enc(s));

  // Default to US Letter; callers pass { pageSize: 'a4' } to switch. The
  // no-arg default keeps existing callers (and the regression test) on
  // 612×792.
  const size = (opts && _SCAN_PAGE_SIZES[opts.pageSize]) || _SCAN_PAGE_SIZES.letter;
  const PAGE_W = size.w, PAGE_H = size.h, MARGIN = 24;   // 72pt/in, ~1/3" margin
  const N = pages.length;
  const offsets = [];                              // offsets[objNum] = byte pos
  const startObj = (n) => { offsets[n] = length; };

  // Object numbering: 1=Catalog, 2=Pages, then per page i (0-based):
  //   page = 3 + i*3, content = 4 + i*3, image = 5 + i*3
  // If any page carries OCR words we add ONE shared font object after all
  // page objects (number 3 + N*3), so the per-page numbering above is
  // untouched and the no-OCR path is byte-for-byte unchanged.
  const pageNum = (i) => 3 + i * 3;
  const hasOcr = pages.some((p) => p.ocrWords && p.ocrWords.length);
  const fontNum = hasOcr ? 3 + N * 3 : 0;
  const kids = pages.map((_, i) => `${pageNum(i)} 0 R`).join(" ");

  pushStr("%PDF-1.3\n");
  push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));   // binary marker

  startObj(1);
  pushStr("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  startObj(2);
  pushStr(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${N} >>\nendobj\n`);

  for (let i = 0; i < N; i++) {
    const p = pages[i];
    const pNum = pageNum(i), cNum = pNum + 1, iNum = pNum + 2;
    const availW = PAGE_W - MARGIN * 2, availH = PAGE_H - MARGIN * 2;
    const s = Math.min(availW / p.w, availH / p.h);
    const dw = p.w * s, dh = p.h * s;
    const tx = (PAGE_W - dw) / 2, ty = (PAGE_H - dh) / 2;

    const fontRes = fontNum ? ` /Font << /F0 ${fontNum} 0 R >>` : "";
    startObj(pNum);
    pushStr(`${pNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] `
      + `/Resources << /XObject << /Im0 ${iNum} 0 R >>${fontRes} >> /Contents ${cNum} 0 R >>\nendobj\n`);

    // Image draw, then an invisible OCR text layer (if present) so the
    // scan is searchable / selectable without altering its appearance.
    const content = `q\n${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${tx.toFixed(2)} ${ty.toFixed(2)} cm\n/Im0 Do\nQ\n`
      + _scanOcrTextOps(p, { iw: p.w, ih: p.h, drawW: dw, drawH: dh, tx, ty });
    const contentBytes = enc(content);
    startObj(cNum);
    pushStr(`${cNum} 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
    push(contentBytes);
    pushStr("endstream\nendobj\n");

    startObj(iNum);
    pushStr(`${iNum} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} `
      + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
    push(p.jpeg);
    pushStr("\nendstream\nendobj\n");
  }

  // Shared invisible-text font (base-14 Helvetica — no font file needed).
  if (fontNum) {
    startObj(fontNum);
    pushStr(`${fontNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`);
  }

  const totalObjs = 2 + N * 3 + (fontNum ? 1 : 0);
  const xrefPos = length;
  pushStr(`xref\n0 ${totalObjs + 1}\n`);
  pushStr("0000000000 65535 f \n");
  for (let n = 1; n <= totalObjs; n++) {
    pushStr(String(offsets[n] || 0).padStart(10, "0") + " 00000 n \n");
  }
  pushStr(`trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let o = 0;
  for (const part of parts) { out.set(part, o); o += part.length; }
  return new Blob([out], { type: "application/pdf" });
}

function _scanDefaultName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `Document ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Build the invisible (render-mode-3) text operators for one page's OCR
// words. Each word's image-pixel bbox is mapped into the page's PDF
// coordinate space (the image occupies drawW×drawH at (tx,ty); PDF y is
// bottom-up while image y is top-down). Font size ≈ the box height and a
// horizontal-scale (Tz) stretches the glyphs to roughly the box width so
// selection tracks the underlying image. Text is invisible, so exact
// metrics don't matter — searchability and rough selection do.
function _scanOcrTextOps(p, geom) {
  const words = p.ocrWords;
  if (!words || !words.length) return "";
  const { iw, ih, drawW, drawH, tx, ty } = geom;
  let out = "BT\n3 Tr\n";
  for (const wd of words) {
    const text = _scanPdfEscapeText(wd.text);
    if (!text) continue;
    const bw = wd.x1 - wd.x0, bh = wd.y1 - wd.y0;
    if (bw <= 0 || bh <= 0) continue;
    const fontPt = Math.max(1, (bh / ih) * drawH);
    const wPt = (bw / iw) * drawW;
    const xPt = tx + (wd.x0 / iw) * drawW;
    const yPt = ty + (1 - wd.y1 / ih) * drawH;          // baseline ≈ box bottom
    const natural = 0.5 * fontPt * Math.max(1, text.length);   // ~0.5em avg advance
    const tz = Math.max(10, Math.min(400, (wPt / natural) * 100));
    out += `/F0 ${fontPt.toFixed(2)} Tf\n${tz.toFixed(1)} Tz\n1 0 0 1 ${xPt.toFixed(2)} ${yPt.toFixed(2)} Tm\n(${text}) Tj\n`;
  }
  out += "ET\n";
  return out;
}

// PDF literal-string-safe, WinAnsi-safe text: escape ( ) backslash, drop
// non-printable / non-Latin to a space (the text layer is English-first;
// full Unicode would need an embedded CID font). Empty → "" so the caller
// skips the word.
function _scanPdfEscapeText(t) {
  if (t == null) return "";
  let out = "";
  for (const ch of String(t)) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 126) { out += " "; continue; }
    if (ch === "(" || ch === ")" || ch === "\\") out += "\\" + ch;
    else out += ch;
  }
  return out.trim();
}

// ── On-device OCR (Tesseract.js, lazy-loaded) ───────────────────────
// OCR is opt-in ("Make searchable"). The engine (~a few MB of WASM + the
// English model) is fetched from a CDN only on first use and then cached
// by the browser / Tesseract's own IndexedDB store, so it doesn't weigh
// on drivers who never turn it on. Everything runs on the phone — no
// backend, no image ever leaves the device for OCR.
const _SCAN_TESSERACT_SRC = "https://cdn.jsdelivr.net/npm/tesseract.js@4.1.4/dist/tesseract.min.js";
let _scanTessPromise = null;
function _scanLoadTesseract() {
  if (typeof window !== "undefined" && window.Tesseract) return Promise.resolve(window.Tesseract);
  if (_scanTessPromise) return _scanTessPromise;
  _scanTessPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = _SCAN_TESSERACT_SRC;
    s.async = true;
    s.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error("tesseract missing"));
    s.onerror = () => { _scanTessPromise = null; reject(new Error("tesseract load failed")); };
    document.head.appendChild(s);
  });
  return _scanTessPromise;
}

// Normalize Tesseract's result to a flat list of { text, x0,y0,x1,y1 } in
// image-pixel coords. v4 exposes data.words directly; we also walk the
// block tree as a fallback in case a build only populates that.
function _scanExtractWords(data) {
  const map = (w) => ({
    text: w.text,
    x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1,
    confidence: w.confidence,
  });
  let words = Array.isArray(data.words) ? data.words : [];
  if (!words.length && Array.isArray(data.blocks)) {
    for (const b of data.blocks)
      for (const par of (b.paragraphs || []))
        for (const ln of (par.lines || []))
          for (const w of (ln.words || [])) words.push(w);
  }
  return words
    .filter((w) => w && w.text && w.text.trim() && w.bbox && (w.confidence == null || w.confidence > 30))
    .map(map);
}

// Run OCR over every captured page, stashing word boxes + full text on
// each page. onProgress(pageIndex, total) drives the UI. Throws if the
// engine can't load; the caller degrades to a non-searchable PDF.
async function _scanRunOcr(onProgress) {
  const T = await _scanLoadTesseract();
  const worker = await T.createWorker("eng");
  try {
    for (let i = 0; i < _scanPages.length; i++) {
      if (onProgress) onProgress(i + 1, _scanPages.length);
      const p = _scanPages[i];
      const blob = new Blob([p.jpeg], { type: "image/jpeg" });
      const { data } = await worker.recognize(blob);
      p.ocrWords = _scanExtractWords(data);
      p.ocrText = (data.text || "").trim();
      // Tesseract reports 0–100; keep it for the receipt pipeline
      // (receipt_uploads.ocr_confidence stores 0–1).
      p.ocrConfidence = (typeof data.confidence === "number") ? data.confidence : null;
    }
  } finally {
    try { await worker.terminate(); } catch {}
  }
}

// Upload the built PDF to the driver-chat-attachments bucket and post it
// to dispatch via driver_chat_send (same pipeline as a chat attachment).
// Returns { ok } on success, or { ok:false, retriable } — retriable
// means a transient/network failure worth queuing for a later retry;
// non-retriable means a terminal problem (no session, incomplete
// profile) where retrying the same way won't help.
async function _scanUploadAndSend(blob, filename) {
  const session = readSession();
  if (!session?.token) return { ok: false, retriable: false, reason: "no-session" };

  let dspId = session.dsp_id, driverId = session.driver_id;
  if (!dspId || !driverId) {
    try {
      const { data: me, error } = await sb.rpc("driver_me", { p_token: session.token });
      if (error || !me) return { ok: false, retriable: true, reason: "profile" };
      dspId = me.dsp_id || dspId; driverId = me.id || driverId;
      const cur = readSession();
      if (cur) writeSession({ ...cur, dsp_id: dspId, driver_id: driverId });
    } catch { return { ok: false, retriable: true, reason: "profile" }; }
  }
  if (!dspId || !driverId) return { ok: false, retriable: false, reason: "incomplete" };

  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "document.pdf";
  const path = `${dspId}/${driverId}/${Date.now()}-${safe}`;
  try {
    const { error: upErr } = await sb.storage
      .from("driver-chat-attachments")
      .upload(path, blob, { contentType: "application/pdf", upsert: false });
    if (upErr) return { ok: false, retriable: true, reason: "upload" };

    const { error: sendErr } = await sb.rpc("driver_chat_send", {
      p_token:                 session.token,
      p_body:                  `📄 Scanned document: ${filename}`,
      p_attachment_path:       path,
      p_attachment_mime:       "application/pdf",
      p_attachment_name:       safe,
      p_attachment_size_bytes: blob.size,
    });
    if (sendErr) return { ok: false, retriable: true, reason: "send" };
    return { ok: true };
  } catch {
    return { ok: false, retriable: true, reason: "network" };
  }
}

// ── Offline send queue ──────────────────────────────────────────────
// Drivers scan in cellular dead zones (loading docks, rural routes). A
// send that can't reach the network is stored — PDF blob and all — in
// IndexedDB and flushed automatically when connectivity returns (the
// `online` event, app foreground, or opening the scanner). So a scan is
// never lost to a bad signal.
const _SCAN_Q_DB = "rr-scan-queue";
const _SCAN_Q_STORE = "docs";
function _scanQueueDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_SCAN_Q_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(_SCAN_Q_STORE)) {
        req.result.createObjectStore(_SCAN_Q_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function _scanQueueAdd(item) {
  const db = await _scanQueueDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(_SCAN_Q_STORE, "readwrite");
    tx.objectStore(_SCAN_Q_STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function _scanQueueAll() {
  const db = await _scanQueueDb();
  return new Promise((resolve) => {
    const tx = db.transaction(_SCAN_Q_STORE, "readonly");
    const r = tx.objectStore(_SCAN_Q_STORE).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => resolve([]);
  });
}
async function _scanQueueDelete(id) {
  const db = await _scanQueueDb();
  return new Promise((resolve) => {
    const tx = db.transaction(_SCAN_Q_STORE, "readwrite");
    tx.objectStore(_SCAN_Q_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
async function _scanQueueCount() {
  try { return (await _scanQueueAll()).length; } catch { return 0; }
}

// Try to send every queued document. Stops at the first still-failing
// item (likely still offline / signed out) to avoid hammering. Safe to
// call repeatedly and concurrently-guarded.
let _scanFlushing = false;
async function _scanFlushQueue({ silent } = {}) {
  if (_scanFlushing) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  if (!readSession()?.token) return;
  _scanFlushing = true;
  let sent = 0;
  try {
    const items = (await _scanQueueAll()).sort((a, b) => a.createdAt - b.createdAt);
    for (const it of items) {
      const res = await _scanUploadAndSend(it.blob, it.filename || it.name || "document.pdf");
      if (res.ok) { await _scanQueueDelete(it.id); sent++; }
      else break;   // leave the rest for the next flush
    }
  } catch { /* ignore — retried next trigger */ }
  _scanFlushing = false;
  if (sent && !silent) toast(`${sent} queued scan${sent === 1 ? "" : "s"} sent to dispatch`, "ok");
  if (sent) { _haptic("success"); _scanUpdateQueueBanner(); }
}

// Flush whenever the network comes back. Wired once for the app's life.
if (typeof window !== "undefined" && !window.__rrScanOnlineWired) {
  window.__rrScanOnlineWired = true;
  window.addEventListener("online", () => { _scanFlushQueue(); });
}


// ── Offline form-submission queue ────────────────────────────────────
// Drivers fill forms in the same dead zones they scan in. If a submit
// can't reach the network, the whole submission — scalar answers plus
// any captured photo/file blobs — is stored in IndexedDB and flushed
// automatically when connectivity returns (the `online` event or the
// next Tasks-hub mount). On flush we upload the deferred files first,
// splice their storage paths into the answers, then call
// driver_submit_form. So a form is never lost to a bad signal.
const _FORM_Q_DB = "rr-form-queue";
const _FORM_Q_STORE = "subs";
function _formQueueDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_FORM_Q_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(_FORM_Q_STORE)) {
        req.result.createObjectStore(_FORM_Q_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function _formQueueAdd(item) {
  const db = await _formQueueDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(_FORM_Q_STORE, "readwrite");
    tx.objectStore(_FORM_Q_STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function _formQueueAll() {
  const db = await _formQueueDb();
  return new Promise((resolve) => {
    const tx = db.transaction(_FORM_Q_STORE, "readonly");
    const r = tx.objectStore(_FORM_Q_STORE).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => resolve([]);
  });
}
async function _formQueueDelete(id) {
  const db = await _formQueueDb();
  return new Promise((resolve) => {
    const tx = db.transaction(_FORM_Q_STORE, "readwrite");
    tx.objectStore(_FORM_Q_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
async function _formQueueCount() {
  try { return (await _formQueueAll()).length; } catch { return 0; }
}

// Fire-and-forget driver-forms telemetry (migration 0447). Best-effort:
// never throws, never blocks the UI, silent in preview mode. Powers the
// dispatcher completion funnel — opened / submitted / submit_rejected /
// queued_offline / flushed_ok / flushed_dropped.
function _logFormEvent(event, formId, meta) {
  try {
    if (PREVIEW) return;
    const s = readSession();
    if (!s?.token) return;
    sb.rpc("driver_log_form_event", {
      p_token:   s.token,
      p_form_id: formId || null,
      p_event:   event,
      p_meta:    meta || {},
    }).then(() => {}, () => {});   // swallow both fulfilment and rejection
  } catch (_) { /* telemetry must never surface an error into the driver's flow */ }
}

// Send every queued submission, oldest first. Stops at the first item
// that still can't go through (offline / storage hiccup) so we don't
// hammer; server-rejected items (already submitted, unpublished, no
// longer assigned) are dropped so a permanently-invalid submission
// can't jam the queue forever. Safe to call repeatedly; guarded.
let _formFlushing = false;
async function _formFlushQueue({ silent } = {}) {
  if (_formFlushing) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  const session = readSession();
  if (!session?.token) return;
  _formFlushing = true;
  let sent = 0;
  try {
    const items = (await _formQueueAll()).sort((a, b) => a.createdAt - b.createdAt);
    for (const it of items) {
      const answers = { ...(it.answers || {}) };
      // Upload any deferred files, splicing their paths into the answers.
      let stuck = false;
      for (const fr of (it.files || [])) {
        const ts = Date.now();
        const safe = (fr.name || "file").replace(/[^A-Za-z0-9._-]+/g, "-");
        const base = `${session.dsp_id || "no-dsp"}/dvic/${session.driver_id || "anon"}/${ts}-${Math.random().toString(36).slice(2, 8)}`;
        const path = `${base}-${safe}`;
        const { error } = await sb.storage.from("driver-documents")
          .upload(path, fr.blob, { contentType: fr.type, upsert: false });
        if (error) { stuck = true; break; }
        // Best-effort thumbnail so photo-heavy reports load light — a failed
        // thumb just omits the field and the report shows the full image.
        let thumb;
        if (fr.thumb) {
          const thumbPath = `${base}-thumb.jpg`;
          const { error: tErr } = await sb.storage.from("driver-documents")
            .upload(thumbPath, fr.thumb, { contentType: fr.thumb.type || "image/jpeg", upsert: false });
          if (!tErr) thumb = thumbPath;
        }
        answers[fr.fid] = { path, name: fr.name, size: fr.blob?.size, type: fr.type, ...(thumb ? { thumb } : {}) };
      }
      if (stuck) break;  // still offline / storage down — retry next trigger
      const { error: subErr } = await sb.rpc("driver_submit_form", {
        p_token:   session.token,
        p_form_id: it.formId,
        p_answers: answers,
      });
      if (!subErr) { await _formQueueDelete(it.id); sent++; _logFormEvent("flushed_ok", it.formId); continue; }
      // Server rejected it (already_submitted / form_not_found / no longer
      // assigned) — drop so it doesn't block everything behind it.
      if (subErr.code === "P0001" || /already_submitted|form_not_found/i.test(subErr.message || "")) {
        await _formQueueDelete(it.id);
        _logFormEvent("flushed_dropped", it.formId, { code: subErr.code || null });
        continue;
      }
      break;  // unknown/transient server error — stop and retry later
    }
  } catch { /* transport threw — retried on next trigger */ }
  _formFlushing = false;
  if (sent && !silent) toast(`${sent} saved form${sent === 1 ? "" : "s"} submitted`, "ok");
  if (sent) _haptic("success");
}

if (typeof window !== "undefined" && !window.__rrFormOnlineWired) {
  window.__rrFormOnlineWired = true;
  window.addEventListener("online", () => { _formFlushQueue(); });
}

// Hand the PDF to the OS share sheet (so the driver can email / message
// / save it anywhere), falling back to a direct download when the Web
// Share API can't take files (most desktop browsers, older iOS).
async function _scanShareOrSave(blob, filename) {
  const file = new File([blob], filename, { type: "application/pdf" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return "shared"; }
    catch (e) {
      if (e && e.name === "AbortError") return "cancelled";   // user dismissed the sheet
      /* otherwise fall through to download */
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return "downloaded";
}

// ── Receipt intake ("What are you uploading?" → Receipt) ────────────
// The scanner builds the same photo pipeline; here we branch on what the
// captured pages *are*. Receipts get a short structured flow that files a
// durable receipt record + a Receipt Ledger row for the DSP. The other
// categories keep the existing "send to dispatch" behavior so nothing the
// driver relied on breaks.
// Stroke SVGs (not emoji) so the picker matches the app's iconography —
// this was the one emoji island in an otherwise all-SVG UI.
const _UPLOAD_TYPES = [
  { key: "receipt",  label: "Receipt",           icon: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/><line x1="14" y1="8" x2="8" y2="8"/><line x1="16" y1="12" x2="8" y2="12"/><line x1="13" y1="16" x2="8" y2="16"/>' },
  { key: "vehicle",  label: "Vehicle document",  icon: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>' },
  { key: "driver",   label: "Driver document",   icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>' },
  { key: "incident", label: "Incident / damage", icon: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>' },
  { key: "hr",       label: "Attendance / HR",   icon: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>' },
  { key: "other",    label: "Other",             icon: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>' },
];
const _RECEIPT_CATEGORIES = [
  "Fuel", "Maintenance", "Tires", "Tolls / Parking", "Supplies",
  "Uniforms / Equipment", "Reimbursement", "Cleaning", "Other",
];
const _RECEIPT_PAYMENTS = ["Card", "Cash", "Fuel Card", "Check", "Other"];

// Draft carried from the scanner into the receipt form (module-scoped so a
// route change doesn't lose it). Cleared on submit / start-over.
let _receiptDraft = null;

// Present the "What are you uploading?" chooser as a bottom sheet.
function _scanChooseUploadType() {
  const body = document.createElement("div");
  body.className = "rr-uploadtype-list";
  body.innerHTML = _UPLOAD_TYPES.map((t) => `
    <button type="button" class="rr-uploadtype" data-upl="${t.key}">
      <span class="rr-uploadtype-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg></span>
      <span class="rr-uploadtype-label">${escapeHtml(t.label)}</span>
      <span class="rr-uploadtype-chev" aria-hidden="true">›</span>
    </button>`).join("");
  body.querySelectorAll("[data-upl]").forEach((b) =>
    b.addEventListener("click", () => { _haptic("tap"); _closeSheet(b.getAttribute("data-upl")); }));
  openSheet({
    title: "What are you uploading?",
    body,
    actions: [{ label: "Cancel", kind: "ghost", value: null }],
  }).then((choice) => { if (choice) _scanHandleUploadType(choice); });
}

function _scanHandleUploadType(choice) {
  if (choice === "receipt") {
    try {
      _receiptDraft = _receiptBuildDraft();
      navigate("/tasks/scan/receipt");
    } catch (err) {
      toast(_friendlyError(err, "Couldn't prepare the receipt image. Try again."), "warn");
    }
    return;
  }
  const label = (_UPLOAD_TYPES.find((t) => t.key === choice) || {}).label || "Document";
  _scanSendToDispatch(label);
}

// Package the captured pages for a receipt: a single page is uploaded as a
// crisp JPEG (best for an image preview); multiple pages combine into a PDF.
function _receiptBuildDraft() {
  const pages = _scanPages;
  if (!pages.length) throw new Error("no pages");
  if (pages.length === 1 && pages[0].jpeg) {
    return {
      blob: new Blob([pages[0].jpeg], { type: "image/jpeg" }),
      mime: "image/jpeg", ext: "jpg",
      thumb: pages[0].thumb || "", pageCount: 1,
      pages: pages.slice(), ocrText: pages[0].ocrText || "",
    };
  }
  const blob = _scanBuildPdfBlob(pages, { pageSize: _scanGetPageSize() });
  return {
    blob, mime: "application/pdf", ext: "pdf",
    thumb: pages[0] ? pages[0].thumb : "", pageCount: pages.length,
    pages: pages.slice(), ocrText: pages.map((p) => p.ocrText || "").join("\n").trim(),
  };
}

// Non-receipt categories: keep the established chat delivery, labeled by type.
async function _scanSendToDispatch(typeLabel) {
  if (!_scanPages.length) return;
  const base = _scanNameValue();
  const name = typeLabel ? `${typeLabel} — ${base}` : base;
  const filename = name.endsWith(".pdf") ? name : name + ".pdf";
  if (_scanGetOcr()) { try { await _scanRunOcr(() => {}); } catch { /* non-blocking */ } }
  let blob;
  try { blob = _scanBuildPdfBlob(_scanPages, { pageSize: _scanGetPageSize() }); }
  catch (err) { toast(_friendlyError(err, "Couldn't build the PDF. Try again."), "warn"); return; }

  const queueIt = async (line) => {
    try {
      await _scanQueueAdd({ id: "q" + Date.now() + Math.random().toString(36).slice(2, 7), name, filename, blob, size: blob.size, createdAt: Date.now() });
      _haptic("success"); toast(line, "ok"); _scanPages = []; renderDocumentScanner();
    } catch { toast("Couldn't save the scan. Try again.", "warn"); }
  };

  toast("Sending…", "default");
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    await queueIt("Saved — will send to dispatch when you're back online"); return;
  }
  const res = await _scanUploadAndSend(blob, filename);
  if (res.ok) { _haptic("success"); toast("Sent to dispatch", "ok"); _scanPages = []; navigate("/chat"); return; }
  if (res.retriable) { await queueIt("Couldn't reach dispatch — saved, will retry when you're back online"); return; }
  toast(res.reason === "no-session" ? "Sign in again to send" : "Profile incomplete — sign out and back in", "warn");
}

// ── Receipt submission screen ───────────────────────────────────────
function renderReceiptForm() {
  if (!_receiptDraft) { navigate("/tasks/scan"); return; }
  setHeader("Submit a receipt", "");
  setRefresh(null);
  const main = document.getElementById("main");
  const today = fmtIsoDate(new Date());
  const d = _receiptDraft;

  main.innerHTML = `
    <div class="receipt-form">
      <div class="receipt-preview">
        ${d.thumb ? `<img src="${d.thumb}" alt="Receipt preview">` : `<div class="receipt-preview-fallback">📄</div>`}
        <div class="receipt-preview-meta">
          <div class="receipt-preview-title">${d.pageCount > 1 ? `${d.pageCount}-page PDF` : "1 photo"}</div>
          <div class="receipt-preview-sub">Stored securely in RouteReady</div>
        </div>
        <button type="button" id="receipt-autofill" class="btn btn-sm btn-ghost">Auto-fill</button>
      </div>

      <label class="field-label">Category <span class="req">*</span></label>
      <div class="receipt-chips" id="receipt-cat">
        ${_RECEIPT_CATEGORIES.map((c) => `<button type="button" class="receipt-chip" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join("")}
      </div>

      <label class="field-label" for="receipt-amount">Total amount <span class="req">*</span></label>
      <div class="receipt-amount-wrap">
        <span class="receipt-amount-cur">$</span>
        <input class="field receipt-amount" id="receipt-amount" type="text" inputmode="decimal" placeholder="0.00" autocomplete="off">
      </div>

      <label class="field-label" for="receipt-vendor">Vendor</label>
      <input class="field" id="receipt-vendor" type="text" placeholder="e.g. Shell, AutoZone" autocapitalize="words" autocomplete="off">

      <div class="receipt-row2">
        <div>
          <label class="field-label" for="receipt-date">Receipt date</label>
          <input class="field" id="receipt-date" type="date" value="${today}">
        </div>
        <div>
          <label class="field-label" for="receipt-tax">Tax</label>
          <input class="field" id="receipt-tax" type="text" inputmode="decimal" placeholder="0.00" autocomplete="off">
        </div>
      </div>

      <label class="field-label">Payment</label>
      <div class="receipt-chips" id="receipt-pay">
        ${_RECEIPT_PAYMENTS.map((p) => `<button type="button" class="receipt-chip" data-pay="${escapeHtml(p)}">${escapeHtml(p)}</button>`).join("")}
      </div>

      <details class="receipt-more">
        <summary>Attach to a van / route (optional)</summary>
        <label class="field-label" for="receipt-van">Van</label>
        <input class="field" id="receipt-van" type="text" placeholder="e.g. 4271" autocomplete="off">
        <label class="field-label" for="receipt-route">Route date</label>
        <input class="field" id="receipt-route" type="date" value="${today}">
      </details>

      <label class="field-label" for="receipt-notes">Notes</label>
      <textarea class="field" id="receipt-notes" rows="2" placeholder="Anything the office should know"></textarea>

      <button id="receipt-submit" class="btn btn-primary btn-block" type="button" style="margin-top:14px">Submit receipt</button>
      <button id="receipt-cancel" class="btn btn-ghost btn-block" type="button" style="margin-top:8px">Cancel</button>
    </div>`;

  const pick = (host, attr) => {
    let val = null;
    host.querySelectorAll(".receipt-chip").forEach((b) => b.addEventListener("click", () => {
      const was = b.classList.contains("on");
      host.querySelectorAll(".receipt-chip").forEach((x) => x.classList.remove("on"));
      if (!was) { b.classList.add("on"); val = b.getAttribute(attr); } else { val = null; }
      _haptic("select");
    }));
    return () => val;
  };
  const getCat = pick(document.getElementById("receipt-cat"), "data-cat");
  const getPay = pick(document.getElementById("receipt-pay"), "data-pay");

  // Best-effort van prefill from today's assignment (never blocks the form).
  (async () => {
    try {
      const s = readSession();
      if (!s?.token) return;
      const vRes = await sb.rpc("driver_vehicle_days", { p_token: s.token });
      const row = (Array.isArray(vRes?.data) ? vRes.data : []).find((r) => r && r.date === today && r.vehicle);
      const vanEl = document.getElementById("receipt-van");
      if (row && vanEl && !vanEl.value) vanEl.value = row.vehicle;
    } catch { /* no van data — fine */ }
  })();

  document.getElementById("receipt-autofill").addEventListener("click", (e) => _receiptOcrAutofill(e.currentTarget));
  document.getElementById("receipt-cancel").addEventListener("click", () => navigate("/tasks/scan"));
  document.getElementById("receipt-submit").addEventListener("click", (e) => {
    const num = (id) => { const v = parseFloat(String(document.getElementById(id).value).replace(/[^0-9.]/g, "")); return isFinite(v) ? v : null; };
    const val = (id) => (document.getElementById(id).value || "").trim() || null;
    const rec = {
      category:   getCat(),
      amount:     num("receipt-amount"),
      tax:        num("receipt-tax"),
      vendor:     val("receipt-vendor"),
      receiptDate: val("receipt-date"),
      payment:    getPay(),
      van:        val("receipt-van"),
      routeDate:  val("receipt-route"),
      notes:      val("receipt-notes"),
      blob: d.blob, mime: d.mime, ext: d.ext,
      filename: `receipt.${d.ext}`, ocrText: _receiptDraft.ocrText || null,
      ocrConfidence: _receiptDraft.ocrConfidence ?? null,
      createdAt: Date.now(), id: "r" + Date.now() + Math.random().toString(36).slice(2, 7),
    };
    _receiptSubmit(e.currentTarget, rec);
  });
}

// Run the on-device OCR over the draft pages and prefill empty fields. Fully
// optional and guarded — the form works without it.
async function _receiptOcrAutofill(btn) {
  const pages = (_receiptDraft && _receiptDraft.pages) || [];
  if (!pages.length) { toast("No photo to read", "warn"); return; }
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = "Reading…";
  try {
    _scanPages = pages;                     // _scanRunOcr reads the module list
    await _scanRunOcr((i, t) => { btn.textContent = `Reading ${i}/${t}…`; });
    const text = pages.map((p) => p.ocrText || "").join("\n").trim();
    _receiptDraft.ocrText = text;
    // Mean page confidence, scaled to the 0–1 range the DB column stores.
    const confs = pages.map((p) => p.ocrConfidence).filter((c) => typeof c === "number");
    _receiptDraft.ocrConfidence = confs.length
      ? Math.max(0, Math.min(1, (confs.reduce((a, b) => a + b, 0) / confs.length) / 100))
      : null;
    const g = _receiptGuessFields(text);
    const amt = document.getElementById("receipt-amount");
    const dt  = document.getElementById("receipt-date");
    const vn  = document.getElementById("receipt-vendor");
    if (g.amount != null && amt && !amt.value) amt.value = g.amount.toFixed(2);
    if (g.date && dt) dt.value = g.date;
    if (g.vendor && vn && !vn.value) vn.value = g.vendor;
    _haptic("success");
    toast(g.amount != null || g.vendor ? "Filled what we could — please check it" : "Couldn't read much — enter the details", "ok");
  } catch {
    toast("Couldn't read the receipt — enter the details", "warn");
  }
  btn.disabled = false; btn.textContent = orig;
}

// Pure text → { amount, date (YYYY-MM-DD), vendor }. Exported for tests.
function _receiptGuessFields(text) {
  const out = { amount: null, date: null, vendor: null };
  if (!text) return out;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const totalRe = /(grand\s+total|total\s+due|amount\s+due|balance\s+due|total|amount)/i;
  const money = /(\d{1,3}(?:,\d{3})+(?:\.\d{2})|\d+\.\d{2})/g;
  let best = null;
  for (const l of lines) {
    if (!totalRe.test(l)) continue;
    let m, last = null; money.lastIndex = 0;
    while ((m = money.exec(l))) last = m[1];
    if (last != null) best = parseFloat(last.replace(/,/g, ""));
  }
  if (best == null) {
    let m; const re = /\b(\d+\.\d{2})\b/g; const flat = text.replace(/,/g, "");
    while ((m = re.exec(flat))) { const v = parseFloat(m[1]); if (best == null || v > best) best = v; }
  }
  out.amount = best;
  const dm = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/) || text.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/);
  if (dm) out.date = _receiptNormalizeDate(dm);
  for (const l of lines.slice(0, 6)) {
    if (/[A-Za-z]{3,}/.test(l) && !/\d{3,}/.test(l) && !totalRe.test(l)) { out.vendor = l.slice(0, 60); break; }
  }
  return out;
}
function _receiptNormalizeDate(dm) {
  try {
    let y, mo, day;
    if (String(dm[1]).length === 4) { y = +dm[1]; mo = +dm[2]; day = +dm[3]; }
    else { mo = +dm[1]; day = +dm[2]; y = +dm[3]; if (y < 100) y += 2000; }
    if (!(mo >= 1 && mo <= 12) || !(day >= 1 && day <= 31)) return null;
    const z = (n) => String(n).padStart(2, "0");
    return `${y}-${z(mo)}-${z(day)}`;
  } catch { return null; }
}

async function _receiptSubmit(btn, rec) {
  if (!rec.category) { toast("Choose a category", "warn"); return; }
  if (!(rec.amount > 0)) { toast("Enter the total amount", "warn"); document.getElementById("receipt-amount")?.focus(); return; }
  btn.disabled = true; btn.textContent = "Submitting…";

  const done = (line, dup) => {
    _haptic("success");
    toast(dup ? "Submitted — flagged as a possible duplicate for review" : line, "ok");
    _receiptDraft = null; _scanPages = [];
    navigate("/tasks");
  };

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    try { await _receiptQueueAdd(rec); done("Saved — will submit when you're back online"); }
    catch { toast("Couldn't save the receipt. Try again.", "warn"); btn.disabled = false; btn.textContent = "Submit receipt"; }
    return;
  }

  const res = await _receiptUploadAndSubmit(rec);
  if (res.ok) { done("Receipt submitted", res.duplicate); return; }
  if (res.retriable) {
    try { await _receiptQueueAdd(rec); done("Couldn't reach RouteReady — saved, will retry when you're back online"); }
    catch { toast("Couldn't save the receipt. Try again.", "warn"); btn.disabled = false; btn.textContent = "Submit receipt"; }
    return;
  }
  toast(res.reason === "no-session" ? "Sign in again to submit" : "Couldn't submit — try again", "warn");
  btn.disabled = false; btn.textContent = "Submit receipt";
}

// Upload the image to the private 'receipts' bucket, then record the receipt.
async function _receiptUploadAndSubmit(rec) {
  const session = readSession();
  if (!session?.token) return { ok: false, retriable: false, reason: "no-session" };
  let dspId = session.dsp_id, driverId = session.driver_id;
  if (!dspId || !driverId) {
    try {
      const { data: me, error } = await sb.rpc("driver_me", { p_token: session.token });
      if (error || !me) return { ok: false, retriable: true, reason: "profile" };
      dspId = me.dsp_id || dspId; driverId = me.id || driverId;
      const cur = readSession();
      if (cur) writeSession({ ...cur, dsp_id: dspId, driver_id: driverId });
    } catch { return { ok: false, retriable: true, reason: "profile" }; }
  }
  if (!dspId || !driverId) return { ok: false, retriable: false, reason: "incomplete" };

  const path = `${dspId}/${driverId}/${Date.now()}-receipt.${rec.ext || "jpg"}`;
  try {
    const { error: upErr } = await sb.storage
      .from("receipts")
      .upload(path, rec.blob, { contentType: rec.mime || "image/jpeg", upsert: false });
    if (upErr) return { ok: false, retriable: true, reason: "upload" };

    const { data, error } = await sb.rpc("driver_receipt_submit", {
      p_token:           session.token,
      p_storage_key:     path,
      p_category:        rec.category,
      p_total_amount:    rec.amount,
      p_vendor_name:     rec.vendor || null,
      p_receipt_date:    rec.receiptDate || null,
      p_tax_amount:      rec.tax ?? null,
      p_payment_type:    rec.payment || null,
      p_van_id:          null,
      p_van_number:      rec.van || null,
      p_route_date:      rec.routeDate || null,
      p_shift_id:        null,
      p_notes:           rec.notes || null,
      p_file_name:       rec.filename || `receipt.${rec.ext || "jpg"}`,
      p_file_size_bytes: rec.blob.size,
      p_mime_type:       rec.mime || "image/jpeg",
      p_ocr_raw_text:    rec.ocrText || null,
      p_ocr_confidence:  rec.ocrConfidence ?? null,
    });
    if (error) return { ok: false, retriable: true, reason: "rpc" };
    return { ok: true, duplicate: !!(data && data.duplicate_flag) };
  } catch { return { ok: false, retriable: true, reason: "network" }; }
}

// ── Offline receipt queue (IndexedDB) ───────────────────────────────
// A receipt is never lost to a bad signal — same contract as the scan
// queue, in its own store so the two flush independently.
const _RCPT_Q_DB = "rr-receipt-queue";
const _RCPT_Q_STORE = "receipts";
function _receiptQueueDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_RCPT_Q_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(_RCPT_Q_STORE)) {
        req.result.createObjectStore(_RCPT_Q_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function _receiptQueueAdd(item) {
  const db = await _receiptQueueDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(_RCPT_Q_STORE, "readwrite");
    tx.objectStore(_RCPT_Q_STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function _receiptQueueAll() {
  const db = await _receiptQueueDb();
  return new Promise((resolve) => {
    const tx = db.transaction(_RCPT_Q_STORE, "readonly");
    const r = tx.objectStore(_RCPT_Q_STORE).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => resolve([]);
  });
}
async function _receiptQueueDelete(id) {
  const db = await _receiptQueueDb();
  return new Promise((resolve) => {
    const tx = db.transaction(_RCPT_Q_STORE, "readwrite");
    tx.objectStore(_RCPT_Q_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
let _receiptFlushing = false;
async function _receiptFlushQueue({ silent } = {}) {
  if (_receiptFlushing) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  if (!readSession()?.token) return;
  _receiptFlushing = true;
  let sent = 0;
  try {
    const items = (await _receiptQueueAll()).sort((a, b) => a.createdAt - b.createdAt);
    for (const it of items) {
      const res = await _receiptUploadAndSubmit(it);
      if (res.ok) { await _receiptQueueDelete(it.id); sent++; }
      else break;
    }
  } catch { /* retried next trigger */ }
  _receiptFlushing = false;
  if (sent && !silent) toast(`${sent} saved receipt${sent === 1 ? "" : "s"} submitted`, "ok");
  if (sent) _haptic("success");
}
if (typeof window !== "undefined" && !window.__rrReceiptOnlineWired) {
  window.__rrReceiptOnlineWired = true;
  window.addEventListener("online", () => { _receiptFlushQueue(); });
}

function renderDocumentScanner() {
  setHeader("Scan a document", "");
  setRefresh(null);
  const main = document.getElementById("main");

  main.innerHTML = `
    <div class="scan-page">
      <input id="scan-file" type="file" accept="image/*" capture="environment" multiple hidden>

      <div id="scan-queue-banner" class="scan-queue-banner" style="display:none"></div>

      <div class="scan-intro">
        Scan each page with your phone camera. Pages combine into one PDF
        you can send to dispatch or save.
      </div>

      <div id="scan-pages" class="scan-pages"></div>

      <button id="scan-add" class="btn btn-primary btn-block" type="button">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:6px"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>
        <span id="scan-add-label">Add a page</span>
      </button>
      <button id="scan-pick" class="btn btn-ghost btn-block" type="button" style="margin-top:8px">Choose from photos</button>

      <div class="scan-namefield" id="scan-namefield" style="display:none">
        <label class="field-label" for="scan-name">Document name</label>
        <input class="field" id="scan-name" type="text" autocapitalize="words" autocomplete="off" />
      </div>

      <div class="scan-actions" id="scan-actions" style="display:none">
        <div class="scan-size-row">
          <span class="scan-size-label">Page size</span>
          <div class="scan-size-seg" id="scan-size-seg" role="group" aria-label="PDF page size">
            <button type="button" class="scan-size-opt" data-scan-size="letter">Letter</button>
            <button type="button" class="scan-size-opt" data-scan-size="a4">A4</button>
          </div>
        </div>
        <label class="scan-ocr-row" for="scan-ocr">
          <span class="scan-ocr-txt">
            <span class="scan-ocr-title">Make searchable</span>
            <span class="scan-ocr-sub">Reads the text so the PDF is searchable. Runs on your phone; adds a little time.</span>
          </span>
          <input type="checkbox" id="scan-ocr" class="scan-ocr-check" />
        </label>
        <button id="scan-categorize" class="btn btn-primary btn-block" type="button">Continue</button>
        <button id="scan-clear" class="btn btn-ghost btn-block" type="button" style="margin-top:8px;color:var(--red)">Start over</button>
      </div>
    </div>`;

  const fileInput = document.getElementById("scan-file");
  const addBtn    = document.getElementById("scan-add");
  const pickBtn   = document.getElementById("scan-pick");

  // "Add a page" opens the live camera when the device supports it (the
  // world-class path — live viewfinder, auto-capture, batch pages).
  // Where getUserMedia isn't available (or is blocked) it falls back to
  // the OS photo-capture input. "Choose from photos" always uses the
  // library picker.
  const _hasCam = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  addBtn.addEventListener("click", () => {
    if (_scanBusy) return;
    if (_hasCam) _scanOpenCamera();
    else fileInput.click();
  });
  pickBtn.addEventListener("click", () => { if (!_scanBusy) fileInput.click(); });

  fileInput.addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    fileInput.value = "";                 // allow re-picking the same file
    if (!files.length) return;
    _scanBusy = true;
    _scanSetBusy(true);
    for (const f of files) {
      if (!/^image\//.test(f.type) && !/\.(jpe?g|png|heic|heif|webp)$/i.test(f.name)) continue;
      try { _scanPages.push(await _scanProcessFile(f)); }
      catch { toast("Couldn't read one of the photos — try again", "warn"); }
    }
    _scanBusy = false;
    _scanSetBusy(false);
    _scanRenderPages();
    _haptic("select");
  });

  document.getElementById("scan-pages").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-scan-act]");
    if (!btn) return;
    const id  = btn.getAttribute("data-scan-id");
    const act = btn.getAttribute("data-scan-act");
    const idx = _scanPages.findIndex((p) => p.id === id);
    if (idx < 0) return;
    if (act === "edit") {
      _haptic("tap");
      _scanOpenEditor(id);
      return;
    } else if (act === "rotate") {
      const p = _scanPages[idx];
      p.rotate = (((p.rotate || 0) + 90) % 360);
      _haptic("tap");
      btn.disabled = true;
      try { await _scanComputeOutput(p); } catch { toast("Couldn't rotate — try again", "warn"); }
      _scanRenderPages();
      return;
    } else if (act === "del") {
      _scanPages.splice(idx, 1);
      _haptic("tap");
    } else if (act === "up" && idx > 0) {
      [_scanPages[idx - 1], _scanPages[idx]] = [_scanPages[idx], _scanPages[idx - 1]];
      _haptic("tap");
    } else if (act === "down" && idx < _scanPages.length - 1) {
      [_scanPages[idx + 1], _scanPages[idx]] = [_scanPages[idx], _scanPages[idx + 1]];
      _haptic("tap");
    }
    _scanRenderPages();
  });

  // Categorizing what you scanned is mandatory — the "What are you uploading?"
  // chooser is the only way forward, so a Receipt is always classified (and
  // never silently dropped into chat un-categorized). Non-receipt types still
  // reach dispatch, just from inside the chooser.
  document.getElementById("scan-categorize").addEventListener("click", () => {
    if (!_scanPages.length || _scanBusy) return;
    _scanChooseUploadType();
  });

  document.getElementById("scan-clear").addEventListener("click", async () => {
    const ok = await confirmSheet({
      title: "Start over?",
      message: "This removes all captured pages.",
      confirmText: "Start over",
      danger: true,
    });
    if (!ok) return;
    _scanPages = [];
    _scanRenderPages();
    _haptic("tap");
  });

  // Page-size segmented control (Letter / A4), persisted across sessions.
  const seg = document.getElementById("scan-size-seg");
  if (seg) {
    const paint = () => {
      const cur = _scanGetPageSize();
      seg.querySelectorAll("[data-scan-size]").forEach((b) =>
        b.classList.toggle("on", b.getAttribute("data-scan-size") === cur));
    };
    paint();
    seg.querySelectorAll("[data-scan-size]").forEach((b) =>
      b.addEventListener("click", () => { _scanSetPageSize(b.getAttribute("data-scan-size")); paint(); _haptic("select"); }));
  }

  // "Make searchable" (OCR) toggle, persisted across sessions.
  const ocrChk = document.getElementById("scan-ocr");
  if (ocrChk) {
    ocrChk.checked = _scanGetOcr();
    ocrChk.addEventListener("change", () => { _scanSetOcr(ocrChk.checked); _haptic("select"); });
  }

  _scanRenderPages();

  // Surface any queued (offline) scans and try to flush them now that
  // the screen — and likely the network — is available again.
  _scanUpdateQueueBanner();
  _scanFlushQueue({ silent: true });
  _receiptFlushQueue({ silent: true });
}

// Show/hide the "waiting to send" banner from the queue count, and wire
// its "Retry now" action.
async function _scanUpdateQueueBanner() {
  const el = document.getElementById("scan-queue-banner");
  if (!el) return;
  const count = await _scanQueueCount();
  if (!count) { el.style.display = "none"; el.innerHTML = ""; return; }
  el.style.display = "";
  el.innerHTML = `
    <div class="scan-queue-txt">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>
      <span>${count} scan${count === 1 ? "" : "s"} waiting to send — will retry automatically.</span>
    </div>
    <button class="scan-queue-retry" id="scan-queue-retry" type="button">Retry now</button>`;
  const retry = document.getElementById("scan-queue-retry");
  if (retry) retry.addEventListener("click", async () => {
    retry.disabled = true; retry.textContent = "Sending…";
    await _scanFlushQueue();
    _scanUpdateQueueBanner();
  });
}

// Re-paint the page grid + toggle the name/actions block based on how
// many pages are captured. Kept separate so every mutation (add,
// delete, reorder) re-renders through one path.
function _scanRenderPages() {
  const wrap = document.getElementById("scan-pages");
  if (!wrap) return;                       // route changed out from under us
  const n = _scanPages.length;

  wrap.innerHTML = n === 0
    ? `<div class="scan-empty">No pages yet. Tap <strong>Add a page</strong> to capture the first one.</div>`
    : _scanPages.map((p, i) => {
        const edited = (p.filter && p.filter !== "original") || p.crop || p.rotate;
        const tags = [];
        if (p.crop) tags.push(p.autoCropped ? "Auto-cropped" : "Cropped");
        if (p.filter && p.filter !== "original") tags.push(_scanFilterLabel(p.filter));
        const warnTags = (p.warn || []).map((wn) => `<span class="scan-tag warn">⚠ ${escapeHtml(wn)}</span>`).join("");
        const okTags = tags.map((t) => `<span class="scan-tag">${escapeHtml(t)}</span>`).join("");
        const tagLine = (tags.length || warnTags)
          ? `<div class="scan-page-tags">${warnTags}${okTags}</div>`
          : `<div class="scan-page-dim">Tap to crop &amp; enhance</div>`;
        return `
        <div class="scan-page-card">
          <button class="scan-open-edit" data-scan-act="edit" data-scan-id="${p.id}" aria-label="Edit page ${i + 1}">
            <span class="scan-thumb"><img src="${p.thumb}" alt="Page ${i + 1}"/>${edited ? '<span class="scan-thumb-edited" aria-hidden="true"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></span>' : ""}</span>
            <span class="scan-page-meta">
              <span class="scan-page-n">Page ${i + 1}</span>
              ${tagLine}
            </span>
          </button>
          <div class="scan-page-ctl">
            <button class="scan-ctl-btn" data-scan-act="rotate" data-scan-id="${p.id}" aria-label="Rotate page">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>
            </button>
            <button class="scan-ctl-btn" data-scan-act="up"   data-scan-id="${p.id}" aria-label="Move up"   ${i === 0 ? "disabled" : ""}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
            </button>
            <button class="scan-ctl-btn" data-scan-act="down" data-scan-id="${p.id}" aria-label="Move down" ${i === n - 1 ? "disabled" : ""}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <button class="scan-ctl-btn danger" data-scan-act="del" data-scan-id="${p.id}" aria-label="Delete page">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </div>`;
      }).join("");

  const addLabel = document.getElementById("scan-add-label");
  if (addLabel) addLabel.textContent = n === 0 ? "Add a page" : "Add another page";

  const nameField = document.getElementById("scan-namefield");
  const actions   = document.getElementById("scan-actions");
  const nameInput = document.getElementById("scan-name");
  if (nameField) nameField.style.display = n > 0 ? "" : "none";
  if (actions)   actions.style.display   = n > 0 ? "" : "none";
  if (nameInput && !nameInput.value) nameInput.value = _scanDefaultName();
}

function _scanNameValue() {
  const el = document.getElementById("scan-name");
  const v = (el?.value || "").trim();
  return v || _scanDefaultName();
}

// Disable the capture button + show progress while photos are being
// processed so rapid taps can't stack decodes.
function _scanSetBusy(busy) {
  const btn = document.getElementById("scan-add");
  const label = document.getElementById("scan-add-label");
  if (!btn) return;
  btn.disabled = busy;
  if (label) label.textContent = busy ? "Processing…" : (_scanPages.length ? "Add another page" : "Add a page");
}

// ── Page editor (crop + enhance) ────────────────────────────────────
// A full-screen overlay for one page: a filtered preview of the source
// with four draggable corner handles for the crop quad, plus a filter
// row. "Apply" dewarps to the chosen quad, bakes in the filter, and
// re-derives the page's export JPEG — all from the immutable source, so
// re-opening the editor starts from the same place every time.
let _scanEditor = null;   // { id, corners, filter, base, previewCanvas, svg, box, dragIdx }

async function _scanOpenEditor(id) {
  const page = _scanPages.find((p) => p.id === id);
  if (!page || _scanEditor) return;

  // Decode the source once for the editor at preview resolution.
  const full = await _scanDecodeToCanvas(page.origJpeg, page.ow, page.oh);
  const pScale = Math.min(1, 1000 / Math.max(page.ow, page.oh));
  const pw = Math.max(1, Math.round(page.ow * pScale));
  const ph = Math.max(1, Math.round(page.oh * pScale));
  const preview = document.createElement("canvas");
  preview.width = pw; preview.height = ph;
  preview.getContext("2d").drawImage(full, 0, 0, pw, ph);
  const base = preview.getContext("2d").getImageData(0, 0, pw, ph);

  const corners = page.crop
    ? page.crop.map((c) => [c[0], c[1]])
    : [[0, 0], [page.ow, 0], [page.ow, page.oh], [0, page.oh]];

  const idxOf = _scanPages.findIndex((p) => p.id === id) + 1;
  const filtersHtml = _SCAN_FILTERS.map((f) =>
    `<button class="scan-fchip${f.key === page.filter ? " on" : ""}" data-scan-filter="${f.key}" type="button">${escapeHtml(f.label)}</button>`
  ).join("");

  const overlay = document.createElement("div");
  overlay.className = "scan-editor";
  overlay.innerHTML = `
    <div class="scan-editor-head">
      <button class="scan-editor-btn" id="scan-ed-cancel" type="button">Cancel</button>
      <div class="scan-editor-title">Page ${idxOf}</div>
      <button class="scan-editor-btn primary" id="scan-ed-apply" type="button">Apply</button>
    </div>
    <div class="scan-editor-stage" id="scan-ed-stage">
      <div class="scan-editor-box" id="scan-ed-box">
        <canvas class="scan-editor-canvas" id="scan-ed-canvas" width="${pw}" height="${ph}"></canvas>
        <svg class="scan-editor-svg" id="scan-ed-svg" viewBox="0 0 ${page.ow} ${page.oh}" preserveAspectRatio="none">
          <polygon id="scan-ed-poly" points="" fill="rgba(37,99,235,.12)" stroke="#2563EB" stroke-width="2" vector-effect="non-scaling-stroke"/>
          ${corners.map((_, k) => `<circle class="scan-ed-handle" data-h="${k}" r="${Math.max(page.ow, page.oh) / 42}" fill="#fff" stroke="#2563EB" stroke-width="2" vector-effect="non-scaling-stroke"/>`).join("")}
        </svg>
      </div>
    </div>
    <div class="scan-editor-cropbar">
      <button class="scan-editor-pill" id="scan-ed-auto" type="button">Auto-detect</button>
      <span class="scan-editor-hint" id="scan-ed-hint">Drag the corners to your document</span>
      <button class="scan-editor-pill" id="scan-ed-reset" type="button">Whole page</button>
    </div>
    <div class="scan-editor-filters">${filtersHtml}</div>`;
  document.body.appendChild(overlay);
  document.body.classList.add("scan-editing");

  _scanEditor = {
    id, corners, filter: page.filter, base, pw, ph,
    ow: page.ow, oh: page.oh, full,          // full-res source for re-detection
    auto: !!page.autoCropped,                 // did the current quad come from auto-detect?
    canvas: overlay.querySelector("#scan-ed-canvas"),
    svg: overlay.querySelector("#scan-ed-svg"),
    box: overlay.querySelector("#scan-ed-box"),
    poly: overlay.querySelector("#scan-ed-poly"),
    overlay, dragIdx: -1,
  };

  _scanEditorLayout();
  _scanEditorRenderFilter();
  _scanEditorRenderQuad();

  window.addEventListener("resize", _scanEditorLayout);

  overlay.querySelector("#scan-ed-cancel").addEventListener("click", _scanCloseEditor);
  overlay.querySelector("#scan-ed-apply").addEventListener("click", _scanApplyEditor);

  // Auto-detect → snap corners to the found document (or nudge the user
  // if nothing confident turns up). Whole page → reset to full frame.
  overlay.querySelector("#scan-ed-auto").addEventListener("click", () => {
    const q = _scanDetectQuad(_scanEditor.full);
    if (q) {
      _scanEditor.corners = q.map((p) => [p[0], p[1]]);
      _scanEditor.auto = true;
      _scanEditorRenderQuad();
      _haptic("success");
    } else {
      const hint = document.getElementById("scan-ed-hint");
      if (hint) hint.textContent = "No document found — drag the corners";
      _haptic("warn");
    }
  });
  overlay.querySelector("#scan-ed-reset").addEventListener("click", () => {
    _scanEditor.corners = [[0, 0], [page.ow, 0], [page.ow, page.oh], [0, page.oh]];
    _scanEditor.auto = false;
    _scanEditorRenderQuad();
    _haptic("tap");
  });

  overlay.querySelectorAll("[data-scan-filter]").forEach((chip) => {
    chip.addEventListener("click", () => {
      _scanEditor.filter = chip.getAttribute("data-scan-filter");
      overlay.querySelectorAll("[data-scan-filter]").forEach((c) => c.classList.toggle("on", c === chip));
      _scanEditorRenderFilter();
      _haptic("select");
    });
  });

  // Corner dragging via pointer events on the SVG handles.
  const svg = _scanEditor.svg;
  const toSrc = (ev) => {
    const r = svg.getBoundingClientRect();
    const x = (ev.clientX - r.left) / r.width  * page.ow;
    const y = (ev.clientY - r.top)  / r.height * page.oh;
    return [Math.max(0, Math.min(page.ow, x)), Math.max(0, Math.min(page.oh, y))];
  };
  const onMove = (ev) => {
    if (_scanEditor.dragIdx < 0) return;
    ev.preventDefault();
    _scanEditor.corners[_scanEditor.dragIdx] = toSrc(ev);
    _scanEditor.auto = false;    // a manual nudge is no longer an auto-crop
    _scanEditorRenderQuad();
  };
  const onUp = () => { _scanEditor && (_scanEditor.dragIdx = -1); };
  svg.querySelectorAll(".scan-ed-handle").forEach((h) => {
    h.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      _scanEditor.dragIdx = Number(h.getAttribute("data-h"));
      try { h.setPointerCapture(ev.pointerId); } catch {}
      _haptic("tap");
    });
    h.addEventListener("pointermove", onMove);
    h.addEventListener("pointerup", onUp);
    h.addEventListener("pointercancel", onUp);
  });
  _scanEditor._onMove = onMove; _scanEditor._onUp = onUp;
}

// Size the canvas + SVG box to fit the stage while preserving the
// source aspect ratio, so corner coords (kept in source space via the
// SVG viewBox) line up exactly with the displayed image.
function _scanEditorLayout() {
  if (!_scanEditor) return;
  const stage = document.getElementById("scan-ed-stage");
  if (!stage) return;
  const cw = stage.clientWidth, ch = stage.clientHeight;
  const ar = _scanEditor.pw / _scanEditor.ph;
  let w = cw, h = cw / ar;
  if (h > ch) { h = ch; w = ch * ar; }
  const box = _scanEditor.box;
  box.style.width = Math.round(w) + "px";
  box.style.height = Math.round(h) + "px";
}

function _scanEditorRenderFilter() {
  if (!_scanEditor) return;
  const { base, filter, canvas } = _scanEditor;
  const img = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height);
  if (filter && filter !== "original") _scanFilterImageData(img, filter);
  canvas.getContext("2d").putImageData(img, 0, 0);
}

function _scanEditorRenderQuad() {
  if (!_scanEditor) return;
  const c = _scanEditor.corners;
  _scanEditor.poly.setAttribute("points", c.map((p) => `${p[0]},${p[1]}`).join(" "));
  _scanEditor.svg.querySelectorAll(".scan-ed-handle").forEach((h) => {
    const k = Number(h.getAttribute("data-h"));
    h.setAttribute("cx", c[k][0]);
    h.setAttribute("cy", c[k][1]);
  });
}

async function _scanApplyEditor() {
  if (!_scanEditor) return;
  const page = _scanPages.find((p) => p.id === _scanEditor.id);
  if (!page) { _scanCloseEditor(); return; }
  const applyBtn = _scanEditor.overlay.querySelector("#scan-ed-apply");
  applyBtn.disabled = true; applyBtn.textContent = "Applying…";

  // Full-frame (within a pixel) means "no crop" — skip the warp so an
  // untouched quad round-trips losslessly.
  const c = _scanEditor.corners;
  const full = [[0, 0], [page.ow, 0], [page.ow, page.oh], [0, page.oh]];
  const isFull = c.every((p, k) => Math.abs(p[0] - full[k][0]) < 1 && Math.abs(p[1] - full[k][1]) < 1);

  page.crop = isFull ? null : c.map((p) => [p[0], p[1]]);
  page.autoCropped = !isFull && _scanEditor.auto;
  page.filter = _scanEditor.filter;

  try {
    await _scanComputeOutput(page);
    _haptic("success");
  } catch (err) {
    toast(_friendlyError(err, "Couldn't apply the edit. Try again."), "warn");
  }
  _scanCloseEditor();
  _scanRenderPages();
}

function _scanCloseEditor() {
  if (!_scanEditor) return;
  window.removeEventListener("resize", _scanEditorLayout);
  _scanEditor.overlay.remove();
  document.body.classList.remove("scan-editing");
  _scanEditor = null;
}

// ── Live camera (auto-capture) ──────────────────────────────────────
// A full-screen viewfinder over the rear camera. Tap the shutter, or
// leave Auto on and the app fires when the frame holds still over a
// document. Pages accumulate without leaving the camera; Done returns
// to the list. Falls back to the OS photo input if getUserMedia fails
// (permission denied, no camera, unsupported).
let _scanCam = null;

async function _scanOpenCamera() {
  if (_scanCam) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch (err) {
    toast("Camera unavailable — pick a photo instead", "warn");
    document.getElementById("scan-file")?.click();
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "scan-cam";
  overlay.innerHTML = `
    <video class="scan-cam-video" id="scan-cam-video" autoplay playsinline muted></video>
    <div class="scan-cam-guide" aria-hidden="true"></div>
    <svg class="scan-cam-edge" id="scan-cam-edge" aria-hidden="true" preserveAspectRatio="none">
      <polygon id="scan-cam-quad" points="" fill="rgba(37,99,235,.16)" stroke="#4d8bff" stroke-width="3"/>
    </svg>
    <div class="scan-cam-top">
      <button class="scan-cam-icon" id="scan-cam-close" type="button" aria-label="Close camera">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
      <button class="scan-cam-auto on" id="scan-cam-auto" type="button" aria-pressed="true">Auto</button>
      <button class="scan-cam-icon" id="scan-cam-torch" type="button" aria-label="Toggle flashlight" hidden>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2h6l-1 7h3l-7 13 2-9H8z"/></svg>
      </button>
    </div>
    <div class="scan-cam-status" id="scan-cam-status">Point at a document</div>
    <div class="scan-cam-bottom">
      <div class="scan-cam-count" id="scan-cam-count">0 pages</div>
      <button class="scan-cam-shutter" id="scan-cam-shutter" type="button" aria-label="Capture page"></button>
      <button class="scan-cam-done" id="scan-cam-done" type="button">Done</button>
    </div>
    <div class="scan-cam-flash" id="scan-cam-flash" aria-hidden="true"></div>`;
  document.body.appendChild(overlay);
  document.body.classList.add("scan-camming");

  const video = overlay.querySelector("#scan-cam-video");
  video.srcObject = stream;
  try { await video.play(); } catch {}

  _scanCam = {
    stream, video, overlay,
    auto: true, added: 0, busy: false, armed: true, steady: 0, prev: null, loop: null,
    tick: 0, quad: null,
    sample: document.createElement("canvas"),
    detect: document.createElement("canvas"),
    edgeSvg: overlay.querySelector("#scan-cam-edge"),
    edgePoly: overlay.querySelector("#scan-cam-quad"),
    track: stream.getVideoTracks()[0] || null,
  };
  _scanCam.sample.width = 48; _scanCam.sample.height = 36;
  _scanCam.detect.width = 200; _scanCam.detect.height = 150;
  _scanCamUpdateCount();

  // Torch, only where the device exposes the capability.
  try {
    const caps = _scanCam.track?.getCapabilities?.();
    if (caps && caps.torch) {
      const tb = overlay.querySelector("#scan-cam-torch");
      tb.hidden = false;
      let on = false;
      tb.addEventListener("click", async () => {
        on = !on;
        try { await _scanCam.track.applyConstraints({ advanced: [{ torch: on }] }); tb.classList.toggle("on", on); }
        catch { on = !on; }
      });
    }
  } catch {}

  overlay.querySelector("#scan-cam-close").addEventListener("click", () => _scanCloseCamera());
  overlay.querySelector("#scan-cam-done").addEventListener("click", () => _scanCloseCamera());
  overlay.querySelector("#scan-cam-shutter").addEventListener("click", () => _scanCamCapture());
  const autoBtn = overlay.querySelector("#scan-cam-auto");
  autoBtn.addEventListener("click", () => {
    _scanCam.auto = !_scanCam.auto;
    autoBtn.classList.toggle("on", _scanCam.auto);
    autoBtn.setAttribute("aria-pressed", String(_scanCam.auto));
    _scanCamStatus(_scanCam.auto ? "Point at a document" : "Tap the shutter to capture");
  });

  _scanCamStabilityLoop();
}

// Poll the frame ~4×/sec, measuring motion as the mean luma change over
// a tiny downsample. When the frame holds still for a couple of ticks —
// and Auto is on and we're armed — fire a capture. After a shot we
// disarm until the scene changes (page turned / camera moved) so a
// steady hand doesn't machine-gun duplicates. The shutter button always
// works regardless of arm state.
function _scanCamStabilityLoop() {
  const cam = _scanCam;
  if (!cam) return;
  const sctx = cam.sample.getContext("2d", { willReadFrequently: true });
  const W = cam.sample.width, H = cam.sample.height;
  const STEADY = 3.2;   // mean luma delta below which the frame is "still"

  const dctx = cam.detect.getContext("2d", { willReadFrequently: true });
  const DW = cam.detect.width, DH = cam.detect.height;

  cam.loop = setInterval(() => {
    if (!_scanCam || cam.busy) return;
    const v = cam.video;
    if (!v.videoWidth) return;

    // Live document detection every other tick (~2×/sec) — draw the
    // found quad on the viewfinder and use it to gate auto-capture.
    if ((cam.tick++ & 1) === 0) {
      dctx.drawImage(v, 0, 0, DW, DH);
      let q = null;
      try { q = _scanDetectQuad(cam.detect); } catch { q = null; }
      cam.quad = q;
      _scanCamDrawQuad(q, DW, DH);
    }

    sctx.drawImage(v, 0, 0, W, H);
    const cur = sctx.getImageData(0, 0, W, H).data;
    if (cam.prev) {
      let diff = 0;
      for (let p = 0; p < cur.length; p += 4) {
        const a = cur[p] * 0.299 + cur[p + 1] * 0.587 + cur[p + 2] * 0.114;
        const b = cam.prev[p] * 0.299 + cam.prev[p + 1] * 0.587 + cam.prev[p + 2] * 0.114;
        diff += Math.abs(a - b);
      }
      diff /= (cur.length / 4);
      if (diff < STEADY) {
        cam.steady++;
        // Auto-fire only when the frame is still AND a document is in
        // view; otherwise coach the driver toward one.
        if (cam.auto && cam.armed && cam.quad && cam.steady >= 2) _scanCamCapture();
        else if (cam.auto && cam.armed) _scanCamStatus(cam.quad ? "Hold steady…" : "Point at a document");
      } else {
        cam.steady = 0;
        if (!cam.armed && diff > STEADY * 2) cam.armed = true;   // scene moved → re-arm
        if (cam.auto && cam.armed) _scanCamStatus(cam.quad ? "Document detected" : "Point at a document");
      }
    }
    cam.prev = cur;
  }, 260);
}

// Paint the detected quad on the full-screen viewfinder overlay,
// mapping detection-sample coordinates through the video's object-fit:
// cover transform so the outline sits exactly on the real document.
function _scanCamDrawQuad(quad, sampleW, sampleH) {
  const cam = _scanCam;
  if (!cam || !cam.edgeSvg) return;
  if (!quad) { cam.edgePoly.setAttribute("points", ""); return; }
  const rect = cam.overlay.getBoundingClientRect();
  const cw = rect.width, ch = rect.height;
  const vw = cam.video.videoWidth, vh = cam.video.videoHeight;
  if (!vw || !vh) return;
  cam.edgeSvg.setAttribute("viewBox", `0 0 ${cw} ${ch}`);
  const scale = Math.max(cw / vw, ch / vh);          // object-fit: cover
  const offX = (cw - vw * scale) / 2, offY = (ch - vh * scale) / 2;
  const pts = quad.map(([x, y]) => {
    const fx = x / sampleW, fy = y / sampleH;         // fraction of the frame
    return `${(offX + fx * vw * scale).toFixed(1)},${(offY + fy * vh * scale).toFixed(1)}`;
  }).join(" ");
  cam.edgePoly.setAttribute("points", pts);
}

function _scanCamStatus(text) {
  const el = document.getElementById("scan-cam-status");
  if (el) el.textContent = text;
}
function _scanCamUpdateCount() {
  const el = document.getElementById("scan-cam-count");
  if (el) el.textContent = `${_scanPages.length} page${_scanPages.length === 1 ? "" : "s"}`;
}

async function _scanCamCapture() {
  const cam = _scanCam;
  if (!cam || cam.busy) return;
  const v = cam.video;
  if (!v.videoWidth) return;
  cam.busy = true; cam.armed = false; cam.steady = 0;
  _scanCamStatus("Captured ✓");
  _haptic("success");

  const flash = document.getElementById("scan-cam-flash");
  if (flash) { flash.classList.add("fire"); setTimeout(() => flash.classList.remove("fire"), 220); }

  try {
    const grab = document.createElement("canvas");
    grab.width = v.videoWidth; grab.height = v.videoHeight;
    grab.getContext("2d").drawImage(v, 0, 0);
    _scanPages.push(await _scanMakePage(grab, grab.width, grab.height));
    cam.added++;
    _scanCamUpdateCount();
  } catch {
    toast("Couldn't capture that frame — try again", "warn");
  }
  cam.busy = false;
  cam.prev = null;   // fresh motion baseline before we re-arm
}

function _scanCloseCamera() {
  const cam = _scanCam;
  if (!cam) return;
  if (cam.loop) clearInterval(cam.loop);
  try { cam.stream.getTracks().forEach((t) => t.stop()); } catch {}
  cam.overlay.remove();
  document.body.classList.remove("scan-camming");
  _scanCam = null;
  _scanRenderPages();
  _haptic("tap");
}

// ── Chat ────────────────────────────────────────────────────────────
// Polls every 8 seconds while the tab is visible. New messages arrive
// without push for now (push lands in a later PR). Mark-read fires on
// open + after every poll that returns dispatch messages.
//
// Two sub-views inside /chat:
//   - "dispatch": the rolling driver↔dispatch thread (legacy default)
//   - "channels": group rooms scoped to the DSP (or station).  Channel
//                 list → channel thread → composer.  Same bubble +
//                 attachment + signed-URL helpers as dispatch chat.
let _chatPollTimer = null;
let _chatLastIds = new Set();
let _chatTab        = "dispatch";  // "dispatch" | "channels"
let _chatChannelId  = null;        // when set, render the channel thread
let _chatChannelMeta = null;       // cached header info for the thread

// Count of messages that have landed while the driver is scrolled up —
// shown on the jump-to-latest pill ("3 new ↓"); reset when they return
// to the bottom.
let _chatNewCount = 0;
function _setChatJumpLabel() {
  const el = document.getElementById("chat-jump-label");
  if (el) el.textContent = _chatNewCount > 0 ? `${_chatNewCount} new` : "New messages";
}

// ─── Connection-state banner ───────────────────────────────────────
// A small floating pill at the top of the message area: "Reconnecting…"
// (amber) while the realtime channel is down, then a brief "Back online"
// (green). While disconnected we also poll refreshChat() so messages
// still land. Keeps the chat from ever feeling silently frozen.
let _chatDisconnected   = false;
let _chatConnPollTimer  = null;

function _showChatConnBanner(text, kind, autohideMs) {
  const b = document.getElementById("chat-conn-banner");
  if (!b) return;
  b.textContent = text;
  b.className = "chat-conn-banner" + (kind ? " " + kind : "") + " show";
  b.hidden = false;
  if (b._t) clearTimeout(b._t);
  if (autohideMs) {
    b._t = setTimeout(() => {
      b.classList.remove("show");
      b._t = setTimeout(() => { b.hidden = true; }, 280);
    }, autohideMs);
  }
}
function _onChatRealtimeStatus(status) {
  // Supabase realtime channel statuses: SUBSCRIBED | TIMED_OUT |
  // CHANNEL_ERROR | CLOSED. Treat the error/timeout states as a drop;
  // ignore CLOSED (it also fires on intentional teardown).
  if ((status === "CHANNEL_ERROR" || status === "TIMED_OUT") && !_chatDisconnected) {
    _chatDisconnected = true;
    _showChatConnBanner("Reconnecting…", "warn");
    clearInterval(_chatConnPollTimer);
    _chatConnPollTimer = setInterval(() => {
      if (currentRoute() === "/chat" && _chatTab === "dispatch") refreshChat(false);
    }, 8000);
  } else if (status === "SUBSCRIBED" && _chatDisconnected) {
    _chatDisconnected = false;
    clearInterval(_chatConnPollTimer);
    _showChatConnBanner("Back online", "ok", 1800);
    refreshChat(false); // reconcile anything missed while down
  }
}

async function renderChat() {
  // Chat's internal navigation lives in the router now (/chat,
  // /chat/channels, /chat/channel?id=…) so hardware Back pops
  // thread → list → out, and channels are deep-linkable. The module
  // vars remain as caches for pollers/guards and the thread header.
  _chatTab = "dispatch";
  _chatChannelId = null;
  setHeader("Chat", "");
  const main = document.getElementById("main");
  main.innerHTML = `
    <div id="chat-shell">
      <div id="chat-conn-banner" class="chat-conn-banner" hidden></div>
      <div id="chat-tabs" class="chat-tabs">
        <button class="chat-tab active" data-rr-chat-tab="dispatch">Dispatch</button>
        <button class="chat-tab" data-rr-chat-tab="channels">Channels</button>
        ${(() => {
          const s = readSession();
          const p = (s?.dsp_phone || "").trim();
          if (!p) return "";
          const href = p.replace(/[^0-9+]/g, "");
          if (!href) return "";
          const esc = (x) => String(x).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
          return `<a class="chat-call" href="tel:${esc(href)}" aria-label="Call dispatch" title="Call dispatch"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg><span>Call</span></a>`;
        })()}
      </div>
      <div id="chat-msgs" class="chat-msgs"><div class="loader"></div></div>
      <form class="chat-composer" id="chat-form">
        <input id="chat-file" type="file" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt" hidden>
        <button id="chat-attach" type="button" class="chat-attach" aria-label="Attach photo or document" title="Attach">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <div style="flex:1;display:flex;flex-direction:column;gap:6px;min-width:0">
          <div class="chat-qa-strip" id="chat-qa-strip">
            <button type="button" class="chat-qa-chip" data-qa="Running late">Running late</button>
            <button type="button" class="chat-qa-chip" data-qa="Truck issue">Truck issue</button>
            <button type="button" class="chat-qa-chip" data-qa="On the road">On the road</button>
            <button type="button" class="chat-qa-chip" data-qa="Done with route">Done with route</button>
            <button type="button" class="chat-qa-chip" data-qa="Need coverage">Need coverage</button>
          </div>
          <div id="chat-attachment-preview" style="display:none"></div>
          <textarea id="chat-input" rows="1" placeholder="Message dispatch…" maxlength="2000"></textarea>
        </div>
        <button class="chat-send" type="submit" aria-label="Send">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </form>
    </div>`;

  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }
  if (_chatDisconnected) _showChatConnBanner("Reconnecting…", "warn");
  // (Preview sessions are fully interactive — the chat composer stays live.)

  // Auto-grow textarea + persistent composer draft. The draft restore
  // means a driver who started typing, got pulled to another tab, or
  // hit a flaky network can come back and pick up exactly where they
  // left off — nothing is lost on nav, focus loss, or app suspend.
  const ta = document.getElementById("chat-input");
  const _chatDraftKey = "chat:dispatch";
  const _restoredChat = getDraft(_chatDraftKey);
  if (typeof _restoredChat === "string" && _restoredChat) {
    ta.value = _restoredChat;
    // Resize textarea to fit the restored content.
    requestAnimationFrame(() => {
      ta.style.height = "auto";
      ta.style.height = Math.min(120, ta.scrollHeight) + "px";
    });
  }
  let _chatDraftTimer = null;
  ta.addEventListener("input", () => {
    ta.style.height = "auto";
    ta.style.height = Math.min(120, ta.scrollHeight) + "px";
    // Throttled typing broadcast so dispatch sees the live indicator.
    _drvBroadcastTyping();
    // Debounced draft save.
    clearTimeout(_chatDraftTimer);
    _chatDraftTimer = setTimeout(() => setDraft(_chatDraftKey, ta.value), 250);
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(pointer:fine)").matches) {
      e.preventDefault();
      document.getElementById("chat-form").requestSubmit();
    }
  });

  // Quick-action chips — one tap drops a status phrase into the composer
  // (appended, not auto-sent, so the driver can add detail and review).
  document.getElementById("chat-qa-strip")?.addEventListener("click", (e) => {
    const chip = e.target.closest(".chat-qa-chip");
    if (!chip) return;
    const phrase = chip.getAttribute("data-qa") || "";
    const cur = ta.value.trim();
    ta.value = cur ? cur + " " + phrase : phrase;
    ta.dispatchEvent(new Event("input"));
    ta.focus();
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch {}
  });

  // Acknowledge button on requires_ack dispatch messages — delegated so
  // re-renders don't re-bind.
  document.getElementById("chat-msgs")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-rr-ack]");
    if (!btn || btn.disabled) return;
    const id = btn.getAttribute("data-rr-ack");
    btn.disabled = true; btn.textContent = "Acknowledging…";
    if (navigator.vibrate) { try { navigator.vibrate(8); } catch {} }
    const cur = readSession();
    const { error } = await sb.rpc("driver_ack_message", { p_token: cur?.token, p_message_id: id });
    if (error) {
      toast(_friendlyError(error, "Couldn't acknowledge. Try again."), "warn");
      btn.disabled = false; btn.textContent = "Acknowledge";
      return;
    }
    // The realtime UPDATE on driver_messages.acked_at will trigger a
    // refreshChat; until it arrives, paint an immediate optimistic flip
    // so the driver sees the result.
    const bubble = btn.closest(".chat-bubble");
    if (bubble) {
      btn.outerHTML = `<div class="chat-ack acked"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6.5 9.5 17 4.5 12"/></svg>Acknowledged · just now</div>`;
    }
    refreshChat(false);
  });

  // Attachment picker — paperclip opens the file input.  Pending file
  // sits in window._rrChatPending until the operator hits send.
  const fileInput = document.getElementById("chat-file");
  const previewEl = document.getElementById("chat-attachment-preview");
  document.getElementById("chat-attach").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (!f) { window._rrChatPending = null; previewEl.style.display = "none"; previewEl.innerHTML = ""; return; }
    if (f.size > 15 * 1024 * 1024) { toast("File too large (max 15 MB)", "warn"); fileInput.value = ""; return; }
    window._rrChatPending = f;
    const isImg = f.type.startsWith("image/");
    const sizeKb = Math.round(f.size / 1024);
    previewEl.style.display = "";
    previewEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;background:var(--canvas);border:1px solid var(--border);border-radius:8px;padding:6px 10px;font-size:var(--fs-sm)">
        ${isImg ? `<img src="${URL.createObjectURL(f)}" alt="" style="width:36px;height:36px;border-radius:6px;object-fit:cover">`
                : `<span style="font-size:18px">📎</span>`}
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(f.name)}</div>
          <div style="color:var(--text-subtle)">${sizeKb} KB</div>
        </div>
        <button type="button" id="chat-attach-clear" class="chat-attach-x" aria-label="Remove attachment">×</button>
      </div>`;
    document.getElementById("chat-attach-clear").addEventListener("click", () => {
      fileInput.value = "";
      window._rrChatPending = null;
      previewEl.style.display = "none";
      previewEl.innerHTML = "";
    });
  });

  // Send — uploads any pending attachment first, then calls the RPC.
  document.getElementById("chat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = (ta.value || "").trim();
    const file = window._rrChatPending;
    if (!body && !file) return;
    if (navigator.vibrate) { try { navigator.vibrate(8); } catch {} }
    const sendBtn = e.target.querySelector(".chat-send");
    if (sendBtn) sendBtn.disabled = true;

    // ─── Optimistic stub ────────────────────────────────────────────
    // Show the message immediately as a pending bubble so the driver
    // sees it land before the upload + RPC round trip.  If the send
    // fails we keep the bubble marked .failed so they can retry
    // without losing the text.
    const wrap = document.getElementById("chat-msgs");
    const stubId = "stub-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    const nowTime = new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const stubBody = body
      ? `<div class="chat-body">${linkifyEscaped(escapeHtml(body).replace(/\n/g, "<br>"), true)}</div>`
      : "";
    const stubAttach = file
      ? `<div style="font-size:var(--fs-xs);opacity:.85;margin-bottom:4px">📎 ${escapeHtml(file.name)} (uploading…)</div>`
      : "";
    const stubHtml = `<div class="chat-bubble mine pending" data-rr-stub="${stubId}" data-group-pos="single">
      ${stubAttach}${stubBody}
      <div class="chat-time">${escapeHtml(nowTime)} · sending</div>
    </div>`;
    if (wrap) {
      // Drop in just before the jump pill (which sits just before the
      // bottom sentinel — sentinel must remain the LAST child so
      // browser scroll-anchoring keeps tracking it).
      const jump = wrap.querySelector(".chat-jump");
      const sentinel = wrap.querySelector(".chat-bottom-sentinel");
      if (jump) jump.insertAdjacentHTML("beforebegin", stubHtml);
      else if (sentinel) sentinel.insertAdjacentHTML("beforebegin", stubHtml);
      else wrap.insertAdjacentHTML("beforeend", stubHtml);
      // Remove the empty-state placeholder if present.
      const empty = wrap.querySelector(".rr-empty");
      if (empty) empty.remove();
      const skel = wrap.querySelector(".chat-skeleton");
      if (skel) skel.remove();
      // Re-arm the anchor — the driver just sent, they want to track
      // new content from here on out.
      wrap.dataset.rrAnchor = "1";
      wrap.scrollTop = wrap.scrollHeight;
    }
    const savedBody = body;
    ta.value = "";
    ta.style.height = "auto";
    clearDraft(_chatDraftKey);
    if (file) {
      window._rrChatPending = null;
      fileInput.value = "";
      previewEl.style.display = "none";
      previewEl.innerHTML = "";
    }
    const markStubFailed = (reason) => {
      const stub = wrap?.querySelector(`[data-rr-stub="${stubId}"]`);
      if (!stub) return;
      stub.classList.remove("pending");
      stub.classList.add("failed");
      const timeEl = stub.querySelector(".chat-time");
      if (timeEl) timeEl.textContent = reason || "send failed · tap to retry";
      stub.style.cursor = "pointer";
      stub.addEventListener("click", () => {
        ta.value = savedBody;
        ta.dispatchEvent(new Event("input"));
        ta.focus();
        stub.remove();
      }, { once: true });
    };

    let attachment = null;
    if (file) {
      let dspId    = session.dsp_id;
      let driverId = session.driver_id;
      if (!dspId || !driverId) {
        const { data: me, error: meErr } = await sb.rpc("driver_me", { p_token: session.token });
        if (meErr || !me) {
          if (sendBtn) sendBtn.disabled = false;
          markStubFailed("profile load failed · tap to retry");
          ta.value = savedBody;
          toast("Couldn't load profile", "warn");
          return;
        }
        dspId    = me.dsp_id    || dspId;
        driverId = me.id        || driverId;
        const cur = readSession();
        if (cur) writeSession({ ...cur, dsp_id: dspId, driver_id: driverId });
      }
      if (!dspId || !driverId) {
        if (sendBtn) sendBtn.disabled = false;
        markStubFailed("profile incomplete · sign out and back in");
        ta.value = savedBody;
        return;
      }

      const ext = (file.name.split(".").pop() || "bin").toLowerCase().slice(0, 8);
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || `file.${ext}`;
      const path = `${dspId}/${driverId}/${Date.now()}-${safe}`;
      const { error: upErr } = await sb.storage
        .from("driver-chat-attachments").upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) {
        if (sendBtn) sendBtn.disabled = false;
        markStubFailed("upload failed · tap to retry");
        ta.value = savedBody;
        toast(_friendlyError(upErr, "Couldn't attach that file. Try again."), "warn");
        return;
      }
      attachment = { path, mime: file.type, name: file.name, size: file.size };
    }

    const { error } = await sb.rpc("driver_chat_send", {
      p_token:                 session.token,
      p_body:                  savedBody || null,
      p_attachment_path:       attachment?.path || null,
      p_attachment_mime:       attachment?.mime || null,
      p_attachment_name:       attachment?.name || null,
      p_attachment_size_bytes: attachment?.size || null,
    });
    if (sendBtn) sendBtn.disabled = false;
    if (error) {
      _haptic("warn");
      markStubFailed("send failed · tap to retry");
      ta.value = savedBody;
      setDraft(_chatDraftKey, savedBody);
      toast(_friendlyError(error, "Couldn't send. Your message is saved — tap retry to try again."), "warn");
      return;
    }
    _haptic("tap");
    clearDraft(_chatDraftKey);
    // The smart-scroll logic in refreshChat will keep us pinned at
    // bottom (the optimistic stub already scrolled us there).
    await refreshChat(false);
  });

  // Tab toggle — Dispatch / Channels. Real routes, so Back behaves.
  document.querySelectorAll("[data-rr-chat-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-rr-chat-tab");
      if (next === _chatTab) return;
      if (_chatPollTimer) { clearInterval(_chatPollTimer); _chatPollTimer = null; }
      navigate(next === "channels" ? "/chat/channels" : "/chat");
    });
  });

  // First time the driver lands on Chat is the right moment to offer
  // notifications — they've clearly engaged with messaging. The actual
  // permission ask lives on the nudge's button (iOS needs a gesture);
  // when permission is already granted this just re-registers silently.
  _mountPushNudge(session);

  // First fetch + realtime subscription + presence + safety-net poller.
  _chatLastIds = new Set();
  await refreshChat(true);
  _chatRealtimeWire(session);
  _drvPresenceWire(session);
  if (_chatPollTimer) clearInterval(_chatPollTimer);
  _chatPollTimer = setInterval(() => {
    if (document.hidden) return;
    if (currentRoute() !== "/chat") { clearInterval(_chatPollTimer); _chatPollTimer = null; return; }
    if (_chatTab !== "dispatch") { clearInterval(_chatPollTimer); _chatPollTimer = null; return; }
    refreshChat(false);
  }, 30000);
}

// ─── Presence + typing (driver side) ─────────────────────────────────
//
// Drivers join a per-DSP presence channel so dispatchers see them as
// online; in return, drivers see a "Dispatch is typing…" indicator
// when an operator is composing in their thread.  Same channel name
// as the dispatcher (rr-presence-dsp-<dspId>), so both sides land in
// the same room.

const _drvPresence = {
  channel: null,
  lastBroadcast: 0,
  typingTimer: null,
};

function _drvPresenceWire(session) {
  const dspId    = session?.dsp_id;
  const driverId = session?.driver_id;
  if (!dspId || !driverId) return;
  if (_drvPresence.channel) return;
  const channel = sb.channel("rr-presence-dsp-" + dspId, {
    config: { presence: { key: "driver:" + driverId } },
  });
  channel
    .on("broadcast", { event: "typing" }, ({ payload }) => {
      if (!payload || payload.from_kind !== "dispatch") return;
      // Only show when the driver is actually viewing the dispatch chat.
      if (currentRoute() !== "/chat" || _chatTab !== "dispatch") return;
      _drvShowDispatchTyping();
    })
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel.track({ kind: "driver", id: driverId, online_at: new Date().toISOString() });
      }
    });
  _drvPresence.channel = channel;

  // Untrack on visibility loss so dispatchers stop seeing them as
  // online when the app is backgrounded for more than ~2s.  Re-track
  // when they come back.
  document.addEventListener("visibilitychange", () => {
    if (!_drvPresence.channel) return;
    if (document.hidden) {
      try { _drvPresence.channel.untrack(); } catch {}
    } else {
      try {
        _drvPresence.channel.track({ kind: "driver", id: driverId, online_at: new Date().toISOString() });
      } catch {}
    }
  });
}

function _drvBroadcastTyping() {
  if (!_drvPresence.channel) return;
  const now = Date.now();
  if (now - _drvPresence.lastBroadcast < 1500) return;
  _drvPresence.lastBroadcast = now;
  const session = readSession();
  if (!session?.driver_id) return;
  try {
    _drvPresence.channel.send({
      type: "broadcast",
      event: "typing",
      payload: { from: session.driver_id, from_kind: "driver", ts: now },
    });
  } catch {}
}

function _drvShowDispatchTyping() {
  // Insert / refresh a small typing pill just above the composer.
  const wrap = document.getElementById("chat-msgs");
  const composer = document.getElementById("chat-form");
  if (!wrap || !composer) return;
  let pill = document.getElementById("chat-typing");
  if (!pill) {
    pill = document.createElement("div");
    pill.id = "chat-typing";
    pill.className = "chat-typing";
    pill.innerHTML = `
      <span class="chat-typing-dots"><span></span><span></span><span></span></span>
      <span>Dispatch is typing…</span>`;
    composer.parentNode.insertBefore(pill, composer);
  }
  pill.classList.add("show");
  clearTimeout(_drvPresence.typingTimer);
  _drvPresence.typingTimer = setTimeout(() => {
    const el = document.getElementById("chat-typing");
    if (el) el.classList.remove("show");
  }, 4000);
}

// Realtime channel for the driver's own dispatch chat. Tears the
// previous channel down on each call so flipping into Channels and
// back doesn't leak subscriptions.
let _chatRealtimeChannel = null;
let _chatRealtimeDebounce = null;
function _chatRealtimeWire(session) {
  const drvId = session?.driver_id;
  if (!drvId) return;
  if (_chatRealtimeChannel) { try { sb.removeChannel(_chatRealtimeChannel); } catch {} _chatRealtimeChannel = null; }
  const fire = () => {
    clearTimeout(_chatRealtimeDebounce);
    _chatRealtimeDebounce = setTimeout(() => {
      if (currentRoute() !== "/chat" || _chatTab !== "dispatch") return;
      refreshChat(false);
    }, 200);
  };
  _chatRealtimeChannel = sb.channel("rr-driver-chat-" + drvId)
    .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "driver_messages", filter: `driver_id=eq.${drvId}` },
        fire)
    .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "driver_messages", filter: `driver_id=eq.${drvId}` },
        fire)
    .subscribe(_onChatRealtimeStatus);
}

async function refreshChat(scrollToBottom) {
  const session = readSession();
  if (!session?.token) return;
  const wrap = document.getElementById("chat-msgs");
  if (!wrap) return;

  // ─── Smart scroll anchor + skeleton ────────────────────────────────
  // Capture position before re-render so we can re-pin to bottom only
  // if the driver was already there.  First render shows a skeleton
  // instead of a bare spinner.
  const prevScrollTop    = wrap.scrollTop;
  const prevScrollHeight = wrap.scrollHeight;
  const prevClientHeight = wrap.clientHeight;
  const wasNearBottom    = (prevScrollHeight - prevScrollTop - prevClientHeight) < 120;
  const prevMsgCount     = parseInt(wrap.dataset.rrMsgCount || "-1", 10);
  const isFirstPaint     = !wrap.querySelector(".chat-bubble") && !wrap.querySelector(".rr-empty");
  if (isFirstPaint && !wrap.querySelector(".chat-skeleton")) {
    // Sentinel comes along on the first paint too — the bubble list
    // re-render replaces this within a tick, but keeping the sentinel
    // present from the very first paint avoids any frame where there
    // is no anchor target at all.
    wrap.innerHTML = `<div class="chat-skeleton">
      <div class="chat-skeleton-row"><div class="chat-skeleton-bubble" style="width:62%"></div></div>
      <div class="chat-skeleton-row right"><div class="chat-skeleton-bubble" style="width:48%"></div></div>
      <div class="chat-skeleton-row"><div class="chat-skeleton-bubble" style="width:38%"></div></div>
      <div class="chat-skeleton-row right"><div class="chat-skeleton-bubble" style="width:55%"></div></div>
    </div>
    <div class="chat-bottom-sentinel" aria-hidden="true"></div>`;
  }

  const [{ data, error }, _reactRes] = await Promise.all([
    sb.rpc("driver_chat_list", { p_token: session.token, p_limit: 200 }),
    sb.rpc("driver_chat_reactions", { p_token: session.token }).then((r) => r, () => ({ data: null })),
  ]);
  if (error) {
    if (/unauthorized|revoked|inactive/.test(error.message || "")) {
      writeSession(null); render(); return;
    }
    wrap.innerHTML = `<div class="empty-state" style="color:var(--text-muted)">Couldn't load messages. Pull down to retry.</div>`;
    return;
  }
  const messages = data?.messages || [];
  const peerReadAt = data?.peer_last_read_at ? new Date(data.peer_last_read_at).getTime() : 0;
  wrap.dataset.rrMsgCount = String(messages.length);
  const _chatReactions = _reactRes?.data?.reactions || [];

  // Strip optimistic stubs whose body now appears in the canonical set.
  const stubBodies = new Set(
    Array.from(wrap.querySelectorAll(".chat-bubble.pending"))
      .map((el) => (el.textContent || "").trim().slice(0, 200))
  );

  if (messages.length === 0) {
    // Carry forward live stubs so a failed first send isn't wiped.
    const liveStubs = Array.from(wrap.querySelectorAll(".chat-bubble.pending, .chat-bubble.failed"))
      .map((el) => el.outerHTML).join("");
    // Sentinel must be the LAST child of .chat-msgs for browser scroll-
    // anchoring to land on it (see .chat-bottom-sentinel CSS).
    wrap.innerHTML = `${liveStubs}
      <div class="rr-empty">
        <div class="rr-empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </div>
        <div class="rr-empty-title">No messages yet</div>
        <div class="rr-empty-sub">Type below to start a conversation with dispatch.</div>
      </div>
      <button type="button" class="chat-jump" id="chat-jump" aria-label="Jump to latest"></button>
      <div class="chat-bottom-sentinel" aria-hidden="true"></div>`;
  } else {
    // Index of the last driver-sent message read by dispatch, and of the
    // last driver-sent message overall (for the "Sent" affordance).
    let lastReadMineIdx = -1;
    let lastMineIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].sender_kind !== "driver") continue;
      if (lastMineIdx === -1) lastMineIdx = i;
      if (peerReadAt > 0 && new Date(messages[i].created_at).getTime() <= peerReadAt) { lastReadMineIdx = i; break; }
    }
    const _ckRead = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6.5 9.2 15.5 6.5 12.8"/><path d="M22 6.5 14.6 14.4"/></svg>`;
    const _ckSent = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6.5 9.5 17 4.5 12"/></svg>`;
    let html = "";
    let lastSender = null;
    let lastTimeMs = 0;
    let lastDateKey = "";
    const today = new Date(); today.setHours(0,0,0,0);
    const yest = new Date(today); yest.setDate(yest.getDate() - 1);
    const dayLabel = (d) => {
      const cur = new Date(d); cur.setHours(0,0,0,0);
      if (cur.getTime() === today.getTime()) return "Today";
      if (cur.getTime() === yest.getTime()) return "Yesterday";
      const sameYear = cur.getFullYear() === today.getFullYear();
      return cur.toLocaleDateString(undefined, sameYear
        ? { weekday: "long", month: "long", day: "numeric" }
        : { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    };
    messages.forEach((m, i) => {
      const t = new Date(m.created_at);
      const dateKey = t.toDateString();
      if (dateKey !== lastDateKey) {
        html += `<div class="chat-day">${escapeHtml(dayLabel(t))}</div>`;
        lastDateKey = dateKey;
        lastSender = null;
      }
      const sameAsPrev = m.sender_kind === lastSender && (t.getTime() - lastTimeMs) < 5 * 60 * 1000;
      const next = messages[i + 1];
      const sameAsNext = next
        && next.sender_kind === m.sender_kind
        && new Date(next.created_at).toDateString() === dateKey
        && (new Date(next.created_at).getTime() - t.getTime()) < 5 * 60 * 1000;
      let pos = "single";
      if      (sameAsPrev && sameAsNext) pos = "middle";
      else if (sameAsPrev)               pos = "last";
      else if (sameAsNext)               pos = "first";
      lastSender = m.sender_kind;
      lastTimeMs = t.getTime();
      html += chatBubbleHtml(m, pos);
      if (i === lastReadMineIdx) {
        html += `<div class="chat-read-receipt read">${_ckRead}Read</div>`;
      } else if (i === lastMineIdx) {
        // Latest message went out but dispatch hasn't opened it yet.
        html += `<div class="chat-read-receipt sent">${_ckSent}Sent</div>`;
      }
    });
    // Carry forward in-flight / failed optimistic bubbles.
    const liveStubs = Array.from(wrap.querySelectorAll(".chat-bubble.pending, .chat-bubble.failed"))
      .filter((el) => !stubBodies.has((el.textContent || "").trim().slice(0, 200)))
      .map((el) => el.outerHTML).join("");
    // Sentinel must be the LAST child for browser scroll-anchoring to
    // pick it as the anchor when the driver is at the bottom.  See the
    // .chat-bottom-sentinel rule in styles.css.
    wrap.innerHTML = html + liveStubs +
      `<button type="button" class="chat-jump" id="chat-jump" aria-label="Jump to latest">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        <span id="chat-jump-label">New messages</span>
      </button>
      <div class="chat-bottom-sentinel" aria-hidden="true"></div>`;
    _rrSignChatAttachments();
    _applyChatReactions(_chatReactions);
  }
  // Wire the smart anchor-release: on scroll-up, flip data-rr-anchor="0"
  // on .chat-msgs which switches the sentinel's overflow-anchor to none
  // (so the browser doesn't fight the driver scrolling up to read).
  // Idempotent — bound once per .chat-msgs element.
  _rrChatBindAnchorRelease(wrap);

  // Wire jump pill (rebound on every render).
  const jump = document.getElementById("chat-jump");
  if (jump) {
    jump.addEventListener("click", () => {
      // Re-arm anchor BEFORE scrolling so the post-scroll reflow
      // (read-receipt land, image hydration) keeps the driver pinned.
      wrap.dataset.rrAnchor = "1";
      wrap.scrollTo({ top: wrap.scrollHeight, behavior: "smooth" });
      jump.classList.remove("show");
      _chatNewCount = 0; _setChatJumpLabel();
    });
  }

  if (scrollToBottom || wasNearBottom) {
    wrap.dataset.rrAnchor = "1";
    wrap.scrollTop = wrap.scrollHeight;
    if (jump) jump.classList.remove("show");
    _chatNewCount = 0; _setChatJumpLabel();
  } else if (prevMsgCount >= 0 && messages.length > prevMsgCount) {
    // Driver was scrolled up; new content arrived — keep them put and
    // surface the jump-pill with a running count.  Anchor stays at "0"
    // so the sentinel's overflow-anchor is `none` and the browser won't
    // yank them down.
    _chatNewCount += messages.length - prevMsgCount;
    _setChatJumpLabel();
    wrap.dataset.rrAnchor = "0";
    if (jump) jump.classList.add("show");
  } else {
    _setChatJumpLabel();
  }

  // Drop the badge to 0 — they're looking at the chat.
  setAppBadge(0);
  _setChatTabBadge(0);

  // Mark-read whenever there's at least one dispatch message
  if (messages.some((m) => m.sender_kind === "dispatch")) {
    sb.rpc("driver_chat_mark_read", { p_token: session.token }).then(undefined, () => {});
  }
}

function chatBubbleHtml(m, pos) {
  const mine = m.sender_kind === "driver";
  const t = new Date(m.created_at);
  const time = t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const groupAttr = pos ? ` data-group-pos="${pos}"` : "";
  // Body — escape first, then swap http(s) URLs into <a> tags.  The
  // driver's own bubble is white-on-accent, so its links inherit the
  // white instead of using var(--accent).
  const body = m.body
    ? linkifyEscaped(escapeHtml(m.body).replace(/\n/g, "<br>"), mine)
    : "";

  // Attachment — Supabase signed URL keeps a bucket-private file
  // viewable via a short-lived link.  We mint inline at render time
  // so the link works without exposing a public bucket.
  let attachment = "";
  if (m.attachment_path) {
    const isImg = (m.attachment_mime || "").startsWith("image/");
    const name  = m.attachment_name || "Attachment";
    const sizeKb = m.attachment_size_bytes ? Math.round(m.attachment_size_bytes / 1024) : null;
    if (isImg) {
      // width/height HTML attributes (NOT just CSS) give the browser
      // the intrinsic size BEFORE any stylesheet parses — the box is
      // 240×240 from the first style-resolution tick.  Combined with
      // object-fit:cover from CSS, the image NEVER changes its own
      // height once src lands, so there's nothing for the browser's
      // scroll-anchor algorithm to "preserve" (which is what was
      // yanking the driver UP to a fixed image position).  Same fix
      // as dashboard PR #597.
      //
      // Vector images (e.g. the install-instructions diagram on the
      // welcome message) override object-fit:cover with `contain` so
      // the whole illustration is visible — cropping the middle out
      // of a how-to diagram defeats the point. Photos still cover
      // and crop.
      const isVector = (m.attachment_mime || "").includes("svg");
      const extraStyle = isVector ? "object-fit:contain;background:#fff;" : "";
      attachment = `<img data-rr-attach="${escapeHtml(m.attachment_path)}" alt="${escapeHtml(name)}" width="240" height="240" loading="eager" decoding="async" style="max-width:240px;border-radius:10px;margin-bottom:6px;cursor:zoom-in;${extraStyle}" onclick="window.open(this.src,'_blank')"/>`;
    } else {
      attachment = `
        <a data-rr-attach="${escapeHtml(m.attachment_path)}" target="_blank" rel="noopener" style="display:flex;gap:8px;align-items:center;padding:8px 10px;background:var(--canvas);border:1px solid var(--border);border-radius:10px;margin-bottom:6px;text-decoration:none;color:inherit;max-width:240px">
          <span style="font-size:18px">📎</span>
          <span style="flex:1;min-width:0">
            <span style="display:block;font-weight:600;font-size:var(--fs-sm);color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(name)}</span>
            ${sizeKb != null ? `<span style="display:block;font-size:var(--fs-xs);color:var(--text-subtle)">${sizeKb} KB</span>` : ""}
          </span>
        </a>`;
    }
  }

  // Priority + ack-required (set by dispatch via dispatch_chat_send).
  // Urgent/high gets a left accent bar via .urgent / .high classes;
  // ack-required dispatch messages render an Acknowledge button until
  // the driver taps it (then it flips to a green "Acknowledged" pill).
  const priCls = m.priority === "urgent" ? " urgent"
                : m.priority === "high"   ? " high" : "";
  const showUrgentTag = !mine && m.priority === "urgent";
  let ack = "";
  if (!mine && m.requires_ack) {
    if (m.acked_at) {
      const at = new Date(m.acked_at).toLocaleString([], { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" });
      ack = `<div class="chat-ack acked"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6.5 9.5 17 4.5 12"/></svg>Acknowledged · ${escapeHtml(at)}</div>`;
    } else {
      ack = `<button type="button" class="chat-ack-btn" data-rr-ack="${escapeHtml(m.id)}">Acknowledge</button>`;
    }
  }

  const likeBtn = m.deleted_at ? "" : `<button type="button" class="chat-like" data-rr-like="${escapeHtml(m.id)}" aria-label="Like"><span class="chat-like-icon" aria-hidden="true">👍</span><span class="chat-like-n"></span></button>`;
  return `
    <div class="chat-bubble ${mine ? "mine" : "theirs"}${priCls}"${groupAttr} data-rr-msg-id="${escapeHtml(m.id)}">
      ${showUrgentTag ? `<div class="chat-pri-tag">Urgent</div>` : ""}
      ${attachment}
      ${body ? `<div class="chat-body">${body}</div>` : ""}
      ${ack}
      <div class="chat-time">${escapeHtml(time)}</div>
      ${likeBtn}
    </div>`;
}

// ─── Message likes (👍) ──────────────────────────────────────────────────
// Driver side of the two-way reaction.  Counts come from
// driver_chat_reactions (the message-fetch RPC is untouched); the driver's
// own tap is optimistic, and dispatch's likes land on the next chat refresh.
function _setChatLike(btn, count, mine) {
  if (!btn) return;
  btn.classList.toggle("on", !!mine);
  btn.classList.toggle("has", (count || 0) > 0);
  const ns = btn.querySelector(".chat-like-n");
  if (ns) ns.textContent = (count || 0) > 0 ? String(count) : "";
}
function _applyChatReactions(entries) {
  const wrap = document.getElementById("chat-msgs");
  if (!wrap) return;
  const map = new Map((entries || []).map((e) => [String(e.message_id), e]));
  wrap.querySelectorAll("[data-rr-like]").forEach((btn) => {
    const e = map.get(String(btn.getAttribute("data-rr-like")));
    _setChatLike(btn, e ? (e.like_count || 0) : 0, !!(e && e.liked_by_me));
  });
}
// Tap to like — delegated so it survives the chat's re-render.
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-rr-like]");
  if (!btn) return;
  const session = readSession();
  if (!session?.token) return;
  const id = btn.getAttribute("data-rr-like");
  const turningOn = !btn.classList.contains("on");
  const ns = btn.querySelector(".chat-like-n");
  const cur = parseInt((ns && ns.textContent) || "0", 10) || 0;
  _setChatLike(btn, Math.max(0, cur + (turningOn ? 1 : -1)), turningOn); // optimistic
  try {
    const { data, error } = await sb.rpc("driver_message_react", { p_token: session.token, p_message_id: id, p_on: turningOn });
    if (error) throw error;
    if (data) _setChatLike(btn, data.like_count || 0, !!data.liked_by_me);
  } catch (_) {
    _setChatLike(btn, cur, !turningOn); // revert on failure
  }
});
// Press-and-hold a bubble to reveal its Like button (mobile reaction
// gesture).  Existing like counts (.has) show regardless; this just gates
// the tap-to-like affordance behind a long-press so it isn't always on.
(function _wireChatLongPress() {
  let timer = null, sx = 0, sy = 0;
  const clearReveals = (keep) => document.querySelectorAll(".chat-bubble.reveal-like")
    .forEach((b) => { if (b !== keep) b.classList.remove("reveal-like"); });
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  document.addEventListener("touchstart", (e) => {
    const bubble = e.target.closest && e.target.closest(".chat-bubble");
    if (!bubble || (e.target.closest && e.target.closest("[data-rr-like], a, button"))) return;
    const t = (e.touches && e.touches[0]) || e;
    sx = t.clientX; sy = t.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      clearReveals(bubble);
      bubble.classList.add("reveal-like");
      try { navigator.vibrate && navigator.vibrate(8); } catch (_) {}
    }, 420);
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (!timer) return;
    const t = (e.touches && e.touches[0]) || e;
    if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) cancel();
  }, { passive: true });
  document.addEventListener("touchend", cancel, { passive: true });
  document.addEventListener("touchcancel", cancel, { passive: true });
  // A tap anywhere that isn't the Like button collapses a revealed bubble.
  document.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("[data-rr-like]")) return;
    clearReveals(null);
  });
})();

// Resolve attachment paths to short-lived signed URLs after each
// chat render, then swap them into the <img>/<a> tags.  We do this
// lazily because signed URLs are per-call; the bucket itself is
// private so we never want to expose paths directly.
async function _rrSignChatAttachments() {
  const els = document.querySelectorAll("[data-rr-attach]:not([data-rr-attach-resolved])");
  for (const el of els) {
    const path = el.getAttribute("data-rr-attach");
    el.setAttribute("data-rr-attach-resolved", "1");
    // Paths that look like absolute URLs or root-relative app assets
    // (e.g. "/app/icons/install-instructions.svg" shipped with the
    // welcome message from migration 0266) are used directly — no
    // bucket signed-URL round-trip. Bucket paths look like
    // "<uuid>/<file>" and never start with "/" or "http".
    const isDirect = /^https?:\/\//i.test(path) || path.startsWith("/");
    if (isDirect) {
      if (el.tagName === "IMG") {
        el.addEventListener("load",  () => el.setAttribute("data-rr-loaded", "1"), { once: true });
        el.addEventListener("error", () => el.setAttribute("data-rr-loaded", "1"), { once: true });
        el.src = path;
      } else {
        el.href = path;
      }
      continue;
    }
    try {
      const { data, error } = await sb.storage
        .from("driver-chat-attachments")
        .createSignedUrl(path, 60 * 60 * 8); // 8h
      if (error || !data?.signedUrl) continue;
      if (el.tagName === "IMG") {
        // Bind load BEFORE assigning src so the loaded flag flips even
        // for cached images (cached <img>s can fire load synchronously
        // on src assignment, before any externally-attached listener).
        // Once loaded, we drop the shimmer / placeholder background.
        el.addEventListener("load", () => {
          el.setAttribute("data-rr-loaded", "1");
        }, { once: true });
        el.addEventListener("error", () => {
          el.setAttribute("data-rr-loaded", "1");
        }, { once: true });
        el.src = data.signedUrl;
      } else {
        el.href = data.signedUrl;
      }
    } catch {}
  }
}

// Smart anchor-release for .chat-msgs.  When the driver scrolls up
// to read history, flip data-rr-anchor="0" so the bottom-sentinel's
// overflow-anchor goes to `none` — that way the browser stops trying
// to keep them at the bottom while content lands above.  When they
// come back to within 80px of the bottom, re-arm to "1".  Bound once
// per .chat-msgs element via a private flag.
function _rrChatBindAnchorRelease(wrap) {
  if (!wrap || wrap._rrChatAnchorBound) return;
  wrap._rrChatAnchorBound = true;
  // Default state: pinned to bottom.  Refresh callers that detected
  // wasNearBottom set this explicitly; this is just the initial value.
  if (!wrap.dataset.rrAnchor) wrap.dataset.rrAnchor = "1";
  const release = () => {
    requestAnimationFrame(() => {
      const cur = wrap.scrollTop;
      const max = wrap.scrollHeight;
      const view = wrap.clientHeight;
      if ((max - cur - view) > 80) wrap.dataset.rrAnchor = "0";
      else wrap.dataset.rrAnchor = "1";
      // Also fold the jump-pill in once they're back near bottom, and
      // clear the "N new" count — they've caught up.
      const jump = wrap.querySelector(".chat-jump");
      if ((max - cur - view) <= 80) {
        if (jump) jump.classList.remove("show");
        if (_chatNewCount) { _chatNewCount = 0; _setChatJumpLabel(); }
      }
    });
  };
  wrap.addEventListener("scroll",    release, { passive: true });
  wrap.addEventListener("wheel",     release, { passive: true });
  wrap.addEventListener("touchmove", release, { passive: true });
}


// ── Channels (driver app side) ─────────────────────────────────────
// driver_channels_list returns every channel the driver belongs to,
// with unread counts.  Click → driver_channel_messages renders the
// thread, composer posts via driver_channel_post.

let _chatChannelPollTimer = null;

async function renderChatChannelsList() {
  _chatTab = "channels";
  _chatChannelId = null;
  setHeader("Channels", "");
  const main = document.getElementById("main");
  main.innerHTML = `
    <div id="chat-shell">
      <div id="chat-tabs" class="chat-tabs">
        <button class="chat-tab" data-rr-chat-tab="dispatch">Dispatch</button>
        <button class="chat-tab active" data-rr-chat-tab="channels">Channels</button>
      </div>
      <div id="chat-channel-list" class="chat-channel-list" style="flex:1;overflow-y:auto;background:var(--canvas);padding:8px 0">
        <div class="loader" style="margin:60px auto"></div>
      </div>
    </div>`;

  document.querySelectorAll("[data-rr-chat-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-rr-chat-tab");
      if (next === _chatTab) return;
      if (_chatChannelPollTimer) { clearInterval(_chatChannelPollTimer); _chatChannelPollTimer = null; }
      navigate(next === "channels" ? "/chat/channels" : "/chat");
    });
  });

  await refreshChannelList();
  if (_chatChannelPollTimer) clearInterval(_chatChannelPollTimer);
  _chatChannelPollTimer = setInterval(() => {
    if (document.hidden) return;
    if (currentRoute() !== "/chat/channels") {
      clearInterval(_chatChannelPollTimer); _chatChannelPollTimer = null; return;
    }
    refreshChannelList();
  }, 10000);
}

async function refreshChannelList() {
  const session = readSession();
  if (!session?.token) return;
  const list = document.getElementById("chat-channel-list");
  if (!list) return;
  const { data, error } = await sb.rpc("driver_channels_list", { p_token: session.token });
  if (error) {
    if (/unauthorized|revoked|inactive/.test(error.message || "")) {
      writeSession(null); render(); return;
    }
    list.innerHTML = `<div class="empty-state" style="color:var(--text-muted)">Couldn't load channels. Pull down to retry.</div>`;
    return;
  }
  const channels = data?.channels || [];
  if (channels.length === 0) {
    list.innerHTML = `
      <div class="rr-empty">
        <div class="rr-empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </div>
        <div class="rr-empty-title">No channels yet</div>
        <div class="rr-empty-sub">Your dispatcher will add you to channels for your station or team.</div>
      </div>`;
    return;
  }
  const fmtRel = (iso) => {
    if (!iso) return "—";
    const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return "now";
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d`;
    return new Date(iso).toLocaleDateString();
  };
  list.innerHTML = channels.map(c => {
    const lastBody = c.last_message
      ? (c.last_sender ? `${c.last_sender}: ` : "") + c.last_message
      : `${c.member_count || 0} member${c.member_count === 1 ? "" : "s"}`;
    const lastBodyTrunc = lastBody.length > 60 ? lastBody.slice(0, 57) + "…" : lastBody;
    const stationChip = c.station_code
      ? `<span style="font-size:var(--fs-xs);color:var(--text-subtle);background:var(--canvas);padding:1px 6px;border-radius:8px;margin-left:6px">${escapeHtml(c.station_code)}</span>`
      : "";
    const unread = c.unread > 0
      ? `<span style="background:var(--accent);color:var(--rr-white);font-size:var(--fs-xs);font-weight:700;padding:2px 7px;border-radius:10px;min-width:20px;text-align:center">${c.unread}</span>`
      : "";
    return `
      <div class="chat-channel-row" data-rr-open-channel="${escapeHtml(c.id)}" style="display:flex;gap:12px;align-items:center;padding:14px 16px;background:var(--surface);margin:0 12px 8px;border:1px solid var(--border);border-radius:14px;cursor:pointer;min-height:64px;box-shadow:var(--shadow-xs)">
        <div class="avatar-sm" style="background:var(--accent-soft);color:var(--accent-text);width:40px;height:40px;border-radius:20px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;flex-shrink:0">#</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;line-height:1.25">
            <span style="font-size:var(--fs-lg);font-weight:600;color:var(--text);letter-spacing:-.005em">${escapeHtml(c.name)}</span>
            ${stationChip}
          </div>
          <div style="font-size:var(--fs-sm);color:var(--text-subtle);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.35">${escapeHtml(lastBodyTrunc)}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0">
          <div style="font-size:var(--fs-xs);color:var(--text-subtle);font-variant-numeric:tabular-nums">${escapeHtml(fmtRel(c.last_message_at))}</div>
          ${unread}
        </div>
      </div>`;
  }).join("");

  list.querySelectorAll("[data-rr-open-channel]").forEach(el => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-rr-open-channel");
      // Cache the header meta so the thread paints its name instantly;
      // the thread itself resolves meta from the RPC on deep links.
      _chatChannelMeta = channels.find(c => c.id === id) || null;
      if (_chatChannelPollTimer) { clearInterval(_chatChannelPollTimer); _chatChannelPollTimer = null; }
      navigate("/chat/channel?id=" + encodeURIComponent(id));
    });
  });
}

async function renderChatChannelThread() {
  // Route-driven: /chat/channel?id=… — the router supplies the back
  // arrow (→ /chat/channels), history pops naturally, and dispatchers
  // can deep-link a channel. Meta comes from the list tap when we have
  // it; on a cold deep link it's resolved from driver_channels_list.
  _chatTab = "channels";
  const qid = routeQuery().get("id");
  if (qid) _chatChannelId = qid;
  if (!_chatChannelId) { navigate("/chat/channels"); return; }
  if (_chatChannelMeta && _chatChannelMeta.id !== _chatChannelId) _chatChannelMeta = null;
  const meta = _chatChannelMeta || {};
  setHeader(`#${meta.name || "channel"}`, meta.station_code ? `station ${meta.station_code}` : `${meta.member_count || 0} member${meta.member_count === 1 ? "" : "s"}`);
  if (!_chatChannelMeta) {
    // Deep link — fill the header in once the channel list resolves.
    const wantedId = _chatChannelId;
    const s = readSession();
    if (s?.token) {
      sb.rpc("driver_channels_list", { p_token: s.token }).then(({ data }) => {
        if (currentRoute() !== "/chat/channel" || _chatChannelId !== wantedId) return;
        const m = (data?.channels || []).find((c) => c.id === wantedId);
        if (!m) return;
        _chatChannelMeta = m;
        setHeader(`#${m.name || "channel"}`, m.station_code ? `station ${m.station_code}` : `${m.member_count || 0} member${m.member_count === 1 ? "" : "s"}`);
        const taEl = document.getElementById("chat-input");
        if (taEl) taEl.placeholder = `Post to #${m.name || "channel"}…`;
      }).catch(() => {});
    }
  }

  const main = document.getElementById("main");
  main.innerHTML = `
    <div id="chat-shell">
      <div id="chat-msgs" class="chat-msgs"><div class="loader"></div></div>
      <form class="chat-composer" id="chat-form">
        <input id="chat-file" type="file" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt" hidden>
        <button id="chat-attach" type="button" class="chat-attach" aria-label="Attach photo or document" title="Attach">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <div style="flex:1;display:flex;flex-direction:column;gap:6px;min-width:0">
          <div id="chat-attachment-preview" style="display:none"></div>
          <textarea id="chat-input" rows="1" placeholder="Post to #${escapeHtml(meta.name || "channel")}…" maxlength="2000"></textarea>
        </div>
        <button class="chat-send" type="submit" aria-label="Send">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </form>
    </div>`;

  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }

  const ta = document.getElementById("chat-input");
  ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(120, ta.scrollHeight) + "px"; });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(pointer:fine)").matches) {
      e.preventDefault();
      document.getElementById("chat-form").requestSubmit();
    }
  });
  // Per-channel draft — survives leaving the thread, a tab switch, or an
  // app restart, matching the dispatch-chat composer.
  const draftKey = `chat:channel:${_chatChannelId}`;
  const savedDraft = getDraft(draftKey);
  if (savedDraft && !ta.value) { ta.value = savedDraft; ta.dispatchEvent(new Event("input")); }
  ta.addEventListener("input", () => setDraft(draftKey, ta.value));

  const fileInput = document.getElementById("chat-file");
  const previewEl = document.getElementById("chat-attachment-preview");
  document.getElementById("chat-attach").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (!f) { window._rrChatPending = null; previewEl.style.display = "none"; previewEl.innerHTML = ""; return; }
    if (f.size > 15 * 1024 * 1024) { toast("File too large (max 15 MB)", "warn"); fileInput.value = ""; return; }
    window._rrChatPending = f;
    const isImg = f.type.startsWith("image/");
    const sizeKb = Math.round(f.size / 1024);
    previewEl.style.display = "";
    previewEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;background:var(--canvas);border:1px solid var(--border);border-radius:8px;padding:6px 10px;font-size:var(--fs-sm)">
        ${isImg ? `<img src="${URL.createObjectURL(f)}" alt="" style="width:36px;height:36px;border-radius:6px;object-fit:cover">`
                : `<span style="font-size:18px">📎</span>`}
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(f.name)}</div>
          <div style="color:var(--text-subtle)">${sizeKb} KB</div>
        </div>
        <button type="button" id="chat-attach-clear" class="chat-attach-x" aria-label="Remove attachment">×</button>
      </div>`;
    document.getElementById("chat-attach-clear").addEventListener("click", () => {
      fileInput.value = "";
      window._rrChatPending = null;
      previewEl.style.display = "none";
      previewEl.innerHTML = "";
    });
  });

  document.getElementById("chat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (form._rrSending) return;   // Enter + tap can double-fire — one post at a time.
    const body = (ta.value || "").trim();
    const file = window._rrChatPending;
    if (!body && !file) return;
    const sendBtn = form.querySelector(".chat-send");
    form._rrSending = true;
    if (sendBtn) sendBtn.disabled = true;
    try {
      let attachment = null;
      if (file) {
        let dspId    = session.dsp_id;
        let driverId = session.driver_id;
        if (!dspId || !driverId) {
          const { data: me } = await sb.rpc("driver_me", { p_token: session.token });
          dspId    = me?.dsp_id    || dspId;
          driverId = me?.id        || driverId;
          const cur = readSession();
          if (cur && (dspId || driverId)) writeSession({ ...cur, dsp_id: dspId, driver_id: driverId });
        }
        if (!dspId || !driverId) { toast("Profile incomplete — sign out and back in", "warn"); return; }
        const ext = (file.name.split(".").pop() || "bin").toLowerCase().slice(0, 8);
        const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || `file.${ext}`;
        const path = `${dspId}/${driverId}/channels/${_chatChannelId}/${Date.now()}-${safe}`;
        const { error: upErr } = await sb.storage
          .from("driver-chat-attachments").upload(path, file, { contentType: file.type, upsert: false });
        if (upErr) { toast(_friendlyError(upErr, "Couldn't attach that file. Try again."), "warn"); return; }
        attachment = { path, mime: file.type, name: file.name, size: file.size };
      }

      const { error } = await sb.rpc("driver_channel_post", {
        p_token:                 session.token,
        p_channel_id:            _chatChannelId,
        p_body:                  body || null,
        p_attachment_path:       attachment?.path || null,
        p_attachment_mime:       attachment?.mime || null,
        p_attachment_name:       attachment?.name || null,
        p_attachment_size_bytes: attachment?.size || null,
      });
      if (error) {
        // The composer still holds the text/attachment — nothing was lost.
        toast(_friendlyError(error, "Couldn't post — your message is still here. Try again."), "warn");
        return;
      }
      // Success — only now is it safe to clear the composer + draft.
      ta.value = ""; ta.style.height = "auto";
      clearDraft(draftKey);
      if (file) {
        window._rrChatPending = null;
        fileInput.value = "";
        previewEl.style.display = "none";
        previewEl.innerHTML = "";
      }
      await refreshChannelThread(true);
    } finally {
      form._rrSending = false;
      if (sendBtn) sendBtn.disabled = false;
    }
  });

  await refreshChannelThread(true);
  _chatChannelRealtimeWire(_chatChannelId);
  if (_chatChannelPollTimer) clearInterval(_chatChannelPollTimer);
  // Realtime is primary; the poller is just a safety net.
  _chatChannelPollTimer = setInterval(() => {
    if (document.hidden) return;
    if (currentRoute() !== "/chat/channel" || !_chatChannelId) {
      clearInterval(_chatChannelPollTimer); _chatChannelPollTimer = null; return;
    }
    refreshChannelThread(false);
  }, 30000);
}

let _chatChannelRealtimeChannel = null;
let _chatChannelRealtimeDebounce = null;
function _chatChannelRealtimeWire(channelId) {
  if (_chatChannelRealtimeChannel) {
    try { sb.removeChannel(_chatChannelRealtimeChannel); } catch {}
    _chatChannelRealtimeChannel = null;
  }
  if (!channelId) return;
  const fire = () => {
    clearTimeout(_chatChannelRealtimeDebounce);
    _chatChannelRealtimeDebounce = setTimeout(() => {
      if (currentRoute() !== "/chat/channel" || _chatChannelId !== channelId) return;
      refreshChannelThread(false);
    }, 200);
  };
  _chatChannelRealtimeChannel = sb.channel("rr-driver-channel-" + channelId)
    .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "driver_channel_messages", filter: `channel_id=eq.${channelId}` },
        fire)
    .subscribe();
}

async function refreshChannelThread(scrollToBottom) {
  const session = readSession();
  if (!session?.token || !_chatChannelId) return;
  const wrap = document.getElementById("chat-msgs");
  const { data, error } = await sb.rpc("driver_channel_messages", {
    p_token: session.token, p_channel_id: _chatChannelId, p_limit: 200,
  });
  if (error) {
    if (/unauthorized|revoked|inactive/.test(error.message || "")) {
      writeSession(null); render(); return;
    }
    if (wrap) {
      wrap.innerHTML = `<div class="empty-state" style="color:var(--text-muted)">Couldn't load channel. Pull down to retry.</div>`;
    }
    return;
  }
  if (!wrap) return;
  // Capture position BEFORE re-render so we can decide whether to
  // re-pin to bottom (driver was already there) or leave their
  // scroll position untouched (they scrolled up to read history).
  const prevScrollTop    = wrap.scrollTop;
  const prevScrollHeight = wrap.scrollHeight;
  const prevClientHeight = wrap.clientHeight;
  const wasNearBottom    = (prevScrollHeight - prevScrollTop - prevClientHeight) < 120;
  const messages = data?.messages || [];
  if (messages.length === 0) {
    wrap.innerHTML = `<div class="empty-state">No messages yet. Be the first to post.</div>
      <div class="chat-bottom-sentinel" aria-hidden="true"></div>`;
  } else {
    // Sender grouping — consecutive messages from the same author
    // within 5 minutes collapse into a block.  Sender label only on
    // first/single bubbles, timestamp on last/single.  Same model
    // as the dispatcher rr-cc render.
    let lastSenderKey = null;
    let lastTimeMs = 0;
    wrap.innerHTML = messages.map((m, i) => {
      const t = new Date(m.created_at);
      const senderKey = m.sender_kind + "|" + (m.sender_id || m.sender_user_id || m.sender_name || "");
      const sameAsPrev = senderKey === lastSenderKey && (t.getTime() - lastTimeMs) < 5 * 60 * 1000;
      const next = messages[i + 1];
      const nextKey = next ? next.sender_kind + "|" + (next.sender_id || next.sender_user_id || next.sender_name || "") : null;
      const sameAsNext = next
        && nextKey === senderKey
        && (new Date(next.created_at).getTime() - t.getTime()) < 5 * 60 * 1000;
      let pos = "single";
      if      (sameAsPrev && sameAsNext) pos = "middle";
      else if (sameAsPrev)               pos = "last";
      else if (sameAsNext)               pos = "first";
      lastSenderKey = senderKey;
      lastTimeMs = t.getTime();
      return channelBubbleHtml(m, pos);
    }).join("") + `<div class="chat-bottom-sentinel" aria-hidden="true"></div>`;
    _rrSignChatAttachments();
  }
  // Bind the smart-anchor-release listener (scroll-up flips
  // data-rr-anchor="0" so the browser doesn't fight the driver).
  _rrChatBindAnchorRelease(wrap);
  if (scrollToBottom || wasNearBottom) {
    wrap.dataset.rrAnchor = "1";
    wrap.scrollTop = wrap.scrollHeight;
  }
  setAppBadge(0);
}

// Same shape as chatBubbleHtml but routes mine/theirs off the
// is_self flag (driver could be either side of a channel post).
function channelBubbleHtml(m, pos) {
  const mine = !!m.is_self;
  const t = new Date(m.created_at);
  const time = t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const sender = m.sender_kind === "dispatch" ? "Dispatch" : (m.sender_name || "Driver");
  const groupAttr = pos ? ` data-group-pos="${pos}"` : "";
  const showSender = !mine && (pos === "first" || pos === "single" || !pos);
  const body = m.body
    ? linkifyEscaped(escapeHtml(m.body).replace(/\n/g, "<br>"), mine)
    : "";

  let attachment = "";
  if (m.attachment_path) {
    const isImg = (m.attachment_mime || "").startsWith("image/");
    const name  = m.attachment_name || "Attachment";
    const sizeKb = m.attachment_size_bytes ? Math.round(m.attachment_size_bytes / 1024) : null;
    if (isImg) {
      // Fixed 240x240 box (see chatBubbleHtml comment + styles.css).
      attachment = `<img data-rr-attach="${escapeHtml(m.attachment_path)}" alt="${escapeHtml(name)}" width="240" height="240" loading="eager" decoding="async" style="max-width:240px;border-radius:10px;margin-bottom:6px;cursor:zoom-in" onclick="window.open(this.src,'_blank')"/>`;
    } else {
      attachment = `
        <a data-rr-attach="${escapeHtml(m.attachment_path)}" target="_blank" rel="noopener" style="display:flex;gap:8px;align-items:center;padding:8px 10px;background:var(--canvas);border:1px solid var(--border);border-radius:10px;margin-bottom:6px;text-decoration:none;color:inherit;max-width:240px">
          <span style="font-size:18px">📎</span>
          <span style="flex:1;min-width:0">
            <span style="display:block;font-weight:600;font-size:var(--fs-sm);color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(name)}</span>
            ${sizeKb != null ? `<span style="display:block;font-size:var(--fs-xs);color:var(--text-subtle)">${sizeKb} KB</span>` : ""}
          </span>
        </a>`;
    }
  }

  return `
    <div class="chat-bubble ${mine ? "mine" : "theirs"}"${groupAttr}>
      ${showSender ? `<div class="chat-sender">${escapeHtml(sender)}</div>` : ""}
      ${attachment}
      ${body ? `<div class="chat-body">${body}</div>` : ""}
      <div class="chat-time">${escapeHtml(time)}</div>
    </div>`;
}

// ── Team · WhatsApp-style directory of everyone at the DSP ──────────
// Each row is one driver: photo or initial avatar, display name, a
// small meta line (station / status), and a phone button on the right.
// Tapping anywhere on the row hands off to the OS dialer via tel:; the
// button is just the visual affordance. Drivers without a phone on file
// still appear in the list (so the team is complete) but the dial
// affordance is replaced with a "—" so the row reads as informational.
async function renderTeam() {
  setHeader("Team", "");
  setRefresh(() => renderTeam());
  const main = document.getElementById("main");
  // Skeleton roster — hints at the row layout (avatar circle + two
  // lines of text + action chip) so the real list swaps in without
  // a jump. Delayed 140ms so a fast roster never flashes a shimmer.
  const _hadContent = !!main.querySelector(".team-list, .team-empty");
  const _skelTimer = _hadContent ? null : setTimeout(() => {
    if (currentRoute() !== "/team") return;
    let _skel = `<div class="team-search" style="opacity:.5;pointer-events:none">
      <svg class="team-search-ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <span style="color:var(--text-subtle);font-size:var(--fs-md)">Search teammates</span>
    </div><div class="team-list">`;
    for (let i = 0; i < 6; i++){
      _skel += `<div class="team-row">
        <span class="skel skel-circle" style="width:44px;height:44px"></span>
        <div class="team-row-body">
          <span class="skel skel-line" style="width:${55 - i*4}%"></span>
          <span class="skel skel-line-sm" style="width:${35 - i*3}%"></span>
        </div>
      </div>`;
    }
    _skel += `</div>`;
    main.innerHTML = _skel;
  }, 140);
  const _clearSkel = () => { if (_skelTimer) clearTimeout(_skelTimer); };

  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }

  const { data, error } = await sb.rpc("driver_team_roster", { p_token: session.token });
  if (currentRoute() !== "/team") return;
  _clearSkel();

  if (error) {
    main.innerHTML = `<div class="team-empty"><div class="team-empty-title">Couldn't load the team</div><div class="team-empty-sub">${escapeHtml(_friendlyError(error, "Pull down to retry."))}</div></div>`;
    return;
  }

  const list = Array.isArray(data) ? data : [];
  // driver-photos is private (0446) — batch-sign teammate photos once here so
  // the (sync) row renderer can just read d.photo_url. Best-effort; any path
  // that doesn't sign falls back to initials.
  try {
    const _paths = list.map((d) => d.photo_path).filter(Boolean);
    if (_paths.length) {
      const { data: _sig } = await sb.storage.from("driver-photos").createSignedUrls(_paths, 7 * 24 * 60 * 60);
      const _m = new Map((_sig || []).filter((s) => s && s.path && s.signedUrl && !s.error).map((s) => [s.path, s.signedUrl]));
      for (const d of list) d.photo_url = d.photo_path ? (_m.get(d.photo_path) || null) : null;
    }
  } catch (_) { /* initials fallback */ }
  if (list.length === 0) {
    main.innerHTML = `
      <div class="team-empty">
        <div class="team-empty-title">No teammates yet</div>
        <div class="team-empty-sub">When dispatch adds other drivers to your DSP, they'll show up here so you can reach them.</div>
      </div>`;
    return;
  }

  const callIcon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;
  const textIcon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

  // Pre-compute a per-row list of lowercased "words" we'll prefix-match
  // against. Each query token must match the *start* of at least one of
  // these words, so as the driver types more letters the list narrows
  // toward a single row (like iOS Contacts). Phone numbers are added
  // both as the digit-stripped form ("4175550100") and as their loose
  // segments so a partial "555" still hits "(417) 555-0100".
  const indexed = list.map((d) => {
    const raw = [
      d.name || "",
      d.full_name || "",
      d.station_code || "",
      (d.phone || "").replace(/[^0-9+]/g, ""),
      (d.phone || ""),
    ].join(" ").toLowerCase();
    const words = raw.split(/[^a-z0-9+]+/).filter(Boolean);
    return { d, words };
  });

  main.innerHTML = `
    <div class="team-search">
      <svg class="team-search-ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input id="team-search-input" class="team-search-input" type="search" placeholder="Search ${list.length} teammates…" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" inputmode="search" />
    </div>
    <div class="team-list" id="team-list" role="list">
      ${list.map((d) => _teamRowHtml(d, callIcon, textIcon)).join("")}
    </div>`;

  const input = document.getElementById("team-search-input");
  const listEl = document.getElementById("team-list");

  // Re-render the list on every keystroke so only matching rows sit in
  // the DOM, stacked directly under the search box. When the query is
  // empty we paint the full roster; when it filters everything out we
  // drop a single inline "No matches" row in place of the list so the
  // result is always immediately under the search bar (no floating box
  // at the bottom of the page).
  input.addEventListener("input", () => {
    const q = input.value;
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = tokens.length === 0
      ? list
      : indexed.filter((r) => tokens.every((t) => r.words.some((w) => w.startsWith(t))))
               .map((r) => r.d);
    if (hits.length === 0) {
      listEl.innerHTML = `<div class="team-row team-row-nomatch" role="listitem">No teammates match "${escapeHtml(q)}"</div>`;
    } else {
      listEl.innerHTML = hits.map((d) => _teamRowHtml(d, callIcon, textIcon)).join("");
    }
  });
}

function _teamRowHtml(d, callIcon, textIcon) {
  const name    = d.name || d.full_name || "—";
  const initials = initialsOf(name);
  const photo   = d.photo_url || null;  // pre-signed at team-roster load (0446)
  const avatar  = photo
    ? `<img class="team-avatar" src="${escapeHtml(photo)}" alt=""/>`
    : `<span class="team-avatar team-avatar-initials">${escapeHtml(initials)}</span>`;
  const metaBits = [];
  if (d.station_code) metaBits.push(escapeHtml(d.station_code));
  if (d.status === "onboarding") metaBits.push("Onboarding");
  const meta = metaBits.join(" · ");
  const phone = (d.phone || "").trim();
  if (phone) {
    const href = phone.replace(/[^0-9+]/g, "");
    const safe = escapeHtml(name);
    return `
      <div class="team-row" role="listitem">
        ${avatar}
        <div class="team-row-body">
          <div class="team-row-name">${safe}</div>
          <div class="team-row-meta">${meta || escapeHtml(phone)}</div>
        </div>
        <a class="team-action team-text" href="sms:${escapeHtml(href)}" aria-label="Text ${safe}" title="Text ${safe}">${textIcon}</a>
        <a class="team-action team-call" href="tel:${escapeHtml(href)}" aria-label="Call ${safe}" title="Call ${safe}">${callIcon}</a>
      </div>`;
  }
  return `
    <div class="team-row team-row-noPhone" role="listitem">
      ${avatar}
      <div class="team-row-body">
        <div class="team-row-name">${escapeHtml(name)}</div>
        <div class="team-row-meta">${meta || "No phone on file"}</div>
      </div>
      <span class="team-action team-call-disabled" aria-hidden="true">—</span>
    </div>`;
}

// ── Profile · home screen ──────────────────────────────────────────
// Branded hero on top, operational cards below.  Three slots load
// independently so each can stream in without blocking the others:
//   #rr-checkin-slot  — primary "Opens at" / check-in surface
//   #rr-missed-slot   — "Report missed day" row (only when relevant)
//   #rr-upnext-slot   — next upcoming shift summary
function renderProfileHub() {
  const session = readSession();
  const name = session?.name || "Driver";
  const dsp  = session?.dsp_name || "RouteReady";
  const greeting = homeGreeting();
  const todayLabel = homeTodayLabel();
  setHeader(dsp, "");
  const main = document.getElementById("main");
  // Brand mark (small shield) lives inside the hero brand row.
  const brandMark = `
    <span class="home-hero-brand-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5l-8-3z"/></svg>
    </span>`;
  const gearSvg = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';

  main.innerHTML = `
    <div class="home-hero">
      <div class="home-hero-bar">
        <div class="home-hero-brand">${brandMark}<span>${escapeHtml(dsp)}</span></div>
        <button class="home-hero-gear" id="rr-home-settings" type="button" aria-label="Settings">${gearSvg}</button>
      </div>
      <button class="profile-avatar-btn" id="rr-photo-btn" type="button" aria-label="Change photo">
        ${avatarHtml(session, "profile-avatar")}
        <span class="profile-avatar-edit" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
        </span>
      </button>
      <input type="file" id="rr-photo-input" accept="image/*" capture="user" style="display:none"/>
      <div class="home-hero-greeting">${escapeHtml(greeting)}</div>
      <div class="home-hero-name">${escapeHtml(name)}</div>
      <div class="home-hero-meta" id="rr-home-meta">Driver</div>
      <div class="home-hero-foot">
        <div class="home-hero-today" aria-label="Today">${escapeHtml(todayLabel)}</div>
        <div class="home-hero-status" id="rr-home-status" hidden>
          <span class="home-hero-status-dot"></span>ON DUTY
        </div>
      </div>
    </div>

    <div class="home-content">
      <div id="rr-checkin-slot">
        <div class="opens-card opens-card-muted">
          <div class="opens-card-row">
            <div class="opens-card-icon"><div class="loader" style="margin:0;width:20px;height:20px;border-width:2px"></div></div>
            <div class="opens-card-body">
              <div class="opens-card-title" style="font-size:18px">Checking your shift…</div>
              <div class="opens-card-meta">One moment</div>
            </div>
          </div>
        </div>
      </div>
      <div id="rr-missed-slot" hidden></div>
      <section class="up-next" id="rr-upnext-slot" hidden></section>
      <section class="van-docs" id="rr-vandocs-slot" hidden></section>
    </div>`;

  document.getElementById("rr-home-settings").addEventListener("click", () => { _haptic("tap"); navigate("/settings"); });

  // Photo upload — clicking the avatar opens the camera or picker.
  const fileInput = document.getElementById("rr-photo-input");
  document.getElementById("rr-photo-btn").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast("Photo must be under 8 MB", "warn"); return; }
    await uploadDriverPhoto(file);
    fileInput.value = ""; // allow re-selecting the same file
  });

  // Independent loaders so the page is responsive while data streams in.
  renderCheckinCard(session);
  renderUpNext(session);
  renderVanDocs(session);

  // Pull-to-refresh re-fetches both async surfaces.  Avatar / name
  // come from the session, which is hydrated in the background by
  // refreshDriverProfile in render().
  setRefresh(() => {
    const s = readSession();
    renderCheckinCard(s);
    renderUpNext(s);
    renderVanDocs(s);
  });

  main.querySelectorAll("[data-task-route]").forEach((el) => {
    el.addEventListener("click", () => navigate(el.dataset.taskRoute));
  });
}

// ── UP NEXT · next upcoming shift after today ──────────────────────
// Reads from driver_my_schedule (same RPC the Schedule tab uses) and
// renders the closest future shift as a single white card.  Hides
// itself silently on empty / error so the home page never shows a
// broken section.
async function renderUpNext(session) {
  const slot = document.getElementById("rr-upnext-slot");
  if (!slot || !session?.token) return;
  let data, error;
  try {
    const res = await sb.rpc("driver_my_schedule", { p_token: session.token, p_weeks: 2 });
    data = res.data; error = res.error;
  } catch (e) { error = e; }
  if (error || !data) { slot.hidden = true; return; }

  const todayIso = fmtIsoDate(new Date());
  const shifts = (Array.isArray(data.shifts) ? data.shifts : [])
    .filter((s) => s.status === "scheduled" && s.date > todayIso)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (shifts.length === 0) { slot.hidden = true; return; }
  const s = shifts[0];

  // Try to look up the assigned vehicle for that day — same RPC
  // the Schedule page uses.  Silent on failure (van just hides).
  let vehicle = "";
  try {
    const vRes = await sb.rpc("driver_vehicle_days", { p_token: session.token });
    for (const r of (Array.isArray(vRes?.data) ? vRes.data : [])) {
      if (r && r.date === s.date && r.vehicle) { vehicle = r.vehicle; break; }
    }
  } catch {}

  const d = new Date(s.date + "T12:00:00");
  const dow = d.toLocaleDateString(undefined, { weekday: "short" }).toUpperCase();
  const day = d.getDate();
  const mon = d.toLocaleDateString(undefined, { month: "short" }).toUpperCase();

  const timeRange = (s.starts_at && s.ends_at)
    ? `${fmtTime(s.starts_at)} – ${fmtTime(s.ends_at)}`
    : "";
  const hasLead = (s.report_lead_minutes || 0) > 0
    && s.wave_starts_at
    && new Date(s.wave_starts_at).getTime() !== new Date(s.starts_at).getTime();

  // Same meta contract as the schedule cards — Van + Wave read as
  // labeled values so the "Up next" hero feels like one product.
  const upCells = [];
  if (vehicle) upCells.push(`<div class="sc-cell"><div class="sc-cell-l">Van</div><div class="sc-cell-v sc-cell-v--van">${escapeHtml(vehicle)}</div></div>`);
  if (hasLead) upCells.push(`<div class="sc-cell"><div class="sc-cell-l">Wave</div><div class="sc-cell-v">${escapeHtml(fmtTime(s.wave_starts_at))}</div></div>`);

  slot.hidden = false;
  slot.innerHTML = `
    <div class="up-next-label">Up next</div>
    <div class="up-next-card">
      <div class="up-next-date">
        <div class="up-next-dow">${escapeHtml(dow)}</div>
        <div class="up-next-day">${day}</div>
        <div class="up-next-mon">${escapeHtml(mon)}</div>
      </div>
      <div class="up-next-body">
        <div class="up-next-time">${escapeHtml(timeRange)}</div>
        ${s.station_code ? `<div class="up-next-meta">${escapeHtml(s.station_code)}</div>` : ""}
        ${upCells.length ? `<div class="sc-meta">${upCells.join("")}</div>` : ""}
        <div class="up-next-weather" id="rr-upnext-wx" hidden></div>
      </div>
    </div>`;

  // Forecast for the shift's station — silent on miss / failure.
  const lat = Number(s.station_latitude);
  const lng = Number(s.station_longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    _fetchForecastByLatLng(lat, lng).then((byIso) => {
      const el = document.getElementById("rr-upnext-wx");
      if (!el || !byIso) return;
      const wx = byIso.get(s.date);
      if (!wx) return;
      el.hidden = false;
      el.innerHTML = `
        <span class="shift-weather-icon" aria-hidden="true">${_weatherIcon(wx.conditions)}</span>
        <span class="shift-weather-temp">${wx.tempF}°</span>
        <span class="shift-weather-text">${escapeHtml(wx.conditions || "")}</span>`;
    });
  }
}

// ── VAN DOCUMENTS · insurance + registration for today's assigned van ─
// Surfaces under "Up next" on the home screen.  Always visible *as a
// section* so the driver learns where these live — when no van is
// assigned, renders a calm "no van yet" empty state instead of hiding.
async function renderVanDocs(session) {
  const slot = document.getElementById("rr-vandocs-slot");
  if (!slot || !session?.token) return;
  let data;
  try {
    const res = await sb.rpc("driver_assigned_van", { p_token: session.token });
    if (res.error) throw res.error;
    data = res.data || {};
  } catch (e) {
    // Stay silent on failure — the section just hides, no broken UI.
    slot.hidden = true;
    return;
  }
  slot.hidden = false;
  const v = data.vehicle;
  if (!v) {
    slot.innerHTML = `
      <div class="van-docs-label">Van documents</div>
      <div class="van-docs-empty">
        <div class="van-docs-empty-ic" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17h2l1-4h12l1 4h2"/><path d="M5 13v4M19 13v4"/><circle cx="8" cy="17" r="2"/><circle cx="16" cy="17" r="2"/></svg>
        </div>
        <div class="van-docs-empty-title">No van assigned yet</div>
        <div class="van-docs-empty-sub">Your documents will appear once your vehicle is assigned.</div>
      </div>`;
    return;
  }
  const docs = Array.isArray(data.documents) ? data.documents : [];
  const docByKind = (k) => docs.find((d) => d.kind === k) || { kind: k, status: "missing", has_file: false };
  const ins = docByKind("insurance");
  const reg = docByKind("registration");
  const threshold = Number(data.threshold_days || 30);

  const plateLine = [v.plate ? `${v.plate}${v.plate_state ? ` (${v.plate_state})` : ""}` : null,
                     v.vin ? `VIN ${v.vin}` : null]
                    .filter(Boolean).join(" · ");
  const ymm = [v.year, v.make, v.model].filter(Boolean).join(" ");

  // Calm but clear inline warning when any doc is missing or expired.
  const worstWarning = _vanDocWorstWarning(ins, reg);

  slot.innerHTML = `
    <div class="van-docs-label">Van documents</div>
    <div class="van-docs-card">
      <div class="van-docs-head">
        <div class="van-docs-head-ic" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17h2l1-4h12l1 4h2"/><path d="M5 13v4M19 13v4"/><circle cx="8" cy="17" r="2"/><circle cx="16" cy="17" r="2"/></svg>
        </div>
        <div style="flex:1;min-width:0">
          <div class="van-docs-van">Van ${escapeHtml(v.name || "—")}</div>
          ${ymm ? `<div class="van-docs-sub">${escapeHtml(ymm)}</div>` : ""}
          ${plateLine ? `<div class="van-docs-sub">${escapeHtml(plateLine)}</div>` : ""}
        </div>
      </div>

      ${worstWarning ? `
        <div class="van-docs-warning">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <span>${escapeHtml(worstWarning)}</span>
        </div>` : ""}

      <div class="van-docs-buttons">
        ${_vanDocButtonHtml(ins, threshold)}
        ${_vanDocButtonHtml(reg, threshold)}
      </div>

      <button type="button" class="van-docs-report" id="rr-vandocs-report">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 22V4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v18l-8-4-8 4z"/></svg>
        <span>Report missing or wrong document</span>
      </button>
    </div>`;

  slot.querySelectorAll("[data-rr-vandoc]").forEach((btn) => {
    btn.addEventListener("click", () => _openVanDoc(session, btn.getAttribute("data-rr-vandoc"), btn.getAttribute("data-rr-vandoc-kind")));
  });
  document.getElementById("rr-vandocs-report").addEventListener("click", () => _openVanDocReportSheet(session, v));
}

function _vanDocLabel(kind) {
  return kind === "insurance" ? "Insurance card" : kind === "registration" ? "Registration" : kind;
}

function _vanDocStatusChip(doc, threshold) {
  const s = doc.status;
  const d = doc.days_until_expiration;
  if (s === "expired")       return { cls: "warn", text: "Expired" };
  if (s === "missing")       return { cls: "warn", text: "Missing" };
  if (s === "expiring_soon") return { cls: "soon", text: `${d}d left` };
  return { cls: "ok", text: "Active" };
}

function _vanDocWorstWarning(ins, reg) {
  const worst = (d) => d.status === "expired" || d.status === "missing";
  if (worst(reg)) {
    return reg.status === "expired"
      ? "This van's registration document is expired. Notify fleet before departure."
      : "This van's registration document is missing. Notify fleet before departure.";
  }
  if (worst(ins)) {
    return ins.status === "expired"
      ? "This van's insurance card is expired. Notify fleet before departure."
      : "This van's insurance card is missing. Notify fleet before departure.";
  }
  return null;
}

function _vanDocButtonHtml(doc, threshold) {
  const label = _vanDocLabel(doc.kind);
  const chip  = _vanDocStatusChip(doc, threshold);
  const disabled = !doc.has_file;
  const icon = doc.kind === "insurance"
    ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>'
    : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>';
  return `
    <button type="button" class="van-docs-btn${disabled ? " is-disabled" : ""}"
            ${disabled ? "" : `data-rr-vandoc="${escapeHtml(doc.id)}" data-rr-vandoc-kind="${escapeHtml(doc.kind)}"`}>
      <span class="van-docs-btn-ic" aria-hidden="true">${icon}</span>
      <span class="van-docs-btn-body">
        <span class="van-docs-btn-title">${escapeHtml(label)}</span>
        <span class="van-docs-btn-chip van-docs-chip-${chip.cls}">${escapeHtml(chip.text)}</span>
      </span>
      ${disabled
        ? '<span class="van-docs-btn-meta">Not uploaded</span>'
        : '<svg class="van-docs-btn-chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>'}
    </button>`;
}

async function _openVanDoc(session, docId, kind) {
  if (!docId || !session?.token) return;
  _haptic("tap");
  // Pre-open the tab synchronously so iOS Safari doesn't block the
  // popup once we hit await — same trick the e-signature flow uses.
  const win = window.open("", "_blank");
  let resp;
  try {
    resp = await fetch(`${cfg.SUPABASE_URL}/functions/v1/vehicle-document-fetch`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": "Bearer " + cfg.SUPABASE_ANON_KEY,
        "apikey":        cfg.SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ token: session.token, vehicle_document_id: docId }),
    });
  } catch (e) {
    if (win) win.close();
    toast("Couldn't open document — check your connection", "warn");
    return;
  }
  const text = await resp.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (!resp.ok || !body?.signed_url) {
    if (win) win.close();
    toast(_friendlyError(body?.error, "Couldn't open the " + _vanDocLabel(kind).toLowerCase() + ". Try again in a moment."), "warn");
    return;
  }
  if (win) { win.location.href = body.signed_url; }
  else { window.location.href = body.signed_url; }
}

async function _openVanDocReportSheet(session, vehicle) {
  // Lean confirm sheet that lets the driver pick which document is
  // missing/wrong and add an optional note.  Uses the same overlay
  // pattern as confirmSheet so the look feels native to the app.
  const wrap = document.createElement("div");
  wrap.className = "rr-vd-sheet-wrap";
  wrap.innerHTML = `
    <div class="rr-vd-sheet" role="dialog" aria-label="Report vehicle document">
      <div class="rr-vd-sheet-title">Report document issue</div>
      <div class="rr-vd-sheet-msg">Let fleet know which document on van ${escapeHtml(vehicle.name || "—")} is missing or wrong. They'll get an alert and replace it.</div>
      <div class="rr-vd-sheet-fields">
        <label class="rr-vd-sheet-radio"><input type="radio" name="rr-vd-kind" value="registration" checked> Registration</label>
        <label class="rr-vd-sheet-radio"><input type="radio" name="rr-vd-kind" value="insurance"> Insurance card</label>
        <textarea id="rr-vd-reason" rows="3" maxlength="500" placeholder="What's wrong? (optional)"></textarea>
      </div>
      <div class="rr-vd-sheet-actions">
        <button type="button" class="rr-vd-sheet-btn" id="rr-vd-cancel">Cancel</button>
        <button type="button" class="rr-vd-sheet-btn rr-vd-sheet-btn-primary" id="rr-vd-submit">Send report</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  document.getElementById("rr-vd-cancel").addEventListener("click", close);
  document.getElementById("rr-vd-submit").addEventListener("click", async () => {
    const kind = wrap.querySelector('input[name="rr-vd-kind"]:checked')?.value || "registration";
    const reason = (document.getElementById("rr-vd-reason").value || "").trim();
    const btn = document.getElementById("rr-vd-submit");
    btn.disabled = true; btn.textContent = "Sending…";
    const { error } = await sb.rpc("driver_report_vehicle_document", {
      p_token: session.token, p_kind: kind, p_reason: reason || null,
    });
    btn.disabled = false; btn.textContent = "Send report";
    if (error) { toast(_friendlyError(error, "Couldn't send the report. Try again."), "warn"); return; }
    close();
    toast("Fleet has been notified", "success");
  });
}

// ── Settings · gear icon in the top-right of the header ─────────────
//
// Two halves: an editable form (identity, contact, emergency contact,
// license) backed by driver_get_profile / driver_update_profile /
// driver_set_dl_image, and the existing Sign out button.  Anything the
// DSP must verify (DL expiration, certs, employment data) is read-only
// down on the Onboarding task — see renderOnboarding.
// ── Settings landing · just a list of clickable rows ────────────────
//
// iOS-style: each row opens its own editor screen.  Saving lives on
// the editor screen, not here, so the landing page stays clean.
function renderSettings() {
  const main = document.getElementById("main");
  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }

  const chev = '<span class="settings-row-chev"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>';

  // Inline SVG glyphs for each settings entry — the soft-blue icon
  // container matches the home page's Report-missed-day icon style
  // so the whole product reads as one visual language.
  const ICONS = {
    profile:      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    license:      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="12" r="2.2"/><line x1="14" y1="10.5" x2="18" y2="10.5"/><line x1="14" y1="13.5" x2="17" y2="13.5"/></svg>',
    pin:          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
    availability: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    "time-off":   '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    attendance:   '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  };

  const row = (id, route, title, sub) => `
    <button type="button" class="settings-row settings-row-link" data-rr-settings-go="${route}">
      <span class="settings-row-icon">${ICONS[id] || ICONS.profile}</span>
      <div class="settings-row-body">
        <div class="settings-section-title">${escapeHtml(title)}</div>
        <div class="settings-section-sub">${escapeHtml(sub)}</div>
      </div>
      ${chev}
    </button>`;

  main.innerHTML = `
    <div class="settings-page">
      <section class="settings-section">
        ${row("profile",      "/settings/profile",      "Profile",      "Name, contact, emergency contact")}
        ${row("license",      "/settings/license",      "Driver's license", "License number and image")}
        ${row("pin",          "/settings/pin",          "Sign-in PIN",  "Set or change your 4–6 digit PIN")}
        ${driverFeatureOn("availability") ? row("availability", "/settings/availability", "Availability", "Days you can work and your earliest start") : ""}
        ${driverFeatureOn("time_off")     ? row("time-off",     "/settings/time-off",     "Time off",     "Request a day off and see past decisions") : ""}
        ${row("attendance",   "/settings/attendance",   "Attendance",   "Today's status and your DSP's points policy")}
      </section>

      <button class="btn btn-block btn-danger" id="rr-signout" style="margin-top:18px">Sign out</button>

      <div class="settings-diag" id="rr-settings-diag" aria-hidden="true"></div>
    </div>`;

  // Support footer: build stamp + live viewport numbers. The build id is
  // the deploy-unique ?v= token app.js was loaded with (bust-cache.mjs
  // stamps the commit sha), so "is the update actually on this phone?"
  // is answerable from a screenshot — as is where any dead space at the
  // screen edges comes from (standalone vs browser, inset, vp vs screen).
  try {
    const build = (new URL(import.meta.url).searchParams.get("v") || "dev").slice(0, 12);
    const standalone = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;visibility:hidden;padding-bottom:env(safe-area-inset-bottom, 0px)";
    document.body.appendChild(probe);
    const insetB = Math.round(parseFloat(getComputedStyle(probe).paddingBottom) || 0);
    probe.remove();
    const vv = window.visualViewport;
    document.getElementById("rr-settings-diag").textContent =
      `RouteReady Driver · build ${build} · ${standalone ? "installed app" : "browser tab"} · ` +
      `vp ${window.innerWidth}×${window.innerHeight}` +
      (vv ? ` · vv ${Math.round(vv.width)}×${Math.round(vv.height)}` : "") +
      ` · screen ${screen.width}×${screen.height} · inset-b ${insetB}px`;
  } catch {}

  main.querySelectorAll("[data-rr-settings-go]").forEach(el =>
    el.addEventListener("click", () => navigate(el.getAttribute("data-rr-settings-go"))));

  document.getElementById("rr-signout").addEventListener("click", async () => {
    const ok = await confirmSheet({
      title: "Sign out?",
      message: "You'll need your invite code or a new link from dispatch to sign back in.",
      confirmText: "Sign out",
      cancelText: "Stay signed in",
      danger: true,
    });
    if (!ok) return;
    const s = readSession();
    _rrLiveStop();
    await teardownPushSubscription(s);
    if (s?.token) { try { await sb.rpc("driver_signout", { p_token: s.token }); } catch {} }
    writeSession(null);
    syncSwSession(null);
    location.hash = "";
    render();
  });
}

// ── Settings → Profile (identity + contact + emergency) ────────────
async function renderSettingsProfile() {
  const main = document.getElementById("main");
  main.innerHTML = `<div class="loader" style="margin:48px auto"></div>`;
  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }

  const { data: prof, error } = await sb.rpc("driver_get_profile", { p_token: session.token });
  if (error) {
    if (/unauthorized|revoked|inactive/i.test(error.message || "")) {
      writeSession(null); toast("Signed out — please sign in again", "warn"); render(); return;
    }
    main.innerHTML = errorStateHtml("Couldn't load your profile", error);
    return;
  }
  const v = (s) => escapeHtml(s ?? "");

  main.innerHTML = `
    <div class="settings-page">
      <section class="settings-section">
        <div class="settings-form">
          <label class="field-label" for="rr-prof-name">Full name</label>
          <input class="field" id="rr-prof-name" type="text" value="${v(prof.full_name)}" autocomplete="name" />

          <label class="field-label" for="rr-prof-pref">Preferred name</label>
          <input class="field" id="rr-prof-pref" type="text" value="${v(prof.preferred_name)}" autocomplete="nickname" />

          <label class="field-label" for="rr-prof-phone">Phone</label>
          <input class="field" id="rr-prof-phone" type="tel" value="${v(prof.phone)}" autocomplete="tel" inputmode="tel" />

          <label class="field-label" for="rr-prof-email">Email</label>
          <input class="field" id="rr-prof-email" type="email" value="${v(prof.email)}" autocomplete="email" inputmode="email" />

          <label class="field-label" for="rr-prof-addr">Address</label>
          <input class="field" id="rr-prof-addr" type="text" value="${v(prof.address)}" autocomplete="street-address" />
        </div>
      </section>

      <section class="settings-section">
        <div class="settings-section-head">
          <div class="settings-section-title">Emergency contact</div>
          <div class="settings-section-sub">Who to call if something happens on the road.</div>
        </div>
        <div class="settings-form">
          <label class="field-label" for="rr-prof-ec-name">Contact name</label>
          <input class="field" id="rr-prof-ec-name" type="text" value="${v(prof.emergency_contact_name)}" />

          <label class="field-label" for="rr-prof-ec-phone">Contact phone</label>
          <input class="field" id="rr-prof-ec-phone" type="tel" value="${v(prof.emergency_contact_phone)}" inputmode="tel" />
        </div>
      </section>

      <button class="btn btn-primary btn-block" id="rr-prof-save" type="button">Save</button>
    </div>`;

  document.getElementById("rr-prof-save").addEventListener("click", async () => {
    const btn = document.getElementById("rr-prof-save");
    btn.disabled = true; btn.textContent = "Saving…";
    const payload = {
      full_name:               document.getElementById("rr-prof-name").value.trim(),
      preferred_name:          document.getElementById("rr-prof-pref").value.trim(),
      phone:                   document.getElementById("rr-prof-phone").value.trim(),
      email:                   document.getElementById("rr-prof-email").value.trim(),
      address:                 document.getElementById("rr-prof-addr").value.trim(),
      emergency_contact_name:  document.getElementById("rr-prof-ec-name").value.trim(),
      emergency_contact_phone: document.getElementById("rr-prof-ec-phone").value.trim(),
    };
    if (!payload.full_name) { btn.disabled = false; btn.textContent = "Save"; toast("Full name can't be empty", "warn"); return; }
    const { error: upErr } = await sb.rpc("driver_update_profile", {
      p_token: session.token, p_payload: payload,
    });
    btn.disabled = false; btn.textContent = "Save";
    if (upErr) { toast(_friendlyError(upErr, "Couldn't save. Your changes are still on screen."), "warn"); return; }
    toast("Saved", "ok");
    refreshDriverProfile(session, { force: true });
    // Onboarding drivers came from the Onboarding card; bounce them
    // straight back so they can pick the next step.
    navigate(prof?.status === "onboarding" ? "/tasks/onboarding" : "/settings");
  });
}

// ── Settings → Driver's license ─────────────────────────────────────
async function renderSettingsLicense(opts) {
  opts = opts || {};
  const main = document.getElementById("main");
  main.innerHTML = `<div class="loader" style="margin:48px auto"></div>`;
  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }

  const { data: prof, error } = await sb.rpc("driver_get_profile", { p_token: session.token });
  if (error) {
    main.innerHTML = errorStateHtml("Couldn't load this page", error);
    return;
  }
  const v = (s) => escapeHtml(s ?? "");
  // Signed URLs only — the public-URL path returns 401 because the
  // driver-documents bucket is private (RLS lets anon SELECT named
  // objects, but the /object/public/ route requires a public bucket).
  // Without this, "image uploaded ok" but the preview comes back blank.
  let dlImgUrl = null;
  let dlBackUrl = null;
  if (prof?.dl_image_path) {
    const { data: signed } = await sb.storage.from("driver-documents")
      .createSignedUrl(prof.dl_image_path, 60 * 60);
    dlImgUrl = signed?.signedUrl || null;
  }
  if (prof?.dl_back_image_path) {
    const { data: signed } = await sb.storage.from("driver-documents")
      .createSignedUrl(prof.dl_back_image_path, 60 * 60);
    dlBackUrl = signed?.signedUrl || null;
  }
  const dlNeedsVerify = (!!prof?.dl_image_path || !!prof?.dl_back_image_path) && !prof?.dl_expires_on;

  // The DL number persists across an in-page re-render (e.g. right
  // after an image upload) because we honor any pending value the
  // caller passes. Without this, typing the number then uploading an
  // image wiped the input — the user had to re-type before they could
  // hit Save.
  const dlNumberVal = (typeof opts.dlNumber === "string") ? opts.dlNumber : (prof.dl_number || "");

  const slot = (side, label, url) => `
    <div style="margin-top:14px">
      <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);margin-bottom:6px">${escapeHtml(label)}</div>
      ${url
        ? `<div class="settings-dl-preview">
             <a href="${url}" target="_blank" rel="noreferrer">
               <img src="${url}" alt="${escapeHtml(label)} of driver's license"/>
             </a>
           </div>`
        : `<div class="settings-dl-empty">No ${escapeHtml(label.toLowerCase())} image yet.</div>`}
      <input id="rr-prof-dl-file-${side}" type="file" accept="image/*" capture="environment" data-rr-dl-side="${side}" style="display:none" />
      <div class="settings-dl-actions">
        <button class="btn btn-primary btn-block" data-rr-dl-pick data-rr-dl-side="${side}" type="button">${url ? `Replace ${label.toLowerCase()}` : `Take photo of ${label.toLowerCase()}`}</button>
        ${url ? `<button class="btn btn-ghost btn-block" data-rr-dl-remove data-rr-dl-side="${side}" type="button" style="color:var(--red);margin-top:8px">Remove ${escapeHtml(label.toLowerCase())}</button>` : ""}
      </div>
    </div>`;

  main.innerHTML = `
    <div class="settings-page">
      <section class="settings-section">
        <div class="settings-section-head">
          <div class="settings-section-sub">Upload both sides. Your dispatcher confirms the expiration date.</div>
        </div>
        <div class="settings-form">
          <label class="field-label" for="rr-prof-dl">License number</label>
          <input class="field" id="rr-prof-dl" type="text" value="${v(dlNumberVal)}" autocapitalize="characters" />

          ${slot("front", "Front", dlImgUrl)}
          ${slot("back",  "Back",  dlBackUrl)}

          ${dlNeedsVerify
            ? `<div class="settings-callout warn" style="margin-top:14px">
                 <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
                 <span>Image uploaded — your dispatcher will confirm the expiration date.</span>
               </div>`
            : ""}
        </div>
      </section>

      <button class="btn btn-primary btn-block" id="rr-dl-save" type="button">Save</button>
    </div>`;

  document.getElementById("rr-dl-save").addEventListener("click", async () => {
    const btn = document.getElementById("rr-dl-save");
    btn.disabled = true; btn.textContent = "Saving…";
    const { error: upErr } = await sb.rpc("driver_update_profile", {
      p_token: session.token,
      p_payload: { dl_number: document.getElementById("rr-prof-dl").value.trim() },
    });
    btn.disabled = false; btn.textContent = "Save";
    if (upErr) { toast(_friendlyError(upErr, "Couldn't save. Try again."), "warn"); return; }
    toast("Saved", "ok");
    // Onboarding drivers came from the Onboarding card; bounce them
    // straight back so they can pick the next step instead of hunting
    // through the Settings list again.
    navigate(prof?.status === "onboarding" ? "/tasks/onboarding" : "/settings");
  });

  // Picker buttons fan out to the side-specific hidden inputs. One
  // event handler per side keeps the upload + remove flow uniform.
  document.querySelectorAll("[data-rr-dl-pick]").forEach(btn => {
    btn.addEventListener("click", () => {
      const side = btn.getAttribute("data-rr-dl-side") || "front";
      document.getElementById(`rr-prof-dl-file-${side}`).click();
    });
  });

  document.querySelectorAll("input[data-rr-dl-side][type=file]").forEach(input => {
    input.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) { toast("Image too large (max 10 MB)", "warn"); return; }
      const side = input.getAttribute("data-rr-dl-side") || "front";
      // Snapshot the typed DL number so it survives the re-render below.
      const dlTyped = document.getElementById("rr-prof-dl")?.value || "";
      const dspId = session.dsp_id || prof?.dsp_id;
      const drvId = session.driver_id || prof?.id;
      if (!dspId || !drvId) { toast("Profile incomplete — sign out and back in", "warn"); return; }

      const ext = (file.name.split(".").pop() || "jpg").toLowerCase().slice(0, 8);
      const path = `${dspId}/${drvId}/license-${side}-${Date.now()}.${ext}`;
      const pickBtn = document.querySelector(`[data-rr-dl-pick][data-rr-dl-side="${side}"]`);
      if (pickBtn) { pickBtn.disabled = true; pickBtn.textContent = "Uploading…"; }
      const { error: upErr } = await sb.storage.from("driver-documents").upload(path, file, {
        contentType: file.type, upsert: false,
      });
      if (upErr) {
        toast(_friendlyError(upErr, "Couldn't upload. Try again."), "warn");
        renderSettingsLicense({ dlNumber: dlTyped });
        return;
      }
      const { error: setErr } = await sb.rpc("driver_set_dl_image", {
        p_token: session.token, p_path: path, p_side: side,
      });
      if (setErr) {
        toast(_friendlyError(setErr, "Couldn't save the image. Try again."), "warn");
        renderSettingsLicense({ dlNumber: dlTyped });
        return;
      }
      toast(`License ${side} saved`, "ok");
      renderSettingsLicense({ dlNumber: dlTyped });
    });
  });

  document.querySelectorAll("[data-rr-dl-remove]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const side = btn.getAttribute("data-rr-dl-side") || "front";
      const okRm = await confirmSheet({
        title: `Remove ${side} image?`,
        message: "Your dispatcher will see the slot as empty until you upload a new one.",
        confirmText: "Remove image",
        danger: true,
      });
      if (!okRm) return;
      const dlTyped = document.getElementById("rr-prof-dl")?.value || "";
      btn.disabled = true;
      const { error: rmErr } = await sb.rpc("driver_clear_dl_image", { p_token: session.token, p_side: side });
      btn.disabled = false;
      if (rmErr) { toast(_friendlyError(rmErr, "Couldn't remove the image. Try again."), "warn"); return; }
      toast("Image removed", "ok");
      renderSettingsLicense({ dlNumber: dlTyped });
    });
  });
}

// ── Settings → Sign-in PIN ─────────────────────────────────────────
// Standalone PIN entry. tap-to-sign-in (0262) skipped the PIN step on
// activation, so drivers had no way to set one and phone+PIN sign-in
// would never succeed for them. This page lets the driver set or
// change a PIN any time they're signed in; the server-side RPC
// (driver_set_pin, 0264) bcrypts it, revokes their other sessions so
// a stolen PIN can't piggyback on a long-lived one elsewhere, and
// clears any rate-limit lockout on their phone.
async function renderSettingsPin() {
  const main = document.getElementById("main");
  main.innerHTML = `<div class="loader" style="margin:48px auto"></div>`;
  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }

  const { data: prof, error } = await sb.rpc("driver_get_profile", { p_token: session.token });
  if (error) {
    main.innerHTML = errorStateHtml("Couldn't load this page", error);
    return;
  }
  const hasPin = prof?.pin_hash === "set";

  main.innerHTML = `
    <div class="settings-page">
      <section class="settings-section">
        <div class="settings-section-head">
          <div class="settings-section-sub">${hasPin
            ? "Change your 4 to 6-digit PIN. You'll use your phone number plus this PIN to sign in on a new device."
            : "Set a 4 to 6-digit PIN so you can sign in fast on a new device using your phone number. Without one, you'll need a fresh sign-in link from your dispatcher every time."}</div>
        </div>
        <form class="settings-form" id="rr-pin-form">
          <div id="rr-pin-err" class="err" style="display:none"></div>

          <label class="field-label">New PIN</label>
          <input class="field" id="rr-pin-1" type="password" inputmode="numeric" autocomplete="new-password" pattern="[0-9]*" maxlength="6" placeholder="••••" style="letter-spacing:.5em;text-align:center"/>

          <label class="field-label" style="margin-top:14px">Confirm PIN</label>
          <input class="field" id="rr-pin-2" type="password" inputmode="numeric" autocomplete="new-password" pattern="[0-9]*" maxlength="6" placeholder="••••" style="letter-spacing:.5em;text-align:center"/>

          <button class="btn btn-primary btn-block" id="rr-pin-save" type="submit" style="margin-top:20px">${hasPin ? "Update PIN" : "Save PIN"}</button>
          <div class="help" style="margin-top:14px;line-height:1.5">${hasPin
            ? "Updating your PIN signs you out of every other device that was signed in with the old one. This device stays signed in."
            : "Setting a PIN signs you out of every other device that's currently signed in. This device stays signed in."}</div>
        </form>
      </section>
    </div>`;

  document.getElementById("rr-pin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = document.getElementById("rr-pin-err");
    err.style.display = "none";
    const pin1 = document.getElementById("rr-pin-1").value.trim();
    const pin2 = document.getElementById("rr-pin-2").value.trim();
    const showErr = (msg) => { err.textContent = msg; err.style.display = ""; };
    if (!/^\d{4,6}$/.test(pin1)) { showErr("PIN must be 4 to 6 digits."); return; }
    if (pin1 !== pin2)            { showErr("PINs don't match. Try again."); return; }

    const btn = document.getElementById("rr-pin-save");
    btn.disabled = true; btn.textContent = "Saving…";
    const { error: setErr } = await sb.rpc("driver_set_pin", { p_token: session.token, p_pin: pin1 });
    btn.disabled = false; btn.textContent = hasPin ? "Update PIN" : "Save PIN";
    if (setErr) {
      const m = setErr.message || "";
      showErr(m.includes("pin_must_be") ? "PIN must be 4 to 6 digits." : _friendlyError(setErr, "Couldn't save the PIN. Try again."));
      return;
    }
    toast("PIN saved", "ok");
    navigate(prof?.status === "onboarding" ? "/tasks/onboarding" : "/settings");
  });
}

// ── Onboarding task ─────────────────────────────────────────────────
//
// Surfaces while drivers.status === 'onboarding'.  Read-only checklist
// of the milestones the DSP records in the dashboard's Employment tab,
// plus quick links to the driver-editable sections (Settings) so the
// driver can complete their half of the work.  When the DSP flips
// status to "active", the Onboarding card disappears from the Tasks
// hub on the next render.
// Onboarding hub — a guided, momentum-first screen. One hero "next
// step", the driver's own steps as a clean checklist, and a calm,
// separate "your team is handling" section so the driver always knows
// what's theirs to do and never wonders what happens next.
const _OB_CHECK = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const _OB_CHEVRON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;

function _obProgressRing(done, total) {
  const r = 23, c = 2 * Math.PI * r;
  const frac = total ? done / total : 0;
  const allDone = total > 0 && done === total;
  return `<svg width="58" height="58" viewBox="0 0 58 58" aria-hidden="true">
    <circle cx="29" cy="29" r="${r}" fill="none" stroke="var(--canvas)" stroke-width="5"/>
    <circle cx="29" cy="29" r="${r}" fill="none" stroke="${allDone ? "var(--green)" : "var(--accent)"}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - frac)).toFixed(1)}" transform="rotate(-90 29 29)" style="transition:stroke-dashoffset .4s ease"/>
  </svg>`;
}

function _obDot(state) {
  if (state === "done") return `<span class="ob-dot done">${_OB_CHECK}</span>`;
  if (state === "active") return `<span class="ob-dot active"></span>`;
  return `<span class="ob-dot empty"></span>`;
}

function _obStatusChip(label, tone = "neutral") {
  return `<span class="ob-chip ${tone}">${escapeHtml(label)}</span>`;
}

function _obSkeleton() {
  const line = (w) => `<div class="i9-skel" style="height:12px;width:${w}"></div>`;
  return `<div class="ob">
    <div class="ob-hero"><div class="i9-skel" style="width:58px;height:58px;border-radius:50%;flex:0 0 auto"></div><div style="flex:1;display:flex;flex-direction:column;gap:8px">${line("55%")}${line("85%")}</div></div>
    <div class="ob-skel-card">${line("28%")}${line("70%")}<div class="i9-skel" style="height:40px;width:100%;margin-top:4px"></div></div>
    <div class="ob-list"><div class="ob-item">${_obDot("empty")}<div style="flex:1;display:flex;flex-direction:column;gap:6px">${line("40%")}${line("60%")}</div></div><div class="ob-item">${_obDot("empty")}<div style="flex:1;display:flex;flex-direction:column;gap:6px">${line("38%")}${line("55%")}</div></div></div>
  </div>`;
}

const _OB_LOCK  = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
const _OB_CLOCK = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 7 12 12 15 14"/></svg>`;
function _obFmtAt(iso) { if (!iso) return ""; const d = new Date(/T/.test(iso) ? iso : iso + "T12:00:00"); return isNaN(+d) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }

// Near-instant sync for the onboarding hub: while it's on screen, re-run
// it every few seconds so a dashboard change (e.g. background check
// cleared) flips the list with no action from the driver. The silent
// re-render skips the skeleton and only repaints when something actually
// changed, so there's no flicker. (refreshOnFocus already covers tab
// away/back; this covers staring at the screen.)
let _obPollTimer = null;
let _obLastSig   = null;
function _obSchedulePoll() {
  clearTimeout(_obPollTimer);
  _obPollTimer = setTimeout(() => {
    if (currentRoute() !== "/tasks/onboarding") return;          // navigated away — let the poll die
    if (!document.hidden) renderOnboarding({ silent: true });    // (re-arms itself at the end)
    else _obSchedulePoll();                                      // hidden — try again later
  }, 3000);
}

// True-realtime path on top of the poll. While the hub is in view, the
// driver app subscribes to postgres_changes on the tables that back
// onboarding state — drivers (status/bg/drug/training), onboarding_progress
// (handbook / job offer / "sent" timestamps), driver_onboarding_state
// (acknowledgements / videos / custom docs), i9_records, document_envelopes,
// onboarding_blueprint. Any event hands off to a silent re-render.
// Realtime is best-effort given the driver app's anon-key session +
// table RLS; the 3s poll is the safety net.
let _obRealtimeChannel  = null;
let _obRealtimeDriverId = null;
function _obSetupRealtime(driverId) {
  if (!driverId || typeof sb.channel !== "function") return;
  if (_obRealtimeChannel && _obRealtimeDriverId === driverId) return;
  if (_obRealtimeChannel) { try { sb.removeChannel(_obRealtimeChannel); } catch (_) {} _obRealtimeChannel = null; }
  _obRealtimeDriverId = driverId;
  const onChange = () => { if (currentRoute() === "/tasks/onboarding" && !document.hidden) renderOnboarding({ silent: true }); };
  const ch = sb.channel("rr-driver-onboarding-" + driverId);
  ch.on("postgres_changes", { event: "*", schema: "public", table: "drivers",                 filter: "id=eq." + driverId },                  onChange);
  ch.on("postgres_changes", { event: "*", schema: "public", table: "onboarding_progress",     filter: "driver_id=eq." + driverId },           onChange);
  ch.on("postgres_changes", { event: "*", schema: "public", table: "driver_onboarding_state", filter: "driver_id=eq." + driverId },           onChange);
  ch.on("postgres_changes", { event: "*", schema: "public", table: "i9_records",              filter: "driver_id=eq." + driverId },           onChange);
  ch.on("postgres_changes", { event: "*", schema: "public", table: "document_envelopes",      filter: "recipient_driver_id=eq." + driverId }, onChange);
  ch.subscribe();
  _obRealtimeChannel = ch;
}

async function renderOnboarding(opts) {
  const silent = !!(opts && opts.silent);
  const main = document.getElementById("main");
  if (typeof _i9InjectStyles === "function") _i9InjectStyles();   // shares the .i9-skel pulse
  if (!silent) { main.innerHTML = _obSkeleton(); _obLastSig = null; }
  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }

  const [profRes, i9Res, stepsRes, availRes] = await Promise.all([
    sb.rpc("driver_get_profile", { p_token: session.token }),
    // PostgrestBuilder is a bare thenable (no .catch) — two-arg .then so
    // a missing/erroring RPC can't blow up the onboarding screen.
    sb.rpc("driver_i9_get",           { p_token: session.token }).then((r) => r, () => ({ data: null })),
    sb.rpc("driver_onboarding_steps", { p_token: session.token }).then((r) => r, () => ({ data: [] })),
    sb.rpc("driver_get_availability", { p_token: session.token }).then((r) => r, () => ({ data: null })),
  ]);
  if (currentRoute() !== "/tasks/onboarding") return;             // navigated away while loading
  const { data: prof, error } = profRes;
  if (error) {
    if (/unauthorized|revoked|inactive/i.test(error.message || "")) {
      writeSession(null); toast("Signed out — please sign in again", "warn"); render(); return;
    }
    if (silent) { _obSchedulePoll(); return; }                   // transient — try again on the next poll
    main.innerHTML = errorStateHtml("Couldn't load onboarding", error);
    return;
  }
  // First successful render — wire up the realtime channel for this
  // driver. Subsequent renders just reuse the channel.
  if (prof && prof.id) _obSetupRealtime(prof.id);

  const i9rec    = i9Res?.data?.record || null;
  const av       = availRes?.data || null;
  const availDone = !!(av && ((Array.isArray(av.days) && av.days.length > 0) || av.pending));
  const fname    = prof.preferred_name ? escapeHtml(prof.preferred_name) : "";

  // The one ordered list every new hire works through, in this order:
  // profile → license → availability → then the DSP's blueprint steps in
  // dashboard order. The driver completes them in sequence — the step
  // after the first incomplete one is locked.
  const items = [
    { key: "profile", title: "Update your profile", owner: "driver", done: !!(prof.phone && prof.email && prof.emergency_contact_name && prof.emergency_contact_phone),
      action: "/settings/profile", cta: "Update profile",
      subDone: "Phone, email, address & emergency contact on file", subTodo: "Add your phone, email, address, and emergency contact" },
    { key: "license", title: "Upload your driver's license", owner: "driver", done: !!(prof.dl_image_path && prof.dl_back_image_path && prof.dl_number),
      action: "/settings/license", cta: (prof.dl_image_path && prof.dl_back_image_path && prof.dl_number) ? "Replace images" : "Upload license",
      subDone: "License number & both sides on file", subTodo: "Enter your license number and take photos of the front and back" },
  ];
  // Availability is part of onboarding only when the DSP offers it.
  if (driverFeatureOn("availability")) {
    items.push({ key: "availability", title: "Set your availability", owner: "driver", done: availDone,
      action: "/settings/availability", cta: "Set availability",
      subDone: (av && av.pending) ? "Submitted — your team will review it" : "On file", subTodo: "Tell us which days you can work and your earliest start time" });
  }
  for (const cs of (Array.isArray(stepsRes?.data) ? stepsRes.data : [])) {
    if (!cs || !cs.key) continue;
    const owner = cs.owner === "driver" ? "driver" : "dsp";
    const st = cs.status || "not_started";
    const it = { key: "bp:" + cs.key, title: cs.title || cs.key, owner, done: st === "complete", action: null, cta: null, attention: false, subDone: "Done", subTodo: "" };
    if (cs.key === "i9") {
      it.title = cs.title || "Form I-9";
      if (st === "complete")            { it.done = true;  it.subDone = "Verified"; }
      else if (st === "awaiting_review"){ it.done = false; it.owner = "dsp"; it.subTodo = "Section 1 signed — your employer is verifying your documents"; }
      else if (st === "needs_correction"){ it.action = "/tasks/i9"; it.cta = "Fix Section 1"; it.attention = true; it.subTodo = "Your employer asked for a correction — please update and re-sign"; }
      else                             { it.action = "/tasks/i9"; it.cta = "Complete Form I-9"; it.subTodo = "Confirm your work eligibility"; }
    } else if (owner === "dsp") {
      if (st === "complete") it.subDone = (cs.key === "bg_check" || cs.key === "drug_test") ? "Cleared" : "Done";
      else if (cs.key === "training" && st === "scheduled" && cs.at) it.subTodo = `Scheduled for ${_obFmtAt(cs.at)}`;
      else it.subTodo = "Your team is handling this";
    } else if (cs.type === "document") {
      const isInfo = cs.doc_kind === "informational";
      it.subDone = isInfo ? "Reviewed & acknowledged" : "Signed";
      if (cs.signing_token) {
        it.action = "/tasks/documents/sign?st=" + encodeURIComponent(cs.signing_token);
        if (st === "declined")    { it.cta = "Reopen"; it.attention = true; it.subTodo = "You declined this — reopen it to review and " + (isInfo ? "acknowledge it" : "sign it"); }
        else if (st === "viewed") { it.cta = isInfo ? "Acknowledge receipt" : "Sign now"; it.subTodo = isInfo ? "You've opened it — confirm you've reviewed the document" : "You've opened it — add your signature to finish"; }
        else                      { it.cta = isInfo ? "Review & acknowledge" : "Review & sign"; it.subTodo = isInfo ? "Open the document, review it, and confirm you've received it" : "Open the document, review it, and sign"; }
      } else { it.subTodo = "Your team is preparing this document — check back soon"; }
    } else if (cs.type === "video") {
      it.action = "/tasks/onboarding/step?key=" + encodeURIComponent(cs.key);
      it.cta = "Watch & confirm"; it.subDone = "Watched"; it.subTodo = "Watch the video, then confirm you've finished";
    } else {
      it.action = "/tasks/onboarding/step?key=" + encodeURIComponent(cs.key);
      it.cta = "Review & confirm"; it.subDone = "Acknowledged";
      it.subTodo = cs.ack_text ? (cs.ack_text.length > 110 ? cs.ack_text.slice(0, 109) + "…" : cs.ack_text) : "Review and confirm";
    }
    items.push(it);
  }

  const total      = items.length;
  const doneCount  = items.filter(it => it.done).length;
  const allDone    = doneCount === total;
  const curIdx     = items.findIndex(it => !it.done);            // first incomplete; -1 if all done
  const cur        = curIdx >= 0 ? items[curIdx] : null;
  const curActionable = !!(cur && cur.owner === "driver" && cur.action);
  const curWaiting    = !!(cur && !curActionable);

  // Skip the repaint if nothing's changed (silent polls only).
  const sig = items.map(it => `${it.key}:${it.done ? 1 : 0}:${it.action || ""}:${it.cta || ""}`).join("|") + `#${allDone ? 1 : 0}`;
  if (silent && sig === _obLastSig) { _obSchedulePoll(); return; }
  _obLastSig = sig;

  const heroTitle = allDone ? `You're all set${fname ? ", " + fname : ""}`
    : curIdx === 0 ? `Welcome aboard${fname ? ", " + fname : ""}`
    : (total - doneCount) === 1 ? `One step to go${fname ? ", " + fname : ""}`
    : `You're making progress${fname ? ", " + fname : ""}`;
  const heroSub = allDone ? "Everything's done. Your dispatcher is activating your account now — you'll be notified the moment you're cleared to drive."
    : curWaiting ? `${doneCount} of ${total} steps complete. Your team is on “${escapeHtml(cur.title)}” — nothing needs you right now. We'll bump you the moment the next step opens.`
    : `${doneCount} of ${total} steps complete. Next up: ${escapeHtml(cur.title)}.`;

  const nextCard = curActionable ? `
      <div class="ob-next ${cur.attention ? "action" : ""}">
        <div class="ob-next-eyebrow">${cur.attention ? "Action needed" : "Your next step"}</div>
        <div class="ob-next-title">${escapeHtml(cur.title)}</div>
        <div class="ob-next-sub">${escapeHtml(cur.subTodo || "")}</div>
        <button class="btn btn-primary ob-next-cta" type="button" data-onboard-go="${escapeHtml(cur.action)}">${escapeHtml(cur.cta || "Open")}</button>
      </div>` : "";

  const itemHtml = (it, i) => {
    if (it.done) {
      return `<div class="ob-item done">${_obDot("done")}<div style="min-width:0"><div class="ob-item-head"><div class="ob-item-title">${escapeHtml(it.title)}</div>${_obStatusChip("Done", "done")}</div><div class="ob-item-sub">${escapeHtml(it.subDone || "Done")}</div></div></div>`;
    }
    if (curIdx >= 0 && i > curIdx) {   // locked — comes after the current step
      return `<div class="ob-item locked"><span class="ob-dot empty"></span><div style="min-width:0"><div class="ob-item-head"><div class="ob-item-title">${escapeHtml(it.title)}</div>${_obStatusChip("Locked")}</div><div class="ob-item-sub">Unlocks once the steps above are done</div></div><span class="ob-trail" aria-hidden="true">${_OB_LOCK}</span></div>`;
    }
    if (i === curIdx && curActionable) {
      return `<div class="ob-item ${it.attention ? "action" : "active"}">${_obDot("active")}<div style="min-width:0"><div class="ob-item-head"><div class="ob-item-title">${escapeHtml(it.title)}</div>${_obStatusChip(it.attention ? "Fix needed" : "Now", it.attention ? "action" : "active")}</div><div class="ob-item-sub">${escapeHtml(it.subTodo || "")}</div></div><button class="ob-go" type="button" data-onboard-go="${escapeHtml(it.action)}" aria-label="${escapeHtml(it.cta || "Open")}">${_OB_CHEVRON}</button></div>`;
    }
    // current step, but it's on the DSP / being prepared
    return `<div class="ob-item active">${_obDot("active")}<div style="min-width:0"><div class="ob-item-head"><div class="ob-item-title">${escapeHtml(it.title)}</div>${_obStatusChip("Team", "waiting")}</div><div class="ob-item-sub">${escapeHtml(it.subTodo || "Your team is handling this")}</div></div><span class="ob-trail" aria-hidden="true">${_OB_CLOCK}</span></div>`;
  };

  main.innerHTML = `
    <div class="ob">
      <div class="ob-hero ${allDone ? "done" : ""}">
        <div class="ob-ring">${_obProgressRing(doneCount, total)}<div class="ob-ring-num" ${allDone ? 'style="color:var(--green)"' : ""}>${doneCount}/${total}</div></div>
        <div style="min-width:0"><div class="ob-hero-title">${heroTitle}</div><div class="ob-hero-sub">${heroSub}</div></div>
      </div>
      ${nextCard}
      <div class="ob-group">
        <div class="ob-sec">Your onboarding</div>
        <div class="ob-list">${items.map(itemHtml).join("")}</div>
      </div>
      <div class="ob-foot">Steps unlock in order — finish the highlighted one to move on. Your dispatcher activates your account once everything's done.</div>
    </div>`;

  main.querySelectorAll("[data-onboard-go]").forEach(el => el.addEventListener("click", () => navigate(el.dataset.onboardGo)));
  _obSchedulePoll();
}

// ── One custom onboarding step (video / acknowledgement) ────────────
// Reached from the onboarding hub. Shows the video link or the
// acknowledgement text, with a confirm button that calls
// driver_onboarding_step_ack and bounces back to the hub.
async function renderOnboardingStep() {
  const main = document.getElementById("main");
  main.innerHTML = `<div class="loader" style="margin:48px auto"></div>`;
  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }
  const key = routeQuery().get("key");
  if (!key) { navigate("/tasks/onboarding"); return; }

  const { data, error } = await sb.rpc("driver_onboarding_steps", { p_token: session.token });
  if (error) {
    if (/unauthorized|revoked|inactive/i.test(error.message || "")) { writeSession(null); toast("Signed out — please sign in again", "warn"); render(); return; }
    main.innerHTML = errorStateHtml("Couldn't load this step", error);
    return;
  }
  const step = (Array.isArray(data) ? data : []).find(s => s && s.key === key);
  if (!step) { navigate("/tasks/onboarding"); return; }

  // Document steps are handled by the document review/sign flow; anything
  // that isn't a video or an acknowledgement (background check, Form I-9,
  // …) belongs on the onboarding hub, not this confirm screen.
  if (step.type === "document") {
    if (step.signing_token) navigate("/tasks/documents/sign?st=" + encodeURIComponent(step.signing_token));
    else navigate("/tasks/onboarding");
    return;
  }
  if (step.type !== "video" && step.type !== "acknowledgement") { navigate("/tasks/onboarding"); return; }

  setHeader(step.title || "Onboarding step", "");
  const isVid = step.type === "video";
  const done  = step.status === "complete";
  const doneOn = step.at ? new Date(step.at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";

  const bodyHtml = isVid
    ? (step.video_url
        ? `<div class="ob-next-sub">Watch the video, then confirm you've finished.</div>
           <a class="btn ob-next-cta" href="${escapeHtml(step.video_url)}" target="_blank" rel="noopener">Open the video ↗</a>`
        : `<div class="ob-next-sub">Your team hasn't added the video link yet — check back soon.</div>`)
    : `<div class="ob-next-sub" style="white-space:pre-wrap">${escapeHtml(step.ack_text || "Please confirm you've reviewed this.")}</div>`;

  const footHtml = done
    ? `<div class="ob-next-sub" style="display:flex;align-items:center;gap:7px;color:var(--green);font-weight:600;margin-top:13px">${_OB_CHECK}<span>Done${doneOn ? " · " + doneOn : ""}</span></div>`
    : `<button class="btn btn-primary ob-next-cta" type="button" id="ob-step-confirm"${(isVid && !step.video_url) ? " disabled" : ""}>${isVid ? "I've watched it" : "I acknowledge"}</button>`;

  main.innerHTML = `
    <div class="ob">
      <div class="ob-next ${done ? "idle" : ""}">
        <div class="ob-next-eyebrow">${isVid ? "Video to watch" : "Acknowledgement"}</div>
        <div class="ob-next-title">${escapeHtml(step.title || (isVid ? "Watch a video" : "Acknowledgement"))}</div>
        ${bodyHtml}
        ${footHtml}
      </div>
      <div class="ob-foot">Your dispatcher activates your account once every step is complete.</div>
    </div>`;

  const btn = document.getElementById("ob-step-confirm");
  if (btn) btn.addEventListener("click", async () => {
    btn.disabled = true; const orig = btn.textContent; btn.textContent = "Saving…";
    const { error: e2 } = await sb.rpc("driver_onboarding_step_ack", { p_token: session.token, p_step_key: key });
    if (e2) {
      if (/unauthorized|revoked|inactive/i.test(e2.message || "")) { writeSession(null); render(); return; }
      btn.disabled = false; btn.textContent = orig; toast(_friendlyError(e2, "Couldn't save. Try again."), "warn"); return;
    }
    toast("Done — nice work ✓", "success");
    navigate("/tasks/onboarding");
  });
}

// ── Form fill-out ───────────────────────────────────────────────────
//
// Loads a single published form via driver_get_form and renders an
// input per field.  Submit collects values keyed by field id and
// calls driver_submit_form.  Form-level settings.once_per_driver
// drives the "already submitted" guard surfaced on the Tasks hub
// and enforced server-side too.
async function renderFormFill() {
  const main = document.getElementById("main");
  main.innerHTML = `<div class="loader" style="margin:48px auto"></div>`;
  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }

  const id = routeQuery().get("id");
  if (!id) { navigate("/tasks"); return; }

  const { data: form, error } = await sb.rpc("driver_get_form", { p_token: session.token, p_id: id });
  if (error || !form) {
    main.innerHTML = errorStateHtml(error ? "Couldn't load this form" : "Form not found", error);
    return;
  }

  setHeader(form.title || "Form", "");
  _logFormEvent("opened", id);

  const fields = Array.isArray(form.fields) ? form.fields : [];
  const fieldHtml = fields.map((f, i) => _formFieldHtml(f, fields, i)).join("");

  main.innerHTML = `
    <div class="form-fill-page">
      ${form.description ? `<div class="form-fill-desc">${escapeHtml(form.description)}</div>` : ""}
      <form id="rr-form-fill">
        ${fieldHtml}
        <button class="btn btn-primary btn-block" type="submit" style="margin-top:18px">Submit</button>
      </form>
    </div>`;

  // Restore any previously-typed answers and wire incremental saving.
  // Drivers can be interrupted mid-form by a phone call, a dropped
  // signal, or a navigation; this guarantees their work isn't lost
  // until the form is submitted (success path explicitly clears it).
  const DRAFT_KEY = `form:${id}`;
  const _formEl = document.getElementById("rr-form-fill");

  // Apply any server-side prefills (e.g. the resolved van number on the
  // Vehicle Concerns form) before draft restoration so a stored draft
  // still wins over the prefill if the driver previously edited the
  // value mid-form.
  const _prefill = (form.prefill && typeof form.prefill === "object") ? form.prefill : null;
  if (_prefill) {
    for (const [fid, val] of Object.entries(_prefill)) {
      if (val == null || val === "") continue;
      const root = _formEl.querySelector(`[data-rr-field="${CSS.escape(fid)}"]`);
      if (!root) continue;
      const t = root.getAttribute("data-rr-type");
      if (t === "short_text" || t === "long_text" || t === "email" ||
          t === "phone"      || t === "number"    || t === "date"  ||
          t === "time"       || t === "dropdown") {
        if ("value" in root) root.value = val;
      }
    }
  }

  const _restored = getDraft(DRAFT_KEY);
  if (_restored && typeof _restored === "object") {
    for (const [fid, val] of Object.entries(_restored)) {
      const root = _formEl.querySelector(`[data-rr-field="${CSS.escape(fid)}"]`);
      if (!root) continue;
      const t = root.getAttribute("data-rr-type");
      if (t === "yes_no" || t === "single_choice" || t === "rating") {
        root.querySelectorAll("input[type=radio]").forEach(r => {
          r.checked = String(r.value) === String(val);
        });
      } else if (t === "multi_choice") {
        const set = new Set(Array.isArray(val) ? val.map(String) : []);
        root.querySelectorAll("input[type=checkbox]").forEach(c => {
          c.checked = set.has(c.value);
        });
      } else if (t === "photo" || t === "file") {
        // Skip — files can't be programmatically refilled, and the
        // draft only carries metadata anyway.
      } else if (t === "dropdown") {
        root.value = val ?? "";
      } else {
        // short_text / long_text / number / date / time / signature
        if ("value" in root) root.value = val ?? "";
      }
    }
    if (Object.keys(_restored).length > 0) {
      toast("Restored your in-progress answers", "ok");
    }
  }

  // Wire a real canvas signature pad for every signature field (drawn ink
  // is read back as a PNG data URL at submit; not draft-restorable).
  fields.filter(f => f.type === "signature").forEach(f => {
    _initSignaturePad(`ff-${f.id}`, `ff-${f.id}-clear`);
  });

  // Debounced save on any text change.
  let _formDraftTimer = null;
  const _saveFormDraft = () => {
    clearTimeout(_formDraftTimer);
    _formDraftTimer = setTimeout(async () => {
      try {
        const cur = await _collectFormAnswers(fields, { skipUploads: true });
        setDraft(DRAFT_KEY, cur);
      } catch { /* swallow — drafts are best-effort */ }
    }, 400);
  };
  _formEl.addEventListener("input",  _saveFormDraft);
  _formEl.addEventListener("change", _saveFormDraft);

  // Conditional logic — re-evaluate visibility on any answer change so
  // dependent fields reveal/hide live. No-op when the form has no
  // conditional fields. Run once now (after prefill + draft restore) to
  // apply the initial state against any restored trigger answers.
  const _runConds = () => _evalFormConditions(_formEl);
  _formEl.addEventListener("input",  _runConds);
  _formEl.addEventListener("change", _runConds);
  _runConds();

  _formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    const resetBtn = () => { if (btn) { btn.disabled = false; btn.textContent = "Submit"; } };
    if (btn) { btn.disabled = true; btn.textContent = "Uploading…"; }

    // If we're offline up front, collect with deferred file uploads so the
    // raw blobs ride along in the queue and upload on flush.
    const offline = (typeof navigator !== "undefined" && navigator.onLine === false);
    const deferredFiles = [];
    const answers = await _collectFormAnswers(
      fields,
      offline ? { deferFiles: true, deferredFiles } : {}
    );

    // Online only: block submit if any photo/file upload failed — otherwise
    // the driver believes the attachment was submitted when only an error
    // marker was stored (it would even pass required validation as truthy).
    if (!offline) {
      const failedUpload = fields.find((f) => {
        const v = answers[f.id];
        return v && typeof v === "object" && v.error;
      });
      if (failedUpload) {
        resetBtn();
        toast(`Couldn't upload "${failedUpload.label || "attachment"}" — check your connection and try again.`, "warn");
        return;
      }
    }

    // Validation — required + field-level rules (min/max length, numeric
    // range, email/phone format, choice membership), mirroring the server
    // (migration 0439). A conditional field that is currently HIDDEN (its
    // rule isn't met) is skipped: not required, not validated. On the first
    // failure we scroll to and focus the offending field so the driver
    // isn't left hunting for it on a long form.
    for (const f of fields) {
      if (["section_header", "divider", "instructions"].includes(f.type)) continue;
      const condWrap = _formEl.querySelector(`[data-cond-field="${CSS.escape(f.id)}"]`);
      if (condWrap && condWrap.hidden) continue;
      const err = _validateFormAnswer(f, answers[f.id]);
      if (err) {
        resetBtn();
        _focusFormField(_formEl, f.id);
        toast(err, "warn");
        return;
      }
    }

    // Persist offline (or when the network drops mid-submit): store the
    // submission for the queue to flush later so nothing is lost to a bad
    // signal. queueAndLeave() clears the draft and returns to Tasks.
    const queueAndLeave = async (files) => {
      try {
        await _formQueueAdd({
          id:        `${id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
          formId:    id,
          formTitle: form.title || "Form",
          answers,
          files:     files || [],
          createdAt: Date.now(),
        });
      } catch (qErr) {
        resetBtn();
        toast("Couldn't save this to submit later — please try again with signal.", "warn");
        return false;
      }
      clearDraft(DRAFT_KEY);
      _haptic("success");
      _logFormEvent("queued_offline", id);
      toast("Saved — we'll submit this when you're back online", "ok");
      navigate("/tasks");
      return true;
    };

    if (offline) { await queueAndLeave(deferredFiles); return; }

    if (btn) { btn.textContent = "Submitting…"; }
    let subErr = null;
    try {
      const res = await sb.rpc("driver_submit_form", {
        p_token:   session.token,
        p_form_id: id,
        p_answers: answers,
      });
      subErr = res.error;
    } catch (netErr) {
      // Transport threw — almost always the network dropped mid-request.
      // Photos already uploaded (answers carry their paths), so queue with
      // no deferred files and let the flusher re-POST when signal returns.
      await queueAndLeave([]);
      return;
    }
    if (subErr) {
      // Network went away between collect and response — queue rather than
      // make the driver refill. Any other error is a real server rejection.
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        await queueAndLeave([]);
        return;
      }
      resetBtn();
      _logFormEvent("submit_rejected", id, { code: subErr.code || null });
      toast(_friendlyError(subErr, "Couldn't submit. Your answers are still here — try again."), "warn");
      return;
    }
    clearDraft(DRAFT_KEY);
    _haptic("success");
    _logFormEvent("submitted", id);
    toast("Submitted", "ok");
    navigate("/tasks");
  });
}

// Conditional-logic eligibility: only these earlier field types can be a
// trigger (discrete answers). Mirrors the builder's _COND_TRIGGER_TYPES.
const _COND_TRIGGER_TYPES = new Set(["yes_no", "single_choice", "dropdown", "rating"]);

// Wrap a field's HTML in a conditional-visibility wrapper when it carries a
// valid `condition`. The wrapper holds the rule as data-* so the runtime
// evaluator (_evalFormConditions) can read it, and starts hidden until the
// trigger's current answer satisfies the rule. A stale/invalid condition
// (no fieldId, or the trigger isn't an EARLIER eligible field) fails OPEN —
// the field renders unwrapped and always shows, exactly like today.
function _formFieldHtml(f, allFields, idx) {
  const inner = _formFieldInnerHtml(f);
  const fields = Array.isArray(allFields) ? allFields : [];
  const cond = f.condition && f.condition.fieldId ? f.condition : null;
  if (cond) {
    const tIdx = fields.findIndex(x => x.id === cond.fieldId);
    const trig = tIdx >= 0 ? fields[tIdx] : null;
    const eligible = trig && tIdx < (idx == null ? fields.length : idx) && _COND_TRIGGER_TYPES.has(trig.type);
    if (eligible) {
      const op = cond.op === "neq" ? "neq" : "eq";
      return `<div class="form-fill-cond" data-cond-field="${escapeHtml(f.id)}" data-cond-on="${escapeHtml(cond.fieldId)}" data-cond-op="${op}" data-cond-value="${escapeHtml(String(cond.value ?? ""))}" hidden>${inner}</div>`;
    }
  }
  return inner;
}

// Read the CURRENT value a trigger field holds inside `formEl`, matching the
// discrete answer the builder's value picker offers. Returns a string (or ""
// when unanswered) so it compares cleanly against data-cond-value.
function _readTriggerValue(formEl, triggerFieldId) {
  const root = formEl.querySelector(`[data-rr-field="${CSS.escape(triggerFieldId)}"]`);
  if (!root) return "";
  const t = root.getAttribute("data-rr-type");
  if (t === "yes_no" || t === "single_choice" || t === "rating") {
    const sel = root.querySelector("input[type=radio]:checked");
    return sel ? String(sel.value) : "";
  }
  if (t === "dropdown") return String(root.value || "");
  // Any other type isn't an eligible trigger; fall back to its value.
  return "value" in root ? String(root.value || "") : "";
}

// Show/hide every conditional field based on its trigger's current answer.
// No-op when the form has no [data-cond-field] wrappers (non-conditional
// forms behave exactly as before). Called once after render and on every
// input/change. A hidden field gets [hidden] + .is-cond-hidden; the submit
// and required-validation paths both skip [data-cond-field][hidden] fields,
// so a hidden conditional field is neither required nor submitted, and a
// revealed one participates normally.
function _evalFormConditions(formEl) {
  if (!formEl) return;
  const wrappers = formEl.querySelectorAll("[data-cond-field]");
  if (!wrappers.length) return;
  wrappers.forEach((w) => {
    const on  = w.getAttribute("data-cond-on");
    const op  = w.getAttribute("data-cond-op") === "neq" ? "neq" : "eq";
    const val = w.getAttribute("data-cond-value") || "";
    const cur = _readTriggerValue(formEl, on);
    const matches = op === "neq" ? (cur !== val) : (cur === val);
    // Fail-open guard: if the trigger field isn't present at all, show.
    const triggerPresent = !!formEl.querySelector(`[data-rr-field="${CSS.escape(on)}"]`);
    const show = triggerPresent ? matches : true;
    w.hidden = !show;
    w.classList.toggle("is-cond-hidden", !show);
  });
}

function _formFieldInnerHtml(f) {
  const id   = `ff-${f.id}`;
  const lbl  = escapeHtml(f.label || "");
  const help = f.help ? `<div class="form-fill-help">${escapeHtml(f.help)}</div>` : "";
  const req  = f.required ? `<span style="color:var(--red);margin-left:3px">*</span>` : "";
  const row  = (input) => `<div class="form-fill-row"><label class="form-fill-label" for="${id}">${lbl}${req}</label>${help}${input}</div>`;
  // Group row for radio/checkbox groups: the question is a <span> (not a
  // <label for>, which can only target one control) and the group carries
  // role="group" + aria-labelledby so screen readers announce the question
  // with the choices.
  const grow = (input) => `<div class="form-fill-row"><span class="form-fill-label" id="${id}-lbl">${lbl}${req}</span>${help}${input}</div>`;
  switch (f.type) {
    case "instructions":
      return `<div class="form-fill-instructions"><div class="form-fill-instructions-title">${lbl || "Instructions"}</div><div>${escapeHtml(f.help || "")}</div></div>`;
    case "section_header":
      return `<div class="form-fill-section">${lbl}</div>`;
    case "divider":
      return `<hr class="form-fill-divider"/>`;
    case "long_text":
      return row(`<textarea class="field" id="${id}" rows="4" data-rr-field="${escapeHtml(f.id)}" data-rr-type="${f.type}"></textarea>`);
    case "email":
      return row(`<input class="field" id="${id}" type="email" inputmode="email" data-rr-field="${escapeHtml(f.id)}" data-rr-type="${f.type}"/>`);
    case "phone":
      return row(`<input class="field" id="${id}" type="tel" inputmode="tel" data-rr-field="${escapeHtml(f.id)}" data-rr-type="${f.type}"/>`);
    case "number":
      return row(`<input class="field" id="${id}" type="number" inputmode="decimal" data-rr-field="${escapeHtml(f.id)}" data-rr-type="${f.type}"/>`);
    case "date":
      return row(`<input class="field" id="${id}" type="date" data-rr-field="${escapeHtml(f.id)}" data-rr-type="${f.type}"/>`);
    case "time":
      return row(`<input class="field" id="${id}" type="time" data-rr-field="${escapeHtml(f.id)}" data-rr-type="${f.type}"/>`);
    case "yes_no":
      return grow(`
        <div class="form-fill-choice-row" role="group" aria-labelledby="${id}-lbl" data-rr-field="${escapeHtml(f.id)}" data-rr-type="yes_no">
          <label class="form-fill-choice"><input type="radio" name="${id}" value="yes"/><span>Yes</span></label>
          <label class="form-fill-choice"><input type="radio" name="${id}" value="no"/><span>No</span></label>
        </div>`);
    case "rating":
      return grow(`
        <div class="form-fill-rating" role="group" aria-labelledby="${id}-lbl" data-rr-field="${escapeHtml(f.id)}" data-rr-type="rating">
          ${[1,2,3,4,5].map(n => `<label class="form-fill-rating-star"><input type="radio" name="${id}" value="${n}"/><span>${n}</span></label>`).join("")}
        </div>`);
    case "single_choice": {
      const opts = (f.options || []).map((o, i) => `
        <label class="form-fill-choice"><input type="radio" name="${id}" value="${escapeHtml(o)}"/><span>${escapeHtml(o)}</span></label>`).join("");
      return grow(`<div class="form-fill-choice-col" role="group" aria-labelledby="${id}-lbl" data-rr-field="${escapeHtml(f.id)}" data-rr-type="single_choice">${opts}</div>`);
    }
    case "multi_choice": {
      const opts = (f.options || []).map((o, i) => `
        <label class="form-fill-choice"><input type="checkbox" value="${escapeHtml(o)}"/><span>${escapeHtml(o)}</span></label>`).join("");
      return grow(`<div class="form-fill-choice-col" role="group" aria-labelledby="${id}-lbl" data-rr-field="${escapeHtml(f.id)}" data-rr-type="multi_choice">${opts}</div>`);
    }
    case "dropdown": {
      const opts = (f.options || []).map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");
      return row(`<select class="field" id="${id}" data-rr-field="${escapeHtml(f.id)}" data-rr-type="dropdown"><option value="">— Select —</option>${opts}</select>`);
    }
    case "photo":
      return row(`<input class="field" id="${id}" type="file" accept="image/*" capture="environment" data-rr-field="${escapeHtml(f.id)}" data-rr-type="photo"/>`);
    case "file":
      return row(`<input class="field" id="${id}" type="file" data-rr-field="${escapeHtml(f.id)}" data-rr-type="file"/>`);
    case "signature":
      // Real canvas signature pad (shared _initSignaturePad, wired after
      // render). The canvas carries data-rr-field so _collectFormAnswers
      // reads its ink as a PNG data URL, matching the Checklist flow.
      return row(`<div class="form-fill-sigwrap">
          <canvas class="form-fill-sigpad" id="${id}" data-rr-field="${escapeHtml(f.id)}" data-rr-type="signature" height="140"></canvas>
          <button type="button" class="form-fill-sigclear" id="${id}-clear">Clear</button>
        </div>`);
    case "gps":
      // GPS captures lat/lng on submit (see _collectFormAnswers).
      return row(`<div class="form-fill-gps" data-rr-field="${escapeHtml(f.id)}" data-rr-type="gps">Location will be captured when you submit.</div>`);
    case "short_text":
    default:
      return row(`<input class="field" id="${id}" type="text" data-rr-field="${escapeHtml(f.id)}" data-rr-type="short_text"/>`);
  }
}

// _validateFormAnswer lives in ./form-validation.js (imported at the top of
// this file as validateFormAnswer). It was extracted into a standalone,
// dependency-free module so it can be unit-tested in Node and diffed against
// the server rules in migration 0439 — see that module's header for the
// parity contract.

// Scroll to and focus a field by id so a validation error is immediately
// visible — beats a lone toast on a long form.
function _focusFormField(formEl, fid) {
  const root = formEl.querySelector(`[data-rr-field="${CSS.escape(fid)}"]`);
  if (!root) return;
  const target = (root.matches("input,select,textarea") ? root : root.querySelector("input,select,textarea")) || root;
  try { target.scrollIntoView({ behavior: "smooth", block: "center" }); } catch { try { target.scrollIntoView(); } catch {} }
  try { target.focus({ preventScroll: true }); } catch {}
}

async function _collectFormAnswers(fields, opts = {}) {
  const out = {};
  const session = readSession();
  const driverId = session?.driver_id || null;
  const dspId    = session?.dsp_id    || null;
  // Walk the inputs and collect; photos upload to storage in parallel
  // so their path ends up in answers when we submit (downstream DVIC
  // flow extracts paths from these to populate the inspection's
  // photos array). When `opts.skipUploads` is set (auto-save / draft
  // pass), we record whatever text-ish state exists and skip the
  // storage round-trip — drafts never spend bandwidth.
  const skipUploads = !!opts.skipUploads;
  const photoUploads = [];
  const gpsCaptures = [];
  const deferOps = [];  // async prep for offline-queued blobs (e.g. downscale)
  document.querySelectorAll("#rr-form-fill [data-rr-field]").forEach((el) => {
    // Conditional logic: a field whose condition isn't currently met sits
    // inside a hidden [data-cond-field] wrapper. Skip it entirely so it is
    // NOT submitted (no answer key) while hidden — and so required
    // validation, which reads this same answers map, won't see a value for
    // it. When the trigger reveals it, the wrapper is no longer hidden and
    // it's collected normally.
    const condWrap = el.closest("[data-cond-field]");
    if (condWrap && condWrap.hidden) return;
    const fid = el.getAttribute("data-rr-field");
    const t   = el.getAttribute("data-rr-type");
    if (t === "yes_no" || t === "single_choice" || t === "rating") {
      const sel = el.querySelector("input[type=radio]:checked");
      if (sel) out[fid] = t === "rating" ? Number(sel.value) : sel.value;
    } else if (t === "multi_choice") {
      out[fid] = Array.from(el.querySelectorAll("input[type=checkbox]:checked")).map((c) => c.value);
    } else if (t === "photo") {
      if (skipUploads) return;  // skip in draft mode
      // Offline path: carry the (downscaled) blob + a small thumbnail for the
      // queue to upload later.
      if (opts.deferFiles) {
        const f = el.files?.[0];
        if (f) {
          out[fid] = { name: f.name, size: f.size, type: f.type, deferred: true };
          deferOps.push(Promise.all([_downscaleImageFile(f), _downscaleImageFile(f, 480, 0.6)]).then(([up, thumb]) => {
            opts.deferredFiles.push({ fid, blob: up, thumb: thumb !== f ? thumb : null, name: f.name, type: up.type });
          }));
        } else { out[fid] = null; }
        return;
      }
      // Upload the captured photo to driver-documents under a path
      // gated by the existing DSP-tenant SELECT policy (0021): the
      // FIRST folder MUST be the DSP id so dispatchers on that DSP
      // can read the object back.  Without this prefix, the
      // dispatcher gets a 403 on createSignedUrls and the Inspections
      // tab thumbnails come back broken.
      const f = el.files?.[0];
      if (f) {
        const ts = Date.now();
        const safe = (f.name || "photo").replace(/[^A-Za-z0-9._-]+/g, "-");
        const base = `${dspId || "no-dsp"}/dvic/${driverId || "anon"}/${ts}-${Math.random().toString(36).slice(2, 8)}`;
        const path = `${base}-${safe}`;
        const thumbPath = `${base}-thumb.jpg`;
        out[fid] = { path, name: f.name, size: f.size, type: f.type, uploading: true };
        photoUploads.push(
          // Upload the full image + a small thumbnail in parallel. The
          // thumbnail is best-effort: photo-heavy reports load the light
          // thumb, but a failed thumb just falls back to the full image.
          Promise.all([
            _downscaleImageFile(f).then((up) =>
              sb.storage.from("driver-documents").upload(path, up, { contentType: up.type, upsert: false })
                .then(({ error }) => ({ error, size: up.size, type: up.type }))),
            _downscaleImageFile(f, 480, 0.6).then((tb) =>
              tb !== f
                ? sb.storage.from("driver-documents").upload(thumbPath, tb, { contentType: tb.type || "image/jpeg", upsert: false })
                    .then(({ error }) => !error)
                    .catch(() => false)
                : false),
          ]).then(([full, thumbOk]) => {
            if (full.error) {
              console.warn("DVIC photo upload failed:", full.error.message);
              out[fid] = { name: f.name, size: f.size, type: f.type, error: full.error.message };
            } else {
              out[fid] = { path, name: f.name, size: full.size, type: full.type, ...(thumbOk ? { thumb: thumbPath } : {}) };
            }
          }).catch((e) => {
            console.warn("DVIC photo upload error:", e);
            out[fid] = { name: f.name, size: f.size, type: f.type, error: String(e) };
          })
        );
      } else {
        out[fid] = null;
      }
    } else if (t === "file") {
      if (skipUploads) return;  // drafts never spend bandwidth
      // Offline path: carry the raw blob for the queue to upload later.
      if (opts.deferFiles) {
        const f = el.files?.[0];
        if (f) {
          opts.deferredFiles.push({ fid, blob: f, name: f.name, type: f.type });
          out[fid] = { name: f.name, size: f.size, type: f.type, deferred: true };
        } else { out[fid] = null; }
        return;
      }
      // Previously the file's bytes were discarded — only {name,size,type}
      // was stored, so dispatchers got an unusable filename. Now we upload
      // the file to storage and keep its path, mirroring the photo branch.
      const f = el.files?.[0];
      if (f) {
        const ts = Date.now();
        const safe = (f.name || "file").replace(/[^A-Za-z0-9._-]+/g, "-");
        // Same DSP-first path prefix as photos so the existing
        // driver-documents SELECT policy lets dispatchers read it back.
        const path = `${dspId || "no-dsp"}/dvic/${driverId || "anon"}/${ts}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
        out[fid] = { path, name: f.name, size: f.size, type: f.type, uploading: true };
        photoUploads.push(
          sb.storage.from("driver-documents").upload(path, f, { contentType: f.type, upsert: false })
            .then(({ error }) => {
              if (error) {
                console.warn("Form file upload failed:", error.message);
                out[fid] = { name: f.name, size: f.size, type: f.type, error: error.message };
              } else {
                out[fid] = { path, name: f.name, size: f.size, type: f.type };
              }
            })
            .catch((e) => {
              console.warn("Form file upload error:", e);
              out[fid] = { name: f.name, size: f.size, type: f.type, error: String(e) };
            })
        );
      } else {
        out[fid] = null;
      }
    } else if (t === "signature") {
      if (skipUploads) return;  // don't bloat localStorage drafts with base64 ink
      // Canvas pad: export ink as a PNG data URL, or "" when unsigned so
      // required validation treats an empty pad as missing.
      out[fid] = el._rrHasInk ? el.toDataURL("image/png") : "";
    } else if (t === "gps") {
      // Previously read el.dataset.rrGps, which was never set anywhere —
      // so a GPS field always submitted null despite promising "captured
      // when you submit". Now we actually capture the location at submit
      // time. Draft passes never prompt for location.
      if (el.dataset.rrGps) {
        try { out[fid] = JSON.parse(el.dataset.rrGps); } catch { out[fid] = el.dataset.rrGps; }
      } else {
        out[fid] = null;
      }
      if (!skipUploads && !el.dataset.rrGps && "geolocation" in navigator) {
        gpsCaptures.push(new Promise((resolve) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              const g = {
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                accuracy: Math.round(pos.coords.accuracy || 0),
                at: new Date().toISOString(),
              };
              el.dataset.rrGps = JSON.stringify(g);
              out[fid] = g;
              resolve();
            },
            // Permission denied / no fix — leave null, never block submit.
            () => { out[fid] = null; resolve(); },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
          );
        }));
      }
    } else {
      out[fid] = el.value || "";
    }
  });
  // Wait for all photo/file uploads, GPS captures, and offline blob prep
  // to settle before returning so the answers carry final paths/coords and
  // the queue carries the downscaled blobs.
  if (photoUploads.length || gpsCaptures.length || deferOps.length) {
    await Promise.all([...photoUploads, ...gpsCaptures, ...deferOps]);
  }
  return out;
}


// ── Checklists tab ──────────────────────────────────────────────────
//
// Dedicated bottom-nav tab for assigned checklists (operator request —
// they used to live as cards inside the Forms hub). The hub groups
// today's checklists into "To do" and "Completed"; the tab icon carries
// a count badge of open (not-completed) checklists, refreshed on every
// shell mount like the Forms/Chat badges.

function _clkCardHtml(c) {
  const dueTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  let sub;
  if (c.status === "completed") {
    sub = `Completed${c.submitted_at ? " · " + dueTime(c.submitted_at) : ""}`;
  } else if (c.status === "overdue") {
    sub = `Overdue — was due ${c.due_at ? dueTime(c.due_at) : "earlier"}`;
  } else {
    const bits = [c.required ? "Required" : "Optional",
                  `${c.item_count} item${c.item_count === 1 ? "" : "s"}`];
    if (c.due_at) bits.push(`Due ${dueTime(c.due_at)}`);
    if (c.status === "in_progress") bits.push("In progress");
    sub = bits.join(" · ");
  }
  return taskCardHtml({
    route: `/tasks/checklist?id=${encodeURIComponent(c.assignment_id)}`,
    title: c.name || "Checklist",
    sub,
    icon:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M7.5 12.4l3 3 6-6.4"/></svg>',
  });
}

function renderChecklistsHub() {
  setHeader("Checklists", "");
  setRefresh(() => renderChecklistsHub());
  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }
  const main = document.getElementById("main");
  main.innerHTML = `
    <div id="rr-clk-outbox-banner" hidden style="margin-bottom:12px"></div>
    <div id="rr-clk-hub-skel">${taskSkeletonHtml(2)}</div>
    <div id="rr-clk-hub"></div>`;

  // Surface anything queued offline, and try to flush now that we're here.
  _clkPaintOutboxBanner();
  _clkFlushOutbox({ silent: true });

  sb.rpc("driver_list_checklists", { p_token: session.token }).then(({ data, error }) => {
    if (currentRoute() !== "/checklists") return;
    document.getElementById("rr-clk-hub-skel")?.remove();
    const host = document.getElementById("rr-clk-hub");
    if (!host) return;
    if (error) {
      console.warn("driver_list_checklists error:", error);
      // Surface the underlying error so a broken backend (missing
      // migration, bad grant, runtime SQL error) is diagnosable from
      // the phone instead of hiding behind a generic retry line.
      const detail = [error.code, error.message, error.hint].filter(Boolean).join(" · ");
      host.innerHTML = `<div class="rr-empty-inline" style="padding:48px 20px;color:var(--text-subtle);font-size:var(--fs-md)">Couldn't load checklists — pull down to retry.${
        detail ? `<div style="margin-top:10px;font-size:12px;line-height:1.5;color:var(--rr-red-700);overflow-wrap:anywhere">${escapeHtml(detail)}</div>` : ""
      }</div>`;
      return;
    }
    const lists = Array.isArray(data) ? data : [];
    if (lists.length === 0) {
      _setChecklistsTabBadge(0);
      host.innerHTML = `<div class="rr-empty-inline" style="padding:48px 20px;color:var(--text-subtle);font-size:var(--fs-md)">No checklists assigned right now — you're all set.</div>`;
      return;
    }
    const todo = lists.filter((c) => c.status !== "completed");
    const done = lists.filter((c) => c.status === "completed");
    host.innerHTML =
      (todo.length ? `<div class="clk-hub-h">To do</div>` + todo.map(_clkCardHtml).join("") : "") +
      (done.length ? `<div class="clk-hub-h">Completed</div>` + done.map(_clkCardHtml).join("") : "");
    host.querySelectorAll("[data-task-route]").forEach((el) =>
      el.addEventListener("click", () => navigate(el.dataset.taskRoute)));
    _setChecklistsTabBadge(todo.length);
  }).catch((err) => {
    console.warn("driver_list_checklists rejected:", err);
    document.getElementById("rr-clk-hub-skel")?.remove();
    const host = document.getElementById("rr-clk-hub");
    if (host) host.innerHTML = `<div class="rr-empty-inline" style="padding:48px 20px;color:var(--text-subtle);font-size:var(--fs-md)">Couldn't load checklists — pull down to retry.<div style="margin-top:10px;font-size:12px;line-height:1.5;color:var(--rr-red-700);overflow-wrap:anywhere">${escapeHtml(String(err && err.message || err))}</div></div>`;
  });
}

// Open-checklist count → folded into the shared Tasks tab badge
// (checklists no longer have their own bottom-nav tab).
function _setChecklistsTabBadge(n) { _tasksBadgeChecklists = n || 0; _paintTasksTabBadge(); }

async function refreshChecklistsBadge() {
  if (PREVIEW) return;
  const session = readSession();
  if (!session?.token) { _setChecklistsTabBadge(0); return; }
  try {
    const { data, error } = await sb.rpc("driver_list_checklists", { p_token: session.token });
    if (error) return;
    const lists = Array.isArray(data) ? data : [];
    _setChecklistsTabBadge(lists.filter((c) => c.status !== "completed").length);
  } catch {}
}


// ── Checklist fill-out ──────────────────────────────────────────────
//
// Assigned checklists open from their Checklists-tab card. Same skeleton
// as renderFormFill (draft restore, required validation, photo upload to
// driver-documents) plus: server-side progress save (dispatch sees
// "In progress"), a real canvas signature pad (_initSignaturePad), and
// a locked read-only view once submitted — until dispatch reopens it.
// Answers post as { <item_id>: { v, note?, photos? } } to
// driver_save_checklist / driver_submit_checklist.

// Per-fill photo model: itemId -> [{ path } (already uploaded) |
// { file, url } (newly picked)]. Rebuilt on every render of the fill
// screen so multiple photos, previews and removal all work off one source.
let _clkPhotos = {};

// Downscale + JPEG-encode a captured photo so a ~6 MB phone shot uploads
// as a couple hundred KB. Reuses the scanner's orientation-aware decode.
// Never blocks a submit — any failure falls back to the original file.
async function _clkCompressPhoto(file) {
  if (!file || !/^image\//.test(file.type || "")) return file;
  try {
    const bmp = await _scanLoadBitmap(file);
    const sw = bmp.width || bmp.naturalWidth, sh = bmp.height || bmp.naturalHeight;
    const MAX = 1600;
    const scale = Math.min(1, MAX / Math.max(sw, sh));
    const ow = Math.max(1, Math.round(sw * scale)), oh = Math.max(1, Math.round(sh * scale));
    const c = document.createElement("canvas");
    c.width = ow; c.height = oh;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, ow, oh);
    ctx.drawImage(bmp, 0, 0, ow, oh);
    if (typeof bmp.close === "function") bmp.close();
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.82));
    if (!blob) return file;
    if (blob.size >= file.size && scale === 1) return file;   // already small
    return new File([blob], (file.name || "photo").replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch (_) {
    return file;
  }
}

// data:image/png;base64,… → Blob, for uploading a signature canvas.
function _dataUrlToBlob(dataUrl) {
  const [head, b64] = String(dataUrl).split(",");
  const mime = (head.match(/data:([^;]+)/) || [])[1] || "image/png";
  const bin = atob(b64 || "");
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// Sign a driver-documents storage path for display (anon can sign this
// private bucket). Returns null on failure so callers can fall back.
async function _clkSignedUrl(path) {
  try {
    const { data } = await sb.storage.from("driver-documents").createSignedUrl(path, 3600);
    return data?.signedUrl || null;
  } catch (_) { return null; }
}

// Paint the thumbnail strip for a photo item from _clkPhotos. New photos
// show a preview; restored (already-uploaded) ones show a labeled chip.
function _clkRenderPhotoStrip(itemId) {
  const strip = document.querySelector(`[data-rr-clk-photostrip="${CSS.escape(itemId)}"]`);
  if (!strip) return;
  const list = _clkPhotos[itemId] || [];
  strip.innerHTML = list.map((p, i) => `
    <div class="clk-thumb" style="position:relative;width:64px;height:64px;margin:0 8px 8px 0">
      ${p.url
        ? `<img src="${escapeHtml(p.url)}" alt="Photo ${i + 1}" style="width:64px;height:64px;object-fit:cover;border-radius:8px;border:1px solid var(--border,var(--rr-gray-300))"/>`
        : `<span style="display:flex;width:64px;height:64px;align-items:center;justify-content:center;border-radius:8px;border:1px solid var(--border,var(--rr-gray-300));background:var(--surface,var(--rr-gray-100));font-size:11px;color:var(--text-subtle,var(--rr-gray-500))">Photo ${i + 1}</span>`}
      <button type="button" class="clk-photo-del" data-rr-clk-photodel="${escapeHtml(itemId)}|${i}" aria-label="Remove photo ${i + 1}">✕</button>
    </div>`).join("");
}

function _clkItemHtml(item) {
  // Required is announced via aria-required on the control/group; the red
  // star is decorative (aria-hidden) so it isn't the only cue.
  const req = item.required ? ' <span class="clk-req" aria-hidden="true" style="color:var(--rr-red-600)">*</span>' : "";
  const areq = item.required ? ' aria-required="true"' : "";
  const help = item.helper_text ? `<div class="clk-helper" id="clk-help-${escapeHtml(item.id)}">${escapeHtml(item.helper_text)}</div>` : "";
  const descBy = item.helper_text ? ` aria-describedby="clk-help-${escapeHtml(item.id)}"` : "";
  const id = escapeHtml(item.id);
  const fid = `clk-field-${id}`;     // control id, targeted by the row <label for>
  const lid = `clk-lbl-${id}`;       // row label id, for group/canvas labelling
  // Types with a single native control get a plain label[for]; radiogroup,
  // checkbox and signature need explicit association instead.
  let control = "";
  let labelFor = ` for="${fid}"`;
  if (item.item_type === "checkbox") {
    control = `<label class="clk-checkrow"><input type="checkbox" id="${fid}" data-rr-clk="${id}" data-rr-clk-type="checkbox"${areq}${descBy}/><span>Mark as done</span></label>`;
  } else if (item.item_type === "yes_no") {
    labelFor = "";  // a group can't be targeted by label[for]
    control = `<div class="form-fill-choice-row" role="radiogroup" aria-labelledby="${lid}"${areq}${descBy} data-rr-clk="${id}" data-rr-clk-type="yes_no">
      <label><input type="radio" name="clk-${id}" value="yes"/><span>Yes</span></label>
      <label><input type="radio" name="clk-${id}" value="no"/><span>No</span></label>
    </div>`;
  } else if (item.item_type === "number") {
    control = `<input type="number" id="${fid}" inputmode="decimal" step="any" data-rr-clk="${id}" data-rr-clk-type="number"${areq}${descBy}/>`;
  } else if (item.item_type === "photo") {
    control = `<div class="clk-photos">
      <div class="clk-photo-strip" data-rr-clk-photostrip="${id}" style="display:flex;flex-wrap:wrap"></div>
      <label class="clk-photo-add" style="display:inline-flex;align-items:center;gap:6px;padding:8px 12px;border:1px dashed var(--border-strong,var(--rr-slate-300));border-radius:10px;cursor:pointer;font-size:var(--fs-sm)">
        <input type="file" id="${fid}" accept="image/*" multiple hidden data-rr-clk="${id}" data-rr-clk-type="photo"${areq}${descBy}/>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
        <span>Add photo</span>
      </label>
    </div>`;
  } else if (item.item_type === "signature") {
    labelFor = "";  // canvas isn't a labelable form control
    control = `<div class="clk-sigwrap">
      <canvas class="clk-sigpad" id="clk-sig-${id}" role="img" tabindex="0" aria-labelledby="${lid}" aria-label="Signature pad — sign with your finger" data-rr-clk="${id}" data-rr-clk-type="signature" height="140"></canvas>
      <button type="button" class="clk-sigclear" id="clk-sigclear-${id}">Clear</button>
    </div>`;
  } else if (item.item_type === "note") {
    control = `<textarea rows="3" id="${fid}" data-rr-clk="${id}" data-rr-clk-type="note"${areq}${descBy}></textarea>`;
  } else {
    control = `<input type="text" id="${fid}" data-rr-clk="${id}" data-rr-clk-type="short_text"${areq}${descBy}/>`;
  }
  return `<div class="form-fill-row clk-row">
    <label class="form-fill-label" id="${lid}"${labelFor}>${escapeHtml(item.label || "Untitled item")}${req}</label>
    ${help}
    ${control}
  </div>`;
}

function _clkAnswerDisplay(item, ans) {
  const v = ans && ans.v != null ? ans.v : null;
  if (item.item_type === "checkbox") return (v === true || v === "true") ? "✓ Done" : "Not done";
  if (item.item_type === "yes_no") return v === "yes" ? "Yes" : v === "no" ? "No" : "—";
  if (item.item_type === "photo") {
    const n = Array.isArray(ans?.photos) ? ans.photos.length : 0;
    return n ? `${n} photo${n === 1 ? "" : "s"} attached` : "No photo";
  }
  if (item.item_type === "signature") {
    if (typeof v === "string" && v.startsWith("data:image")) return `<img class="clk-sig-img" src="${escapeHtml(v)}" alt="Signature"/>`;
    if (typeof v === "string" && v) return `<img class="clk-sig-img" data-rr-sig-path="${escapeHtml(v)}" alt="Signature"/>`;  // signed after render
    return "Signed";
  }
  const s = v == null || v === "" ? "—" : String(v);
  return escapeHtml(s);
}

// Swap stored-signature <img data-rr-sig-path> placeholders for signed URLs.
function _clkEnhanceSignatures(root) {
  (root || document).querySelectorAll("img[data-rr-sig-path]").forEach((img) => {
    const p = img.getAttribute("data-rr-sig-path");
    img.removeAttribute("data-rr-sig-path");
    _clkSignedUrl(p).then((u) => { if (u) img.src = u; });
  });
}

async function _clkCollect(items, opts = {}) {
  const out = {};
  const session = readSession();
  const driverId = session?.driver_id || null;
  const dspId    = session?.dsp_id    || null;
  const skipUploads = !!opts.skipUploads;
  const uploads = [];
  let uploadFailed = 0;
  for (const item of items) {
    const el = document.querySelector(`#rr-clk-fill [data-rr-clk="${CSS.escape(item.id)}"]`);
    if (!el) continue;
    const t = el.getAttribute("data-rr-clk-type");
    if (t === "checkbox") {
      out[item.id] = { v: el.checked ? "true" : "false" };
    } else if (t === "yes_no") {
      const sel = el.querySelector("input[type=radio]:checked");
      if (sel) out[item.id] = { v: sel.value };
    } else if (t === "photo") {
      // Photos are handled off _clkPhotos after the loop (below).
    } else if (t === "signature") {
      // Fresh ink on a server pass is uploaded below; on a local-draft pass
      // it's kept inline so it survives a reload. An untouched pad keeps its
      // existing value (a storage path, or a legacy inline data URL).
      if (el._rrHasInk && skipUploads) out[item.id] = { v: el.toDataURL("image/png") };
      else if (!el._rrHasInk && el.dataset.rrExistingSig) out[item.id] = { v: el.dataset.rrExistingSig };
    } else {
      const v = (el.value || "").trim();
      if (v !== "") out[item.id] = { v };
    }
  }

  // Photos: upload any not-yet-stored files (unless this is a local-draft
  // pass), stamping the storage path back onto the entry. The DSP-id-first
  // path contract lets dispatch sign URLs.
  if (!skipUploads) {
    for (const item of items) {
      if (item.item_type !== "photo") continue;
      for (const entry of (_clkPhotos[item.id] || [])) {
        if (entry.path || !entry.file) continue;
        const ff = entry.file;
        const safe = (ff.name || "photo").replace(/[^A-Za-z0-9._-]+/g, "-");
        const path = `${dspId || "no-dsp"}/checklists/${driverId || "anon"}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
        uploads.push(
          sb.storage.from("driver-documents").upload(path, ff, { contentType: ff.type, upsert: false })
            .then(({ error }) => { if (error) { uploadFailed++; console.warn("checklist photo upload failed:", error.message); } else { entry.path = path; } })
            .catch((e) => { uploadFailed++; console.warn("checklist photo upload error:", e); })
        );
      }
    }

    // Signatures: upload freshly-drawn ink as a PNG to storage instead of
    // stuffing tens of KB of base64 into value_text on every save.
    for (const item of items) {
      if (item.item_type !== "signature") continue;
      const el = document.querySelector(`#rr-clk-fill [data-rr-clk="${CSS.escape(item.id)}"]`);
      if (!el || !el._rrHasInk) continue;
      const blob = _dataUrlToBlob(el.toDataURL("image/png"));
      const path = `${dspId || "no-dsp"}/checklists/${driverId || "anon"}/sig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
      uploads.push(
        sb.storage.from("driver-documents").upload(path, blob, { contentType: "image/png", upsert: false })
          .then(({ error }) => { if (error) { uploadFailed++; console.warn("checklist signature upload failed:", error.message); } else { out[item.id] = { v: path }; } })
          .catch((e) => { uploadFailed++; console.warn("checklist signature upload error:", e); })
      );
    }
  }
  if (uploads.length) await Promise.all(uploads);

  // Build photo answers from whatever now has a stored path (new uploads +
  // restored photos). Local-draft passes carry only the already-stored ones.
  for (const item of items) {
    if (item.item_type !== "photo") continue;
    const paths = (_clkPhotos[item.id] || []).filter((e) => e.path).map((e) => e.path);
    if (paths.length) out[item.id] = { photos: paths };
  }

  // A dropped photo used to be swallowed as a console.warn while the answer
  // kept the pre-upload (empty) list — so a driver could "save" or "submit"
  // and silently lose the photo. Surface it: throw so the caller can warn
  // and keep the work on the phone.
  if (uploadFailed) {
    const err = new Error("photo_upload_failed");
    err.rrUploadFailed = uploadFailed;
    throw err;
  }
  return out;
}

// ── Offline submit queue (outbox) ─────────────────────────────────────
//
// A checklist submit needs the network twice: to upload photos/signatures
// to storage, and to call driver_submit_checklist. If a driver is in a
// dead zone, both fail. The outbox persists the *raw* answer inputs (photo
// blobs, signature PNGs, field values) to IndexedDB and replays the whole
// upload+submit when connectivity returns. Replays are idempotent — the
// server's already_submitted guard + the unique-per-period index mean a
// double-fire just no-ops.

const _CLK_DB = "rr-checklist-outbox", _CLK_STORE = "outbox";
function _clkDb() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(_CLK_DB, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(_CLK_STORE)) db.createObjectStore(_CLK_STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function _clkIdbTx(mode, fn) {
  return _clkDb().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(_CLK_STORE, mode);
    const store = tx.objectStore(_CLK_STORE);
    let out;
    Promise.resolve(fn(store)).then((v) => { out = v; });
    tx.oncomplete = () => res(out);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  }));
}
const _clkOutboxAdd = (rec) => _clkIdbTx("readwrite", (s) => s.put(rec));
const _clkOutboxDel = (id) => _clkIdbTx("readwrite", (s) => s.delete(id));
const _clkOutboxAll = () => _clkIdbTx("readonly", (s) => new Promise((res) => { const r = s.getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => res([]); }));
async function _clkOutboxCount() { try { return (await _clkOutboxAll()).length; } catch (_) { return 0; } }

// Snapshot the form's raw inputs without uploading anything — safe to
// stash offline. Photos keep already-uploaded paths + not-yet-uploaded
// blobs; signatures keep fresh ink as a data URL or an existing value.
function _clkCaptureRaw(items) {
  const rec = { fields: {}, photos: {}, signatures: {} };
  for (const item of items) {
    const el = document.querySelector(`#rr-clk-fill [data-rr-clk="${CSS.escape(item.id)}"]`);
    if (!el) continue;
    const t = el.getAttribute("data-rr-clk-type");
    if (t === "checkbox") rec.fields[item.id] = { v: el.checked ? "true" : "false" };
    else if (t === "yes_no") { const s = el.querySelector("input[type=radio]:checked"); if (s) rec.fields[item.id] = { v: s.value }; }
    else if (t === "photo") {
      const entries = _clkPhotos[item.id] || [];
      const paths = entries.filter((e) => e.path).map((e) => e.path);
      const blobs = entries.filter((e) => e.file).map((e) => e.file);
      if (paths.length || blobs.length) rec.photos[item.id] = { paths, blobs };
    } else if (t === "signature") {
      if (el._rrHasInk) rec.signatures[item.id] = { dataUrl: el.toDataURL("image/png") };
      else if (el.dataset.rrExistingSig) rec.signatures[item.id] = { existing: el.dataset.rrExistingSig };
    } else { const v = (el.value || "").trim(); if (v) rec.fields[item.id] = { v }; }
  }
  return rec;
}

// Is `item` (by type) empty in a raw capture? Used to validate required
// items before we queue, so an offline submit still enforces them.
function _clkRawEmpty(item, rec) {
  if (item.item_type === "photo") { const p = rec.photos[item.id]; return !p || ((p.paths || []).length + (p.blobs || []).length) === 0; }
  if (item.item_type === "signature") return !rec.signatures[item.id];
  if (item.item_type === "checkbox") return (rec.fields[item.id]?.v) !== "true";
  const v = rec.fields[item.id]?.v;
  return v == null || v === "";
}

// Turn a stored record into a submit payload: upload its media (getting
// storage paths) then assemble the { itemId: {...} } answers.
async function _clkReplayRecord(rec) {
  const answers = {};
  const dspId = rec.dspId, driverId = rec.driverId;
  for (const [id, v] of Object.entries(rec.fields || {})) answers[id] = v;
  for (const [id, p] of Object.entries(rec.photos || {})) {
    const paths = [...(p.paths || [])];
    for (const blob of (p.blobs || [])) {
      const path = `${dspId || "no-dsp"}/checklists/${driverId || "anon"}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
      const { error } = await sb.storage.from("driver-documents").upload(path, blob, { contentType: blob.type || "image/jpeg", upsert: false });
      if (error) throw error;
      paths.push(path);
    }
    if (paths.length) answers[id] = { photos: paths };
  }
  for (const [id, s] of Object.entries(rec.signatures || {})) {
    if (s.existing) { answers[id] = { v: s.existing }; continue; }
    if (s.dataUrl) {
      const blob = _dataUrlToBlob(s.dataUrl);
      const path = `${dspId || "no-dsp"}/checklists/${driverId || "anon"}/sig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
      const { error } = await sb.storage.from("driver-documents").upload(path, blob, { contentType: "image/png", upsert: false });
      if (error) throw error;
      answers[id] = { v: path };
    }
  }
  return answers;
}

let _clkFlushing = false;
async function _clkFlushOutbox(opts = {}) {
  if (_clkFlushing) return 0;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return 0;
  _clkFlushing = true;
  let done = 0, dropped = 0;
  try {
    const recs = await _clkOutboxAll();
    for (const rec of recs) {
      try {
        const answers = await _clkReplayRecord(rec);
        const { error } = await sb.rpc("driver_submit_checklist", { p_token: rec.token, p_assignment_id: rec.assignmentId, p_answers: answers });
        if (error) {
          const msg = String(error.message || "");
          // Already handled server-side, or no longer submittable (template
          // changed) — drop so the queue can't get stuck on it.
          if (msg.startsWith("already_submitted") || msg.startsWith("missing_required") || msg.startsWith("assignment_not_found") || msg.startsWith("not_assigned") || msg.startsWith("checklist_not_active")) {
            await _clkOutboxDel(rec.id); dropped++; continue;
          }
          throw error;   // network/transient → stop and retry later
        }
        await _clkOutboxDel(rec.id); done++;
      } catch (_) {
        break;   // network failure — leave the rest queued
      }
    }
  } catch (_) { /* idb unavailable */ } finally { _clkFlushing = false; }
  if (done && !opts.silent) toast(`Submitted ${done} checklist${done === 1 ? "" : "s"} that ${done === 1 ? "was" : "were"} waiting`, "ok");
  if (dropped && !opts.silent) toast(`${dropped} queued checklist${dropped === 1 ? "" : "s"} couldn't be submitted and ${dropped === 1 ? "was" : "were"} discarded`, "warn");
  _clkPaintOutboxBanner();
  if (typeof refreshChecklistsBadge === "function") { try { refreshChecklistsBadge(); } catch (_) {} }
  return done;
}

// Paint the "waiting to send" banner wherever a host slot exists.
async function _clkPaintOutboxBanner() {
  const host = document.getElementById("rr-clk-outbox-banner");
  if (!host) return;
  const n = await _clkOutboxCount();
  if (!n) { host.innerHTML = ""; host.hidden = true; return; }
  host.hidden = false;
  const off = (typeof navigator !== "undefined" && navigator.onLine === false);
  host.innerHTML = `<div class="clk-banner clk-banner-due" style="display:flex;align-items:center;gap:10px;justify-content:space-between">
    <span>${n} checklist${n === 1 ? "" : "s"} waiting to send${off ? " — you're offline" : ""}.</span>
    <button type="button" class="btn btn-sm" data-rr-clk-outbox-retry ${off ? "disabled" : ""}>Send now</button>
  </div>`;
}

// Register connectivity + retry handlers once.
if (typeof window !== "undefined" && !window.__rrClkOutboxWired) {
  window.__rrClkOutboxWired = true;
  window.addEventListener("online", () => { _clkFlushOutbox(); });
  document.addEventListener("click", (e) => {
    if (e.target.closest?.("[data-rr-clk-outbox-retry]")) { e.preventDefault(); _clkFlushOutbox(); }
  });
}

async function renderChecklistFill() {
  const main = document.getElementById("main");
  main.innerHTML = `<div class="loader" style="margin:48px auto"></div>`;
  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }

  const id = routeQuery().get("id");
  if (!id) { navigate("/checklists"); return; }

  const { data: cl, error } = await sb.rpc("driver_get_checklist", { p_token: session.token, p_assignment_id: id });
  if (error || !cl) {
    main.innerHTML = errorStateHtml(error ? "Couldn't load this checklist" : "Checklist not found", error);
    return;
  }

  setHeader(cl.name || "Checklist", "");
  const items = Array.isArray(cl.items) ? cl.items : [];
  const answers = (cl.answers && typeof cl.answers === "object") ? cl.answers : {};
  const submitted = cl.submission?.status === "submitted";

  // ── Locked read-only view after submission ──
  if (submitted) {
    main.innerHTML = `
      <div class="form-fill-page">
        <div class="clk-banner clk-banner-done">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          <div><strong>Submitted</strong> · ${cl.submission.submitted_at ? new Date(cl.submission.submitted_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}<div class="clk-banner-sub">Answers are locked. Ask dispatch to reopen it if something needs a correction.</div></div>
        </div>
        ${cl.description ? `<div class="form-fill-desc">${escapeHtml(cl.description)}</div>` : ""}
        <div class="clk-readonly">
          ${items.map(it => `
            <div class="clk-ro-row">
              <div class="clk-ro-label">${escapeHtml(it.label || "Untitled item")}</div>
              <div class="clk-ro-val">${_clkAnswerDisplay(it, answers[it.id])}${answers[it.id]?.note ? `<div class="clk-helper">Note: ${escapeHtml(answers[it.id].note)}</div>` : ""}</div>
            </div>`).join("")}
        </div>
      </div>`;
    _clkEnhanceSignatures(main);
    return;
  }

  const dueLine = cl.due_at
    ? (new Date(cl.due_at) < new Date()
        ? `<div class="clk-banner clk-banner-overdue">Overdue — was due ${new Date(cl.due_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</div>`
        : `<div class="clk-banner clk-banner-due">Due by ${new Date(cl.due_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</div>`)
    : "";
  const reopened = cl.submission?.status === "reopened"
    ? `<div class="clk-banner clk-banner-due">Dispatch reopened this checklist — review your answers and resubmit.</div>` : "";

  main.innerHTML = `
    <div class="form-fill-page">
      <div id="rr-clk-outbox-banner" hidden></div>
      ${reopened}${dueLine}
      ${cl.description ? `<div class="form-fill-desc">${escapeHtml(cl.description)}</div>` : ""}
      <form id="rr-clk-fill">
        ${items.map(_clkItemHtml).join("")}
        <button class="btn btn-primary btn-block" type="submit" style="margin-top:18px">Submit checklist</button>
        <button class="btn btn-block" type="button" id="rr-clk-save" style="margin-top:10px">Save progress</button>
      </form>
    </div>`;

  const formEl = document.getElementById("rr-clk-fill");
  _clkPaintOutboxBanner();

  // Signature pads first (before restore paints saved ink back on).
  items.filter(i => i.item_type === "signature").forEach(i => {
    _initSignaturePad(`clk-sig-${i.id}`, `clk-sigclear-${i.id}`);
  });

  // Restore answers: server-saved progress first, then any local draft
  // (typed after the last "Save progress") wins on top.
  const DRAFT_KEY = `checklist:${id}`;
  const draft = getDraft(DRAFT_KEY);
  const restore = Object.assign({}, answers, (draft && typeof draft === "object") ? draft : {});
  _clkPhotos = {};   // fresh photo model per render
  let restoredAny = false;
  for (const item of items) {
    const ans = restore[item.id];
    if (!ans) continue;
    const el = formEl.querySelector(`[data-rr-clk="${CSS.escape(item.id)}"]`);
    if (!el) continue;
    const t = el.getAttribute("data-rr-clk-type");
    if (t === "checkbox") { el.checked = ans.v === true || ans.v === "true"; restoredAny = true; }
    else if (t === "yes_no") {
      el.querySelectorAll("input[type=radio]").forEach(r => { r.checked = String(r.value) === String(ans.v); });
      if (ans.v != null) restoredAny = true;
    } else if (t === "photo") {
      const photos = Array.isArray(ans.photos) ? ans.photos : [];
      if (photos.length) {
        _clkPhotos[item.id] = photos.map((p) => ({ path: p }));
        _clkRenderPhotoStrip(item.id);
        restoredAny = true;
      }
    } else if (t === "signature") {
      const v = ans.v;
      if (typeof v === "string" && v) {
        // Keep the stored value (storage path, or a legacy inline data URL)
        // as the existing answer; draw it for display without marking it as
        // new ink, so an untouched pad keeps the path instead of re-uploading.
        el.dataset.rrExistingSig = v;
        const draw = (srcUrl) => {
          const img = new Image();
          img.onload = () => {
            try {
              const ctx = el.getContext("2d");
              ctx.drawImage(img, 0, 0, el.clientWidth || el.width, el.clientHeight || 140);
            } catch (_) {}
          };
          img.src = srcUrl;
        };
        if (v.startsWith("data:image")) draw(v);
        else _clkSignedUrl(v).then((u) => { if (u) draw(u); });
        restoredAny = true;
      }
    } else {
      if ("value" in el) { el.value = ans.v ?? ""; if (ans.v) restoredAny = true; }
    }
  }
  if (restoredAny && draft) toast("Restored your in-progress answers", "ok");

  // Debounced local draft on any change (photos/signatures excluded —
  // they carry via dataset + server saves instead).
  let draftTimer = null;
  const saveLocal = () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(async () => {
      try { setDraft(DRAFT_KEY, await _clkCollect(items, { skipUploads: true })); } catch (_) {}
    }, 400);
  };
  formEl.addEventListener("input", saveLocal);
  formEl.addEventListener("change", saveLocal);

  // Photo picking: compress each selection and append to the item's model,
  // so multiple photos accumulate across taps (the input is cleared so the
  // same file can be re-picked). Thumbnails render immediately.
  formEl.addEventListener("change", async (e) => {
    const inp = e.target.closest?.('input[data-rr-clk-type="photo"]');
    if (!inp) return;
    const itemId = inp.getAttribute("data-rr-clk");
    const files = Array.from(inp.files || []);
    inp.value = "";
    if (!files.length) return;
    if (!_clkPhotos[itemId]) _clkPhotos[itemId] = [];
    for (const f of files) {
      const c = await _clkCompressPhoto(f);
      _clkPhotos[itemId].push({ file: c, url: URL.createObjectURL(c) });
    }
    _clkRenderPhotoStrip(itemId);
  });

  // Remove a photo (revoke its preview URL so we don't leak object URLs).
  formEl.addEventListener("click", (e) => {
    const del = e.target.closest?.("[data-rr-clk-photodel]");
    if (!del) return;
    e.preventDefault();
    const raw = del.getAttribute("data-rr-clk-photodel");
    const cut = raw.lastIndexOf("|");
    const itemId = raw.slice(0, cut), i = parseInt(raw.slice(cut + 1), 10);
    const list = _clkPhotos[itemId];
    if (!list || !list[i]) return;
    if (list[i].url) { try { URL.revokeObjectURL(list[i].url); } catch (_) {} }
    list.splice(i, 1);
    _clkRenderPhotoStrip(itemId);
  });

  // Save progress → server, so dispatch sees "In progress". Photos are
  // uploaded here too (skipUploads used to drop a freshly-snapped photo
  // on Save — it only persisted on final Submit, so Save→leave lost it).
  document.getElementById("rr-clk-save")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      const cur = await _clkCollect(items);
      const { error: saveErr } = await sb.rpc("driver_save_checklist", {
        p_token: session.token, p_assignment_id: id, p_answers: cur,
      });
      if (saveErr) throw saveErr;
      setDraft(DRAFT_KEY, cur);
      toast("Progress saved", "ok");
    } catch (err) {
      toast(err?.rrUploadFailed
        ? "A photo didn't upload — check your signal and tap Save again."
        : _friendlyError(err, "Couldn't save progress — it's still on this phone."), "warn");
    } finally {
      btn.disabled = false; btn.textContent = "Save progress";
    }
  });

  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    const resetBtn = () => { if (btn) { btn.disabled = false; btn.textContent = "Submit checklist"; } };
    if (btn) { btn.disabled = true; btn.textContent = "Submitting…"; }

    // Validate required from the raw capture first, so an offline submit
    // still enforces them without needing to upload anything.
    const raw = _clkCaptureRaw(items);
    for (const item of items) {
      if (item.required && _clkRawEmpty(item, raw)) {
        toast(`"${item.label || "Untitled item"}" is required`, "warn");
        resetBtn();
        return;
      }
    }

    // Queue the raw submission to IndexedDB and let the outbox replay it.
    const queueOffline = async () => {
      const rec = {
        id: `${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        token: session.token, assignmentId: id,
        dspId: session?.dsp_id || null, driverId: session?.driver_id || null,
        name: cl.name || "Checklist", fields: raw.fields, photos: raw.photos,
        signatures: raw.signatures, createdAt: Date.now(),
      };
      try {
        await _clkOutboxAdd(rec);
        clearDraft(DRAFT_KEY);
        _haptic("success");
        toast("No connection — saved. It'll submit automatically when you're back online.", "ok");
        navigate("/checklists");
        return true;
      } catch (_) {
        toast("Couldn't save offline — your answers are still on this phone.", "warn");
        resetBtn();
        return false;
      }
    };

    // Obviously offline → don't even try the uploads that will fail.
    if (typeof navigator !== "undefined" && navigator.onLine === false) { await queueOffline(); return; }

    if (btn) btn.textContent = "Uploading…";
    let cur;
    try {
      cur = await _clkCollect(items);
    } catch (err) {
      // An upload blip mid-submit (dropped signal) → queue rather than lose it.
      if (err?.rrUploadFailed) { await queueOffline(); return; }
      resetBtn();
      toast(_friendlyError(err, "Couldn't upload — try again."), "warn");
      return;
    }

    if (btn) btn.textContent = "Submitting…";
    let subErr;
    try {
      ({ error: subErr } = await sb.rpc("driver_submit_checklist", {
        p_token: session.token, p_assignment_id: id, p_answers: cur,
      }));
    } catch (netErr) {
      await queueOffline();   // network threw → queue
      return;
    }
    if (subErr) {
      const msg = String(subErr.message || "");
      if (msg.startsWith("missing_required:")) {
        toast(`"${msg.slice("missing_required:".length)}" is required`, "warn");
        resetBtn();
        return;
      }
      if (msg.startsWith("already_submitted")) {
        clearDraft(DRAFT_KEY); toast("Already submitted", "ok"); navigate("/checklists"); return;
      }
      if (_clkIsNetworkErr(subErr)) { await queueOffline(); return; }
      resetBtn();
      toast(_friendlyError(subErr, "Couldn't submit. Your answers are still here — try again."), "warn");
      return;
    }
    clearDraft(DRAFT_KEY);
    _haptic("success");
    toast("Checklist submitted", "ok");
    navigate("/checklists");
  });
}

// A best-effort "does this look like a connectivity failure?" check so we
// queue on network errors but surface real server errors.
function _clkIsNetworkErr(err) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  const m = String(err?.message || err || "").toLowerCase();
  return /failed to fetch|networkerror|network error|load failed|fetch failed|timeout|timed out/.test(m);
}


// ── Coaching feed ───────────────────────────────────────────────────
//
// Single unified feed of every coaching the dispatcher has sent to
// this driver, regardless of category (attendance / safety / quality
// / other).  Tap a row to open the detail screen, where the driver
// completes the required action (acknowledgment, signature, or
// both).  Once cleared, the row stays visible (so the driver can
// scroll back through their history) but is marked Acknowledged.
const _COACHING_LABELS = {
  topic: { attendance: "Attendance", safety: "Safety", quality: "Quality", performance: "Performance",
           behavior: "Behavior", recognition: "Recognition", scorecard: "Scorecard",
           conduct: "Conduct", theft: "Theft", other: "Other" },
  severity: { note: "Note", info: "Note", verbal: "Verbal", concern: "Verbal",
              written: "Written", warning: "Written", final: "Final", termination: "Termination" },
};
// Attendance coachings (topic = 'attendance', manual or auto) read
// "Verbal-Attendance" etc.; other accountability stays plain. The specific
// infraction (No Call/No Show, Call-Out, Late) rides in the coaching summary.
const _coachSevLabel = (c) => {
  const base = _COACHING_LABELS.severity[c.severity] || c.severity;
  return c && c.topic === "attendance" ? `${base}-Attendance` : base;
};

async function renderCoachingFeed() {
  const main = document.getElementById("main");
  main.innerHTML = `<div class="loader" style="margin:48px auto"></div>`;
  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }

  const { data, error } = await sb.rpc("driver_list_coachings", { p_token: session.token });
  if (error) {
    main.innerHTML = errorStateHtml("Couldn't load coaching", error);
    return;
  }
  const list = Array.isArray(data) ? data : [];
  if (list.length === 0) {
    main.innerHTML = `<div class="empty-state">No coaching from your dispatcher yet.</div>`;
    return;
  }

  // Cache the list so the detail screen has it without re-fetching.
  window._rrCoachings = list;

  main.innerHTML = `<div class="coaching-feed">${list.map(_coachingRowHtml).join("")}</div>`;
  main.querySelectorAll("[data-rr-coaching]").forEach(el => {
    el.addEventListener("click", () => navigate(`/tasks/coaching/one?id=${encodeURIComponent(el.dataset.rrCoaching)}`));
  });
}

function _coachingRowHtml(c) {
  const topic    = _COACHING_LABELS.topic[c.topic] || c.topic;
  const severity = _coachSevLabel(c);
  const date     = c.occurred_at ? new Date(c.occurred_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
  const needsAction = c.delivery_required && c.delivery_required !== "none" && !c.acknowledged_at;
  const cls = `coaching-row${needsAction ? " coaching-row-pending" : ""}`;
  const status = needsAction
    ? `<span class="coaching-status pending">Action needed</span>`
    : (c.acknowledged_at
        ? `<span class="coaching-status done">Acknowledged</span>`
        : `<span class="coaching-status">Note</span>`);
  return `
    <div class="${cls}" data-rr-coaching="${escapeHtml(c.id)}">
      <div class="coaching-row-head">
        <span class="coaching-badge cat-${escapeHtml(c.topic || "other")}">${escapeHtml(topic)}</span>
        <span class="coaching-badge sev-${escapeHtml(c.severity || "note")}">${escapeHtml(severity)}</span>
        <span class="coaching-row-date">${escapeHtml(date)}</span>
      </div>
      <div class="coaching-row-summary">${escapeHtml(c.summary || c.notes || "Coaching from your dispatcher")}</div>
      <div class="coaching-row-foot">
        <span class="coaching-row-by">${escapeHtml(c.coached_by_name || "Dispatcher")}</span>
        ${status}
      </div>
    </div>`;
}

async function renderCoachingDetail() {
  const main = document.getElementById("main");
  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }

  const id = routeQuery().get("id");
  if (!id) { navigate("/tasks/coaching"); return; }

  // Try the cached list first (fast back-and-forth from feed → detail).
  let coaching = (window._rrCoachings || []).find(c => c.id === id);
  if (!coaching) {
    main.innerHTML = `<div class="loader" style="margin:48px auto"></div>`;
    const { data, error } = await sb.rpc("driver_list_coachings", { p_token: session.token });
    if (error) { main.innerHTML = errorStateHtml("Couldn't open this", error); return; }
    coaching = (data || []).find(c => c.id === id);
    window._rrCoachings = data || [];
  }
  if (!coaching) { navigate("/tasks/coaching"); return; }

  const topic    = _COACHING_LABELS.topic[coaching.topic] || coaching.topic;
  const severity = _coachSevLabel(coaching);
  const date     = coaching.occurred_at ? new Date(coaching.occurred_at).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";

  const needsAck  = coaching.delivery_required === "ack" || coaching.delivery_required === "ack_and_sign";
  const needsSign = coaching.delivery_required === "sign" || coaching.delivery_required === "ack_and_sign";
  const cleared   = !!coaching.acknowledged_at;

  // Cleared rows don't normally reach this view because the server
  // filters them out of driver_list_coachings.  Defensive fallback
  // only — instantly bounce back if we somehow have one cached.
  let footHtml = "";
  if (cleared) {
    setTimeout(() => navigate("/tasks/coaching"), 0);
    footHtml = "";
  } else if (coaching.delivery_required === "none") {
    // Read-only coachings still need an active dismiss tap so the
    // driver clears them and they disappear permanently.
    footHtml = `
      <button type="button" class="btn btn-primary btn-block" id="rr-coach-ack" style="margin-top:14px">Got it</button>`;
  } else {
    footHtml = `
      ${needsSign ? `
        <div class="coaching-sign-section">
          <div class="coaching-sign-label">Sign with your finger or stylus</div>
          <canvas id="rr-coach-sigpad" class="coaching-sigpad" width="600" height="180"></canvas>
          <button type="button" class="btn btn-ghost btn-sm" id="rr-coach-sig-clear" style="margin-top:6px">Clear</button>
        </div>` : ""}
      <button type="button" class="btn btn-primary btn-block" id="rr-coach-ack" style="margin-top:14px">
        ${needsSign && needsAck ? "Sign &amp; Acknowledge" : (needsSign ? "Sign" : "I understand")}
      </button>`;
  }

  main.innerHTML = `
    <div class="coaching-detail">
      <div class="coaching-detail-head">
        <span class="coaching-badge cat-${escapeHtml(coaching.topic || "other")}">${escapeHtml(topic)}</span>
        <span class="coaching-badge sev-${escapeHtml(coaching.severity || "note")}">${escapeHtml(severity)}</span>
      </div>
      <div class="coaching-detail-meta">${escapeHtml(date)} · from ${escapeHtml(coaching.coached_by_name || "Dispatcher")}</div>
      ${coaching.summary ? `<div class="coaching-detail-summary">${escapeHtml(coaching.summary)}</div>` : ""}
      ${coaching.notes   ? `<div class="coaching-detail-notes">${escapeHtml(coaching.notes)}</div>` : ""}
      <div class="coaching-detail-foot">${footHtml}</div>
    </div>`;

  if (needsSign && !cleared) {
    _initSignaturePad("rr-coach-sigpad", "rr-coach-sig-clear");
  }
  const ackBtn = document.getElementById("rr-coach-ack");
  if (ackBtn) {
    ackBtn.addEventListener("click", () => _submitCoachingAck(coaching, needsSign));
  }
}

async function _submitCoachingAck(coaching, needsSign) {
  const session = readSession();
  const ackBtn = document.getElementById("rr-coach-ack");
  let signature = null;
  if (needsSign) {
    const canvas = document.getElementById("rr-coach-sigpad");
    if (!canvas || !canvas._rrHasInk) { toast("Please sign first", "warn"); return; }
    signature = canvas.toDataURL("image/png");
  }
  if (ackBtn) { ackBtn.disabled = true; ackBtn.textContent = "Saving…"; }
  const { error } = await sb.rpc("driver_ack_coaching", {
    p_token: session.token,
    p_coaching_id: coaching.id,
    p_signature_b64: signature,
  });
  if (error) {
    if (ackBtn) { ackBtn.disabled = false; ackBtn.textContent = needsSign ? "Sign & Acknowledge" : "I understand"; }
    toast(_friendlyError(error, "Couldn't save your acknowledgement. Try again."), "warn");
    return;
  }
  // Drop the cached list so the next feed load is fresh.
  window._rrCoachings = null;
  toast("Acknowledged", "ok");
  // Update the Forms tab badge now that one coaching is cleared.
  if (typeof refreshFormsBadge === "function") refreshFormsBadge();
  navigate("/tasks/coaching");
}

// Lightweight canvas signature pad.  Tracks both pointer and touch
// events for cross-platform support; sets canvas._rrHasInk = true
// when the user has drawn at least one stroke so the submit handler
// can validate.
function _initSignaturePad(canvasId, clearBtnId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  // High-DPI: scale the backing buffer to match the visual size.
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  canvas.width = cssW * ratio; canvas.height = cssH * ratio;
  ctx.scale(ratio, ratio);
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.strokeStyle = "#111827";
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, cssW, cssH);
  canvas._rrHasInk = false;

  let drawing = false;
  const pos = (e) => {
    const rect = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  };
  const start = (e) => { drawing = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault(); };
  const move  = (e) => { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); canvas._rrHasInk = true; e.preventDefault(); };
  const end   = (e) => { drawing = false; e.preventDefault?.(); };

  canvas.addEventListener("mousedown", start);
  canvas.addEventListener("mousemove", move);
  canvas.addEventListener("mouseup",   end);
  canvas.addEventListener("mouseleave", end);
  canvas.addEventListener("touchstart", start, { passive: false });
  canvas.addEventListener("touchmove",  move,  { passive: false });
  canvas.addEventListener("touchend",   end);

  const clearBtn = document.getElementById(clearBtnId);
  if (clearBtn) clearBtn.addEventListener("click", () => {
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, cssW, cssH);
    canvas._rrHasInk = false;
    // Clearing also drops any restored signature so "clear + submit" means
    // no signature, rather than silently keeping the old one.
    delete canvas.dataset.rrExistingSig;
  });
}

// ── Check-in / check-out / report missed day on the Profile page ─────
//
// One card, three states:
//   1. Before window: "Opens 9:45 AM · check in · report missed day"
//   2. In window, not checked in: same buttons, but Check in is enabled
//   3. Checked in: "Checked in · 8:42 AM" + "Check out" button
// Every action goes through confirm() so a stray tap doesn't fire it.
let _checkinCountdownTimer = null;
function _stopCheckinCountdown() {
  if (_checkinCountdownTimer) { clearInterval(_checkinCountdownTimer); _checkinCountdownTimer = null; }
}
function _startCheckinCountdown(targetMs) {
  _stopCheckinCountdown();
  const tick = () => {
    const el = document.getElementById("rr-checkin-countdown");
    if (!el) { _stopCheckinCountdown(); return; }
    const valueEl = el.querySelector(".opens-card-countdown-value");
    const txt = _countdownText(targetMs);
    if (!txt) {
      el.hidden = true;
      _stopCheckinCountdown();
      return;
    }
    if (valueEl) valueEl.textContent = txt;
  };
  tick();
  _checkinCountdownTimer = setInterval(tick, 30 * 1000);
}

async function renderCheckinCard(session) {
  const slot = document.getElementById("rr-checkin-slot");
  const missedSlot = document.getElementById("rr-missed-slot");
  if (!slot) return;
  _stopCheckinCountdown();
  // Helper: render the "Report missed day" row into its own slot.
  // Hidden by default; only the states where a missed-day makes sense
  // turn it on (pre-checkin window-not-open / no-geofence).
  const showMissed = (visible) => {
    if (!missedSlot) return;
    missedSlot.hidden = !visible;
    if (!visible) { missedSlot.innerHTML = ""; return; }
    missedSlot.innerHTML = `
      <button class="missed-day-card" id="rr-missed-btn" type="button">
        <span class="missed-day-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
        </span>
        <div class="missed-day-body">
          <div class="missed-day-title">Report missed day</div>
          <div class="missed-day-sub">Let dispatch know if you can't make it</div>
        </div>
        <span class="missed-day-chev" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </span>
      </button>`;
    document.getElementById("rr-missed-btn").addEventListener("click", () => doMissedDay(session));
  };

  if (!session?.token) { slot.innerHTML = ""; showMissed(false); return; }

  let status;
  try {
    const { data, error } = await sb.rpc("driver_checkin_status", { p_token: session.token });
    if (error) throw error;
    status = data;
  } catch (err) {
    slot.innerHTML = `
      <div class="opens-card opens-card-warn">
        <div class="opens-card-row">
          <div class="opens-card-icon">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          </div>
          <div class="opens-card-body">
            <div class="opens-card-title" style="font-size:18px">Couldn't load shift</div>
            <div class="opens-card-meta">${escapeHtml(_friendlyError(err, "Pull down to retry."))}</div>
          </div>
        </div>
      </div>`;
    showMissed(false);
    return;
  }

  const shift = status?.shift;
  // Mirror station + on-duty state into the home-hero subtitle / pill.
  const metaEl = document.getElementById("rr-home-meta");
  const dutyEl = document.getElementById("rr-home-status");
  if (metaEl) {
    const stn = shift?.station_code;
    metaEl.textContent = stn ? `Driver · ${stn}` : "Driver";
  }
  if (dutyEl) {
    const onDuty = !!(status?.checkin?.checked_in_at && !status?.checkin?.checked_out_at);
    dutyEl.hidden = !onDuty;
  }

  // Reusable bits for the "Opens at" surface.
  const clockIcon = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
  const checkIcon = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  const card = (cls, icon, title, meta, extra = "") => `
    <div class="opens-card ${cls}">
      <div class="opens-card-row">
        <div class="opens-card-icon">${icon}</div>
        <div class="opens-card-body">
          <div class="opens-card-title">${title}</div>
          ${meta ? `<div class="opens-card-meta">${meta}</div>` : ""}
        </div>
      </div>
      ${extra}
    </div>`;

  if (!shift) {
    slot.innerHTML = card("opens-card-muted", clockIcon, "No shift today", "Enjoy your day off.");
    showMissed(false);
    return;
  }

  const startsAtTxt = shift.starts_at
    ? new Date(shift.starts_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : "—";
  const stationCode = shift.station_code || "—";
  const windowOpenTxt = shift.window_open_at
    ? new Date(shift.window_open_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : "—";

  const hasReportLead = shift.report_lead_minutes > 0
    && shift.wave_starts_at
    && new Date(shift.wave_starts_at).getTime() !== new Date(shift.starts_at).getTime();
  const waveTxt = hasReportLead
    ? new Date(shift.wave_starts_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : "";
  const startWithWave = hasReportLead
    ? `${startsAtTxt} · Wave ${waveTxt}`
    : startsAtTxt;
  const detailMeta = `${escapeHtml(stationCode)} · ${escapeHtml(startWithWave)}`;

  const chk = status?.checkin;

  // Already missed-day reported.
  if (chk?.missed_reported_at && !chk?.checked_in_at) {
    const t = new Date(chk.missed_reported_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    slot.innerHTML = card("opens-card-warn", clockIcon,
      `Reported missed day · ${escapeHtml(t)}`,
      chk.missed_reason ? escapeHtml(chk.missed_reason) : "Your dispatcher has been notified.");
    showMissed(false);
    return;
  }

  // Already checked in — show check-out CTA (or already checked out).
  if (chk?.checked_in_at) {
    const inT  = new Date(chk.checked_in_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (chk.checked_out_at) {
      const outT = new Date(chk.checked_out_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      slot.innerHTML = card("opens-card-ok", checkIcon,
        `Shift complete · ${escapeHtml(outT)}`,
        `In ${escapeHtml(inT)} · out ${escapeHtml(outT)}`,
        `<button class="opens-card-cta" id="rr-undo-checkout" type="button">Undo check-out</button>`);
      document.getElementById("rr-undo-checkout").addEventListener("click", () => doUndoCheckout(session));
      showMissed(false);
      return;
    }
    slot.innerHTML = card("opens-card-ok", checkIcon,
      `Checked in · ${escapeHtml(inT)}`,
      escapeHtml(stationCode),
      `<button class="opens-card-cta" id="rr-checkout-btn" type="button">Check out</button>`);
    document.getElementById("rr-checkout-btn").addEventListener("click", () => doCheckout(session));
    showMissed(false);
    return;
  }

  // Not checked in. Show check-in (gated by window) + missed-day below.
  if (!shift.has_geofence) {
    slot.innerHTML = card("opens-card-muted", clockIcon,
      "Check-in unavailable",
      `Geofence isn't set for ${escapeHtml(stationCode)}.`);
    showMissed(true);
    return;
  }

  // "STARTS IN 45m" — counts down to shift start so the driver knows
  // how long they've got. Initial value is rendered server-side from
  // the markup below; _startCheckinCountdown refreshes it on a 30s
  // interval and self-clears once the start time has passed.
  const startsAtMs = shift.starts_at ? new Date(shift.starts_at).getTime() : NaN;
  const initialCountdown = Number.isFinite(startsAtMs) ? _countdownText(startsAtMs) : null;
  const countdownHtml = initialCountdown
    ? `<div class="opens-card-countdown" id="rr-checkin-countdown">
         <div class="opens-card-countdown-label">Starts in</div>
         <div class="opens-card-countdown-value">${escapeHtml(initialCountdown)}</div>
       </div>`
    : "";

  const windowOpen   = !!status.window_is_open;
  const nowMs        = Date.now();
  const closeAtMs    = shift.window_close_at ? new Date(shift.window_close_at).getTime() : NaN;
  const windowClosed = !windowOpen && Number.isFinite(closeAtMs) && nowMs > closeAtMs;
  const noStartTime  = !shift.starts_at;
  const windowCloseTxt = shift.window_close_at
    ? new Date(shift.window_close_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : "—";

  if (noStartTime) {
    slot.innerHTML = `
      <div class="opens-card opens-card-warn" aria-disabled="true">
        <div class="opens-card-row">
          <div class="opens-card-icon">${clockIcon}</div>
          <div class="opens-card-body">
            <div class="opens-card-title">Check-in unavailable</div>
            <div class="opens-card-meta">No scheduled start time on this shift yet — contact dispatch.</div>
          </div>
        </div>
      </div>`;
    showMissed(true);
    return;
  }

  if (windowOpen) {
    slot.innerHTML = `
      <button class="opens-card" id="rr-checkin-btn" type="button">
        <div class="opens-card-row">
          <div class="opens-card-icon">${checkIcon}</div>
          <div class="opens-card-body">
            <div class="opens-card-title">Check in</div>
            <div class="opens-card-meta">${detailMeta}</div>
          </div>
          ${countdownHtml}
        </div>
      </button>`;
    document.getElementById("rr-checkin-btn").addEventListener("click", () => doCheckin(session));
  } else if (windowClosed) {
    slot.innerHTML = `
      <div class="opens-card opens-card-warn" aria-disabled="true">
        <div class="opens-card-row">
          <div class="opens-card-icon">${clockIcon}</div>
          <div class="opens-card-body">
            <div class="opens-card-title">Check-in closed at ${escapeHtml(windowCloseTxt)}</div>
            <div class="opens-card-meta">If you still need to start your shift, contact dispatch.</div>
          </div>
        </div>
      </div>`;
  } else {
    slot.innerHTML = `
      <div class="opens-card" aria-disabled="true">
        <div class="opens-card-row">
          <div class="opens-card-icon">${clockIcon}</div>
          <div class="opens-card-body">
            <div class="opens-card-title">Opens at ${escapeHtml(windowOpenTxt)}</div>
            <div class="opens-card-meta">${detailMeta}</div>
          </div>
          ${countdownHtml}
        </div>
      </div>`;
  }
  if (initialCountdown) _startCheckinCountdown(startsAtMs);
  showMissed(true);
}

async function doCheckin(session) {
  const ok = await confirmSheet({
    title: "Check in now?",
    message: "We'll confirm you're at the station and log your start time.",
    confirmText: "Check in",
  });
  if (!ok) return;
  _haptic("tap");
  // Tap target is on the hero CTA in /profile or on the check-in card
  // on /profile — both share the same id wired in their respective
  // renderers.
  const btn = document.getElementById("rr-checkin-btn") || document.getElementById("rr-hero-cta");
  if (!btn) return;
  if (!("geolocation" in navigator)) { toast("This device can't share location", "warn"); _haptic("warn"); return; }
  btn.disabled = true;
  const orig = btn.innerHTML;
  btn.innerHTML = "Locating…";

  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    btn.innerHTML = "Checking in…";
    const { data, error } = await sb.rpc("driver_checkin", {
      p_token:    session.token,
      p_lat:      lat,
      p_lng:      lng,
      p_accuracy: Math.round(accuracy || 0),
    });
    btn.disabled = false;
    btn.innerHTML = orig;
    if (error) {
      _haptic("warn");
      const msg = error.message || "";
      if      (msg.includes("out_of_geofence"))         toast(msg.replace(/^.*out_of_geofence:\s*/, "Too far from station: "), "warn");
      else if (msg.includes("too_early_to_checkin"))    toast(msg.replace(/^.*too_early_to_checkin:\s*/, ""), "warn");
      else if (msg.includes("too_late_to_checkin"))     toast("Check-in window has closed. Contact dispatch if you still need to start your shift.", "warn");
      else if (msg.includes("no_checkin_window"))       toast("Your shift doesn't have a scheduled start time yet. Contact dispatch.", "warn");
      else if (msg.includes("no_shift_today"))          toast("No shift scheduled today", "warn");
      else if (msg.includes("geofence_not_configured")) toast("Dispatcher hasn't set the geofence yet", "warn");
      else                                              toast(_friendlyError(error, "Check-in didn't go through. Try again."), "warn");
      return;
    }
    _haptic("strong");
    toast(data?.already_checked_in ? "Already checked in" : "Checked in ✓", "ok");
    renderCheckinCard(session);
  }, (err) => {
    btn.disabled = false;
    btn.innerHTML = orig;
    _haptic("warn");
    if (err.code === err.PERMISSION_DENIED) toast("Allow location to check in", "warn");
    else toast("Couldn't get your location. Move outside and try again.", "warn");
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
}

async function doCheckout(session) {
  const ok = await confirmSheet({
    title: "Check out?",
    message: "This ends your shift in RouteReady. You can undo within a few minutes.",
    confirmText: "Check out",
  });
  if (!ok) return;
  _haptic("tap");
  const btn = document.getElementById("rr-checkout-btn");
  if (btn) btn.disabled = true;
  // Geolocation is best-effort on check-out; we don't gate.
  const submit = async (lat, lng) => {
    const { error } = await sb.rpc("driver_checkout", {
      p_token: session.token, p_lat: lat ?? null, p_lng: lng ?? null,
    });
    if (btn) btn.disabled = false;
    if (error) { _haptic("warn"); toast(_friendlyError(error, "Couldn't check out. You're still on the clock — try again."), "warn"); return; }
    _haptic("strong");
    toast("Checked out ✓", "ok");
    renderCheckinCard(session);
  };
  if (!("geolocation" in navigator)) { submit(); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => submit(pos.coords.latitude, pos.coords.longitude),
    () => submit(),
    { enableHighAccuracy: false, timeout: 5000, maximumAge: 30000 },
  );
}

async function doUndoCheckout(session) {
  const ok = await confirmSheet({
    title: "Undo check-out?",
    message: "Your check-out time will be cleared and your shift goes back to active.",
    confirmText: "Undo",
  });
  if (!ok) return;
  const { error } = await sb.rpc("driver_undo_checkout", { p_token: session.token });
  if (error) {
    if ((error.message || "").includes("day_finalized")) {
      toast("Day already approved — contact dispatch", "warn");
    } else if ((error.message || "").includes("no_checkout_to_undo")) {
      toast("Nothing to undo", "warn");
    } else {
      toast(_friendlyError(error, "Couldn't undo. Try again."), "warn");
    }
    return;
  }
  toast("Check-out undone", "ok");
  renderCheckinCard(session);
}

async function doMissedDay(session) {
  const answer = await promptSheet({
    title: "Report today as missed?",
    message: "Dispatch will be notified right away.",
    placeholder: "Optional reason for dispatch",
    confirmText: "Report missed day",
    cancelText: "Cancel",
    danger: true,
  });
  if (!answer) return; // cancelled
  const { error } = await sb.rpc("driver_report_missed_day", {
    p_token: session.token,
    p_reason: answer.text,
  });
  if (error) {
    if ((error.message || "").includes("already_checked_in")) {
      toast("You're already checked in", "warn");
    } else if ((error.message || "").includes("no_shift_today")) {
      toast("No shift scheduled today", "warn");
    } else {
      toast(_friendlyError(error, "Couldn't report. Try again or message dispatch."), "warn");
    }
    return;
  }
  toast("Reported · dispatch has been notified", "ok");
  renderCheckinCard(session);
}

async function uploadDriverPhoto(file) {
  const session = readSession();
  if (!session?.token) return;
  toast("Uploading…");
  const fd = new FormData();
  fd.append("token", session.token);
  fd.append("photo", file);
  let url = `${cfg.SUPABASE_URL}/functions/v1/upload-driver-photo`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        // Supabase routes through its own auth gateway; the anon key
        // satisfies the JWT requirement, the function does its own
        // token verification.
        "Authorization": "Bearer " + cfg.SUPABASE_ANON_KEY,
        "apikey":        cfg.SUPABASE_ANON_KEY,
      },
      body: fd,
    });
    const json = await res.json().catch(() => ({}));
    // Success is keyed on photo_path (bucket is private now; photo_url is a
    // signed URL that may be null if the edge-side sign hiccupped — driver_me
    // will re-sign within a minute either way).
    if (!res.ok || !json?.photo_path) {
      toast(_friendlyError(json?.error, "Couldn't upload your photo. Try a smaller image."), "warn");
      return;
    }
    writeSession({ ...session, photo_url: json.photo_url || null, photo_path: json.photo_path });
    toast("Photo updated", "ok");
    render(); // re-render so header chip + profile avatar pick up the new URL
  } catch (err) {
    toast(_friendlyError(err, "Couldn't upload your photo. Try a smaller image."), "warn");
  }
}

// ── Availability ────────────────────────────────────────────────────
const _AVAIL_DAYS = [
  { k: "mon", label: "Mon", fullLabel: "Monday" },
  { k: "tue", label: "Tue", fullLabel: "Tuesday" },
  { k: "wed", label: "Wed", fullLabel: "Wednesday" },
  { k: "thu", label: "Thu", fullLabel: "Thursday" },
  { k: "fri", label: "Fri", fullLabel: "Friday" },
  { k: "sat", label: "Sat", fullLabel: "Saturday" },
  { k: "sun", label: "Sun", fullLabel: "Sunday" },
];

// While the availability page is mounted, keep it in sync with the
// server.  The driver might have the page open when the dispatcher
// approves their request elsewhere; without a live signal we'd
// keep showing the "pending review" banner forever.  Two triggers:
//   1. visibilitychange · re-fetch when the PWA comes back to the
//      foreground (user switched apps, locked / unlocked, etc.)
//   2. polling · re-fetch every 30s while the page is mounted
let _availPollTimer = null;
let _availVisHandler = null;
function _availStopAutoRefresh() {
  if (_availPollTimer) { clearInterval(_availPollTimer); _availPollTimer = null; }
  if (_availVisHandler) { document.removeEventListener("visibilitychange", _availVisHandler); _availVisHandler = null; }
}
function _availStartAutoRefresh() {
  _availStopAutoRefresh();
  _availVisHandler = () => {
    // Only re-render if we're STILL on the availability page when
    // visibility flips back.  A different page may have mounted
    // since (the user navigated away).
    if (document.visibilityState === "visible" && document.getElementById("avail-list")) {
      renderAvailability();
    }
  };
  document.addEventListener("visibilitychange", _availVisHandler);

  _availPollTimer = setInterval(() => {
    // Same guard — only poll if the availability page is still mounted.
    if (document.getElementById("avail-list")) renderAvailability();
    else _availStopAutoRefresh();
  }, 30000);
}

// Earliest-start picker: "Any" + 4:00 AM → 2:00 PM in 30-min steps.
const _AVAIL_START_RE = /^(0[4-9]|1[0-4]):(00|30)$/;
function _availStartChoices() {
  const out = [];
  for (let m = 4 * 60; m <= 14 * 60; m += 30) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    out.push(`${hh}:${mm}`);
  }
  return out;
}

async function renderAvailability() {
  const main = document.getElementById("main");
  main.innerHTML = `<div class="loader"></div>`;

  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }
  if (!driverFeatureOn("availability")) { main.innerHTML = _featureOffHtml("Availability"); return; }

  const { data, error } = await sb.rpc("driver_get_availability", { p_token: session.token });
  if (error) {
    if (/unauthorized|revoked|inactive/i.test(error.message || "")) {
      writeSession(null); toast("Signed out — please sign in again", "warn"); render(); return;
    }
    main.innerHTML = errorStateHtml("Couldn't load availability", error);
    return;
  }

  const liveDays    = new Set(Array.isArray(data?.days) ? data.days : []);
  const pendingDays = data?.pending?.days ? new Set(data.pending.days) : null;
  const picked      = new Set(pendingDays || liveDays);

  const hasPending = !!data?.pending;
  const blackout   = data?.blackout || null;
  const leadDays   = Number(data?.lead_days ?? 7);

  // Lock the request form when there's a blackout OR a pending request
  // waiting for approval. (Preferred days below stay editable — they're
  // a free preference, not part of the approval workflow.)
  const locked = !!blackout || hasPending;
  // First-time / onboarding: no approved availability yet and able to submit.
  // In this state the driver picks preferred days from the days they're
  // CHOOSING (not yet approved), and both save together on submit — a new
  // driver's submission auto-approves, so the preferred subset validates.
  const firstTime = liveDays.size === 0 && !blackout && !hasPending;

  // Earliest start is carried on the request, so the form shows the
  // pending request's value if there is one, else the approved value.
  const liveStart    = (typeof data?.earliest_start === "string" && data.earliest_start) || "";
  const pendingStart = (data?.pending && typeof data.pending.earliest_start === "string" && data.pending.earliest_start) || "";
  const pickedStart  = hasPending ? pendingStart : liveStart;

  // Preferred days — only days inside the currently approved availability
  // (liveDays) can be on; anything else is shown disabled.
  const prefSet = new Set((Array.isArray(data?.preferred_days) ? data.preferred_days : []).filter((k) => liveDays.has(k)));

  const rowsHtml = _AVAIL_DAYS.map((d) => {
    const on = picked.has(d.k);
    return `
      <label class="avail-day" for="avail-tog-${d.k}" ${locked ? `style="opacity:.55;pointer-events:none"` : ""}>
        <span class="avail-day-name">${escapeHtml(d.fullLabel)}</span>
        <span class="avail-toggle ${on ? "on" : ""}">
          <input type="checkbox" id="avail-tog-${d.k}" data-rr-day="${d.k}" ${on ? "checked" : ""} ${locked ? "disabled" : ""}/>
          <span class="avail-toggle-track"><span class="avail-toggle-thumb"></span></span>
        </span>
      </label>`;
  }).join("");

  const startOpts = [`<option value=""${pickedStart ? "" : " selected"}>Any start time</option>`];
  if (pickedStart && !_AVAIL_START_RE.test(pickedStart)) {
    startOpts.push(`<option value="${escapeHtml(pickedStart)}" selected>${escapeHtml(_fmtTime12(pickedStart) || pickedStart)}</option>`);
  }
  for (const v of _availStartChoices()) {
    startOpts.push(`<option value="${v}"${v === pickedStart ? " selected" : ""}>${escapeHtml(_fmtTime12(v))}</option>`);
  }

  const startBlock = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:12px;margin-top:14px${locked ? ";opacity:.55;pointer-events:none" : ""}">
      <div>
        <div style="font-weight:600">Earliest you can start</div>
        <div style="font-size:var(--fs-sm);color:var(--text-muted);margin-top:2px">Shifts run up to ~10 hours from this time.</div>
      </div>
      <select id="avail-start" ${locked ? "disabled" : ""} style="font:inherit;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--canvas);color:var(--text)">${startOpts.join("")}</select>
    </div>`;

  const policyText = leadDays > 0
    ? `Day or start-time changes take effect <b>${leadDays} day${leadDays === 1 ? "" : "s"}</b> after approval, for 3 weeks.`
    : `Day or start-time changes take effect immediately on approval, for 3 weeks.`;

  // Banner states, in priority order:
  //   1. blackout — can't submit
  //   2. pending  — submitted, awaiting dispatcher decision
  //   3. approved-pending-effective — dispatcher approved, but the
  //      change doesn't take effect until the effective date.
  const lastDec = data?.last_decision || null;
  const todayIso = new Date().toISOString().slice(0, 10);
  const approvedNotYetEffective = lastDec
    && lastDec.status === "approved"
    && lastDec.effective_from
    && lastDec.effective_from > todayIso;

  const _dayLbl = { mon:"Mon", tue:"Tue", wed:"Wed", thu:"Thu", fri:"Fri", sat:"Sat", sun:"Sun" };
  const _fmtDecDays = (arr) => (Array.isArray(arr) && arr.length)
    ? arr.map((k) => _dayLbl[k] || k).join(", ")
    : "no days";

  let bannerHtml = "";
  if (blackout) {
    bannerHtml = `<div class="avail-banner denied">
      <div class="avail-banner-title">Submissions paused${blackout.reason ? " · " + escapeHtml(blackout.reason) : ""}</div>
      <div class="avail-banner-sub">Availability changes are blocked through ${escapeHtml(_fmtAvailDate(blackout.end_date))}.</div>
    </div>`;
  } else if (hasPending) {
    const ps = pendingStart ? ` · earliest start ${escapeHtml(_fmtTime12(pendingStart))}` : "";
    bannerHtml = `<div class="avail-banner pending">
      <div class="avail-banner-title">Request pending review</div>
      <div class="avail-banner-sub">${escapeHtml(_fmtDecDays(data.pending.days))}${ps}. You'll get a message when your dispatcher decides.</div>
    </div>`;
  } else if (approvedNotYetEffective) {
    const ds = lastDec.earliest_start ? ` · earliest start ${escapeHtml(_fmtTime12(lastDec.earliest_start))}` : "";
    bannerHtml = `<div class="avail-banner approved">
      <div class="avail-banner-title">Change approved · effective ${escapeHtml(_fmtAvailDate(lastDec.effective_from))}</div>
      <div class="avail-banner-sub">${escapeHtml(_fmtDecDays(lastDec.days))}${ds} starting ${escapeHtml(_fmtAvailDate(lastDec.effective_from))}.  Your schedule keeps using the days below until then.</div>
    </div>`;
  }

  // Preferred rows are re-rendered as the driver toggles availability in
  // first-time mode, so this is a function rather than a one-shot string.
  const _prefRowsHtml = () => _AVAIL_DAYS.map((d) => {
    const allowed = firstTime ? picked.has(d.k) : liveDays.has(d.k);
    const on = prefSet.has(d.k) && allowed;
    return `
      <label class="avail-day" data-rr-pref-row="${d.k}" style="${allowed ? "" : "opacity:.4"}">
        <span class="avail-day-name">${escapeHtml(d.fullLabel)}</span>
        <span class="avail-toggle ${on ? "on" : ""}">
          <input type="checkbox" data-rr-pref="${d.k}" ${on ? "checked" : ""} ${allowed ? "" : "disabled"}/>
          <span class="avail-toggle-track"><span class="avail-toggle-thumb"></span></span>
        </span>
      </label>`;
  }).join("");

  const prefBlock = `
    <div style="margin-top:26px">
      <div style="font-weight:700;font-size:var(--fs-lg)">Preferred days</div>
      <div style="font-size:var(--fs-sm);color:var(--text-muted);margin:4px 0 10px">${firstTime
        ? "Days you'd most like to be scheduled — pick from the days you chose above. We'll save them when you submit."
        : "Days you'd most like to be scheduled — we'll try to honor these. You can only pick days you're already approved for; to add a new day, submit an availability change above."}</div>
      ${(firstTime || liveDays.size > 0)
        ? `<section class="avail-list" id="avail-pref-list">${_prefRowsHtml()}</section>`
        : `<div style="font-size:var(--fs-sm);color:var(--text-subtle)">Set your available days first.</div>`}
    </div>`;

  // Overtime opt-in — would the driver take a 5th day when coverage is
  // short. Persists immediately (a free preference, no approval needed).
  const fifthDayOk = data?.fifth_day_ok === true;
  const fifthDayBlock = `
    <div style="margin-top:26px">
      <div style="font-weight:700;font-size:var(--fs-lg)">Overtime</div>
      <div style="font-size:var(--fs-sm);color:var(--text-muted);margin:4px 0 10px">If coverage is short, would you be willing to work a 5th day that week? Your dispatcher sees who's opted in.</div>
      <section class="avail-list">
        <label class="avail-day" for="avail-fifth">
          <span class="avail-day-name">Open to a 5th day</span>
          <span class="avail-toggle ${fifthDayOk ? "on" : ""}">
            <input type="checkbox" id="avail-fifth" data-rr-fifth ${fifthDayOk ? "checked" : ""}/>
            <span class="avail-toggle-track"><span class="avail-toggle-thumb"></span></span>
          </span>
        </label>
      </section>
    </div>`;

  main.innerHTML = `
    <div class="avail-page">
      ${bannerHtml ? `<div id="avail-banner-slot">${bannerHtml}</div>` : ""}
      <div style="font-weight:700;font-size:var(--fs-lg);margin-bottom:8px">Days you can work</div>
      <section class="avail-list" id="avail-list">${rowsHtml}</section>
      ${driverFeatureOn("start_time") ? startBlock : ""}
      <button class="checkin-btn" id="avail-submit" type="button" ${locked ? "disabled" : ""}>
        ${locked ? "Submission paused" : "Submit availability change"}
      </button>
      <div class="avail-policy">${policyText}</div>
      ${driverFeatureOn("preferred_days") ? prefBlock : ""}
      ${driverFeatureOn("fifth_day") ? fifthDayBlock : ""}
    </div>`;

  const listEl   = document.getElementById("avail-list");
  const submitEl = document.getElementById("avail-submit");
  const startEl  = document.getElementById("avail-start");
  const prefEl   = document.getElementById("avail-pref-list");

  // Auto-refresh while this page is mounted (dispatcher may
  // approve / deny the pending request from the dashboard).
  _availStartAutoRefresh();

  let _inFlight = 0;
  window._rrAvailInFlight = () => _inFlight > 0;

  listEl.addEventListener("change", (e) => {
    const cb = e.target.closest("input[data-rr-day]");
    if (!cb) return;
    const dk = cb.dataset.rrDay;
    if (cb.checked) picked.add(dk); else picked.delete(dk);
    cb.closest(".avail-toggle").classList.toggle("on", cb.checked);
    _haptic("select");
    // First-time: preferred days are chosen from the days picked here, so
    // keep the preferred list in sync — drop a day from preferred when it's
    // removed from availability, and re-render so newly-picked days become
    // selectable as preferred.
    if (firstTime && prefEl) {
      if (!cb.checked) prefSet.delete(dk);
      prefEl.innerHTML = _prefRowsHtml();
    }
  });

  // Preferred days: persist on each toggle (established driver). In first-time
  // mode they're held locally and saved together with the availability submit.
  if (prefEl) {
    prefEl.addEventListener("click", (e) => {
      const row = e.target.closest("[data-rr-pref-row]");
      if (!row) return;
      const dk = row.getAttribute("data-rr-pref-row");
      const allowed = firstTime ? picked.has(dk) : liveDays.has(dk);
      if (!allowed) {
        e.preventDefault();
        const full = (_AVAIL_DAYS.find((d) => d.k === dk) || {}).fullLabel || dk;
        toast(firstTime
          ? `Turn on ${full} in "Days you can work" above first.`
          : `${full} isn't in your approved availability. Submit an availability change to add it.`, "warn");
      }
    });
    prefEl.addEventListener("change", async (e) => {
      const cb = e.target.closest("input[data-rr-pref]");
      if (!cb) return;
      const dk = cb.dataset.rrPref;
      const allowed = firstTime ? picked.has(dk) : liveDays.has(dk);
      if (!allowed) { cb.checked = false; return; }
      if (cb.checked) prefSet.add(dk); else prefSet.delete(dk);
      cb.closest(".avail-toggle").classList.toggle("on", cb.checked);
      _haptic("select");
      // First-time: no approved days to validate against yet — saved together
      // with the availability submit below.
      if (firstTime) return;
      _inFlight++;
      const { error: perr } = await sb.rpc("driver_set_preferred_days", { p_token: session.token, p_days: [...prefSet] });
      _inFlight--;
      if (perr) {
        if (cb.checked) prefSet.delete(dk); else prefSet.add(dk);
        cb.checked = !cb.checked;
        cb.closest(".avail-toggle").classList.toggle("on", cb.checked);
        const m = perr.message || "";
        toast(m.includes("preferred_day_unavailable")
          ? m.replace(/^.*preferred_day_unavailable:\s*/, "")
          : _friendlyError(perr, "Couldn't save your preferred days. Try again."), "warn");
        return;
      }
      toast("Preferred days saved", "ok");
    });
  }

  // 5th-day overtime opt-in — persists immediately on toggle.
  const fifthEl = document.getElementById("avail-fifth");
  if (fifthEl) {
    fifthEl.addEventListener("change", async () => {
      const want = fifthEl.checked;
      fifthEl.closest(".avail-toggle").classList.toggle("on", want);
      _haptic("select");
      _inFlight++;
      const { error: ferr } = await sb.rpc("driver_set_fifth_day_ok", {
        p_token: session.token, p_ok: want,
      });
      _inFlight--;
      if (ferr) {
        fifthEl.checked = !want;
        fifthEl.closest(".avail-toggle").classList.toggle("on", !want);
        toast(_friendlyError(ferr, "Couldn't save that. Try again."), "warn");
        return;
      }
      toast(want ? "You're open to a 5th day" : "5th-day opt-in turned off", "ok");
    });
  }

  submitEl.addEventListener("click", async () => {
    if (locked) {
      if (hasPending) toast("You already have a pending request", "warn");
      else if (blackout) toast("Submissions are paused right now", "warn");
      return;
    }
    {
      const ok = await confirmSheet({
        title: "Submit availability change?",
        message: "Your dispatcher will review this and either approve or decline.",
        confirmText: "Submit for approval",
      });
      if (!ok) return;
      _haptic("tap");
    }

    _inFlight++;
    submitEl.disabled = true;
    const days = _AVAIL_DAYS.filter((d) => picked.has(d.k)).map((d) => d.k);
    const startVal = startEl ? (startEl.value || null) : null;
    const { data: res, error: serr } = await sb.rpc("driver_submit_availability", {
      p_token: session.token, p_days: days, p_earliest_start: startVal,
    });
    _inFlight--;
    if (serr) {
      submitEl.disabled = false;
      if ((serr.message || "").includes("availability_blackout")) {
        const reason = serr.message.replace(/^.*availability_blackout:\s*/, "");
        toast("Submissions paused: " + reason, "warn");
      } else {
        toast(_friendlyError(serr, "Couldn't submit. Try again."), "warn");
      }
      return;
    }
    // First-time: persist the preferred-day picks now. A new driver's submit
    // auto-approves, so the approved days exist and preferred (a subset)
    // validates. If it went to pending instead (e.g. a custom earliest start),
    // preferred can't be saved until a dispatcher approves — tell the driver.
    if (firstTime && prefSet.size > 0) {
      const prefDays = days.filter((k) => prefSet.has(k));
      if (res?.auto_approved && prefDays.length) {
        _inFlight++;
        const { error: perr } = await sb.rpc("driver_set_preferred_days", { p_token: session.token, p_days: prefDays });
        _inFlight--;
        toast(perr
          ? "Availability saved · couldn't save preferred days — set them from this page"
          : "Availability & preferred days saved", perr ? "warn" : "ok");
        renderAvailability();
        return;
      }
      if (!res?.auto_approved) {
        toast("Submitted for approval · set your preferred days once it's approved", "ok");
        renderAvailability();
        return;
      }
    }
    toast(res?.auto_approved ? "Availability updated" : "Submitted for approval", "ok");
    renderAvailability();
  });
}

function _fmtTime12(hhmm) {
  if (typeof hhmm !== "string" || !/^\d{1,2}:\d{2}$/.test(hhmm)) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const ap = h < 12 ? "AM" : "PM";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, "0")} ${ap}`;
}

// Refresh the Availability page on focus / visibility change so a
// dispatcher decision (which arrives via chat push) clears the
// "pending" banner without a manual reload. Registered once at module
// load; the inner guard keeps it cheap when on other routes.
function _refreshAvailabilityIfActive() {
  if (currentRoute() !== "/settings/availability") return;
  if (typeof window._rrAvailInFlight === "function" && window._rrAvailInFlight()) return;
  renderAvailability();
}
window.addEventListener("focus", _refreshAvailabilityIfActive);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) _refreshAvailabilityIfActive();
});

function _fmtAvailDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso + "T12:00:00");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch { return iso; }
}

// ── Settings → Time off: request a day off, see past decisions ─────
// Driver-side companion to the dashboard's Time off page. The driver
// picks a start date (and optionally an end date for a multi-day
// request), drops in an optional reason, and submits. Below the form
// the existing requests are listed newest-first with a colored status
// pill and any dispatcher decision note. Pending requests can be
// cancelled with one tap. Approval / denial pushes a chat message
// from dispatch so the existing notification pipeline surfaces the
// outcome — see migration 0252.
async function renderTimeOff() {
  setHeader("Time off", "");
  const main = document.getElementById("main");
  main.innerHTML = `<div class="loader" style="margin:60px auto"></div>`;
  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }
  if (!driverFeatureOn("time_off")) { main.innerHTML = _featureOffHtml("Time off"); return; }

  const { data, error } = await sb.rpc("driver_time_off_list", { p_token: session.token });
  if (currentRoute() !== "/settings/time-off") return;
  if (error) {
    main.innerHTML = errorStateHtml("Couldn't load time off", error);
    return;
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const minIso = today.toISOString().slice(0, 10);

  main.innerHTML = `
    <div class="to-form" id="to-form">
      <div class="to-form-h">Request a day off</div>
      <div class="to-form-row">
        <label class="field-label" for="to-start">Start</label>
        <input class="field" id="to-start" type="date" min="${minIso}"/>
      </div>
      <div class="to-form-row">
        <label class="field-label" for="to-end">End <span style="color:var(--text-subtle);font-weight:400">(leave blank for one day)</span></label>
        <input class="field" id="to-end" type="date" min="${minIso}"/>
      </div>
      <div class="to-form-row">
        <label class="field-label" for="to-reason">Reason <span style="color:var(--text-subtle);font-weight:400">(optional)</span></label>
        <textarea class="field" id="to-reason" rows="3" maxlength="500" placeholder="Vacation, doctor's appointment, family event…"></textarea>
      </div>
      <div class="to-form-row" style="display:flex;align-items:flex-start;gap:10px;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--canvas)">
        <input type="checkbox" id="to-use-pto" style="margin-top:3px;width:18px;height:18px;flex:0 0 auto"/>
        <label for="to-use-pto" style="flex:1;cursor:pointer;line-height:1.4">
          <div style="font-weight:600;font-size:var(--fs-md)">Use my PTO for these days</div>
          <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">Check this if you want these days paid out of your PTO balance. Leave it unchecked for unpaid time off — your dispatcher will still see the request.</div>
        </label>
      </div>
      <div class="to-form-err" id="to-err" hidden></div>
      <button class="btn btn-block btn-primary" id="to-submit" type="button">Submit request</button>
    </div>
    <div class="to-list" id="to-list">${_toListHtml(data || [])}</div>`;

  document.getElementById("to-submit").addEventListener("click", _toSubmit);
  document.getElementById("to-list").addEventListener("click", _toListClick);
}

function _toListHtml(rows) {
  if (!rows.length) {
    return `<div class="to-empty">No previous requests. Future requests will appear here.</div>`;
  }
  return `
    <div class="to-list-h">Your requests</div>
    ${rows.map(_toRowHtml).join("")}`;
}

function _toRowHtml(r) {
  const lbl = (iso) => {
    try { return new Date(iso + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
    catch { return iso; }
  };
  const range = r.start_date === r.end_date
    ? lbl(r.start_date)
    : `${lbl(r.start_date)} – ${lbl(r.end_date)}`;
  const pill = `<span class="to-pill to-pill-${r.status}">${escapeHtml(r.status[0].toUpperCase() + r.status.slice(1))}</span>`;
  const kindPill = r.is_pto
    ? `<span class="to-pill" style="background:rgba(13,148,136,.12);color:var(--rr-teal-700);margin-left:6px">PTO</span>`
    : `<span class="to-pill" style="background:var(--canvas);color:var(--text-muted);margin-left:6px">Unpaid</span>`;
  const note = r.decision_notes
    ? `<div class="to-row-note"><strong>Dispatch:</strong> ${escapeHtml(r.decision_notes)}</div>`
    : "";
  const reason = r.reason
    ? `<div class="to-row-reason">${escapeHtml(r.reason)}</div>`
    : "";
  const cancel = r.status === "pending"
    ? `<button class="to-cancel" type="button" data-rr-to-cancel="${escapeHtml(r.id)}">Cancel request</button>`
    : "";
  return `
    <div class="to-row" data-rr-to-row="${escapeHtml(r.id)}">
      <div class="to-row-top">
        <div class="to-row-range">${escapeHtml(range)}</div>
        <div>${pill}${kindPill}</div>
      </div>
      ${reason}
      ${note}
      ${cancel}
    </div>`;
}

async function _toSubmit() {
  const start = document.getElementById("to-start").value;
  const endRaw = document.getElementById("to-end").value;
  const reason = document.getElementById("to-reason").value.trim();
  const err = document.getElementById("to-err");
  const submit = document.getElementById("to-submit");
  err.hidden = true; err.textContent = "";
  if (!start) {
    err.textContent = "Pick a start date.";
    err.hidden = false;
    return;
  }
  const end = endRaw || start;
  if (end < start) {
    err.textContent = "End date can't be before start date.";
    err.hidden = false;
    return;
  }
  const usePto = !!document.getElementById("to-use-pto")?.checked;
  submit.disabled = true; submit.textContent = "Submitting…";
  const session = readSession();
  const { error } = await sb.rpc("driver_time_off_request", {
    p_token: session.token,
    p_start_date: start,
    p_end_date: end,
    p_reason: reason || null,
    p_use_pto: usePto,
  });
  submit.disabled = false; submit.textContent = "Submit request";
  if (error) {
    const msg = (error.message || "").includes("time_off_overlaps_existing")
      ? "You already have a request that overlaps these dates."
      : _friendlyError(error, "Couldn't submit your request. Try again.");
    err.textContent = msg; err.hidden = false;
    return;
  }
  toast("Request submitted", "success");
  renderTimeOff();
}

async function _toListClick(e) {
  const btn = e.target.closest("[data-rr-to-cancel]");
  if (!btn) return;
  const id = btn.getAttribute("data-rr-to-cancel");
  const ok = await confirmSheet({
    title: "Cancel this request?",
    message: "Your dispatcher won't see it anymore. You can submit a new one.",
    confirmText: "Yes, cancel it",
    cancelText: "Keep it",
    danger: true,
  });
  if (!ok) return;
  _haptic("tap");
  btn.disabled = true; btn.textContent = "Cancelling…";
  const session = readSession();
  const { error } = await sb.rpc("driver_time_off_cancel", { p_token: session.token, p_id: id });
  if (error) {
    toast(_friendlyError(error, "Couldn't cancel. Try again."), "warn");
    btn.disabled = false; btn.textContent = "Cancel request";
    return;
  }
  toast("Request cancelled", "success");
  renderTimeOff();
}

// ── Documents ───────────────────────────────────────────────────────
// ── Tasks → Attendance: today's status + the policy ────────────────
async function renderAttendance() {
  const main = document.getElementById("main");
  main.innerHTML = `<div class="loader"></div>`;
  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }

  // Pull the driver's current standing + their DSP's policy (now
  // block-shaped: variable rung count, custom point values per
  // event).  Driver-side scoring is computed server-side so it
  // can never disagree with what the dispatcher sees.
  const { data, error } = await sb.rpc("driver_attendance_overview",
    { p_token: session.token });

  if (error) {
    main.innerHTML = errorStateHtml("Couldn't load attendance", error);
    return;
  }

  const standing = data?.standing || {};
  const policy   = data?.policy   || {};
  const enabled  = policy.enabled !== false;

  const SEV_LABEL = { verbal: "Verbal", written: "Written", final: "Final", termination: "Termination" };
  const EVENT_LABEL = { callout: "Callout", no_show: "No-show", late: "Late arrival" };
  const ladder = Array.isArray(policy.ladder) ? policy.ladder : [];
  const events = Array.isArray(policy.events) ? policy.events : [];

  // Status banner.
  let statusTitle, statusSub, statusClass;
  if (!enabled) {
    statusTitle = "No attendance policy";
    statusSub   = "Your DSP doesn't track attendance points right now.";
    statusClass = "neutral";
  } else if (standing.status === "action") {
    const sev = SEV_LABEL[standing.severity] || "Action";
    statusTitle = `${sev} — review with your leader`;
    statusSub   = standing.in_first_30_days
      ? "First-30-days probation rule applied."
      : `${standing.points} point${standing.points === 1 ? "" : "s"} in the last ${policy.decay_days} days.`;
    statusClass = "denied";
  } else if (standing.status === "warning") {
    const sev = SEV_LABEL[standing.severity] || "Warning";
    statusTitle = sev;
    statusSub   = standing.next_severity
      ? `${standing.points} point${standing.points === 1 ? "" : "s"} · ${standing.points_to_next} more = ${SEV_LABEL[standing.next_severity] || standing.next_severity}.`
      : `${standing.points} point${standing.points === 1 ? "" : "s"} accrued.`;
    statusClass = "pending";
  } else {
    statusTitle = "Good standing";
    if (standing.next_severity && standing.points_to_next > 0) {
      statusSub = `${standing.points} point${standing.points === 1 ? "" : "s"} · ${standing.points_to_next} more = ${SEV_LABEL[standing.next_severity] || standing.next_severity}.`;
    } else {
      statusSub = "Clean record over the last " + policy.decay_days + " days.";
    }
    statusClass = "approved";
  }

  // Per-event point values — the new policy lets the DSP set
  // different point weights per event type, so we tell the driver.
  const pointsExplained = events.length === 0
    ? "Nothing currently counts toward points — your DSP is logging events but not scoring them."
    : events.map(e => {
        const pts = Number(e.points) || 0;
        const label = (EVENT_LABEL[e.kind] || e.kind);
        return `${escapeHtml(label)} = <strong>${pts} point${pts === 1 ? "" : "s"}</strong>`;
      }).join(" · ");

  // Render the actual ladder the DSP built — variable count, real
  // thresholds.  Highlight the rung the driver currently sits on.
  const ladderHtml = ladder.length === 0
    ? "<li>Your DSP hasn't set up coaching levels yet.</li>"
    : ladder.map(r => {
        const sev = SEV_LABEL[r.severity] || r.severity;
        const thr = Number(r.threshold) || 0;
        const here = standing.severity === r.severity;
        return `<li${here ? ' style="color:var(--text);font-weight:700"' : ""}>
          ${thr} pt → ${escapeHtml(sev)}${here ? " ← you are here" : ""}
        </li>`;
      }).join("");

  const ncnsText = policy.ncns_terminates
    ? `<li><strong>One no-call no-show is grounds for termination</strong> — your DSP escalates NCNS instantly, even on a clean record.</li>`
    : "";

  const first30Text = policy.first_30_strict
    ? `<li>New drivers are held to <strong>zero absences</strong> for their first ${policy.first_30_window_days} days. Any callout or no-show in that window jumps straight to Action.</li>`
    : "";

  main.innerHTML = `
    <div class="avail-page">
      <div class="avail-banner ${statusClass}">
        <div class="avail-banner-title">${escapeHtml(statusTitle)}</div>
        ${statusSub ? `<div class="avail-banner-sub">${escapeHtml(statusSub)}</div>` : ""}
      </div>

      ${enabled ? `
      <div class="card">
        <div class="checkin-title" style="margin-bottom:8px">Your record · last ${policy.decay_days} days</div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px">
          <div style="background:var(--canvas);border-radius:10px;padding:10px 8px;text-align:center">
            <div style="font-size:18px;font-weight:700;color:var(--text)">${standing.points ?? 0}</div>
            <div style="font-size:10px;color:var(--text-subtle);font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin-top:2px">Points</div>
          </div>
          <div style="background:var(--canvas);border-radius:10px;padding:10px 8px;text-align:center">
            <div style="font-size:18px;font-weight:700;color:var(--text)">${standing.callouts ?? 0}</div>
            <div style="font-size:10px;color:var(--text-subtle);font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin-top:2px">Callouts</div>
          </div>
          <div style="background:var(--canvas);border-radius:10px;padding:10px 8px;text-align:center">
            <div style="font-size:18px;font-weight:700;color:var(--text)">${standing.noshows ?? 0}</div>
            <div style="font-size:10px;color:var(--text-subtle);font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin-top:2px">No-shows</div>
          </div>
          <div style="background:var(--canvas);border-radius:10px;padding:10px 8px;text-align:center">
            <div style="font-size:18px;font-weight:700;color:var(--text)">${standing.tardies ?? 0}</div>
            <div style="font-size:10px;color:var(--text-subtle);font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin-top:2px">Tardies</div>
          </div>
        </div>
        <div style="font-size:var(--fs-sm);color:var(--text-muted);line-height:1.5">${pointsExplained}</div>
      </div>` : ""}

      <section class="card">
        <div class="checkin-title" style="margin-bottom:8px">${enabled ? "Your DSP's coaching ladder" : "Attendance"}</div>
        ${enabled
          ? `<ul style="margin:0;padding-left:18px;font-size:var(--fs-md);color:var(--text-muted);line-height:1.7">
               ${ladderHtml}
             </ul>
             <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:10px;line-height:1.4">Older events drop off after ${policy.decay_days} days.</div>`
          : `<p style="margin:0;font-size:var(--fs-md);color:var(--text-muted);line-height:1.6">Your DSP isn't running an attendance scoring policy right now. Tardies, callouts, and no-shows are still logged on your record, but no warnings or actions are auto-generated.</p>`}
      </section>

      ${enabled && (ncnsText || first30Text) ? `
      <section class="card">
        <div class="checkin-title" style="margin-bottom:8px">Special rules</div>
        <ul style="margin:0;padding-left:18px;font-size:var(--fs-md);color:var(--text-muted);line-height:1.6">
          ${ncnsText}
          ${first30Text}
        </ul>
      </section>` : ""}
    </div>`;
}

// ── Header helper ───────────────────────────────────────────────────
function setHeader(title, sub) {
  const t = document.getElementById("head-title");
  const s = document.getElementById("head-sub");
  if (t) t.textContent = title;
  if (s) s.textContent = sub || "";
}

// ── Boot ────────────────────────────────────────────────────────────
// In preview mode, seed the in-memory session from the URL so the first
// render has a token (and the right onboarding state) before driver_me
// fills in the rest. The token is validated server-side like any other.
if (PREVIEW && !readSession()) {
  let q; try { q = new URLSearchParams(location.search); } catch { q = new URLSearchParams(""); }
  writeSession({
    token:     PREVIEW_TOKEN,
    preview:   true,
    driver_id: q.get("did") || null,
    name:      q.get("n") || "Driver",
    dsp_name:  q.get("d") || "",
    status:    q.get("onb") === "1" ? "onboarding" : (q.get("st") || null),
  });
}
render();


// ───────────────────────────────────────────────────────────────────────
// Documents (e-signature) · driver-side. List + sign flow. The
// dispatcher composes envelopes from the dashboard; this surface lets
// the driver review, accept the ESIGN consent disclosure, and sign.
// PDF sealing (PKCS#7 + RFC 3161 + Certificate of Completion) happens
// in the slice-4 signing service after the envelope flips to 'signed'.
// ───────────────────────────────────────────────────────────────────────

const _ESIGN_CONSENT_VERSION = "esign-v1-2026-05";
const _ESIGN_CONSENT_TEXT =
  "By signing below, I consent to use electronic signatures and agree " +
  "that my signature has the same legal effect as a handwritten signature. " +
  "I understand this consent and my signature are recorded with my name, " +
  "IP address, device information, and a timestamp, and that this record " +
  "is retained as evidence of the agreement.";

const _DOCS_STATUS_LABEL = {
  sent:     "Awaiting your signature",
  viewed:   "Awaiting your signature",
  signed:   "Signed",
  declined: "Declined",
  voided:   "Cancelled by sender",
  expired:  "Expired",
};
const _DOCS_STATUS_LABEL_INFO = {
  sent:     "To review",
  viewed:   "To review",
  signed:   "Reviewed",
  declined: "Declined",
  voided:   "Cancelled by sender",
  expired:  "Expired",
};
const _DOCS_STATUS_COLOR = {
  sent:     "color:var(--amber-dark);background:var(--amber-soft)",
  viewed:   "color:var(--amber-dark);background:var(--amber-soft)",
  signed:   "color:var(--green);background:var(--green-soft)",
  declined: "color:var(--red);background:rgba(220,38,38,.10)",
  voided:   "color:var(--text-subtle);background:var(--canvas)",
  expired:  "color:var(--text-subtle);background:var(--canvas)",
};
const _docLabel = (e) => ((e && e.kind === "informational") ? _DOCS_STATUS_LABEL_INFO : _DOCS_STATUS_LABEL)[e?.status] || e?.status || "";

async function renderDocumentsList() {
  const main = document.getElementById("main");
  main.innerHTML = `<div class="loader" style="margin:96px auto"></div>`;
  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }
  const { data, error } = await sb.rpc("driver_envelopes_list", { p_token: session.token });
  if (error) {
    if (/unauthorized|revoked|inactive/.test(error.message || "")) { writeSession(null); render(); return; }
    main.innerHTML = errorStateHtml("Couldn't load documents", error);
    return;
  }
  const pending   = Array.isArray(data?.pending)   ? data.pending   : [];
  const completed = Array.isArray(data?.completed) ? data.completed : [];

  const section = (title, items, isPending) => {
    if (items.length === 0) return "";
    return `
      <div style="padding:18px 16px 6px 16px;font-size:var(--fs-xs);font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-subtle)">${escapeHtml(title)}</div>
      <div style="display:flex;flex-direction:column;gap:8px;padding:0 14px">
        ${items.map((e) => `
          <button class="rr-doc-row" data-sign="${escapeHtml(e.signing_token)}" style="text-align:left;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;cursor:pointer;display:flex;align-items:center;gap:12px;width:100%">
            <div style="width:34px;height:42px;flex:0 0 auto;background:var(--accent-soft);color:var(--accent);border-radius:6px;display:flex;align-items:center;justify-content:center">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(e.template_title || "Document")}</div>
              <div style="margin-top:3px"><span class="tag" style="${_DOCS_STATUS_COLOR[e.status] || ""};font-size:11px">${escapeHtml(_docLabel(e))}</span></div>
            </div>
            ${isPending
              ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" style="color:var(--text-subtle);flex:0 0 auto"><polyline points="9 18 15 12 9 6"/></svg>'
              : ""}
          </button>`).join("")}
      </div>`;
  };

  if (pending.length === 0 && completed.length === 0) {
    main.innerHTML = `<div class="empty-state" style="padding:64px 24px;color:var(--text-subtle);text-align:center"><strong style="display:block;color:var(--text);margin-bottom:4px">No documents</strong>You'll see anything your team sends you here — to sign or to review.</div>`;
    return;
  }
  main.innerHTML = `<div style="padding-bottom:24px">${section("To sign", pending, true)}${section("Recent", completed, false)}</div>`;
  main.querySelectorAll(".rr-doc-row").forEach((row) => {
    row.addEventListener("click", () => navigate("/tasks/documents/sign?st=" + row.getAttribute("data-sign")));
  });
}

async function renderDocumentSign() {
  const main = document.getElementById("main");
  main.innerHTML = `<div class="loader" style="margin:96px auto"></div>`;
  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }
  const q = routeQuery();
  const signingToken = q.get("st");
  if (!signingToken) {
    main.innerHTML = errorStateHtml("Document not found", null);
    return;
  }

  // Fetch the envelope + signed URL via the edge function. This also
  // logs the 'viewed' event on first open.
  //
  // We deliberately use raw fetch instead of sb.functions.invoke —
  // the supabase-js helper consumes the response body internally to
  // build error.message, which leaves error.context's body locked
  // and forces us back to the generic "Edge Function returned a
  // non-2xx status code" string. With raw fetch we always get the
  // full JSON the function returned (code/details/hint included).
  let fetched = null;
  let fetchErrDetail = null;
  try {
    const resp = await fetch(`${cfg.SUPABASE_URL}/functions/v1/driver-document-fetch`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": "Bearer " + cfg.SUPABASE_ANON_KEY,
        "apikey":        cfg.SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ token: session.token, signing_token: signingToken }),
    });
    const text = await resp.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!resp.ok) {
      fetchErrDetail = (body && (body.error || body.message))
        || text
        || `HTTP ${resp.status}`;
    } else {
      fetched = body;
    }
  } catch (e) {
    fetchErrDetail = (e && e.message) || "network_error";
  }
  if (fetchErrDetail) {
    main.innerHTML = errorStateHtml("Couldn't open document", fetchErrDetail);
    return;
  }
  const env = fetched?.envelope;
  const tpl = fetched?.template;
  const url = fetched?.signed_url;
  if (!env || !tpl || !url) {
    main.innerHTML = errorStateHtml("Document isn't available", null);
    return;
  }
  const isInfo = (tpl.kind === "informational");

  if (!["sent","viewed"].includes(env.status)) {
    main.innerHTML = `
      <div style="padding:32px 20px;text-align:center">
        <div style="font-size:var(--fs-lg);font-weight:700;color:var(--text);margin-bottom:6px">${escapeHtml(tpl.title || "Document")}</div>
        <div><span class="tag" style="${_DOCS_STATUS_COLOR[env.status] || ""};font-size:11px">${escapeHtml(_docLabel({ status: env.status, kind: tpl.kind }))}</span></div>
        <div style="margin-top:14px;color:var(--text-subtle);font-size:var(--fs-sm)">No further action needed.</div>
      </div>`;
    return;
  }

  // Recipient-fill fields (text / checkbox) the dispatcher placed on
  // the template — the driver completes these here; the values are
  // sent with the signature and the sealing worker stamps them onto
  // the PDF at their positions.
  // Multi-signer awareness: a field belongs to the driver if it has
  // no signer_role tag (legacy single-signer templates) or its tag is
  // explicitly "driver". Employer-tagged fields are completed by an
  // operator after this signing pass, so the driver shouldn't see
  // them in the fill list.
  const isDriverField = (f) => !f.signer_role || f.signer_role === "driver";
  const fillFields = (env.fields_snapshot || []).filter((f) => f && isDriverField(f) && (f.kind === "text" || f.kind === "checkbox"));
  const fillSection = fillFields.length ? `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:12px">
        <div style="font-size:var(--fs-xs);font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted)">Complete these fields</div>
        ${fillFields.map((f) => f.kind === "checkbox"
          ? `<label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer"><input type="checkbox" data-rr-fld="${escapeHtml(f.id)}" style="margin-top:2px;width:18px;height:18px;accent-color:var(--accent);flex:0 0 auto"><span style="font-size:var(--fs-sm);line-height:1.5;color:var(--text)">${escapeHtml(f.label || "Checkbox")}</span></label>`
          : `<label style="display:flex;flex-direction:column;gap:4px"><span style="font-size:var(--fs-xs);color:var(--text-muted)">${escapeHtml(f.label || "Text field")}</span><input type="text" data-rr-fld="${escapeHtml(f.id)}" style="padding:10px 12px;border:1px solid var(--border);border-radius:8px;font:inherit;background:var(--canvas)"></label>`
        ).join("")}
      </div>` : "";

  main.innerHTML = `
    <div style="padding:14px 16px 96px 16px;display:flex;flex-direction:column;gap:14px">
      <div>
        <div style="font-size:var(--fs-lg);font-weight:700;color:var(--text)">${escapeHtml(tpl.title || "Document")}</div>
        ${tpl.description ? `<div style="margin-top:4px;color:var(--text-muted);font-size:var(--fs-sm)">${escapeHtml(tpl.description)}</div>` : ""}
      </div>

      <a href="${url}" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;color:var(--text);text-decoration:none;font-weight:600">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--accent)" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span style="flex:1">View document (PDF)</span>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--text-subtle)" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </a>

      ${fillSection}

      ${isInfo ? `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:12px">
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
          <input type="checkbox" id="rr-doc-consent" style="margin-top:3px;width:18px;height:18px;accent-color:var(--accent);flex:0 0 auto">
          <span style="font-size:var(--fs-sm);line-height:1.5;color:var(--text)">I confirm I have reviewed this document. This acknowledgment is recorded with my name and a timestamp.</span>
        </label>
        <label style="display:flex;flex-direction:column;gap:4px">
          <span style="font-size:var(--fs-xs);font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted)">Your name</span>
          <input type="text" id="rr-sig-typed" autocomplete="name" value="${escapeHtml(env.recipient_name || "")}" style="padding:10px 12px;border:1px solid var(--border);border-radius:8px;font:inherit;background:var(--canvas)">
        </label>
      </div>
      <div style="display:flex"><button type="button" id="rr-doc-submit" class="btn btn-primary" style="flex:1">I've reviewed this — acknowledge</button></div>
      ` : `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px">
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
          <input type="checkbox" id="rr-doc-consent" style="margin-top:3px;width:18px;height:18px;accent-color:var(--accent);flex:0 0 auto">
          <span style="font-size:var(--fs-sm);line-height:1.5;color:var(--text)">${escapeHtml(_ESIGN_CONSENT_TEXT)}</span>
        </label>
      </div>

      <div>
        <div style="font-size:var(--fs-xs);font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px">Your signature</div>
        <div style="position:relative;background:var(--rr-white);border:1px solid var(--border);border-radius:12px;overflow:hidden">
          <canvas id="rr-sig-canvas" style="display:block;width:100%;height:200px;background:var(--rr-white);touch-action:none;cursor:crosshair"></canvas>
          <button type="button" id="rr-sig-clear" style="position:absolute;top:8px;right:8px;background:var(--rr-slate-100);border:1px solid var(--rr-slate-300);border-radius:999px;padding:4px 10px;font:inherit;font-size:11px;font-weight:600;color:var(--rr-slate-600);cursor:pointer">Clear</button>
          <div id="rr-sig-hint" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);color:var(--rr-slate-400);font-size:var(--fs-xs);pointer-events:none">Draw your signature with your finger or mouse</div>
        </div>
        <label style="display:flex;flex-direction:column;gap:4px;margin-top:10px">
          <span style="font-size:var(--fs-xs);font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted)">Or type your full name</span>
          <input type="text" id="rr-sig-typed" placeholder="Your full legal name" autocomplete="name" style="padding:10px 12px;border:1px solid var(--border);border-radius:8px;font:inherit;background:var(--canvas)">
        </label>
      </div>

      <div style="display:flex;gap:8px;justify-content:space-between;align-items:center">
        <button type="button" id="rr-doc-decline" class="btn" style="background:transparent;color:var(--red);border:1px solid var(--border)">Decline</button>
        <button type="button" id="rr-doc-submit" class="btn btn-primary" style="flex:1">Sign &amp; submit</button>
      </div>`}
    </div>`;

  let hasInk = false, canvas = null, ctx = null;
  if (!isInfo) {
    // Canvas signature pad — pointer events handle mouse + touch + pen.
    canvas = document.getElementById("rr-sig-canvas");
    ctx = canvas.getContext("2d");
    const hint = document.getElementById("rr-sig-hint");
    var fitCanvas = function () {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width  = Math.round(rect.width  * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.scale(dpr, dpr);
      ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#0f172a";
    };
    fitCanvas();
    let drawing = false, lastX = 0, lastY = 0;
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      drawing = true; const p = pos(e); lastX = p.x; lastY = p.y; e.preventDefault();
      if (!hasInk) { hint.style.display = "none"; hasInk = true; }
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      const p = pos(e);
      ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(p.x, p.y); ctx.stroke();
      lastX = p.x; lastY = p.y;
    });
    const endStroke = () => { drawing = false; };
    canvas.addEventListener("pointerup",     endStroke);
    canvas.addEventListener("pointercancel", endStroke);
    canvas.addEventListener("pointerleave",  endStroke);
    document.getElementById("rr-sig-clear").addEventListener("click", () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height); fitCanvas(); hasInk = false; hint.style.display = "";
    });
    document.getElementById("rr-doc-decline").addEventListener("click", async () => {
      const answer = await promptSheet({
        title: "Decline this document?",
        message: "Your dispatcher will be notified. The reason is kept on the audit trail.",
        placeholder: "Optional reason",
        confirmText: "Decline document",
        cancelText: "Keep reviewing",
        danger: true,
      });
      if (!answer) return;
      const { error: err } = await sb.rpc("driver_envelope_decline", {
        p_token: session.token, p_signing_token: signingToken, p_reason: answer.text || null,
      });
      if (err) { toast(_friendlyError(err, "Couldn't decline. Try again."), "warn"); return; }
      toast("Declined", "warn");
      navigate("/tasks/documents");
    });
  }

  document.getElementById("rr-doc-submit").addEventListener("click", async () => {
    const consentBox = document.getElementById("rr-doc-consent");
    if (!consentBox.checked) {
      toast(isInfo ? "Please confirm you've reviewed the document." : "Please accept the consent disclosure to sign.", "warn"); return;
    }
    const typed = (document.getElementById("rr-sig-typed").value || "").trim();
    let method = null, data = null;
    if (!isInfo && hasInk) { method = "drawn"; data = canvas.toDataURL("image/png"); }
    else if (typed.length >= 2) { method = "typed"; data = typed; }
    else { toast(isInfo ? "Enter your name to acknowledge." : "Draw your signature or type your full name.", "warn"); return; }

    const fieldValues = {};
    for (const f of fillFields) {
      const el = main.querySelector(`[data-rr-fld="${f.id}"]`);
      if (!el) continue;
      fieldValues[f.id] = f.kind === "checkbox" ? !!el.checked : (el.value || "").trim();
    }

    const btn = document.getElementById("rr-doc-submit");
    const origLabel = btn.textContent;
    btn.disabled = true; btn.textContent = isInfo ? "Saving…" : "Signing…";
    if (navigator.vibrate) { try { navigator.vibrate(8); } catch {} }

    const args = {
      p_token:            session.token,
      p_signing_token:    signingToken,
      p_signature_method: method,
      p_signature_data:   data,
      p_consent_version:  isInfo ? "ack-v1-2026-05" : _ESIGN_CONSENT_VERSION,
      p_consent_text:     isInfo ? "I confirm I have reviewed this document. This acknowledgment is recorded with my name and a timestamp." : _ESIGN_CONSENT_TEXT,
      p_typed_name:       typed || null,
      p_ip:               null,
      p_user_agent:       navigator.userAgent || null,
    };
    if (fillFields.length > 0) args.p_field_values = fieldValues;
    let { error: err } = await sb.rpc("driver_envelope_sign", args);
    if (err && /p_field_values|schema cache|PGRST202/i.test(String(err.message || err))) {
      delete args.p_field_values;
      ({ error: err } = await sb.rpc("driver_envelope_sign", args));
    }
    if (err) {
      btn.disabled = false; btn.textContent = origLabel;
      toast(_friendlyError(err, isInfo ? "Couldn't acknowledge. Try again." : "Couldn't sign. Try again."), "warn"); return;
    }
    toast(isInfo ? "Acknowledged ✓" : "Signed ✓", "success");
    navigate("/tasks/documents");
  });
}


// ───────────────────────────────────────────────────────────────────────
// Form I-9 · Section 1 — Employee Information and Attestation.
// The employee completes and e-signs Section 1 themselves here; the
// employer reviews documents and completes Section 2 from the dashboard.
// NOT legal advice — the official Form I-9 (USCIS, edition 08/01/23) and
// its instructions govern; this captures the same information + the
// attestation + an electronic signature with an audit trail.
// ───────────────────────────────────────────────────────────────────────

const _I9_CONSENT_VERSION = "i9-s1-v1-2026-05";
const _I9_ATTESTATION_TEXT =
  "I am aware that federal law provides for imprisonment and/or fines for " +
  "false statements, or the use of false documents, in connection with the " +
  "completion of this form. I attest, under penalty of perjury, that the " +
  "information I have provided above and the citizenship or immigration " +
  "status I selected are true and correct.";
const _I9_CONSENT_TEXT =
  _I9_ATTESTATION_TEXT + "  " +
  "I also consent to sign this Form I-9 electronically and agree my " +
  "electronic signature has the same legal effect as a handwritten one. " +
  "I understand this signature is recorded with my name, IP address, " +
  "device information, and a timestamp, and retained as evidence.";

const _I9_CITIZEN_OPTIONS = [
  { v: "citizen",    label: "A citizen of the United States" },
  { v: "national",   label: "A noncitizen national of the United States" },
  { v: "lpr",        label: "A lawful permanent resident" },
  { v: "authorized", label: "A noncitizen authorized to work in the United States" },
];

// Wire a <canvas> signature pad. Returns { hasInk(), dataUrl(), clear() }.
function _i9MountSignaturePad(canvasId, clearId, hintId) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext("2d");
  const hint = document.getElementById(hintId);
  function fit() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width  = Math.round(rect.width  * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = "#0f172a";
  }
  fit();
  let drawing = false, lastX = 0, lastY = 0, hasInk = false;
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    drawing = true; const p = pos(e); lastX = p.x; lastY = p.y; e.preventDefault();
    if (!hasInk && hint) { hint.style.display = "none"; hasInk = true; } else { hasInk = true; }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(p.x, p.y); ctx.stroke();
    lastX = p.x; lastY = p.y;
  });
  const end = () => { drawing = false; };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("pointerleave", end);
  document.getElementById(clearId)?.addEventListener("click", () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height); fit(); hasInk = false;
    if (hint) hint.style.display = "";
  });
  return {
    hasInk: () => hasInk,
    dataUrl: () => canvas.toDataURL("image/png"),
  };
}

const _i9Fld = (id, label, opts = {}) => `
  <label style="display:flex;flex-direction:column;gap:4px;${opts.flex ? `flex:${opts.flex};` : ""}min-width:0">
    <span style="font-size:var(--fs-xs);color:var(--text-muted)">${escapeHtml(label)}${opts.req ? ' <span style="color:var(--red)">*</span>' : ""}</span>
    <input type="${opts.type || "text"}" id="${id}" ${opts.attrs || ""} value="${escapeHtml(opts.value || "")}"
      style="padding:10px 12px;border:1px solid var(--border);border-radius:8px;font:inherit;background:var(--canvas)">
  </label>`;

// Small inline check icon for completed sections.
const _I9_CHECK_SVG = `<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

// One-time inline styles: skeleton pulse, section check chip, field error.
function _i9InjectStyles() {
  if (document.getElementById("i9-inline-styles")) return;
  const st = document.createElement("style");
  st.id = "i9-inline-styles";
  st.textContent =
    "@keyframes i9-pulse{0%,100%{opacity:.5}50%{opacity:.85}}" +
    ".i9-skel{background:var(--border);border-radius:8px;animation:i9-pulse 1.3s ease-in-out infinite}" +
    ".i9-card-check{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:#16a34a;flex:0 0 auto}" +
    ".i9-err-msg{font-size:var(--fs-xs);color:var(--red);margin-top:4px}" +
    "input.i9-err{border-color:var(--red) !important}";
  document.head.appendChild(st);
}

function _i9SkeletonHtml() {
  const card = (lines) => `<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:12px"><div class="i9-skel" style="height:11px;width:38%"></div>${Array.from({ length: lines }).map(() => `<div class="i9-skel" style="height:38px;width:100%"></div>`).join("")}</div>`;
  return `<div style="display:flex;flex-direction:column;gap:16px">
    <div class="i9-skel" style="height:48px;width:100%;border-radius:12px"></div>
    <div style="display:flex;flex-direction:column;gap:6px"><div class="i9-skel" style="height:18px;width:50%"></div><div class="i9-skel" style="height:12px;width:88%"></div></div>
    ${card(2)}${card(3)}${card(2)}${card(4)}${card(1)}
    <div class="i9-skel" style="height:200px;width:100%;border-radius:12px"></div>
    <div class="i9-skel" style="height:44px;width:100%;border-radius:8px"></div>
  </div>`;
}

// The completion screen — checkmark-circle treatment + what-happens-next.
function _i9RenderCompletion(main, rec, session) {
  const onDate = rec.section1_completed_at ? new Date(rec.section1_completed_at).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) : null;
  const fdoe = rec.first_day_of_employment ? new Date(rec.first_day_of_employment + "T00:00:00").toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) : null;
  const onboarding = !!(session && session.status === "onboarding");
  const dest = onboarding ? "/tasks/onboarding" : "/tasks";
  main.innerHTML = `
    <div style="padding:36px 20px 24px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:14px">
      <div style="width:64px;height:64px;border-radius:50%;background:var(--rr-green-100);display:flex;align-items:center;justify-content:center">
        <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="#15803d" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
      <div>
        <div style="font-size:20px;font-weight:700;color:var(--text)">Form I-9 · Section 1 complete</div>
        <div style="margin-top:8px;color:var(--text-muted);font-size:var(--fs-sm);line-height:1.6;max-width:360px">You signed your part of Form I-9${onDate ? ` on ${escapeHtml(onDate)}` : ""}. Nothing else is needed from you here.</div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;text-align:left;font-size:var(--fs-sm);color:var(--text);line-height:1.6;max-width:360px;width:100%">
        <div style="font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted);margin-bottom:6px">What happens next</div>
        Your employer reviews your identity and work-authorization documents and completes Section 2.${fdoe ? ` Bring your documents on your first day of work — <strong>${escapeHtml(fdoe)}</strong>.` : " Bring your documents on your first day of work."}
      </div>
      <button type="button" id="i9-done-back" class="btn btn-primary" style="min-width:200px;margin-top:4px">Back to ${onboarding ? "onboarding" : "tasks"}</button>
    </div>`;
  document.getElementById("i9-done-back")?.addEventListener("click", () => navigate(dest));
}

// The 6 logical sections of Section 1, in order, for the progress header
// + per-card checkmarks. `done` reads the live form state.
const _I9_SECTIONS = [
  { id: "name",    done: (s) => !!(s.last_name && s.first_name) },
  { id: "address", done: (s) => !!(s.addr_street && s.addr_city && s.addr_state && s.addr_zip) },
  { id: "about",   done: (s) => !!s.dob },
  { id: "status",  done: (s) => {
      if (!["citizen", "national", "lpr", "authorized"].includes(s.citizen_status)) return false;
      if (s.citizen_status === "lpr") return !!s.lpr_uscis_number;
      if (s.citizen_status === "authorized") return !!s.auth_doc_number && (s.auth_doc_kind !== "passport" || !!s.auth_passport_country);
      return true;
    } },
  { id: "attest",  done: (s) => !!s._attestChecked },
  { id: "sign",    done: (s) => !!s._sigOk },
];

async function renderI9Section1() {
  const main = document.getElementById("main");
  _i9InjectStyles();
  main.innerHTML = _i9SkeletonHtml();
  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }

  const { data, error } = await sb.rpc("driver_i9_get", { p_token: session.token });
  if (error) {
    if (/unauthorized|revoked|inactive/i.test(error.message || "")) { writeSession(null); render(); return; }
    main.innerHTML = errorStateHtml("Couldn't load Form I-9", error);
    return;
  }
  const rec = data?.record || {};
  const pre = data?.prefill || {};
  const s1  = rec.section1 && typeof rec.section1 === "object" ? rec.section1 : {};
  const submitted = rec.status && rec.status !== "not_started" && rec.status !== "needs_correction";

  if (submitted) { _i9RenderCompletion(main, rec, session); return; }

  const v = (k, fallback = "") => escapeHtml(s1[k] != null && s1[k] !== "" ? String(s1[k]) : fallback);
  const cs = s1.citizen_status || "";
  const fdoe = rec.first_day_of_employment ? new Date(rec.first_day_of_employment + "T00:00:00").toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) : null;
  // Section-card header: an uppercase title + a checkmark chip that shows
  // once that section is complete.
  const head = (id, title, reqStar) => `<div style="display:flex;align-items:center;gap:8px"><div style="flex:1;font-size:var(--fs-xs);font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted)">${escapeHtml(title)}${reqStar ? ' <span style="color:var(--red)">*</span>' : ""}</div><span class="i9-card-check" data-i9-check="${id}" style="display:none">${_I9_CHECK_SVG}</span></div>`;
  const cardOpen = (id, extra = "") => `<div data-i9-card="${id}" style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:12px;${extra}">`;

  main.innerHTML = `
    <div data-i9-progress style="position:sticky;top:0;z-index:3;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:10px 14px;box-shadow:0 2px 10px rgba(15,23,42,.07)">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <span style="font-size:var(--fs-sm);font-weight:600;color:var(--text)">Form I-9 · Section 1</span>
        <span data-i9-count style="font-size:var(--fs-xs);color:var(--text-muted);font-weight:600">0 of 6 sections</span>
      </div>
      <div style="margin-top:7px;height:4px;border-radius:999px;background:var(--border);overflow:hidden"><div data-i9-bar style="height:100%;width:0%;background:var(--accent);transition:width .25s ease;border-radius:999px"></div></div>
    </div>

    <div style="padding:14px 0 110px 0;display:flex;flex-direction:column;gap:16px">
      <div>
        <div style="margin-top:2px;color:var(--text-muted);font-size:var(--fs-sm);line-height:1.55">
          Employee Information and Attestation. Federal law requires every employee to complete this part by their first day of work${fdoe ? ` — yours is <strong>${escapeHtml(fdoe)}</strong>` : ""}.
        </div>
      </div>

      ${rec.status === "needs_correction" ? `
        <div style="background:var(--rr-red-50);border:1px solid var(--rr-red-200);border-radius:12px;padding:12px 14px;font-size:var(--fs-sm);color:var(--rr-red-800);line-height:1.5">
          <strong>Your employer asked for a correction.</strong>${rec.needs_correction_note ? `<div style="margin-top:4px">${escapeHtml(rec.needs_correction_note)}</div>` : ""}
        </div>` : ""}

      ${cardOpen("name")}
        ${head("name", "Your legal name")}
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${_i9Fld("i9-last", "Last name (family name)", { req: true, flex: "1 1 140px", value: v("last_name", pre.last_name || "") })}
          ${_i9Fld("i9-first", "First name (given name)", { req: true, flex: "1 1 140px", value: v("first_name", pre.first_name || "") })}
          ${_i9Fld("i9-mi", "Middle initial", { flex: "0 1 90px", attrs: 'maxlength="3"', value: v("middle_initial") })}
        </div>
        ${_i9Fld("i9-other", "Other last names used (if any)", { value: v("other_last_names") })}
      </div>

      ${cardOpen("address")}
        ${head("address", "Address")}
        ${pre.address_on_file ? `<div style="font-size:var(--fs-xs);color:var(--text-subtle)">On file with your employer: ${escapeHtml(pre.address_on_file)}</div>` : ""}
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${_i9Fld("i9-street", "Street number and name", { req: true, flex: "1 1 200px", value: v("addr_street") })}
          ${_i9Fld("i9-apt", "Apt. number", { flex: "0 1 100px", value: v("addr_apt") })}
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${_i9Fld("i9-city", "City or town", { req: true, flex: "1 1 160px", value: v("addr_city") })}
          ${_i9Fld("i9-state", "State", { req: true, flex: "0 1 90px", attrs: 'maxlength="2" autocapitalize="characters" placeholder="WA"', value: v("addr_state") })}
          ${_i9Fld("i9-zip", "ZIP code", { req: true, flex: "0 1 120px", attrs: 'inputmode="numeric" maxlength="10"', value: v("addr_zip") })}
        </div>
      </div>

      ${cardOpen("about")}
        ${head("about", "About you")}
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${_i9Fld("i9-dob", "Date of birth", { req: true, type: "date", flex: "1 1 150px", value: v("dob", pre.dob_on_file || "") })}
          ${_i9Fld("i9-ssn", "U.S. Social Security Number", { flex: "1 1 150px", attrs: 'inputmode="numeric" placeholder="optional" maxlength="11"', value: v("ssn") })}
        </div>
        <div style="font-size:var(--fs-xs);color:var(--text-subtle)">Your Social Security Number is optional unless your employer participates in E-Verify.</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${_i9Fld("i9-email", "Email address", { type: "email", flex: "1 1 180px", attrs: 'autocomplete="email"', value: v("email", pre.email || "") })}
          ${_i9Fld("i9-phone", "Telephone number", { type: "tel", flex: "1 1 150px", attrs: 'autocomplete="tel"', value: v("phone", pre.phone || "") })}
        </div>
      </div>

      ${cardOpen("status")}
        ${head("status", "Citizenship / immigration status", true)}
        <div style="font-size:var(--fs-xs);color:var(--text-subtle)">Select the one option that applies to you.</div>
        ${_I9_CITIZEN_OPTIONS.map((o, i) => `
          <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;padding:8px 0;border-bottom:${i < 3 ? "1px solid var(--border)" : "none"}">
            <input type="radio" name="i9-cs" value="${o.v}" ${cs === o.v ? "checked" : ""} style="margin-top:2px;width:18px;height:18px;accent-color:var(--accent);flex:0 0 auto">
            <span style="font-size:var(--fs-sm);line-height:1.45;color:var(--text)">${i + 1}. ${escapeHtml(o.label)}</span>
          </label>`).join("")}

        <div id="i9-lpr-box" style="display:${cs === "lpr" ? "block" : "none"};margin-top:6px">
          ${_i9Fld("i9-lpr-num", "USCIS / Alien Registration Number (A-Number)", { req: true, attrs: 'placeholder="A-000000000"', value: v("lpr_uscis_number") })}
        </div>

        <div id="i9-auth-box" style="display:${cs === "authorized" ? "flex" : "none"};margin-top:6px;flex-direction:column;gap:10px">
          ${_i9Fld("i9-auth-exp", "Work authorization expires on (enter N/A if it doesn't)", { attrs: 'placeholder="MM/DD/YYYY or N/A"', value: v("auth_expires") })}
          <div style="font-size:var(--fs-xs);color:var(--text-muted)">Provide one of the following document numbers:</div>
          <label style="display:flex;align-items:center;gap:8px;font-size:var(--fs-sm);color:var(--text);cursor:pointer"><input type="radio" name="i9-authkind" value="uscis" ${(s1.auth_doc_kind || "uscis") === "uscis" ? "checked" : ""} style="accent-color:var(--accent)"> USCIS / A-Number</label>
          <label style="display:flex;align-items:center;gap:8px;font-size:var(--fs-sm);color:var(--text);cursor:pointer"><input type="radio" name="i9-authkind" value="i94" ${s1.auth_doc_kind === "i94" ? "checked" : ""} style="accent-color:var(--accent)"> Form I-94 Admission Number</label>
          <label style="display:flex;align-items:center;gap:8px;font-size:var(--fs-sm);color:var(--text);cursor:pointer"><input type="radio" name="i9-authkind" value="passport" ${s1.auth_doc_kind === "passport" ? "checked" : ""} style="accent-color:var(--accent)"> Foreign passport number</label>
          ${_i9Fld("i9-auth-num", "Document number", { req: true, value: v("auth_doc_number") })}
          <div id="i9-auth-country-box" style="display:${s1.auth_doc_kind === "passport" ? "block" : "none"}">
            ${_i9Fld("i9-auth-country", "Country of issuance", { req: true, value: v("auth_passport_country") })}
          </div>
        </div>
      </div>

      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px">
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
          <input type="checkbox" id="i9-no-preparer" ${s1.preparer_used ? "" : "checked"} style="margin-top:3px;width:18px;height:18px;accent-color:var(--accent);flex:0 0 auto">
          <span style="font-size:var(--fs-sm);line-height:1.5;color:var(--text)">I did not use a preparer or translator to complete this form.</span>
        </label>
        <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:6px">If someone helped you, uncheck this — your employer will collect their information separately.</div>
      </div>

      ${cardOpen("attest", "gap:10px")}
        ${head("attest", "Attestation")}
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
          <input type="checkbox" id="i9-attest" style="margin-top:3px;width:18px;height:18px;accent-color:var(--accent);flex:0 0 auto">
          <span style="font-size:var(--fs-sm);line-height:1.55;color:var(--text)">${escapeHtml(_I9_CONSENT_TEXT)}</span>
        </label>
      </div>

      <div data-i9-card="sign">
        <div style="font-size:var(--fs-xs);font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px">Review &amp; sign</div>
        <div style="background:var(--canvas);border:1px dashed var(--border);border-radius:10px;padding:12px 14px;font-size:var(--fs-sm);line-height:1.6;color:var(--text);margin-bottom:12px">
          <div><span style="color:var(--text-muted);display:inline-block;min-width:62px">Name</span><span data-i9-recap="name">—</span></div>
          <div><span style="color:var(--text-muted);display:inline-block;min-width:62px">Address</span><span data-i9-recap="addr">—</span></div>
          <div><span style="color:var(--text-muted);display:inline-block;min-width:62px">Status</span><span data-i9-recap="status">—</span></div>
          <div style="color:var(--text-subtle);font-size:var(--fs-xs);margin-top:6px">Check these are right, then sign below.</div>
        </div>
        <div style="position:relative;background:var(--rr-white);border:1px solid var(--border);border-radius:12px;overflow:hidden">
          <canvas id="i9-sig-canvas" style="display:block;width:100%;height:200px;background:var(--rr-white);touch-action:none;cursor:crosshair"></canvas>
          <button type="button" id="i9-sig-clear" style="position:absolute;top:8px;right:8px;background:var(--rr-slate-100);border:1px solid var(--rr-slate-300);border-radius:999px;padding:4px 10px;font:inherit;font-size:11px;font-weight:600;color:var(--rr-slate-600);cursor:pointer">Clear</button>
          <div id="i9-sig-hint" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);color:var(--rr-slate-400);font-size:var(--fs-xs);pointer-events:none">Draw your signature with your finger or mouse</div>
        </div>
        <label style="display:flex;flex-direction:column;gap:4px;margin-top:10px">
          <span style="font-size:var(--fs-xs);font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted)">Or type your full legal name</span>
          <input type="text" id="i9-sig-typed" placeholder="Your full legal name" autocomplete="name" style="padding:10px 12px;border:1px solid var(--border);border-radius:8px;font:inherit;background:var(--canvas)">
        </label>
      </div>

      <div style="display:flex;gap:8px">
        <button type="button" id="i9-save" class="btn" style="background:transparent;color:var(--text);border:1px solid var(--border)">Save draft</button>
        <button type="button" id="i9-submit" class="btn btn-primary" style="flex:1">Submit &amp; sign</button>
      </div>
      <div style="font-size:var(--fs-xs);color:var(--text-subtle);text-align:center;line-height:1.5">
        This is not legal advice. Your submission is recorded on Form I-9 by your employer.
      </div>
    </div>`;

  // Show/hide the conditional blocks as the citizenship choice changes.
  const lprBox = document.getElementById("i9-lpr-box");
  const authBox = document.getElementById("i9-auth-box");
  const syncCs = () => {
    const val = main.querySelector('input[name="i9-cs"]:checked')?.value || "";
    lprBox.style.display  = val === "lpr" ? "block" : "none";
    authBox.style.display = val === "authorized" ? "flex" : "none";
  };
  main.querySelectorAll('input[name="i9-cs"]').forEach((r) => r.addEventListener("change", syncCs));
  const authCountryBox = document.getElementById("i9-auth-country-box");
  main.querySelectorAll('input[name="i9-authkind"]').forEach((r) => r.addEventListener("change", () => {
    authCountryBox.style.display = (main.querySelector('input[name="i9-authkind"]:checked')?.value === "passport") ? "block" : "none";
  }));

  const sig = _i9MountSignaturePad("i9-sig-canvas", "i9-sig-clear", "i9-sig-hint");

  function collect() {
    const csChoice = main.querySelector('input[name="i9-cs"]:checked')?.value || "";
    const authKind = main.querySelector('input[name="i9-authkind"]:checked')?.value || "uscis";
    const g = (id) => (document.getElementById(id)?.value || "").trim();
    return {
      last_name: g("i9-last"), first_name: g("i9-first"), middle_initial: g("i9-mi"), other_last_names: g("i9-other"),
      addr_street: g("i9-street"), addr_apt: g("i9-apt"), addr_city: g("i9-city"),
      addr_state: g("i9-state").toUpperCase(), addr_zip: g("i9-zip"),
      dob: g("i9-dob"), ssn: g("i9-ssn"), email: g("i9-email"), phone: g("i9-phone"),
      citizen_status: csChoice,
      lpr_uscis_number: csChoice === "lpr" ? g("i9-lpr-num") : "",
      auth_expires: csChoice === "authorized" ? g("i9-auth-exp") : "",
      auth_doc_kind: csChoice === "authorized" ? authKind : "",
      auth_doc_number: csChoice === "authorized" ? g("i9-auth-num") : "",
      auth_passport_country: csChoice === "authorized" && authKind === "passport" ? g("i9-auth-country") : "",
      preparer_used: !document.getElementById("i9-no-preparer")?.checked,
    };
  }

  const sigState = () => {
    const typed = (document.getElementById("i9-sig-typed")?.value || "").trim();
    return sig.hasInk() || typed.length >= 2;
  };

  // Live progress: section count, the bar, per-card checkmarks, recap.
  const recapName = (s) => [s.first_name, s.middle_initial && (s.middle_initial + "."), s.last_name].filter(Boolean).join(" ").trim();
  const recapAddr = (s) => { const a = [s.addr_street, s.addr_apt && ("Apt " + s.addr_apt)].filter(Boolean).join(", "); const b = [s.addr_city, [s.addr_state, s.addr_zip].filter(Boolean).join(" ")].filter(Boolean).join(", "); return [a, b].filter(Boolean).join(", "); };
  const recapStatus = (s) => { const o = _I9_CITIZEN_OPTIONS.find((x) => x.v === s.citizen_status); return o ? o.label : ""; };
  function updateProgress() {
    const s = collect();
    s._attestChecked = !!document.getElementById("i9-attest")?.checked;
    s._sigOk = sigState();
    let done = 0;
    for (const sec of _I9_SECTIONS) {
      const ok = sec.done(s);
      if (ok) done++;
      const chk = main.querySelector(`[data-i9-check="${sec.id}"]`);
      if (chk) chk.style.display = ok ? "inline-flex" : "none";
    }
    const cnt = main.querySelector("[data-i9-count]");
    if (cnt) cnt.textContent = `${done} of ${_I9_SECTIONS.length} sections`;
    const bar = main.querySelector("[data-i9-bar]");
    if (bar) bar.style.width = Math.round((done / _I9_SECTIONS.length) * 100) + "%";
    const setRecap = (k, val) => { const el = main.querySelector(`[data-i9-recap="${k}"]`); if (el) { el.textContent = val || "—"; el.style.color = val ? "var(--text)" : "var(--text-subtle)"; } };
    setRecap("name", recapName(s));
    setRecap("addr", recapAddr(s));
    setRecap("status", recapStatus(s));
  }
  main.querySelectorAll("input, select").forEach((el) => {
    el.addEventListener("input", () => { el.classList.remove("i9-err"); el.parentElement?.querySelector(".i9-err-msg")?.remove(); updateProgress(); });
    el.addEventListener("change", updateProgress);
  });
  document.getElementById("i9-sig-canvas")?.addEventListener("pointerup", updateProgress);
  document.getElementById("i9-sig-clear")?.addEventListener("click", () => setTimeout(updateProgress, 0));
  updateProgress();

  // Inline required-field errors on submit.
  function clearErrors() {
    main.querySelectorAll("input.i9-err").forEach((i) => i.classList.remove("i9-err"));
    main.querySelectorAll(".i9-err-msg").forEach((e) => e.remove());
  }
  function fieldError(id, msg) {
    const inp = document.getElementById(id);
    if (!inp) return null;
    inp.classList.add("i9-err");
    if (!inp.parentElement.querySelector(".i9-err-msg")) {
      const e = document.createElement("div");
      e.className = "i9-err-msg"; e.textContent = msg;
      inp.parentElement.appendChild(e);
    }
    return inp;
  }
  function scrollToCard(id) { main.querySelector(`[data-i9-card="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }); }

  // Returns the first thing to fix, as {focus} (a node to scroll to), or null.
  function firstProblem(s) {
    const req = [
      ["i9-last", s.last_name, "Enter your last name"],
      ["i9-first", s.first_name, "Enter your first name"],
      ["i9-street", s.addr_street, "Enter your street address"],
      ["i9-city", s.addr_city, "Enter your city or town"],
      ["i9-state", s.addr_state, "Enter your state"],
      ["i9-zip", s.addr_zip, "Enter your ZIP code"],
      ["i9-dob", s.dob, "Enter your date of birth"],
    ];
    let firstNode = null;
    for (const [id, val, msg] of req) { if (!val) { const n = fieldError(id, msg); if (!firstNode) firstNode = n; } }
    if (firstNode) return { focus: firstNode };
    // State must be 2-letter alpha — accept any case, normalize to upper.
    if (!/^[A-Z]{2}$/.test(s.addr_state)) return { focus: fieldError("i9-state", "Use the 2-letter state code (e.g. NC)") };
    // SSN is optional unless the employer uses E-Verify, but if the
    // driver provided one, it must be a valid format. Accept digits-only
    // or XXX-XX-XXXX with hyphens.
    if (s.ssn && !/^\d{3}-?\d{2}-?\d{4}$/.test(s.ssn)) return { focus: fieldError("i9-ssn", "Enter your SSN as 9 digits (e.g. 123-45-6789)") };
    if (!["citizen", "national", "lpr", "authorized"].includes(s.citizen_status)) { toast("Select your citizenship or immigration status.", "warn"); return { focus: main.querySelector('[data-i9-card="status"]') }; }
    if (s.citizen_status === "lpr" && !s.lpr_uscis_number) return { focus: fieldError("i9-lpr-num", "Enter your USCIS / A-Number") };
    if (s.citizen_status === "authorized" && !s.auth_doc_number) return { focus: fieldError("i9-auth-num", "Enter a work-authorization document number") };
    // Work-authorization expires must be a real date when provided —
    // free-text was slipping through and breaking the reverification
    // clock on the operator side. Allow blank (USCIS allows "N/A" for
    // certain refugee/asylee cases, captured separately as a checkbox
    // upstream if needed); reject obviously invalid strings.
    if (s.citizen_status === "authorized" && s.auth_expires) {
      const d = new Date(s.auth_expires + "T00:00:00");
      if (isNaN(d.getTime())) return { focus: fieldError("i9-auth-exp", "Enter the expiration as MM/DD/YYYY") };
    }
    if (s.citizen_status === "authorized" && s.auth_doc_kind === "passport" && !s.auth_passport_country) return { focus: fieldError("i9-auth-country", "Enter the passport's country of issuance") };
    return null;
  }

  document.getElementById("i9-save").addEventListener("click", async () => {
    const btn = document.getElementById("i9-save");
    btn.disabled = true; btn.textContent = "Saving…";
    const { error: err } = await sb.rpc("driver_i9_save_section1", { p_token: session.token, p_section1: collect() });
    btn.disabled = false; btn.textContent = "Save draft";
    if (err) {
      console.error("driver_i9_save_section1 failed:", err);
      toast(_friendlyError(err, "Couldn't save. Try again."), "warn"); return;
    }
    toast("Draft saved", "ok");
  });

  document.getElementById("i9-submit").addEventListener("click", async () => {
    clearErrors();
    const s = collect();
    const problem = firstProblem(s);
    if (problem) { if (problem.focus) { problem.focus.scrollIntoView({ behavior: "smooth", block: "center" }); if (typeof problem.focus.focus === "function" && problem.focus.tagName === "INPUT") setTimeout(() => problem.focus.focus(), 250); } else toast("Please complete the highlighted fields.", "warn"); return; }
    if (!document.getElementById("i9-attest")?.checked) { toast("Please read and accept the attestation to sign.", "warn"); scrollToCard("attest"); return; }
    const typed = (document.getElementById("i9-sig-typed").value || "").trim();
    let method = null, sigData = null;
    if (sig.hasInk()) { method = "drawn"; sigData = sig.dataUrl(); }
    else if (typed.length >= 2) { method = "typed"; sigData = typed; }
    else { toast("Draw your signature or type your full legal name.", "warn"); scrollToCard("sign"); return; }
    const signerName = typed || session.name || `${s.first_name} ${s.last_name}`.trim();

    const btn = document.getElementById("i9-submit");
    btn.disabled = true; btn.textContent = "Submitting…";
    if (navigator.vibrate) { try { navigator.vibrate(8); } catch {} }
    const { error: err } = await sb.rpc("driver_i9_submit_section1", {
      p_token:           session.token,
      p_section1:        s,
      p_signature:       { method, data: sigData, signer_name: signerName },
      p_consent_version: _I9_CONSENT_VERSION,
      p_consent_text:    _I9_CONSENT_TEXT,
      p_ip:              null,
      p_user_agent:      navigator.userAgent || null,
    });
    if (err) {
      // The friendly toast hides the real reason behind a generic "Couldn't
      // submit. Try again." Log the full error to console so a tester with
      // DevTools open can see what actually went wrong (Postgres error
      // code, RPC message, network status).
      console.error("driver_i9_submit_section1 failed:", err);
      btn.disabled = false; btn.textContent = "Submit & sign";
      toast(_friendlyError(err, "Couldn't submit. Try again."), "warn"); return;
    }
    if (navigator.vibrate) { try { navigator.vibrate([10, 40, 10]); } catch {} }
    _i9RenderCompletion(main, { ...rec, status: "section1_complete", section1_completed_at: new Date().toISOString() }, session);
  });
}

// ── Operational assignments — driver "My Tasks" cards (migration 0183) ─
// driver_assignments_list / driver_assignment_acknowledge.  A row
// assigned to this driver shows as a card with a completion action; the
// button label and whether a photo / note is asked for or required come
// from the board's config.  Photos go to the driver-documents bucket
// (same as the licence-photo flow), then the path is handed to the ack
// RPC, which enforces the requirement, flips the row's status, and logs
// `completed` to the board's audit trail.
let _wtData  = {};   // rowId → assignment object
let _wtPhoto = {};   // rowId → uploaded storage path (this session)

function _wtCfg(a) { return (a && a.config && typeof a.config === "object") ? a.config : {}; }
function _wtFmtDue(s) {
  if (!s) return "";
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? s + "T00:00:00" : s);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function _wtOverdue(s) {
  if (!s) return false;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? s + "T23:59:59" : s);
  return !isNaN(d.getTime()) && d.getTime() < Date.now();
}
function _wtCardHtml(a) {
  _wtData[a.row_id] = a;
  const cfg = _wtCfg(a);
  const dueTxt = _wtFmtDue(a.due_date);
  const sub = [escapeHtml(String(a.board_name || "")), dueTxt ? `due ${escapeHtml(dueTxt)}` : ""].filter(Boolean).join(" · ");
  const label = escapeHtml(String(cfg.completion_label || "Mark done"));
  return `<div class="wt-card" data-wt-row="${escapeHtml(a.row_id)}">
    <div class="wt-card-main">
      <div class="wt-card-title${_wtOverdue(a.due_date) ? " overdue" : ""}">${escapeHtml(String(a.item_label || a.board_name || "Task"))}</div>
      <div class="wt-card-sub">${sub}${a.status ? `${sub ? " · " : ""}<span class="wt-status">${escapeHtml(String(a.status))}</span>` : ""}</div>
    </div>
    <button type="button" class="btn btn-primary btn-sm wt-cta" data-wt-go>${label}</button>
    <div class="wt-form" hidden></div>
  </div>`;
}
function _wtBindSlot(slot) {
  if (slot.dataset.rrWtBound) return; slot.dataset.rrWtBound = "1";
  slot.addEventListener("click", (e) => {
    const card = e.target.closest(".wt-card"); if (!card) return;
    if (e.target.closest("[data-wt-go]"))     { _wtOpenComplete(card); return; }
    if (e.target.closest("[data-wt-submit]")) { _wtSubmit(card, {}); return; }
    if (e.target.closest("[data-wt-cancel]")) { _wtCloseComplete(card); return; }
  });
  slot.addEventListener("change", (e) => {
    const fi = e.target.closest("[data-wt-photo-input]");
    if (fi && fi.files && fi.files[0]) _wtUploadPhoto(fi.closest(".wt-card"), fi.files[0]);
  });
}
function _wtOpenComplete(card) {
  const a = _wtData[card.getAttribute("data-wt-row")]; if (!a) return;
  const cfg = _wtCfg(a);
  const wantPhoto = cfg.require_photo === "required" || cfg.require_photo === "optional";
  const wantNote  = cfg.require_note  === "required" || cfg.require_note  === "optional";
  if (!wantPhoto && !wantNote) { _wtSubmit(card, { photoPath: null, note: null }); return; }
  const needPhoto = cfg.require_photo === "required";
  const needNote  = cfg.require_note  === "required";
  const label = escapeHtml(String(cfg.completion_label || "Mark done"));
  const cta = card.querySelector("[data-wt-go]"); if (cta) cta.style.display = "none";
  const form = card.querySelector(".wt-form");
  form.innerHTML = `
    ${wantPhoto ? `<label class="wt-photo"><input type="file" accept="image/*" capture="environment" data-wt-photo-input style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none"><span class="wt-photo-btn"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>${needPhoto ? "Photo required" : "Add a photo"}</span><span class="wt-photo-state"></span></label>` : ""}
    ${wantNote ? `<textarea class="field wt-note" data-wt-note rows="2" placeholder="${needNote ? "Add a note (required)" : "Add a note (optional)"}"></textarea>` : ""}
    <div class="wt-form-actions"><button type="button" class="btn btn-sm" data-wt-cancel>Cancel</button><button type="button" class="btn btn-sm btn-primary" data-wt-submit>${label}</button></div>`;
  form.hidden = false;
}
function _wtCloseComplete(card) {
  delete _wtPhoto[card.getAttribute("data-wt-row")];
  const form = card.querySelector(".wt-form"); if (form) { form.innerHTML = ""; form.hidden = true; }
  const cta = card.querySelector("[data-wt-go]"); if (cta) cta.style.display = "";
}
async function _wtUploadPhoto(card, file) {
  const session = readSession(); if (!session?.token) return;
  const rowId = card.getAttribute("data-wt-row");
  const stateEl = card.querySelector(".wt-photo-state");
  if (stateEl) stateEl.textContent = "Uploading…";
  const dspId = session.dsp_id || "x", drvId = session.driver_id || "x";
  const ext = ((file.name || "").split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6) || "jpg";
  const path = `${dspId}/${drvId}/assignment-${rowId}-${Date.now()}.${ext}`;
  const { error } = await sb.storage.from("driver-documents").upload(path, file, { contentType: file.type || "image/jpeg", upsert: true });
  if (error) { delete _wtPhoto[rowId]; if (stateEl) stateEl.textContent = "Couldn't upload — tap to retry"; return; }
  _wtPhoto[rowId] = path;
  if (stateEl) stateEl.textContent = "✓ Photo attached";
}
async function _wtSubmit(card, opts) {
  opts = opts || {};
  const session = readSession(); if (!session?.token) { writeSession(null); render(); return; }
  const rowId = card.getAttribute("data-wt-row");
  const a = _wtData[rowId]; if (!a) return;
  const cfg = _wtCfg(a);
  const noteEl = card.querySelector("[data-wt-note]");
  const note = (opts.note !== undefined) ? opts.note : (noteEl ? String(noteEl.value || "").trim() : "");
  const photoPath = (opts.photoPath !== undefined) ? opts.photoPath : (_wtPhoto[rowId] || null);
  if (cfg.require_note === "required" && !note) { toast("A note is required to complete this.", "warn"); if (noteEl) noteEl.focus(); return; }
  if (cfg.require_photo === "required" && !photoPath) { toast("A photo is required to complete this.", "warn"); return; }
  const submitBtn = card.querySelector("[data-wt-submit]");
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Saving…"; }
  const { error } = await sb.rpc("driver_assignment_acknowledge", { p_token: session.token, p_row_id: rowId, p_photo_path: photoPath || null, p_note: note || null });
  if (error) {
    if (/unauthorized|revoked|inactive/i.test(error.message || "")) { writeSession(null); render(); return; }
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = String(cfg.completion_label || "Mark done"); }
    toast(_friendlyError(error, "Couldn't complete. Try again."), "warn"); return;
  }
  if (navigator.vibrate) { try { navigator.vibrate(15); } catch {} }
  toast("Done — nice work ✓", "success");
  delete _wtPhoto[rowId]; delete _wtData[rowId];
  card.classList.add("wt-done");
  card.innerHTML = `<div class="wt-card-main"><div class="wt-card-title done">${escapeHtml(String(a.item_label || "Task"))}</div><div class="wt-card-sub">Completed</div></div><span class="wt-check"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>`;
  setTimeout(() => { card.remove(); _wtRefreshSec(); }, 1500);
}
function _wtRefreshSec() {
  const slot = document.getElementById("rr-tasks-assignments-slot");
  if (!slot) return;
  const n = slot.querySelectorAll(".wt-card:not(.wt-done)").length;
  if (n <= 0) { slot.innerHTML = ""; return; }
  const nEl = slot.querySelector(".wt-sec-n"); if (nEl) nEl.textContent = String(n);
}




// ═══════════════════════════════════════════════════════════════════
// RECOGNITION CELEBRATION · v121 — ROUTE-BASED ARCHITECTURE
// ═══════════════════════════════════════════════════════════════════
// After multiple iterations of JS-event-handler-based dismiss flows
// failed on iOS PWA standalone mode (per-button listeners, capture-
// phase document delegation, inline onclick attributes, window-global
// fallbacks, and overlay tap-anywhere backstops ALL failed to fire),
// the celebration is now a dedicated route (#/welcome) instead of a
// floating overlay.
//
// Why this can't fail:
//
//   - The "Start my day" CTA is a plain <a href="#/schedule"> anchor.
//     iOS native browser navigation on an anchor tap is rock-solid —
//     no JS event handler is involved in the dismiss path at all.
//     The hash changes, the router re-fires, the celebration view is
//     unmounted naturally as the next route's render replaces #main.
//
//   - The dismiss RPC + sessionStorage flag are fired from a
//     hashchange listener that detects "leaving /welcome" — guaranteed
//     to run because hashchange is what the router itself listens to.
//
//   - The celebration view paints multiple anchor exits (CTA, close X,
//     and a full-screen tap-anywhere backdrop). All three are anchor
//     tags pointing at #/schedule. Any tap outside the white card,
//     anywhere on the gradient, dismisses.
//
//   - There is no pre-paint backdrop / early RPC kickoff race — the
//     celebration only paints when the /welcome route is active, so
//     there's no lifecycle window where a stale backdrop can sit on
//     top of a removed overlay.

// Module-level stash for the pending event the router will render.
// checkAndShowPendingRecognition fetches the event and stashes it
// here, then calls navigate("/welcome").  The /welcome route's
// render function reads from these.
let _currentCelebrationEv      = null;
let _currentCelebrationSession = null;

// Client-side dismissed set, persisted to sessionStorage so a hot
// reload mid-session (iOS aggressively recycles PWA shells) doesn't
// re-paint a just-dismissed celebration before the server-side
// dismissed_at write has propagated.
// Persisted to LOCALSTORAGE (not session) so dismissed celebrations
// stay dismissed across full app launches.  iOS PWAs clear sessionStorage
// on full close — without localStorage persistence, a celebration whose
// dismiss-RPC was in-flight when the user closed the app would re-show
// on next open.  Bounded to last 200 ids to keep storage small.
const _RECOG_DISMISSED_KEY = "rr.recogDismissed";
const _recogDismissedIds = new Set();
try {
  const fromLocal   = localStorage.getItem(_RECOG_DISMISSED_KEY);
  const fromSession = sessionStorage.getItem(_RECOG_DISMISSED_KEY);   // migrate any old session-only state
  if (fromLocal)   JSON.parse(fromLocal).forEach((id) => _recogDismissedIds.add(id));
  if (fromSession) JSON.parse(fromSession).forEach((id) => _recogDismissedIds.add(id));
  // Persist immediately if we just migrated from session.
  if (!fromLocal && fromSession) localStorage.setItem(_RECOG_DISMISSED_KEY, JSON.stringify([..._recogDismissedIds]));
} catch (_) {}
function _markRecogDismissed(id) {
  if (!id) return;
  _recogDismissedIds.add(id);
  try {
    // Cap stored size — keep most recent 200.  Iteration order on Set
    // is insertion order, so slicing the tail keeps the freshest.
    const all = [..._recogDismissedIds];
    const trimmed = all.length > 200 ? all.slice(all.length - 200) : all;
    localStorage.setItem(_RECOG_DISMISSED_KEY, JSON.stringify(trimmed));
  } catch (_) {}
}

// ── Foreground re-check ─────────────────────────────────────────────
// iOS PWA / Safari bfcache keep the JS process alive across
// suspend/resume.  These listeners re-run the pending-event check
// when the app returns to the foreground.
function _recheckRecognitionOnForeground() {
  try {
    const session = (typeof readSession === "function") ? readSession() : null;
    if (!session || !session.token) return;
    checkAndShowPendingRecognition(session).catch(() => {});
  } catch (_) {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") _recheckRecognitionOnForeground();
});
window.addEventListener("pageshow", _recheckRecognitionOnForeground);
window.addEventListener("focus",    _recheckRecognitionOnForeground);

// ── checkAndShowPendingRecognition ──────────────────────────────────
// Fetches the pending event; if one is queued (and not already shown /
// dismissed), stashes it on the module-level vars and navigates to
// /welcome.  The router renders the celebration view from the stash.
async function checkAndShowPendingRecognition(session) {
  if (!session || !session.token) return;
  // Already on /welcome with an event in the stash — nothing to do.
  if (currentRoute() === "/welcome" && _currentCelebrationEv) return;
  // Legacy session cap cleanup — iOS PWA can persist sessionStorage
  // across full app close.  Strip the stale key so anyone upgrading
  // from a pre-v124 build is freed on first load.
  try { sessionStorage.removeItem("rr.recogShownThisSession"); } catch (_) {}

  // STALE HEAD-OF-LINE RECONCILIATION (the actual root cause of "Halloween
  // never shows after I dismissed Welcome"):
  //
  // The pending RPC returns the OLDEST sent-but-not-dismissed row.  If a
  // previous dismiss RPC failed (easy to hit on iOS PWA — the dismiss is
  // fire-and-forget right before a hash navigation, and iOS frequently
  // cancels in-flight fetches when the page transitions), the row stays
  // sent_at + dismissed_at=null on the server forever.  The client knows
  // it was dismissed (it's in _recogDismissedIds, localStorage-persisted),
  // so checkAndShowPendingRecognition returns early — and every newer
  // celebration sits behind that stale row forever.
  //
  // Fix: when the pending RPC returns an id that's already in the
  // dismissed-set, RECONCILE — re-issue the dismiss RPC and ask again.
  // Walks past stale rows until a genuinely new event surfaces, or up to
  // 5 hops (bounded to avoid runaway loops if the server keeps failing).
  const reconciledIds = new Set();
  for (let attempt = 0; attempt < 5; attempt++) {
    let r;
    try {
      r = await sb.rpc("driver_recognitions_pending", { p_token: session.token });
    } catch (e) { console.warn("[recog] rpc threw:", e?.message); return; }
    if (r.error) { console.warn("[recog] rpc error:", r.error.message); return; }
    const ev = r.data;
    if (!ev || !ev.id) return;

    if (_recogDismissedIds.has(ev.id)) {
      if (reconciledIds.has(ev.id)) return;        // dismiss RPC keeps failing → give up
      reconciledIds.add(ev.id);
      try {
        const dismissed = await sb.rpc("driver_recognition_dismiss", { p_token: session.token, p_id: ev.id });
        if (dismissed?.error) {
          console.warn("[recog] stale-dismiss reconcile failed:", dismissed.error.message);
          return;
        }
      } catch (e) {
        console.warn("[recog] stale-dismiss reconcile failed:", e?.message);
        return;
      }
      continue;     // ask the RPC again — should now return the next row
    }

    // Genuinely new event — stash and navigate.  The /welcome route's
    // render reads from the module-level vars.  No JS handlers needed
    // for the dismiss path — the user taps an anchor and the hash
    // changes; the router does the rest.
    _currentCelebrationEv      = ev;
    _currentCelebrationSession = session;
    navigate("/welcome");
    return;
  }
}

// ── _recogTheme ─────────────────────────────────────────────────────
// Per-kind theming for the celebration overlay.  Each entry supplies:
//   • badge      — inline SVG painted inside the hex badge (24x24 vbox)
//   • gradient   — CSS background for #rr-celebration-route
//   • badgeBg    — CSS background for the .rrc-badge hex
//   • palette    — confetti color array
//   • defaultTitle / defaultMessage / defaultCta / defaultFooter
// Unknown kinds fall through to a friendly "welcome" default so the
// route never paints blank.  All copy is intentionally short — these
// drive a one-screen takeover, not a long-form note.
function _recogTheme(kind) {
  // Reusable SVG snippets (24x24 viewBox, stroke-based for crispness).
  const svg = {
    welcome:    '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    cake:       '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8"/><path d="M4 16h16"/><path d="M2 21h20"/><path d="M12 4v3"/><path d="M8 4v3"/><path d="M16 4v3"/></svg>',
    trophy:     '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4a2 2 0 0 1-2-2V5h4"/><path d="M18 9h2a2 2 0 0 0 2-2V5h-4"/><path d="M6 5v6a6 6 0 0 0 12 0V5z"/><path d="M9 21h6"/><path d="M12 17v4"/></svg>',
    sparkle:    '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6"/><path d="M12 16v6"/><path d="M2 12h6"/><path d="M16 12h6"/><path d="M5 5l3 3"/><path d="M16 16l3 3"/><path d="M19 5l-3 3"/><path d="M8 16l-3 3"/></svg>',
    babyBottle: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6"/><path d="M8 5h8v3a4 4 0 0 1-1 2.7l-.5.6V19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-7.7l-.5-.6A4 4 0 0 1 8 8z"/><path d="M9 13h6"/><path d="M9 16h6"/></svg>',
    onesie:     '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3l2 3h6l2-3"/><path d="M7 3 4 8l3 2v11h10V10l3-2-3-5"/><path d="M10 16h4"/></svg>',
    rattle:     '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5"/><path d="M11.5 11.5 20 20"/><path d="m17 17 3-3"/><path d="M6 6h.01"/><path d="M10 6h.01"/><path d="M6 10h.01"/></svg>',
    heart:      '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
    fireworks:  '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 12V2"/><path d="M12 12l7-7"/><path d="M12 12l-7-7"/><path d="M12 12 5 19"/><path d="m12 12 7 7"/><path d="M12 12h10"/><path d="M2 12h10"/></svg>',
    star:       '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15 8.5 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 9 8.5 12 2"/></svg>',
    flag:       '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22V4"/><path d="M4 4h13l-2 4 2 4H4"/></svg>',
    shamrock:   '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 12c-2-4-6-2-6 1s2 4 4 4"/><path d="M12 12c2-4 6-2 6 1s-2 4-4 4"/><path d="M12 12c-4-2-2-6 1-6s4 2 4 4"/><path d="M12 12v9"/></svg>',
    egg:        '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22c-4 0-7-3-7-7 0-5 3-13 7-13s7 8 7 13c0 4-3 7-7 7z"/><path d="M8 13h8"/><path d="M9 16h6"/></svg>',
    flower:     '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9" r="2"/><path d="M12 7a3 3 0 0 0 3-3 3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3"/><path d="M14 9a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3 3 3 0 0 0-3 3"/><path d="M10 9a3 3 0 0 1-3 3 3 3 0 0 1-3-3 3 3 0 0 1 3-3 3 3 0 0 1 3 3"/><path d="M12 11v11"/><path d="M9 17l3 2 3-2"/></svg>',
    tie:        '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6l-1 5 3 9-5 6-5-6 3-9z"/><path d="M10 8h4"/></svg>',
    gear:       '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    feather:    '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><path d="M16 8 2 22"/><path d="M17.5 15H9"/></svg>',
    pumpkin:    '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v3"/><path d="M12 5c1-2 4-2 4 0"/><path d="M8 8c-3 0-5 3-5 7s2 7 5 7c1 0 2-1 4-1s3 1 4 1c3 0 5-3 5-7s-2-7-5-7c-1 0-2 1-4 1s-3-1-4-1z"/><path d="M9 13l2 2 2-2"/><path d="M13 13l2 2 2-2"/></svg>',
    leaf:       '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 4 13c0-6 5-10 17-10 0 8-4 17-10 17a7 7 0 0 1-7-7z"/><path d="M2 21c4-4 7-7 18-15"/></svg>',
    tree:       '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 6 10h3l-3 5h3l-3 5h12l-3-5h3l-3-5h3z"/><path d="M11 20h2v2h-2z"/></svg>',
    cornucopia: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18c0-7 5-12 12-12 2 0 4 2 4 4s-2 4-4 4c-3 0-6 2-6 5"/><circle cx="14" cy="14" r="2"/><circle cx="18" cy="17" r="1.5"/></svg>',
  };

  const themes = {
    // ── Existing five ────────────────────────────────────────────────
    welcome_to_team: {
      badge: svg.welcome,
      gradient: 'radial-gradient(ellipse at 50% 38%, #2563eb 0%, #1e40af 45%, #0f1d4a 100%)',
      badgeBg:  'linear-gradient(160deg, #3b82f6 0%, #1d4ed8 100%)',
      palette: ['#FBBF24','#F59E0B','#FDE68A','#60A5FA','#93C5FD','#3B82F6','#FFFFFF','#DBEAFE'],
      defaultTitle: 'Welcome to the team',
      defaultMessage: "We're excited to have you here. Let's make this a great first day.",
      defaultCta: 'Start my day',
      defaultFooter: 'Sent by your team',
    },
    birthday: {
      badge: svg.cake,
      gradient: 'radial-gradient(ellipse at 50% 38%, #d946ef 0%, #a21caf 45%, #4a044e 100%)',
      badgeBg:  'linear-gradient(160deg, #f472b6 0%, #be185d 100%)',
      palette: ['#F472B6','#FBBF24','#34D399','#60A5FA','#F87171','#FFFFFF','#FDE68A','#A78BFA'],
      defaultTitle: 'Happy birthday!',
      defaultMessage: 'Hope your day is as awesome as you are. Enjoy it!',
      defaultCta: 'Thanks!',
      defaultFooter: 'Sent by your team',
    },
    work_anniversary: {
      badge: svg.trophy,
      gradient: 'radial-gradient(ellipse at 50% 38%, #b45309 0%, #78350f 45%, #1c1917 100%)',
      badgeBg:  'linear-gradient(160deg, #fbbf24 0%, #b45309 100%)',
      palette: ['#FBBF24','#F59E0B','#FCD34D','#FEF3C7','#FFFFFF','#92400E','#D97706','#FDE68A'],
      defaultTitle: 'Happy work anniversary!',
      defaultMessage: 'Thanks for everything you bring to the team. Cheers to another great year.',
      defaultCta: 'Thanks!',
      defaultFooter: 'Sent by your team',
    },
    safety_milestone: {
      badge: svg.sparkle,
      gradient: 'radial-gradient(ellipse at 50% 38%, #16A34A 0%, #065f46 45%, #022c22 100%)',
      badgeBg:  'linear-gradient(160deg, #34d399 0%, #15803D 100%)',
      palette: ['#34D399','#A7F3D0','#FFFFFF','#10B981','#6EE7B7','#D1FAE5','#16A34A','#FBBF24'],
      defaultTitle: 'Safety milestone',
      defaultMessage: 'Your safe driving sets the standard. Thank you for keeping it dialed in.',
      defaultCta: 'Keep it up',
      defaultFooter: 'Sent by your team',
    },
    custom: {
      badge: svg.heart,
      gradient: 'radial-gradient(ellipse at 50% 38%, #2563eb 0%, #1e40af 45%, #0f1d4a 100%)',
      badgeBg:  'linear-gradient(160deg, #3b82f6 0%, #1d4ed8 100%)',
      palette: ['#FBBF24','#F59E0B','#FDE68A','#60A5FA','#93C5FD','#3B82F6','#FFFFFF','#DBEAFE'],
      defaultTitle: 'A note from your team',
      defaultMessage: '',
      defaultCta: 'Continue',
      defaultFooter: 'Sent by your team',
    },

    // ── Baby (3) ─────────────────────────────────────────────────────
    baby_boy: {
      badge: svg.onesie,
      gradient: 'radial-gradient(ellipse at 50% 38%, #93c5fd 0%, #3b82f6 45%, #1e3a8a 100%)',
      badgeBg:  'linear-gradient(160deg, #bfdbfe 0%, #3b82f6 100%)',
      palette: ['#BFDBFE','#93C5FD','#60A5FA','#FFFFFF','#DBEAFE','#3B82F6','#EFF6FF','#FBBF24'],
      defaultTitle: "It's a boy!",
      defaultMessage: 'Congratulations on the newest addition to your family. Wishing you all the best.',
      defaultCta: 'Thank you!',
      defaultFooter: 'Sent by your team',
    },
    baby_girl: {
      badge: svg.onesie,
      gradient: 'radial-gradient(ellipse at 50% 38%, #fbcfe8 0%, #ec4899 45%, #831843 100%)',
      badgeBg:  'linear-gradient(160deg, #fbcfe8 0%, #db2777 100%)',
      palette: ['#FBCFE8','#F9A8D4','#F472B6','#FFFFFF','#FCE7F3','#EC4899','#FFE4E6','#FBBF24'],
      defaultTitle: "It's a girl!",
      defaultMessage: 'Congratulations on the newest addition to your family. Wishing you all the best.',
      defaultCta: 'Thank you!',
      defaultFooter: 'Sent by your team',
    },
    baby_expecting: {
      badge: svg.rattle,
      gradient: 'radial-gradient(ellipse at 50% 38%, #fde68a 0%, #f59e0b 45%, #78350f 100%)',
      badgeBg:  'linear-gradient(160deg, #fef3c7 0%, #f59e0b 100%)',
      palette: ['#FEF3C7','#FDE68A','#FCD34D','#FFFFFF','#FBCFE8','#BFDBFE','#FBBF24','#FEF9C3'],
      defaultTitle: 'Congratulations!',
      defaultMessage: 'A baby on the way is wonderful news. So happy for you and your family.',
      defaultCta: 'Thank you!',
      defaultFooter: 'Sent by your team',
    },

    // ── Holidays (17) ────────────────────────────────────────────────
    holiday_new_years_day: {
      badge: svg.fireworks,
      gradient: 'radial-gradient(ellipse at 50% 38%, #facc15 0%, #a16207 45%, #0a0a0a 100%)',
      badgeBg:  'linear-gradient(160deg, #fde047 0%, #ca8a04 100%)',
      palette: ['#FACC15','#FDE047','#FFFFFF','#1F2937','#CA8A04','#FEF08A','#F59E0B','#A16207'],
      defaultTitle: 'Happy New Year!',
      defaultMessage: "Here's to a great year ahead — thanks for being part of the team.",
      defaultCta: 'Cheers!',
      defaultFooter: 'Sent by your team',
    },
    holiday_mlk_day: {
      badge: svg.star,
      gradient: 'radial-gradient(ellipse at 50% 38%, #1d4ed8 0%, #1e3a8a 45%, #082f49 100%)',
      badgeBg:  'linear-gradient(160deg, #fbbf24 0%, #b45309 100%)',
      palette: ['#1D4ED8','#FBBF24','#FFFFFF','#1E3A8A','#FCD34D','#3B82F6','#FEF3C7','#60A5FA'],
      defaultTitle: 'Honoring Dr. King',
      defaultMessage: 'A day to reflect on the dream of justice and equality for all.',
      defaultCta: 'Continue',
      defaultFooter: 'Sent by your team',
    },
    holiday_valentines_day: {
      badge: svg.heart,
      gradient: 'radial-gradient(ellipse at 50% 38%, #fb7185 0%, #be123c 45%, #4c0519 100%)',
      badgeBg:  'linear-gradient(160deg, #fda4af 0%, #DC2626 100%)',
      palette: ['#FB7185','#EF4444','#FECDD3','#FFFFFF','#FFE4E6','#BE123C','#FBCFE8','#DC2626'],
      defaultTitle: "Happy Valentine's Day!",
      defaultMessage: 'A little love sent your way from the whole team.',
      defaultCta: 'Thanks!',
      defaultFooter: 'Sent by your team',
    },
    holiday_presidents_day: {
      badge: svg.flag,
      gradient: 'radial-gradient(ellipse at 50% 38%, #1d4ed8 0%, #b91c1c 60%, #1e3a8a 100%)',
      badgeBg:  'linear-gradient(160deg, #dc2626 0%, #1d4ed8 100%)',
      palette: ['#DC2626','#FFFFFF','#1D4ED8','#FEE2E2','#DBEAFE','#B91C1C','#1E3A8A','#F3F4F6'],
      defaultTitle: "Happy Presidents' Day",
      defaultMessage: 'A day to honor the leaders who have shaped our country.',
      defaultCta: 'Continue',
      defaultFooter: 'Sent by your team',
    },
    holiday_st_patricks_day: {
      badge: svg.shamrock,
      gradient: 'radial-gradient(ellipse at 50% 38%, #16a34a 0%, #15803d 45%, #052e16 100%)',
      badgeBg:  'linear-gradient(160deg, #4ade80 0%, #15803d 100%)',
      palette: ['#16A34A','#4ADE80','#FBBF24','#FFFFFF','#BBF7D0','#22C55E','#FCD34D','#FEF3C7'],
      defaultTitle: "Happy St. Patrick's Day!",
      defaultMessage: 'Wishing you a little extra luck of the Irish out on the road today.',
      defaultCta: 'Sláinte!',
      defaultFooter: 'Sent by your team',
    },
    holiday_easter: {
      badge: svg.egg,
      gradient: 'radial-gradient(ellipse at 50% 38%, #c4b5fd 0%, #a78bfa 45%, #4c1d95 100%)',
      badgeBg:  'linear-gradient(160deg, #fbcfe8 0%, #a78bfa 100%)',
      palette: ['#FBCFE8','#C4B5FD','#FDE68A','#A7F3D0','#FFFFFF','#FECACA','#BFDBFE','#FEF08A'],
      defaultTitle: 'Happy Easter!',
      defaultMessage: 'Wishing you a peaceful, joyful Easter from the whole team.',
      defaultCta: 'Thanks!',
      defaultFooter: 'Sent by your team',
    },
    holiday_mothers_day: {
      badge: svg.flower,
      gradient: 'radial-gradient(ellipse at 50% 38%, #f9a8d4 0%, #db2777 45%, #500724 100%)',
      badgeBg:  'linear-gradient(160deg, #fbcfe8 0%, #db2777 100%)',
      palette: ['#F9A8D4','#FBCFE8','#FFFFFF','#FCE7F3','#EC4899','#FECDD3','#FBBF24','#FDE68A'],
      defaultTitle: "Happy Mother's Day!",
      defaultMessage: 'To all the moms on the team — thank you for everything you do.',
      defaultCta: 'Thanks!',
      defaultFooter: 'Sent by your team',
    },
    holiday_memorial_day: {
      badge: svg.flag,
      gradient: 'radial-gradient(ellipse at 50% 38%, #b91c1c 0%, #1d4ed8 60%, #1e3a8a 100%)',
      badgeBg:  'linear-gradient(160deg, #dc2626 0%, #1d4ed8 100%)',
      palette: ['#DC2626','#FFFFFF','#1D4ED8','#FEE2E2','#DBEAFE','#B91C1C','#1E3A8A','#F3F4F6'],
      defaultTitle: 'Memorial Day',
      defaultMessage: 'Honoring those who gave everything in service of our country.',
      defaultCta: 'Continue',
      defaultFooter: 'Sent by your team',
    },
    holiday_juneteenth: {
      badge: svg.star,
      gradient: 'radial-gradient(ellipse at 50% 38%, #b91c1c 0%, #166534 50%, #0a0a0a 100%)',
      badgeBg:  'linear-gradient(160deg, #dc2626 0%, #166534 100%)',
      palette: ['#DC2626','#16A34A','#FBBF24','#FFFFFF','#1F2937','#FEE2E2','#BBF7D0','#FEF3C7'],
      defaultTitle: 'Happy Juneteenth!',
      defaultMessage: 'A day to celebrate freedom, history, and the road ahead.',
      defaultCta: 'Continue',
      defaultFooter: 'Sent by your team',
    },
    holiday_fathers_day: {
      badge: svg.tie,
      gradient: 'radial-gradient(ellipse at 50% 38%, #1d4ed8 0%, #1e40af 45%, #0f1d4a 100%)',
      badgeBg:  'linear-gradient(160deg, #fbbf24 0%, #1d4ed8 100%)',
      palette: ['#1D4ED8','#FBBF24','#FFFFFF','#DBEAFE','#FCD34D','#3B82F6','#FEF3C7','#1E3A8A'],
      defaultTitle: "Happy Father's Day!",
      defaultMessage: 'To all the dads on the team — thank you for everything you do.',
      defaultCta: 'Thanks!',
      defaultFooter: 'Sent by your team',
    },
    holiday_independence_day: {
      badge: svg.fireworks,
      gradient: 'radial-gradient(ellipse at 50% 38%, #b91c1c 0%, #1d4ed8 60%, #1e3a8a 100%)',
      badgeBg:  'linear-gradient(160deg, #dc2626 0%, #1d4ed8 100%)',
      palette: ['#DC2626','#FFFFFF','#1D4ED8','#FEE2E2','#DBEAFE','#B91C1C','#1E3A8A','#FBBF24'],
      defaultTitle: 'Happy 4th of July!',
      defaultMessage: 'Wishing you a safe and festive Independence Day.',
      defaultCta: 'Happy 4th!',
      defaultFooter: 'Sent by your team',
    },
    holiday_labor_day: {
      badge: svg.gear,
      gradient: 'radial-gradient(ellipse at 50% 38%, #475569 0%, #1e293b 45%, #020617 100%)',
      badgeBg:  'linear-gradient(160deg, #cbd5e1 0%, #1d4ed8 100%)',
      palette: ['#1D4ED8','#CBD5E1','#FFFFFF','#94A3B8','#DBEAFE','#475569','#E2E8F0','#3B82F6'],
      defaultTitle: 'Happy Labor Day!',
      defaultMessage: 'Thanks for the hard work — enjoy the day off.',
      defaultCta: 'Thanks!',
      defaultFooter: 'Sent by your team',
    },
    holiday_indigenous_peoples_day: {
      badge: svg.feather,
      gradient: 'radial-gradient(ellipse at 50% 38%, #b45309 0%, #78350f 45%, #1c1917 100%)',
      badgeBg:  'linear-gradient(160deg, #f59e0b 0%, #92400e 100%)',
      palette: ['#B45309','#92400E','#FBBF24','#FFFFFF','#FED7AA','#78350F','#D97706','#FDE68A'],
      defaultTitle: "Indigenous Peoples' Day",
      defaultMessage: 'Honoring the history, cultures, and contributions of Indigenous peoples.',
      defaultCta: 'Continue',
      defaultFooter: 'Sent by your team',
    },
    holiday_halloween: {
      badge: svg.pumpkin,
      gradient: 'radial-gradient(ellipse at 50% 38%, #f97316 0%, #7c3aed 50%, #0a0a0a 100%)',
      badgeBg:  'linear-gradient(160deg, #fb923c 0%, #7c3aed 100%)',
      palette: ['#F97316','#7C3AED','#1F2937','#FBBF24','#FB923C','#A78BFA','#FFFFFF','#FED7AA'],
      defaultTitle: 'Happy Halloween!',
      defaultMessage: 'Stay spooky out there — and watch out for the goblins.',
      defaultCta: 'Boo!',
      defaultFooter: 'Sent by your team',
    },
    holiday_veterans_day: {
      badge: svg.flag,
      gradient: 'radial-gradient(ellipse at 50% 38%, #1d4ed8 0%, #b91c1c 60%, #1e3a8a 100%)',
      badgeBg:  'linear-gradient(160deg, #dc2626 0%, #1d4ed8 100%)',
      palette: ['#DC2626','#FFFFFF','#1D4ED8','#FEE2E2','#DBEAFE','#B91C1C','#1E3A8A','#FBBF24'],
      defaultTitle: 'Thank You, Veterans',
      defaultMessage: 'With gratitude for your service — today and every day.',
      defaultCta: 'Thank you',
      defaultFooter: 'Sent by your team',
    },
    holiday_thanksgiving: {
      badge: svg.cornucopia,
      gradient: 'radial-gradient(ellipse at 50% 38%, #c2410c 0%, #7c2d12 45%, #1c1917 100%)',
      badgeBg:  'linear-gradient(160deg, #fb923c 0%, #9a3412 100%)',
      palette: ['#C2410C','#FB923C','#FBBF24','#FFFFFF','#FED7AA','#9A3412','#FDE68A','#A16207'],
      defaultTitle: 'Happy Thanksgiving!',
      defaultMessage: 'Grateful to have you on the team. Enjoy the day with the people you love.',
      defaultCta: 'Thanks!',
      defaultFooter: 'Sent by your team',
    },
    holiday_christmas: {
      badge: svg.tree,
      gradient: 'radial-gradient(ellipse at 50% 38%, #16a34a 0%, #166534 50%, #052e16 100%)',
      badgeBg:  'linear-gradient(160deg, #dc2626 0%, #166534 100%)',
      palette: ['#DC2626','#16A34A','#FBBF24','#FFFFFF','#FEE2E2','#BBF7D0','#FCD34D','#22C55E'],
      defaultTitle: 'Merry Christmas!',
      defaultMessage: 'Wishing you a warm, joyful Christmas with family and friends.',
      defaultCta: 'Merry Christmas!',
      defaultFooter: 'Sent by your team',
    },
  };

  return themes[kind] || themes.welcome_to_team;
}

// ── renderCelebrationRoute ──────────────────────────────────────────
// The /welcome route's render function.  Reads the stashed event and
// session from module-level vars, paints the celebration HTML into
// #main (replacing whatever the schedule view would otherwise show),
// and fires the delivered RPC fire-and-forget.
//
// Crucially: the CTA + close + tap-anywhere-backdrop are all <a>
// anchor tags pointing at #/schedule.  When the user taps one, iOS
// performs native hash navigation — no JS event handler is involved.
// The hashchange listener picks up the URL change and re-fires
// render(), which mounts renderSchedule() into #main.  The
// _onCelebrationLeave hashchange listener (set up once, below) fires
// the dismiss RPC and marks _recogDismissedIds.
//
// If the user navigates to /welcome manually (or via back-forward
// cache) without a stashed event, we redirect to /schedule.
function renderCelebrationRoute() {
  // No event to celebrate — bounce to schedule so the route is never
  // a dead-end.  Manual /welcome navigation, stale bookmarks, etc.
  if (!_currentCelebrationEv) {
    navigate("/schedule");
    return;
  }
  const ev      = _currentCelebrationEv;
  const session = _currentCelebrationSession;
  const main    = document.getElementById("main");
  if (!main) return;

  setHeader("", "");

  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const theme   = _recogTheme(ev.kind || "welcome_to_team");
  const title    = String(ev.title    || theme.defaultTitle);
  const message  = String(ev.message  || theme.defaultMessage);
  const ctaLabel = String(ev.cta_label || theme.defaultCta);
  const footer   = String(ev.footer   || theme.defaultFooter);

  const palette = theme.palette;
  const confetti = reduced ? "" : Array.from({ length: 120 }, () => {
    const left  = (Math.random() * 110 - 5).toFixed(1);
    const delay = (Math.random() * 3.0).toFixed(2);
    const dur   = (3.4 + Math.random() * 2.4).toFixed(2);
    const hue   = palette[Math.floor(Math.random() * palette.length)];
    const rot   = (Math.random() * 360).toFixed(0);
    const drift = (Math.random() * 120 - 60).toFixed(0);
    const size  = (8 + Math.random() * 8).toFixed(0);
    const round = Math.random() > 0.55 ? "border-radius:50%;" : "";
    return `<i class="rrc-piece" style="left:${left}vw;background:${hue};width:${size}px;height:${size}px;${round}--rot:${rot}deg;--drift:${drift}px;animation-delay:${delay}s;animation-duration:${dur}s"></i>`;
  }).join("");

  // The whole celebration mounts into #main.  position:fixed on the
  // root makes it cover the shell (header + tab bar) so the driver
  // sees a full-screen takeover — but unlike v120 there's nothing
  // appended to <body>; the router owns the lifecycle.
  main.innerHTML = `
    <style>
      #rr-celebration-route{
        position:fixed;inset:0;z-index:1001;
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        padding:24px;color:#fff;
        background:${theme.gradient};
        overflow:hidden;
      }
      #rr-celebration-route .rrc-burst{
        position:absolute;top:calc(50% - 200px);left:50%;width:520px;height:520px;
        transform:translate(-50%, -50%);pointer-events:none;
        background:radial-gradient(circle, rgba(255,255,255,.35) 0%, rgba(147,197,253,.18) 28%, transparent 65%);
        opacity:.6;
      }
      #rr-celebration-route .rrc-piece{
        position:absolute;top:-24px;width:10px;height:14px;border-radius:2px;
        opacity:.92;pointer-events:none;will-change:transform, opacity;
        animation:rrcDrift linear forwards;
        transform:translate3d(0,0,0) rotate(var(--rot, 0deg));
      }
      @keyframes rrcDrift{
        0%   { transform:translate3d(0, -20px, 0) rotate(var(--rot, 0deg)); opacity:1 }
        100% { transform:translate3d(var(--drift, 0), 110vh, 0) rotate(calc(var(--rot, 0deg) + 540deg)); opacity:.85 }
      }
      /* Full-screen anchor that covers the gradient area but sits
         BELOW the card (z-index 1).  Taps anywhere on the blue area
         hit this anchor and trigger native hash navigation. */
      #rr-celebration-route .celeb-tap-anywhere{
        position:absolute;inset:0;z-index:1;
        display:block;
        -webkit-tap-highlight-color:transparent;
      }
      #rr-celebration-route .rrc-card{
        position:relative;z-index:2;
        width:100%;max-width:340px;
        background:#fff;color:#0f172a;
        border-radius:20px;
        padding:38px 26px 28px;
        box-shadow:0 18px 60px rgba(2,12,40,.32), 0 2px 10px rgba(2,12,40,.18);
        text-align:center;
      }
      #rr-celebration-route .rrc-badge{
        position:absolute;top:-32px;left:50%;transform:translateX(-50%);
        width:68px;height:68px;
        display:flex;align-items:center;justify-content:center;
        background:${theme.badgeBg};
        clip-path:polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
        color:#fff;
        box-shadow:0 10px 24px rgba(2,12,40,.45), inset 0 -4px 8px rgba(0,0,0,.18);
      }
      #rr-celebration-route .rrc-title{margin:14px 0 0;font-size:24px;line-height:1.18;font-weight:700;letter-spacing:-.01em}
      #rr-celebration-route .rrc-divider{margin:16px auto 14px;height:1px;width:80%;background:#e5e7eb}
      #rr-celebration-route .rrc-msg{margin:0;font-size:15px;line-height:1.45;color:#475569}
      /* The CTA is an <a> tag styled as a button.  iOS native anchor
         navigation is the dismiss path — no JS handler involved. */
      #rr-celebration-route .rrc-cta{
        display:block;width:100%;margin:22px 0 0;
        background:linear-gradient(180deg, #2563eb 0%, #1d4ed8 100%);
        color:#fff;font-size:17px;font-weight:700;
        border:0;border-radius:14px;padding:15px 18px;
        box-shadow:0 8px 22px rgba(29,78,216,.42);
        cursor:pointer;letter-spacing:.01em;
        -webkit-tap-highlight-color:rgba(255,255,255,0.25);
        touch-action:manipulation;
        font-family:inherit;
        text-decoration:none;text-align:center;
        box-sizing:border-box;
      }
      #rr-celebration-route .rrc-cta:active{transform:scale(.97);box-shadow:0 4px 10px rgba(29,78,216,.42)}
      #rr-celebration-route .rrc-foot{
        margin-top:14px;font-size:13px;color:rgba(255,255,255,.85);
        display:inline-flex;align-items:center;gap:6px;
        position:relative;z-index:2;
      }
      #rr-celebration-route .rrc-foot svg{stroke:rgba(255,255,255,.85);fill:none;width:14px;height:14px}
      #rr-celebration-route .rrc-close{
        position:absolute;top:14px;right:14px;z-index:3;
        width:44px;height:44px;
        border-radius:50%;border:0;
        background:rgba(255,255,255,.18);color:#fff;
        display:flex;align-items:center;justify-content:center;
        -webkit-tap-highlight-color:rgba(255,255,255,0.25);
        touch-action:manipulation;
        text-decoration:none;font-size:22px;font-weight:600;line-height:1;
      }
      #rr-celebration-route .rrc-close:active{background:rgba(255,255,255,.35)}
    </style>
    <div id="rr-celebration-route" role="dialog" aria-modal="true">
      <a href="#/schedule" class="celeb-tap-anywhere" aria-label="Dismiss celebration"></a>
      <div class="rrc-burst" aria-hidden="true"></div>
      ${confetti}
      <a href="#/schedule" class="rrc-close" aria-label="Close celebration">&times;</a>
      <div class="rrc-card">
        <div class="rrc-badge" aria-hidden="true">
          ${theme.badge}
        </div>
        <h2 class="rrc-title">${escapeHtml(title)}</h2>
        <div class="rrc-divider" aria-hidden="true"></div>
        <p class="rrc-msg">${escapeHtml(message)}</p>
        <a href="#/schedule" class="rrc-cta">${escapeHtml(ctaLabel)}</a>
      </div>
      <div class="rrc-foot">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
        ${escapeHtml(footer)}
      </div>
    </div>
  `;

  if (!reduced && navigator.vibrate) {
    try { navigator.vibrate([14, 40, 18]); } catch (_) {}
  }
  if (!reduced) _playCelebrationChime();

  // Removed the session-shown sessionStorage write — see the matching
  // comment in checkAndShowPendingRecognition.  _celebrationOpen is
  // implicit via the route (we're at /welcome) and the localStorage
  // dismissed-IDs set covers replay.

  if (session && session.token && ev.id) {
    sb.rpc("driver_recognition_delivered", { p_token: session.token, p_id: ev.id })
      .catch((e) => console.warn("[recog] mark-delivered failed:", e?.message));
  }
}

// ── Dismiss-on-leave (hashchange) ───────────────────────────────────
// The actual dismiss path.  Fires whenever the hash changes AWAY from
// /welcome.  Because anchor taps mutate location.hash natively, this
// listener is guaranteed to run on every dismiss — there is no JS
// event handler involved on the anchor itself.  Fire-and-forget RPC,
// mark the id locally, clear the stash.
let _lastCelebrationRoute = null;
window.addEventListener("hashchange", () => {
  try {
    const now = currentRoute();
    if (_lastCelebrationRoute === "/welcome" && now !== "/welcome") {
      const ev      = _currentCelebrationEv;
      const session = _currentCelebrationSession;
      _currentCelebrationEv      = null;
      _currentCelebrationSession = null;
      if (ev && ev.id) {
        _markRecogDismissed(ev.id);
        if (session && session.token) {
          sb.rpc("driver_recognition_dismiss", { p_token: session.token, p_id: ev.id })
            .catch((e) => console.warn("[recog] mark-dismissed failed:", e?.message));
        }
      }
    }
    _lastCelebrationRoute = now;
  } catch (_) {}
});
// Prime _lastCelebrationRoute on initial load so a cold-open to
// /welcome (then nav away) still triggers the dismiss branch.
try { _lastCelebrationRoute = currentRoute(); } catch (_) {}

// ── _playCelebrationChime ───────────────────────────────────────────
// Brief E5 / G#5 / B5 triad via Web Audio.  iOS Safari needs a prior
// user gesture in the session to unlock the context; if suspended
// and resume() fails to acquire one, the chime is silent (acceptable
// on first celebration; subsequent opens after any tap play sound).
function _playCelebrationChime() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    if (ctx.state === "suspended") { try { ctx.resume(); } catch (_) {} }
    const master = ctx.createGain();
    master.gain.value = 0.26;
    master.connect(ctx.destination);
    const start = ctx.currentTime + 0.02;
    [659.25, 830.61, 987.77].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      const t0 = start + i * 0.085;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.95, t0 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.9);
      osc.connect(gain);
      gain.connect(master);
      osc.start(t0);
      osc.stop(t0 + 0.95);
    });
    setTimeout(() => { try { ctx.close(); } catch (_) {} }, 1700);
  } catch (_) {}
}

// Audio gesture-unlock helper — first user gesture anywhere primes
// the audio context for subsequent _playCelebrationChime() calls.
let _audioUnlocked = false;
function _unlockAudioOnGesture() {
  if (_audioUnlocked) return;
  _audioUnlocked = true;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    if (ctx.state === "suspended") {
      ctx.resume().then(() => { try { ctx.close(); } catch (_) {} }).catch(() => {});
    } else {
      try { ctx.close(); } catch (_) {}
    }
  } catch (_) {}
}
["touchstart", "click", "pointerdown"].forEach((evt) => {
  document.addEventListener(evt, _unlockAudioOnGesture, { once: true, passive: true, capture: true });
});

// Version tag removed — the celebration flow is verified working in
// production.  Cache-buster on app.js?v=NNN still tells us which
// build is loaded via Safari's view-source if we ever need to check.
