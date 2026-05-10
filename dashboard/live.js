// Live data layer for the operator dashboard.
//
// The mockup HTML is the visual frame. live.js takes over once the page
// loads: requires auth, then hands the pipeline view real data via the
// pipeline_list / pipeline_counts RPCs, and rewires paAction(...) to
// call send_screening_link / send_booking_link / decline_applicant.
//
// Other tabs still show mockup data — they get wired up in follow-ups.

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const cfg = window.RR_CONFIG;
if (!cfg) throw new Error("RR_CONFIG missing — load config.js before live.js");

const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
window.RR = { sb, user: null, dsp: null };
// Devtools convenience: surface the Supabase client + a one-liner
// for the okami_demand diagnostic so operators can paste a single
// command without knowing about RR.sb.
window.sb = sb;
window.debugDemand = async (weekStart) => {
  const r = await sb.rpc('debug_okami_demand', { p_week_start: weekStart });
  if (r.error) { console.error(r.error); return; }
  console.table(r.data);
  return r.data;
};

// ─── Auth gate ─────────────────────────────────────────────────────────────
const { data: { session } } = await sb.auth.getSession();
if (!session) {
  const next = encodeURIComponent(location.pathname + location.search);
  location.replace(`./login.html?next=${next}`);
  throw new Error("redirecting to login");
}

// When the SDK can't refresh the access token (network blip, JWT secret
// rotation, refresh-token expiry) the dashboard keeps running with cached
// state but every authenticated REST call returns 401 — RLS sees the
// caller as anon, dsp-scoped queries return 0 rows, and SECURITY DEFINER
// RPCs raise 'forbidden'.  The operator sees half-broken panels showing
// "Forbidden" / "no drivers" / "no forms" with no clue why.  Detect the
// failure and force a clean re-login instead.
function _forceRelogin(reason) {
  const next = encodeURIComponent(location.pathname + location.search);
  try { sb.auth.signOut().catch(() => {}); } catch {}
  try { localStorage.clear(); sessionStorage.clear(); } catch {}
  location.replace(`./login.html?err=${encodeURIComponent(reason || "session_expired")}&next=${next}`);
  throw new Error(`force relogin: ${reason}`);
}
function _isAuthError(err) {
  if (!err) return false;
  if (err.status === 401 || err.status === 403) return true;
  if (err.code === "PGRST301" || err.code === "401" || err.code === "403") return true;
  const m = (err.message || "").toLowerCase();
  return /jwt|unauthor|expired|forbidden/.test(m);
}
window._rrForceRelogin = _forceRelogin;
sb.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT") _forceRelogin("session_expired");
});

const { data: profile, error: profileErr } = await sb.from("app_users")
  .select("id, dsp_id, email, full_name, role, allowed_pages").eq("id", session.user.id).maybeSingle();

if (profileErr) {
  // 401 / JWT issue at boot — refresh failed.  Force re-login.
  if (_isAuthError(profileErr)) _forceRelogin("session_expired");
  console.error("profile load failed:", profileErr);
  _forceRelogin("profile_load_failed");
}
if (!profile) {
  // Auth user exists but app_users row doesn't — auth hook failed (most
  // likely a non-allowed domain that slipped through). Send to login with
  // an error.
  await sb.auth.signOut();
  location.replace("./login.html?err=no_profile");
  throw new Error("no app_users row");
}
window.RR.user = profile;

// Apply per-user sidebar hiding. Owners always see everything (so
// they can manage the team and won't accidentally lock themselves
// out). For other roles, hide top-level nav items not in their
// allowed_pages list. NULL allowed_pages = no restriction. Settings
// is always visible because that's how a restricted user appeals.
(function applyAllowedPages() {
  const allowed = profile.allowed_pages;
  if (profile.role === "owner" || profile.role === "platform_admin") return;
  if (!Array.isArray(allowed) || allowed.length === 0) return;
  const apply = () => {
    document.querySelectorAll(".nav-item[data-view]").forEach(btn => {
      const view = btn.getAttribute("data-view");
      if (view === "settings") return;
      if (!allowed.includes(view)) {
        btn.style.display = "none";
      }
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply, { once: true });
  } else {
    apply();
  }
})();

// ── First-run welcome zone ─────────────────────────────────────────────
// Shown on the dashboard view for newly-activated DSPs (within 14 days
// of dsps.activated_at) until the owner dismisses.  Dismissal writes
// metadata.first_run_dismissed_at so it survives across devices /
// browsers (vs. localStorage).
//
// Existing DSPs have activated_at backfilled by migration 0126 to
// their created_at, so any DSP older than 14 days at migration time
// never sees the banner — important for not surprising long-time
// operators with a "Welcome!" message.
function _initFirstRunZone() {
  const zone = document.getElementById("rr-firstrun");
  if (!zone) return;
  const dsp = window.RR?.dsp;
  if (!dsp) return;
  const activated = dsp.activated_at ? new Date(dsp.activated_at).getTime() : null;
  const dismissed = dsp.metadata?.first_run_dismissed_at
    ? new Date(dsp.metadata.first_run_dismissed_at).getTime()
    : null;
  const ageMs = activated ? (Date.now() - activated) : Infinity;
  const isFresh = activated != null && ageMs < (14 * 24 * 60 * 60 * 1000);
  // Platform admins skip the welcome — admin tooling is their
  // surface, and a "Welcome to RouteReady" banner reads weird when
  // they're managing customers.
  if (profile.role === "platform_admin") return;
  if (!isFresh || dismissed) return;

  // Suffix with the owner's first name (from app_users.full_name).
  const firstName = (profile.full_name || "").split(/\s+/)[0];
  const suffix = document.getElementById("rr-firstrun-name-suffix");
  if (suffix && firstName) suffix.textContent = `, ${firstName}`;
  zone.hidden = false;

  document.getElementById("rr-firstrun-dismiss")?.addEventListener("click", async () => {
    zone.hidden = true;
    const nowIso = new Date().toISOString();
    const newMeta = Object.assign({}, dsp.metadata || {}, { first_run_dismissed_at: nowIso });
    // Optimistic local update so a re-paint doesn't flash the banner.
    if (window.RR?.dsp) window.RR.dsp.metadata = newMeta;
    const { error } = await sb.from("dsps").update({ metadata: newMeta }).eq("id", dsp.id);
    if (error) {
      // Non-fatal: banner is hidden in-session even if persistence
      // failed.  Log so we know about it.
      console.warn("first_run_dismissed_at persist failed:", error);
    }
  });
}
// Defer the call until DOM is settled (the welcome zone lives inside
// the dashboard view, mounted after live.js's top-level await).
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _initFirstRunZone, { once: true });
} else {
  _initFirstRunZone();
}

// ── Onboarding wizard gate ─────────────────────────────────────────────
// Newly-provisioned DSP owners land in the dashboard with their workspace
// in status='pending' or 'onboarding'.  Until they finish the wizard,
// the regular dashboard chrome is hidden and #view-onboarding takes
// over the screen.  Migration 0126 backfilled status='active' DSPs to
// onboarding_step='complete', so existing workspaces (Air Capital
// Logistics, etc.) bypass the wizard cleanly.
//
// Platform admins skip the wizard for their own DSP — admin tooling is
// the right surface for them, not the customer-flavored onboarding.
if (window.RR.dsp
    && (window.RR.dsp.status === "pending" || window.RR.dsp.status === "onboarding")
    && profile.role !== "platform_admin") {
  document.body.dataset.rrOnboarding = "1";
  // Defer the actual wizard mount until DOM is fully present (post-await
  // module timing means the body exists but mutation observers might
  // not be ready).
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => _mountOnboarding(), { once: true });
  } else {
    _mountOnboarding();
  }
}

// Reveal the platform-admin nav-item only for users who actually have
// that role.  The button is `display:none` by default in the HTML, so
// regular owners / dispatchers / drivers never see it.  See the
// 0124_platform_admin.sql migration + bootstrap for how to grant the
// role.  All cross-tenant data calls go through admin_* RPCs, each of
// which re-checks is_platform_admin() in its body — hiding the nav
// item is UX, not security.
(function revealPlatformAdminNav() {
  if (profile.role !== "platform_admin") return;
  const apply = () => {
    document.querySelectorAll('.nav-item[data-rr-platform-admin-only="1"]').forEach((btn) => {
      btn.style.display = "";
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply, { once: true });
  } else {
    apply();
  }
})();

const { data: dspRow, error: dspErr } = await sb.from("dsps")
  .select("id, name, short_code, timezone, metadata").eq("id", profile.dsp_id).single();
if (dspErr || !dspRow || !dspRow.id) {
  // .single() on dsps fails when (a) the JWT was rejected so RLS sees
  // the caller as anon and returns 0 rows, or (b) profile.dsp_id is
  // genuinely missing/wrong.  Either way, every dsp-scoped query
  // downstream would silently return 0 rows or 401.  Don't paint a
  // half-broken UI — bounce through login with an explanation.
  console.error("dsp load failed:", dspErr, "profile.dsp_id:", profile.dsp_id);
  _forceRelogin(_isAuthError(dspErr) ? "session_expired" : "dsp_unresolved");
}
window.RR.dsp = dspRow;

// ─── Brand · paint DSP name + station code into the sidebar chip ────────
// The chip in dashboard/index.html is a static placeholder ("Cardinal
// Logistics") so the file looks fine in a static preview. Replace it
// with the live DSP record so the operator sees their own brand, and
// re-paint after the Workspace settings save.
function _paintWorkspaceChip() {
  const dsp = window.RR?.dsp;
  if (!dsp) return;
  const name   = dsp.name || "Workspace";
  const code   = dsp.short_code || "";
  const initials = name
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || "").join("") || "··";
  const elName   = document.getElementById("rr-workspace-chip-name");
  const elSub    = document.getElementById("rr-workspace-chip-sub");
  const elAvatar = document.getElementById("rr-workspace-chip-avatar");
  if (elName)   elName.textContent = name;
  if (elSub)    elSub.textContent  = code ? `DSP · ${code}` : "DSP";
  if (elAvatar) elAvatar.textContent = initials;
  // Top-of-sidebar brand wordmark stays "RouteReady" (the platform
  // brand the operator pays for); the operator's DSP name lives in
  // the workspace chip below it.
  document.title = `${name} · Dispatcher`;
}
_paintWorkspaceChip();

// ─── Tiny DOM helpers ──────────────────────────────────────────────────────
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ─── Driver photos · paint avatars wherever they show up ───────────────
// The roster, schedule grid, coaching feed, message list, etc. all
// render <div class="avatar-sm">XY</div> with the driver's initials.
// Rather than touch every render site, we cache the photo URL per
// driver once and walk the DOM after each render painting a CSS
// background-image on every avatar near a [data-rr-driver-id] node.
//
// This means a driver who uploads a photo on the PWA shows up across
// the dispatcher dashboard automatically, and adding a new avatar
// somewhere later doesn't require remembering to wire up the photo.
const _driverPhotos = { loaded: null, map: new Map() };

async function _loadDriverPhotos() {
  if (_driverPhotos.loaded) return _driverPhotos.loaded;
  _driverPhotos.loaded = (async () => {
    const dspId = window.RR?.dsp?.id;
    if (!dspId) return _driverPhotos.map;
    const { data, error } = await sb.from("drivers")
      .select("id, photo_path")
      .eq("dsp_id", dspId)
      .not("photo_path", "is", null);
    if (error) { console.warn("loadDriverPhotos:", error); return _driverPhotos.map; }
    for (const r of (data || [])) {
      _driverPhotos.map.set(
        r.id,
        `${cfg.SUPABASE_URL}/storage/v1/object/public/driver-photos/${r.photo_path}`
      );
    }
    return _driverPhotos.map;
  })();
  return _driverPhotos.loaded;
}

function _resolveDriverIdForAvatar(el) {
  // Direct attribute on the avatar itself (cal-row-label, etc.)
  let id = el.getAttribute("data-rr-driver-id");
  if (id) return id;
  // Walk up the tree. Some renders put the id on a deep wrapper
  // (.cell-driver row -> <tr data-driver-id>), some on a sibling
  // text node (.cell-name[data-rr-driver-id]), some on the row
  // itself. We try each ancestor in turn until we find one.
  let cur = el.parentElement;
  while (cur && cur !== document.body) {
    if (cur.dataset?.rrDriverId)        return cur.dataset.rrDriverId;
    if (cur.dataset?.driverId)          return cur.dataset.driverId;
    if (cur.dataset?.rrCoachFeedDriver) return cur.dataset.rrCoachFeedDriver;
    const tagged = cur.querySelector?.("[data-rr-driver-id]");
    if (tagged) return tagged.getAttribute("data-rr-driver-id");
    // Stop at row-style boundaries so we don't bleed into a sibling
    // driver's id when an avatar lives inside a wider container.
    // (.cell-driver is a per-cell wrapper, NOT a row — keep walking.)
    if (cur.matches?.("tr, .msg-item, .cal-row-label, .checkin-row, .iv-card, .driver-row, .dr-coach-row")) return null;
    cur = cur.parentElement;
  }
  return null;
}

function _paintDriverAvatars(root) {
  if (_driverPhotos.map.size === 0) return;
  const scope = root && root.querySelectorAll ? root : document;
  scope.querySelectorAll(".avatar-sm").forEach((el) => {
    if (el.dataset.rrPhotoPainted) return;
    const id = _resolveDriverIdForAvatar(el);
    if (!id) return;
    const url = _driverPhotos.map.get(id);
    if (!url) return;
    el.style.backgroundImage    = `url('${url}')`;
    el.style.backgroundSize     = "cover";
    el.style.backgroundPosition = "center";
    el.style.color              = "transparent"; // hide initials
    el.dataset.rrPhotoPainted   = "1";
  });
}

// Repaint after any DOM change. Debounced so a heavy render doesn't
// cause a flood — one paint pass after the dust settles is enough.
let _paintTimer = null;
function _schedulePaint() {
  if (_paintTimer) return;
  _paintTimer = setTimeout(() => { _paintTimer = null; _paintDriverAvatars(document); }, 50);
}

_loadDriverPhotos().then(() => {
  _paintDriverAvatars(document);
  new MutationObserver(_schedulePaint).observe(document.body, { childList: true, subtree: true });
});

// Public hook so a freshly-uploaded photo (e.g. via the driver record
// drawer in the future) can refresh without a page reload.
window.RR.refreshDriverPhotos = async function () {
  _driverPhotos.loaded = null;
  _driverPhotos.map.clear();
  document.querySelectorAll(".avatar-sm[data-rr-photo-painted]").forEach((el) => {
    el.style.backgroundImage = "";
    el.style.color = "";
    delete el.dataset.rrPhotoPainted;
  });
  await _loadDriverPhotos();
  _paintDriverAvatars(document);
};

function toast(msg, kind) {
  if (typeof window.toast === "function") return window.toast(msg, kind);
  console.log("[toast]", kind ?? "", msg);
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ─── Pipeline render ───────────────────────────────────────────────────────

const STAGE_LABELS = {
  applied: "Applied",
  screened: "Screened",
  booking_pending: "Booking pending",
  booking_scheduled: "Booking scheduled",
};

// Some upstream systems hand us applicant names in ALL CAPS; render
// them title-cased so the Pipeline cards don't shout. Word-boundary
// regex handles hyphens, apostrophes, and other separators correctly
// (e.g. "MARY-JANE O'BRIEN" → "Mary-Jane O'Brien").
function rrTitleCaseName(s) {
  return (s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// Match the prototype's compact-list pattern: the collapsed card
// shows stage pill + identity + score, with one View toggle on the
// right. Action buttons + screening answers live in the expanded
// detail panel below, so the row above stays scannable.
function renderApplicantCard(a) {
  const stage = a.pipeline_stage;
  const slug  = (a.full_name || "").toLowerCase().replace(/\s+/g, "-");
  const name  = rrTitleCaseName(a.full_name);

  // Identity meta line — render whatever's available, dot-separated.
  const meta = [
    a.station_code ? `Station ${a.station_code}` : null,
    a.source ? `via ${a.source}` : null,
    a.email,
    a.phone,
  ].filter(Boolean).join(" · ");

  // Stage pill copy. For booking_scheduled, append the booked time so
  // the operator can see when it is without expanding.
  let stageLabel = STAGE_LABELS[stage] ?? stage;
  if (stage === "booking_scheduled" && a.next_event_starts_at) {
    stageLabel = `${STAGE_LABELS[stage]} · ${fmtDate(a.next_event_starts_at)}`;
  }

  const relTime = a.created_at ? _relTimeShort(a.created_at) : "";

  // Score chip — colour by tier so high-fits stand out at a glance.
  let scoreChip = "";
  if (a.score !== null && a.score !== undefined) {
    const cls = a.score >= 7 ? "score" : a.score >= 4 ? "score score-mid" : "score score-low";
    scoreChip = `<span class="pa-card-tag ${cls}">Score ${a.score}</span>`;
  }

  // Disposition buttons — placed inside the expanded action bar so the
  // collapsed view stays calm.
  let primaryBtn = "";
  if (stage === "applied") {
    primaryBtn = `<button class="pa-disp-btn primary" type="button" data-rr-action="resend_screening">Resend screening</button>`;
  } else if (stage === "screened") {
    primaryBtn = `<button class="pa-disp-btn primary" type="button" data-rr-action="send_link">Send booking link</button>`;
  } else if (stage === "booking_pending") {
    primaryBtn = `<button class="pa-disp-btn primary" type="button" data-rr-action="resend_link">Resend booking link</button>`;
  } else if (stage === "booking_scheduled") {
    primaryBtn = `<button class="pa-disp-btn primary" type="button" data-rr-action="reschedule">Reschedule</button>
                  <button class="pa-disp-btn danger" type="button" data-rr-action="cancel_interview">Cancel interview</button>`;
  }

  const videoBtn = a.video_url
    ? `<button class="pa-disp-btn ghost" type="button" data-rr-action="play_video" data-video-url="${encodeURI(a.video_url)}">Intro video</button>`
    : "";
  const emailBtn = a.email
    ? `<button class="pa-disp-btn ghost" type="button" data-rr-action="email_thread">Email</button>`
    : "";

  // Screening Q&A is rendered inline inside the expanded detail. The
  // slot loads lazily on first expand (see _loadScreeningAnswersInto)
  // so we don't N+1 the DB on every list render.
  const answersBlock = stage !== "applied" ? `
    <div class="pa-detail-section">
      <div class="pa-detail-section-title">Screening answers</div>
      <div class="pa-qa" data-rr-screening-slot>
        <div style="color:var(--text-subtle);font-size:var(--fs-sm);grid-column:1 / -1">Loading answers…</div>
      </div>
    </div>` : "";

  // Operator scratchpad — private notes for the DSP (call summaries,
  // follow-ups, gut checks). Lazy-loads on expand and auto-saves on
  // blur so there's no Save button to remember.
  const notesBlock = `
    <div class="pa-detail-section">
      <div class="pa-detail-section-title">Notes</div>
      <div class="pa-notes" data-rr-notes-slot>
        <textarea class="pa-notes-input" data-rr-notes-input placeholder="Private notes for your team — call summaries, follow-ups, gut checks…" disabled></textarea>
        <div class="pa-detail-section-meta" data-rr-notes-status>Loading…</div>
      </div>
    </div>`;

  return `
    <div class="pa-card" data-stage="${stage}" data-applicant="${a.id}" data-applicant-slug="${slug}">
      <div class="pa-row">
        <div class="pa-card-stage">
          <span class="pa-stage-pill ${stage}">${escapeHtml(stageLabel)}</span>
          ${relTime ? `<span class="pa-card-time">${escapeHtml(relTime)}</span>` : ""}
        </div>
        <div class="pa-card-body">
          <div class="pa-card-header">
            <div class="pa-card-avatar ${_tierClassFromScore(a.score)}">${escapeHtml(_initialsOf(name))}</div>
            <div>
              <div class="pa-card-name">${escapeHtml(name)}</div>
              <div class="pa-card-meta">${escapeHtml(meta)}</div>
            </div>
          </div>
          ${scoreChip ? `<div class="pa-card-tags">${scoreChip}</div>` : ""}
        </div>
        <div class="pa-card-actions">
          <button class="pa-view-btn" type="button" onclick="paToggle(this)">View<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></button>
        </div>
      </div>
      <div class="pa-detail">
        ${answersBlock}
        ${notesBlock}
        <div class="pa-actions-bar">
          <button class="pa-disp-btn ghost" type="button" data-rr-action="call">Call</button>
          ${emailBtn}
          ${videoBtn}
          <button class="pa-disp-btn danger" type="button" data-rr-action="decline">Decline</button>
          ${primaryBtn}
        </div>
      </div>
    </div>`;
}

function _initialsOf(name) {
  if (!name) return "?";
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function _tierClassFromScore(score) {
  if (score === null || score === undefined) return "tier-d";
  if (score >= 7) return "tier-a";
  if (score >= 4) return "tier-b";
  if (score >= 1) return "tier-c";
  return "tier-d";
}

function _relTimeShort(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Open the applicant's video intro in a simple modal overlay.
function openVideoModal(url) {
  let overlay = document.getElementById("rr-video-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "rr-video-overlay";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;cursor:pointer";
    overlay.addEventListener("click", () => { overlay.remove(); });
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <video controls autoplay playsinline
           style="max-width:100%;max-height:90vh;border-radius:12px;background:#000"
           src="${url}"></video>`;
}

// ─── Applicant email thread modal ─────────────────────────────────────
//
// Two-way email on the applicant card. Reads the thread via
// applicant_email_thread RPC (added in migration 0095), renders inbound
// + outbound rows, and lets the operator queue a reply that send-email
// will dispatch on its next tick.

// Lazily fetch and render an applicant's screening answers into the
// expanded detail panel's [data-rr-screening-slot] container. Cached
// per-card via the loaded flag so re-expanding doesn't re-fetch.
async function _loadScreeningAnswersInto(slot, applicantId) {
  if (!slot || slot.dataset.loaded === "1") return;
  slot.dataset.loaded = "1";

  const { data: rows, error } = await sb
    .from("screening_responses")
    .select("answer_text, answer_json, score_awarded, hard_filter_failed, created_at, screening_questions(prompt, field_type, display_order)")
    .eq("applicant_id", applicantId)
    .order("created_at", { ascending: true });

  if (error) {
    slot.innerHTML = `<div style="color:var(--red);font-size:var(--fs-sm);grid-column:1 / -1">Couldn't load: ${escapeHtml(error.message)}</div>`;
    slot.dataset.loaded = "";
    return;
  }
  if (!rows || rows.length === 0) {
    slot.innerHTML = `<div style="color:var(--text-subtle);font-size:var(--fs-sm);grid-column:1 / -1">No answers submitted yet.</div>`;
    return;
  }

  const fmtAnswer = (r) => {
    if (r.answer_text && String(r.answer_text).trim()) return escapeHtml(r.answer_text);
    if (r.answer_json !== null && r.answer_json !== undefined) {
      try { return escapeHtml(JSON.stringify(r.answer_json)); } catch { /* fall through */ }
    }
    return "—";
  };

  slot.innerHTML = rows.map((r) => {
    const prompt = r.screening_questions?.prompt || "(question deleted)";
    const failClass = r.hard_filter_failed ? " fail" : "";
    return `
      <div class="pa-qa-item">
        <div class="pa-qa-q">${escapeHtml(prompt)}</div>
        <div class="pa-qa-a${failClass}">${fmtAnswer(r)}</div>
      </div>`;
  }).join("");
}

// Wrap the prototype's paToggle so that expanding a card also kicks off
// the screening-answer fetch for the slot inside .pa-detail. The
// original toggle logic still runs first (handles class flips + scroll).
const _origPaToggle = window.paToggle;
window.paToggle = function (btn) {
  if (typeof _origPaToggle === "function") _origPaToggle(btn);
  const card = btn?.closest?.(".pa-card");
  if (!card || !card.classList.contains("expanded")) return;
  const id = card.getAttribute("data-applicant");
  if (!id) return;
  const screeningSlot = card.querySelector("[data-rr-screening-slot]");
  if (screeningSlot) _loadScreeningAnswersInto(screeningSlot, id);
  const notesSlot = card.querySelector("[data-rr-notes-slot]");
  if (notesSlot) _initApplicantNotes(notesSlot, id);
};

// Lazy-load notes textarea contents and wire blur-based auto-save.
// Idempotent — re-expanding the same card is a no-op.
async function _initApplicantNotes(slot, applicantId) {
  if (!slot || slot.dataset.loaded === "1") return;
  slot.dataset.loaded = "1";

  const ta     = slot.querySelector("[data-rr-notes-input]");
  const status = slot.querySelector("[data-rr-notes-status]");
  if (!ta || !status) return;

  const { data, error } = await sb
    .from("applicants")
    .select("operator_notes")
    .eq("id", applicantId)
    .single();
  if (error) {
    status.textContent = "Couldn't load notes: " + error.message;
    status.style.color = "var(--red)";
    slot.dataset.loaded = "";
    return;
  }
  ta.value = data?.operator_notes ?? "";
  ta.disabled = false;
  status.textContent = "";

  let lastSaved = ta.value;
  ta.addEventListener("blur", async () => {
    const next = ta.value;
    if (next === lastSaved) return;
    status.textContent = "Saving…";
    status.style.color = "var(--text-subtle)";
    const { error: upErr } = await sb
      .from("applicants")
      .update({ operator_notes: next || null })
      .eq("id", applicantId);
    if (upErr) {
      status.textContent = "Save failed: " + upErr.message;
      status.style.color = "var(--red)";
      return;
    }
    lastSaved = next;
    const t = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    status.textContent = `Saved at ${t}`;
    status.style.color = "var(--text-subtle)";
  });
}


async function openEmailThreadModal(applicantId, fullName, toEmail) {
  let m = document.getElementById("rr-email-thread-modal");
  if (m) m.remove();
  m = document.createElement("div");
  m.id = "rr-email-thread-modal";
  m.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px";
  m.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;width:100%;max-width:640px;max-height:88vh;display:flex;flex-direction:column;overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid var(--border)">
        <div>
          <div style="font-size:var(--fs-lg);font-weight:600">Email · ${escapeHtml(rrTitleCaseName(fullName))}</div>
          <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">${escapeHtml(toEmail || "—")}</div>
        </div>
        <button class="btn btn-sm" data-rr-email-close>Close</button>
      </div>
      <div id="rr-email-thread-body" style="flex:1;overflow-y:auto;padding:18px 22px;display:flex;flex-direction:column;gap:14px">
        <div style="color:var(--text-subtle);font-size:var(--fs-sm)">Loading thread…</div>
      </div>
      <div style="border-top:1px solid var(--border);padding:14px 22px;background:var(--surface)">
        <textarea id="rr-email-reply-body" placeholder="Type your reply…" style="width:100%;min-height:80px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font:inherit;resize:vertical;box-sizing:border-box"></textarea>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px">
          <button class="btn btn-primary" id="rr-email-reply-send">Send reply</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(m);

  m.addEventListener("click", async (e) => {
    if (e.target === m || e.target.closest("[data-rr-email-close]")) {
      m.remove(); return;
    }
    if (e.target.closest("#rr-email-reply-send")) {
      const body = document.getElementById("rr-email-reply-body").value.trim();
      if (!body) { toast("Type a reply first", "warn"); return; }
      const sendBtn = e.target.closest("button");
      sendBtn.disabled = true; sendBtn.textContent = "Sending…";
      const { error } = await sb.rpc("send_applicant_email", {
        p_applicant_id: applicantId, p_body: body, p_subject: null,
      });
      if (error) {
        toast("Send failed: " + error.message, "warn");
        sendBtn.disabled = false; sendBtn.textContent = "Send reply";
        return;
      }
      document.getElementById("rr-email-reply-body").value = "";
      toast("Reply queued", "success");
      sendBtn.disabled = false; sendBtn.textContent = "Send reply";
      await _renderEmailThread(applicantId);
    }
  });

  await _renderEmailThread(applicantId);
}

async function _renderEmailThread(applicantId) {
  const body = document.getElementById("rr-email-thread-body");
  if (!body) return;
  const { data: rows, error } = await sb.rpc("applicant_email_thread", { p_applicant_id: applicantId });
  if (error) {
    body.innerHTML = `<div style="color:var(--red);font-size:var(--fs-sm)">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!rows || rows.length === 0) {
    body.innerHTML = `<div style="color:var(--text-subtle);font-size:var(--fs-sm)">No emails yet. Send the first one below.</div>`;
    return;
  }
  body.innerHTML = rows.map(_renderEmailRow).join("");
  body.scrollTop = body.scrollHeight;
}

function _renderEmailRow(r) {
  const inbound = r.direction === "inbound";
  const align = inbound ? "flex-start" : "flex-end";
  const bg    = inbound ? "var(--surface-pressed)" : "rgba(15,108,189,.10)";
  const sender = inbound ? "Applicant" : "You";
  const when   = r.created_at ? new Date(r.created_at).toLocaleString() : "";
  const status = inbound ? "" : ` · ${r.status}`;
  // Plaintext only — body_html is intentionally not injected to avoid
  // remote-content shenanigans inside the operator dashboard.
  const text = (r.body_text || "").replace(/\s+$/g, "");
  return `
    <div style="display:flex;flex-direction:column;align-items:${align};gap:4px">
      <div style="font-size:var(--fs-xs);color:var(--text-subtle)">${escapeHtml(sender)} · ${escapeHtml(when)}${status}</div>
      <div style="max-width:88%;background:${bg};border:1px solid var(--border);border-radius:12px;padding:10px 14px">
        <div style="font-size:var(--fs-sm);font-weight:600;margin-bottom:4px">${escapeHtml(r.subject || "(no subject)")}</div>
        <div style="font-size:var(--fs-sm);white-space:pre-wrap;line-height:1.5">${escapeHtml(text)}</div>
      </div>
    </div>`;
}

async function loadPipeline(stage = "all") {
  const list = $("#pipe-applicants");
  if (!list) return;

  const [{ data: rows, error }, { data: counts }] = await Promise.all([
    sb.rpc("pipeline_list", { p_stage: stage, p_limit: 200 }),
    sb.rpc("pipeline_counts"),
  ]);
  if (error) {
    toast("Pipeline load failed: " + error.message, "warn");
    return;
  }

  // Update tab counts. Always set (including 0) so the mockup defaults
  // don't bleed through when a stage is empty.
  const countMap = Object.fromEntries((counts ?? []).map(r => [r.stage, r.count]));
  $$("#pipeline-stage-tabs .stage-tab").forEach(btn => {
    const s = btn.getAttribute("data-stage");
    const el = btn.querySelector(".stage-tab-count");
    if (el) el.textContent = countMap[s] ?? 0;
  });

  list.innerHTML = (rows ?? []).map(renderApplicantCard).join("")
    || `<div class="rr-empty-inline">No applicants yet — share your apply link or add one manually.</div>`;
}

// ─── paAction override ─────────────────────────────────────────────────────
//
// The mockup wires onclick="paAction(this,'send_link','Marcus Hill')". We
// intercept at the document level via delegated listener; if the button
// has data-rr-action (live cards), we use that and dispatch to the RPC.
// If it has the legacy onclick (static seeded HTML), we still handle it
// the same way using the card's data-applicant.

async function handleAction(btn) {
  // Funnel cards use .pa-card[data-applicant]; Interview Day cards use
  // .iv-card[data-applicant-id]. Reschedule / Cancel interview surface
  // on both, so the handler accepts either.
  const card = btn.closest(".pa-card, .iv-card");
  if (!card) return;
  const id     = card.getAttribute("data-applicant") || card.getAttribute("data-applicant-id");
  const action = btn.getAttribute("data-rr-action");
  if (!id || !action) return;

  btn.disabled = true;

  try {
    if (action === "resend_screening") {
      const { error } = await sb.rpc("send_screening_link", { p_id: id });
      if (error) throw error;
      toast("Screening link sent", "success");
    } else if (action === "send_link" || action === "resend_link") {
      const { error } = await sb.rpc("send_booking_link", { p_id: id, p_kind: "interview" });
      if (error) throw error;
      toast("Booking link sent", "success");
    } else if (action === "decline") {
      if (!confirm("Decline this applicant?")) { btn.disabled = false; return; }
      const { error } = await sb.rpc("decline_applicant", { p_id: id, p_reason: "Manual decline" });
      if (error) throw error;
      toast("Applicant declined", "warn");
    } else if (action === "reschedule" || action === "cancel_interview") {
      const isReschedule = action === "reschedule";
      const promptText = isReschedule
        ? "Reason for asking them to reschedule? (optional · stays internal)"
        : "Reason for cancelling the interview? (optional · stays internal)";
      const reason = prompt(promptText);
      if (reason === null) { btn.disabled = false; return; }
      // Both wire to the cancel_interview RPC: it voids the current
      // booking, queues the cancellation SMS/email with a fresh booking
      // link, and reverts applicant.status to interview_invited so they
      // show up in Booking pending. Operators get separate buttons
      // because the wording on the operator side ("Reschedule" vs
      // "Cancel interview") matches different conversations they're
      // having with the applicant.
      const { error } = await sb.rpc("cancel_interview", { p_applicant_id: id, p_reason: reason || null });
      if (error) throw error;
      toast(isReschedule
        ? "Reschedule requested · applicant sent a new booking link"
        : "Interview cancelled · applicant sent a new booking link", "success");
    } else if (action === "call") {
      // Dial via tel: link; no backend call.
      const { data } = await sb.from("applicants").select("phone").eq("id", id).single();
      if (data?.phone) location.href = `tel:${data.phone}`;
      else toast("No phone on file", "warn");
      btn.disabled = false;
      return;
    } else if (action === "play_video") {
      const url = btn.getAttribute("data-video-url");
      if (url) openVideoModal(url);
      btn.disabled = false;
      return;
    } else if (action === "email_thread") {
      // Look up the applicant's display name for the modal header.
      const { data: a } = await sb.from("applicants")
        .select("full_name, email").eq("id", id).single();
      openEmailThreadModal(id, a?.full_name || "", a?.email || "");
      btn.disabled = false;
      return;
    }
    await loadPipeline(getActiveStage());
    // If the action originated from the Interview Day card, also refresh
    // that view so the rescheduled / cancelled applicant disappears
    // immediately. Funnel-only actions still refresh just the funnel.
    if (card.classList.contains("iv-card") && typeof loadInterviewDay === "function") {
      await loadInterviewDay();
    }
  } catch (e) {
    toast("Action failed: " + (e.message ?? e), "warn");
    btn.disabled = false;
  }
}

document.addEventListener("click", (e) => {
  // Watch-video pill works on both .pa-card and .iv-card — handle as a
  // standalone action that doesn't need a parent card lookup.
  const playBtn = e.target.closest("[data-rr-play-video]");
  if (playBtn) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const url = playBtn.getAttribute("data-video-url");
    if (url) openVideoModal(url);
    return;
  }
  const btn = e.target.closest("[data-rr-action]");
  if (btn) {
    e.preventDefault();
    e.stopImmediatePropagation();
    handleAction(btn);
  }
}, true);

// Replace the mockup's window.paAction with a thin shim that uses the
// data-rr-action path so legacy seeded inline-onclick markup keeps working
// after the first re-render (until then it triggers the mockup's toast).
const _legacyPaAction = window.paAction;
window.paAction = function (btn, action, _name) {
  btn.setAttribute("data-rr-action", action);
  return handleAction(btn);
};

// ─── Stage filter + view-switch hooks ──────────────────────────────────────

function getActiveStage() {
  const active = $("#pipeline-stage-tabs .stage-tab.active");
  return active?.getAttribute("data-stage") ?? "all";
}

const _legacyFilter = window.filterPipelineStage;
window.filterPipelineStage = function (btn) {
  if (typeof _legacyFilter === "function") _legacyFilter(btn);
  loadPipeline(btn.getAttribute("data-stage") ?? "all");
};

const _legacyGoto = window.goto;
window.goto = function (view) {
  if (typeof _closeAttKpiDetail === "function")     _closeAttKpiDetail();
  if (typeof _closeAvailKpiDetail === "function")   _closeAvailKpiDetail();
  if (typeof _closeRosterKpiDetail === "function")  _closeRosterKpiDetail();
  if (typeof _legacyGoto === "function") _legacyGoto(view);
  if (view === "pipeline")  loadPipeline(getActiveStage());
  if (view === "drivers")   loadDriversRoster();
  if (view === "checkin")   loadCheckinView();
  if (view === "dashboard") { loadTodayPlan(); }
  if (view === "messages")  loadDriverChatInbox();
  if (view === "forms")     loadFormsList();
  if (view === "admin")     loadPlatformAdmin();
  if (view === "outlook")   loadStaffingOutlook();
};

// ── Platform admin view ────────────────────────────────────────────────────
// Cross-tenant DSP management.  Backed by the SECURITY DEFINER admin_*
// RPCs from migration 0124; each RPC re-checks is_platform_admin() in
// its body so calling it as a non-admin returns 'forbidden'.

// Module-level state for the admin table.  Loaded once per view-enter
// from admin_list_dsps(); search / filter / sort / page operate on the
// in-memory copy (it tops out at a few hundred rows even at 100×
// growth, so client-side is fine and feels instant).
const _admin = {
  dsps: [],
  search: "",
  filterStatus: "",
  filterPlan: "",
  sort: "created_at:desc",
  page: 1,
  pageSize: 25,
  loaded: false,
};

async function loadPlatformAdmin() {
  if (profile.role !== "platform_admin") {
    // Defensive: a non-admin somehow landed on the view (deep link,
    // back button after role change, etc.).  Bounce them rather than
    // letting them sit on a permission-denied page.
    window.goto("dashboard");
    return;
  }
  await Promise.all([_loadPlatformAdminStats(), _loadPlatformAdminDsps()]);
}

async function _loadPlatformAdminStats() {
  const { data, error } = await sb.rpc("admin_kpis");
  const slots = document.querySelectorAll('#view-admin [data-rr-admin-stat-value]');
  if (error) {
    if (_isAuthError(error)) _forceRelogin("session_expired");
    console.error("admin_kpis failed:", error);
    slots.forEach((el) => { el.textContent = "—"; });
    if (typeof toast === "function") toast(`Couldn't load admin stats: ${error.message}`, "warn");
    return;
  }
  const kpis = data || {};
  const map = {
    total:     kpis.total ?? 0,
    active:    kpis.active ?? 0,
    pending:   kpis.pending ?? 0,
    suspended: kpis.suspended ?? 0,
  };
  for (const [key, value] of Object.entries(map)) {
    const card = document.querySelector(`#view-admin [data-rr-admin-stat="${key}"]`);
    if (!card) continue;
    const slot = card.querySelector("[data-rr-admin-stat-value]");
    if (!slot) continue;
    slot.textContent = String(value);
  }
}

async function _loadPlatformAdminDsps() {
  const tbody = document.getElementById("rr-admin-tbody");
  if (!tbody) return;
  // Skeleton rows are already in the markup; only show them on the
  // FIRST load to avoid a flash on subsequent re-paints.
  if (!_admin.loaded) {
    tbody.innerHTML = `
      <tr><td colspan="10" class="rr-admin-skel"><span></span></td></tr>
      <tr><td colspan="10" class="rr-admin-skel"><span></span></td></tr>
      <tr><td colspan="10" class="rr-admin-skel"><span></span></td></tr>`;
  }
  const { data, error } = await sb.rpc("admin_list_dsps");
  if (error) {
    if (_isAuthError(error)) _forceRelogin("session_expired");
    console.error("admin_list_dsps failed:", error);
    tbody.innerHTML = `<tr><td colspan="10" style="padding:24px;color:var(--red);text-align:center">${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  _admin.dsps = data || [];
  _admin.loaded = true;
  _renderPlatformAdminTable();
}

function _adminFilteredDsps() {
  const q = _admin.search.trim().toLowerCase();
  let rows = _admin.dsps.slice();
  if (q) {
    rows = rows.filter((d) => {
      const haystack = [
        d.name, d.short_code, d.owner_email, d.owner_name, d.phone, d.address, d.notes,
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }
  if (_admin.filterStatus) rows = rows.filter((d) => d.status === _admin.filterStatus);
  if (_admin.filterPlan)   rows = rows.filter((d) => d.subscription_plan === _admin.filterPlan);

  const [field, dir] = _admin.sort.split(":");
  const mul = dir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    const av = a[field], bv = b[field];
    // null-last sort: missing values always sink regardless of direction
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * mul;
    if (field === "created_at" || field === "last_active_at") {
      return (new Date(av).getTime() - new Date(bv).getTime()) * mul;
    }
    return String(av).localeCompare(String(bv)) * mul;
  });
  return rows;
}

function _adminFmtRelative(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1)   return "just now";
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

function _renderPlatformAdminTable() {
  const tbody    = document.getElementById("rr-admin-tbody");
  const empty    = document.getElementById("rr-admin-empty");
  const emptySub = document.getElementById("rr-admin-empty-sub");
  const count    = document.getElementById("rr-admin-row-count");
  const pagWrap  = document.getElementById("rr-admin-pagination");
  if (!tbody) return;

  const filtered = _adminFilteredDsps();
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / _admin.pageSize));
  if (_admin.page > totalPages) _admin.page = totalPages;
  const start = (_admin.page - 1) * _admin.pageSize;
  const pageRows = filtered.slice(start, start + _admin.pageSize);

  if (count) {
    const all = _admin.dsps.length;
    count.textContent = total === all
      ? `${all} DSP${all === 1 ? "" : "s"}`
      : `${total} of ${all} DSPs`;
  }

  if (total === 0) {
    tbody.innerHTML = "";
    if (empty) empty.hidden = false;
    if (emptySub) {
      emptySub.textContent = (_admin.dsps.length === 0)
        ? "Add your first DSP client to get started."
        : "Try clearing filters or search.";
    }
    if (pagWrap) pagWrap.hidden = true;
    return;
  }
  if (empty) empty.hidden = true;

  tbody.innerHTML = pageRows.map((d) => _renderAdminRow(d)).join("");
  _bindAdminRowActions();

  // Pagination
  if (pagWrap) {
    pagWrap.hidden = total <= _admin.pageSize;
    const sumEl  = document.getElementById("rr-admin-pagination-summary");
    const lblEl  = document.getElementById("rr-admin-page-label");
    const prevEl = document.getElementById("rr-admin-page-prev");
    const nextEl = document.getElementById("rr-admin-page-next");
    if (sumEl)  sumEl.textContent  = `Showing ${start + 1}–${Math.min(start + _admin.pageSize, total)} of ${total}`;
    if (lblEl)  lblEl.textContent  = `Page ${_admin.page} of ${totalPages}`;
    if (prevEl) prevEl.disabled    = _admin.page <= 1;
    if (nextEl) nextEl.disabled    = _admin.page >= totalPages;
  }
}

function _renderAdminRow(d) {
  const statusClass =
    d.status === "active"    ? "status-pill-success" :
    d.status === "pending"   ? "status-pill-pending" :
    d.status === "suspended" ? "status-pill-danger"  : "status-pill-neutral";
  const statusLabel =
    d.status === "active"    ? "Active" :
    d.status === "pending"   ? "Pending" :
    d.status === "suspended" ? "Suspended" : (d.status || "—");
  const planClass = d.subscription_plan === "enterprise"
    ? "rr-admin-cell-plan rr-admin-cell-plan--enterprise"
    : d.subscription_plan === "growth"
      ? "rr-admin-cell-plan rr-admin-cell-plan--growth"
      : "rr-admin-cell-plan";
  const ownerLine = d.owner_name
    ? escapeHtml(d.owner_name)
    : `<span class="rr-admin-cell-muted">No owner yet</span>`;
  const emailLine = d.owner_email
    ? `<a href="mailto:${escapeHtml(d.owner_email)}" style="color:inherit;text-decoration:none">${escapeHtml(d.owner_email)}</a>`
    : `<span class="rr-admin-cell-muted">—</span>`;
  const phoneLine = d.phone
    ? escapeHtml(d.phone)
    : `<span class="rr-admin-cell-muted">—</span>`;

  // Suspend vs Reactivate based on current status.
  const suspendItem = d.status === "suspended"
    ? `<button class="rr-admin-row-actions__item" data-rr-admin-action="reactivate"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>Reactivate account</button>`
    : `<button class="rr-admin-row-actions__item rr-admin-row-actions__item--danger" data-rr-admin-action="suspend"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>Suspend account</button>`;

  return `
    <tr data-rr-admin-row="${escapeHtml(d.id)}">
      <td>
        <div class="rr-admin-cell-dsp">
          <div class="rr-admin-cell-dsp__name">${escapeHtml(d.name || "—")}</div>
          ${d.short_code ? `<div class="rr-admin-cell-dsp__sub">${escapeHtml(d.short_code)}</div>` : ""}
        </div>
      </td>
      <td>${ownerLine}</td>
      <td>${emailLine}</td>
      <td>${phoneLine}</td>
      <td><span class="status-pill ${statusClass}">${escapeHtml(statusLabel)}</span></td>
      <td class="rr-admin-cell-num">${d.driver_count ?? 0}</td>
      <td class="rr-admin-cell-num"><span class="rr-admin-cell-muted">${d.route_count ?? 0}</span></td>
      <td><span class="${planClass}">${escapeHtml(d.subscription_plan || "starter")}</span></td>
      <td class="rr-admin-cell-muted">${_adminFmtRelative(d.last_active_at)}</td>
      <td class="rr-admin-row-actions">
        <button class="rr-admin-row-actions__btn" data-rr-admin-toggle="${escapeHtml(d.id)}" aria-label="Open actions">
          <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
        </button>
        <div class="rr-admin-row-actions__menu" data-rr-admin-menu="${escapeHtml(d.id)}" hidden>
          <button class="rr-admin-row-actions__item" data-rr-admin-action="view"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>View details</button>
          <button class="rr-admin-row-actions__item" data-rr-admin-action="edit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>Edit account</button>
          <button class="rr-admin-row-actions__item" data-rr-admin-action="users"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>Manage users</button>
          <div class="rr-admin-row-actions__sep"></div>
          ${suspendItem}
          <button class="rr-admin-row-actions__item rr-admin-row-actions__item--danger" data-rr-admin-action="delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>Delete account</button>
        </div>
      </td>
    </tr>`;
}

function _bindAdminRowActions() {
  // Action buttons on rows.  Delegated to the document so the bind
  // happens once and survives every re-render.
  if (_bindAdminRowActions._bound) return;
  _bindAdminRowActions._bound = true;

  document.addEventListener("click", (e) => {
    // Toggle the per-row "..." menu.
    const tgl = e.target.closest("[data-rr-admin-toggle]");
    if (tgl) {
      e.stopPropagation();
      const id = tgl.getAttribute("data-rr-admin-toggle");
      const menu = document.querySelector(`[data-rr-admin-menu="${id}"]`);
      const wasOpen = menu && !menu.hidden;
      // Close every other menu first.
      document.querySelectorAll('[data-rr-admin-menu]').forEach((m) => { m.hidden = true; });
      if (menu && !wasOpen) menu.hidden = false;
      return;
    }
    // Run an action.
    const item = e.target.closest("[data-rr-admin-action]");
    if (item) {
      const row = item.closest("[data-rr-admin-row]");
      const dspId = row?.getAttribute("data-rr-admin-row");
      const action = item.getAttribute("data-rr-admin-action");
      if (!dspId) return;
      _runAdminAction(action, dspId);
      // Close the menu.
      document.querySelectorAll('[data-rr-admin-menu]').forEach((m) => { m.hidden = true; });
      return;
    }
    // Click anywhere else closes any open menu.
    if (!e.target.closest('[data-rr-admin-menu]')) {
      document.querySelectorAll('[data-rr-admin-menu]').forEach((m) => { m.hidden = true; });
    }
  });
}

async function _runAdminAction(action, dspId) {
  const dsp = _admin.dsps.find((d) => d.id === dspId);
  if (!dsp) return;
  switch (action) {
    case "view":
    case "edit":
      _openAdminEditDspModal(dspId);
      return;
    case "users":
      _openAdminManageUsers(dspId);
      return;
    case "suspend": {
      if (!confirm(`Suspend "${dsp.name}"?\n\nAll users at this DSP will lose access until you reactivate.`)) return;
      const { error } = await sb.rpc("admin_suspend_dsp", { p_dsp_id: dspId });
      if (error) {
        if (_isAuthError(error)) _forceRelogin("session_expired");
        toast(`Couldn't suspend: ${error.message}`, "warn");
        return;
      }
      toast(`${dsp.name} suspended.`, "ok");
      await Promise.all([_loadPlatformAdminStats(), _loadPlatformAdminDsps()]);
      return;
    }
    case "reactivate": {
      if (!confirm(`Reactivate "${dsp.name}"?`)) return;
      const { error } = await sb.rpc("admin_reactivate_dsp", { p_dsp_id: dspId });
      if (error) {
        if (_isAuthError(error)) _forceRelogin("session_expired");
        toast(`Couldn't reactivate: ${error.message}`, "warn");
        return;
      }
      toast(`${dsp.name} reactivated.`, "ok");
      await Promise.all([_loadPlatformAdminStats(), _loadPlatformAdminDsps()]);
      return;
    }
    case "delete": {
      _openAdminDeleteDspModal(dsp);
      return;
    }
  }
}

function _adminCsvExport() {
  const rows = _adminFilteredDsps();
  const cols = [
    ["DSP",          (d) => d.name || ""],
    ["Short code",   (d) => d.short_code || ""],
    ["Owner",        (d) => d.owner_name || ""],
    ["Email",        (d) => d.owner_email || ""],
    ["Phone",        (d) => d.phone || ""],
    ["Address",      (d) => d.address || ""],
    ["Status",       (d) => d.status || ""],
    ["Plan",         (d) => d.subscription_plan || ""],
    ["Drivers",      (d) => d.driver_count ?? 0],
    ["Routes",       (d) => d.route_count ?? 0],
    ["Last active",  (d) => d.last_active_at || ""],
    ["Created",      (d) => d.created_at || ""],
    ["Notes",        (d) => d.notes || ""],
  ];
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map(([h]) => esc(h)).join(",")];
  for (const r of rows) lines.push(cols.map(([, fn]) => esc(fn(r))).join(","));
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `routeready-dsps-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Wire the toolbar + CTA buttons once the DOM is ready.  IMPORTANT:
// live.js uses top-level `await` (the auth gate at the top of the
// file).  The HTML spec does NOT delay DOMContentLoaded for module
// promises, so any code AFTER the top-level await runs AFTER DCL has
// already fired.  Registering `document.addEventListener("DOMContent-
// Loaded", ...)` here would silently never fire — the original Phase
// 3/4a/4c bug where Add-DSP / Invite-user / search / sort / etc. all
// looked dead.  Bind directly instead; the DOM is guaranteed parsed
// by the time the post-await code reaches this line.
function _bindAdminPageHandlers() {
  const search   = document.getElementById("rr-admin-search");
  const fStatus  = document.getElementById("rr-admin-filter-status");
  const fPlan    = document.getElementById("rr-admin-filter-plan");
  const sortSel  = document.getElementById("rr-admin-sort");
  const exportEl = document.getElementById("rr-admin-export");
  const prevEl   = document.getElementById("rr-admin-page-prev");
  const nextEl   = document.getElementById("rr-admin-page-next");
  const emptyCta = document.getElementById("rr-admin-empty-cta");

  search?.addEventListener("input", () => {
    _admin.search = search.value;
    _admin.page = 1;
    _renderPlatformAdminTable();
  });
  fStatus?.addEventListener("change", () => { _admin.filterStatus = fStatus.value; _admin.page = 1; _renderPlatformAdminTable(); });
  fPlan?.addEventListener("change",   () => { _admin.filterPlan   = fPlan.value;   _admin.page = 1; _renderPlatformAdminTable(); });
  sortSel?.addEventListener("change", () => { _admin.sort         = sortSel.value;  _renderPlatformAdminTable(); });
  exportEl?.addEventListener("click", () => _adminCsvExport());
  prevEl?.addEventListener("click", () => { if (_admin.page > 1) { _admin.page -= 1; _renderPlatformAdminTable(); }});
  nextEl?.addEventListener("click", () => { _admin.page += 1; _renderPlatformAdminTable(); });
  emptyCta?.addEventListener("click", () => document.getElementById("rr-admin-add-dsp")?.click());

  // "Add DSP client" → open the Phase-4a modal.
  document.getElementById("rr-admin-add-dsp")?.addEventListener("click", () => {
    _openAdminAddDspModal();
  });
  // "Invite user" → open the invite modal.
  document.getElementById("rr-admin-invite-user")?.addEventListener("click", () => {
    _openAdminInviteUser();
  });
  // Invite form submit.
  document.getElementById("rr-admin-invite-form")?.addEventListener("submit", _submitAdminInviteUser);

  // Auto-suggest short code from DSP name as the operator types.
  // (The Add-DSP modal used to expose a "Station code" field that
  // collided whenever multiple DSPs operated out of the same Amazon
  // station.  Migration 0125 makes the server auto-generate a unique
  // workspace identifier from the DSP name, so the field is gone
  // from the UI and the auto-suggest logic that fed it is no longer
  // needed.)

  // Form submit handlers.
  document.getElementById("rr-admin-add-dsp-form")?.addEventListener("submit", _submitAdminAddDsp);
  document.getElementById("rr-admin-edit-dsp-form")?.addEventListener("submit", _submitAdminEditDsp);
}
// Run immediately (post-await means the DOM is already parsed) — no
// need to wait for DCL, and waiting would silently break us.
_bindAdminPageHandlers();

// ── Delete-DSP modal ───────────────────────────────────────────────────────
// Hard delete via admin_delete_dsp RPC.  Typed-name confirmation
// guards against accidental clicks.  The Delete button stays
// disabled until the confirmation input matches the DSP name
// exactly (case-insensitive whitespace-trimmed).

function _openAdminDeleteDspModal(dsp) {
  const idEl    = document.getElementById("rr-delete-dsp-id");
  const nameEl  = document.getElementById("rr-delete-dsp-name");
  const dispEl  = document.getElementById("rr-delete-dsp-name-display");
  const subEl   = document.getElementById("rr-delete-dsp-sub");
  const confEl  = document.getElementById("rr-delete-dsp-confirm");
  const submit  = document.getElementById("rr-admin-delete-dsp-submit");
  const errEl   = document.getElementById("rr-admin-delete-dsp-error");
  if (idEl)    idEl.value      = dsp.id;
  if (nameEl)  nameEl.value    = dsp.name || "";
  if (dispEl)  dispEl.textContent = dsp.name || "—";
  if (subEl)   subEl.textContent  = `${dsp.name} · ${dsp.short_code || "—"}`;
  if (confEl)  { confEl.value = ""; confEl.placeholder = dsp.name || ""; }
  if (submit)  submit.disabled = true;
  if (errEl)   { errEl.hidden = true; errEl.textContent = ""; }
  if (typeof window.openModal === "function") window.openModal("modal-admin-delete-dsp");
  setTimeout(() => confEl?.focus(), 60);
}

function _bindAdminDeleteDspHandlers() {
  const confEl = document.getElementById("rr-delete-dsp-confirm");
  const nameEl = document.getElementById("rr-delete-dsp-name");
  const submit = document.getElementById("rr-admin-delete-dsp-submit");
  const form   = document.getElementById("rr-admin-delete-dsp-form");
  if (!confEl || !nameEl || !submit || !form) return;

  // Live match check on the confirmation input.
  const refresh = () => {
    const target = (nameEl.value || "").trim().toLowerCase();
    const typed  = (confEl.value || "").trim().toLowerCase();
    submit.disabled = !(target && target === typed);
  };
  confEl.addEventListener("input", refresh);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const dspId  = document.getElementById("rr-delete-dsp-id")?.value;
    const name   = nameEl.value || "";
    const lbl    = submit.querySelector("[data-rr-delete-dsp-label]");
    const errEl  = document.getElementById("rr-admin-delete-dsp-error");
    if (!dspId) return;

    submit.disabled = true;
    if (lbl) lbl.textContent = "Deleting…";
    if (errEl) errEl.hidden = true;

    // Delete via the admin-delete-dsp edge function (full scrub —
    // DB cascade + auth.users + storage objects).  Falls back to the
    // SQL admin_delete_dsp RPC if the edge function isn't deployed
    // yet (DB-only delete; auth users + storage are left orphaned
    // but the DSP itself is gone).
    let resp = await sb.functions.invoke("admin-delete-dsp", {
      body: { p_dsp_id: dspId },
    });
    let raw = "";
    if (resp.error) {
      // Surface the function's structured error if present.
      try {
        const ctx = await resp.error.context?.json?.();
        if (ctx?.error) raw = ctx.error;
      } catch { /* fall through */ }
      raw = raw || resp.error.message || "";

      // If the edge function literally isn't deployed yet (404),
      // fall back to the SQL RPC so admins still have a delete
      // path during the deploy window.
      if (/not[\s_-]*found|404|deployment/i.test(raw) && !/dsp_not_found/.test(raw)) {
        const sqlResp = await sb.rpc("admin_delete_dsp", { p_dsp_id: dspId });
        if (!sqlResp.error) {
          resp = { data: { ok: true, fallback: "sql" }, error: null };
          raw = "";
        } else {
          raw = sqlResp.error.message || raw;
        }
      }
    }

    if (raw) {
      if (_isAuthError(resp.error)) _forceRelogin("session_expired");
      let msg = raw;
      if (/cannot_delete_own_dsp/.test(raw)) msg = "You can't delete the DSP your own account is attached to.";
      else if (/platform_admin_in_target_dsp/.test(raw)) msg = "Cannot delete this DSP — a platform admin is a member.  Move their account to another workspace first, then retry.";
      else if (/dsp_not_found/.test(raw))    msg = "That DSP no longer exists. Refresh the table.";
      else if (/forbidden/.test(raw))        msg = "You don't have admin access. Sign in as the platform admin.";
      else if (/inactive_caller/.test(raw))  msg = "Your account is inactive.  Contact an admin.";
      if (errEl) {
        errEl.textContent = msg;
        errEl.hidden = false;
      }
      submit.disabled = false;
      if (lbl) lbl.textContent = "Delete forever";
      return;
    }

    // Surface the per-leg cleanup tally so the operator can see what
    // actually got scrubbed.  Keeps the toast short for the happy
    // path; partial failures pass details into a longer toast.
    const summary = resp.data || {};
    const errs = Array.isArray(summary.errors) ? summary.errors : [];
    if (errs.length > 0) {
      console.warn("admin-delete-dsp partial errors:", errs);
      if (typeof toast === "function") {
        toast(`${name} deleted (with ${errs.length} cleanup warning${errs.length === 1 ? "" : "s"} — check console)`, "warn", 6000);
      }
    } else if (typeof toast === "function") {
      const auth = summary.auth_users_deleted ?? 0;
      const storage = summary.storage_objects_deleted ?? 0;
      const tail = (auth || storage)
        ? ` · ${auth} user${auth === 1 ? "" : "s"}, ${storage} file${storage === 1 ? "" : "s"} scrubbed`
        : "";
      toast(`${name} deleted${tail}.`, "ok", 5000);
    }
    if (typeof window.closeModal === "function") window.closeModal("modal-admin-delete-dsp");
    submit.disabled = false;
    if (lbl) lbl.textContent = "Delete forever";
    await Promise.all([_loadPlatformAdminStats(), _loadPlatformAdminDsps()]);
  });
}
// Bind once at module init (post-await DOM is parsed; no DCL race).
_bindAdminDeleteDspHandlers();

// ── Onboarding wizard ──────────────────────────────────────────────────────
// Backed by the migration 0126 RPCs:
//   onboarding_get_state()  — read + auto-flip pending → onboarding
//   onboarding_save_step()  — autosave per step (debounced 500ms on field blur)
//   onboarding_complete()   — finalize, flip status → active
//
// State machine in JS mirrors the schema:
//   not_started / company → contact → billing → complete
// Each card stays in the DOM at all times (display:none for inactive
// steps) so autosaved values from prior steps stay rehydrated without
// a re-render.

const _onb = {
  state:    null,            // last-known onboarding_get_state payload
  current:  "company",       // visible step
  saveTimer: null,           // debounce handle
  pendingStep: null,         // step whose payload is queued for autosave
};

async function _mountOnboarding() {
  // Kick off the state fetch + paint the form values when it lands.
  // Every other handler in this section is bound here too.
  await _onbLoadState();
  _onbBindHandlers();
  _onbGoToStep(_onbResumeStep());
}

async function _onbLoadState() {
  const { data, error } = await sb.rpc("onboarding_get_state");
  if (error) {
    if (_isAuthError(error)) _forceRelogin("session_expired");
    console.error("onboarding_get_state failed:", error);
    // Hard-fail: if the wizard can't even read its state, the user
    // can't make progress.  Surface the error in the company step's
    // error banner so they can at least see what's wrong.
    _onbError("company", `Couldn't load onboarding: ${error.message}`);
    return;
  }
  _onb.state = data || {};
  _onbPaintFromState();
  // Capacity for plan readonly + the activation copy.
  const plan = _onb.state.subscription_plan || "starter";
  const planEl = document.getElementById("rr-onb-plan-readonly");
  if (planEl) planEl.textContent = plan.charAt(0).toUpperCase() + plan.slice(1);
}

function _onbResumeStep() {
  // Resume at the FIRST incomplete step.  onboarding_step on the
  // schema means "the step the user has reached"; we want them on
  // that step, not past it.
  const s = _onb.state?.onboarding_step;
  if (s === "contact")  return "contact";
  if (s === "billing")  return "billing";
  return "company";
}

function _onbPaintFromState() {
  const s = _onb.state || {};
  const v = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
  v("rr-onb-name",                s.name);
  v("rr-onb-dba",                 s.dba);
  v("rr-onb-business-address",    s.business_address);
  v("rr-onb-business-phone",      s.business_phone);
  v("rr-onb-support-email",       s.support_email);
  v("rr-onb-timezone",            s.timezone || "America/New_York");
  v("rr-onb-owner-name",          s.owner_name);
  v("rr-onb-owner-phone",         s.owner_phone);
  v("rr-onb-emerg-name",          s.emergency_contact_name);
  v("rr-onb-emerg-phone",         s.emergency_contact_phone);
  const billing = s.billing || {};
  v("rr-onb-cardholder",          billing.cardholder);
  v("rr-onb-billing-email",       billing.billing_email || s.support_email || profile?.email);
  // We never restore the card number — only the last 4 are persisted,
  // and the form should look empty so the user knows the field is
  // editable / placeholder.
}

function _onbGoToStep(step) {
  _onb.current = step;
  // Toggle card visibility.
  ["company","contact","billing"].forEach((s) => {
    const card = document.querySelector(`[data-rr-onb-card="${s}"]`);
    if (card) card.style.display = (s === step) ? "" : "none";
  });
  // Update progress dots.
  const order = ["company","contact","billing"];
  const currentIdx = order.indexOf(step);
  order.forEach((s, i) => {
    const dot = document.querySelector(`[data-rr-onb-step="${s}"]`);
    if (!dot) return;
    dot.classList.remove("done","current");
    if (i < currentIdx) dot.classList.add("done");
    else if (i === currentIdx) dot.classList.add("current");
  });
  // Focus the first input of the visible step.
  setTimeout(() => {
    const el = document.querySelector(`[data-rr-onb-card="${step}"] input, [data-rr-onb-card="${step}"] select`);
    el?.focus();
  }, 60);
}

function _onbBindHandlers() {
  // Autosave on blur for every field within the wizard cards.  Blur
  // (not input) avoids hammering the RPC on every keystroke; the user
  // gets confirmation when they tab away.
  document.querySelectorAll('[data-rr-onb-card] input, [data-rr-onb-card] select').forEach((el) => {
    el.addEventListener("blur", () => _onbAutosave(_onb.current));
    // Also save on change for selects (they don't fire blur reliably
    // on touch devices).
    if (el.tagName === "SELECT") el.addEventListener("change", () => _onbAutosave(_onb.current));
  });

  // Step submit (Continue button).
  document.getElementById("rr-onb-form-company")?.addEventListener("submit", (e) => {
    e.preventDefault();
    _onbSubmitStep("company", "contact");
  });
  document.getElementById("rr-onb-form-contact")?.addEventListener("submit", (e) => {
    e.preventDefault();
    _onbSubmitStep("contact", "billing");
  });
  document.getElementById("rr-onb-form-billing")?.addEventListener("submit", (e) => {
    e.preventDefault();
    _onbActivate();
  });

  // Back buttons.
  document.querySelectorAll("[data-rr-onb-back]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-rr-onb-back");
      _onbGoToStep(target);
    });
  });

  // Save & sign out · autosave the current step then sign out.
  document.getElementById("rr-onb-signout")?.addEventListener("click", async () => {
    await _onbAutosave(_onb.current);
    try { await sb.auth.signOut(); } catch {}
    location.replace("./login.html?msg=onboarding_paused");
  });

  // Card-number formatter (placeholder UX): collapse to last 4 stored.
  const cardNum = document.getElementById("rr-onb-card-number");
  if (cardNum) {
    cardNum.addEventListener("input", () => {
      // Strip non-digits, group every 4 chars for readability.
      const digits = cardNum.value.replace(/\D/g, "").slice(0, 19);
      cardNum.value = digits.replace(/(.{4})/g, "$1 ").trim();
    });
  }
}

function _onbCollectStepPayload(step) {
  if (step === "company") {
    return {
      name:             _onbVal("rr-onb-name"),
      dba:              _onbVal("rr-onb-dba"),
      business_address: _onbVal("rr-onb-business-address"),
      business_phone:   _onbVal("rr-onb-business-phone"),
      support_email:    _onbVal("rr-onb-support-email"),
      timezone:         _onbVal("rr-onb-timezone"),
    };
  }
  if (step === "contact") {
    return {
      owner_name:              _onbVal("rr-onb-owner-name"),
      owner_phone:             _onbVal("rr-onb-owner-phone"),
      emergency_contact_name:  _onbVal("rr-onb-emerg-name"),
      emergency_contact_phone: _onbVal("rr-onb-emerg-phone"),
    };
  }
  if (step === "billing") {
    const card = (_onbVal("rr-onb-card-number") || "").replace(/\D/g, "");
    return {
      cardholder:    _onbVal("rr-onb-cardholder"),
      card_last4:    card.length >= 4 ? card.slice(-4) : null,
      billing_email: _onbVal("rr-onb-billing-email"),
    };
  }
  return {};
}
function _onbVal(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  const v = (el.value || "").trim();
  return v || null;
}

function _onbSetSaving(step, isSaving) {
  const el = document.querySelector(`[data-rr-onb-card="${step}"] .rr-onb-save-status`);
  if (!el) return;
  el.dataset.rrSaving = isSaving ? "1" : "0";
  el.textContent = isSaving ? "Saving…" : "Saved";
}

function _onbError(step, message) {
  const el = document.getElementById(`rr-onb-error-${step}`);
  if (!el) return;
  if (!message) { el.hidden = true; el.textContent = ""; return; }
  el.textContent = message;
  el.hidden = false;
}

async function _onbAutosave(step) {
  if (!step) return;
  const payload = _onbCollectStepPayload(step);
  _onbSetSaving(step, true);
  const { error } = await sb.rpc("onboarding_save_step", {
    p_step: step,
    p_payload: payload,
  });
  if (error) {
    if (_isAuthError(error)) _forceRelogin("session_expired");
    console.error("onboarding_save_step failed:", error);
    _onbSetSaving(step, false);
    _onbError(step, `Couldn't save: ${error.message}`);
    return;
  }
  _onbSetSaving(step, false);
  _onbError(step, null);
}

async function _onbSubmitStep(step, nextStep) {
  // Light client-side validation so the user gets the same friendly
  // wording the rest of the dashboard uses.
  if (step === "company") {
    if (!_onbVal("rr-onb-name"))                     return _onbError(step, "DSP name is required.");
    if (!_onbVal("rr-onb-business-address"))         return _onbError(step, "Business address is required.");
    const supEmail = _onbVal("rr-onb-support-email");
    if (supEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supEmail)) {
      return _onbError(step, "Support email looks invalid.");
    }
  } else if (step === "contact") {
    if (!_onbVal("rr-onb-owner-name"))               return _onbError(step, "Owner full name is required.");
    if (!_onbVal("rr-onb-owner-phone"))              return _onbError(step, "Preferred contact number is required.");
  }

  await _onbAutosave(step);
  _onbGoToStep(nextStep);
}

async function _onbActivate() {
  const submit = document.getElementById("rr-onb-activate");
  const lbl    = submit?.querySelector("[data-rr-onb-activate-label]");
  if (submit) submit.disabled = true;
  if (lbl)    lbl.textContent = "Activating…";

  const billingPayload = _onbCollectStepPayload("billing");
  const billingEmail = billingPayload.billing_email;
  if (billingEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billingEmail)) {
    if (submit) submit.disabled = false;
    if (lbl)    lbl.textContent = "Activate workspace";
    return _onbError("billing", "Billing email looks invalid.");
  }

  const { error } = await sb.rpc("onboarding_complete", { p_payload: billingPayload });
  if (error) {
    if (_isAuthError(error)) _forceRelogin("session_expired");
    if (submit) submit.disabled = false;
    if (lbl)    lbl.textContent = "Activate workspace";
    return _onbError("billing", `Activation failed: ${error.message}`);
  }

  // Show the success state briefly, then reload the dashboard so the
  // boot logic can re-evaluate window.RR.dsp.status (now 'active')
  // and render the regular operator UX.
  ["company","contact","billing"].forEach((s) => {
    const c = document.querySelector(`[data-rr-onb-card="${s}"]`); if (c) c.style.display = "none";
  });
  const success = document.getElementById("rr-onb-success");
  if (success) success.style.display = "";
  setTimeout(() => { location.replace("./index.html?welcome=1"); }, 1400);
}

// ── Add-DSP modal · open / submit ──────────────────────────────────────────
function _openAdminAddDspModal() {
  const form = document.getElementById("rr-admin-add-dsp-form");
  if (form) form.reset();
  const err = document.getElementById("rr-admin-add-dsp-error");
  if (err) { err.hidden = true; err.textContent = ""; err.classList.remove("rr-admin-add-dsp-error--ok"); }
  if (typeof window.openModal === "function") window.openModal("modal-admin-add-dsp");
  setTimeout(() => document.getElementById("rr-add-dsp-name")?.focus(), 60);
}

function _adminAddDspError(message, kind) {
  const el = document.getElementById("rr-admin-add-dsp-error");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("rr-admin-add-dsp-error--ok", kind === "ok");
  el.hidden = false;
}

// ── Invite User modal ──────────────────────────────────────────────────────
// Calls the invite-team-member edge function with `target_dsp_id` so a
// platform admin can drop a new staff member into ANY DSP at any role
// (the function's own gate enforces that target_dsp_id is honored only
// for platform_admin callers; tenant owners stay scoped to their DSP).
//
// Why an edge function instead of an RPC: sending the magic-link
// invite requires `auth.admin.inviteUserByEmail`, which only works
// with the service-role key — we cannot ship that to the browser.
// The RPC layer can't bridge it either; auth.admin is intentionally
// not exposed via PostgREST.

function _openAdminInviteUser() {
  const form = document.getElementById("rr-admin-invite-form");
  if (form) form.reset();
  const err = document.getElementById("rr-admin-invite-error");
  if (err) { err.hidden = true; err.textContent = ""; err.classList.remove("rr-admin-add-dsp-error--ok"); }

  // Populate the target DSP dropdown from the in-memory list.  If
  // the admin clicked Invite-User before ever opening the table,
  // _admin.dsps may be empty; fetch lazily then continue.
  const select = document.getElementById("rr-invite-target-dsp");
  const fillOptions = (dsps) => {
    if (!select) return;
    const sorted = (dsps || []).slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    select.innerHTML = `<option value="">Select a DSP…</option>` + sorted.map((d) =>
      `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}${d.short_code ? ` · ${escapeHtml(d.short_code)}` : ""}</option>`
    ).join("");
  };
  if (_admin.loaded && _admin.dsps.length) {
    fillOptions(_admin.dsps);
  } else {
    fillOptions([]);
    // Kick off a load and refresh the dropdown when it lands.
    _loadPlatformAdminDsps().then(() => fillOptions(_admin.dsps));
  }

  if (typeof window.openModal === "function") window.openModal("modal-admin-invite-user");
  setTimeout(() => document.getElementById("rr-invite-target-dsp")?.focus(), 60);
}

function _adminInviteError(message) {
  const el = document.getElementById("rr-admin-invite-error");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("rr-admin-add-dsp-error--ok");
  el.hidden = false;
}

async function _submitAdminInviteUser(e) {
  e.preventDefault();
  const form    = e.currentTarget;
  const submit  = document.getElementById("rr-admin-invite-submit");
  const lbl     = submit?.querySelector("[data-rr-invite-label]");
  const errEl   = document.getElementById("rr-admin-invite-error");
  if (errEl) errEl.hidden = true;

  const get = (n) => (form.elements.namedItem(n)?.value || "").trim();
  const target_dsp_id = get("target_dsp_id");
  const email         = get("email").toLowerCase();
  const full_name     = get("full_name");
  const role          = get("role") || "dispatcher";

  if (!target_dsp_id)                                       return _adminInviteError("Pick a target DSP.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))            return _adminInviteError("Enter a valid email.");
  if (!["dispatcher", "ops", "owner", "platform_admin"].includes(role)) {
    return _adminInviteError("Pick a valid role.");
  }

  if (submit) submit.disabled = true;
  if (lbl)    lbl.textContent = "Sending…";

  // sb.functions.invoke automatically forwards the user's JWT in the
  // Authorization header, which is what the edge function uses to
  // resolve the caller's app_users row + role.
  const { data, error } = await sb.functions.invoke("invite-team-member", {
    body: { email, full_name, role, target_dsp_id },
  });

  if (submit) submit.disabled = false;
  if (lbl)    lbl.textContent = "Send invite";

  if (error) {
    if (_isAuthError(error)) _forceRelogin("session_expired");
    // The edge function returns body.error on validation failure;
    // sb.functions.invoke surfaces that in error.context.
    let raw = error.message || "";
    try {
      const ctxBody = await error.context?.json?.();
      if (ctxBody?.error) raw = ctxBody.error;
    } catch { /* fall through with raw */ }
    let friendly = raw;
    if (/already_on_team/.test(raw))            friendly = "That email is already on this DSP's team.";
    else if (/already_in_other_dsp/.test(raw))  friendly = "That email is already attached to another workspace.  Move them out first, then retry.";
    else if (/target_dsp_id_required/.test(raw))friendly = "Pick a target DSP.";
    else if (/target_dsp_not_found/.test(raw))  friendly = "That DSP doesn't exist anymore.";
    else if (/cross_dsp_invite_forbidden/.test(raw)) friendly = "You can only invite into your own DSP.";
    else if (/insufficient_role/.test(raw))     friendly = "You don't have permission to invite users.";
    else if (/inactive_caller/.test(raw))       friendly = "Your account is inactive.  Contact an admin.";
    else if (/invalid_email/.test(raw))         friendly = "Email looks invalid.";
    else if (/invalid_role/.test(raw))          friendly = "That role isn't allowed.";
    else if (/invite_failed/.test(raw))         friendly = raw.replace(/^invite_failed:\s*/, "Invite failed: ");
    return _adminInviteError(friendly);
  }

  // Success copy depends on whether the edge function sent a fresh
  // invite or re-issued a magic link to a returning user.
  const kind = data?.kind || "invited";
  const msg = kind === "resent_magic_link"
    ? `${email} already had an account; sent a fresh sign-in link.`
    : `Invite sent to ${email}.`;
  if (typeof toast === "function") toast(msg, "ok");
  if (typeof window.closeModal === "function") window.closeModal("modal-admin-invite-user");

  // Refresh the table — if the invitee already had an auth account,
  // the upsert path inside the edge function may have placed them
  // in the target DSP's app_users immediately.
  await Promise.all([_loadPlatformAdminStats(), _loadPlatformAdminDsps()]);
}

// ── DSP detail / edit modal ────────────────────────────────────────────────
// Single modal for both "View details" and "Edit account" row actions.
// Reads from the in-memory _admin.dsps list (already populated by
// admin_list_dsps), then writes via direct UPDATE on the dsps table —
// the dsps_admin_all RLS policy from migration 0124 authorizes the
// update.  Status / suspend / reactivate stay in the row-actions
// menu so destructive flows are clearly separate from this surface.

function _openAdminEditDspModal(dspId) {
  const dsp = _admin.dsps.find((d) => d.id === dspId);
  if (!dsp) {
    if (typeof toast === "function") toast("Couldn't find that DSP — try refreshing.", "warn");
    return;
  }

  const get = (id) => document.getElementById(id);

  if (get("rr-edit-dsp-title")) get("rr-edit-dsp-title").textContent = `Edit · ${dsp.name || "DSP"}`;
  if (get("rr-edit-dsp-sub"))   get("rr-edit-dsp-sub").textContent   = dsp.short_code || "—";

  // Read-only meta strip · created date / status pill / driver count.
  const meta = get("rr-edit-dsp-meta");
  if (meta) {
    const created = dsp.created_at ? new Date(dsp.created_at).toLocaleDateString() : "—";
    const statusClass =
      dsp.status === "active"    ? "status-pill-success" :
      dsp.status === "pending"   ? "status-pill-pending" :
      dsp.status === "suspended" ? "status-pill-danger"  : "status-pill-neutral";
    const statusLabel =
      dsp.status === "active"    ? "Active" :
      dsp.status === "pending"   ? "Pending" :
      dsp.status === "suspended" ? "Suspended" : (dsp.status || "—");
    meta.innerHTML = `
      <div class="rr-edit-dsp-meta__cell">
        <span class="rr-edit-dsp-meta__label">Created</span>
        <span class="rr-edit-dsp-meta__value">${escapeHtml(created)}</span>
      </div>
      <div class="rr-edit-dsp-meta__cell">
        <span class="rr-edit-dsp-meta__label">Status</span>
        <span class="rr-edit-dsp-meta__value"><span class="status-pill ${statusClass}">${escapeHtml(statusLabel)}</span></span>
      </div>
      <div class="rr-edit-dsp-meta__cell">
        <span class="rr-edit-dsp-meta__label">Drivers</span>
        <span class="rr-edit-dsp-meta__value">${dsp.driver_count ?? 0}</span>
      </div>`;
  }

  // Prefill form fields.
  if (get("rr-edit-dsp-id"))         get("rr-edit-dsp-id").value         = dsp.id;
  if (get("rr-edit-dsp-name"))       get("rr-edit-dsp-name").value       = dsp.name        || "";
  if (get("rr-edit-dsp-short-code")) get("rr-edit-dsp-short-code").value = dsp.short_code  || "";
  if (get("rr-edit-dsp-phone"))      get("rr-edit-dsp-phone").value      = dsp.phone       || "";
  if (get("rr-edit-dsp-address"))    get("rr-edit-dsp-address").value    = dsp.address     || "";
  if (get("rr-edit-dsp-plan"))       get("rr-edit-dsp-plan").value       = dsp.subscription_plan || "starter";
  if (get("rr-edit-dsp-notes"))      get("rr-edit-dsp-notes").value      = dsp.notes       || "";

  const errEl = get("rr-admin-edit-dsp-error");
  if (errEl) { errEl.hidden = true; errEl.textContent = ""; errEl.classList.remove("rr-admin-add-dsp-error--ok"); }

  if (typeof window.openModal === "function") window.openModal("modal-admin-edit-dsp");
  setTimeout(() => get("rr-edit-dsp-name")?.focus(), 60);
}

function _adminEditDspError(message) {
  const el = document.getElementById("rr-admin-edit-dsp-error");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("rr-admin-add-dsp-error--ok");
  el.hidden = false;
}

async function _submitAdminEditDsp(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const submit = document.getElementById("rr-admin-edit-dsp-submit");
  const lbl    = submit?.querySelector("[data-rr-edit-dsp-label]");
  const errEl  = document.getElementById("rr-admin-edit-dsp-error");
  if (errEl) errEl.hidden = true;

  const dspId = document.getElementById("rr-edit-dsp-id")?.value;
  if (!dspId) return _adminEditDspError("Lost track of which DSP to update — close and reopen.");

  const get = (n) => (form.elements.namedItem(n)?.value || "").trim();
  const name              = get("name");
  const phone             = get("phone");
  const address           = get("address");
  const subscription_plan = get("subscription_plan") || "starter";
  const notes             = get("notes");

  if (name.length < 2) return _adminEditDspError("DSP company name is required.");
  if (!["starter", "growth", "enterprise"].includes(subscription_plan)) {
    return _adminEditDspError("Pick a subscription plan.");
  }

  if (submit) submit.disabled = true;
  if (lbl)    lbl.textContent = "Saving…";

  // Direct UPDATE — gated by the dsps_admin_all RLS policy from
  // migration 0124.  A non-platform-admin caller would get 0 rows
  // affected (silent no-op), which is fine because non-admins can't
  // see the modal in the first place.
  const { error } = await sb.from("dsps")
    .update({
      name,
      phone:             phone   || null,
      address:           address || null,
      subscription_plan,
      notes:             notes   || null,
    })
    .eq("id", dspId);

  if (submit) submit.disabled = false;
  if (lbl)    lbl.textContent = "Save changes";

  if (error) {
    if (_isAuthError(error)) _forceRelogin("session_expired");
    return _adminEditDspError(error.message || "Couldn't save the changes.");
  }

  if (typeof toast === "function") toast(`${name} updated.`, "ok");
  if (typeof window.closeModal === "function") window.closeModal("modal-admin-edit-dsp");
  await _loadPlatformAdminDsps();
}

// Edit-DSP form submit is wired by _bindAdminPageHandlers above
// (single bind point so we don't double-fire on submit).  Removed
// the original DOMContentLoaded wrapper that silently never ran due
// to live.js's top-level await — same root cause as the Add-DSP +
// Invite-user buttons looking dead.

// ── Manage-Users slide-over ────────────────────────────────────────────────
// Right-side drawer that lists every app_users row attached to a DSP
// and lets a platform admin change their role / active flag.  Backed
// by admin_dsp_detail() (read) + admin_set_user_permissions() (write).
//
// Re-renders the entire user list after each successful write so the
// UI never drifts from the DB state — easier to reason about than
// patching individual rows in place.

let _adminUsersCurrentDspId = null;

function _openAdminManageUsers(dspId) {
  _adminUsersCurrentDspId = dspId;
  const drawer  = document.getElementById("rr-admin-users-drawer");
  const backdrop = document.getElementById("rr-admin-users-backdrop");
  const titleEl = document.getElementById("rr-admin-users-title");
  const subEl   = document.getElementById("rr-admin-users-sub");
  const bodyEl  = document.getElementById("rr-admin-users-body");
  if (!drawer || !backdrop || !bodyEl) return;

  const dsp = _admin.dsps.find((d) => d.id === dspId);
  if (titleEl) titleEl.textContent = `Manage users · ${dsp?.name || "DSP"}`;
  if (subEl)   subEl.textContent   = dsp?.short_code
    ? `${dsp.short_code} · ${dsp?.driver_count ?? 0} driver${dsp?.driver_count === 1 ? "" : "s"}`
    : "—";

  // Skeleton rows while admin_dsp_detail is in flight.
  bodyEl.innerHTML = `
    <div class="rr-admin-users-skel" aria-hidden="true">
      <div></div><div></div><div></div>
    </div>`;

  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  backdrop.classList.add("open");

  _loadAdminManageUsers(dspId);
}

function _closeAdminManageUsers() {
  const drawer   = document.getElementById("rr-admin-users-drawer");
  const backdrop = document.getElementById("rr-admin-users-backdrop");
  if (drawer)   { drawer.classList.remove("open"); drawer.setAttribute("aria-hidden", "true"); }
  if (backdrop) backdrop.classList.remove("open");
  _adminUsersCurrentDspId = null;
}

async function _loadAdminManageUsers(dspId) {
  const bodyEl = document.getElementById("rr-admin-users-body");
  if (!bodyEl) return;

  const { data, error } = await sb.rpc("admin_dsp_detail", { p_dsp_id: dspId });
  if (error) {
    if (_isAuthError(error)) _forceRelogin("session_expired");
    bodyEl.innerHTML = `<div class="rr-admin-users-empty" style="color:var(--red);border-color:var(--red-soft)">Couldn't load users: ${escapeHtml(error.message)}</div>`;
    return;
  }
  const users = (data && data.users) || [];

  if (users.length === 0) {
    bodyEl.innerHTML = `<div class="rr-admin-users-empty">No users in this DSP yet.</div>`;
    return;
  }

  // Group: active first (sorted by role rank desc, then name), then
  // inactive at the bottom so the admin can see everyone in one
  // glance without losing the "who's currently in the DSP" signal.
  const ROLE_RANK = { platform_admin: 4, owner: 3, ops: 2, dispatcher: 1, driver: 0 };
  const sortByRoleThenName = (a, b) => {
    const r = (ROLE_RANK[b.role] ?? -1) - (ROLE_RANK[a.role] ?? -1);
    return r !== 0 ? r : (a.full_name || a.email || "").localeCompare(b.full_name || b.email || "");
  };
  const active   = users.filter((u) => u.active).sort(sortByRoleThenName);
  const inactive = users.filter((u) => !u.active).sort(sortByRoleThenName);

  let html = "";
  if (active.length) {
    html += `<div class="rr-admin-users-section-head">Active · ${active.length}</div>`;
    html += `<div class="rr-admin-users-list">${active.map(_renderAdminUserRow).join("")}</div>`;
  }
  if (inactive.length) {
    html += `<div class="rr-admin-users-section-head">Inactive · ${inactive.length}</div>`;
    html += `<div class="rr-admin-users-list">${inactive.map(_renderAdminUserRow).join("")}</div>`;
  }
  bodyEl.innerHTML = html;
}

function _renderAdminUserRow(u) {
  const initials = (u.full_name || u.email || "?")
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => (w[0] || "").toUpperCase()).join("") || "?";
  const roleOptions = [
    ["driver",         "Driver"],
    ["dispatcher",     "Dispatcher"],
    ["ops",            "Ops"],
    ["owner",          "Owner"],
    ["platform_admin", "Platform admin"],
  ].map(([v, label]) => `<option value="${v}"${v === u.role ? " selected" : ""}>${label}</option>`).join("");
  return `
    <div class="rr-admin-user-row" data-rr-admin-user-id="${escapeHtml(u.id)}" data-rr-inactive="${u.active ? "0" : "1"}">
      <div class="rr-admin-user-row__avatar">${escapeHtml(initials)}</div>
      <div style="min-width:0">
        <div class="rr-admin-user-row__name">${escapeHtml(u.full_name || "—")}</div>
        <div class="rr-admin-user-row__email">${escapeHtml(u.email || "—")}</div>
      </div>
      <div class="rr-admin-user-row__actions">
        <select class="rr-admin-user-row__role" data-rr-admin-user-role="${escapeHtml(u.id)}" data-rr-role="${escapeHtml(u.role)}" aria-label="Role">
          ${roleOptions}
        </select>
        <label class="rr-admin-toggle" title="${u.active ? "Active" : "Inactive"}">
          <input type="checkbox" data-rr-admin-user-active="${escapeHtml(u.id)}" ${u.active ? "checked" : ""} aria-label="Active" />
          <span class="rr-admin-toggle__slider"></span>
        </label>
      </div>
    </div>`;
}

// Bind role-change + active-toggle handlers via delegation so they
// survive every re-render of the user list.
(function bindAdminManageUsersHandlers() {
  document.addEventListener("change", async (e) => {
    const t = e.target;
    if (!t) return;

    // Role change.
    const roleId = t.getAttribute && t.getAttribute("data-rr-admin-user-role");
    if (roleId) {
      const newRole = t.value;
      t.disabled = true;
      const { error } = await sb.rpc("admin_set_user_permissions", {
        p_user_id: roleId,
        p_role:    newRole,
        p_allowed_pages: null,
        p_active:        null,
      });
      t.disabled = false;
      if (error) {
        if (_isAuthError(error)) _forceRelogin("session_expired");
        toast(`Role change failed: ${error.message}`, "warn");
        return;
      }
      toast(`Role updated.`, "ok");
      // Re-load both the panel (to reflect grouping/sort changes) and
      // the table (in case role flipped someone in/out of the owner
      // column).
      if (_adminUsersCurrentDspId) await _loadAdminManageUsers(_adminUsersCurrentDspId);
      await _loadPlatformAdminDsps();
      return;
    }

    // Active toggle.
    const activeId = t.getAttribute && t.getAttribute("data-rr-admin-user-active");
    if (activeId) {
      const newActive = !!t.checked;
      t.disabled = true;
      const { error } = await sb.rpc("admin_set_user_permissions", {
        p_user_id: activeId,
        p_role:           null,
        p_allowed_pages:  null,
        p_active:         newActive,
      });
      t.disabled = false;
      if (error) {
        if (_isAuthError(error)) _forceRelogin("session_expired");
        // Roll the toggle back on failure so the UI doesn't lie.
        t.checked = !newActive;
        toast(`Couldn't update: ${error.message}`, "warn");
        return;
      }
      toast(newActive ? "User reactivated." : "User deactivated.", "ok");
      if (_adminUsersCurrentDspId) await _loadAdminManageUsers(_adminUsersCurrentDspId);
      return;
    }
  });

  // Close the slide-over via backdrop / X button / Escape.
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-rr-admin-users-close]")) _closeAdminManageUsers();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const drawer = document.getElementById("rr-admin-users-drawer");
      if (drawer && drawer.classList.contains("open")) _closeAdminManageUsers();
    }
  });
})();

async function _submitAdminAddDsp(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const submit = document.getElementById("rr-admin-add-dsp-submit");
  const lbl = submit?.querySelector("[data-rr-add-dsp-label]");
  const errEl = document.getElementById("rr-admin-add-dsp-error");
  if (errEl) errEl.hidden = true;

  // Collect + trim form values.  short_code is no longer collected
  // from the form — the server (admin_create_dsp / dsp_unique_short_
  // code) generates a unique workspace identifier from the name so
  // the operator never has to think about collisions.
  const get = (n) => (form.elements.namedItem(n)?.value || "").trim();
  const name        = get("name");
  const owner_email = get("owner_email").toLowerCase();
  const owner_name  = get("owner_name");
  const phone       = get("phone");
  const address     = get("address");
  const subscription_plan = get("subscription_plan") || "starter";
  const notes       = get("notes");

  // Client-side validation matches the migration's CHECK constraints
  // and the email-format expectation. Surfaces friendly inline errors
  // before we burn an RPC round-trip on a known-bad payload.
  if (name.length < 2)                               return _adminAddDspError("DSP company name is required.");
  if (owner_name.length < 2)                         return _adminAddDspError("Owner name is required.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner_email)) return _adminAddDspError("Owner email looks invalid.");
  if (!["starter", "growth", "enterprise"].includes(subscription_plan)) {
    return _adminAddDspError("Pick a subscription plan.");
  }

  // Lock the form while the RPC runs so a double-click can't
  // accidentally provision two DSPs with the same intent.
  if (submit) submit.disabled = true;
  if (lbl)    lbl.textContent = "Creating…";

  const { data, error } = await sb.rpc("admin_create_dsp", {
    p_name:               name,
    p_owner_email:        owner_email,
    p_owner_name:         owner_name,
    p_phone:              phone || null,
    p_address:            address || null,
    p_subscription_plan:  subscription_plan,
    p_notes:              notes || null,
  });

  if (submit) submit.disabled = false;
  if (lbl)    lbl.textContent = "Create account";

  if (error) {
    if (_isAuthError(error)) _forceRelogin("session_expired");
    // Friendlier wording for the predictable failure modes.  The
    // server now auto-generates a unique short_code, so a UNIQUE
    // collision would only come from a duplicate name + race; treat
    // it as a generic conflict.
    let msg = error.message || "Couldn't create the DSP.";
    if (/duplicate key|unique/i.test(msg))      msg = `That DSP already exists.`;
    else if (/forbidden/i.test(msg))            msg = "You don't have admin access. Sign in as the platform admin.";
    return _adminAddDspError(msg);
  }

  // The RPC returns the new DSP's id; without it we can't fire the
  // owner invite.  This SHOULD never happen given the RPC's contract,
  // but guard against a NULL return rather than crashing the next call.
  const newDspId = data;
  if (!newDspId) {
    if (typeof toast === "function") toast(`${name} created, but couldn't read its id back. Invite the owner manually from "Invite user".`, "warn");
    if (typeof window.closeModal === "function") window.closeModal("modal-admin-add-dsp");
    await Promise.all([_loadPlatformAdminStats(), _loadPlatformAdminDsps()]);
    return;
  }

  // Fire the owner invite via the same edge function the standalone
  // Invite-user modal uses.  We treat invite failure as non-fatal —
  // the DSP is created and the platform admin can re-invite from
  // the row actions menu / Invite-user modal.  Surface it clearly so
  // the operator knows to follow up.
  if (lbl) lbl.textContent = "Sending invite…";
  const { data: invData, error: invError } = await sb.functions.invoke("invite-team-member", {
    body: {
      email:         owner_email,
      full_name:     owner_name,
      role:          "owner",
      target_dsp_id: newDspId,
    },
  });

  if (typeof window.closeModal === "function") window.closeModal("modal-admin-add-dsp");
  await Promise.all([_loadPlatformAdminStats(), _loadPlatformAdminDsps()]);

  if (invError) {
    let raw = invError.message || "";
    try {
      const ctxBody = await invError.context?.json?.();
      if (ctxBody?.error) raw = ctxBody.error;
    } catch { /* fall through */ }
    if (typeof toast === "function") {
      toast(`${name} created — but the owner invite failed (${raw}). Use "Invite user" to resend.`, "warn", 9000);
    }
    return;
  }

  // Edge function distinguishes a fresh invite from a re-issued
  // magic link (returning user).  Both are success paths from the
  // operator's perspective, but the wording matters.
  const kind = invData?.kind || "invited";
  const successMsg = kind === "resent_magic_link"
    ? `${name} created. ${owner_email} already had an account — sent a fresh sign-in link.`
    : `${name} created. Invite sent to ${owner_email}.`;
  if (typeof toast === "function") toast(successMsg, "ok", 6000);
}


// ─── Bulk-import drivers · CSV paste flow ─────────────────────────────────
// UI lives at #modal-bulk-drivers (Drivers view → "Bulk import" button).
// Parses pasted CSV, shows a live preview, then calls the
// bulk_create_drivers RPC (migration 0130) which validates server-side
// and returns per-row results.
//
// CSV parser is hand-rolled (RFC-4180-ish) so we don't pull in a
// dependency for ~30 lines of logic.  Handles quoted fields with
// embedded commas + escaped quotes.

function _bulkDriversParseCsv(text) {
  // Split into rows respecting quoted newlines.  Tab-separated paste
  // (from Google Sheets / Excel) also works — we treat \t and , as
  // delimiters interchangeably.
  const rows = [];
  let cur = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === "," || ch === "\t") { cur.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { cur.push(field); rows.push(cur); cur = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  if (field !== "" || cur.length) { cur.push(field); rows.push(cur); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ""));
}

function _bulkDriversNormalize(rows) {
  // Detect header row.  Match any of: first_name, firstname, first
  // name, fname; same families for last, phone, email.  Letters
  // case-insensitive.
  const headerKey = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");
  const looksLikeHeader = (r) =>
    r.some((c) => /^(first|last|phone|email)/i.test(c)) ||
    r.some((c) => ["firstname","lastname","phonenumber","emailaddress"].includes(headerKey(c)));

  let headers = ["first_name", "last_name", "phone", "email"];
  let dataRows = rows;
  if (rows.length && looksLikeHeader(rows[0])) {
    headers = rows[0].map((c) => {
      const k = headerKey(c);
      if (k.startsWith("first") || k === "fname")  return "first_name";
      if (k.startsWith("last")  || k === "lname" || k === "surname") return "last_name";
      if (k.startsWith("phone") || k === "tel" || k === "mobile" || k === "cell") return "phone";
      if (k.startsWith("email") || k === "mail")   return "email";
      return c.toLowerCase();
    });
    dataRows = rows.slice(1);
  }
  return dataRows.map((r) => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = r[idx] || ""; });
    return {
      first_name: (obj.first_name || "").trim(),
      last_name:  (obj.last_name  || "").trim(),
      phone:      (obj.phone      || "").trim(),
      email:      (obj.email      || "").trim(),
    };
  });
}

function _bulkDriversValidate(rows) {
  const issues = [];
  rows.forEach((r, idx) => {
    if (!r.first_name) issues.push({ row: idx + 1, msg: "missing first name" });
    if (!r.last_name)  issues.push({ row: idx + 1, msg: "missing last name" });
    if (r.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) {
      issues.push({ row: idx + 1, msg: `invalid email "${r.email}"` });
    }
  });
  return issues;
}

function _renderBulkDriversPreview() {
  const txt = document.getElementById("rr-bulk-drivers-csv")?.value || "";
  const wrap = document.getElementById("rr-bulk-drivers-preview-wrap");
  const body = document.getElementById("rr-bulk-drivers-preview-body");
  const cnt  = document.getElementById("rr-bulk-drivers-preview-count");
  const sufx = document.getElementById("rr-bulk-drivers-preview-s");
  const warn = document.getElementById("rr-bulk-drivers-warnings");
  const sub  = document.getElementById("rr-bulk-drivers-submit");
  const errEl = document.getElementById("rr-bulk-drivers-error");

  if (!txt.trim()) {
    if (wrap) wrap.hidden = true;
    if (sub)  sub.disabled = true;
    if (errEl) errEl.hidden = true;
    return;
  }

  let parsed, normalized, issues;
  try {
    parsed = _bulkDriversParseCsv(txt);
    normalized = _bulkDriversNormalize(parsed);
    issues = _bulkDriversValidate(normalized);
  } catch (e) {
    if (errEl) { errEl.textContent = `Parse error: ${e.message}`; errEl.hidden = false; }
    if (sub)  sub.disabled = true;
    return;
  }

  if (errEl) errEl.hidden = true;
  if (wrap)  wrap.hidden = false;
  if (cnt)   cnt.textContent = normalized.length;
  if (sufx)  sufx.textContent = normalized.length === 1 ? "" : "s";

  // Render preview rows · max 50 to keep DOM light, with a "+N more" line
  if (body) {
    const head = normalized.slice(0, 50);
    body.innerHTML = head.map((r, i) => {
      const rowIssues = issues.filter((x) => x.row === i + 1).map((x) => x.msg).join("; ");
      const dot = rowIssues
        ? `<span title="${escapeHtml(rowIssues)}" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--amber)"></span>`
        : `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--green-bright)"></span>`;
      return `<tr>
        <td>${dot}</td>
        <td>${escapeHtml(r.first_name)}</td>
        <td>${escapeHtml(r.last_name)}</td>
        <td>${escapeHtml(r.phone)}</td>
        <td>${escapeHtml(r.email)}</td>
      </tr>`;
    }).join("") + (normalized.length > 50
      ? `<tr><td colspan="5" style="text-align:center;color:var(--text-subtle);font-style:italic">+ ${normalized.length - 50} more rows (will all be imported)</td></tr>`
      : "");
  }

  if (warn) {
    warn.textContent = issues.length
      ? `${issues.length} row${issues.length === 1 ? " has" : "s have"} issues — hover the amber dot for details.  Bad rows are skipped on import.`
      : "All rows look good.";
  }

  if (sub) sub.disabled = normalized.length === 0;
}

async function _submitBulkDrivers() {
  const txt = document.getElementById("rr-bulk-drivers-csv")?.value || "";
  const sub = document.getElementById("rr-bulk-drivers-submit");
  const lbl = sub?.querySelector("[data-rr-bulk-drivers-label]");
  const errEl = document.getElementById("rr-bulk-drivers-error");
  const resEl = document.getElementById("rr-bulk-drivers-result");
  if (errEl) errEl.hidden = true;
  if (resEl) resEl.hidden = true;

  let normalized;
  try {
    normalized = _bulkDriversNormalize(_bulkDriversParseCsv(txt));
  } catch (e) {
    if (errEl) { errEl.textContent = `Parse error: ${e.message}`; errEl.hidden = false; }
    return;
  }
  if (normalized.length === 0) {
    if (errEl) { errEl.textContent = "No rows to import."; errEl.hidden = false; }
    return;
  }

  if (sub) sub.disabled = true;
  if (lbl) lbl.textContent = `Importing ${normalized.length}…`;

  const { data, error } = await sb.rpc("bulk_create_drivers", { p_rows: normalized });

  if (sub) sub.disabled = false;
  if (lbl) lbl.textContent = "Import";

  if (error) {
    if (_isAuthError(error)) _forceRelogin("session_expired");
    let msg = error.message || "Couldn't import drivers.";
    if (/forbidden/i.test(msg)) msg = "You don't have permission to add drivers (need dispatcher or higher).";
    if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
    return;
  }

  const summary = data || {};
  const inserted = summary.inserted ?? 0;
  const skipped  = summary.skipped  ?? 0;
  const errored  = summary.errored  ?? 0;
  const rows     = Array.isArray(summary.rows) ? summary.rows : [];

  if (resEl) {
    const failedRows = rows.filter((r) => !r.ok);
    resEl.innerHTML = `
      <div style="background:${inserted > 0 ? "var(--green-soft)" : "var(--canvas)"};border:1px solid ${inserted > 0 ? "rgba(5,150,105,.20)" : "var(--border)"};border-radius:var(--r-md);padding:var(--s-3) var(--s-4);font-size:var(--fs-sm);line-height:1.5">
        <div style="font-weight:700;color:${inserted > 0 ? "var(--green-dark)" : "var(--text)"};margin-bottom:6px">Import complete</div>
        <div style="color:var(--text-muted)">
          ✅ ${inserted} created
          ${skipped > 0 ? `· ⏭️ ${skipped} skipped (duplicate email)` : ""}
          ${errored > 0 ? `· ⚠️ ${errored} errored` : ""}
        </div>
        ${failedRows.length > 0 ? `
          <details style="margin-top:8px">
            <summary style="cursor:pointer;font-weight:600;color:var(--text-muted)">Show ${failedRows.length} skipped/errored row${failedRows.length === 1 ? "" : "s"}</summary>
            <ul style="margin:6px 0 0 18px;padding:0;color:var(--text-subtle);font-size:var(--fs-xs)">
              ${failedRows.map((r) => {
                const reason = r.reason === "duplicate_email" ? `already exists: ${r.email}`
                  : r.reason === "missing_name"     ? "missing first or last name"
                  : r.reason === "db_error"         ? `DB error: ${r.detail || ""}`
                  : r.reason || "unknown";
                return `<li>Row ${r.index}: ${escapeHtml(reason)}</li>`;
              }).join("")}
            </ul>
          </details>
        ` : ""}
      </div>`;
    resEl.hidden = false;
  }

  if (typeof toast === "function") {
    toast(`Imported ${inserted} driver${inserted === 1 ? "" : "s"}` + (skipped + errored > 0 ? ` (${skipped + errored} skipped/errored — see modal)` : ""), inserted > 0 ? "ok" : "warn");
  }

  // Refresh the roster to show the new drivers.
  if (typeof loadDriversRoster === "function" && inserted > 0) loadDriversRoster();
}

(function bindBulkDriversHandlers() {
  // Defer to the DOM being parsed.  live.js's top-level await makes
  // DOMContentLoaded unreliable here (same gotcha as the admin handlers),
  // so we do an immediate bind + readyState fallback.
  const bind = () => {
    const ta = document.getElementById("rr-bulk-drivers-csv");
    if (ta) ta.addEventListener("input", _renderBulkDriversPreview);
    const sub = document.getElementById("rr-bulk-drivers-submit");
    if (sub) sub.addEventListener("click", _submitBulkDrivers);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind, { once: true });
  } else {
    bind();
  }
})();

// ─── Drivers roster ────────────────────────────────────────────────────────
//
// Replaces the mockup roster rows with live rows from public.drivers.
// Records are minimal today (name, contact, station, hire_date, status)
// so the columns the mockup defined for Score / Attendance / Coach show
// "—" until a future migration fills them in.

// Driver stage state — what the operator has filtered to.
let _driverStage = "active";
// Roster filter / sort state (set by the toolbar dropdowns).
let _rosterFilters = { station: "", tenure: "", score: "", sort: "score-asc" };
// Cached roster rows so filter/sort changes don't refetch.
let _rosterRows = [];

async function loadDriversRoster() {
  const tbody = document.getElementById("drivers-tbody");
  if (!tbody) return;

  const { data: rows, error } = await sb.from("drivers")
    .select(`id, full_name, first_name, last_name, preferred_name, email, phone, status, hire_date, tier, score, updated_at, metadata,
             background_check_completed_at, drug_test_completed_at,
             training_scheduled_at, training_date,
             station:station_id (code)`)
    .eq("dsp_id", window.RR.dsp.id)
    .order("hire_date", { ascending: false })
    .limit(500);

  _rosterRows = rows ?? [];
  refreshDriverStatRow(_rosterRows);
  _populateRosterStationFilter(_rosterRows);
  renderDriverTable(_rosterRows, error);

  // Page sub-line: live count of active drivers + distinct active stations.
  const sub = document.getElementById("rr-drivers-page-sub");
  if (sub) {
    const all = rows || [];
    const active = all.filter(r => r.status === "active").length;
    const stationCodes = new Set(
      all.filter(r => r.status === "active" && r.station?.code).map(r => r.station.code)
    );
    const stationN = stationCodes.size;
    sub.textContent = `${active} active driver${active === 1 ? "" : "s"}${stationN > 0 ? ` across ${stationN} station${stationN === 1 ? "" : "s"}` : ""}`;
  }
}

function visibleDriversForStage(rows, stage) {
  let out;
  switch (stage) {
    case "onboarding": out = rows.filter(r => r.status === "onboarding"); break;
    case "active":     out = rows.filter(r => r.status === "active"); break;
    case "atrisk":     out = rows.filter(r => r.status === "active" && (r.score ?? 999) < 70); break;
    case "onleave":    out = rows.filter(r => r.status === "leave"); break;
    case "inactive":   out = rows.filter(r => ["inactive","terminated"].includes(r.status)); break;
    default:           out = rows;
  }
  return _applyRosterFiltersAndSort(out);
}

function _applyRosterFiltersAndSort(rows) {
  const f = _rosterFilters;
  let out = rows;
  if (f.station) out = out.filter(r => (r.station?.code || "") === f.station);
  if (f.tenure) {
    const today = Date.now();
    out = out.filter(r => {
      if (!r.hire_date) return false;
      const days = Math.floor((today - new Date(r.hire_date).getTime()) / 86400000);
      switch (f.tenure) {
        case "0-30":   return days >= 0   && days <= 30;
        case "31-90":  return days >= 31  && days <= 90;
        case "91-365": return days >= 91  && days <= 365;
        case "365+":   return days > 365;
        default:       return true;
      }
    });
  }
  if (f.score) {
    out = out.filter(r => {
      const s = r.score;
      switch (f.score) {
        case "0-69":  return s != null && s < 70;
        case "70-84": return s != null && s >= 70 && s < 85;
        case "85+":   return s != null && s >= 85;
        case "none":  return s == null;
        default:      return true;
      }
    });
  }
  const dispName = (r) => (r.preferred_name?.trim() || r.full_name || "").toLowerCase();
  switch (f.sort) {
    case "score-asc":   out = [...out].sort((a, b) => (a.score ?? 999) - (b.score ?? 999)); break;
    case "score-desc":  out = [...out].sort((a, b) => (b.score ?? -1)  - (a.score ?? -1));  break;
    case "name":        out = [...out].sort((a, b) => dispName(a).localeCompare(dispName(b))); break;
    case "tenure-desc": out = [...out].sort((a, b) => new Date(a.hire_date || 0) - new Date(b.hire_date || 0)); break;
    case "tenure-asc":  out = [...out].sort((a, b) => new Date(b.hire_date || 0) - new Date(a.hire_date || 0)); break;
  }
  return out;
}

function _populateRosterStationFilter(rows) {
  const sel = document.getElementById("rr-roster-station");
  if (!sel) return;
  const codes = [...new Set(rows.map(r => r.station?.code).filter(Boolean))].sort();
  const cur = sel.value;
  sel.innerHTML = '<option value="">Station: All</option>'
    + codes.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  if (codes.includes(cur)) sel.value = cur;
}

document.addEventListener("change", (e) => {
  const id = e.target?.id;
  if (id === "rr-roster-station" || id === "rr-roster-tenure"
   || id === "rr-roster-score") {
    _rosterFilters = {
      ..._rosterFilters,
      station: document.getElementById("rr-roster-station")?.value || "",
      tenure:  document.getElementById("rr-roster-tenure")?.value  || "",
      score:   document.getElementById("rr-roster-score")?.value   || "",
    };
    renderDriverTable(_rosterRows, null);
  }
});

// Click a sortable column header → toggle direction (or set to that
// column at its default direction).
document.addEventListener("click", (e) => {
  const th = e.target.closest("[data-rr-roster-sort]");
  if (!th) return;
  const col = th.dataset.rrRosterSort;
  const cur = _rosterFilters.sort;
  let next;
  if (col === "name")        next = "name";
  else if (col === "tenure") next = cur === "tenure-desc" ? "tenure-asc"  : "tenure-desc";
  else if (col === "score")  next = cur === "score-asc"   ? "score-desc"  : "score-asc";
  if (!next) return;
  _rosterFilters = { ..._rosterFilters, sort: next };
  renderDriverTable(_rosterRows, null);
});

function renderDriverTable(rows, error) {
  const tbody = document.getElementById("drivers-tbody");
  const thead = tbody?.parentElement?.querySelector("thead tr");
  if (!tbody || !thead) return;

  // Sort caret helper — shows the active sort direction next to the
  // matching header.
  const f = _rosterFilters;
  const caret = (col) => {
    const map = {
      name:    ["name"],
      tenure:  ["tenure-asc", "tenure-desc"],
      score:   ["score-asc", "score-desc"],
    };
    const ours = map[col] || [];
    if (!ours.includes(f.sort)) return "";
    if (f.sort.endsWith("-asc") || f.sort === "name") return ' <span style="font-size:9px">▲</span>';
    return ' <span style="font-size:9px">▼</span>';
  };

  // Swap headers per stage.  Onboarding still uses the milestone
  // columns; Active drops the Status column (everyone's "Active" in
  // this stage by definition) and turns the sortable columns into
  // clickable headers (data-rr-roster-sort).
  if (_driverStage === "onboarding") {
    thead.innerHTML = `
      <th>Driver</th>
      <th>Days since hire</th>
      <th>Background check</th>
      <th>Drug test</th>
      <th>Training scheduled</th>
      <th>Status</th>
      <th>Training date</th>
      <th></th>`;
  } else {
    const colCount = 7;
    thead.innerHTML = `
      <th data-rr-roster-sort="name"   style="cursor:pointer;user-select:none">Driver${caret("name")}</th>
      <th>Station</th>
      <th data-rr-roster-sort="tenure" style="cursor:pointer;user-select:none">Tenure${caret("tenure")}</th>
      <th data-rr-roster-sort="score"  style="cursor:pointer;user-select:none">Score${caret("score")}</th>
      <th>Attendance · 30d</th>
      <th>Last coached</th>
      <th></th>`;
    thead.dataset.rrColCount = String(colCount);
  }

  const colspan = _driverStage === "onboarding" ? 8 : 7;
  if (error) {
    tbody.innerHTML = `<tr><td colspan="${colspan}" style="padding:24px;text-align:center;color:var(--red);font-size:var(--fs-md)">${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  const visible = visibleDriversForStage(rows, _driverStage);
  if (visible.length === 0) {
    const empty = _driverStage === "onboarding"
      ? "No drivers in onboarding right now."
      : _driverStage === "active"
      ? "No active drivers yet. Hire someone in Interview Day to fill this list."
      : "No drivers in this stage.";
    tbody.innerHTML = `<tr><td colspan="${colspan}" style="padding:48px;text-align:center;color:var(--text-subtle);font-size:var(--fs-md)">${empty}</td></tr>`;
    return;
  }

  const renderer = _driverStage === "onboarding" ? renderOnboardingRow : renderDriverRow;
  tbody.innerHTML = visible.map(renderer).join("");
}

function pillCheck(when) {
  if (when) return `<span class="tag" style="background:var(--green-soft);color:var(--green)">Done · ${new Date(when).toLocaleDateString()}</span>`;
  return `<span class="tag" style="background:var(--canvas);color:var(--text-subtle)">Pending</span>`;
}

function renderOnboardingRow(d) {
  const initials = displayDriverInitials(d);
  const display = displayDriverName(d);
  const tier = d.tier ? `tier-${String(d.tier).toLowerCase()}` : "";
  const contact = d.phone || d.email || "";
  const days = d.hire_date
    ? Math.max(0, Math.floor((Date.now() - new Date(d.hire_date).getTime()) / 86400000))
    : null;
  const daysCell = days != null
    ? `<span style="font-weight:600">${days}</span> <span style="font-size:var(--fs-xs);color:var(--text-subtle)">day${days === 1 ? "" : "s"}</span>`
    : '<span style="color:var(--text-subtle)">—</span>';
  return `
    <tr data-driver-id="${d.id}" data-rr-open-driver>
      <td><div class="cell-driver"><div class="avatar-sm ${tier}">${initials}</div>
        <div><div class="cell-name">${escapeHtml(display)}</div>
        <div class="cell-name-sub">${escapeHtml(contact)}</div></div></div></td>
      <td>${daysCell}</td>
      <td>${pillCheck(d.background_check_completed_at)}</td>
      <td>${pillCheck(d.drug_test_completed_at)}</td>
      <td>${d.training_scheduled_at ? new Date(d.training_scheduled_at).toLocaleString() : '<span style="color:var(--text-subtle)">—</span>'}</td>
      <td>${renderDriverStatusBadge(d.status)}</td>
      <td class="cell-time">${d.training_date ? new Date(d.training_date).toLocaleDateString() : "—"}</td>
      <td></td>
    </tr>`;
}

function renderDriverRow(d) {
  const initials = displayDriverInitials(d);
  const display = displayDriverName(d);
  const tier = d.tier ? `tier-${String(d.tier).toLowerCase()}` : "";
  const tenure = d.hire_date ? tenureLabel(d.hire_date) : "—";
  const station = d.station?.code || "—";
  const contact = d.phone || d.email || "";
  // Status column dropped from the active roster — it'd always read
  // "Active" by definition.  The Active / Onboarding / At risk /
  // Inactive stage tabs above already split that.
  return `
    <tr data-driver-id="${d.id}" data-rr-open-driver>
      <td><div class="cell-driver"><div class="avatar-sm ${tier}">${initials}</div>
        <div><div class="cell-name">${escapeHtml(display)}</div>
        <div class="cell-name-sub">${escapeHtml(contact)}</div></div></div></td>
      <td>${escapeHtml(station)}</td>
      <td>${tenure}</td>
      <td>—</td>
      <td>—</td>
      <td class="cell-time">—</td>
      <td></td>
    </tr>`;
}

// Override the mockup's filterDriversStage so it actually filters the
// roster against live data. Auto-hides at-risk + inactive when empty
// since we don't yet have the data model for at-risk.
const _legacyFilterDrivers = window.filterDriversStage;
window.filterDriversStage = function (btn) {
  if (typeof _legacyFilterDrivers === "function") _legacyFilterDrivers(btn);
  _driverStage = btn.getAttribute("data-stage") || "active";
  loadDriversRoster();
};


// ─── Drivers → Licenses tab ──────────────────────────────────────────────
//
// The mockup's renderRenewalsPanel() (and licResendNow / licMarkRenewed)
// fill the same DOM container we use, with RR_DRIVERS mockup data. They
// fire on page load and on stage filter clicks, flashing fake rows
// before our live loader runs. Stub them all out at boot so only the
// live loader paints the panel.
window.renderRenewalsPanel = function () { /* superseded */ };
window.licResendNow        = function () { /* superseded */ };
window.licMarkRenewed      = function () { /* superseded */ };
window.licApplyAll         = function () { /* superseded */ };

// Wipe the panel body once at boot so any rendering the mockup already
// did before live.js loaded gets cleared before the operator can click.
{
  const body = document.getElementById("lic-renewals-body");
  if (body) body.innerHTML = `<div class="rr-loading">Loading</div>`;
}

// ─── Drivers · Attendance (live) ───────────────────────────────────────────
// The attendance report now renders against the policy decay window —
// it's the operator's "standing attendance" view, not a what-happened-
// in-the-last-N-days slice.  Window selector dropped per direction.
let _attReportSort = { col: "points", dir: "desc" };
let _attReportRows = [];
let _attDecisionNotesByShift = new Map();   // shift_id → notes (for row drilldown)

// Click a sortable column header → toggle direction (or switch column).
document.addEventListener("click", (e) => {
  const th = e.target.closest("[data-rr-att-sort]");
  if (!th) return;
  const col = th.dataset.rrAttSort;
  if (_attReportSort.col === col) {
    _attReportSort.dir = _attReportSort.dir === "desc" ? "asc" : "desc";
  } else {
    _attReportSort = { col, dir: ["driver", "station", "status"].includes(col) ? "asc" : "desc" };
  }
  _renderAttReportTbody();
});


async function loadAttendanceLive() {
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;

  // Window = the policy decay window.  This is the "standing
  // attendance" view, so it always reflects what's currently scoring
  // toward each driver's running total.  EVAL is the normalized form
  // of the operator-built block policy; POLICY is kept for legacy
  // callers (Today's Plan still reads master toggles from it).
  const POLICY = _getAttPolicy();
  const EVAL   = _evalPolicy();
  const decay  = Number(EVAL.decay_days) || 90;
  const sinceDate = new Date(); sinceDate.setDate(sinceDate.getDate() - decay);
  const sinceIso  = fmtIsoDate(sinceDate);
  const todayIso  = fmtIsoDate(new Date());

  const [driversRes, shiftsRes, coachingsRes, decisionsRes] = await Promise.all([
    sb.from("drivers")
      .select("id, full_name, first_name, last_name, preferred_name, status, hire_date, station:station_id (code)")
      .eq("dsp_id", dspId)
      .order("full_name"),
    sb.from("shifts")
      .select("id, driver_id, status, date")
      .eq("dsp_id", dspId)
      .gte("date", sinceIso)
      .lte("date", todayIso),
    sb.from("coachings")
      .select("id, driver_id, severity, occurred_at, acknowledged_at, signed_at, delivery_required")
      .eq("dsp_id", dspId)
      .eq("topic", "attendance")
      .eq("driver_visible", true)
      .gte("occurred_at", sinceDate.toISOString())
      .is("archived_at", null)
      .order("occurred_at", { ascending: false }),
    // Operator-excused decisions in the same window. Counted as
    // "Excused" on the report (separate KPI from VTO). Each shift
    // has at most one decision, so this also doubles as the per-row
    // notes lookup.
    sb.from("attendance_decisions")
      .select("shift_id, driver_id, outcome, decision, notes, created_at")
      .eq("dsp_id", dspId)
      .eq("decision", "deny")
      .gte("created_at", sinceDate.toISOString()),
  ]);

  if (driversRes.error || shiftsRes.error) {
    console.warn("attendance load:", driversRes.error || shiftsRes.error);
    return;
  }

  const drivers   = driversRes.data || [];
  const shifts    = shiftsRes.data  || [];
  const coachings = coachingsRes?.data || [];
  const decisions = decisionsRes?.data || [];

  // Excused-decision count per driver. A shift with decision='deny'
  // also produced shifts.status of (no_show|late|called_off) before
  // 0099 stamped the same row as excused on finalize — but the
  // operator's intent in either case is "this doesn't count", so
  // surface it as Excused regardless of how the underlying shift
  // status reads. Strip the matching incident from the legacy
  // counters below so we don't double-count it.
  const excusedShiftIds = new Set(decisions.map(d => d.shift_id));
  const excusedByDriver = new Map();
  for (const d of decisions) {
    excusedByDriver.set(d.driver_id, (excusedByDriver.get(d.driver_id) || 0) + 1);
  }
  // Cache per-shift decision notes for the row drilldown / tooltip.
  _attDecisionNotesByShift = new Map(decisions.map(d => [d.shift_id, d.notes || ""]));

  // Map driver_id → most recent attendance coaching.  Also remember
  // the count so the dispatcher can tell at a glance "this driver
  // has been coached three times in the window."
  const lastCoachByDriver = new Map();
  const coachCountByDriver = new Map();
  for (const c of coachings) {
    if (!lastCoachByDriver.has(c.driver_id)) lastCoachByDriver.set(c.driver_id, c);
    coachCountByDriver.set(c.driver_id, (coachCountByDriver.get(c.driver_id) || 0) + 1);
  }

  // Per-driver tally. A shift with an Excused decision is counted
  // as excused only — strip it from the late/callout/noshow counters
  // so it doesn't drag down the driver's standing AND show up as
  // excused in the report.
  const acc = new Map();
  for (const sh of shifts) {
    if (!sh.driver_id) continue;
    let a = acc.get(sh.driver_id);
    if (!a) { a = { scheduled: 0, present: 0, late: 0, callouts: 0, noshows: 0, vto: 0, excused: 0, last: null }; acc.set(sh.driver_id, a); }
    a.scheduled += 1;
    if (excusedShiftIds.has(sh.id)) {
      a.excused += 1;
    } else if (sh.status === "completed")  a.present  += 1;
    else if (sh.status === "late")       a.late     += 1;
    else if (sh.status === "called_off") a.callouts += 1;
    else if (sh.status === "no_show")    a.noshows  += 1;
    else if (sh.status === "vto")        a.vto      += 1;
    if (!excusedShiftIds.has(sh.id) && (sh.status === "called_off" || sh.status === "no_show")) {
      if (!a.last || sh.date > a.last) a.last = sh.date;
    }
  }

  let totalScheduled = 0, totalIncidents = 0, totalVto = 0, totalExcused = 0, inAction = 0;
  const todayMs = Date.now();
  // Per-event point values from the block policy.  An event kind that
  // has no Event block (or 0 points) doesn't contribute to the
  // running total — that's how the operator says "log this but don't
  // count it" with the new builder.
  const ptsCallout = EVAL.events.callout ? Number(EVAL.events.callout.points) || 0 : 0;
  const ptsNoshow  = EVAL.events.no_show ? Number(EVAL.events.no_show.points) || 0 : 0;
  const ptsLate    = EVAL.events.late    ? Number(EVAL.events.late.points)    || 0 : 0;
  const sevToLabel = { verbal: "Verbal", written: "Written", final: "Final", termination: "Termination" };
  const rows = drivers.map(d => {
    const a = acc.get(d.id) || { scheduled: 0, present: 0, late: 0, callouts: 0, noshows: 0, vto: 0, excused: 0, last: null };
    // occ is still "how many counted events" — kept for the existing
    // Occ. column.  points uses the per-event point values from
    // the block policy.
    const occ    = (ptsLate > 0 ? a.late : 0) + (ptsCallout > 0 ? a.callouts : 0) + (ptsNoshow > 0 ? a.noshows : 0);
    const points = (a.late * ptsLate) + (a.callouts * ptsCallout) + (a.noshows * ptsNoshow);

    let statusLabel = "Good";
    let statusKind  = "ok";
    let coachingLabel = "Clear";

    if (!EVAL.enabled) {
      statusLabel = "Policy off"; statusKind = "ok"; coachingLabel = "Policy off";
    } else {
      const rung = _evalLadderRung(EVAL, points);
      if (rung) {
        coachingLabel = sevToLabel[rung.severity] || rung.severity;
        statusKind = rung.severity === "verbal" ? "warn" : "bad";
        statusLabel = rung.severity === "verbal" ? "Warn" : "Action";
      }
    }
    // First-30-strict — same effect as before but driven by the new
    // block-shaped policy.
    if (EVAL.first_30 && EVAL.first_30.active && d.hire_date && occ > 0) {
      const daysSinceHire = Math.floor((todayMs - new Date(d.hire_date + "T12:00:00").getTime()) / 86400000);
      if (daysSinceHire >= 0 && daysSinceHire <= (EVAL.first_30.days || 30)) {
        statusLabel = "Action · first-30 rule";
        statusKind  = "bad";
        if (coachingLabel === "Clear" || coachingLabel === "Verbal") coachingLabel = "Written · 1st 30";
      }
    }
    totalScheduled += a.scheduled;
    totalIncidents += occ;
    totalVto       += a.vto;
    totalExcused   += a.excused;
    if (statusKind !== "ok") inAction += 1;
    const lastCoach = lastCoachByDriver.get(d.id) || null;
    const coachCount = coachCountByDriver.get(d.id) || 0;
    return { d, a, points, occ, statusLabel, statusKind, coachingLabel, lastCoach, coachCount };
  });

  _attReportRows = rows;

  // KPIs.
  const absenceRate = totalScheduled > 0 ? (totalIncidents / totalScheduled * 100) : 0;
  const presentPct  = Math.round(100 - absenceRate);
  const vtoPct      = totalScheduled > 0 ? Math.round(totalVto / totalScheduled * 100) : 0;
  const setKpi = (id, text, cls) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    if (cls) el.className = `di-val ${cls}`;
  };
  const excusedPct = totalScheduled > 0 ? Math.round(totalExcused / totalScheduled * 100) : 0;
  setKpi("att-kpi-rate", `${presentPct}%`, presentPct >= 95 ? "ok" : presentPct >= 90 ? "warn" : "bad");
  setKpi("att-kpi-vto", `${vtoPct}%`);
  setKpi("att-kpi-excused", `${totalExcused}`);
  const rateSubEl = document.getElementById("att-kpi-rate-sub");
  if (rateSubEl) rateSubEl.textContent = `${totalIncidents} absent / ${totalScheduled} scheduled · last ${decay}d`;
  const vtoSubEl = document.getElementById("att-kpi-vto-sub");
  if (vtoSubEl) vtoSubEl.textContent = `${totalVto} VTO / ${totalScheduled} scheduled · last ${decay}d`;
  const excusedSubEl = document.getElementById("att-kpi-excused-sub");
  if (excusedSubEl) excusedSubEl.textContent = `${totalExcused} excused · ${excusedPct}% · last ${decay}d`;

  // "In corrective action" KPI — drivers currently flagged at any
  // step of the coaching ladder.  Verbal = at the warn threshold,
  // Written = at the action threshold (or first-30-days strict),
  // Final and Termination are tracked manually for now (no historical
  // coaching ladder yet) so we surface 0 for those — operators see
  // the live count grow once those flows are wired up.
  let nVerbal = 0, nWritten = 0;
  for (const r of rows) {
    if (r.statusKind === "warn")     nVerbal++;
    else if (r.statusKind === "bad") nWritten++;
  }
  const nTotal = nVerbal + nWritten;
  setKpi("att-kpi-action-count",
    String(nTotal),
    nTotal === 0 ? "ok" : nTotal <= 3 ? "warn" : "bad");
  const breakdownEl = document.getElementById("att-kpi-action-breakdown");
  if (breakdownEl) {
    breakdownEl.textContent = POLICY.policy_enabled === false
      ? "Policy is OFF"
      : `${nVerbal} verbal · ${nWritten} written · 0 final · 0 termination`;
  }

  _renderAttReportTbody();

  const badge = document.getElementById("att-subnav-badge");
  if (badge) {
    if (inAction > 0) { badge.textContent = String(inAction); badge.style.display = "inline-block"; }
    else { badge.style.display = "none"; }
  }
}

// Filter chip state for the Attendance Report overview.
let _attReportFilter = "all";

document.addEventListener("click", (e) => {
  const chip = e.target.closest("#rr-att-filters [data-rr-att-filter]");
  if (!chip) return;
  e.preventDefault();
  _attReportFilter = chip.getAttribute("data-rr-att-filter");
  document.querySelectorAll("#rr-att-filters [data-rr-att-filter]").forEach(c =>
    c.classList.toggle("active", c === chip));
  _renderAttReportTbody();
});

// Repaint the policy snapshot banner above the table.  Reads from
// _attReportRows directly so it always matches what's rendered.
function _renderAttSnapshot() {
  const el = document.getElementById("rr-att-snapshot");
  if (!el) return;
  const rows = _attReportRows || [];
  if (rows.length === 0) { el.style.display = "none"; return; }
  const counts = { Termination: 0, Final: 0, Written: 0, Verbal: 0, Clear: 0 };
  for (const r of rows) {
    const k = r.coachingLabel === "Written · 1st 30" ? "Written"
            : (r.coachingLabel === "Policy off" ? "Clear" : r.coachingLabel);
    if (counts[k] != null) counts[k] += 1;
  }
  el.style.display = "block";
  el.innerHTML = `
    <div class="att-snapshot-row">
      <span class="att-snapshot-title">${rows.length} drivers ·</span>
      <span class="att-snapshot-pip"><span class="att-snapshot-pip-dot" style="background:var(--red-dark)"></span>${counts.Termination} Termination</span>
      <span class="att-snapshot-pip"><span class="att-snapshot-pip-dot" style="background:var(--red)"></span>${counts.Final} Final</span>
      <span class="att-snapshot-pip"><span class="att-snapshot-pip-dot" style="background:var(--amber-dark)"></span>${counts.Written} Written</span>
      <span class="att-snapshot-pip"><span class="att-snapshot-pip-dot" style="background:var(--amber)"></span>${counts.Verbal} Verbal</span>
      <span class="att-snapshot-pip"><span class="att-snapshot-pip-dot" style="background:var(--green-dark)"></span>${counts.Clear} Clear</span>
    </div>`;
}

function _renderAttReportTbody() {
  const tbody = document.getElementById("att-report-body");
  if (!tbody) return;
  _renderAttSnapshot();
  let rows = [..._attReportRows];
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="rr-empty-inline">No drivers yet</div></td></tr>`;
    return;
  }
  // Apply filter chip.  "atrisk" = anyone past Clear; "recent" = has
  // coaching < 14d ago; "uncoached" = no coaching in window.
  const fourteen = Date.now() - 14 * 86400000;
  if (_attReportFilter === "atrisk") {
    rows = rows.filter(r => r.coachingLabel !== "Clear" && r.coachingLabel !== "Policy off");
  } else if (_attReportFilter === "recent") {
    rows = rows.filter(r => r.lastCoach && new Date(r.lastCoach.occurred_at).getTime() >= fourteen);
  } else if (_attReportFilter === "uncoached") {
    rows = rows.filter(r => !r.lastCoach);
  }
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="rr-empty-inline">No drivers match this filter.</div></td></tr>`;
    return;
  }

  // Apply current sort.  Direction: asc / desc.  Each column maps to
  // a comparator-friendly value via the keyOf table below.
  // Coaching column ranks by ladder severity so a click sorts most-
  // urgent → clear (Termination > Final > Written > Verbal > Clear).
  const COACHING_RANK = { "Termination": 4, "Final": 3, "Written · 1st 30": 2, "Written": 2, "Verbal": 1, "Clear": 0, "Policy off": -1 };
  // Severity rank for the new Last coaching column — drives the
  // sort when an operator clicks that header.
  const SEV_RANK = { termination: 4, final: 3, written: 3, warning: 3, verbal: 1, concern: 1, note: 0, info: 0 };
  const keyOf = {
    driver:    (r) => (displayDriverName(r.d) || "").toLowerCase(),
    station:   (r) => (r.d.station?.code || "").toLowerCase(),
    scheduled: (r) => r.a.scheduled,
    present:   (r) => r.a.present,
    late:      (r) => r.a.late,
    callouts:  (r) => r.a.callouts,
    noshows:   (r) => r.a.noshows,
    vto:       (r) => r.a.vto,
    points:    (r) => r.points,
    occ:       (r) => r.occ,
    status:    (r) => COACHING_RANK[r.coachingLabel] ?? 0,
    lastcoach: (r) => r.lastCoach ? (SEV_RANK[r.lastCoach.severity] ?? 0) : -1,
    last:      (r) => r.a.last || "",
  };
  const k = keyOf[_attReportSort.col] || keyOf.points;
  const dir = _attReportSort.dir === "asc" ? 1 : -1;
  rows.sort((x, y) => {
    const a = k(x), b = k(y);
    if (a < b) return -1 * dir;
    if (a > b) return  1 * dir;
    // Tie-break on driver name asc.
    const xn = (displayDriverName(x.d) || "").toLowerCase();
    const yn = (displayDriverName(y.d) || "").toLowerCase();
    return xn < yn ? -1 : xn > yn ? 1 : 0;
  });

  // Repaint header carets so the active sort is visible.
  const thead = document.getElementById("att-report-thead");
  if (thead) {
    thead.querySelectorAll("[data-rr-att-sort]").forEach(th => {
      const col = th.dataset.rrAttSort;
      const base = th.textContent.replace(/\s*[▲▼]\s*$/, "");
      th.textContent = base;
      if (col === _attReportSort.col) {
        th.appendChild(document.createTextNode(" "));
        const arrow = document.createElement("span");
        arrow.style.fontSize = "9px";
        arrow.textContent = _attReportSort.dir === "asc" ? "▲" : "▼";
        th.appendChild(arrow);
      }
    });
  }

  // Group rows by ladder rung so the highest-priority drivers float
  // to the top with a clear section header.  Override the user's
  // sort only when no explicit column sort is active (default points
  // desc maps cleanly to ladder grouping anyway).
  const groupOrder  = ["Termination", "Final", "Written", "Written · 1st 30", "Verbal", "Clear", "Policy off"];
  const groupLabels = { "Termination": "Termination", "Final": "Final", "Written": "Written", "Written · 1st 30": "Written (first-30)", "Verbal": "Verbal", "Clear": "Clear", "Policy off": "Policy off" };
  const buckets = new Map();
  for (const lbl of groupOrder) buckets.set(lbl, []);
  for (const r of rows) {
    const key = buckets.has(r.coachingLabel) ? r.coachingLabel : "Clear";
    buckets.get(key).push(r);
  }
  // Within a bucket, sort by points desc then driver name.
  for (const [, list] of buckets) {
    list.sort((x, y) => (y.points - x.points) || (displayDriverName(x.d) || "").localeCompare(displayDriverName(y.d) || ""));
  }

  const RECOMMEND = {
    "Termination":      "termination",
    "Final":            "final",
    "Written":          "written",
    "Written · 1st 30": "written",
    "Verbal":           "verbal",
    "Clear":            "verbal",
    "Policy off":       "verbal",
  };

  // Decide once per row whether it needs an action — used by both
  // the row class (left accent stripe) and the group-header count.
  // Reuses SEV_RANK declared above for the lastcoach sort.
  const rowNeedsAction = (r) => {
    const sev = RECOMMEND[r.coachingLabel] || "verbal";
    const isClear = r.coachingLabel === "Clear" || r.coachingLabel === "Policy off";
    if (isClear) return false;
    const rowSevRank  = SEV_RANK[sev] ?? 0;
    const lastSevRank = r.lastCoach ? (SEV_RANK[r.lastCoach.severity] ?? 0) : -1;
    return rowSevRank > lastSevRank;
  };

  const renderRow = (r) => {
    const display = displayDriverName(r.d);
    const initials = displayDriverInitials(r.d);
    const station = r.d.station?.code || "—";
    const lastEv  = r.a.last ? new Date(r.a.last + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
    const statusVariant = r.statusKind === "bad"  ? "danger"
                        : r.statusKind === "warn" ? "warning"
                        : "neutral";
    const sev = RECOMMEND[r.coachingLabel] || "verbal";
    const summary = `${r.coachingLabel} · ${r.a.callouts} callout${r.a.callouts === 1 ? "" : "s"}, ${r.a.noshows} no-show${r.a.noshows === 1 ? "" : "s"}, ${r.a.late} late`;

    let lastCoachCell = `<span style="color:var(--text-subtle)">—</span>`;
    if (r.lastCoach) {
      const lc       = r.lastCoach;
      const sevLabel = (_COACHING_SEV_LABEL && _COACHING_SEV_LABEL[lc.severity]) || lc.severity;
      const when     = lc.occurred_at ? _relTimeAgo(lc.occurred_at) : "";
      let ackChip;
      if (lc.acknowledged_at) {
        const ackBy = lc.signed_at ? "Signed" : "Acknowledged";
        ackChip = `<span class="att-coach-chip done" title="${escapeHtml(ackBy)} ${escapeHtml(_relTimeAgo(lc.acknowledged_at))}">✓ ${escapeHtml(ackBy)}</span>`;
      } else if (lc.delivery_required && lc.delivery_required !== "none") {
        ackChip = `<span class="att-coach-chip pending" title="Driver hasn't acknowledged yet">Awaiting ack</span>`;
      } else {
        ackChip = `<span class="att-coach-chip" title="No driver action required">Sent</span>`;
      }
      lastCoachCell = `<div style="display:flex;flex-direction:column;gap:2px"><div style="font-weight:600;font-size:var(--fs-sm)">${escapeHtml(sevLabel)}<span style="color:var(--text-subtle);font-weight:500"> · ${escapeHtml(when)}</span></div>${ackChip}</div>`;
    }

    // Decide whether the row needs an action button.  Show ONLY when
    // the driver has crossed a ladder rung that hasn't been coached
    // at that severity yet.  Already-coached or Clear rows stay
    // quiet — operators can drill into the per-driver Attendance tab
    // to send a follow-up coaching when they want one.
    const needsAction = rowNeedsAction(r);

    const actionCell = needsAction
      ? `<button class="btn btn-sm" type="button"
          data-rr-coach-report="1"
          data-rr-coach-driver="${escapeHtml(r.d.id)}"
          data-rr-coach-driver-name="${escapeHtml(display)}"
          data-rr-coach-severity="${escapeHtml(sev)}"
          data-rr-coach-summary="${escapeHtml(summary)}"
          data-rr-coach-points="${r.points}"
          data-rr-coach-occ="${r.occ}"
          data-rr-coach-callouts="${r.a.callouts}"
          data-rr-coach-noshows="${r.a.noshows}"
          data-rr-coach-late="${r.a.late}"
          title="Send coaching · pre-filled with ladder recommendation">Send coaching</button>`
      : "";

    // Whole row is clickable → opens drawer on Attendance tab.
    // Action-needed rows carry a left accent stripe via .att-row-action
    // so the eye finds them before reading any individual cell.
    const rowCls = needsAction ? "att-row-action" : "";
    return `<tr data-rr-att-row="${escapeHtml(r.d.id)}" class="${rowCls}" style="cursor:pointer">
      <td><div class="cell-driver"><div class="avatar-sm">${initials}</div><div><div class="cell-name">${escapeHtml(display)}</div></div></div></td>
      <td>${escapeHtml(station)}</td>
      <td><span class="status-pill status-pill-${statusVariant}" title="${escapeHtml(r.statusLabel)}">${escapeHtml(r.coachingLabel)}</span></td>
      <td style="text-align:right;font-weight:600">${r.points}</td>
      <td>${escapeHtml(lastEv)}</td>
      <td>${lastCoachCell}</td>
      <td style="text-align:right">${actionCell}</td>
    </tr>`;
  };

  let html = "";
  for (const lbl of groupOrder) {
    const list = buckets.get(lbl) || [];
    if (list.length === 0) continue;
    const needCount = list.filter(rowNeedsAction).length;
    const headerSuffix = needCount > 0
      ? `<span class="count">· ${needCount} need coaching</span>`
      : `<span class="count">· ${list.length}</span>`;
    html += `<tr><td colspan="7" class="att-group-head">${escapeHtml(groupLabels[lbl] || lbl)} ${headerSuffix}</td></tr>`;
    html += list.map(renderRow).join("");
  }
  tbody.innerHTML = html;
}

// Severity → human label for the Last coaching column on the
// Attendance Report and the Event log "✓ Coached" badge.
const _COACHING_SEV_LABEL = {
  note: "Note", info: "Note",
  verbal: "Verbal", concern: "Verbal",
  written: "Written", warning: "Written",
  final: "Final",
  termination: "Termination",
};

// Compact "1d ago" / "3h ago" / "just now" helper.
function _relTimeAgo(iso) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  if (d < 30) return d + "d ago";
  return new Date(iso).toLocaleDateString();
}

// ─── Attendance KPI detail panel ──────────────────────────────────────────
//
// Click a KPI card above the report and a panel opens below the strip
// showing the relevant breakdown.  The data fetch is on-demand and
// cached at the maximum range we've seen so toggling 30/90/365 doesn't
// re-hit the network unless the user widens the window.
//
//   rate   → distribution of absences (callouts + no-shows) by weekday
//   vto    → distribution of VTO events by weekday
//   action → bar breakdown: % of team at each coaching ladder rung
//            (suppressed with a friendly note when the policy is off)

let _attKpiDetailKpi   = null;        // 'rate' | 'vto' | 'excused' | 'action' | null
let _attKpiDetailRange = 90;          // 30 | 90 | 365
let _attKpiHistory     = null;        // { range:Number, byDay:Array<{date,scheduled,present,late,callouts,noshows,vto}> }

// Hide the KPI drilldown panel and reset state.  Called whenever the
// operator navigates away from the report so they always come back to
// a closed-by-default report — no stale "the panel I left open last
// time" surprises.
function _closeAttKpiDetail() {
  _attKpiDetailKpi = null;
  const panel = document.getElementById("rr-att-kpi-detail");
  if (panel) { panel.style.display = "none"; panel.innerHTML = ""; }
  document.querySelectorAll("[data-rr-att-kpi]").forEach(el => el.classList.remove("active"));
}

async function _ensureAttKpiHistory(rangeDays) {
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return null;
  if (_attKpiHistory && _attKpiHistory.range >= rangeDays) return _attKpiHistory;

  const today    = new Date();
  const since    = new Date(); since.setDate(since.getDate() - rangeDays);
  const sinceIso = fmtIsoDate(since);
  const todayIso = fmtIsoDate(today);

  const { data, error } = await sb.from("shifts")
    .select("date, status")
    .eq("dsp_id", dspId)
    .gte("date", sinceIso)
    .lte("date", todayIso);
  if (error) { console.warn("att kpi history:", error.message); return null; }

  const byDayMap = new Map();
  for (const sh of (data || [])) {
    if (!sh.date) continue;
    let g = byDayMap.get(sh.date);
    if (!g) { g = { date: sh.date, scheduled:0, present:0, late:0, callouts:0, noshows:0, vto:0 }; byDayMap.set(sh.date, g); }
    g.scheduled += 1;
    if      (sh.status === "completed")  g.present  += 1;
    else if (sh.status === "late")       g.late     += 1;
    else if (sh.status === "called_off") g.callouts += 1;
    else if (sh.status === "no_show")    g.noshows  += 1;
    else if (sh.status === "vto")        g.vto      += 1;
  }
  const byDay = [...byDayMap.values()].sort((a, b) => a.date < b.date ? -1 : 1);
  _attKpiHistory = { range: rangeDays, byDay };
  return _attKpiHistory;
}

function _attKpiSliceToRange(rows, rangeDays) {
  const cutoffMs = Date.now() - rangeDays * 86400000;
  return rows.filter(r => new Date(r.date + "T12:00:00").getTime() >= cutoffMs);
}

// Group daily rows into a 7-bucket weekday distribution.  valueFn
// pulls the metric per row (e.g. callouts+noshows for the rate view,
// vto for the VTO view).  Output buckets are Mon..Sun so the work-week
// reads left-to-right naturally for a logistics audience.
function _attKpiByWeekday(rows, valueFn) {
  const labels = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
  const buckets = [0,0,0,0,0,0,0];
  let total = 0;
  for (const r of rows) {
    const v = valueFn(r);
    if (!v) continue;
    const dow = new Date(r.date + "T12:00:00").getDay(); // 0=Sun..6=Sat
    const idx = (dow + 6) % 7;                            // shift so Mon=0..Sun=6
    buckets[idx] += v;
    total += v;
  }
  return { labels, buckets, total };
}

function _attKpiWeekdayBars(rows, valueFn, opts) {
  const { color = "var(--accent)", noun = "events", emptyMessage = "No events in range." } = opts || {};
  const { labels, buckets, total } = _attKpiByWeekday(rows, valueFn);
  if (total === 0) {
    return `<div class="rr-empty-inline" style="padding:32px 0">${escapeHtml(emptyMessage)}</div>`;
  }
  const max = Math.max(...buckets);
  // Bar width is scaled to the busiest weekday so the differences are
  // legible; the % label still reflects share of the total.
  return labels.map((label, i) => {
    const n   = buckets[i];
    const pct = (n / total) * 100;
    const w   = max > 0 ? (n / max) * 100 : 0;
    return `<div style="display:grid;grid-template-columns:96px 1fr 88px;gap:14px;align-items:center;padding:8px 0">
      <div style="font-size:var(--fs-sm);font-weight:600;color:var(--text)">${label}</div>
      <div style="background:var(--canvas);border-radius:6px;height:14px;overflow:hidden;border:1px solid var(--border)">
        <div style="background:${color};height:100%;width:${w.toFixed(1)}%;transition:width var(--t-fast)"></div>
      </div>
      <div style="font-size:var(--fs-sm);color:var(--text-muted);text-align:right">
        <strong style="color:var(--text)">${n}</strong> · ${pct.toFixed(0)}%
      </div>
    </div>`;
  }).join("") + `<div style="font-size:var(--fs-xs);color:var(--text-subtle);padding-top:8px;border-top:1px solid var(--border);margin-top:8px">${total} ${noun} across ${_attKpiDetailRange === 365 ? "the last year" : "the last " + _attKpiDetailRange + " days"}.</div>`;
}

function _attRangeToggleHtml(active) {
  // Subtle clock-icon affordance — opens a small popover with the
  // three windows. Matches the Turnover KPI's switcher pattern.
  const label = active === 365 ? "1 year" : `${active} days`;
  return `<button id="rr-att-range-toggle" type="button"
    style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid var(--border);background:var(--surface);border-radius:8px;cursor:pointer;font:inherit;font-size:var(--fs-xs);font-weight:600;color:var(--text-muted);position:relative"
    title="Switch time frame" aria-label="Switch time frame">
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>
    <span>${label}</span>
  </button>`;
}

function _attKpiPanelShell(title, sub, body) {
  return `<div class="card" style="padding:var(--s-5)">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:var(--s-3);margin-bottom:var(--s-3)">
      <div>
        <div style="font-size:var(--fs-lg);font-weight:700;color:var(--text);letter-spacing:-.01em">${escapeHtml(title)}</div>
        <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">${sub}</div>
      </div>
      ${_attRangeToggleHtml(_attKpiDetailRange)}
    </div>
    ${body}
  </div>`;
}

async function _renderAttKpiDetail() {
  const panel = document.getElementById("rr-att-kpi-detail");
  if (!panel) return;

  // Highlight the active KPI card.
  document.querySelectorAll("[data-rr-att-kpi]").forEach(el => {
    el.classList.toggle("active", el.dataset.rrAttKpi === _attKpiDetailKpi);
  });

  if (!_attKpiDetailKpi) { panel.style.display = "none"; panel.innerHTML = ""; return; }
  panel.style.display = "block";

  // Coaching breakdown doesn't depend on the daily-history fetch — it
  // reads the per-driver report rows that the report already computed.
  // Termination is intentionally excluded: a terminated driver isn't
  // "in" the team anymore so showing them as a slice was misleading.
  if (_attKpiDetailKpi === "action") {
    const POLICY = _getAttPolicy();
    if (POLICY.policy_enabled === false) {
      panel.innerHTML = _attKpiPanelShell(
        "Corrective action",
        "Breakdown of the team across the coaching ladder.",
        `<div class="rr-empty-inline" style="padding:32px 0">Attendance policy is OFF — no coaching levels are being tracked. Turn the policy on in Settings → Attendance to see this breakdown.</div>`
      );
      return;
    }
    const rows = _attReportRows || [];
    const order  = ["Clear", "Verbal", "Written", "Final"];
    const buckets = { "Clear": 0, "Verbal": 0, "Written": 0, "Final": 0 };
    for (const r of rows) {
      let k = (r.coachingLabel || "").startsWith("Written") ? "Written" : r.coachingLabel;
      // Fold Termination back into Final for the breakdown — termination
      // is a one-time action, not a population the team sits in.
      if (k === "Termination") k = "Final";
      if (k in buckets) buckets[k] += 1;
      else buckets["Clear"] += 1;
    }
    const total = order.reduce((s, k) => s + buckets[k], 0);
    if (total === 0) {
      panel.innerHTML = _attKpiPanelShell("Corrective action", "Breakdown of the team across the coaching ladder.",
        `<div class="rr-empty-inline" style="padding:32px 0">No drivers loaded yet.</div>`);
      return;
    }
    const colors = {
      "Clear":   "var(--green)",
      "Verbal":  "var(--amber)",
      "Written": "var(--orange, var(--amber))",
      "Final":   "var(--red)",
    };
    const blurbs = {
      "Clear":   "no active coaching",
      "Verbal":  "1 occurrence in window",
      "Written": "2 occurrences in window",
      "Final":   "3+ occurrences in window",
    };

    // Top-of-panel stacked bar — gives the operator a single visual of
    // how the team splits across all four levels at a glance.
    const stack = order.map(k => {
      const pct = total ? (buckets[k] / total) * 100 : 0;
      return pct > 0
        ? `<div title="${k}: ${buckets[k]} drivers (${Math.round(pct)}%)" style="background:${colors[k]};width:${pct}%;height:100%"></div>`
        : "";
    }).join("");

    // Per-level rows lead with the % so the accountability distribution
    // is the headline number; count + descriptor support it.
    const rowsHtml = order.map(k => {
      const n   = buckets[k];
      const pct = total ? Math.round((n / total) * 100) : 0;
      return `<div style="display:grid;grid-template-columns:88px 12px 1fr;gap:14px;align-items:center;padding:14px 0;border-top:1px solid var(--border)">
        <div style="text-align:right">
          <div style="font-size:var(--fs-xxl);font-weight:700;color:var(--text);letter-spacing:-.02em;line-height:1">${pct}%</div>
          <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">of team</div>
        </div>
        <div style="width:6px;height:36px;background:${colors[k]};border-radius:3px"></div>
        <div>
          <div style="font-size:var(--fs-base);font-weight:700;color:var(--text)">${k}</div>
          <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px"><strong style="color:var(--text-muted)">${n} driver${n === 1 ? "" : "s"}</strong> · ${blurbs[k]}</div>
        </div>
      </div>`;
    }).join("");

    panel.innerHTML = `<div class="card" style="padding:var(--s-5)">
      <div style="margin-bottom:var(--s-4)">
        <div style="font-size:var(--fs-lg);font-weight:700;color:var(--text);letter-spacing:-.01em">Corrective action breakdown</div>
        <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">${total} active driver${total === 1 ? "" : "s"} across the coaching ladder right now.</div>
      </div>
      <div style="display:flex;height:14px;background:var(--canvas);border:1px solid var(--border);border-radius:7px;overflow:hidden;margin-bottom:8px">${stack}</div>
      <div style="display:flex;justify-content:space-between;font-size:var(--fs-xs);color:var(--text-subtle);margin-bottom:var(--s-3)">
        <span>Lowest accountability</span><span>Highest</span>
      </div>
      ${rowsHtml}
    </div>`;
    return;
  }

  // Excused view: list of individual excused decisions with the
  // operator's notes, sorted newest-first. The notes are the whole
  // point of this drilldown — operators want to remember WHY they
  // forgave each absence (approved leave, system glitch, doc'd
  // illness, etc.).
  if (_attKpiDetailKpi === "excused") {
    const title = "Excused absences";
    const sub   = "Each absence the dispatcher chose not to count, with the notes that explain why.";
    panel.innerHTML = _attKpiPanelShell(title, sub, `<div class="rr-loading">Loading…</div>`);

    const days = Number(_attKpiDetailRange) || 90;
    const fromIso = fmtIsoDate(new Date(Date.now() - days * 86400000));
    const toIso   = fmtIsoDate(new Date());
    const { data: rows, error } = await sb.rpc("attendance_excused_list", {
      p_from: fromIso, p_to: toIso,
    });
    if (error) {
      panel.innerHTML = _attKpiPanelShell(title, sub,
        `<div class="rr-empty-inline" style="padding:32px 0;color:var(--red)">Couldn't load: ${escapeHtml(error.message)}</div>`);
      return;
    }
    if (!rows || rows.length === 0) {
      panel.innerHTML = _attKpiPanelShell(title, sub,
        `<div class="rr-empty-inline" style="padding:32px 0">No excused absences in range.</div>`);
      return;
    }
    const outcomeLabel = (o) => ({
      ncns:            "No-call no-show",
      tardy:           "Tardy",
      missed_reported: "Callout",
    }[o] || o);
    const fmtDay = (d) => {
      const dt = new Date(d + "T12:00:00");
      return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    };
    const list = rows.map(r => `
      <div style="display:grid;grid-template-columns:90px 180px 1fr;gap:14px;align-items:start;padding:14px 0;border-top:1px solid var(--border)">
        <div>
          <div style="font-size:var(--fs-md);font-weight:600">${escapeHtml(fmtDay(r.date))}</div>
          <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">${escapeHtml(r.station_code || "—")}</div>
        </div>
        <div>
          <div style="font-size:var(--fs-md);font-weight:600">${escapeHtml(r.driver_name || "")}</div>
          <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">${escapeHtml(outcomeLabel(r.outcome))}${r.decided_by ? " · by " + escapeHtml(r.decided_by) : ""}</div>
        </div>
        <div style="font-size:var(--fs-md);color:var(--text);line-height:1.5">${r.notes ? escapeHtml(r.notes) : `<span style="color:var(--text-subtle)">— no notes —</span>`}</div>
      </div>`).join("");
    panel.innerHTML = _attKpiPanelShell(title, sub, `
      <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-bottom:8px">${rows.length} excused in last ${days}d</div>
      ${list}`);
    return;
  }

  // Rate + VTO views: weekday distribution.  The chart answers
  // "which day of the week do these events cluster on?" so a DSP can
  // see if Mondays are absence-heavy or VTO clusters around weekends.
  const isRate = _attKpiDetailKpi === "rate";
  const title  = isRate ? "Absences by day of the week" : "VTO by day of the week";
  const sub    = isRate
    ? "Distribution of callouts + no-shows across each weekday."
    : "Distribution of VTO events across each weekday.";

  panel.innerHTML = _attKpiPanelShell(title, sub, `<div class="rr-loading">Loading…</div>`);

  const hist = await _ensureAttKpiHistory(_attKpiDetailRange);
  if (!hist) {
    panel.innerHTML = _attKpiPanelShell(title, sub,
      `<div class="rr-empty-inline" style="padding:32px 0">Couldn't load history — try again.</div>`);
    return;
  }
  const sliced  = _attKpiSliceToRange(hist.byDay, _attKpiDetailRange);
  const valueFn = isRate ? (r) => r.callouts + r.noshows : (r) => r.vto;
  const opts = isRate
    ? { color: "var(--red)",    noun: "absences",   emptyMessage: "No callouts or no-shows in range — nice." }
    : { color: "var(--accent)", noun: "VTO events", emptyMessage: "No VTO events in range." };
  panel.innerHTML = _attKpiPanelShell(title, sub, _attKpiWeekdayBars(sliced, valueFn, opts));
}

// Click handler: KPI card opens / closes its own detail panel.
document.addEventListener("click", (e) => {
  const card = e.target.closest("[data-rr-att-kpi]");
  if (card) {
    const kpi = card.dataset.rrAttKpi;
    _attKpiDetailKpi = (_attKpiDetailKpi === kpi) ? null : kpi;
    _renderAttKpiDetail();
    return;
  }
  // Time-frame toggle button → small popover with 30 / 90 / 1y.
  const tfBtn = e.target.closest("#rr-att-range-toggle");
  if (tfBtn) {
    e.stopPropagation();
    e.preventDefault();
    const existing = tfBtn.querySelector(".rr-tf-popover");
    if (existing) { existing.remove(); return; }
    document.querySelectorAll(".rr-tf-popover").forEach(el => el.remove());
    const opts = [{ d: 30, l: "30 days" }, { d: 90, l: "90 days" }, { d: 365, l: "1 year" }];
    const pop = document.createElement("div");
    pop.className = "rr-tf-popover";
    pop.style.top = "30px"; pop.style.right = "0";
    pop.innerHTML = opts.map(o =>
      `<button data-rr-att-range="${o.d}" class="${o.d === _attKpiDetailRange ? "active" : ""}">${o.l}</button>`
    ).join("");
    tfBtn.appendChild(pop);
    return;
  }
  const range = e.target.closest("[data-rr-att-range]");
  if (range) {
    _attKpiDetailRange = Number(range.dataset.rrAttRange) || 90;
    document.querySelectorAll(".rr-tf-popover").forEach(el => el.remove());
    _renderAttKpiDetail();
    return;
  }
  // Click outside the toggle closes any open popover.
  if (!e.target.closest("#rr-att-range-toggle, .rr-tf-popover")) {
    document.querySelectorAll(".rr-tf-popover").forEach(el => el.remove());
  }
});
// Keyboard activation for the role="button" KPI cards.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const card = e.target.closest("[data-rr-att-kpi]");
  if (!card) return;
  e.preventDefault();
  card.click();
});

// ─── Today's check-in (live) ───────────────────────────────────────────────

const _CI_TO_STATUS = { present: "completed", late: "late", callout: "called_off", noshow: "no_show", vto: "vto" };
const _STATUS_TO_CI = Object.fromEntries(Object.entries(_CI_TO_STATUS).map(([k, v]) => [v, k]));

// ─── Dashboard · Weather (NWS forecast + alerts) ──────────────────────

let _weatherRefreshTimer = null;
function _scheduleWeatherRefresh() {
  if (_weatherRefreshTimer) return;
  _weatherRefreshTimer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (!document.getElementById("rr-weather-body")) return;
    loadDashboardWeather();
  }, 5 * 60 * 1000);
}

async function loadDashboardWeather() {
  const card = document.getElementById("rr-weather-card");
  const body = document.getElementById("rr-weather-body");
  if (!body) return;
  const meta = window.RR?.dsp?.metadata?.weather || {};
  // Per-DSP toggle. Default true so existing installs don't lose the card.
  const showCard = meta.show_card !== false;
  if (card) card.style.display = showCard ? "" : "none";
  // Always evaluate radar visibility — it has its own toggle and must be
  // able to hide itself even when the forecast card is off.
  loadWeatherRadar();
  if (!showCard) return;
  _scheduleWeatherRefresh();
  const lat = Number(meta.lat);
  const lon = Number(meta.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    body.innerHTML = `<div class="task-eyebrow" style="margin-bottom:2px">Weather · station forecast</div>
      <div style="font-size:var(--fs-md);color:var(--text);font-weight:600;margin-bottom:2px">Set your station location</div>
      <div style="font-size:var(--fs-xs);color:var(--text-subtle);line-height:1.4">Paste lat/lon from Google Maps in Settings → Workspace to enable the local weather forecast and severe-weather alerts.</div>`;
    return;
  }

  body.innerHTML = `<div class="task-eyebrow" style="margin-bottom:2px">Weather · station forecast</div>
    <div style="font-size:var(--fs-md);color:var(--text-subtle)">Loading…</div>`;

  try {
    const headers = { "User-Agent": "RouteReady/1.0 (dashboard)", "Accept": "application/geo+json" };
    const pointsRes = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, { headers });
    if (!pointsRes.ok) throw new Error(`points HTTP ${pointsRes.status}`);
    const points = await pointsRes.json();
    const forecastUrl = points?.properties?.forecast;
    const hourlyUrl   = points?.properties?.forecastHourly;
    const stationsUrl = points?.properties?.observationStations;
    const locName = (() => {
      const rl = points?.properties?.relativeLocation?.properties;
      if (!rl) return "";
      return [rl.city, rl.state].filter(Boolean).join(", ");
    })();
    if (!forecastUrl) throw new Error("no forecast URL from NWS");

    const [fRes, alertsRes, hRes, stationsRes, sunRes] = await Promise.all([
      fetch(forecastUrl, { headers }),
      fetch(`https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`, { headers }),
      hourlyUrl ? fetch(hourlyUrl, { headers }) : Promise.resolve(null),
      stationsUrl ? fetch(stationsUrl, { headers }).catch(() => null) : Promise.resolve(null),
      fetch(`https://api.sunrise-sunset.org/json?lat=${lat.toFixed(4)}&lng=${lon.toFixed(4)}&formatted=0`).catch(() => null),
    ]);
    const forecast = await fRes.json();
    const alerts   = await alertsRes.json();
    const hourly   = hRes ? await hRes.json() : null;

    // Latest observation from nearest station (gust, pressure, visibility, real humidity)
    let obs = null;
    try {
      if (stationsRes && stationsRes.ok) {
        const stations = await stationsRes.json();
        const stationId = stations?.features?.[0]?.properties?.stationIdentifier;
        if (stationId) {
          const obsRes = await fetch(`https://api.weather.gov/stations/${stationId}/observations/latest`, { headers });
          if (obsRes.ok) {
            const o = await obsRes.json();
            obs = o?.properties || null;
          }
        }
      }
    } catch (e) { /* obs is optional */ }

    // Sunrise / sunset (UTC ISO → browser local)
    let sun = null;
    try {
      if (sunRes && sunRes.ok) {
        const sj = await sunRes.json();
        if (sj?.status === "OK") sun = sj.results;
      }
    } catch (e) { /* optional */ }

    const periods = forecast?.properties?.periods || [];
    if (periods.length === 0) throw new Error("no forecast periods");

    const now = periods[0];
    const dayPairs = [];
    for (let i = 0; i < periods.length && dayPairs.length < 8; i++) {
      const p = periods[i];
      if (p.isDaytime) {
        const next = periods[i + 1];
        dayPairs.push({
          label: p.name,
          hi: p.temperature,
          lo: next && !next.isDaytime ? next.temperature : null,
          unit: p.temperatureUnit,
          short: p.shortForecast,
          precip: p.probabilityOfPrecipitation?.value || 0,
          wind: p.windSpeed,
          windDir: p.windDirection,
          startTime: p.startTime,
        });
      }
    }

    const hourlyPeriods = (hourly?.properties?.periods || []).slice(0, 14);
    const peakRain = hourlyPeriods.reduce((m, h) => Math.max(m, h.probabilityOfPrecipitation?.value || 0), 0);
    const peakWindMph = hourlyPeriods.reduce((m, h) => {
      const v = parseInt(String(h.windSpeed || "").match(/(\d+)/)?.[1] || "0", 10);
      return Math.max(m, v);
    }, 0);
    const peakTemp = hourlyPeriods.reduce((m, h) => Math.max(m, h.temperature ?? -999), -999);
    const minTemp  = hourlyPeriods.reduce((m, h) => Math.min(m, h.temperature ??  999),  999);

    const fmtHour = (iso) => {
      try { const d = new Date(iso); const h = d.getHours(); return (h%12||12) + (h<12?"a":"p"); } catch { return ""; }
    };
    const tempColor = (t) => {
      if (t >= 95) return "var(--red)";
      if (t >= 85) return "var(--amber)";
      if (t <= 32) return "#5b8def";
      return "var(--text)";
    };
    const precipColor = (pct) => {
      if (pct >= 60) return "var(--red)";
      if (pct >= 30) return "var(--amber)";
      return "var(--text-subtle)";
    };
    const hourlyHtml = hourlyPeriods.map(h => {
      const pct = h.probabilityOfPrecipitation?.value || 0;
      const wind = parseInt(String(h.windSpeed || "").match(/(\d+)/)?.[1] || "0", 10);
      return `<div style="display:flex;flex-direction:column;align-items:center;gap:1px;padding:4px 5px;border-radius:4px;min-width:42px;background:var(--canvas)">
        <div style="font-size:var(--fs-xs);color:var(--text-muted);font-weight:600">${fmtHour(h.startTime)}</div>
        <div style="font-size:var(--fs-md);font-weight:700;color:${tempColor(h.temperature)};font-variant-numeric:tabular-nums;line-height:1">${h.temperature}°</div>
        <div style="font-size:9px;font-weight:600;color:${precipColor(pct)};line-height:1">${pct}%</div>
        ${wind >= 15 ? `<div style="font-size:9px;color:var(--amber);font-weight:600;line-height:1">${wind}</div>` : ""}
      </div>`;
    }).join("");

    const advisories = [];
    if (peakWindMph >= 25) advisories.push(`High wind to <strong>${peakWindMph} mph</strong> next 14h — secure cargo doors, watch high-profile vehicles.`);
    else if (peakWindMph >= 18) advisories.push(`Gusty wind to <strong>${peakWindMph} mph</strong> next 14h.`);
    if (peakTemp >= 95) advisories.push(`Heat to <strong>${peakTemp}°F</strong> — push hydration breaks, watch for heat stress.`);
    else if (peakTemp >= 88) advisories.push(`Warm <strong>${peakTemp}°F</strong> peak — stock water in vans.`);
    if (minTemp <= 32 && minTemp !== 999) advisories.push(`Freezing temps (<strong>${minTemp}°F</strong>) — black-ice risk on early routes.`);
    if (peakRain >= 60) {
      const wettest = hourlyPeriods.reduce((b, h) => ((h.probabilityOfPrecipitation?.value||0) > (b?.probabilityOfPrecipitation?.value||0) ? h : b), null);
      const when = wettest ? fmtHour(wettest.startTime) : "";
      advisories.push(`<strong>${peakRain}%</strong> precip${when ? ` near <strong>${when}</strong>` : ""} — pad route times, plan covered handoffs.`);
    } else if (peakRain >= 40) {
      advisories.push(`<strong>${peakRain}%</strong> precip in delivery window.`);
    }

    const activeAlerts = (alerts?.features || [])
      .map(f => f?.properties)
      .filter(p => p && p.event)
      .sort((a, b) => {
        const rank = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };
        return (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9);
      })
      .slice(0, 5);

    const fmtExpires = (iso) => {
      try {
        const d = new Date(iso);
        const mins = Math.round((d - new Date()) / 60000);
        if (mins <= 0) return "expired";
        if (mins < 60) return `expires in ${mins}m`;
        const h = Math.floor(mins / 60), m = mins % 60;
        if (h < 24) return `expires in ${h}h${m ? ` ${m}m` : ""}`;
        const days = Math.floor(h / 24);
        return `expires in ${days}d`;
      } catch { return ""; }
    };

    const alertHtml = activeAlerts.length === 0
      ? ""
      : `<div style="display:flex;flex-direction:column;gap:5px;margin-top:8px;padding:6px 8px;background:rgba(229,62,62,.06);border-left:2px solid var(--red);border-radius:3px">
          <div class="task-eyebrow" style="margin-bottom:1px">${activeAlerts.length} active alert${activeAlerts.length > 1 ? "s" : ""}</div>
          ${activeAlerts.map(a => {
            const sev = a.severity === "Extreme" ? "var(--red)" : a.severity === "Severe" ? "var(--red)" : a.severity === "Moderate" ? "var(--amber)" : "var(--text-muted)";
            const exp = a.expires ? ` <span style="color:var(--text-subtle);font-weight:400">· ${escapeHtml(fmtExpires(a.expires))}</span>` : "";
            return `<div style="font-size:var(--fs-xs);color:${sev};line-height:1.35"><strong>${escapeHtml(a.event || "Alert")}</strong>${a.headline ? ` — ${escapeHtml(a.headline.slice(0, 130))}` : ""}${exp}</div>`;
          }).join("")}
        </div>`;

    const advisoryHtml = advisories.length === 0
      ? ""
      : `<div style="margin-top:8px"><div class="task-eyebrow" style="margin-bottom:3px">Driver advisory</div>
          ${advisories.map(a => `<div style="font-size:var(--fs-xs);color:var(--text);line-height:1.4;margin:1px 0">• ${a}</div>`).join("")}
        </div>`;

    const nowWind = parseInt(String(now.windSpeed || "").match(/(\d+)/)?.[1] || "0", 10);
    const nowDir = now.windDirection || "";

    // Live observation conversions
    const cToF = (c) => c == null ? null : Math.round(c * 9/5 + 32);
    const kphToMph = (k) => k == null ? null : Math.round(k * 0.621371);
    const paToInHg = (p) => p == null ? null : (p * 0.0002953).toFixed(2);
    const mToMi = (m) => m == null ? null : (m / 1609.344).toFixed(1);
    const obsTempF = obs ? cToF(obs.temperature?.value) : null;
    const obsHumidity = obs ? Math.round(obs.relativeHumidity?.value ?? -1) : -1;
    const obsGustMph = obs ? kphToMph(obs.windGust?.value) : null;
    const obsPressureInHg = obs ? paToInHg(obs.barometricPressure?.value) : null;
    const obsVisibilityMi = obs ? mToMi(obs.visibility?.value) : null;
    const obsTimestamp = obs?.timestamp || null;

    // Hourly humidity for index 0 (right now-ish) for "feels like" fallback
    const h0 = hourlyPeriods[0] || {};
    const rhNow = obsHumidity > 0 ? obsHumidity : (h0.relativeHumidity?.value ?? null);
    const tNow = obsTempF != null ? obsTempF : now.temperature;
    const windNow = obsGustMph != null ? obsGustMph : nowWind;

    // Heat index (Rothfusz) — valid when T >= 80°F and RH >= 40
    const heatIndex = (T, RH) => {
      if (T < 80 || RH < 40) return null;
      const HI = -42.379 + 2.04901523*T + 10.14333127*RH - 0.22475541*T*RH
                - 0.00683783*T*T - 0.05481717*RH*RH + 0.00122874*T*T*RH
                + 0.00085282*T*RH*RH - 0.00000199*T*T*RH*RH;
      return Math.round(HI);
    };
    // Wind chill — valid when T <= 50°F and V >= 3 mph
    const windChill = (T, V) => {
      if (T > 50 || V < 3) return null;
      const WC = 35.74 + 0.6215*T - 35.75*Math.pow(V, 0.16) + 0.4275*T*Math.pow(V, 0.16);
      return Math.round(WC);
    };
    let feelsLike = null;
    let feelsKind = "";
    if (rhNow != null) {
      const hi = heatIndex(tNow, rhNow);
      if (hi != null && hi !== tNow) { feelsLike = hi; feelsKind = "Feels like"; }
    }
    if (feelsLike == null) {
      const wc = windChill(tNow, windNow);
      if (wc != null && wc !== tNow) { feelsLike = wc; feelsKind = "Feels like"; }
    }

    // Heat-index advisory (highest takes priority of existing peakTemp checks)
    if (feelsLike != null && feelsLike >= 100 && peakTemp < 95) {
      advisories.unshift(`Heat index <strong>${feelsLike}°F</strong> right now — push hydration breaks, watch for heat stress.`);
    }

    // Sunrise/sunset (display in browser local time)
    const fmtTime = (iso) => {
      try {
        const d = new Date(iso);
        return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase().replace(" ", "");
      } catch { return ""; }
    };
    const sunLine = sun
      ? (() => {
          const sr = fmtTime(sun.sunrise);
          const ss = fmtTime(sun.sunset);
          // Headlight cutoff context — civil twilight end
          const ct = fmtTime(sun.civil_twilight_end);
          const now = new Date();
          const sunsetD = new Date(sun.sunset);
          const minsToSunset = Math.round((sunsetD - now) / 60000);
          let cutoffNote = "";
          if (minsToSunset > 0 && minsToSunset < 180) {
            cutoffNote = ` · <strong style="color:var(--amber)">${minsToSunset >= 60 ? Math.floor(minsToSunset/60)+"h " : ""}${minsToSunset%60}m to sunset</strong>`;
          }
          return `<div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">☀ Sunrise <strong style="color:var(--text)">${sr}</strong> · Sunset <strong style="color:var(--text)">${ss}</strong>${ct ? ` · Headlights ${ct}` : ""}${cutoffNote}</div>`;
        })()
      : "";

    // "Right now" detail line — humidity, gust, pressure, visibility
    const obsBits = [];
    if (rhNow != null && rhNow >= 0) obsBits.push(`Humidity <strong style="color:var(--text)">${rhNow}%</strong>`);
    if (obsGustMph && obsGustMph > nowWind) obsBits.push(`Gust <strong style="color:${obsGustMph >= 25 ? "var(--red)" : obsGustMph >= 18 ? "var(--amber)" : "var(--text)"}">${obsGustMph} mph</strong>`);
    if (obsPressureInHg) obsBits.push(`Pressure <strong style="color:var(--text)">${obsPressureInHg} inHg</strong>`);
    if (obsVisibilityMi && parseFloat(obsVisibilityMi) < 5) obsBits.push(`Vis <strong style="color:var(--amber)">${obsVisibilityMi} mi</strong>`);
    const obsLine = obsBits.length
      ? `<div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">${obsBits.join(" · ")}</div>`
      : "";

    const today    = dayPairs[0];
    const tomorrow = dayPairs[1];
    const dayLine = (d) => d
      ? `<div style="font-size:var(--fs-xs);color:var(--text-subtle);line-height:1.4">
           <strong style="color:var(--text)">${escapeHtml(d.label)}</strong>
           Hi <strong style="color:var(--text);font-variant-numeric:tabular-nums">${d.hi}°</strong>${d.lo!=null ? ` / Lo <strong style="color:var(--text);font-variant-numeric:tabular-nums">${d.lo}°</strong>` : ""}
           · ${escapeHtml(d.short || "")}${d.precip ? ` · <strong style="color:${precipColor(d.precip)}">${d.precip}%</strong>` : ""}
         </div>`
      : "";

    // 7-day at-a-glance
    const weeklyHtml = dayPairs.slice(0, 7).map((d, idx) => {
      const wd = idx === 0 ? "Today" : (() => {
        try { return new Date(d.startTime).toLocaleDateString([], { weekday: "short" }); }
        catch { return d.label.slice(0, 3); }
      })();
      const summary = (d.short || "").slice(0, 18);
      return `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 6px;border-radius:5px;min-width:62px;background:var(--canvas)">
        <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em">${escapeHtml(wd)}</div>
        <div style="display:flex;align-items:baseline;gap:3px">
          <span style="font-size:var(--fs-md);font-weight:700;color:${tempColor(d.hi)};font-variant-numeric:tabular-nums;line-height:1">${d.hi}°</span>
          ${d.lo!=null ? `<span style="font-size:var(--fs-xs);color:var(--text-subtle);font-variant-numeric:tabular-nums">${d.lo}°</span>` : ""}
        </div>
        <div style="font-size:9px;color:var(--text-subtle);text-align:center;line-height:1.15;max-width:72px">${escapeHtml(summary)}</div>
        ${d.precip ? `<div style="font-size:9px;font-weight:600;color:${precipColor(d.precip)};line-height:1">${d.precip}%</div>` : `<div style="height:9px"></div>`}
      </div>`;
    }).join("");

    body.innerHTML = `
      <div class="task-eyebrow" style="margin-bottom:2px">Weather${locName ? ` · ${escapeHtml(locName)}` : ""}${obsTimestamp ? ` · obs ${fmtTime(obsTimestamp)}` : ""}</div>
      <div style="display:flex;align-items:baseline;gap:10px;margin-top:2px;flex-wrap:wrap">
        <div style="font-size:26px;font-weight:700;color:var(--text);letter-spacing:-.02em;line-height:1;font-variant-numeric:tabular-nums">${tNow}°F</div>
        <div style="font-size:var(--fs-sm);color:var(--text);line-height:1.3;font-weight:600">${escapeHtml(now.shortForecast || "")}</div>
        ${feelsLike != null ? `<div style="font-size:var(--fs-xs);color:${feelsLike >= 100 ? "var(--red)" : feelsLike >= 90 ? "var(--amber)" : feelsLike <= 20 ? "#5b8def" : "var(--text-subtle)"};font-weight:600">${feelsKind} <span style="font-variant-numeric:tabular-nums">${feelsLike}°F</span></div>` : ""}
      </div>
      <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">
        ${nowWind ? `Wind ${nowWind} mph${nowDir ? ` ${escapeHtml(nowDir)}` : ""}` : ""}${peakRain ? `${nowWind ? " · " : ""}${peakRain}% peak precip next 14h` : ""}
      </div>
      ${obsLine}
      ${sunLine}
      <div class="task-eyebrow" style="margin-top:10px;margin-bottom:4px">Next 14 hours</div>
      <div style="display:flex;gap:3px;overflow-x:auto;padding-bottom:2px">${hourlyHtml}</div>
      <div class="task-eyebrow" style="margin-top:10px;margin-bottom:4px">7-day outlook</div>
      <div style="display:flex;gap:4px;overflow-x:auto;padding-bottom:2px">${weeklyHtml}</div>
      <div style="margin-top:8px;display:flex;flex-direction:column;gap:3px">
        ${dayLine(today)}
        ${dayLine(tomorrow)}
      </div>
      ${advisoryHtml}
      ${alertHtml}`;

    // Snapshot today's weather to weather_snapshots so we can correlate
    // attendance / scorecard slips with weather later. Idempotent: same
    // (dsp_id, date) just upserts the freshest values.
    try {
      const dspId = window.RR?.dsp?.id;
      if (dspId && today) {
        const todayIso = fmtIsoDate(new Date());
        const conditions = (() => {
          const s = (today.short || "").toLowerCase();
          if (s.includes("snow"))      return "snow";
          if (s.includes("thunder"))   return "thunderstorm";
          if (s.includes("rain") || s.includes("shower")) return "rain";
          if (s.includes("cloud"))     return "cloudy";
          if (s.includes("sun") || s.includes("clear"))   return "sunny";
          return s.split(" ")[0] || null;
        })();
        const alertsJson = activeAlerts.map(a => ({
          event: a.event, severity: a.severity, headline: a.headline, expires: a.expires,
        }));
        await sb.from("weather_snapshots").upsert({
          dsp_id: dspId,
          date: todayIso,
          high_temp_f: today.hi ?? null,
          low_temp_f:  today.lo ?? null,
          precip_pct:  today.precip ?? null,
          peak_wind_mph: peakWindMph || null,
          conditions,
          alerts: alertsJson,
          source: "nws",
        }, { onConflict: "dsp_id,date" });
      }
    } catch (e) {
      // Don't break the card if storage fails (e.g. table missing).
      console.warn("weather snapshot save:", e);
    }
  } catch (err) {
    console.warn("weather load failed:", err);
    const isOutsideUS = String(err.message || "").includes("404");
    const detail = isOutsideUS
      ? `Saved coords <strong>${lat}, ${lon}</strong> aren't covered by NWS (US only). Common cause: longitude sign flipped — west of the prime meridian should be negative (e.g. <strong>-76.910</strong>).`
      : `Could not load forecast (${escapeHtml(err.message || String(err))}). Saved: <strong>${lat}, ${lon}</strong>.`;
    body.innerHTML = `<div class="task-eyebrow" style="margin-bottom:2px">Weather · station forecast</div>
      <div style="font-size:var(--fs-md);color:var(--text-subtle);line-height:1.5">${detail}</div>`;
  }
}

// ─── Dashboard · Live radar (RainViewer + Leaflet + 2hr drive overlay) ─

let _weatherRadarState = null;
let _weatherRadarRefreshTimer = null;

function _ensureLeaflet() {
  if (window.L) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-rr-leaflet]')) {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      css.crossOrigin = '';
      css.dataset.rrLeaflet = '1';
      document.head.appendChild(css);
    }
    const existing = document.querySelector('script[data-rr-leaflet]');
    if (existing) {
      const wait = setInterval(() => {
        if (window.L) { clearInterval(wait); resolve(); }
      }, 50);
      setTimeout(() => { clearInterval(wait); if (!window.L) reject(new Error('leaflet timeout')); }, 10000);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.crossOrigin = '';
    script.dataset.rrLeaflet = '1';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('leaflet load failed'));
    document.head.appendChild(script);
  });
}

async function loadWeatherRadar() {
  const card = document.getElementById('rr-weather-radar-card');
  if (!card) return;
  const meta = window.RR?.dsp?.metadata?.weather || {};
  const showRadar = meta.show_radar !== false;
  const lat = Number(meta.lat);
  const lon = Number(meta.lon);
  if (!showRadar || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    card.style.display = 'none';
    // Free up the map + animation timers when the operator turns radar off.
    if (_weatherRadarState?.timer) clearInterval(_weatherRadarState.timer);
    if (_weatherRadarState?.map) { _weatherRadarState.map.remove(); }
    if (_weatherRadarRefreshTimer) { clearInterval(_weatherRadarRefreshTimer); _weatherRadarRefreshTimer = null; }
    _weatherRadarState = null;
    return;
  }
  card.style.display = 'flex';

  try { await _ensureLeaflet(); } catch (e) { console.warn('leaflet load:', e); return; }

  const mapEl = document.getElementById('rr-radar-map');
  if (!mapEl) return;

  // First-time map setup
  if (!_weatherRadarState || !_weatherRadarState.map) {
    // Initial view at zoom 7 (~150mi span) so OSM tiles request immediately;
    // fitBounds in the layout-ready callback below tightens to the 2hr ring.
    const map = L.map(mapEl, {
      center: [lat, lon],
      zoom: 7,
      zoomControl: true,
      scrollWheelZoom: false,
      attributionControl: false,
      minZoom: 5,
      maxZoom: 11,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      crossOrigin: true,
    }).addTo(map);

    L.circleMarker([lat, lon], {
      radius: 6, color: '#fff', weight: 2, fillColor: '#e53e3e', fillOpacity: 1,
    }).addTo(map).bindTooltip('Station', { permanent: false });

    // 2hr drive ring (~120 mi at typical highway speeds)
    const ring = L.circle([lat, lon], {
      radius: 193121, color: '#0F6CBD', weight: 1.5, dashArray: '6 4',
      fillColor: '#0F6CBD', fillOpacity: 0.04,
    }).addTo(map).bindTooltip('2hr drive zone (~120 mi)', { permanent: false });

    _weatherRadarState = {
      map, frames: [], currentIdx: 0, layers: new Map(),
      playing: true, timer: null, host: '', pastCount: 0, color: 2, ring,
    };

    // Wait for layout to settle, then fit to the ring + padding so the
    // operator sees the full coverage zone with a buffer for incoming weather.
    requestAnimationFrame(() => {
      map.invalidateSize();
      try { map.fitBounds(ring.getBounds().pad(0.15)); } catch (e) { /* fallback to initial view */ }
    });
  }

  // Refresh frame catalog
  try {
    const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
    if (!res.ok) throw new Error(`rainviewer HTTP ${res.status}`);
    const data = await res.json();
    const past    = data.radar?.past || [];
    const nowcast = data.radar?.nowcast || [];
    const frames  = [...past, ...nowcast];
    if (!frames.length) return;

    const s = _weatherRadarState;
    // Drop stale layers from previous fetch
    for (const layer of s.layers.values()) s.map.removeLayer(layer);
    s.layers.clear();
    s.frames = frames;
    s.host   = data.host;
    s.pastCount = past.length;

    // Set scrubber max
    const scrub = document.getElementById('rr-radar-scrub');
    if (scrub) {
      scrub.max = String(frames.length - 1);
      scrub.value = String(past.length - 1);
    }

    setRadarFrame(past.length - 1);

    // Restart auto-play
    if (s.timer) clearInterval(s.timer);
    s.playing = true;
    const playBtn = document.getElementById('rr-radar-playpause');
    if (playBtn) playBtn.textContent = '⏸';
    s.timer = setInterval(() => {
      if (!s.playing) return;
      const next = (s.currentIdx + 1) % s.frames.length;
      setRadarFrame(next);
    }, 700);
  } catch (e) {
    console.warn('radar fetch:', e);
  }

  // Auto-refresh frame catalog every 5 min
  if (!_weatherRadarRefreshTimer) {
    _weatherRadarRefreshTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (!document.getElementById('rr-radar-map')) return;
      loadWeatherRadar();
    }, 5 * 60 * 1000);
  }
}

function setRadarFrame(idx) {
  const s = _weatherRadarState;
  if (!s || !s.frames[idx]) return;

  if (!s.layers.has(idx)) {
    const f = s.frames[idx];
    // 512px tiles cover the full zoom range we use; 256px versions return
    // "Zoom Level Not Supported" tiles for some color/smooth/snow combos.
    const url = `${s.host}${f.path}/512/{z}/{x}/{y}/${s.color}/1_1.png`;
    const layer = L.tileLayer(url, { opacity: 0, tileSize: 512, zoomOffset: -1, zIndex: 100 + idx });
    layer.addTo(s.map);
    s.layers.set(idx, layer);
  }

  for (const [i, layer] of s.layers.entries()) {
    layer.setOpacity(i === idx ? 0.7 : 0);
  }

  s.currentIdx = idx;

  const tl = document.getElementById('rr-radar-timeline');
  if (tl) {
    const f = s.frames[idx];
    const t = new Date(f.time * 1000);
    const isLast = idx === s.pastCount - 1;
    const isPast = idx < s.pastCount;
    const offsetMin = Math.round((t.getTime() - Date.now()) / 60000);
    const label = isLast ? 'Now' : (isPast ? `${offsetMin}m` : `+${offsetMin}m`);
    const time = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const color = isPast ? (isLast ? 'var(--text)' : 'var(--text-subtle)') : 'var(--accent-text)';
    tl.style.color = color;
    tl.textContent = `${label} · ${time}`;
  }

  const scrub = document.getElementById('rr-radar-scrub');
  if (scrub && parseInt(scrub.value, 10) !== idx) scrub.value = String(idx);
}

// Radar controls — play/pause, scrub, color scheme
document.addEventListener('click', (e) => {
  if (e.target.closest('#rr-radar-playpause')) {
    if (!_weatherRadarState) return;
    _weatherRadarState.playing = !_weatherRadarState.playing;
    const btn = document.getElementById('rr-radar-playpause');
    if (btn) btn.textContent = _weatherRadarState.playing ? '⏸' : '▶';
  }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'rr-radar-scrub') {
    if (!_weatherRadarState) return;
    _weatherRadarState.playing = false;
    const btn = document.getElementById('rr-radar-playpause');
    if (btn) btn.textContent = '▶';
    setRadarFrame(parseInt(e.target.value, 10));
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'rr-radar-style') {
    if (!_weatherRadarState) return;
    _weatherRadarState.color = parseInt(e.target.value, 10) || 2;
    // Drop cached layers so new color takes effect
    for (const layer of _weatherRadarState.layers.values()) _weatherRadarState.map.removeLayer(layer);
    _weatherRadarState.layers.clear();
    setRadarFrame(_weatherRadarState.currentIdx);
  }
});

// Settings: Save station location → write to dsps.metadata.weather, refresh card.
document.addEventListener("click", async (e) => {
  if (!e.target.closest("#rr-set-weather-save")) return;
  e.preventDefault();
  const dspId = window.RR?.dsp?.id;
  const status = document.getElementById("rr-set-weather-status");
  const setStatus = (text, kind) => {
    if (!status) return;
    status.style.color = kind === "warn" ? "var(--red)" : kind === "ok" ? "var(--green)" : "var(--text-subtle)";
    status.textContent = text;
  };
  if (!dspId) { setStatus("DSP not loaded — refresh the page", "warn"); return; }

  const latRaw = (document.getElementById("rr-set-weather-lat")?.value || "").trim();
  const lonRaw = (document.getElementById("rr-set-weather-lon")?.value || "").trim();
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (latRaw === "" || lonRaw === "" || !Number.isFinite(lat) || !Number.isFinite(lon)
      || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    setStatus("Enter valid lat/lon (e.g. 38.886, -76.910)", "warn");
    return;
  }

  setStatus("Saving…");
  try {
    const { data: row, error: readErr } = await sb.from("dsps").select("metadata").eq("id", dspId).single();
    if (readErr) throw readErr;
    const meta = row?.metadata || {};
    const newMeta = { ...meta, weather: { ...(meta.weather || {}), lat, lon } };
    const { error: upErr } = await sb.from("dsps").update({ metadata: newMeta }).eq("id", dspId);
    if (upErr) throw upErr;
    if (window.RR?.dsp) window.RR.dsp.metadata = newMeta;
    setStatus(`Saved ✓ (${lat}, ${lon})`, "ok");
    setTimeout(() => setStatus(""), 4000);
    toast("Station location saved", "success");
    if (typeof loadDashboardWeather === "function") loadDashboardWeather();
  } catch (err) {
    console.error("weather save failed:", err);
    setStatus("Failed: " + (err.message || String(err)), "warn");
  }
});

// Pre-fill the settings inputs and show what's currently stored so the
// operator never has to guess whether their save took.
function _prefillWeatherInputs() {
  const meta = window.RR?.dsp?.metadata?.weather || {};
  const latEl = document.getElementById("rr-set-weather-lat");
  const lonEl = document.getElementById("rr-set-weather-lon");
  if (latEl && Number.isFinite(Number(meta.lat))) latEl.value = meta.lat;
  if (lonEl && Number.isFinite(Number(meta.lon))) lonEl.value = meta.lon;
  const status = document.getElementById("rr-set-weather-status");
  if (status && (Number.isFinite(Number(meta.lat)) || Number.isFinite(Number(meta.lon)))) {
    status.style.color = "var(--text-subtle)";
    status.textContent = `Currently saved: ${meta.lat}, ${meta.lon}`;
  }

  // DSP brand · prefill from the live record so the operator can edit it.
  const nameEl = document.getElementById("rr-set-dsp-name");
  const codeEl = document.getElementById("rr-set-dsp-code");
  const replyEl = document.getElementById("rr-set-dsp-reply-email");
  if (nameEl) nameEl.value = window.RR?.dsp?.name        || "";
  if (codeEl) codeEl.value = window.RR?.dsp?.short_code  || "";
  if (replyEl) replyEl.value = window.RR?.dsp?.metadata?.reply_to_email || "";
}

// Save DSP name → dsps.name, then refresh sidebar chip + page title.
document.addEventListener("click", async (e) => {
  if (!e.target.closest("#rr-set-dsp-name-save")) return;
  e.preventDefault();
  const dspId = window.RR?.dsp?.id;
  const input = document.getElementById("rr-set-dsp-name");
  if (!dspId || !input) return;
  const next = (input.value || "").trim();
  if (!next) { toast("DSP name can't be blank", "warn"); return; }
  try {
    const { error } = await sb.from("dsps").update({ name: next }).eq("id", dspId);
    if (error) throw error;
    window.RR.dsp.name = next;
    _paintWorkspaceChip();
    toast("DSP name saved", "success");
  } catch (err) {
    console.error("dsp name save:", err);
    toast("Save failed: " + (err.message || String(err)), "warn");
  }
});

// Save station code → dsps.short_code, then refresh sidebar chip.
document.addEventListener("click", async (e) => {
  if (!e.target.closest("#rr-set-dsp-code-save")) return;
  e.preventDefault();
  const dspId = window.RR?.dsp?.id;
  const input = document.getElementById("rr-set-dsp-code");
  if (!dspId || !input) return;
  const next = (input.value || "").trim().toUpperCase();
  if (!next) { toast("Station code can't be blank", "warn"); return; }
  try {
    const { error } = await sb.from("dsps").update({ short_code: next }).eq("id", dspId);
    if (error) throw error;
    window.RR.dsp.short_code = next;
    _paintWorkspaceChip();
    toast("Station code saved", "success");
  } catch (err) {
    console.error("station code save:", err);
    toast("Save failed: " + (err.message || String(err)), "warn");
  }
});

// Save reply email → dsps.metadata.reply_to_email. Used by send-email
// as the Reply-To header so applicant replies land in the operator's
// inbox instead of the platform support address.
document.addEventListener("click", async (e) => {
  if (!e.target.closest("#rr-set-dsp-reply-email-save")) return;
  e.preventDefault();
  const dspId = window.RR?.dsp?.id;
  const input = document.getElementById("rr-set-dsp-reply-email");
  if (!dspId || !input) return;
  const next = (input.value || "").trim();
  if (next && !next.includes("@")) { toast("Enter a valid email or leave blank", "warn"); return; }
  try {
    // Read-modify-write so we don't trample sibling metadata keys.
    const { data: row, error: rErr } = await sb.from("dsps").select("metadata").eq("id", dspId).single();
    if (rErr) throw rErr;
    const md = row?.metadata || {};
    if (next) md.reply_to_email = next;
    else delete md.reply_to_email;
    const { error } = await sb.from("dsps").update({ metadata: md }).eq("id", dspId);
    if (error) throw error;
    if (window.RR?.dsp) window.RR.dsp.metadata = md;
    toast(next ? "Reply email saved" : "Reply email cleared", "success");
  } catch (err) {
    console.error("reply email save:", err);
    toast("Save failed: " + (err.message || String(err)), "warn");
  }
});

// Note: the dashboard weather card / radar toggles were removed from
// Settings → Workspace. Lat/lng capture stays so the system can still
// log local weather every day for performance insights — that's done
// by the (separate) weather-tracking job, not by this UI.
document.addEventListener("click", (e) => {
  // Settings nav button (sidebar) or the Workspace section pill.
  if (e.target.closest('[data-rr-nav-item="settings"]') ||
      e.target.closest('a[href="#settings"]') ||
      e.target.closest('.settings-nav-item[data-set="workspace"]')) {
    setTimeout(_prefillWeatherInputs, 0);
  }
});
// Wrap the existing goto so navigating to settings also prefills.
const _legacyGotoForWeather = window.goto;
if (typeof _legacyGotoForWeather === "function") {
  window.goto = function (view) {
    const r = _legacyGotoForWeather(view);
    if (view === "settings") setTimeout(_prefillWeatherInputs, 0);
    return r;
  };
}


// ─── Dashboard · Today's tasks (Attendance card + header counts) ───────

async function loadDashboardTasks() {
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;
  const todayIso = fmtIsoDate(new Date());
  const weekStart = fmtIsoDate(startOfWeekMonday(new Date()));
  const weekEnd   = fmtIsoDate(addDays(new Date(weekStart + "T12:00:00"), 6));

  // Date eyebrow
  const eyebrow = document.getElementById("db-eyebrow");
  if (eyebrow) eyebrow.textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

  // Today's shifts: total, present (completed), pending (scheduled), and stations.
  const [shiftsRes, stationsRes, recentAbsentRes] = await Promise.all([
    sb.from("shifts")
      .select("id, status, driver_id, station_id, starts_at, ends_at")
      .eq("dsp_id", dspId)
      .eq("date", todayIso),
    sb.from("stations").select("code, active").eq("dsp_id", dspId).eq("active", true),
    // 30-day absences for the "callout patterns" pill.
    sb.from("shifts")
      .select("driver_id, status")
      .eq("dsp_id", dspId)
      .in("status", ["called_off", "no_show"])
      .gte("date", fmtIsoDate(addDays(new Date(), -30)))
      .lte("date", todayIso),
  ]);

  const shifts = shiftsRes.data || [];
  const stations = stationsRes.data || [];

  const total       = shifts.length;
  const checkedIn   = shifts.filter(sh => sh.status === "completed" || sh.status === "late").length;
  const callouts    = shifts.filter(sh => sh.status === "called_off" || sh.status === "no_show").length;
  const coverageNeeded = shifts.filter(sh => sh.status !== "called_off" && sh.status !== "no_show").length;
  const coveragePct = total === 0 ? 0 : Math.round(checkedIn / Math.max(1, coverageNeeded) * 100);

  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setText("dash-pip-checkin", checkedIn);
  setText("dash-pip-total", total);
  setText("dash-coverage", total === 0 ? "—" : `${coveragePct}%`);

  // Loadout = earliest scheduled start time today; stations comma-list.
  const earliest = shifts
    .filter(sh => sh.starts_at)
    .map(sh => new Date(sh.starts_at))
    .sort((a, b) => a - b)[0];
  const loadoutLabel = earliest
    ? `Loadout ${earliest.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
    : "No shifts today";
  const stationLabel = stations.length > 0 ? ` · ${stations.map(s => s.code).join(", ")}` : "";
  setText("dash-pip-meta", `${loadoutLabel}${stationLabel}`);

  // "Callout patterns" — drivers with 3+ callouts/no-shows in last 30 days.
  const absencesPerDriver = new Map();
  for (const sh of (recentAbsentRes.data || [])) {
    if (!sh.driver_id) continue;
    absencesPerDriver.set(sh.driver_id, (absencesPerDriver.get(sh.driver_id) || 0) + 1);
  }
  const flagged = Array.from(absencesPerDriver.values()).filter(n => n >= 3).length;
  const flagEl = document.getElementById("dash-pip-flag");
  const flagTextEl = document.getElementById("dash-pip-flag-text");
  if (flagEl && flagTextEl) {
    if (flagged > 0) {
      flagEl.style.display = "";
      flagTextEl.textContent = `${flagged} callout pattern${flagged === 1 ? "" : "s"} flagged`;
    } else {
      flagEl.style.display = "none";
    }
  }
}

async function loadCheckinView() {
  const list = document.querySelector("#view-checkin .checkin-list");
  if (!list) return;
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;
  const todayIso = fmtIsoDate(new Date());
  // Look 7 days ahead. If today has no assigned shifts, fall back to the
  // next day that does — operator on a Sunday wants to see Monday's roster
  // without manually navigating.
  const horizonIso = fmtIsoDate(addDays(new Date(), 7));

  const [driversRes, shiftsRes] = await Promise.all([
    sb.from("drivers")
      .select("id, full_name, first_name, last_name, preferred_name, phone, station:station_id (code), tier")
      .eq("dsp_id", dspId)
      .eq("status", "active"),
    sb.from("shifts")
      .select("id, driver_id, status, date")
      .eq("dsp_id", dspId)
      .gte("date", todayIso)
      .lte("date", horizonIso)
      .not("driver_id", "is", null)
      .order("date", { ascending: true }),
  ]);

  if (driversRes.error || shiftsRes.error) {
    console.warn("checkin load:", driversRes.error || shiftsRes.error);
    return;
  }
  const drivers = driversRes.data || [];
  const allShifts = shiftsRes.data  || [];

  // Pick target date: today if it has shifts, otherwise earliest day with any.
  const todayShifts = allShifts.filter(sh => sh.date === todayIso);
  const targetIso = todayShifts.length > 0
    ? todayIso
    : (allShifts[0]?.date || todayIso);
  const shifts = allShifts.filter(sh => sh.date === targetIso);

  const driverShift = new Map(); // driver_id -> shift row
  for (const sh of shifts) {
    if (sh.driver_id) driverShift.set(sh.driver_id, sh);
  }

  // Head sub line — note when we're showing a future date.
  const sub = document.querySelector("#view-checkin .page-sub");
  if (sub) {
    const expected = drivers.filter(d => driverShift.has(d.id)).length;
    const targetDate = new Date(targetIso + "T12:00:00");
    const dateLabel = targetDate.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    if (targetIso !== todayIso) {
      sub.textContent = `${dateLabel} · ${expected} drivers expected (no shifts scheduled today)`;
    } else {
      sub.textContent = `${dateLabel} · ${expected} drivers expected`;
    }
  }

  const rows = drivers
    .filter(d => driverShift.has(d.id))
    .map(d => {
      const display = displayDriverName(d);
      const initials = displayDriverInitials(d);
      const station = d.station?.code || "—";
      const tier = d.tier ? `tier-${String(d.tier).toLowerCase()}` : "";
      const sh = driverShift.get(d.id);
      const ciKey = _STATUS_TO_CI[sh.status]; // present / late / callout / noshow / undefined
      const markedClass = ciKey ? ` marked marked-${ciKey === "callout" ? "callout" : ciKey === "noshow" ? "noshow" : ciKey}` : "";
      const btn = (key, title, svg) => {
        const active = ciKey === key ? " active" : "";
        return `<button type="button" class="status-btn s-${key}${active}" data-rr-ci-shift="${sh.id}" data-rr-ci-status="${key}" title="${title}">${svg}</button>`;
      };
      return `<div class="checkin-row${markedClass}" data-name="${escapeHtml(initials)}">
        <div class="checkin-driver">
          <div class="avatar-sm ${tier}">${initials}</div>
          <div>
            <div class="checkin-driver-name" data-rr-driver-id="${d.id}">${escapeHtml(display)}</div>
            <div class="checkin-driver-meta">${escapeHtml(d.phone || "")}</div>
          </div>
        </div>
        <div class="checkin-station">${escapeHtml(station)}</div>
        <div class="status-row">
          ${btn("present", "Present", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>')}
          ${btn("late",    "Late",    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>')}
          ${btn("callout", "Callout", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>')}
          ${btn("noshow",  "No-show", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>')}
          ${btn("vto",     "VTO · Voluntary Time Off (operator-granted, no points)", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg>')}
        </div>
      </div>`;
    });

  list.innerHTML = rows.length === 0
    ? `<div class="rr-empty-inline">No shifts scheduled for today.</div>`
    : rows.join("");

  _updateCheckinProgress();
}

function _updateCheckinProgress() {
  const list = document.querySelector("#view-checkin .checkin-list");
  if (!list) return;
  const total = list.querySelectorAll(".checkin-row").length;
  const marked = list.querySelectorAll(".checkin-row.marked").length;
  const pct = total > 0 ? Math.round(marked / total * 100) : 0;
  const fill = document.getElementById("ci-progress");
  if (fill) fill.style.width = `${pct}%`;
  const m = document.getElementById("ci-marked");
  if (m) m.textContent = String(marked);
  const meta = document.querySelector("#view-checkin .checkin-progress-meta span:first-child");
  if (meta) meta.textContent = `${marked} of ${total} marked`;
}

// Click handler: write the status to public.shifts and toggle UI.
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-rr-ci-shift][data-rr-ci-status]");
  if (!btn) return;
  e.preventDefault();
  const shiftId = btn.dataset.rrCiShift;
  const ciKey   = btn.dataset.rrCiStatus;
  const newStatus = _CI_TO_STATUS[ciKey];
  if (!shiftId || !newStatus) return;

  const row = btn.closest(".checkin-row");
  const { error } = await sb.from("shifts").update({ status: newStatus }).eq("id", shiftId);
  if (error) { toast("Save failed: " + error.message, "warn"); return; }

  // Visual: clear sibling active states, mark row, add active to clicked.
  if (row) {
    row.classList.remove("marked-present", "marked-late", "marked-callout", "marked-noshow", "marked-vto");
    row.classList.add("marked", `marked-${ciKey === "noshow" ? "noshow" : ciKey === "callout" ? "callout" : ciKey === "vto" ? "vto" : ciKey}`);
    row.querySelectorAll(".status-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
  }
  _updateCheckinProgress();
  // Refresh the live Attendance Report (it queries shifts by status) so
  // the tally updates without a full nav. Shifts isn't in the realtime
  // channel, so we trigger the refresh here.
  if (typeof loadAttendanceLive === "function") loadAttendanceLive();
});


// ─── Drivers · Attendance · Policy + Event log ──────────────────────────

const _ATT_DEFAULT_POLICY = {
  policy_enabled: true,
  decay_days: 90,
  // What counts as one occurrence.  Most DSPs don't count tardies as
  // an "occurrence" but do count callouts and no-shows.
  count_tardy:    false,
  count_callout:  true,
  count_noshow:   true,
  threshold_warn:   3,
  threshold_action: 6,
  // Auto-escalations.  ncns_terminates triggers a Termination
  // recommendation on the very first NCNS, regardless of count.
  ncns_terminates: false,
  // Coaching is a progressive ladder by definition: each qualifying
  // occurrence in the rolling window steps the driver up one rung
  // (Verbal → Written → Final → Termination). No on/off knob.
  // Auto-coaching: master toggle + per-level toggles. When the master
  // is ON and the per-level toggle for the recommended action is also
  // ON, hitting Approve on the daily tool fires the coaching record
  // and posts an in-app message to the driver immediately. Levels
  // not auto-fired drop into the coaching drawer for the leader to
  // finalize. Termination is never auto — a leader always confirms.
  auto_coaching:    false,
  auto_verbal:      false,
  auto_written:     false,
  auto_final:       false,
  // Per-severity delivery requirement — what the driver must do in
  // the RouteReady app to clear an auto-fired coaching of that
  // level.  Surfaces as the default in the manual Send-coaching
  // modal too, so dispatchers don't reset it every time.
  delivery_verbal:      "ack",
  delivery_written:     "ack_and_sign",
  delivery_final:       "ack_and_sign",
  delivery_termination: "ack_and_sign",
  // First-30-days strict rule: any callout/no-show inside the
  // probationary window jumps the driver straight to Action.
  first_30_strict: false,
  first_30_window_days: 30,
};

function _getAttPolicy() {
  const p = window.RR?.dsp?.metadata?.attendance?.policy || {};
  // Translate legacy records (points-mode, the old progressive_coaching
  // toggle, multi-action side effects) into the current shape.  The
  // ladder is now always progressive and "auto-fire on a level"
  // implies a single side effect (in-app driver message).
  const merged = { ..._ATT_DEFAULT_POLICY, ...p };
  delete merged.mode;
  delete merged.points_per_tardy;
  delete merged.points_per_callout;
  delete merged.points_per_noshow;
  delete merged.progressive_coaching;
  delete merged.auto_coaching_actions;
  return merged;
}

// _evalPolicy — walk the blocks-style policy and produce a clean
// normalized object the rest of the dashboard reads from.  Migration
// 0086 backfills `blocks` for every existing tenant; new tenants get
// blocks the first time the policy builder saves.  When `blocks` is
// missing or empty (defensive), we fall back to the legacy fields so
// nothing breaks during the rollout.
//
// Output shape:
//   {
//     enabled: bool,
//     auto_coaching: bool,
//     decay_days: int,
//     events: { callout?: { points }, no_show?: { points }, late?: { points } },
//     ladder: [{ severity, threshold, delivery, auto_fire }, ...],   // sorted by threshold asc
//     ncns_terminates: bool,
//     first_30:        { active: bool, days: int },
//   }
function _evalPolicy() {
  const p   = window.RR?.dsp?.metadata?.attendance?.policy || {};
  const out = {
    enabled:         p.policy_enabled !== false,
    auto_coaching:   !!p.auto_coaching,
    decay_days:      90,
    events:          {},
    ladder:          [],
    ncns_terminates: false,
    first_30:        { active: false, days: 30 },
  };
  const blocks = Array.isArray(p.blocks) ? p.blocks : [];
  if (blocks.length === 0) {
    // Fallback to legacy fields — should only matter on a tenant that
    // somehow missed the 0086 backfill.  The Report still renders.
    const legacy = _getAttPolicy();
    out.decay_days      = legacy.decay_days || 90;
    if (legacy.count_callout) out.events.callout = { points: 1 };
    if (legacy.count_noshow)  out.events.no_show = { points: 1 };
    if (legacy.count_tardy)   out.events.late    = { points: 1 };
    const warn = Math.max(1, legacy.threshold_warn || 1);
    out.ladder = [
      { severity: "verbal",      threshold: warn,     delivery: legacy.delivery_verbal      || "ack",          auto_fire: !!legacy.auto_verbal },
      { severity: "written",     threshold: warn + 1, delivery: legacy.delivery_written     || "ack_and_sign", auto_fire: !!legacy.auto_written },
      { severity: "final",       threshold: warn + 2, delivery: legacy.delivery_final       || "ack_and_sign", auto_fire: !!legacy.auto_final },
      { severity: "termination", threshold: warn + 3, delivery: legacy.delivery_termination || "ack_and_sign", auto_fire: false },
    ];
    out.ncns_terminates = !!legacy.ncns_terminates;
    out.first_30        = { active: !!legacy.first_30_strict, days: legacy.first_30_window_days || 30 };
    return out;
  }
  for (const b of blocks) {
    if (!b || !b.type) continue;
    if (b.type === "window") {
      out.decay_days = Number(b.days) > 0 ? Number(b.days) : 90;
    } else if (b.type === "event") {
      const k = b.kind;
      if (k === "callout" || k === "no_show" || k === "late") {
        out.events[k] = { points: Number(b.points) || 0 };
      }
    } else if (b.type === "ladder_rung") {
      out.ladder.push({
        severity:  b.severity || "verbal",
        threshold: Number(b.threshold) || 0,
        delivery:  b.delivery  || "ack",
        auto_fire: b.severity === "termination" ? false : !!b.auto_fire,
      });
    } else if (b.type === "auto_escalation") {
      if (b.kind === "ncns_terminates")  out.ncns_terminates = true;
      if (b.kind === "first_30_strict")  out.first_30 = { active: true, days: Number(b.days) || 30 };
    }
    // recovery / others: ignored for now (Tier 2 scope)
  }
  // Ladder sorted ascending by threshold so "highest rung whose
  // threshold ≤ points" is just a linear walk.
  out.ladder.sort((a, b) => a.threshold - b.threshold);
  return out;
}

// Find the ladder rung a driver currently sits at, given accumulated
// points.  Returns null when the driver is below the lowest rung
// (Clear) or when the policy has no ladder rungs.
function _evalLadderRung(eval_, points) {
  let rung = null;
  for (const r of (eval_.ladder || [])) {
    if (points >= r.threshold) rung = r;
    else break;
  }
  return rung;
}

// ─── Attendance policy editor · structured form ────────────────────
// Same data model as the previous drag-and-drop builder (blocks
// array on dsps.metadata.attendance.policy), different UX: a normal
// settings page that reads top-to-bottom.  All flexibility preserved
// — variable rung count, custom point values per event, per-rung
// threshold/delivery/auto-fire — without the empty-canvas / drag-
// blocks ceremony.
const _RR_SEVERITY_OPTIONS = [
  { value: "verbal",      label: "Verbal" },
  { value: "written",     label: "Written" },
  { value: "final",       label: "Final" },
  { value: "termination", label: "Termination" },
];
const _RR_DELIVERY_OPTIONS = [
  { value: "none",         label: "Read only · no action required" },
  { value: "ack",          label: "Acknowledge" },
  { value: "sign",         label: "Sign" },
  { value: "ack_and_sign", label: "Acknowledge & sign" },
];

// Working state for the editor (mutated as the operator types).
const _polState = {
  master: { policy_enabled: true, auto_coaching: false },
  window_days: 90,
  events: [
    { kind: "callout", enabled: true,  points: 1 },
    { kind: "no_show", enabled: true,  points: 1 },
    { kind: "late",    enabled: false, points: 0.5 },
  ],
  ladder: [],
  ncns_terminates: false,
  first_30: { active: false, days: 30 },
  timing:   { tardy_grace_minutes: 10, ncns_after_minutes: 60 },
};

function _newRungId() {
  return "rung_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Convert dsps.metadata.attendance.policy.blocks into the editor's
// state shape.  Falls back to legacy fields when blocks aren't there.
function _polStateFromMeta(meta) {
  const p = meta?.attendance?.policy || {};
  const blocks = Array.isArray(p.blocks) ? p.blocks : [];

  const out = {
    master: {
      policy_enabled: p.policy_enabled !== false,
      auto_coaching:  !!p.auto_coaching,
    },
    window_days: 90,
    events: [
      { kind: "callout", enabled: false, points: 1 },
      { kind: "no_show", enabled: false, points: 1 },
      { kind: "late",    enabled: false, points: 0.5 },
    ],
    ladder: [],
    ncns_terminates: false,
    first_30: { active: false, days: 30 },
  };

  for (const b of blocks) {
    if (!b || !b.type) continue;
    if (b.type === "window") out.window_days = Number(b.days) || 90;
    else if (b.type === "event") {
      const ev = out.events.find(e => e.kind === b.kind);
      if (ev) { ev.enabled = true; ev.points = Number(b.points) || 0; }
    }
    else if (b.type === "ladder_rung") {
      out.ladder.push({
        id:        _newRungId(),
        severity:  b.severity || "verbal",
        threshold: Number(b.threshold) || 0,
        delivery:  b.delivery  || "ack",
        auto_fire: b.severity === "termination" ? false : !!b.auto_fire,
      });
    }
    else if (b.type === "auto_escalation") {
      if (b.kind === "ncns_terminates") out.ncns_terminates = true;
      if (b.kind === "first_30_strict") out.first_30 = { active: true, days: Number(b.days) || 30 };
    }
  }
  out.ladder.sort((a, b) => a.threshold - b.threshold);
  return out;
}

// Convert editor state back into the blocks array.
function _polStateToBlocks(s) {
  const blocks = [];
  blocks.push({ id: "blk_window_" + Date.now(), type: "window", days: Number(s.window_days) || 90 });
  for (const ev of (s.events || [])) {
    if (!ev.enabled) continue;
    blocks.push({ id: "blk_evt_" + ev.kind, type: "event", kind: ev.kind, points: Number(ev.points) || 0 });
  }
  for (const r of (s.ladder || [])) {
    blocks.push({
      id:        "blk_rung_" + r.id,
      type:      "ladder_rung",
      severity:  r.severity,
      threshold: Number(r.threshold) || 0,
      delivery:  r.delivery,
      auto_fire: r.severity === "termination" ? false : !!r.auto_fire,
    });
  }
  if (s.ncns_terminates) {
    blocks.push({ id: "blk_esc_ncns", type: "auto_escalation", kind: "ncns_terminates" });
  }
  if (s.first_30 && s.first_30.active) {
    blocks.push({ id: "blk_esc_first30", type: "auto_escalation", kind: "first_30_strict", days: Number(s.first_30.days) || 30 });
  }
  return blocks;
}

async function loadAttendancePolicy() {
  const pane = document.getElementById("att-pane-policy");
  if (!pane) return;
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;

  const [{ data: dspRow, error: dspErr }, { data: setRow }] = await Promise.all([
    sb.from("dsps").select("metadata").eq("id", dspId).single(),
    sb.from("scheduling_settings")
      .select("checkin_lead_minutes, tardy_grace_minutes, ncns_after_minutes")
      .eq("dsp_id", dspId).is("week_start", null).maybeSingle(),
  ]);
  if (dspErr) { console.warn("policy load:", dspErr.message); return; }
  const meta = dspRow?.metadata || {};
  if (window.RR?.dsp) window.RR.dsp.metadata = meta;

  const fromMeta = _polStateFromMeta(meta);
  Object.assign(_polState, fromMeta);
  _polState.timing = {
    tardy_grace_minutes: setRow?.tardy_grace_minutes ?? 10,
    ncns_after_minutes:  setRow?.ncns_after_minutes  ?? 60,
  };

  _renderPolicyEditor();
  _wirePolicyEditor();
}

function _renderPolicyEditor() {
  const pane = document.getElementById("att-pane-policy");
  if (!pane) return;
  const s = _polState;

  const evRow = (kind, label) => {
    const ev = s.events.find(e => e.kind === kind) || { enabled: false, points: 0 };
    return `
      <label class="rr-pol-evrow">
        <input type="checkbox" data-rr-pol-event="${kind}" ${ev.enabled ? "checked" : ""}/>
        <span class="rr-pol-evlabel">${escapeHtml(label)}</span>
        <span class="rr-pol-evpoints">worth
          <input type="number" min="0" max="20" step="0.5" data-rr-pol-event-points="${kind}" value="${Number(ev.points) || 0}" ${ev.enabled ? "" : "disabled"}/>
          point(s) each
        </span>
      </label>`;
  };

  const rungRow = (r, idx) => {
    const sevOpts = _RR_SEVERITY_OPTIONS.map(o => `<option value="${o.value}" ${r.severity === o.value ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("");
    const delOpts = _RR_DELIVERY_OPTIONS.map(o => `<option value="${o.value}" ${r.delivery === o.value ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("");
    const autoLocked = r.severity === "termination";
    return `
      <div class="rr-pol-rung" data-rr-pol-rung="${escapeHtml(r.id)}">
        <div class="rr-pol-rung-head">
          <select data-rr-pol-rung-prop="severity">${sevOpts}</select>
          <span class="rr-pol-rung-sep">at</span>
          <input type="number" min="0" step="0.5" data-rr-pol-rung-prop="threshold" value="${Number(r.threshold) || 0}" />
          <span class="rr-pol-rung-sep">pt</span>
          <button type="button" class="rr-pol-rung-remove" data-rr-pol-rung-remove="${escapeHtml(r.id)}" aria-label="Remove level">×</button>
        </div>
        <label class="rr-pol-rung-toggle">
          <input type="checkbox" data-rr-pol-rung-prop="auto_fire" ${r.auto_fire && !autoLocked ? "checked" : ""} ${autoLocked ? "disabled" : ""}/>
          <span>${autoLocked ? "Auto-fire (always manual for Termination)" : "Auto-fire on Approve"}</span>
        </label>
        <label class="rr-pol-rung-delivery">
          <span>Driver must:</span>
          <select data-rr-pol-rung-prop="delivery">${delOpts}</select>
        </label>
      </div>`;
  };

  pane.innerHTML = `
    <div class="pol-section" style="display:flex;align-items:center;gap:14px">
      <span style="flex:1">
        <h3 class="pol-section-title">Attendance policy</h3>
        <p class="pol-section-sub" style="margin:0">When ON, the dashboard scores every driver against the rules below. When OFF, attendance is logged but not flagged or coached.</p>
      </span>
      <label class="toggle">
        <input type="checkbox" id="rr-pol-master-enabled" ${s.master.policy_enabled ? "checked" : ""}/>
        <span class="toggle-slider"></span>
      </label>
    </div>

    <div class="pol-section">
      <h3 class="pol-section-title">Window</h3>
      <p class="pol-section-sub">How far back the Report and the ladder look for events.</p>
      <label class="rr-pol-row">
        <span>Track events from the last</span>
        <input type="number" min="1" max="365" step="1" id="rr-pol-window" value="${Number(s.window_days) || 90}"/>
        <span>days</span>
      </label>
    </div>

    <div class="pol-section">
      <h3 class="pol-section-title">What I count</h3>
      <p class="pol-section-sub">Pick which events accumulate points toward the ladder, and how much each is worth.</p>
      ${evRow("callout", "Callout")}
      ${evRow("no_show", "No-show")}
      ${evRow("late",    "Late")}
    </div>

    <div class="pol-section">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:10px">
        <span style="flex:1">
          <h3 class="pol-section-title" style="margin:0">Coaching ladder</h3>
          <p class="pol-section-sub" style="margin:2px 0 0">Each level fires when accumulated points cross its threshold.</p>
        </span>
        <span style="display:flex;align-items:center;gap:8px;font-size:var(--fs-sm);color:var(--text-muted)">
          Auto-coach
          <label class="toggle">
            <input type="checkbox" id="rr-pol-master-auto" ${s.master.auto_coaching ? "checked" : ""}/>
            <span class="toggle-slider"></span>
          </label>
        </span>
      </div>
      <div id="rr-pol-rungs" class="rr-pol-rungs">
        ${(s.ladder || []).map(rungRow).join("")}
        ${(s.ladder || []).length === 0 ? `<div class="rr-pol-empty-rungs">No coaching levels yet. Click <strong>+ Add a level</strong> below to start.</div>` : ""}
      </div>
      <button type="button" class="btn btn-sm" id="rr-pol-add-rung" style="margin-top:10px">+ Add a level</button>
    </div>

    <div class="pol-section">
      <h3 class="pol-section-title">Auto-escalations</h3>
      <p class="pol-section-sub">Optional rules that bypass the normal threshold ladder for severe events.</p>
      <label class="rr-pol-toggle-row">
        <input type="checkbox" id="rr-pol-ncns" ${s.ncns_terminates ? "checked" : ""}/>
        <span><strong>First NCNS = Termination</strong> · any no-call no-show triggers a Termination recommendation regardless of points.</span>
      </label>
      <label class="rr-pol-toggle-row">
        <input type="checkbox" id="rr-pol-first30" ${s.first_30.active ? "checked" : ""}/>
        <span><strong>First-30-days strict</strong> · any callout / no-show inside the probation window jumps to the highest rung.</span>
      </label>
      <label class="rr-pol-row" style="margin-top:6px;${s.first_30.active ? "" : "opacity:.55"}">
        <span>Probation window</span>
        <input type="number" min="7" max="120" step="1" id="rr-pol-first30-days" value="${Number(s.first_30.days) || 30}" ${s.first_30.active ? "" : "disabled"}/>
        <span>days</span>
      </label>
    </div>

    <div class="pol-section">
      <h3 class="pol-section-title">Tardy &amp; NCNS timing</h3>
      <p class="pol-section-sub">When the daily approvals card flags a driver Tardy or No-call no-show.</p>
      <label class="rr-pol-row">
        <span>Tardy after</span>
        <input type="number" min="0" max="120" step="1" id="rr-pol-tardy" value="${Number(s.timing.tardy_grace_minutes) || 0}"/>
        <span>min after shift start</span>
      </label>
      <label class="rr-pol-row">
        <span>NCNS after</span>
        <input type="number" min="30" max="240" step="30" id="rr-pol-ncns-min" value="${Number(s.timing.ncns_after_minutes) || 0}"/>
        <span>min after shift start</span>
      </label>
    </div>

    <div style="display:flex;align-items:center;gap:10px;margin-top:6px">
      <button class="btn btn-primary" type="button" id="rr-pol-save">Save policy</button>
      <span id="rr-pol-status" style="font-size:var(--fs-sm);color:var(--text-subtle)"></span>
    </div>`;
}

function _wirePolicyEditor() {
  const pane = document.getElementById("att-pane-policy");
  if (!pane || pane.dataset.rrWired === "1") return;
  pane.dataset.rrWired = "1";

  // Two-way binding for the simple top-level fields.
  pane.addEventListener("input", (e) => {
    const t = e.target;
    if (t.id === "rr-pol-window")        _polState.window_days = Number(t.value);
    if (t.id === "rr-pol-first30-days")  _polState.first_30.days = Number(t.value);
    if (t.id === "rr-pol-tardy")         _polState.timing.tardy_grace_minutes = Number(t.value);
    if (t.id === "rr-pol-ncns-min")      _polState.timing.ncns_after_minutes  = Number(t.value);

    // Event point input.
    const evPts = t.dataset?.rrPolEventPoints;
    if (evPts) {
      const ev = _polState.events.find(e => e.kind === evPts);
      if (ev) ev.points = Number(t.value);
    }

    // Rung props (severity / threshold / delivery / auto_fire).
    const rungEl = t.closest && t.closest("[data-rr-pol-rung]");
    const propKey = t.dataset?.rrPolRungProp;
    if (rungEl && propKey) {
      const id = rungEl.getAttribute("data-rr-pol-rung");
      const r  = _polState.ladder.find(x => x.id === id);
      if (r) {
        if (propKey === "auto_fire")  r.auto_fire = !!t.checked;
        else if (propKey === "threshold") r.threshold = Number(t.value);
        else r[propKey] = t.value;
      }
    }
  });

  pane.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "rr-pol-master-enabled") _polState.master.policy_enabled = !!t.checked;
    if (t.id === "rr-pol-master-auto")    _polState.master.auto_coaching  = !!t.checked;
    if (t.id === "rr-pol-ncns")           _polState.ncns_terminates       = !!t.checked;
    if (t.id === "rr-pol-first30") {
      _polState.first_30.active = !!t.checked;
      // Toggle the days-input enabled state by re-rendering the row's
      // enabled/disabled state.  Light re-render: just walk the input.
      const daysEl = pane.querySelector("#rr-pol-first30-days");
      const wrap   = daysEl ? daysEl.closest("label") : null;
      if (daysEl) daysEl.disabled = !t.checked;
      if (wrap)   wrap.style.opacity = t.checked ? "" : ".55";
    }
    // Event enabled toggle.
    const evK = t.dataset?.rrPolEvent;
    if (evK) {
      const ev = _polState.events.find(e => e.kind === evK);
      if (ev) {
        ev.enabled = !!t.checked;
        const ptsEl = pane.querySelector(`[data-rr-pol-event-points="${evK}"]`);
        if (ptsEl) ptsEl.disabled = !t.checked;
      }
    }
    // Rung severity changing — termination flips auto_fire off.
    const rungEl = t.closest && t.closest("[data-rr-pol-rung]");
    if (rungEl && t.dataset?.rrPolRungProp === "severity") {
      const id = rungEl.getAttribute("data-rr-pol-rung");
      const r  = _polState.ladder.find(x => x.id === id);
      if (r && r.severity === "termination") r.auto_fire = false;
      _renderPolicyEditor();
    }
  });

  pane.addEventListener("click", async (e) => {
    // Add a level.
    if (e.target.id === "rr-pol-add-rung") {
      e.preventDefault();
      const next = _polState.ladder.length;
      const nextThreshold = _polState.ladder.length > 0
        ? Number(_polState.ladder[_polState.ladder.length - 1].threshold) + 1
        : 1;
      const sevSeq = ["verbal","written","final","termination"];
      _polState.ladder.push({
        id:        _newRungId(),
        severity:  sevSeq[Math.min(next, 3)],
        threshold: nextThreshold,
        delivery:  "ack",
        auto_fire: false,
      });
      _renderPolicyEditor();
      return;
    }
    // Remove a level.
    const rm = e.target.closest && e.target.closest("[data-rr-pol-rung-remove]");
    if (rm) {
      e.preventDefault();
      const id = rm.getAttribute("data-rr-pol-rung-remove");
      _polState.ladder = _polState.ladder.filter(r => r.id !== id);
      _renderPolicyEditor();
      return;
    }
    // Save.
    if (e.target.id === "rr-pol-save") {
      e.preventDefault();
      const dspId = window.RR?.dsp?.id;
      if (!dspId) return;
      const status = document.getElementById("rr-pol-status");
      if (status) { status.style.color = "var(--text-subtle)"; status.textContent = "Saving…"; }

      const newPolicy = {
        policy_enabled: _polState.master.policy_enabled,
        auto_coaching:  _polState.master.auto_coaching,
        blocks:         _polStateToBlocks(_polState),
      };

      const { data: row } = await sb.from("dsps").select("metadata").eq("id", dspId).single();
      const meta = row?.metadata || {};
      const newMeta = { ...meta, attendance: { ...(meta.attendance || {}), policy: newPolicy } };
      const { error: upErr } = await sb.from("dsps").update({ metadata: newMeta }).eq("id", dspId);
      if (upErr) { if (status) { status.style.color = "var(--red)"; status.textContent = "Failed: " + upErr.message; } return; }
      if (window.RR?.dsp) window.RR.dsp.metadata = newMeta;

      // Timing.
      const timing = {};
      if (Number.isFinite(_polState.timing.tardy_grace_minutes)) timing.tardy_grace_minutes = _polState.timing.tardy_grace_minutes;
      if (Number.isFinite(_polState.timing.ncns_after_minutes))  timing.ncns_after_minutes  = _polState.timing.ncns_after_minutes;
      if (Object.keys(timing).length > 0) {
        const { data: existing } = await sb.from("scheduling_settings")
          .select("id").eq("dsp_id", dspId).is("week_start", null).maybeSingle();
        if (existing?.id) {
          const { error: setErr } = await sb.from("scheduling_settings")
            .update(timing).eq("id", existing.id);
          if (setErr) console.warn("timing save:", setErr.message);
        } else {
          const { error: insErr } = await sb.from("scheduling_settings")
            .insert([{ dsp_id: dspId, week_start: null, ...timing }]);
          if (insErr) console.warn("timing insert:", insErr.message);
        }
      }

      if (status) { status.style.color = "var(--green)"; status.textContent = "Saved ✓"; setTimeout(() => status.textContent = "", 2500); }
      toast("Attendance policy saved", "success");
      if (typeof _rrApplyAttPolicyMode === "function") _rrApplyAttPolicyMode();
      if (typeof loadAttendanceLive === "function") loadAttendanceLive();
      if (typeof loadAttendanceEventLog === "function") loadAttendanceEventLog();
    }
  });
}



// Time-period the Event log shows.  Independent of the policy
// decay window — operators may want to inspect "all time" while
// running a 90-day policy, or 7 days while running a 365-day
// policy.  Stored on the function so re-render preserves the
// selection without rewiring the dropdown.
let _attLogWindowDays = 90;  // default

async function loadAttendanceEventLog() {
  const pane = document.getElementById("att-pane-log");
  if (!pane) return;
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;

  const policy = _getAttPolicy();
  const policyOn = policy.policy_enabled !== false;

  // "all" is sentinel for no lower bound.
  const isAll = _attLogWindowDays === "all";
  const since = isAll ? null : (() => { const d = new Date(); d.setDate(d.getDate() - Number(_attLogWindowDays)); return d; })();
  const sinceIso = since ? fmtIsoDate(since) : null;

  let shiftsQ = sb.from("shifts")
    .select("id, date, status, driver_id")
    .eq("dsp_id", dspId)
    .in("status", ["called_off", "no_show", "late"])
    .order("date", { ascending: false });
  if (sinceIso) shiftsQ = shiftsQ.gte("date", sinceIso);

  let coachQ = sb.from("coachings")
    .select("id, severity, triggering_shift_id, occurred_at, acknowledged_at, signed_at")
    .eq("dsp_id", dspId)
    .eq("topic", "attendance")
    .eq("driver_visible", true)
    .not("triggering_shift_id", "is", null)
    .is("archived_at", null)
    .order("occurred_at", { ascending: false });
  if (since) coachQ = coachQ.gte("occurred_at", since.toISOString());

  const [shiftsRes, driversRes, coachRes] = await Promise.all([
    shiftsQ,
    sb.from("drivers")
      .select("id, full_name, first_name, last_name, preferred_name, station:station_id (code), tier")
      .eq("dsp_id", dspId),
    coachQ,
  ]);

  if (shiftsRes.error || driversRes.error) {
    console.warn("event log load:", shiftsRes.error || driversRes.error);
    return;
  }

  const drvById = new Map((driversRes.data || []).map(d => [d.id, d]));
  const events = (shiftsRes.data || []).filter(sh => sh.driver_id);

  // Most recent coaching per triggering shift — drives the ✓ Coached
  // chip when the dispatcher has already addressed an event.
  const coachByShift = new Map();
  for (const c of (coachRes?.data || [])) {
    if (!coachByShift.has(c.triggering_shift_id)) coachByShift.set(c.triggering_shift_id, c);
  }

  const countEl = document.getElementById("att-log-count");
  if (countEl) countEl.textContent = String(events.length);

  // Per-driver totals — gives the dispatcher their own counting
  // signal to act on when the policy is off.
  const totalsByDriver = new Map();
  for (const ev of events) {
    if (!ev.driver_id) continue;
    totalsByDriver.set(ev.driver_id, (totalsByDriver.get(ev.driver_id) || 0) + 1);
  }
  const repeatCount = Array.from(totalsByDriver.values()).filter(n => n >= 2).length;

  const windowOpts = [
    [7, "Last 7 days"], [30, "Last 30 days"], [90, "Last 90 days"],
    [365, "Last 12 months"], ["all", "All time"],
  ].map(([v, lbl]) => `<option value="${v}" ${String(_attLogWindowDays) === String(v) ? "selected" : ""}>${escapeHtml(lbl)}</option>`).join("");

  // Filter bar — time-period selector + summary chip.  Always
  // rendered even when there are 0 events so the operator can
  // widen the window to find some.
  const filterBar = `
    <div class="toolbar" style="margin-bottom:var(--s-3)">
      <div class="toolbar-left" style="display:flex;align-items:center;gap:10px">
        <label style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Window</label>
        <select id="rr-att-log-window" class="form-input" style="height:auto;padding:6px 10px">${windowOpts}</select>
        <span style="font-size:var(--fs-sm);color:var(--text-subtle)">
          <strong style="color:var(--text)">${events.length}</strong> event${events.length === 1 ? "" : "s"} ·
          <strong style="color:var(--text)">${totalsByDriver.size}</strong> driver${totalsByDriver.size === 1 ? "" : "s"}
          ${repeatCount > 0 ? ` · <strong style="color:var(--amber)">${repeatCount}</strong> with 2+ events` : ""}
        </span>
      </div>
    </div>`;

  if (events.length === 0) {
    pane.innerHTML = `${filterBar}<div class="rr-empty-inline">No callouts, no-shows, or late events in this window.</div>`;
    _wireAttLogWindow();
    return;
  }

  const eventLabel = { called_off: "Callout", no_show: "No-show", late: "Late" };
  const eventColor = { called_off: "var(--amber)", no_show: "var(--red)", late: "var(--text-muted)" };

  // Action column: Send-coaching button when policy is OFF (the
  // operator owns next steps from the log itself).  When policy
  // is ON, coaching flows exclusively through the Report — the
  // log stays neutral / passive so it doesn't compete with the
  // Report for the same decision.
  const actionHeader = policyOn ? "" : "<th></th>";

  pane.innerHTML = `${filterBar}
    <div class="table-wrap"><table class="table">
      <thead><tr>
        <th>Date</th><th>Driver</th><th>Station</th><th>Event</th>
        <th style="text-align:right" title="Driver's count of attendance events in this window">In window</th>
        <th>Coaching</th>${actionHeader}
      </tr></thead>
      <tbody>
        ${events.map(ev => {
          const d = drvById.get(ev.driver_id);
          const display = d ? displayDriverName(d) : "—";
          const station = d?.station?.code || "—";
          const initials = d ? displayDriverInitials(d) : "?";
          const tier = d?.tier ? `tier-${String(d.tier).toLowerCase()}` : "";
          const driverTotal = totalsByDriver.get(ev.driver_id) || 1;

          const c = coachByShift.get(ev.id);
          let coachCell;
          if (c) {
            const sevLabel = (_COACHING_SEV_LABEL && _COACHING_SEV_LABEL[c.severity]) || c.severity;
            const ackState = c.acknowledged_at ? (c.signed_at ? "Signed" : "Acknowledged") : "Awaiting ack";
            const chipCls  = ackState === "Awaiting ack" ? "pending" : "done";
            coachCell = `<div style="display:flex;flex-direction:column;gap:2px;align-items:flex-start"><span style="font-size:var(--fs-sm);font-weight:600">${escapeHtml(sevLabel)} <span style="color:var(--text-subtle);font-weight:500">· ${escapeHtml(_relTimeAgo(c.occurred_at))}</span></span><span class="att-coach-chip ${chipCls}">✓ ${escapeHtml(ackState)}</span></div>`;
          } else {
            coachCell = `<span style="color:var(--text-subtle)">—</span>`;
          }

          let actionCell = "";
          if (!policyOn) {
            const sendBtn = c
              ? `<button class="btn btn-sm btn-ghost" type="button" data-rr-coach-event="${escapeHtml(ev.id || "")}" data-rr-coach-driver="${escapeHtml(d?.id || ev.driver_id || "")}" data-rr-coach-driver-name="${escapeHtml(display)}" data-rr-coach-event-label="${escapeHtml(eventLabel[ev.status] || ev.status)}" data-rr-coach-event-date="${escapeHtml(ev.date)}" title="Already coached. Send another only if needed.">Send another</button>`
              : `<button class="btn btn-sm" type="button" data-rr-coach-event="${escapeHtml(ev.id || "")}" data-rr-coach-driver="${escapeHtml(d?.id || ev.driver_id || "")}" data-rr-coach-driver-name="${escapeHtml(display)}" data-rr-coach-event-label="${escapeHtml(eventLabel[ev.status] || ev.status)}" data-rr-coach-event-date="${escapeHtml(ev.date)}">Send coaching</button>`;
            actionCell = `<td style="text-align:right">${sendBtn}</td>`;
          }

          return `<tr>
            <td>${new Date(ev.date + "T12:00:00").toLocaleDateString()}</td>
            <td><div class="cell-driver"><div class="avatar-sm ${tier}">${initials}</div><div><div class="cell-name" data-rr-driver-id="${d?.id || ev.driver_id || ""}">${escapeHtml(display)}</div></div></div></td>
            <td>${escapeHtml(station)}</td>
            <td><span style="color:${eventColor[ev.status]};font-weight:600">${eventLabel[ev.status]}</span></td>
            <td style="text-align:right;font-weight:600;color:${driverTotal >= 2 ? "var(--amber)" : "var(--text)"}">${driverTotal}</td>
            <td>${coachCell}</td>
            ${actionCell}
          </tr>`;
        }).join("")}
      </tbody>
    </table></div>`;
  _wireAttLogWindow();
}

function _wireAttLogWindow() {
  const sel = document.getElementById("rr-att-log-window");
  if (!sel) return;
  sel.addEventListener("change", () => {
    const v = sel.value;
    _attLogWindowDays = (v === "all") ? "all" : Number(v);
    loadAttendanceEventLog();
  });
}

// ─── Send coaching modal — Event log entry point ────────────────────
//
// Phase 1 path: dispatcher fires a coaching ad-hoc from a single
// attendance event.  Severity choices include 'note' (no ladder
// advancement) since this surface is for the policy-OFF / soft-touch
// case.  delivery_required is per-coaching here — when the policy
// is ON, the Report path will pull severity defaults from policy
// settings instead.
let _coachCtx = null;

document.addEventListener("click", (e) => {
  // Event log row → soft-touch path (severity defaults to Verbal,
  // the Note option is available because policy may be off).
  const evBtn = e.target.closest("[data-rr-coach-event]");
  if (evBtn) {
    e.preventDefault();
    e.stopImmediatePropagation();
    _coachCtx = {
      source:      "event_log",
      event_id:    evBtn.getAttribute("data-rr-coach-event") || null,
      driver_id:   evBtn.getAttribute("data-rr-coach-driver"),
      driver_name: evBtn.getAttribute("data-rr-coach-driver-name") || "Driver",
      event_label: evBtn.getAttribute("data-rr-coach-event-label") || "Event",
      event_date:  evBtn.getAttribute("data-rr-coach-event-date") || "",
      topic:       "attendance",
    };
    _openSendCoachingModal(_coachCtx);
    return;
  }
  // Attendance Report row → ladder-aware path.  Severity comes from
  // the row's coaching label; delivery default comes from the matching
  // Ladder rung block in the new policy.
  const repBtn = e.target.closest("[data-rr-coach-report]");
  if (repBtn) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const sev = repBtn.getAttribute("data-rr-coach-severity") || "verbal";
    const evalP = _evalPolicy();
    const rung  = (evalP.ladder || []).find(r => r.severity === sev);
    const delDefault = rung?.delivery || "ack";
    _coachCtx = {
      source:           "report",
      driver_id:        repBtn.getAttribute("data-rr-coach-driver"),
      driver_name:      repBtn.getAttribute("data-rr-coach-driver-name") || "Driver",
      severity:         sev,
      delivery_default: delDefault,
      summary:          repBtn.getAttribute("data-rr-coach-summary") || "",
      points:           repBtn.getAttribute("data-rr-coach-points") || "0",
      occ:              repBtn.getAttribute("data-rr-coach-occ")    || "0",
      callouts:         repBtn.getAttribute("data-rr-coach-callouts") || "0",
      noshows:          repBtn.getAttribute("data-rr-coach-noshows")  || "0",
      late:             repBtn.getAttribute("data-rr-coach-late")     || "0",
      topic:            "attendance",
    };
    _openSendCoachingModal(_coachCtx);
  }
});

function _openSendCoachingModal(ctx) {
  let m = document.getElementById("rr-send-coach-modal");
  if (m) m.remove();
  m = document.createElement("div");
  m.id = "rr-send-coach-modal";
  m.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px";

  const fromReport  = ctx.source === "report";
  const dateStr     = ctx.event_date ? new Date(ctx.event_date + "T12:00:00").toLocaleDateString() : "";
  const subtitle    = fromReport
    ? `${escapeHtml(ctx.driver_name)} · ladder · ${escapeHtml(ctx.points)} pts · ${escapeHtml(ctx.occ)} occurrences`
    : `${escapeHtml(ctx.driver_name)} · ${escapeHtml(ctx.event_label || "")}${dateStr ? " · " + escapeHtml(dateStr) : ""}`;
  const sevDefault  = ctx.severity || "verbal";
  const delDefault  = ctx.delivery_default || "ack";
  const summaryVal  = fromReport
    ? (ctx.summary || `Attendance · ${ctx.driver_name}`)
    : `${ctx.event_label || ""}${dateStr ? " on " + dateStr : ""}`;
  const notesPrefill = fromReport
    ? `Over the last 90 days you've had ${ctx.callouts} callout${ctx.callouts === "1" ? "" : "s"}, ${ctx.noshows} no-show${ctx.noshows === "1" ? "" : "s"}, and ${ctx.late} late arrival${ctx.late === "1" ? "" : "s"} (${ctx.points} points · ${ctx.occ} occurrences). Let's talk about how to get back on track.`
    : "";

  // Note severity is hidden when launched from the Report — that path
  // is for ladder-tracking, and Note doesn't advance the ladder.
  const noteOption = fromReport ? "" : `<option value="note">Note · informational, no ladder advancement</option>`;

  const sel = (v) => v === sevDefault ? "selected" : "";
  const dsel = (v) => v === delDefault ? "selected" : "";

  m.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;width:520px;max-width:100%;max-height:90vh;overflow-y:auto;padding:22px 24px;box-shadow:var(--shadow-lg)">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px">
        <div>
          <div style="font-size:var(--fs-lg);font-weight:700;color:var(--text);letter-spacing:-.005em">Send coaching</div>
          <div style="font-size:var(--fs-sm);color:var(--text-subtle);margin-top:2px">${subtitle}</div>
        </div>
        <button type="button" id="rr-coach-close" style="background:none;border:0;font-size:var(--fs-xl);cursor:pointer;color:var(--text-muted);padding:0 4px;line-height:1">×</button>
      </div>

      <label style="display:block;font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px">Severity${fromReport ? ' <span style="color:var(--accent);font-weight:600;text-transform:none;letter-spacing:0">· ladder recommendation</span>' : ''}</label>
      <select id="rr-coach-sev" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--canvas);color:var(--text);font-size:var(--fs-md);margin-bottom:14px">
        ${noteOption}
        <option value="verbal"      ${sel("verbal")}>Verbal · soft warning</option>
        <option value="written"     ${sel("written")}>Written · documented warning</option>
        <option value="final"       ${sel("final")}>Final · last warning before termination</option>
        <option value="termination" ${sel("termination")}>Termination · separation</option>
      </select>

      <label style="display:block;font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px">Driver must${fromReport ? ' <span style="color:var(--accent);font-weight:600;text-transform:none;letter-spacing:0">· policy default</span>' : ''}</label>
      <select id="rr-coach-delivery" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--canvas);color:var(--text);font-size:var(--fs-md);margin-bottom:14px">
        <option value="none"         ${dsel("none")}>Read only · no action required</option>
        <option value="ack"          ${dsel("ack")}>Acknowledge · tap "I understand"</option>
        <option value="sign"         ${dsel("sign")}>Sign · capture signature</option>
        <option value="ack_and_sign" ${dsel("ack_and_sign")}>Acknowledge &amp; sign</option>
      </select>

      <label style="display:block;font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px">Headline</label>
      <input type="text" id="rr-coach-summary" placeholder="One-line summary the driver sees first" value="${escapeHtml(summaryVal)}" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--canvas);color:var(--text);font-size:var(--fs-md);margin-bottom:14px"/>

      <label style="display:block;font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px">Message</label>
      <textarea id="rr-coach-notes" rows="5" placeholder="What you'd like the driver to know" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--canvas);color:var(--text);font-size:var(--fs-md);font-family:inherit;line-height:1.5;resize:vertical">${escapeHtml(notesPrefill)}</textarea>

      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
        <button type="button" class="btn" id="rr-coach-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="rr-coach-send">Send to driver</button>
      </div>
    </div>`;
  document.body.appendChild(m);

  const close = () => { m.remove(); _coachCtx = null; };
  m.addEventListener("click", (e) => { if (e.target === m) close(); });
  document.getElementById("rr-coach-close").addEventListener("click", close);
  document.getElementById("rr-coach-cancel").addEventListener("click", close);

  document.getElementById("rr-coach-send").addEventListener("click", async () => {
    const sev      = document.getElementById("rr-coach-sev").value;
    const delivery = document.getElementById("rr-coach-delivery").value;
    const summary  = document.getElementById("rr-coach-summary").value.trim();
    const notes    = document.getElementById("rr-coach-notes").value.trim();
    if (!summary && !notes) { toast("Add a headline or message", "warn"); return; }
    const sendBtn = document.getElementById("rr-coach-send");
    sendBtn.disabled = true; sendBtn.textContent = "Sending…";
    const payload = {
      driver_id:           ctx.driver_id,
      topic:               ctx.topic || "attendance",
      severity:            sev,
      delivery_required:   delivery,
      summary,
      notes,
      triggering_shift_id: ctx.event_id || null,
      incident_date:       ctx.event_date || null,
    };
    const { error } = await sb.rpc("send_coaching", { p_payload: payload });
    if (error) {
      sendBtn.disabled = false; sendBtn.textContent = "Send to driver";
      toast("Send failed: " + error.message, "warn");
      return;
    }
    toast("Coaching sent to " + ctx.driver_name, "success");
    close();
    // Refresh whichever surface launched the modal so the operator
    // sees their action reflected immediately.
    if (ctx.source === "report" && typeof loadAttendanceLive === "function") loadAttendanceLive();
    else if (typeof loadAttendanceEventLog === "function")                   loadAttendanceEventLog();
  });
}

// Hook attTab — operator clicks Report / Policy / Log inside the
// Drivers → Attendance subview. The mockup defines window.attTab on
// load; wrap it so we can also fire our live loaders.
const _legacyAttTab = window.attTab;
window.attTab = function (name) {
  // Always close the report's KPI drilldown when switching tabs so a
  // panel left open before doesn't reappear when the operator comes
  // back to the Report tab.
  if (typeof _closeAttKpiDetail === "function") _closeAttKpiDetail();
  // Redirect any lingering "today" call to history — the Today pane was
  // moved to the sidebar Today's Plan page.
  if (name === "today") name = "history";
  // Policy builder lives in Settings → Attendance policy now.  If
  // anything still triggers attTab('policy'), bounce the operator to
  // the new home instead of rendering nothing.
  if (name === "policy") {
    if (typeof window.goto === "function") window.goto("settings");
    setTimeout(() => {
      const btn = document.querySelector('.settings-nav-item[data-set="attendance"]');
      if (btn) btn.click();
    }, 50);
    return;
  }
  if (typeof _legacyAttTab === "function") _legacyAttTab(name);
  if (name === "report")  loadAttendanceLive();
  if (name === "log")     loadAttendanceEventLog();
};

// Hide / show the right tab based on the attendance policy state.
// One surface per mode:
//   • Policy OFF → Event log only.  Operator coaches manually per
//                  event from the log.
//   • Policy ON  → Report only.  Same data, packaged per-driver
//                  with points + ladder.  The Event log would just
//                  be a redundant chronological view of the same
//                  shifts the Report already aggregates.
function _rrApplyAttPolicyMode() {
  const policy   = (typeof _getAttPolicy === "function") ? _getAttPolicy() : {};
  const isOn     = policy.policy_enabled !== false;
  const reportTab  = document.querySelector('#rr-att-tabstrip [data-att="report"]');
  const reportPane = document.getElementById("att-pane-report");
  const logTab     = document.querySelector('#rr-att-tabstrip [data-att="log"]');
  const logPane    = document.getElementById("att-pane-log");
  if (!reportTab || !logTab) return;

  if (isOn) {
    // Report visible, Event log hidden.  If the Event log was active
    // when the policy got turned on, flip the active tab + pane to
    // Report so the operator isn't staring at a hidden surface.
    reportTab.style.display = "";
    logTab.style.display    = "none";
    if (logTab.classList.contains("active")) {
      logTab.classList.remove("active");
      reportTab.classList.add("active");
      if (logPane)    logPane.classList.remove("active");
      if (reportPane) reportPane.classList.add("active");
      loadAttendanceLive();
    }
  } else {
    // Event log visible, Report hidden.  Flip active to Event log
    // when needed for the same reason.
    reportTab.style.display = "none";
    logTab.style.display    = "";
    if (reportTab.classList.contains("active")) {
      reportTab.classList.remove("active");
      logTab.classList.add("active");
      if (reportPane) reportPane.classList.remove("active");
      if (logPane)    logPane.classList.add("active");
      loadAttendanceEventLog();
    }
  }
}

// Load the right data when the operator opens a settings section
// that's hosted by JS rather than baked into the HTML mockup.
document.addEventListener("click", (e) => {
  if (e.target.closest('.settings-nav-item[data-set="attendance"]')) {
    setTimeout(() => loadAttendancePolicy(), 0);
  }
  if (e.target.closest('.settings-nav-item[data-set="availability"]')) {
    setTimeout(() => loadAvailabilityRequests(), 0);
  }
  if (e.target.closest('.settings-nav-item[data-set="team"]')) {
    setTimeout(() => loadTeamMembers(), 0);
  }
  // Screening / Messages / Referrals were moved here from the Pipeline
  // subnav. Each section reuses the loader that previously fired on the
  // pipeSub click — same DOM ids inside the section, no other changes.
  if (e.target.closest('.settings-nav-item[data-set="screening-questions"]')) {
    setTimeout(() => loadScreeningQuestionsList(), 0);
  }
  if (e.target.closest('.settings-nav-item[data-set="hiring-messages"]')) {
    setTimeout(() => loadMessagesTab(), 0);
  }
  if (e.target.closest('.settings-nav-item[data-set="referrals"]')) {
    setTimeout(() => loadReferralsTab(), 0);
  }
});

// ─── Settings · Team ─────────────────────────────────────────────────────
//
// Hydrates the Team section with live app_users rows for the caller's
// DSP, and wires the "Invite team member" button to a modal that calls
// the invite-team-member edge function.

async function loadTeamMembers() {
  const list = document.getElementById("rr-team-list");
  if (!list) return;
  const dspId  = window.RR?.dsp?.id;
  const meId   = window.RR?.user?.id;
  const meRole = window.RR?.user?.role;
  const isOwner = meRole === "owner";
  if (!dspId) { list.innerHTML = `<div class="rr-empty-inline">No DSP context</div>`; return; }

  list.innerHTML = `<div class="rr-loading">Loading team</div>`;
  const { data, error } = await sb
    .from("app_users")
    .select("id, email, full_name, role, active, allowed_pages, created_at")
    .eq("dsp_id", dspId)
    .eq("active", true)
    .order("role", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    list.innerHTML = `<div class="rr-empty-inline" style="color:var(--red)">${escapeHtml(error.message)}</div>`;
    return;
  }
  const rows = data || [];
  if (rows.length === 0) {
    list.innerHTML = `<div class="rr-empty-inline">No team members yet — use the button below to send the first invite.</div>`;
    return;
  }
  const initialsOf = (s) => (s || "?").split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  const ageDays = (iso) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
  const ageLabel = (iso) => {
    const d = ageDays(iso);
    if (d === 0)  return "added today";
    if (d === 1)  return "added 1 day ago";
    if (d < 30)   return `added ${d} days ago`;
    if (d < 365)  return `added ${Math.floor(d / 30)} mo ago`;
    return `added ${Math.floor(d / 365)} y ago`;
  };
  // Top-level pages — keys must match data-view on .nav-item buttons
  // and the keys passed to goto(). Settings is always visible to
  // everyone (otherwise a restricted user has no way back to here),
  // so it isn't togglable.
  const PAGES = [
    { key: "dashboard", label: "Today" },
    { key: "pipeline",  label: "Hiring Pipeline" },
    { key: "drivers",   label: "Drivers" },
    { key: "staffing",  label: "Performance" },
    { key: "fleet",     label: "Fleet" },
    { key: "schedule",  label: "Schedule" },
    { key: "messages",  label: "Messages" },
    { key: "forms",     label: "Workflows" },
    { key: "finances",  label: "Finances" },
  ];
  list.innerHTML = rows.map(r => {
    const isMe   = r.id === meId;
    const initials = initialsOf(r.full_name || r.email);
    const sub = isMe ? `${r.email} · you` : `${r.email} · ${ageLabel(r.created_at)}`;
    const roleOpts = ["owner","ops","dispatcher"].map(opt =>
      `<option value="${opt}" ${opt === r.role ? "selected" : ""}>${opt.charAt(0).toUpperCase() + opt.slice(1)}</option>`
    ).join("");
    // Editable name input — anyone can edit their own; owners can
    // edit anyone's. The DB has matching policies (self-name update +
    // owner-write).
    const canEditName = isMe || isOwner;
    // Page permissions only togglable by owner, only on non-owner rows
    // (owners always see everything), and only on non-self rows.
    const canTogglePages = isOwner && !isMe && r.role !== "owner";
    const allowed = Array.isArray(r.allowed_pages) ? r.allowed_pages : null;
    const restrictedCount = allowed ? PAGES.filter(p => !allowed.includes(p.key)).length : 0;
    const pageBtn = canTogglePages
      ? `<button class="btn btn-sm" data-rr-team-pages="${r.id}" style="white-space:nowrap">
           ${restrictedCount > 0 ? `Pages · ${PAGES.length - restrictedCount}/${PAGES.length}` : "Pages · all"}
         </button>`
      : "";
    return `<div class="member-row" data-rr-team-row="${r.id}">
      <div class="dsp-avatar" style="width:32px;height:32px;font-size:var(--fs-xs)">${escapeHtml(initials)}</div>
      <div style="min-width:0">
        ${canEditName
          ? `<input type="text" value="${escapeHtml(r.full_name || "")}" placeholder="${escapeHtml(r.email)}"
              data-rr-team-name="${r.id}"
              style="font-size:var(--fs-md);font-weight:600;background:transparent;border:1px solid transparent;border-radius:4px;padding:2px 6px;width:100%;color:var(--text)"
              onfocus="this.style.borderColor='var(--border-strong)';this.style.background='var(--surface)'"
              onblur="this.style.borderColor='transparent';this.style.background='transparent'">`
          : `<div style="font-size:var(--fs-md);font-weight:600;padding:2px 6px">${escapeHtml(r.full_name || r.email)}</div>`}
        <div style="font-size:var(--fs-xs);color:var(--text-subtle);padding-left:6px">${escapeHtml(sub)}</div>
      </div>
      ${pageBtn}
      <select class="form-input" style="width:140px;padding:4px 8px;font-size:var(--fs-sm)" data-rr-team-role="${r.id}" ${isMe ? "disabled title='Cannot change your own role'" : ""}>${roleOpts}</select>
      <button class="btn btn-sm btn-danger" data-rr-team-remove="${r.id}" data-rr-team-name-display="${escapeHtml(r.full_name || r.email)}" ${isMe ? "disabled title='Cannot remove yourself'" : ""}>Remove</button>
    </div>`;
  }).join("");
}

// Inline name save on blur — debounced via the blur event itself.
document.addEventListener("blur", async (e) => {
  const inp = e.target.closest("[data-rr-team-name]");
  if (!inp) return;
  const id = inp.getAttribute("data-rr-team-name");
  const newName = inp.value.trim();
  // Skip if unchanged (the row's previous value lives in the DOM
  // before edit; we just send what's there now).
  const { error } = await sb.from("app_users").update({ full_name: newName || null }).eq("id", id);
  if (error) { toast("Save failed: " + error.message, "warn"); return; }
  toast("Name updated", "success");
  // If the user updated their own name, reflect it in window.RR.user
  // so other dashboard surfaces (workspace chip, account menu) catch up.
  if (id === window.RR?.user?.id) {
    window.RR.user.full_name = newName || null;
  }
}, true);

// Page-permissions popover. Click the "Pages" button to toggle which
// top-level views show in the teammate's sidebar.
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-rr-team-pages]");
  if (!btn) return;
  e.preventDefault();
  const id = btn.getAttribute("data-rr-team-pages");
  // Fetch fresh allowed_pages so we don't overwrite a parallel edit.
  const { data, error } = await sb.from("app_users")
    .select("allowed_pages, full_name, email")
    .eq("id", id).maybeSingle();
  if (error) { toast("Load failed: " + error.message, "warn"); return; }
  const PAGES = [
    { key: "dashboard", label: "Today" },
    { key: "pipeline",  label: "Hiring Pipeline" },
    { key: "drivers",   label: "Drivers" },
    { key: "staffing",  label: "Performance" },
    { key: "fleet",     label: "Fleet" },
    { key: "schedule",  label: "Schedule" },
    { key: "messages",  label: "Messages" },
    { key: "forms",     label: "Workflows" },
    { key: "finances",  label: "Finances" },
  ];
  // null/undefined allowed_pages = full access (all pages allowed).
  const current = Array.isArray(data?.allowed_pages) ? data.allowed_pages : PAGES.map(p => p.key);
  // Build modal contents.
  const teammate = data?.full_name || data?.email || "this teammate";
  const checks = PAGES.map(p =>
    `<label style="display:flex;align-items:center;gap:8px;padding:6px 4px;cursor:pointer;border-radius:4px" onmouseover="this.style.background='var(--surface-hover)'" onmouseout="this.style.background='transparent'">
       <input type="checkbox" data-rr-page-toggle="${p.key}" ${current.includes(p.key) ? "checked" : ""}>
       <span style="font-size:var(--fs-md)">${escapeHtml(p.label)}</span>
     </label>`
  ).join("");
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.style.display = "flex";
  modal.style.zIndex = "9999";
  modal.innerHTML = `
    <div class="modal" style="max-width:380px">
      <div class="modal-header">
        <div>
          <p class="modal-title">Sidebar pages</p>
          <p class="modal-sub" style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">${escapeHtml(teammate)} will only see checked pages</p>
        </div>
        <button class="modal-close" data-rr-page-modal-close><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="modal-body">${checks}</div>
      <div class="modal-actions" style="display:flex;justify-content:space-between;gap:var(--s-2);padding:var(--s-3) var(--s-5);border-top:1px solid var(--border)">
        <button class="btn btn-sm btn-ghost" data-rr-page-modal-all>Allow all</button>
        <div style="display:flex;gap:var(--s-2)">
          <button class="btn btn-sm" data-rr-page-modal-close>Cancel</button>
          <button class="btn btn-sm btn-primary" data-rr-page-modal-save>Save</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener("click", async (ev) => {
    if (ev.target === modal || ev.target.closest("[data-rr-page-modal-close]")) {
      modal.remove(); return;
    }
    if (ev.target.closest("[data-rr-page-modal-all]")) {
      modal.querySelectorAll("[data-rr-page-toggle]").forEach(c => c.checked = true);
      return;
    }
    if (ev.target.closest("[data-rr-page-modal-save]")) {
      const checked = Array.from(modal.querySelectorAll("[data-rr-page-toggle]:checked"))
        .map(c => c.getAttribute("data-rr-page-toggle"));
      // If everything's checked, store NULL (= no restriction). Cleaner
      // than carrying a redundant array around.
      const value = checked.length === PAGES.length ? null : checked;
      const { error } = await sb.from("app_users").update({ allowed_pages: value }).eq("id", id);
      if (error) { toast("Save failed: " + error.message, "warn"); return; }
      toast("Page access updated", "success");
      modal.remove();
      loadTeamMembers();
    }
  });
});

// Inline role-change save (no modal — change the select, hits the
// app_users row immediately).
document.addEventListener("change", async (e) => {
  const sel = e.target.closest("[data-rr-team-role]");
  if (!sel) return;
  const id = sel.getAttribute("data-rr-team-role");
  const role = sel.value;
  const { error } = await sb.from("app_users").update({ role }).eq("id", id);
  if (error) { toast("Save failed: " + error.message, "warn"); loadTeamMembers(); return; }
  toast("Role updated", "success");
});

// Remove member — soft-delete via active=false so any audit/coaching
// rows that reference them still resolve. Keeps the auth.users row
// intact (no privileged admin call needed); the app login gate already
// rejects inactive app_users.
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-rr-team-remove]");
  if (!btn) return;
  const id   = btn.getAttribute("data-rr-team-remove");
  const name = btn.getAttribute("data-rr-team-name-display") || "this teammate";
  if (!confirm(`Remove ${name} from the team? They'll lose dashboard access immediately. Re-invite them later if needed.`)) return;
  btn.disabled = true;
  const { error } = await sb.from("app_users").update({ active: false }).eq("id", id);
  if (error) { toast("Remove failed: " + error.message, "warn"); btn.disabled = false; return; }
  toast(`Removed ${name}`, "warn");
  loadTeamMembers();
});

// Open the invite modal.
document.addEventListener("click", (e) => {
  if (e.target.closest("#rr-team-invite-open")) {
    const modal = document.getElementById("modal-team-invite");
    if (!modal) return;
    modal.style.display = "flex";
    document.getElementById("rr-team-invite-email").value = "";
    document.getElementById("rr-team-invite-name").value  = "";
    document.getElementById("rr-team-invite-role").value  = "dispatcher";
    const status = document.getElementById("rr-team-invite-status");
    if (status) status.textContent = "";
    setTimeout(() => document.getElementById("rr-team-invite-email")?.focus(), 50);
  }
});

// Submit the invite — calls the invite-team-member edge function.
document.addEventListener("submit", async (e) => {
  if (e.target?.id !== "rr-team-invite-form") return;
  e.preventDefault();
  const email   = document.getElementById("rr-team-invite-email").value.trim().toLowerCase();
  const name    = document.getElementById("rr-team-invite-name").value.trim();
  const role    = document.getElementById("rr-team-invite-role").value;
  const status  = document.getElementById("rr-team-invite-status");
  const submit  = document.getElementById("rr-team-invite-submit");
  if (!email) return;

  if (status) { status.style.color = "var(--text-subtle)"; status.textContent = "Sending…"; }
  submit.disabled = true;

  try {
    const { data, error } = await sb.functions.invoke("invite-team-member", {
      method: "POST",
      body: { email, full_name: name, role },
    });
    if (error || data?.error) {
      const msg = data?.error || error?.message || "Invite failed";
      if (status) { status.style.color = "var(--red)"; status.textContent = _humanInviteError(msg); }
      submit.disabled = false;
      return;
    }
    if (status) { status.style.color = "var(--green)"; status.textContent = "Invite sent. They'll receive a magic-link email."; }
    toast("Invite sent to " + email, "success");
    setTimeout(() => {
      document.getElementById("modal-team-invite").style.display = "none";
      submit.disabled = false;
      loadTeamMembers();
    }, 900);
  } catch (err) {
    if (status) { status.style.color = "var(--red)"; status.textContent = String(err?.message || err); }
    submit.disabled = false;
  }
});

function _humanInviteError(raw) {
  const m = String(raw);
  if (m.includes("already_on_team"))    return "That email is already on your team.";
  if (m.includes("invalid_email"))      return "That doesn't look like a valid email.";
  if (m.includes("invalid_role"))       return "Pick a valid role.";
  if (m.includes("not_authenticated"))  return "Your session expired — refresh the page and try again.";
  if (m.includes("no_profile"))         return "Your account isn't linked to a tenant.";
  if (m.includes("insufficient_role"))  return "Only owners and ops can invite teammates.";
  return m;
}

// Attendance subtab order is operator-preference.  Drag to reorder;
// the order is persisted per browser via localStorage so it survives
// reloads.  Re-applies on every render of the Drivers view.
const _RR_ATT_TAB_ORDER_KEY = "rr.att.tab-order";
function _rrApplyAttTabOrder() {
  const strip = document.getElementById("rr-att-tabstrip");
  if (!strip) return;
  let order;
  try { order = JSON.parse(localStorage.getItem(_RR_ATT_TAB_ORDER_KEY) || "null"); } catch {}
  if (!Array.isArray(order)) return;
  const byKey = {};
  strip.querySelectorAll("[data-att]").forEach(el => { byKey[el.dataset.att] = el; });
  for (const k of order) if (byKey[k]) strip.appendChild(byKey[k]);
}
function _rrSaveAttTabOrder() {
  const strip = document.getElementById("rr-att-tabstrip");
  if (!strip) return;
  const order = [...strip.querySelectorAll("[data-att]")].map(el => el.dataset.att);
  try { localStorage.setItem(_RR_ATT_TAB_ORDER_KEY, JSON.stringify(order)); } catch {}
}
function _rrInitAttTabDnD() {
  const strip = document.getElementById("rr-att-tabstrip");
  if (!strip || strip.dataset.rrDndReady === "1") return;
  strip.dataset.rrDndReady = "1";
  _rrApplyAttTabOrder();

  let dragged = null;
  strip.addEventListener("dragstart", (e) => {
    const t = e.target.closest("[data-att]");
    if (!t) return;
    dragged = t;
    t.style.opacity = "0.4";
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", t.dataset.att); } catch {}
  });
  strip.addEventListener("dragend", () => {
    if (dragged) dragged.style.opacity = "";
    dragged = null;
  });
  strip.addEventListener("dragover", (e) => {
    if (!dragged) return;
    e.preventDefault();
    const target = e.target.closest("[data-att]");
    if (!target || target === dragged) return;
    const rect = target.getBoundingClientRect();
    const after = (e.clientX - rect.left) > rect.width / 2;
    target.parentElement.insertBefore(dragged, after ? target.nextSibling : target);
  });
  strip.addEventListener("drop", (e) => {
    e.preventDefault();
    _rrSaveAttTabOrder();
  });
}
// Bootstrap once now (in case the user is already on Drivers →
// Attendance) and again after every drSub call so the strip exists.
_rrInitAttTabDnD();

// ─── Sidebar · Today's Plan ────────────────────────────────────────────
// The new default landing for operators. Pulls today's attendance live,
// today's coverage gaps (open shifts), and credential expirations into
// one glanceable view. Polls every 30 s while on the dashboard tab.

let _todayPlanTimer = null;

// sessionStorage keys — survive tab navigation, dropped on browser
// close. Used to render last-known data INSTANTLY on tab open while
// fresh data fetches in the background ("stale-while-revalidate").
const _TP_CACHE_KEYS = { att: "rr.tp.att", plan: "rr.tp.plan" };

function _tpCacheRead(key) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    // Drop anything older than 10 minutes — better to fetch fresh.
    if (!obj?.ts || Date.now() - obj.ts > 10 * 60 * 1000) return null;
    return obj.data;
  } catch { return null; }
}
function _tpCacheWrite(key, data) {
  try { sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch {}
}

async function loadTodayPlan() {
  const shell = document.getElementById("rr-today-plan-shell");
  if (!shell) return;

  const dateEl = document.getElementById("rr-today-date");
  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString(undefined, {
      weekday: "long", month: "long", day: "numeric",
    });
  }

  if (_todayPlanTimer) clearInterval(_todayPlanTimer);
  _todayPlanTimer = setInterval(() => {
    if (document.getElementById("view-dashboard")?.classList.contains("active") && !document.hidden) {
      _refreshTodayPlanData();
    } else { clearInterval(_todayPlanTimer); _todayPlanTimer = null; }
  }, 30000);

  // Render the skeleton FIRST so the page never sits on a single spinner.
  // Re-render whenever the expected IDs are missing — handles upgrading
  // an open tab from an older live.js that wrote a different skeleton.
  const skeletonOk = !!document.getElementById("rr-tp-waves")
                  && !!document.getElementById("rr-tp-tool")
                  && !!document.getElementById("rr-tp-extras");
  if (!skeletonOk) {
    shell.dataset.rrPlanShell = "1";
    shell.innerHTML = `
      <div id="rr-tp-waves"   style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:var(--s-3);margin-bottom:var(--s-4)">
        <div class="card" style="height:108px"></div>
        <div class="card" style="height:108px"></div>
      </div>
      <div id="rr-tp-meta" class="card card-compact" style="padding:var(--s-2) var(--s-4);margin-bottom:var(--s-4);font-size:var(--fs-sm);color:var(--text-subtle)">Loading</div>
      <div id="rr-tp-tool" class="card card-flush" style="margin-bottom:var(--s-4)">
        <div class="rr-tp-section-head">Daily attendance · approvals</div>
        <div class="rr-loading">Loading</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--s-4)">
        <div id="rr-tp-extras" class="card card-flush">
          <div class="rr-tp-section-head">Extra drivers (Ex)</div>
          <div class="rr-loading">Loading</div>
        </div>
        <div id="rr-tp-cov" class="card card-flush">
          <div class="rr-tp-section-head">Coverage</div>
          <div class="rr-loading">Loading</div>
        </div>
      </div>`;
  }

  // Stale-while-revalidate: render last-known cached data instantly so
  // the page is filled in the same frame the operator clicks Today.
  // Wrap in try/catch — if the cache shape from an earlier live.js
  // doesn't match the new render code, we'd rather drop the cache than
  // freeze the page on a "Loading…" placeholder.
  const cachedAtt  = _tpCacheRead(_TP_CACHE_KEYS.att);
  const cachedPlan = _tpCacheRead(_TP_CACHE_KEYS.plan);
  try { if (cachedAtt)  _renderTpAttendance(cachedAtt,  null); }
  catch (e) { console.warn("today plan · stale attendance cache:", e); sessionStorage.removeItem(_TP_CACHE_KEYS.att); }
  try { if (cachedPlan) _renderTpCoverage(cachedPlan,   null); }
  catch (e) { console.warn("today plan · stale coverage cache:", e);   sessionStorage.removeItem(_TP_CACHE_KEYS.plan); }

  _refreshTodayPlanData();
}

async function _refreshTodayPlanData() {
  // Fire each RPC independently so a hang in one doesn't block the
  // other. Each handler updates only its own region.  Wrap the render
  // in try/catch so a single bad row never wipes out the whole page —
  // keep the page alive and surface the error inline instead.
  sb.rpc("today_attendance").then(({ data, error }) => {
    if (error) { _renderTpAttendance(null, error); return; }
    _tpCacheWrite(_TP_CACHE_KEYS.att, data);
    try { _renderTpAttendance(data, null); }
    catch (e) { console.error("today plan · attendance render failed:", e); _renderTpAttendance(null, e); }
  }).catch(err => _renderTpAttendance(null, err));

  sb.rpc("today_plan").then(({ data, error }) => {
    if (error) { _renderTpCoverage(null, error); return; }
    _tpCacheWrite(_TP_CACHE_KEYS.plan, data);
    try { _renderTpCoverage(data, null); }
    catch (e) { console.error("today plan · coverage render failed:", e); _renderTpCoverage(null, e); }
  }).catch(err => _renderTpCoverage(null, err));
}

function _renderTpAttendance(data, error) {
  const wavesEl  = document.getElementById("rr-tp-waves");
  const metaEl   = document.getElementById("rr-tp-meta");
  const toolEl   = document.getElementById("rr-tp-tool");
  const extrasEl = document.getElementById("rr-tp-extras");
  if (!wavesEl || !metaEl || !toolEl || !extrasEl) return;

  if (error) {
    toolEl.innerHTML = `<div class="card-section-head">Daily attendance · approvals</div>
      <div style="padding:18px;color:var(--red);font-size:var(--fs-sm);text-align:center">${escapeHtml(error.message || String(error))}</div>`;
    return;
  }

  const attRows = data?.rows || [];

  // ── Wave-level rollup ──────────────────────────────────────────────
  // For each wave: scheduled, checked-in (working OR completed), and
  // the rest (not-yet-checked-in). Percentages are computed against
  // scheduled. Operators read this top-down at the start of the day.
  const waveBuckets = new Map();
  for (const r of attRows) {
    const w = r.wave_index ?? 0;
    if (!waveBuckets.has(w)) waveBuckets.set(w, { scheduled: 0, checkedIn: 0, notIn: 0, tardy: 0, ncns: 0 });
    const b = waveBuckets.get(w);
    b.scheduled++;
    if (r.computed_outcome === "checked_in" || r.computed_outcome === "checked_out") b.checkedIn++;
    else b.notIn++;
    if (r.computed_outcome === "tardy") b.tardy++;
    if (r.computed_outcome === "ncns")  b.ncns++;
  }

  const pctOf = (a, b) => b > 0 ? Math.round((a / b) * 100) : 0;
  // Neutral palette throughout — operator wants the numbers to carry
  // the message, not the dashboard's verdict.
  const waveCard = (wave, b) => {
    const inPct  = pctOf(b.checkedIn, b.scheduled);
    const outPct = 100 - inPct;
    const flagged = b.tardy + b.ncns;
    return `
      <div class="card card-compact" style="display:flex;flex-direction:column;gap:var(--s-3)">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <div style="font-size:var(--fs-md);font-weight:700;color:var(--text)">Wave ${escapeHtml(String(wave))}</div>
          <div style="font-size:var(--fs-xs);color:var(--text-subtle)">${b.scheduled} scheduled</div>
        </div>
        <div style="display:flex;gap:12px">
          <div style="flex:1">
            <div style="font-size:var(--fs-xs);color:var(--text-subtle);font-weight:600;letter-spacing:.04em;text-transform:uppercase">Checked in</div>
            <div style="font-size:var(--fs-xxl);font-weight:700;color:var(--text)">${b.checkedIn}<span style="font-size:var(--fs-md);color:var(--text-subtle);font-weight:600;margin-left:6px">${inPct}%</span></div>
          </div>
          <div style="flex:1">
            <div style="font-size:var(--fs-xs);color:var(--text-subtle);font-weight:600;letter-spacing:.04em;text-transform:uppercase">Not in</div>
            <div style="font-size:var(--fs-xxl);font-weight:700;color:var(--text)">${b.notIn}<span style="font-size:var(--fs-md);color:var(--text-subtle);font-weight:600;margin-left:6px">${outPct}%</span></div>
          </div>
        </div>
        <div style="height:6px;background:var(--canvas);border-radius:999px;overflow:hidden;display:flex">
          <div style="width:${inPct}%;background:var(--text-muted)"></div>
          <div style="width:${outPct}%;background:var(--border-strong)"></div>
        </div>
        ${flagged > 0
          ? `<div style="font-size:var(--fs-xs);color:var(--text);font-weight:600">${b.tardy} tardy · ${b.ncns} NCNS</div>`
          : `<div style="font-size:var(--fs-xs);color:var(--text-subtle)">No issues this wave</div>`}
      </div>`;
  };

  const sortedWaves = [...waveBuckets.entries()].sort((a, b) => a[0] - b[0]);
  wavesEl.innerHTML = sortedWaves.length === 0
    ? `<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;text-align:center;color:var(--text-subtle);font-size:var(--fs-md)">No drivers scheduled today.</div>`
    : sortedWaves.map(([w, b]) => waveCard(w, b)).join("");

  // ── Meta strip (service-type breakdown + as-of) ────────────────────
  const bySvc = {};
  for (const r of attRows) {
    const sv = r.service_type_code || "—";
    if (!bySvc[sv]) bySvc[sv] = { count: 0, color: r.service_type_color || "#94a3b8" };
    bySvc[sv].count++;
  }
  const svcChips = Object.entries(bySvc).map(([code, v]) =>
    `<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:10px;background:${v.color}22;color:${v.color};font-size:var(--fs-xs);font-weight:600;margin-right:4px">${escapeHtml(code)} · ${v.count}</span>`
  ).join("");
  metaEl.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <div>${svcChips || "<span style='color:var(--text-subtle)'>No service-type breakdown</span>"}</div>
      <div style="font-size:var(--fs-xs);color:var(--text-subtle)">As of ${escapeHtml(new Date(data.as_of).toLocaleTimeString())}</div>
    </div>`;

  // ── Daily attendance approvals card ────────────────────────────────
  // Anyone tardy / NCNS / missed-reported needs a leader decision today.
  // We show their current points + standing + recommended action and
  // expose Approve / Deny buttons.  Persistence is the next phase per
  // the product spec; for now the buttons just mark the row visually so
  // the operator can see what they've reviewed.
  const flagged = attRows.filter(r =>
    ["tardy", "ncns", "missed_reported"].includes(r.computed_outcome)
  );
  _renderTpDailyTool(flagged);

  // ── Extra drivers (Ex / cushion) roster ────────────────────────────
  const extras = attRows.filter(r => r.is_cushion);
  const extrasRows = extras.length === 0
    ? `<div class="rr-empty-inline">No extras scheduled today.</div>`
    : extras.map(r => {
        const t = r.starts_at ? new Date(r.starts_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "—";
        // Neutral chip — Today page is a no-stoplight zone.
        const tone = { bg: "var(--canvas)", fg: "var(--text-muted)" };
        const label = _RR_OUTCOME_LABEL[r.computed_outcome] || r.computed_outcome;
        const initials = (r.driver_name || "?").split(/\s+/).map(p => p[0]).filter(Boolean).slice(0,2).join("").toUpperCase();
        return `
          <div style="display:grid;grid-template-columns:30px 1fr auto;gap:10px;align-items:center;padding:8px 14px;border-top:1px solid var(--border)">
            <div class="avatar-sm" data-rr-driver-id="${escapeHtml(r.driver_id)}" style="width:30px;height:30px;font-size:var(--fs-xs)">${escapeHtml(initials)}</div>
            <div style="min-width:0">
              <div style="font-size:var(--fs-md);font-weight:600" data-rr-driver-id="${escapeHtml(r.driver_id)}">${escapeHtml(r.driver_name)}</div>
              <div style="font-size:var(--fs-xs);color:var(--text-subtle)">${escapeHtml(r.station_code || "—")} · Wave ${r.wave_index ?? 0} · ${escapeHtml(t)}</div>
            </div>
            <span style="background:${tone.bg};color:${tone.fg};font-size:var(--fs-xs);font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:3px 8px;border-radius:10px">${escapeHtml(label)}</span>
          </div>`;
      }).join("");
  extrasEl.innerHTML = `
    <div class="card-section-head">
      Extra drivers (Ex) <span style="color:var(--text-subtle);font-weight:600">· ${extras.length}</span>
    </div>
    ${extrasRows}`;
}

// Daily approvals tool — pulls each flagged driver's current
// attendance points from the last `decay_days` of shift events, plots
// them against the policy's warn / action thresholds, and recommends
// the next step.  The Approve / Deny buttons are intentionally inert
// for now (visual only); persistence + driver notifications are the
// next phase per product direction.
async function _renderTpDailyTool(flagged) {
  const toolEl = document.getElementById("rr-tp-tool");
  if (!toolEl) return;

  const head = (n) => `
    <div class="card-section-head">
      Daily attendance · approvals <span style="color:var(--text-subtle);font-weight:600">· ${n}</span>
    </div>`;

  if (flagged.length === 0) {
    toolEl.innerHTML = `${head(0)}
      <div style="padding:24px;text-align:center;color:var(--green);font-size:var(--fs-md);font-weight:600">✓ No tardies or no-shows to approve right now.</div>`;
    return;
  }

  const policy = _getAttPolicy();
  const evalP  = _evalPolicy();
  const dspId  = window.RR?.dsp?.id;
  const since  = new Date(Date.now() - (evalP.decay_days || 90) * 86400000)
    .toISOString().slice(0, 10);

  // Per-event point values — same as the Report.  Missing event
  // blocks contribute zero (the operator chose not to count that
  // event type).
  const ptsCallout = evalP.events.callout ? Number(evalP.events.callout.points) || 0 : 0;
  const ptsNoshow  = evalP.events.no_show ? Number(evalP.events.no_show.points) || 0 : 0;
  const ptsLate    = evalP.events.late    ? Number(evalP.events.late.points)    || 0 : 0;
  const pointsForEvent = (st) =>
      st === "late"       ? ptsLate
    : st === "called_off" ? ptsCallout
    : st === "no_show"    ? ptsNoshow
    : 0;
  const pointsForOutcome = (oc) =>
      oc === "tardy"            ? ptsLate
    : oc === "missed_reported"  ? ptsCallout
    : oc === "ncns"             ? ptsNoshow
    : 0;

  // Map driver_id → cumulative points already accrued in window.
  let pointsMap = new Map();
  if (evalP.enabled) {
    const ids = flagged.map(r => r.driver_id);
    const { data: hist } = await sb.from("shifts")
      .select("driver_id, status")
      .eq("dsp_id", dspId)
      .in("driver_id", ids)
      .in("status", ["called_off", "no_show", "late"])
      .gte("date", since);
    for (const h of (hist || [])) {
      const p = pointsForEvent(h.status);
      if (p > 0) pointsMap.set(h.driver_id, (pointsMap.get(h.driver_id) || 0) + p);
    }
  }

  // Neutral palette — labels carry the meaning; no stoplight tints.
  const standing = (rung) => {
    if (!evalP.enabled) return { label: "Policy off", tone: "var(--text-subtle)" };
    if (!rung)          return { label: "Good standing", tone: "var(--text-subtle)" };
    if (rung.severity === "verbal") return { label: "Warning", tone: "var(--text-muted)" };
    return { label: "Action", tone: "var(--text)" };
  };

  // levelFor → severity string from the matching ladder rung; null
  // when the driver hasn't crossed the lowest threshold.
  // NCNS-terminates short-circuits to termination regardless of points.
  const levelFor = (outcome, points) => {
    if (!evalP.enabled) return null;
    if (outcome === "ncns" && evalP.ncns_terminates) return "termination";
    const rung = _evalLadderRung(evalP, points);
    return rung ? rung.severity : null;
  };
  const recommend = (outcome, level) => {
    if (!evalP.enabled) return "Logged · policy is off";
    if (level === "termination") return "Termination · review &amp; confirm";
    if (level === "final")       return "Final written warning · 1 step before termination";
    if (level === "written")     return "Written warning · log conversation";
    if (level === "verbal")      return "Verbal coaching · log conversation";
    if (outcome === "ncns")  return "Confirm no-call / no-show";
    if (outcome === "tardy") return "Note tardy · no formal action";
    return "Acknowledge missed day";
  };
  // Lookup the matching ladder rung's auto_fire + delivery — the
  // builder's source of truth.  Master auto_coaching toggle off
  // disables every auto-fire regardless.
  const rungFor = (level) => (evalP.ladder || []).find(r => r.severity === level) || null;
  const willAutoFire = (level) => {
    if (!evalP.enabled || !evalP.auto_coaching) return false;
    if (!level || level === "termination") return false;
    const r = rungFor(level);
    return !!(r && r.auto_fire);
  };
  const deliveryFor = (level) => {
    const r = rungFor(level);
    return r?.delivery || "ack";
  };

  const rows = flagged.map(r => {
    const before = pointsMap.get(r.driver_id) || 0;
    const add = (evalP.enabled ? pointsForOutcome(r.computed_outcome) : 0);
    const after = before + add;
    const lvl = levelFor(r.computed_outcome, after);
    const auto = willAutoFire(lvl);
    const st  = standing(after);
    const rec = recommend(r.computed_outcome, lvl);
    const initials = (r.driver_name || "?").split(/\s+/).map(p => p[0]).filter(Boolean).slice(0,2).join("").toUpperCase();
    // Today page is neutral — no stoplight chip on the daily approvals.
    const tone = { bg: "var(--canvas)", fg: "var(--text-muted)" };
    const label = _RR_OUTCOME_LABEL[r.computed_outcome] || r.computed_outcome;
    return `
      <div class="rr-tp-tool-row" data-driver-id="${escapeHtml(r.driver_id)}"
           style="display:grid;grid-template-columns:36px minmax(160px,1fr) 130px 1fr auto;gap:14px;align-items:center;padding:12px 14px;border-top:1px solid var(--border)">
        <div class="avatar-sm" data-rr-driver-id="${escapeHtml(r.driver_id)}">${escapeHtml(initials)}</div>
        <div style="min-width:0">
          <div style="font-size:var(--fs-md);font-weight:600" data-rr-driver-id="${escapeHtml(r.driver_id)}">${escapeHtml(r.driver_name)}</div>
          <div style="font-size:var(--fs-xs);color:var(--text-subtle)">${escapeHtml(r.station_code || "—")} · Wave ${r.wave_index ?? 0}</div>
        </div>
        <div>
          <span style="background:${tone.bg};color:${tone.fg};font-size:var(--fs-xs);font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:3px 8px;border-radius:10px">${escapeHtml(label)}</span>
        </div>
        <div style="min-width:0">
          <div style="font-size:var(--fs-sm);color:var(--text)"><strong>${after} occ${after === 1 ? "" : "s"}</strong> · <span style="color:${st.tone};font-weight:600">${st.label}</span></div>
          <div style="font-size:var(--fs-xs);color:var(--text-subtle)">Next: ${rec}${auto ? " · auto-fires on Approve" : ""}</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn btn-sm btn-primary"
                  data-rr-tp-approve="1"
                  data-shift-id="${escapeHtml(r.shift_id)}"
                  data-outcome="${escapeHtml(r.computed_outcome)}"
                  data-driver-name="${escapeHtml(r.driver_name)}"
                  data-level="${escapeHtml(lvl || '')}"
                  data-auto-fire="${auto ? '1' : '0'}"
                  data-delivery="${escapeHtml(deliveryFor(lvl))}"
                  type="button">Confirm</button>
          <button class="btn btn-sm"
                  data-rr-tp-vto="1"
                  data-shift-id="${escapeHtml(r.shift_id)}"
                  data-outcome="${escapeHtml(r.computed_outcome)}"
                  data-driver-name="${escapeHtml(r.driver_name)}"
                  type="button">VTO</button>
          <button class="btn btn-sm"
                  data-rr-tp-deny="1"
                  data-shift-id="${escapeHtml(r.shift_id)}"
                  data-outcome="${escapeHtml(r.computed_outcome)}"
                  data-driver-name="${escapeHtml(r.driver_name)}"
                  data-level="${escapeHtml(lvl || '')}"
                  type="button">Excuse</button>
        </div>
      </div>`;
  }).join("");

  // Footer summary — what happens on Confirm given the current
  // policy + auto-coaching toggles.
  let autoCoachNote;
  if (!evalP.enabled) {
    autoCoachNote = "Attendance policy is OFF — Confirm just stamps the shift; coach manually from the Event log.";
  } else if (!evalP.auto_coaching) {
    autoCoachNote = "Auto-coaching is OFF — Confirm just stamps the shift; fire coachings manually from the Attendance Report.";
  } else {
    const levels = (evalP.ladder || []).filter(r => r.auto_fire && r.severity !== "termination").map(r => r.severity);
    autoCoachNote = levels.length === 0
      ? "Auto-coaching is ON but no ladder rungs are set to auto-fire. Confirm just stamps the shift."
      : "Auto-fires + messages the driver in the RouteReady app when the driver crosses: " + levels.join(", ") + ".";
  }

  toolEl.innerHTML = `${head(flagged.length)}${rows}
    <div style="padding:10px 14px;background:var(--canvas);border-top:1px solid var(--border);font-size:var(--fs-xs);color:var(--text-subtle)">
      ${escapeHtml(autoCoachNote)}
    </div>`;
}

// Approve / decline on the daily tool.  Approve hits the
// attendance_decide RPC (which stamps shifts.status, writes a coaching
// row, and DMs the driver if auto_coaching is on).  Decline opens a
// notes prompt — server enforces notes on deny.
document.addEventListener("click", async (e) => {
  const ap  = e.target.closest("[data-rr-tp-approve]");
  const dn  = e.target.closest("[data-rr-tp-deny]");
  const vto = e.target.closest("[data-rr-tp-vto]");
  if (!ap && !dn && !vto) return;
  e.preventDefault();
  const btn = ap || dn || vto;
  const row = btn.closest(".rr-tp-tool-row");
  if (!row) return;

  const shiftId    = btn.dataset.shiftId;
  const outcome   = btn.dataset.outcome;
  const driverName = btn.dataset.driverName || "driver";

  // Excuse → notes required (same prompt as before, just renamed).
  // VTO    → notes optional ("offered VTO Wednesday — accepted" etc.).
  let notes = null;
  let decision = "approve";
  if (dn) {
    decision = "deny";
    const reason = window.prompt(
      `Excuse ${driverName}'s ${outcome.replace(/_/g, " ")}?\n\nNotes are required — explain why this event is excused (e.g. "approved leave", "system glitch", "documentation provided").`
    );
    if (reason === null) return;
    if (!reason.trim()) { toast("Notes required to excuse", "warn"); return; }
    notes = reason.trim();
  } else if (vto) {
    decision = "vto";
    const reason = window.prompt(
      `Mark ${driverName}'s shift as VTO?\n\nOptional notes (who offered VTO, why, etc.).`,
      ""
    );
    if (reason === null) return;
    notes = reason.trim() || null;
  }

  const btnCell = btn.parentElement;
  btnCell.innerHTML = `<span style="font-size:var(--fs-xs);color:var(--text-subtle)">Saving…</span>`;

  const level    = btn.dataset.level || null;
  const autoFire = btn.dataset.autoFire === "1";
  const delivery = btn.dataset.delivery || null;

  const { data, error } = await sb.rpc("attendance_decide", {
    p_shift_id:  shiftId,
    p_outcome:   outcome,
    p_decision:  decision,
    p_notes:     notes,
    p_auto_fire: ap ? autoFire : false,
    p_level:     level,
    p_delivery:  ap ? delivery : null,
  });

  if (error) {
    toast("Save failed: " + (error.message || String(error)), "warn");
    btnCell.innerHTML = `<span style="font-size:var(--fs-xs);color:var(--red)">${escapeHtml(error.message || "Failed")}</span>`;
    return;
  }

  const verb = ap ? "Approved" : (vto ? "Marked VTO" : "Excused");
  const tone = ap ? "var(--green)" : "var(--text-subtle)";
  btnCell.innerHTML = `<span style="font-size:var(--fs-xs);font-weight:700;color:${tone};letter-spacing:.04em;text-transform:uppercase">${escapeHtml(verb)}</span>`;
  const tailParts = [];
  if (data?.auto_fired) tailParts.push("driver coached");
  else if (ap)          tailParts.push("queued for coaching drawer");
  const tail = tailParts.length ? " · " + tailParts.join(" · ") : "";
  toast(`${verb}${tail}`, "success");
  // Fade + remove the row so the operator's queue visibly shrinks.
  // 600ms gives them time to register the inline confirmation pill
  // before it disappears.  After removal, refresh the Today's Plan
  // data so the wave KPIs reflect the new shift status.
  row.style.transition = "opacity .35s ease, transform .35s ease, max-height .35s ease, padding .35s ease, margin .35s ease";
  setTimeout(() => {
    row.style.opacity = "0";
    row.style.transform = "translateX(8px)";
    row.style.maxHeight = "0";
    row.style.paddingTop = "0";
    row.style.paddingBottom = "0";
    row.style.marginTop = "0";
    row.style.marginBottom = "0";
    row.style.overflow = "hidden";
    setTimeout(() => {
      row.remove();
      if (typeof _refreshTodayPlanData === "function") _refreshTodayPlanData();
    }, 380);
  }, 600);
});

function _renderTpCoverage(data, error) {
  const covEl = document.getElementById("rr-tp-cov");
  if (!covEl) return;

  const headHtml = (subtext) => `
    <div class="card-section-head">
      Coverage${subtext ? ` <span style="color:var(--text-subtle);font-weight:600">· ${subtext}</span>` : ""}
    </div>`;

  if (error) {
    // The most common case here is migration 0068 not yet applied —
    // surface a friendly hint instead of just the SQL error.
    const msg = String(error.message || error || "");
    const hint = /not find|does not exist|today_plan/i.test(msg)
      ? `Coverage view needs migration 0068 (today_plan). Apply it via Supabase SQL Editor and refresh.`
      : msg;
    covEl.innerHTML = `${headHtml("")}
      <div style="padding:18px;color:var(--amber);font-size:var(--fs-sm);text-align:center">${escapeHtml(hint)}</div>`;
    return;
  }

  const open  = data?.open_shifts       || [];
  const dlExp = data?.dl_expiring       || [];
  const noDot = data?.not_dot_certified || [];

  const openRows = open.length === 0
    ? `<div style="padding:18px;text-align:center;color:var(--green);font-size:var(--fs-sm);font-weight:600">✓ All shifts assigned</div>`
    : open.map(o => {
        const t = o.starts_at ? new Date(o.starts_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "—";
        const svc = o.service_type_code ? `<span style="background:${o.service_type_color || "#94a3b8"}22;color:${o.service_type_color || "#94a3b8"};padding:2px 6px;border-radius:4px;font-size:var(--fs-xs);font-weight:700;margin-left:6px">${escapeHtml(o.service_type_code)}</span>` : "";
        const cushion = o.is_cushion ? `<span style="background:rgba(180,83,9,.15);color:var(--amber);padding:2px 6px;border-radius:4px;font-size:var(--fs-xs);font-weight:700;margin-left:6px">EX</span>` : "";
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 14px;border-top:1px solid var(--border);font-size:var(--fs-md)">
          <div><strong>${escapeHtml(o.station_code || "—")}</strong> · ${escapeHtml(t)} · Wave ${o.wave_index ?? 0}${svc}${cushion}</div>
          <button class="btn btn-sm" onclick="goto('schedule')">Assign</button>
        </div>`;
      }).join("");

  const dlRows = dlExp.length === 0 ? "" :
    `<div style="padding:10px 14px;background:var(--canvas);border-top:1px solid var(--border);font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Driver license expiring soon · ${dlExp.length}</div>`
    + dlExp.map(d => {
        const days = Number(d.days_left);
        const tone = days <= 0 ? "var(--red)" : (days <= 2 ? "var(--amber)" : "var(--text-muted)");
        const label = days < 0 ? `Expired ${-days}d ago` : days === 0 ? "Expires today" : `${days}d left`;
        return `<div style="display:grid;grid-template-columns:1fr auto;gap:10px;padding:8px 14px;border-top:1px solid var(--border);font-size:var(--fs-md);align-items:center">
          <div data-rr-driver-id="${escapeHtml(d.driver_id)}" style="font-weight:600;cursor:pointer">${escapeHtml(d.driver_name)}</div>
          <span style="color:${tone};font-weight:700;font-size:var(--fs-sm)">${escapeHtml(label)}</span>
        </div>`;
      }).join("");

  // Drop the "active drivers without DOT certification" list on the
  // home page per product direction — that lives on the Drivers
  // licenses tab, no need to repeat it here.
  covEl.innerHTML = `${headHtml(`${open.length} open · ${dlExp.length} DL`)}
    ${openRows}${dlRows}`;
}


// ─── Drivers · Attendance · Today ──────────────────────────────────────
// Live KPI card + roster of who hasn't checked in. Polls every 15 s
// while the tab is visible. Operator can finalize the day with one
// click; that stamps every row's final_outcome and locks them so the
// permanent attendance record is immutable.

const _RR_OUTCOME_LABEL = {
  waiting:          "Waiting",
  ready_to_checkin: "Ready",
  checked_in:       "Checked in",
  checked_out:      "Done",
  missed_reported:  "Missed (reported)",
  tardy:            "Tardy",
  ncns:             "NCNS",
};
const _RR_OUTCOME_TONE = {
  waiting:          { bg: "var(--canvas)",            fg: "var(--text-subtle)" },
  ready_to_checkin: { bg: "var(--accent-soft)",       fg: "var(--accent)" },
  checked_in:       { bg: "rgba(22,163,74,.15)",      fg: "var(--green)" },
  checked_out:      { bg: "rgba(22,163,74,.10)",      fg: "var(--green)" },
  missed_reported:  { bg: "rgba(180,83,9,.15)",       fg: "var(--amber)" },
  tardy:            { bg: "rgba(180,83,9,.20)",       fg: "var(--amber)" },
  ncns:             { bg: "rgba(220,38,38,.15)",      fg: "var(--red)" },
};

let _todayAttPollTimer = null;

async function loadTodayAttendance() {
  const wrap = document.getElementById("rr-today-shell");
  if (!wrap) return;

  if (_todayAttPollTimer) clearInterval(_todayAttPollTimer);
  _todayAttPollTimer = setInterval(() => {
    if (document.getElementById("att-pane-today")?.classList.contains("active")
        && !document.hidden) {
      loadTodayAttendance();
    } else {
      clearInterval(_todayAttPollTimer); _todayAttPollTimer = null;
    }
  }, 15000);

  const { data, error } = await sb.rpc("today_attendance");
  if (error) {
    wrap.innerHTML = `<div style="padding:24px;color:var(--red);font-size:var(--fs-md)">${escapeHtml(error.message)}</div>`;
    return;
  }
  const rows = data?.rows || [];
  if (rows.length === 0) {
    wrap.innerHTML = `<div class="rr-empty-inline">No drivers scheduled for today.</div>`;
    return;
  }

  // Bucket counts by computed outcome for the KPI strip.
  const cnt = { total: rows.length, present: 0, working: 0, ready: 0, waiting: 0,
                missed: 0, tardy: 0, ncns: 0, finalized: 0 };
  for (const r of rows) {
    if (r.finalized) cnt.finalized++;
    switch (r.computed_outcome) {
      case "checked_in":     cnt.working++; cnt.present++; break;
      case "checked_out":                cnt.present++; break;
      case "ready_to_checkin": cnt.ready++; break;
      case "waiting":        cnt.waiting++; break;
      case "missed_reported": cnt.missed++; break;
      case "tardy":          cnt.tardy++; break;
      case "ncns":           cnt.ncns++; break;
    }
  }
  const notCheckedInYet = cnt.total - (cnt.working + (rows.filter(r => r.computed_outcome === "checked_out").length));

  // Wave + service-type breakdown.
  const byWave = {};
  const bySvc  = {};
  for (const r of rows) {
    const w = r.wave_index ?? 0;
    byWave[w] = (byWave[w] || 0) + 1;
    const k = r.service_type_code || "—";
    if (!bySvc[k]) bySvc[k] = { count: 0, color: r.service_type_color || "#94a3b8" };
    bySvc[k].count++;
  }

  const kpiCard = (label, value, sub, tone) => `
    <div class="card card-compact">
      <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-subtle);letter-spacing:.06em;text-transform:uppercase">${escapeHtml(label)}</div>
      <div style="font-size:26px;font-weight:700;margin-top:4px;color:${tone || "var(--text)"}">${escapeHtml(String(value))}</div>
      ${sub ? `<div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">${sub}</div>` : ""}
    </div>`;

  // Driver-row renderer.
  const rowHtml = (r) => {
    const tone = _RR_OUTCOME_TONE[r.computed_outcome] || _RR_OUTCOME_TONE.waiting;
    const label = _RR_OUTCOME_LABEL[r.computed_outcome] || r.computed_outcome;
    const t = r.starts_at ? new Date(r.starts_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "—";
    const inT = r.checked_in_at ? new Date(r.checked_in_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : null;
    const noteBits = [];
    if (inT) noteBits.push("In " + inT);
    if (r.distance_meters != null && inT) noteBits.push(`${r.distance_meters} m`);
    if (r.missed_reason) noteBits.push(`"${r.missed_reason}"`);
    return `
      <div style="display:grid;grid-template-columns:36px 1fr auto;gap:12px;align-items:center;padding:10px 14px;border-top:1px solid var(--border)">
        <div class="avatar-sm" data-rr-driver-id="${escapeHtml(r.driver_id)}">${escapeHtml((r.driver_name || "?").split(/\s+/).map(p => p[0]).filter(Boolean).slice(0,2).join("").toUpperCase())}</div>
        <div style="min-width:0">
          <div style="font-size:var(--fs-md);font-weight:600;color:var(--text)">${escapeHtml(r.driver_name)}</div>
          <div style="font-size:var(--fs-xs);color:var(--text-subtle)">${escapeHtml(r.station_code || "—")} · ${escapeHtml(t)}${noteBits.length ? " · " + escapeHtml(noteBits.join(" · ")) : ""}</div>
        </div>
        <span style="background:${tone.bg};color:${tone.fg};font-size:var(--fs-xs);font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:4px 10px;border-radius:10px">${escapeHtml(label)}</span>
      </div>`;
  };

  // Group by status — operator scans top-down: NCNS · tardy · ready · waiting · missed · checked-in.
  const groupOrder = [
    ["ncns",            "No-call no-show"],
    ["tardy",           "Tardy"],
    ["ready_to_checkin","Ready to check in"],
    ["waiting",         "Waiting · before window"],
    ["missed_reported", "Missed day · reported"],
    ["checked_in",      "Checked in · working"],
    ["checked_out",     "Shift complete"],
  ];
  const grouped = groupOrder.map(([k, label]) => {
    const items = rows.filter(r => r.computed_outcome === k);
    if (items.length === 0) return "";
    return `
      <div class="card card-flush" style="margin-bottom:var(--s-4)">
        <div style="padding:10px 14px;background:var(--canvas);border-bottom:1px solid var(--border);font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">
          ${escapeHtml(label)} <span style="color:var(--text-subtle);font-weight:600">· ${items.length}</span>
        </div>
        ${items.map(rowHtml).join("")}
      </div>`;
  }).join("");

  const waveLine = Object.keys(byWave).sort()
    .map(w => `Wave ${w}: <strong>${byWave[w]}</strong>`).join(" · ");
  const svcChips = Object.entries(bySvc)
    .map(([code, v]) => `<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:10px;background:${v.color}22;color:${v.color};font-size:var(--fs-xs);font-weight:600;margin-right:4px">${escapeHtml(code)} · ${v.count}</span>`)
    .join("");

  wrap.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">
      ${kpiCard("Scheduled", cnt.total, waveLine || "today")}
      ${kpiCard("Not checked in", Math.max(0, notCheckedInYet), `${cnt.ready} ready · ${cnt.waiting} waiting`, notCheckedInYet > 0 ? "var(--amber)" : undefined)}
      ${kpiCard("Tardy / NCNS", cnt.tardy + cnt.ncns, `${cnt.tardy} tardy · ${cnt.ncns} no-show`, (cnt.tardy + cnt.ncns) > 0 ? "var(--red)" : undefined)}
      ${kpiCard("Working", cnt.working, `${cnt.missed} missed reported`, cnt.working > 0 ? "var(--green)" : undefined)}
    </div>

    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:var(--fs-sm);color:var(--text-muted);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <div>${svcChips || "<span style='color:var(--text-subtle)'>No service-type breakdown</span>"}</div>
      <div style="display:flex;gap:8px;align-items:center">
        <span style="font-size:var(--fs-xs);color:var(--text-subtle)">As of ${escapeHtml(new Date(data.as_of).toLocaleTimeString())}</span>
        <button class="btn btn-sm" id="rr-today-refresh">Refresh</button>
        <button class="btn btn-sm btn-primary" id="rr-today-finalize" ${cnt.finalized === cnt.total ? "disabled" : ""}>${cnt.finalized === cnt.total ? "Already finalized" : "Approve & finalize day"}</button>
      </div>
    </div>

    ${grouped}
  `;

  document.getElementById("rr-today-refresh").addEventListener("click", loadTodayAttendance);
  document.getElementById("rr-today-finalize").addEventListener("click", async () => {
    if (!confirm("Finalize today's attendance?\n\nThis locks every record for today into the permanent log. Pending check-ins after this won't be retroactive without re-opening the day.")) return;
    const today = new Date().toISOString().slice(0, 10);
    const { error } = await sb.rpc("attendance_approve_day", { p_day: today });
    if (error) { toast("Finalize failed: " + error.message, "warn"); return; }
    toast("Day finalized · permanent record updated", "success");
    loadTodayAttendance();
  });
}



async function loadDriverLicensesView() {
  const body = document.getElementById("lic-renewals-body");
  const status = document.getElementById("lic-panel-status");
  if (!body) return;

  // Wipe synchronously so any mockup-rendered rows can't flash through
  // while the live select is in flight.
  body.innerHTML = `<div class="rr-loading">Loading</div>`;
  if (status) status.textContent = "—";
  // Renewal-reminder configuration moved to Settings → License renewals
  // and Schedule → Scheduling rules; this view just shows the renewal
  // queue.  Hydrate happens when the operator opens those panes.

  const { data: rows, error } = await sb.from("drivers")
    .select("id, full_name, station:station_id (code), dl_number, dl_expires_on, status")
    .eq("dsp_id", window.RR.dsp.id)
    .not("dl_expires_on", "is", null)
    .order("dl_expires_on", { ascending: true })
    .limit(500);

  if (error) {
    body.innerHTML = `<div style="padding:16px;color:var(--red);font-size:var(--fs-md)">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!rows || rows.length === 0) {
    body.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-subtle);font-size:var(--fs-md)">
      <strong style="color:var(--text-muted);display:block;margin-bottom:4px">No license dates on file</strong>
      Open a driver record → License tab to add a license number and expiration.
    </div>`;
    if (status) status.textContent = "0 drivers with licenses";
    return;
  }

  const today = Date.now();
  const expired = rows.filter(r => new Date(r.dl_expires_on).getTime() < today).length;
  const within30 = rows.filter(r => {
    const t = new Date(r.dl_expires_on).getTime();
    return t >= today && t < today + 30 * 86400000;
  }).length;
  if (status) status.textContent = `${expired} expired · ${within30} within 30 days · ${rows.length} total`;

  body.innerHTML = `
    <div class="card card-flush">
      <div style="display:grid;grid-template-columns:1fr 110px 110px 130px 90px;gap:12px;padding:10px 16px;background:var(--canvas);font-size:var(--fs-xs);font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted)">
        <div>Driver</div>
        <div>Station</div>
        <div>DL number</div>
        <div>Expires</div>
        <div></div>
      </div>
      ${rows.map(renderLicenseRow).join("")}
    </div>`;
}

function renderLicenseRow(d) {
  const exp = new Date(d.dl_expires_on);
  const days = Math.floor((exp.getTime() - Date.now()) / 86400000);
  // Don't tint the entire row anymore — operators found the orange/red
  // washes too noisy.  The pill on the right is enough warning.
  let pillStyle = "color:var(--text-subtle)";
  let label = `Expires in ${days}d`;
  if (days < 0) {
    pillStyle = "color:var(--red);font-weight:700";
    label = `Expired ${-days}d ago`;
  } else if (days <= 30) {
    pillStyle = "color:var(--amber-dark);font-weight:700";
    label = `Expires in ${days}d`;
  }
  const initials = displayDriverInitials(d);
  return `
    <div data-driver-id="${d.id}" data-rr-open-driver style="display:grid;grid-template-columns:1fr 110px 110px 130px 90px;gap:12px;padding:12px 16px;border-top:1px solid var(--border);align-items:center;cursor:pointer">
      <div style="display:flex;align-items:center;gap:10px">
        <div class="avatar-sm">${initials}</div>
        <div><div style="font-size:var(--fs-md);font-weight:600">${escapeHtml(displayDriverName(d))}</div></div>
      </div>
      <div style="font-size:var(--fs-md)">${escapeHtml(d.station?.code || "—")}</div>
      <div style="font-size:var(--fs-md);font-family:'SF Mono',Menlo,monospace">${escapeHtml(d.dl_number || "—")}</div>
      <div style="font-size:var(--fs-md)">${exp.toLocaleDateString()}<div style="font-size:var(--fs-xs);${pillStyle}">${label}</div></div>
      <div><button class="btn btn-sm" data-rr-open-driver data-driver-id="${d.id}">Edit</button></div>
    </div>`;
}

const _legacyDrSub = window.drSub;
window.drSub = function (sub) {
  // Close any open KPI drilldowns on subview navigation so they
  // don't reappear when the operator comes back to the page.
  if (typeof _closeAttKpiDetail === "function")     _closeAttKpiDetail();
  if (typeof _closeAvailKpiDetail === "function")   _closeAvailKpiDetail();
  if (typeof _closeRosterKpiDetail === "function")  _closeRosterKpiDetail();
  if (typeof _legacyDrSub === "function") _legacyDrSub(sub);
  if (sub === "licenses")     loadDriverLicensesView();
  if (sub === "roster")       loadDriversRoster();
  if (sub === "attendance")   { _rrApplyAttPolicyMode(); loadAttendanceLive(); _rrInitAttTabDnD(); }
  if (sub === "coaching")     loadCoachingFeed();
  if (sub === "availability") loadAvailabilityRequests();
  _swapDriversCta(sub);
};

// Swap the page-level CTA so it matches the active subnav. On Coaching,
// 'Add driver' becomes 'Coach a driver' and opens a driver picker that
// drops into the coaching log form for the chosen driver.
function _swapDriversCta(/* sub */) {
  // The Add driver button now lives in the Roster sub-tab's toolbar
  // (top-left of the table) and the Coach a driver button has its own
  // dedicated home in the Coaching sub-tab toolbar — no swap needed.
  // Function kept as a no-op so existing call sites don't throw.
}

// Wire the Coach a driver CTA in the Coaching sub-tab toolbar.
document.addEventListener("click", (e) => {
  if (e.target.closest("#rr-coach-cta")) {
    e.preventDefault();
    openCoachDriverPicker();
  }
});

// Driver picker → coaching log. Shown when the operator clicks 'Coach
// a driver' on Drivers > Coaching. Pick a driver from the list, modal
// closes, the coaching log form opens for that driver.
async function openCoachDriverPicker() {
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;

  const { data, error } = await sb.from("drivers")
    .select("id, full_name, preferred_name, station:station_id (code)")
    .eq("dsp_id", dspId)
    .in("status", ["active", "onboarding"])
    .order("full_name");
  if (error) { toast("Couldn't load drivers: " + error.message, "warn"); return; }
  const drivers = data || [];
  if (drivers.length === 0) {
    toast("Add a driver first, then come back here to coach them.", "warn");
    return;
  }

  const m = document.createElement("div");
  m.id = "rr-coach-picker";
  m.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px";
  m.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 18px 14px;max-width:440px;width:100%;max-height:80vh;display:flex;flex-direction:column">
      <h3 style="margin:0 0 10px;font-size:var(--fs-lg);font-weight:600">Coach a driver</h3>
      <input id="rr-coach-picker-search" type="text" placeholder="Search drivers…" class="form-input" style="margin-bottom:10px"/>
      <div id="rr-coach-picker-list" style="flex:1;overflow-y:auto;border:1px solid var(--border);border-radius:8px"></div>
      <div style="display:flex;justify-content:flex-end;margin-top:12px">
        <button class="btn" type="button" data-rr-coach-picker-cancel>Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(m);

  const list = m.querySelector("#rr-coach-picker-list");
  const renderList = (filter) => {
    const f = (filter || "").toLowerCase().trim();
    const matches = !f ? drivers : drivers.filter(d => {
      const name = (d.preferred_name || d.full_name || "").toLowerCase();
      return name.includes(f);
    });
    if (matches.length === 0) {
      list.innerHTML = `<div class="rr-empty-inline">No drivers match.</div>`;
      return;
    }
    list.innerHTML = matches.map(d => {
      const display = d.preferred_name || d.full_name || "—";
      const station = d.station?.code || "";
      return `<div class="rr-coach-pick" data-id="${d.id}" style="padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;justify-content:space-between;font-size:var(--fs-md)">
        <span><strong>${escapeHtml(display)}</strong>${station ? ` <span style="color:var(--text-subtle);font-weight:400;margin-left:6px">${escapeHtml(station)}</span>` : ""}</span>
        <span style="color:var(--text-subtle);font-size:var(--fs-xs)">Coach →</span>
      </div>`;
    }).join("");
  };
  renderList();

  m.querySelector("#rr-coach-picker-search").addEventListener("input", (e) => renderList(e.target.value));
  m.addEventListener("click", (e) => {
    if (e.target === m || e.target.closest("[data-rr-coach-picker-cancel]")) { m.remove(); return; }
    const pick = e.target.closest(".rr-coach-pick");
    if (pick) {
      const id = pick.getAttribute("data-id");
      m.remove();
      // Same coaching log flow used everywhere else (drawer, etc.).
      // _ddDriver isn't required for create-mode; openCoachingForm only
      // needs the driverId.
      if (typeof openCoachingForm === "function") openCoachingForm(id);
    }
  });
}


let _dowMath = null;
document.addEventListener("click", (e) => {
  if (!e.target.closest("#rr-di-dow-info")) return;
  e.preventDefault();
  const m = _dowMath;
  if (!m) return;
  const old = document.getElementById("rr-di-dow-popover");
  if (old) { old.remove(); return; }
  const DOW = ["mon","tue","wed","thu","fri","sat","sun"];
  const DOW_LABEL = { mon:"Mon", tue:"Tue", wed:"Wed", thu:"Thu", fri:"Fri", sat:"Sat", sun:"Sun" };
  const tableRows = DOW.map(d => {
    const tot = m.dowTotal[d], abs = m.dowAbsent[d];
    const rate = tot > 0 ? (abs / tot * 100).toFixed(1) : "—";
    // Neutral throughout — no stoplight tint on insight popovers.
    const color = "var(--text)";
    return `
    <tr>
      <td style="padding:5px 10px;border-bottom:1px solid var(--border)"><strong>${DOW_LABEL[d]}</strong></td>
      <td style="padding:5px 10px;border-bottom:1px solid var(--border);text-align:right">${tot}</td>
      <td style="padding:5px 10px;border-bottom:1px solid var(--border);text-align:right">${abs}</td>
      <td style="padding:5px 10px;border-bottom:1px solid var(--border);text-align:right;color:${color};font-weight:600">${tot > 0 ? rate + "%" : "—"}</td>
    </tr>`;
  }).join("");
  const pop = document.createElement("div");
  pop.id = "rr-di-dow-popover";
  pop.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px";
  pop.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:22px;max-width:520px;width:100%;font-size:var(--fs-md);line-height:1.55;color:var(--text);max-height:80vh;overflow-y:auto">
      <h3 style="margin:0 0 14px;font-size:var(--fs-lg);font-weight:600">Day-of-week absence · the math</h3>
      <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.05em;text-transform:uppercase;margin-bottom:6px">Window</div>
      <div>Last <strong>90 days</strong>. Each shift counted once on the day it was scheduled.</div>
      <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.05em;text-transform:uppercase;margin-top:14px;margin-bottom:6px">Definitions</div>
      <div>· <strong>Total</strong> = shifts that had any outcome (completed, late, called_off, no_show, vto). Pure 'scheduled' (not yet started) is excluded.</div>
      <div>· <strong>Absences</strong> = called_off + no_show only. VTO is operator-approved and doesn't count.</div>
      <div style="font-family:ui-monospace,monospace;font-size:var(--fs-xs);background:var(--canvas);padding:8px 10px;border-radius:4px;color:var(--text);margin-top:8px">% absent = absences ÷ total</div>
      <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.05em;text-transform:uppercase;margin-top:14px;margin-bottom:6px">By day</div>
      <table style="width:100%;border-collapse:collapse;font-size:var(--fs-sm);margin-top:6px">
        <thead>
          <tr>
            <th style="padding:6px 10px;text-align:left;background:var(--canvas);font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Day</th>
            <th style="padding:6px 10px;text-align:right;background:var(--canvas);font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Total</th>
            <th style="padding:6px 10px;text-align:right;background:var(--canvas);font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Absences</th>
            <th style="padding:6px 10px;text-align:right;background:var(--canvas);font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">% absent</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
      <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.05em;text-transform:uppercase;margin-top:14px;margin-bottom:6px">Color thresholds</div>
      <div>· <strong style="color:var(--red)">Red</strong> = ≥1.5× the overall rate (and >5%)</div>
      <div>· <strong style="color:var(--amber)">Amber</strong> = ≥1.2× the overall rate</div>
      <div>· <strong style="color:var(--green-bright)">Green</strong> = at or below the overall rate</div>
      <div>· <span style="color:var(--text-muted)">Grey</span> = no shifts on that day in the window</div>
      <div style="margin-top:18px;display:flex;justify-content:flex-end">
        <button class="btn btn-sm" type="button" id="rr-di-dow-popover-close">Close</button>
      </div>
    </div>`;
  pop.addEventListener("click", (ev) => {
    if (ev.target === pop || ev.target.id === "rr-di-dow-popover-close") pop.remove();
  });
  document.body.appendChild(pop);
});


// Renewal-reminder + license-block settings moved to:
//   Settings → License renewals  (auto-reminders, channels, days, template)
//   Schedule → Scheduling rules  (block scheduling past expiry)
// Both write the same dsps.metadata.licenses object so the existing
// background job keeps reading from one place.
function _rrPrefillLicenseSettings() {
  const lic = window.RR?.dsp?.metadata?.licenses || {};
  const setBool = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.checked = !!val;
  };
  // auto_reminders defaults ON when no record yet, to match the
  // previous mockup behavior.
  setBool("rr-lic-toggle-input",  lic.auto_reminders !== false);
  // Channels: default to SMS on (the historical channel) and in-app
  // off.  Operators opt into in-app explicitly.
  setBool("rr-lic-channel-sms",   lic.channel_sms   !== false);
  setBool("rr-lic-channel-inapp", lic.channel_inapp === true);
  // Block past expiry: false by default (was the legacy default too).
  setBool("rr-lic-block-input",   !!lic.block_past_expiry);

  const days = document.getElementById("rr-lic-days");
  if (days) days.value = Array.isArray(lic.reminder_days) ? lic.reminder_days.join(", ") : "30, 14";
  const tpl = document.getElementById("rr-lic-template");
  if (tpl && lic.sms_template) tpl.value = lic.sms_template;
}
// Hydrate when the operator opens Settings or Schedule rules.
document.addEventListener("click", (e) => {
  if (e.target.closest('.settings-nav-item[data-set="licenses"]') ||
      e.target.closest('[data-rr-nav-item="settings"]')           ||
      e.target.closest('a[href="#schedule"]')                     ||
      e.target.closest('[data-rr-rules-section="license-compliance"]')) {
    setTimeout(_rrPrefillLicenseSettings, 0);
  }
});
// Wrap goto so navigating to Settings or Schedule prefills too.
const _legacyGotoForLic = window.goto;
if (typeof _legacyGotoForLic === "function") {
  window.goto = function (view) {
    const r = _legacyGotoForLic(view);
    if (view === "settings" || view === "schedule") setTimeout(_rrPrefillLicenseSettings, 0);
    return r;
  };
}

document.addEventListener("click", async (e) => {
  if (!e.target.closest("[data-rr-lic-save]")) return;
  e.preventDefault();
  const status = document.getElementById("rr-lic-status");
  const setStatus = (text, kind) => {
    if (!status) return;
    status.style.color = kind === "warn" ? "var(--red)" : kind === "ok" ? "var(--green)" : "var(--text-subtle)";
    status.textContent = text;
  };
  const get = (id) => document.getElementById(id);
  const enabled  = get("rr-lic-toggle-input")?.checked;
  const sms      = get("rr-lic-channel-sms")?.checked;
  const inapp    = get("rr-lic-channel-inapp")?.checked;
  const daysRaw  = get("rr-lic-days")?.value || "";
  const template = get("rr-lic-template")?.value || "";
  const days = daysRaw.split(/[,\s]+/).map(s => parseInt(s, 10)).filter(n => Number.isFinite(n) && n > 0);

  setStatus("Saving…");
  const { data: dsp, error: rErr } = await sb.from("dsps").select("metadata").eq("id", window.RR.dsp.id).single();
  if (rErr) { setStatus(rErr.message, "warn"); return; }
  const md = dsp.metadata || {};
  md.licenses = {
    ...(md.licenses || {}),
    auto_reminders:    !!enabled,
    channel_sms:       !!sms,
    channel_inapp:     !!inapp,
    reminder_days:     days,
    sms_template:      template,
  };
  const { error: wErr } = await sb.from("dsps").update({ metadata: md }).eq("id", window.RR.dsp.id);
  if (wErr) { setStatus(wErr.message, "warn"); return; }
  window.RR.dsp.metadata = md;
  setStatus(`Saved at ${new Date().toLocaleTimeString()}`, "ok");
});

// Block-past-expiry toggle on the scheduling rules page is a one-shot
// save — flip and persist.
document.addEventListener("change", async (e) => {
  if (e.target?.id !== "rr-lic-block-input") return;
  const checked = !!e.target.checked;
  const { data: dsp } = await sb.from("dsps").select("metadata").eq("id", window.RR.dsp.id).single();
  const md = dsp?.metadata || {};
  md.licenses = { ...(md.licenses || {}), block_past_expiry: checked };
  const { error } = await sb.from("dsps").update({ metadata: md }).eq("id", window.RR.dsp.id);
  if (error) { toast("Couldn't save: " + error.message, "warn"); e.target.checked = !checked; return; }
  window.RR.dsp.metadata = md;
  toast(checked ? "Block scheduling past expiry: ON" : "Block scheduling past expiry: OFF", "success");
});

function renderDriverStatusBadge(s) {
  const map = {
    onboarding: { label: "Onboarding", style: "background:rgba(124,58,237,.14);color:#7C3AED" },
    active:     { label: "Active",     style: "background:var(--green-soft);color:var(--green)" },
    leave:      { label: "On leave",   style: "background:var(--amber-soft);color:var(--amber)" },
    inactive:   { label: "Inactive",   style: "background:var(--canvas);color:var(--text-subtle)" },
    terminated: { label: "Terminated", style: "background:var(--red-soft);color:var(--red)" },
  };
  const v = map[s] || { label: s, style: "" };
  return `<span class="tag" style="${v.style}">${v.label}</span>`;
}

// Roster turnover window — operator can switch via the small clock
// icon on the Turnover KPI tile. Persisted to localStorage so the
// choice carries across sessions.
const _RR_TURNOVER_TF_KEY = "rr.roster.turnover-tf";
let _rosterTurnoverDays = (() => {
  const v = parseInt(localStorage.getItem(_RR_TURNOVER_TF_KEY) || "30", 10);
  return [30, 90, 365].includes(v) ? v : 30;
})();
// Cached roster computation so the drilldown renderers don't redo
// the math.  Refreshed in refreshDriverStatRow().
let _rosterStats = null;

async function refreshDriverStatRow(rows) {
  // Active / onboarding / inactive counts.
  const counts = { active: 0, onboarding: 0, leave: 0, inactive: 0, terminated: 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  // On-leave drivers got their own tab (PR for LOA visibility), so the
  // legacy Inactive bucket no longer rolls them in.
  const inactiveTotal = (counts.inactive || 0) + (counts.terminated || 0);

  const atRiskCount = rows.filter(r => r.status === "active" && (r.score ?? 999) < 70).length;

  const tabCounts = {
    active:     counts.active,
    onboarding: counts.onboarding,
    atrisk:     atRiskCount,
    onleave:    counts.leave,
    inactive:   inactiveTotal,
  };
  Object.entries(tabCounts).forEach(([stage, n]) => {
    const el = document.querySelector(`.dr-subview .stage-tab[data-stage="${stage}"] .stage-tab-count`);
    if (el) el.textContent = n;
  });

  const scored = rows.filter(r => r.score != null);
  const avgScore = scored.length === 0
    ? "—"
    : Math.round(scored.reduce((s, r) => s + Number(r.score), 0) / scored.length);

  // Avg tenure (months) across active + onboarding drivers with hire dates.
  const todayMs = Date.now();
  const active = rows.filter(r => r.status === "active" || r.status === "onboarding");
  const totalActive = active.length;
  const tenureMonths = active
    .filter(d => d.hire_date)
    .map(d => (todayMs - new Date(d.hire_date + "T12:00:00").getTime()) / (1000 * 60 * 60 * 24 * 30.4375))
    .sort((a, b) => a - b);
  const avgTenure = tenureMonths.length
    ? tenureMonths.reduce((s, n) => s + n, 0) / tenureMonths.length
    : null;
  const medianTenure = tenureMonths.length
    ? tenureMonths[Math.floor(tenureMonths.length / 2)]
    : 0;
  const longestMonths = tenureMonths.length ? tenureMonths[tenureMonths.length - 1] : 0;

  // Turnover — terminations in the rolling window. The schema doesn't
  // track a terminated_at column; updated_at on a status='terminated'
  // row is the closest proxy.
  const winDays   = _rosterTurnoverDays;
  const winCutoff = new Date(todayMs - winDays * 86400000).toISOString();
  const priorCutoff = new Date(todayMs - winDays * 2 * 86400000).toISOString();
  const termsLastWin = rows.filter(r =>
    r.status === "terminated" && r.updated_at && r.updated_at >= winCutoff
  );
  const termsPriorWin = rows.filter(r => {
    if (r.status !== "terminated" || !r.updated_at) return false;
    return r.updated_at >= priorCutoff && r.updated_at < winCutoff;
  });
  const turnoverDenom = Math.max(1, totalActive + termsLastWin.length);
  const turnoverPct      = (termsLastWin.length  / turnoverDenom) * 100;
  const turnoverPriorPct = (termsPriorWin.length / turnoverDenom) * 100;
  const turnoverDelta    = turnoverPct - turnoverPriorPct;

  // Tenure buckets for the drilldown.
  const tenureBuckets = { "0-30": 0, "30-90": 0, "90-365": 0, "365-730": 0, "730plus": 0 };
  for (const d of active) {
    if (!d.hire_date) continue;
    const days = (todayMs - new Date(d.hire_date + "T12:00:00").getTime()) / 86400000;
    if      (days < 30)   tenureBuckets["0-30"]   += 1;
    else if (days < 90)   tenureBuckets["30-90"]  += 1;
    else if (days < 365)  tenureBuckets["90-365"] += 1;
    else if (days < 730)  tenureBuckets["365-730"]+= 1;
    else                  tenureBuckets["730plus"]+= 1;
  }

  // Score buckets for the Avg-score drilldown.
  const scoreBuckets = { "90+": 0, "80-89": 0, "70-79": 0, "50-69": 0, "lt50": 0 };
  for (const r of active) {
    const s = r.score;
    if (s == null || !Number.isFinite(Number(s))) continue;
    const v = Number(s);
    if      (v >= 90) scoreBuckets["90+"]   += 1;
    else if (v >= 80) scoreBuckets["80-89"] += 1;
    else if (v >= 70) scoreBuckets["70-79"] += 1;
    else if (v >= 50) scoreBuckets["50-69"] += 1;
    else              scoreBuckets["lt50"]  += 1;
  }
  // Top + bottom 5 by score, for the at-a-glance lists in the drilldown.
  const scoredActive = active.filter(d => d.score != null);
  const sortedByScore = scoredActive.slice().sort((a, b) => Number(b.score) - Number(a.score));
  const topFive = sortedByScore.slice(0, 5);
  const botFive = sortedByScore.slice(-5).reverse();

  // Stash everything the drilldowns need so they can render without
  // re-computing or re-fetching.
  _rosterStats = {
    totalActive, atRiskCount,
    avgScore, scoredCount: scored.length,
    scoreBuckets, topFive, botFive,
    tenureMonths, avgTenure, medianTenure, longestMonths,
    tenureBuckets,
    winDays,
    termsLastWin, termsPriorWin,
    turnoverPct, turnoverPriorPct, turnoverDelta,
  };

  const tiles = document.querySelectorAll(".driver-stat-row .stat-mini");
  if (tiles.length >= 5) {
    setStatTile(tiles[0], "Active", counts.active, `${counts.onboarding} onboarding · ${inactiveTotal} inactive`);
    setStatTile(tiles[1], "Avg score", avgScore,
      scored.length === 0 ? "No driver scores yet" : `Across ${scored.length} scored driver${scored.length === 1 ? "" : "s"}`);
    setStatTile(tiles[2], "At risk", atRiskCount, "Active drivers below 70");
    setStatTile(tiles[3], "Avg tenure",
      avgTenure == null ? "—" : `${avgTenure.toFixed(1)} mo`,
      avgTenure == null
        ? "Set hire dates to see tenure"
        : `Median ${medianTenure.toFixed(0)} mo · longest ${(longestMonths / 12).toFixed(1)} yr`);
    const winLabel = winDays === 365 ? "1 yr" : `${winDays}d`;
    setStatTile(tiles[4], "Turnover",
      `${turnoverPct.toFixed(0)}%`,
      termsLastWin.length === 0
        ? `0 terms in last ${winLabel}`
        : `${termsLastWin.length} term${termsLastWin.length === 1 ? "" : "s"} last ${winLabel} · ${turnoverDelta >= 0 ? "+" : ""}${turnoverDelta.toFixed(1)}% vs prior`);
  }

  // Re-render the open drilldown if one was active.
  if (_rosterKpiDetail) _renderRosterKpiDetail();
}

function setStatTile(tile, label, value, sub) {
  tile.querySelector(".stat-mini-label").textContent = label;
  const valEl = tile.querySelector(".stat-mini-value");
  valEl.textContent = value;
  valEl.style.color = "";
  const s = tile.querySelector(".stat-mini-sub");
  if (s) s.textContent = sub;
}

// ─── Roster KPI drill-down · Avg tenure + Turnover ─────────────────────
let _rosterKpiDetail = null;   // 'tenure' | 'turnover' | null

function _closeRosterKpiDetail() {
  _rosterKpiDetail = null;
  const panel = document.getElementById("rr-roster-kpi-detail");
  if (panel) { panel.style.display = "none"; panel.innerHTML = ""; }
  document.querySelectorAll("[data-rr-roster-kpi]").forEach(el => el.classList.remove("active"));
  // Close any open time-frame popover too.
  document.querySelectorAll(".rr-tf-popover").forEach(el => el.remove());
}

function _renderRosterKpiDetail() {
  const panel = document.getElementById("rr-roster-kpi-detail");
  if (!panel) return;
  document.querySelectorAll("[data-rr-roster-kpi]").forEach(el => {
    el.classList.toggle("active", el.dataset.rrRosterKpi === _rosterKpiDetail);
  });
  if (!_rosterKpiDetail || !_rosterStats) {
    panel.style.display = "none"; panel.innerHTML = "";
    return;
  }
  panel.style.display = "block";

  const s = _rosterStats;

  if (_rosterKpiDetail === "score") {
    // Score-distribution buckets + top + bottom drivers.  Score is a
    // 0–100 composite on drivers.score; we tier into 90+ / 80–89 /
    // 70–79 / 50–69 / <50 with brand-blue → red so the at-risk tail
    // is obvious.
    const order  = ["90+", "80-89", "70-79", "50-69", "lt50"];
    const labels = {
      "90+":   "90 – 100  · Top tier",
      "80-89": "80 – 89   · Strong",
      "70-79": "70 – 79   · Standard",
      "50-69": "50 – 69   · At risk",
      "lt50":  "Below 50  · Critical",
    };
    const colors = {
      "90+":   "var(--green)",
      "80-89": "var(--accent)",
      "70-79": "var(--text-muted)",
      "50-69": "var(--amber)",
      "lt50":  "var(--red)",
    };
    const buckets = s.scoreBuckets;
    const total = order.reduce((sum, k) => sum + (buckets[k] || 0), 0);
    const max   = Math.max(1, ...order.map(k => buckets[k] || 0));
    const bars  = order.map(k => {
      const n   = buckets[k] || 0;
      const pct = total ? Math.round((n / total) * 100) : 0;
      const w   = (n / max) * 100;
      return `<div style="display:grid;grid-template-columns:200px 1fr 90px;gap:14px;align-items:center;padding:8px 0">
        <div style="font-size:var(--fs-sm);font-weight:600;color:var(--text);font-variant-numeric:tabular-nums">${labels[k]}</div>
        <div style="background:var(--canvas);border-radius:6px;height:14px;overflow:hidden;border:1px solid var(--border)">
          <div style="background:${colors[k]};height:100%;width:${w.toFixed(1)}%;transition:width .3s"></div>
        </div>
        <div style="font-size:var(--fs-sm);color:var(--text-muted);text-align:right"><strong style="color:var(--text)">${n}</strong> · ${pct}%</div>
      </div>`;
    }).join("");

    const driverRow = (r, color) => {
      const name = rrTitleCaseName(displayDriverName(r) || r.full_name || "Driver");
      const station = r.station?.code || "—";
      return `<div style="display:grid;grid-template-columns:1fr 80px 60px;gap:12px;align-items:center;padding:6px 0;border-top:1px solid var(--border);font-size:var(--fs-sm)">
        <div style="font-weight:600;color:var(--text)">${escapeHtml(name)}</div>
        <div style="color:var(--text-muted)">${escapeHtml(station)}</div>
        <div style="text-align:right;font-weight:700;color:${color};font-variant-numeric:tabular-nums">${Number(r.score).toFixed(0)}</div>
      </div>`;
    };
    const topList = s.topFive.length === 0
      ? `<div class="rr-empty-inline" style="padding:14px 0">No scored drivers yet.</div>`
      : s.topFive.map(r => driverRow(r, "var(--green)")).join("");
    const botList = s.botFive.length === 0
      ? `<div class="rr-empty-inline" style="padding:14px 0">No scored drivers yet.</div>`
      : s.botFive.map(r => driverRow(r, Number(r.score) < 70 ? "var(--red)" : "var(--text)")).join("");

    panel.innerHTML = `<div class="card" style="padding:var(--s-5)">
      <div style="margin-bottom:var(--s-4)">
        <div style="font-size:var(--fs-lg);font-weight:700;color:var(--text);letter-spacing:-.01em">Avg score · distribution</div>
        <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">Fleet average is ${s.avgScore} across ${s.scoredCount} scored driver${s.scoredCount === 1 ? "" : "s"}. Bars show how the team splits across performance tiers.</div>
      </div>
      ${bars}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--s-4);margin-top:var(--s-4);padding-top:var(--s-3);border-top:1px solid var(--border)">
        <div>
          <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase;margin-bottom:8px">Top 5</div>
          ${topList}
        </div>
        <div>
          <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase;margin-bottom:8px">Bottom 5</div>
          ${botList}
        </div>
      </div>
    </div>`;
    return;
  }

  if (_rosterKpiDetail === "tenure") {
    // Tenure-distribution bar chart — same buckets the old Insights
    // page used so operators see the histogram they're used to.
    const order = ["0-30", "30-90", "90-365", "365-730", "730plus"];
    const labels = {
      "0-30":    "First 30 days",
      "30-90":   "30 – 90 days",
      "90-365":  "90 days – 1 year",
      "365-730": "1 – 2 years",
      "730plus": "2+ years",
    };
    const max = Math.max(1, ...order.map(k => s.tenureBuckets[k] || 0));
    const total = order.reduce((sum, k) => sum + (s.tenureBuckets[k] || 0), 0);
    const rows = order.map(k => {
      const n = s.tenureBuckets[k] || 0;
      const pct = total ? Math.round((n / total) * 100) : 0;
      const w = (n / max) * 100;
      return `<div style="display:grid;grid-template-columns:160px 1fr 90px;gap:14px;align-items:center;padding:8px 0">
        <div style="font-size:var(--fs-sm);font-weight:600;color:var(--text)">${labels[k]}</div>
        <div style="background:var(--canvas);border-radius:6px;height:14px;overflow:hidden;border:1px solid var(--border)">
          <div style="background:var(--accent);height:100%;width:${w.toFixed(1)}%;transition:width .3s"></div>
        </div>
        <div style="font-size:var(--fs-sm);color:var(--text-muted);text-align:right"><strong style="color:var(--text)">${n}</strong> · ${pct}%</div>
      </div>`;
    }).join("");
    panel.innerHTML = `<div class="card" style="padding:var(--s-5)">
      <div style="margin-bottom:var(--s-3)">
        <div style="font-size:var(--fs-lg);font-weight:700;color:var(--text);letter-spacing:-.01em">Tenure distribution</div>
        <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">Active + onboarding drivers grouped by how long they've been on the team. Avg ${s.avgTenure == null ? "—" : s.avgTenure.toFixed(1) + " mo"} · median ${s.medianTenure.toFixed(0)} mo.</div>
      </div>
      ${rows}
    </div>`;
    return;
  }

  if (_rosterKpiDetail === "turnover") {
    // Turnover-source breakdown.  We surface the actual termination
    // events in the window plus a quick station + tenure-at-departure
    // breakdown so the operator can see *where* the bulk is coming from.
    const winLabel = s.winDays === 365 ? "the last year" : `the last ${s.winDays} days`;
    const terms = s.termsLastWin || [];

    // Tenure-at-termination buckets — answers "are we losing rookies
    // or veterans?". Uses hire_date → updated_at gap.
    const buckets = { "0-30": 0, "30-90": 0, "90-365": 0, "365plus": 0, "no_hire": 0 };
    const stationCounts = new Map();
    for (const t of terms) {
      const stationCode = t.station?.code || "—";
      stationCounts.set(stationCode, (stationCounts.get(stationCode) || 0) + 1);
      if (!t.hire_date) { buckets["no_hire"]++; continue; }
      const daysAtTerm = (new Date(t.updated_at).getTime() - new Date(t.hire_date + "T12:00:00").getTime()) / 86400000;
      if      (daysAtTerm < 30)  buckets["0-30"]++;
      else if (daysAtTerm < 90)  buckets["30-90"]++;
      else if (daysAtTerm < 365) buckets["90-365"]++;
      else                       buckets["365plus"]++;
    }

    // Recent terminations list (most-recent first, capped at 8).
    const recent = terms
      .slice()
      .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""))
      .slice(0, 8);
    const recentRows = recent.length === 0
      ? `<div class="rr-empty-inline" style="padding:24px 0">No terminations in ${winLabel} — that's the best read on retention.</div>`
      : recent.map(t => {
          const tenureAtTerm = t.hire_date
            ? Math.floor((new Date(t.updated_at).getTime() - new Date(t.hire_date + "T12:00:00").getTime()) / 86400000)
            : null;
          const ago = Math.floor((Date.now() - new Date(t.updated_at).getTime()) / 86400000);
          const display = rrTitleCaseName(displayDriverName(t) || t.full_name || "Driver");
          return `<div style="display:grid;grid-template-columns:1fr 100px 110px 80px;gap:14px;align-items:center;padding:8px 0;border-top:1px solid var(--border);font-size:var(--fs-sm)">
            <div style="font-weight:600;color:var(--text)">${escapeHtml(display)}</div>
            <div style="color:var(--text-muted)">${escapeHtml(t.station?.code || "—")}</div>
            <div style="color:var(--text-muted)">${tenureAtTerm == null ? "—" : tenureAtTerm + "d at term"}</div>
            <div style="color:var(--text-subtle);text-align:right">${ago}d ago</div>
          </div>`;
        }).join("");

    // Tenure-at-termination bars.
    const bktOrder = ["0-30", "30-90", "90-365", "365plus", "no_hire"];
    const bktLabel = {
      "0-30":    "Lost in first 30 days",
      "30-90":   "Lost 30 – 90 days in",
      "90-365":  "Lost 90 days – 1 year in",
      "365plus": "Lost after 1+ year",
      "no_hire": "No hire date on file",
    };
    const bktTotal = bktOrder.reduce((sum, k) => sum + buckets[k], 0);
    const bktMax   = Math.max(1, ...bktOrder.map(k => buckets[k]));
    const bktBars = bktOrder.map(k => {
      const n = buckets[k];
      if (n === 0 && k === "no_hire") return "";
      const pct = bktTotal ? Math.round((n / bktTotal) * 100) : 0;
      const w   = (n / bktMax) * 100;
      const isRookie = k === "0-30" || k === "30-90";
      return `<div style="display:grid;grid-template-columns:200px 1fr 80px;gap:14px;align-items:center;padding:6px 0">
        <div style="font-size:var(--fs-sm);font-weight:600;color:var(--text)">${bktLabel[k]}</div>
        <div style="background:var(--canvas);border-radius:6px;height:12px;overflow:hidden;border:1px solid var(--border)">
          <div style="background:${isRookie ? "var(--red)" : "var(--accent)"};height:100%;width:${w.toFixed(1)}%;transition:width .3s"></div>
        </div>
        <div style="font-size:var(--fs-sm);color:var(--text-muted);text-align:right"><strong style="color:var(--text)">${n}</strong> · ${pct}%</div>
      </div>`;
    }).join("");

    // Station breakdown.
    const stationRows = [...stationCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([code, n]) => {
        const pct = bktTotal ? Math.round((n / bktTotal) * 100) : 0;
        return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--border);font-size:var(--fs-sm)">
          <span style="font-weight:600">${escapeHtml(code)}</span>
          <span style="color:var(--text-muted)"><strong style="color:var(--text)">${n}</strong> · ${pct}%</span>
        </div>`;
      }).join("");

    panel.innerHTML = `<div class="card" style="padding:var(--s-5)">
      <div style="margin-bottom:var(--s-4)">
        <div style="font-size:var(--fs-lg);font-weight:700;color:var(--text);letter-spacing:-.01em">Where the turnover is coming from</div>
        <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">${terms.length} termination${terms.length === 1 ? "" : "s"} across ${winLabel}. Use the clock icon on the KPI tile to switch the window.</div>
      </div>

      ${terms.length > 0 ? `
      <div style="display:grid;grid-template-columns:2fr 1fr;gap:var(--s-4)">
        <div>
          <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase;margin-bottom:8px">Tenure at termination</div>
          ${bktBars}
          <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:8px;line-height:1.5">Red bars = early-tenure attrition. Concentrated red usually points to onboarding / fit issues; concentrated blue points to long-tenure burnout or coaching gaps.</div>
        </div>
        <div>
          <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase;margin-bottom:8px">By station</div>
          ${stationRows}
        </div>
      </div>

      <div style="margin-top:var(--s-4);padding-top:var(--s-3);border-top:1px solid var(--border)">
        <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase;margin-bottom:8px">Recent terminations</div>
        ${recentRows}
      </div>` : recentRows}
    </div>`;
    return;
  }
}

// Click handler for the Roster KPI tiles.
document.addEventListener("click", (e) => {
  // Time-frame icon — open / close the popover.
  const tfBtn = e.target.closest("[data-rr-roster-tf-toggle]");
  if (tfBtn) {
    e.stopPropagation();
    e.preventDefault();
    const tile = tfBtn.closest(".stat-mini");
    if (!tile) return;
    const existing = tile.querySelector(".rr-tf-popover");
    if (existing) { existing.remove(); return; }
    // Close any other open popovers.
    document.querySelectorAll(".rr-tf-popover").forEach(el => el.remove());
    const opts = [{ d: 30, l: "30 days" }, { d: 90, l: "90 days" }, { d: 365, l: "1 year" }];
    const pop = document.createElement("div");
    pop.className = "rr-tf-popover";
    pop.innerHTML = opts.map(o =>
      `<button data-rr-roster-tf="${o.d}" class="${o.d === _rosterTurnoverDays ? "active" : ""}">${o.l}</button>`
    ).join("");
    tile.appendChild(pop);
    return;
  }
  // Time-frame option click.
  const tfOpt = e.target.closest("[data-rr-roster-tf]");
  if (tfOpt) {
    _rosterTurnoverDays = parseInt(tfOpt.dataset.rrRosterTf, 10) || 30;
    try { localStorage.setItem(_RR_TURNOVER_TF_KEY, String(_rosterTurnoverDays)); } catch {}
    document.querySelectorAll(".rr-tf-popover").forEach(el => el.remove());
    if (typeof refreshDriverStatRow === "function" && Array.isArray(_rosterRows)) {
      refreshDriverStatRow(_rosterRows);
    }
    return;
  }
  // Click outside any popover closes them.
  if (!e.target.closest(".rr-tf-icon, .rr-tf-popover")) {
    document.querySelectorAll(".rr-tf-popover").forEach(el => el.remove());
  }
  // KPI tile click → open / toggle drilldown.
  const card = e.target.closest("[data-rr-roster-kpi]");
  if (!card) return;
  const kpi = card.dataset.rrRosterKpi;
  _rosterKpiDetail = (_rosterKpiDetail === kpi) ? null : kpi;
  _renderRosterKpiDetail();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const card = e.target.closest("[data-rr-roster-kpi]");
  if (!card) return;
  e.preventDefault();
  card.click();
});

function tenureLabel(hireDate) {
  const d = new Date(hireDate);
  if (isNaN(d)) return "—";
  const months = Math.max(0, Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30)));
  if (months < 1) {
    const days = Math.max(0, Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24)));
    return `${days}d`;
  }
  return `${months} mo`;
}

// Show the driver's preferred first name (when set) followed by last_name.
// Falls back to first_name → full_name. Used everywhere drivers are listed.
function displayDriverName(d) {
  const pref = (d?.preferred_name || "").trim();
  const first = pref || (d?.first_name || "").trim();
  const last  = (d?.last_name || "").trim();
  if (first && last) return `${first} ${last}`;
  return (first || last || (d?.full_name || "")).trim();
}
function displayDriverInitials(d) {
  const pref = (d?.preferred_name || "").trim();
  const first = pref || (d?.first_name || "").trim();
  const last  = (d?.last_name || "").trim();
  if (first || last) {
    const a = first[0] || "";
    const b = last[0]  || "";
    return (a + b).toUpperCase() || "?";
  }
  return (d?.full_name || "").split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
}

// ─── Add applicant ─────────────────────────────────────────────────────────
//
// We bind via event delegation on a data-attribute, not by overriding the
// mockup's window.submitAddApplicant(). Module top-level await means the
// global override happens later than DOM-paint, and inline onclick handlers
// would fire the mockup stub if the user clicked early.

async function doAddApplicant() {
  const fn    = document.getElementById("aa-fn").value.trim();
  const ln    = document.getElementById("aa-ln").value.trim();
  const phone = document.getElementById("aa-phone").value.trim();
  const email = document.getElementById("aa-email").value.trim();
  const source = (document.querySelector("#modal-add-applicant .cd-pill.active")?.textContent || "Indeed").toLowerCase();

  if (!fn && !ln) { toast("Add a name first", "warn"); return; }
  if (!phone && !email) { toast("Phone or email required", "warn"); return; }

  const payload = {
    dsp_short_code: window.RR.dsp.short_code,
    first_name: fn || null,
    last_name:  ln || null,
    full_name:  `${fn} ${ln}`.trim(),
    phone:      phone ? toE164(phone) : null,
    email:      email || null,
    source,
    force_new:  true,
  };

  const { data: applicant, error } = await sb.rpc("intake_applicant", { p_payload: payload });
  if (error) { toast("Add failed: " + error.message, "warn"); return; }

  if ((applicant.phone || applicant.email) && applicant.status === "applied") {
    await sb.rpc("send_screening_link", { p_id: applicant.id });
  }

  closeModal("modal-add-applicant");
  await loadPipeline("all");
  toast(`${rrTitleCaseName(applicant.full_name)} added · screening invite queued`, "success");
}

// ─── Add driver ────────────────────────────────────────────────────────────
//
// Mockup's submitAddDriver() and modal-add-driver were a simple form. We
// route the Drivers-page "Add driver" button to the same rich driver-record
// drawer used for editing — but in CREATE mode (no driverId). On save we
// insert directly into public.drivers (the update_driver_record RPC doesn't
// accept station_id today, so create mode bypasses it).

const _originalOpenModal = window.openModal;
window.openModal = function (id) {
  if (id === "modal-add-driver") { openDriverDrawer(null); return; }
  if (typeof _originalOpenModal === "function") _originalOpenModal(id);
  if (id === "modal-broadcast") { _initBroadcastModal(); }
};

// ─── Broadcast (one-message-to-many) ──────────────────────────────
// The modal markup is fully styled but every audience pill, count, and
// the Send button were hardcoded mockup behavior.  This swaps the
// audience pills with live station counts, tracks the operator's
// selection, and rewires the Send button to actually fan a single
// message out to every targeted driver via dispatch_chat_send (which
// already handles SMS + push fan-out through the existing chat infra).
let _broadcastDrivers = []; // [{id, station_id, station_code}]
let _broadcastAudience = "all"; // "all" | "station:<id>"

async function _initBroadcastModal() {
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;

  const { data, error } = await sb.from("drivers")
    .select("id, status, station_id, station:station_id (code)")
    .eq("dsp_id", dspId)
    .in("status", ["active", "onboarding"]);
  if (error) { toast("Couldn't load drivers: " + error.message, "warn"); return; }

  _broadcastDrivers = (data || []).map(d => ({
    id:           d.id,
    station_id:   d.station_id || null,
    station_code: d.station?.code || null,
  }));
  _broadcastAudience = "all";

  // Group drivers by station for per-station pill counts.
  const byStation = new Map();
  for (const d of _broadcastDrivers) {
    if (!d.station_id) continue;
    if (!byStation.has(d.station_id)) {
      byStation.set(d.station_id, { id: d.station_id, code: d.station_code, count: 0 });
    }
    byStation.get(d.station_id).count++;
  }
  const stations = Array.from(byStation.values()).sort((a, b) => (a.code || "").localeCompare(b.code || ""));

  // Replace the static audience pill row + count line with live data.
  const modal = document.getElementById("modal-broadcast");
  if (!modal) return;
  const pillRow = modal.querySelector(".aud-pill-row");
  if (pillRow) {
    pillRow.innerHTML =
      `<button class="aud-pill active" data-rr-bcast-aud="all">All drivers (${_broadcastDrivers.length})</button>` +
      stations.map(s => `<button class="aud-pill" data-rr-bcast-aud="station:${escapeHtml(s.id)}">${escapeHtml(s.code || "—")} (${s.count})</button>`).join("");
    pillRow.querySelectorAll("[data-rr-bcast-aud]").forEach(btn => {
      btn.addEventListener("click", () => {
        pillRow.querySelectorAll(".aud-pill").forEach(p => p.classList.remove("active"));
        btn.classList.add("active");
        _broadcastAudience = btn.dataset.rrBcastAud;
        _updateBroadcastCount();
      });
    });
  }

  _updateBroadcastCount();

  // Replace the Send button's mockup onclick with the real sender.
  const sendBtn = modal.querySelector(".modal-foot .btn-primary");
  if (sendBtn) {
    sendBtn.onclick = _sendBroadcast;
  }
}

function _broadcastSelectedDrivers() {
  if (_broadcastAudience === "all") return _broadcastDrivers;
  if (_broadcastAudience.startsWith("station:")) {
    const sid = _broadcastAudience.slice("station:".length);
    return _broadcastDrivers.filter(d => d.station_id === sid);
  }
  return [];
}

function _updateBroadcastCount() {
  const modal = document.getElementById("modal-broadcast");
  const countEl = modal?.querySelector(".aud-count strong");
  if (!countEl) return;
  const n = _broadcastSelectedDrivers().length;
  countEl.textContent = `${n} driver${n === 1 ? "" : "s"}`;
  // The "X currently online" count was a mockup figure; drop it now
  // that the rest of the line is live.
  const parent = modal.querySelector(".aud-count");
  if (parent) {
    const trailing = parent.lastChild;
    if (trailing && trailing.nodeType === Node.TEXT_NODE && trailing.textContent.includes("online")) {
      trailing.textContent = " · sent via in-app + SMS";
    }
  }
}

async function _sendBroadcast() {
  const modal = document.getElementById("modal-broadcast");
  if (!modal) return;
  const ta = document.getElementById("bcast-msg");
  const body = (ta?.value || "").trim();
  if (!body) { toast("Type a message first", "warn"); return; }

  const targets = _broadcastSelectedDrivers();
  if (targets.length === 0) { toast("No drivers in the selected audience", "warn"); return; }
  if (!confirm(`Send this broadcast to ${targets.length} driver${targets.length === 1 ? "" : "s"}?`)) return;

  const sendBtn = modal.querySelector(".modal-foot .btn-primary");
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = "Sending…"; }

  let sent = 0, failed = 0;
  for (const d of targets) {
    const { error } = await sb.rpc("dispatch_chat_send", { p_driver_id: d.id, p_body: body });
    if (error) failed++; else sent++;
  }

  if (sendBtn) { sendBtn.disabled = false; sendBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Send broadcast`; }
  if (typeof closeModal === "function") closeModal("modal-broadcast");
  if (ta) ta.value = "";
  if (failed === 0) toast(`Broadcast sent to ${sent} driver${sent === 1 ? "" : "s"}`, "success");
  else              toast(`Broadcast sent to ${sent} of ${targets.length} drivers · ${failed} failed`, "warn");
}

let _driverStationsCache = null;
async function getDriverStationsCached() {
  if (_driverStationsCache) return _driverStationsCache;
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return [];
  const { data, error } = await sb.from("stations")
    .select("id, code, name, active")
    .eq("dsp_id", dspId)
    .eq("active", true)
    .order("code");
  if (error) { console.warn("stations load:", error.message); return []; }
  _driverStationsCache = data || [];
  return _driverStationsCache;
}

// ─── Bulk ingest (paste from Indeed CSV/TSV) ───────────────────────────────
//
// Accepts tab-OR comma-delimited paste with a header row. Maps any of
// these header labels to our fields:
//   name     ← "name", "applicant name", "full name", "candidate name"
//   first    ← "first name", "first", "given name"
//   last     ← "last name", "last", "surname", "family name"
//   email    ← "email", "email address", "e-mail"
//   phone    ← "phone", "phone number", "mobile", "cell"
//
// At minimum we need (name OR first+last) and (phone OR email). Rows
// missing both are skipped with a counter shown in the result toast.

function parseBulkText(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return { rows: [], skipped: 0, headers: [] };

  // Detect delimiter: tab if any tab in header, else comma.
  const delim = lines[0].includes("\t") ? "\t" : ",";
  const headers = splitCsv(lines[0], delim).map(h => h.toLowerCase().trim());

  const idx = (...names) => headers.findIndex(h => names.some(n => h === n || h.includes(n)));
  const iName  = idx("applicant name", "candidate name", "full name", "name");
  const iFirst = idx("first name", "first", "given");
  const iLast  = idx("last name", "last", "surname", "family");
  const iEmail = idx("email address", "e-mail", "email");
  const iPhone = idx("phone number", "phone", "mobile", "cell");

  const rows = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsv(lines[i], delim);
    let first = iFirst >= 0 ? cols[iFirst]?.trim() : "";
    let last  = iLast  >= 0 ? cols[iLast]?.trim()  : "";
    const fullName = iName >= 0 ? cols[iName]?.trim() : "";

    if (!first && !last && fullName) {
      const parts = fullName.split(/\s+/);
      first = parts[0] || "";
      last  = parts.slice(1).join(" ");
    }
    const full = (fullName || `${first} ${last}`).trim();

    const email = iEmail >= 0 ? cols[iEmail]?.trim() : "";
    const phone = iPhone >= 0 ? cols[iPhone]?.trim() : "";

    if (!full)        { skipped++; continue; }
    if (!email && !phone) { skipped++; continue; }

    rows.push({
      first_name: first || null,
      last_name:  last  || null,
      full_name:  full,
      email:      email || null,
      phone:      phone ? toE164(phone) : null,
    });
  }
  return { rows, skipped, headers };
}

// Minimal CSV splitter: handles double-quoted fields with embedded commas.
function splitCsv(line, delim) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === delim && !inQ) {
      out.push(cur); cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

// Loose phone normalizer → E.164. Stored as +1XXXXXXXXXX for US numbers,
// otherwise passes through anything already starting with +.
function toE164(raw) {
  const digits = String(raw).replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return digits ? "+" + digits : null;
}

async function doBulkIngest() {
  const text = document.getElementById("bi-paste").value;
  const { rows, skipped } = parseBulkText(text);
  if (rows.length === 0) {
    toast(`No importable rows. Need a header row with at least name + phone or email.`, "warn");
    return;
  }

  const btn = document.getElementById("bi-import-btn");
  btn.disabled = true;
  btn.textContent = `Importing 0 / ${rows.length}…`;

  let added = 0, dupes = 0, failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    btn.textContent = `Importing ${i + 1} / ${rows.length}…`;
    try {
      const { data: existing } = await sb.from("applicants")
        .select("id").eq("dsp_id", window.RR.dsp.id)
        .or(`email.eq.${row.email ?? "__none__"},phone.eq.${row.phone ?? "__none__"}`).limit(1);

      const { data: applicant, error } = await sb.rpc("intake_applicant", {
        p_payload: {
          dsp_short_code: window.RR.dsp.short_code,
          source: "indeed",
          ...row,
        },
      });
      if (error) { failed++; continue; }

      if (existing && existing.length > 0 && existing[0].id === applicant.id) {
        dupes++;
      } else {
        added++;
        if ((applicant.phone || applicant.email) && applicant.status === "applied") {
          await sb.rpc("send_screening_link", { p_id: applicant.id });
        }
      }
    } catch {
      failed++;
    }
  }

  closeModal("modal-bulk-ingest");
  await loadPipeline("all");
  toast(`Imported ${added} · ${dupes} duplicates · ${failed} failed${skipped ? ` · ${skipped} unparseable rows skipped` : ""}`,
    failed ? "warn" : "success");
}

// Capture-phase delegate for the two import buttons. Capture phase
// + stopImmediatePropagation guarantees we win even if the mockup's
// inline onclick somehow re-attaches.
document.addEventListener("click", (e) => {
  const add = e.target.closest("[data-rr-add-applicant]");
  if (add) {
    e.preventDefault();
    e.stopImmediatePropagation();
    doAddApplicant();
    return;
  }
  const bulk = e.target.closest("[data-rr-bulk-ingest]");
  if (bulk) {
    if (bulk.disabled) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    doBulkIngest();
  }
}, true);

// Sign-out hook: any element with [data-rr-signout] logs out.
document.addEventListener("click", async (e) => {
  if (e.target.closest("[data-rr-signout]")) {
    e.preventDefault();
    await sb.auth.signOut();
    location.replace("./login.html");
  }
});

// ─── Pipeline KPIs ─────────────────────────────────────────────────────────
//
// Hits the pipeline_kpis RPC and updates the Pipeline page's hp-show-rate /
// hp-hire-rate cells. RPC returns 0.75 / 0.75 fallback until the first
// interview day is closed; after that, rolling 30-day actuals.

// Selected lookback window for the KPI strip. Defaults to 4 weeks; the
// segmented control above the strip toggles between 7 / 28 / 3650.
let _kpiWindowDays = 28;

async function loadPipelineKpis() {
  syncKpiWindowToggle();

  const [{ data: kpi }, { data: funnel }] = await Promise.all([
    sb.rpc("pipeline_kpis",        { p_window_days: _kpiWindowDays }),
    sb.rpc("pipeline_funnel_kpis", { p_window_days: _kpiWindowDays }),
  ]);

  if (kpi) {
    setText("hp-show-rate", Math.round(Number(kpi.show_rate ?? 0) * 100));
    setText("hp-hire-rate", Math.round(Number(kpi.hire_rate ?? 0) * 100));
  }

  if (funnel) {
    setText("hp-contacted-pct", funnel.contacted_pct ?? 0);
    setText("hp-passed-pct",    funnel.passed_pct ?? 0);
    setText("hp-booked-pct",    funnel.booked_rate ?? 0);
    setText("hp-e2e",           funnel.e2e_pct ?? 0);
    const bsub = document.getElementById("hp-booked-sub");
    if (bsub) bsub.textContent = `${funnel.booked ?? 0} of ${funnel.invited ?? 0} sent a booking link`;
    const esub = document.getElementById("hp-e2e-sub");
    if (esub) esub.textContent = `${funnel.hired ?? 0} hired ÷ ${funnel.total ?? 0} applicants`;
  }

  // Page sub-line: live applicant count (open pipeline, not closed).
  const pageSub = document.getElementById("rr-pipeline-page-sub");
  if (pageSub) {
    const total = funnel?.total ?? 0;
    pageSub.textContent = total === 0
      ? "No applicants in the pipeline yet"
      : `${total} applicant${total === 1 ? "" : "s"} in the pipeline`;
  }

  renderWeeksStrip();
}

function syncKpiWindowToggle() {
  document.querySelectorAll("[data-rr-window]").forEach((b) => {
    b.classList.toggle("active", parseInt(b.getAttribute("data-rr-window"), 10) === _kpiWindowDays);
  });
}

// Capture-phase delegate for the window toggle.
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-rr-window]");
  if (!btn) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  _kpiWindowDays = parseInt(btn.getAttribute("data-rr-window"), 10) || 28;
  loadPipelineKpis();
}, true);


// ─── Dynamic 5-week strip ──────────────────────────────────────────────────
//
// Renders the next five upcoming weeks (does NOT include the current week —
// that belongs to the Schedule view). Auto-refreshes at the Sunday→Monday
// rollover so dashboards left open across midnight don't drift.

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

let _weeksStripRolloverTimer = null;
function _scheduleWeeksStripRollover() {
  if (_weeksStripRolloverTimer) clearTimeout(_weeksStripRolloverTimer);
  const now = new Date();
  const next = new Date(now);
  const day = now.getDay();
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7 || 7;
  next.setDate(now.getDate() + daysUntilMonday);
  next.setHours(0, 0, 1, 0);
  const ms = Math.max(60_000, next - now);
  _weeksStripRolloverTimer = setTimeout(() => {
    _weeksStripRolloverTimer = null;
    if (document.getElementById("hp-weeks-strip")) renderWeeksStrip();
  }, ms);
}

async function renderWeeksStrip() {
  const strip = document.getElementById("hp-weeks-strip");
  if (!strip) return;
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;

  // Start from NEXT Monday — current week lives in the Schedule view.
  const thisMonday = startOfWeekMonday(new Date());
  const monday = addDays(thisMonday, 7);
  const startIso = fmtIsoDate(monday);
  _scheduleWeeksStripRollover();

  // Build placeholders only on the very first paint so the strip never
  // shows mockup data while the live query is in flight. On re-renders
  // (30s refresh tick, Realtime change) we leave the existing real
  // values in place and overwrite once the new data arrives — without
  // this, every refresh produced a visible flicker as the cells went
  // "— / —" and back.
  if (!strip.dataset.rrLoaded) {
    const placeholderWeeks = Array.from({ length: 5 }, (_, i) => isoWeek(addDays(monday, i * 7)));
    strip.innerHTML = `<span class="hp-weeks-strip-label">Next 5 weeks</span>
      <div class="hp-weeks-row">${placeholderWeeks.map(n =>
        `<div class="hp-week-cell"><span class="wk">W${n}</span><span class="ratio" style="color:var(--text-subtle)">— / —</span><span class="gap">&nbsp;</span></div>`
      ).join("")}</div>`;
  }

  // Pull 5 weeks of okami_grid + active driver count.
  const [gridRes, drvRes] = await Promise.all([
    sb.rpc("okami_grid", { p_start: startIso, p_weeks: 5 }),
    sb.from("drivers")
      .select("id, status", { count: "exact", head: true })
      .eq("dsp_id", dspId)
      .in("status", ["active", "onboarding"]),
  ]);
  if (gridRes.error) { console.warn("weeks strip:", gridRes.error.message); return; }

  const cells = gridRes.data || [];
  const available = drvRes.count || 0;
  const dpr = parseFloat(document.getElementById("okami-dpr")?.value) || 2.0;

  // Group target_routes per (date) summed across stations.
  const targetByDate = new Map();
  for (const c of cells) {
    targetByDate.set(c.date, (targetByDate.get(c.date) || 0) + (c.target_routes || 0));
  }

  const out = [];
  for (let w = 0; w < 5; w++) {
    const wkStart = addDays(monday, w * 7);
    let routesMax = 0;
    for (let d = 0; d < 7; d++) {
      const t = targetByDate.get(fmtIsoDate(addDays(wkStart, d))) || 0;
      if (t > routesMax) routesMax = t;
    }
    const wkLabel = `W${isoWeek(wkStart)}`;
    if (routesMax === 0) {
      // OKAMI hasn't been set for this week yet. Be explicit instead of
      // showing "5 / 0 +5" which reads like canned data.
      out.push(`<div class="hp-week-cell"><span class="wk">${wkLabel}</span><span class="ratio" style="color:var(--text-subtle)">set OKAMI</span><span class="gap">&nbsp;</span></div>`);
      continue;
    }
    // OKAMI is exact demand now (post migration 0039); cushion is a
    // separate operator tool. needed = peak routes × DPR.
    const needed = Math.round(routesMax * dpr);
    const gap = available - needed;
    const gapClass = gap >= 0 ? "ok" : (gap >= -10 ? "tight" : "short");
    const gapText = (gap >= 0 ? "+" : "") + gap;
    out.push(`<div class="hp-week-cell"><span class="wk">${wkLabel}</span><span class="ratio">${available} / ${needed}</span><span class="gap ${gapClass}">${gapText}</span></div>`);
  }

  strip.innerHTML = `<span class="hp-weeks-strip-label">Next 5 weeks</span><div class="hp-weeks-row">${out.join("")}</div>`;
  strip.dataset.rrLoaded = "1";
}


// ─── Interview Day ─────────────────────────────────────────────────────────
//
// `loadInterviewDay()` picks WHICH day to show:
//   1. If today has bookings, show today.
//   2. Otherwise, jump to the soonest future date that has bookings.
//   3. If no future bookings exist anywhere, default to today (empty).
//
// Operators can also navigate prev/next via buttons rendered in the
// header. State is held in module-scope `_ivDate` so re-renders survive.

let _ivDate = null;            // YYYY-MM-DD currently displayed
let _ivDayId = null;           // interview_days.id for the displayed date
let _ivDatesWithBookings = []; // sorted YYYY-MM-DD strings (today + future)

function dspTz() {
  return window.RR?.dsp?.timezone || "America/New_York";
}
function localDate(d) {
  return new Date(d).toLocaleDateString("en-CA", { timeZone: dspTz() });
}

async function loadInterviewDay() {
  const list = document.getElementById("iv-candidates");
  if (!list) return;

  // Pull all booking cal_events from yesterday onward to map out the
  // dates that have applicants coming in. No kind filter — operators
  // think "who's booked May 22?", not "interview vs orientation".
  // This matches interview_day_roster (migration 0094).
  const { data: events } = await sb.from("cal_events")
    .select("starts_at")
    .eq("dsp_id", window.RR.dsp.id)
    .gte("starts_at", new Date(Date.now() - 86400000).toISOString())
    .in("status", ["scheduled","rescheduled","completed","no_show"])
    .order("starts_at", { ascending: true });

  const datesSet = new Set();
  for (const e of events ?? []) datesSet.add(localDate(e.starts_at));
  _ivDatesWithBookings = [...datesSet].sort();

  const today = localDate(new Date());
  if (!_ivDate) {
    if (_ivDatesWithBookings.includes(today)) _ivDate = today;
    else _ivDate = _ivDatesWithBookings[0] || today;
  }

  const { data: day, error: openErr } = await sb.rpc("open_interview_day", { p_date: _ivDate });
  if (openErr) { toast("Couldn't open interview day: " + openErr.message, "warn"); return; }
  _ivDayId = day.id;

  const { data: roster, error: rErr } = await sb.rpc("interview_day_roster", { p_day_id: day.id });
  if (rErr) { toast("Roster load failed: " + rErr.message, "warn"); return; }
  renderInterviewDay(day, roster ?? []);
}

function renderInterviewDay(day, rows) {
  const list = document.getElementById("iv-candidates");
  if (!list) return;

  // Date navigator + label injected just above the stat banner.
  renderInterviewDayNav(day);

  const booked   = rows.length;
  const hired    = rows.filter(r => r.outcome === "hired").length;
  const noHire   = rows.filter(r => r.outcome === "no_hire").length;
  const noShow   = rows.filter(r => r.outcome === "no_show").length;
  const remaining = booked - hired - noHire - noShow;

  setText("iv-booked",    booked);
  setText("iv-hired",     hired);
  setText("iv-nohire",    noHire);
  setText("iv-noshow",    noShow);
  setText("iv-remaining", remaining);

  const fill = document.getElementById("iv-progress-fill");
  if (fill) fill.style.width = booked === 0
    ? "0%"
    : Math.round(((booked - remaining) / booked) * 100) + "%";

  if (rows.length === 0) {
    list.innerHTML = `
      <div style="padding:48px;text-align:center;color:var(--text-subtle);font-size:var(--fs-md);background:var(--surface);border:1px solid var(--border);border-radius:12px">
        <strong style="color:var(--text-muted);display:block;margin-bottom:4px">No interviews booked for ${day.date}</strong>
        When applicants book via Cal.com, they'll show up here.
      </div>`;
  } else if (day.closed_at) {
    // Closed days are archived — render a summary instead of the
    // actionable applicant cards. Operators can still see the per-row
    // outcomes by reopening (DB-side) or in the funnel below.
    list.innerHTML = `
      <div style="padding:32px;text-align:center;color:var(--text-subtle);font-size:var(--fs-md);background:var(--surface);border:1px solid var(--border);border-radius:12px">
        <strong style="color:var(--text);display:block;margin-bottom:6px;font-size:var(--fs-lg)">Interview day closed</strong>
        <div style="margin-bottom:4px">${booked} interview${booked === 1 ? "" : "s"} on ${day.date}</div>
        <div style="font-size:var(--fs-sm)">${hired} hired · ${noHire} no-hire · ${noShow} no-show</div>
      </div>`;
  } else {
    list.innerHTML = rows.map(renderInterviewCard).join("");
  }

  // Inject a Close-day link after the candidate list. Subtle by design —
  // operators close once at end of day, not a primary action.
  const wrap = list.parentNode;
  let closeBtn = wrap.querySelector("[data-rr-close-day]");
  if (!closeBtn) {
    closeBtn = document.createElement("button");
    closeBtn.className = "btn btn-sm";
    closeBtn.style.cssText = "margin-top:14px;font-size:var(--fs-sm);color:var(--text-subtle);background:transparent;border:1px solid var(--border)";
    closeBtn.dataset.rrCloseDay = "1";
    wrap.insertBefore(closeBtn, list.nextSibling);
  }
  closeBtn.disabled = day.closed_at != null;
  closeBtn.textContent = day.closed_at
    ? `Day closed · ${new Date(day.closed_at).toLocaleString()}`
    : "Close interview day";

  // Show "done" state once everyone is decided + day is closed.
  const done = document.getElementById("iv-done");
  if (done) {
    if (day.closed_at) {
      done.style.display = "";
      const sub = document.getElementById("iv-done-sub");
      if (sub) sub.textContent = `${hired} hired · ${noHire} no-hire · ${noShow} no-show`;
    } else {
      done.style.display = "none";
    }
  }
}

function renderInterviewDayNav(day) {
  // Find or create the nav row inside the Interview Day subview, just
  // before the iv-stats-banner.
  const subview = document.getElementById("pipe-sub-interview");
  const banner  = subview?.querySelector(".iv-stats-banner");
  if (!subview || !banner) return;

  let nav = subview.querySelector("[data-rr-iv-nav]");
  if (!nav) {
    nav = document.createElement("div");
    nav.setAttribute("data-rr-iv-nav", "1");
    nav.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:var(--s-3);background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 14px";
    banner.parentNode.insertBefore(nav, banner);
  }

  const idx = _ivDatesWithBookings.indexOf(_ivDate);
  let prev, next;
  if (idx >= 0) {
    prev = idx > 0 ? _ivDatesWithBookings[idx - 1] : null;
    next = idx < _ivDatesWithBookings.length - 1 ? _ivDatesWithBookings[idx + 1] : null;
  } else {
    // Operator is viewing a date that has no bookings (e.g. today is empty
    // but they explicitly clicked Today). Fall back to nearest neighbors
    // on either side from the booked-dates list.
    prev = [..._ivDatesWithBookings].reverse().find(d => d < _ivDate) || null;
    next = _ivDatesWithBookings.find(d => d > _ivDate) || null;
  }

  const dt = new Date(_ivDate + "T12:00:00");
  const label = dt.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const today = localDate(new Date());
  const relative = _ivDate === today ? "Today" : (_ivDate < today ? "Past" : "Upcoming");

  nav.innerHTML = `
    <div>
      <div style="font-size:var(--fs-md);font-weight:600">${label}</div>
      <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">${relative}${day.closed_at ? " · day closed" : ""}</div>
    </div>
    <div style="display:flex;gap:6px">
      <button class="btn btn-sm" data-rr-iv-prev ${prev ? "" : "disabled"} style="font-size:var(--fs-xs)">← Prev day</button>
      <button class="btn btn-sm" data-rr-iv-today style="font-size:var(--fs-xs)">Today</button>
      <button class="btn btn-sm" data-rr-iv-next ${next ? "" : "disabled"} style="font-size:var(--fs-xs)">Next day →</button>
    </div>`;
}

function renderInterviewCard(r) {
  const initials = (r.full_name || "")
    .split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
  const time = r.starts_at
    ? new Date(r.starts_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : "—";
  const outcome = r.outcome;
  const sourceColors = {
    hired:   "background:rgba(22,163,74,.12);color:var(--green)",
    no_hire: "background:rgba(220,38,38,.12);color:var(--red)",
    no_show: "background:rgba(245,158,11,.18);color:var(--amber-dark)",
  };
  const badge = outcome
    ? `<span class="iv-card-source" style="${sourceColors[outcome]}">${outcome.replace("_"," ")}</span>`
    : `<span class="iv-card-source" style="background:var(--accent-soft);color:var(--accent-text)">${r.source ?? "Indeed"}</span>`;

  const tags = [];
  if (r.video_url) tags.push(
    `<span class="iv-card-tag" data-rr-play-video data-video-url="${encodeURI(r.video_url)}" style="cursor:pointer">▶ Watch intro</span>`
  );
  // Reschedule / Cancel surfaced on the day-of card too — operators
  // sometimes need to bump or kill a slot from this view, not just the
  // funnel. Hidden when the day already has an outcome on this row.
  if (!outcome) {
    tags.push(`<span class="iv-card-tag" data-rr-action="reschedule" style="cursor:pointer">↻ Reschedule</span>`);
    tags.push(`<span class="iv-card-tag" data-rr-action="cancel_interview" style="cursor:pointer;color:var(--red)">× Cancel interview</span>`);
  }

  return `
    <div class="iv-card" data-applicant-id="${r.applicant_id}" ${outcome ? `data-outcome="${outcome}"` : ""}>
      <div class="iv-card-time">${time}</div>
      <div class="iv-card-body">
        <div class="iv-card-header">
          <div class="iv-card-avatar tier-b">${initials}</div>
          <div>
            <div class="iv-card-name">${r.full_name ?? ""}</div>
            <div class="iv-card-meta">${[r.phone, r.email].filter(Boolean).join(" · ")}</div>
          </div>
          ${badge}
        </div>
        ${tags.length ? `<div class="iv-card-tags">${tags.join("")}</div>` : ""}
      </div>
      <div class="iv-card-actions">
        <button class="iv-action-btn nohire" data-rr-outcome="no_hire" ${outcome === "no_hire" ? "disabled" : ""}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>No Hire
        </button>
        <button class="iv-action-btn noshow" data-rr-outcome="no_show" ${outcome === "no_show" ? "disabled" : ""}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/></svg>No Show
        </button>
        <button class="iv-action-btn hired" data-rr-outcome="hired" ${outcome === "hired" ? "disabled" : ""}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>Hired
        </button>
      </div>
    </div>`;
}

function setText(id, txt) {
  const el = document.getElementById(id);
  if (el) el.textContent = txt;
}

// Capture-phase delegate for outcome + close-day buttons.
document.addEventListener("click", async (e) => {
  const outcomeBtn = e.target.closest("[data-rr-outcome]");
  if (outcomeBtn && !outcomeBtn.disabled) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const card = outcomeBtn.closest(".iv-card");
    if (!card) return;
    const id = card.getAttribute("data-applicant-id");
    const outcome = outcomeBtn.getAttribute("data-rr-outcome");
    outcomeBtn.disabled = true;
    const { error } = await sb.rpc("record_outcome", {
      p_applicant_id: id, p_outcome: outcome, p_notes: null,
    });
    if (error) {
      toast("Action failed: " + error.message, "warn");
      outcomeBtn.disabled = false;
      return;
    }
    toast(
      outcome === "hired" ? "Hired ✓ · driver record created"
      : outcome === "no_hire" ? "Marked no hire"
      : "Marked no show",
      outcome === "hired" ? "success" : "warn",
    );
    await loadInterviewDay();
    await loadPipelineKpis();
    return;
  }

  // Interview Day prev/next/today
  const navBtn = e.target.closest("[data-rr-iv-prev],[data-rr-iv-next],[data-rr-iv-today]");
  if (navBtn && !navBtn.disabled) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (navBtn.hasAttribute("data-rr-iv-prev")) {
      const candidates = _ivDatesWithBookings.filter(d => d < _ivDate);
      _ivDate = candidates[candidates.length - 1] || _ivDate;
    } else if (navBtn.hasAttribute("data-rr-iv-next")) {
      const candidates = _ivDatesWithBookings.filter(d => d > _ivDate);
      _ivDate = candidates[0] || _ivDate;
    } else if (navBtn.hasAttribute("data-rr-iv-today")) {
      _ivDate = localDate(new Date());
    }
    _ivDayId = null;
    await loadInterviewDay();
    return;
  }

  const closeBtn = e.target.closest("[data-rr-close-day]");
  if (closeBtn && !closeBtn.disabled) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!confirm("Close interview day? Anyone booked but not yet acted on will be marked No Show.")) return;
    closeBtn.disabled = true;
    // Close the DAY THE OPERATOR IS VIEWING, not whatever's "currently open"
    // server-side. Without p_day_id, the RPC defaults to today's open day,
    // which is empty if the operator was looking at a future booking.
    const { error } = await sb.rpc("close_interview_day", { p_day_id: _ivDayId });
    if (error) {
      toast("Close failed: " + error.message, "warn");
      closeBtn.disabled = false;
      return;
    }
    toast("Interview day closed · KPIs updated", "success");
    // After close, jump to the next future date with bookings. If there
    // isn't one, advance to the calendar day after the one we just
    // closed so the operator lands on an empty "no interviews booked"
    // state rather than seeing the just-closed roster reload (which
    // happens if we fall back to today and today is the closed date).
    const closedDate = _ivDate;
    const futureBookings = _ivDatesWithBookings.filter(d => d > closedDate);
    if (futureBookings.length > 0) {
      _ivDate = futureBookings[0];
    } else {
      const next = new Date(closedDate + "T12:00:00");
      next.setDate(next.getDate() + 1);
      _ivDate = localDate(next);
    }
    _ivDayId = null;
    await loadInterviewDay();
    await loadPipelineKpis();
    await loadPipeline(getActiveStage());
  }
}, true);

// Hook pipeSub so switching to a tab kicks off the right load.
// Screening, Messages, and Referrals were moved to Settings → gear so the
// Pipeline subnav now only handles Funnel / Interview Day / Calendar.
const _legacyPipeSub = window.pipeSub;
window.pipeSub = function (sub) {
  if (typeof _legacyPipeSub === "function") _legacyPipeSub(sub);
  if (sub === "interview") loadInterviewDay();
  if (sub === "calendar")  loadCalendarTab();
};


// ─── Referrals tab ─────────────────────────────────────────────────────────

let _refsLoaded = false;

async function loadReferralsTab() {
  await Promise.all([loadReferralsSummary(), loadReferralsLeaderboard()]);

  // First-load: wire settings inputs to autosave.
  if (!_refsLoaded) {
    _refsLoaded = true;
    document.getElementById("ref-toggle-enabled")?.addEventListener("click", async (e) => {
      e.preventDefault();
      const btn = e.currentTarget;
      btn.classList.toggle("on");
      await saveReferralSettings();
    });
    ["ref-weeks","ref-payout-input"].forEach(id => {
      document.getElementById(id)?.addEventListener("change", saveReferralSettings);
    });
  }

  // Set the master link preview from any first leaderboard row's link.
  const masterEl = document.getElementById("ref-master-link");
  if (masterEl) {
    const baseUrl = window.RR.dsp?.metadata?.public_base_url || "https://gorouteready.com";
    masterEl.textContent = `${baseUrl}/r/<driver-token>`;
  }
}

async function loadReferralsSummary() {
  const { data, error } = await sb.rpc("referral_summary");
  if (error || !data) return;
  setText("ref-active", data.active ?? 0);
  setText("ref-hired",  data.hired  ?? 0);
  setText("ref-payout", Math.round((data.payout_cents ?? 0) / 100));

  const tg = document.getElementById("ref-toggle-enabled");
  if (tg) tg.classList.toggle("on", !!data.enabled);
  setText("ref-auto-status", data.enabled ? "On" : "Off");
  const sub = document.getElementById("ref-auto-sub");
  if (sub) sub.textContent = data.enabled
    ? `Each new driver gets a referral SMS ${data.weeks ?? 4} week${data.weeks === 1 ? "" : "s"} after their hire date.`
    : "New hires don't get a referral SMS automatically.";

  const weeksEl = document.getElementById("ref-weeks");
  if (weeksEl) weeksEl.value = data.weeks ?? 4;
  const payIn = document.getElementById("ref-payout-input");
  if (payIn) payIn.value = Math.round((data.payout_cents ?? 0) / 100);
}

async function loadReferralsLeaderboard() {
  const list = document.getElementById("ref-leaderboard");
  if (!list) return;
  const { data: rows, error } = await sb.rpc("referral_leaderboard");
  if (error) {
    list.innerHTML = `<div style="padding:16px;color:var(--red);font-size:var(--fs-sm)">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!rows || rows.length === 0) {
    list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-subtle);font-size:var(--fs-sm)"><strong style="color:var(--text-muted);display:block;margin-bottom:4px">No referrals yet</strong>Send drivers their links and the leaderboard fills in.</div>`;
    return;
  }
  list.innerHTML = rows.map((r, i) => `
    <div class="ref-leader-row">
      <div class="ref-leader-rank">${i + 1}</div>
      <div>
        <div class="ref-leader-name">${escapeHtml(r.full_name)}</div>
        <div class="ref-leader-meta">${r.hired_count} hired · ${r.active_count} active</div>
      </div>
      <button class="ref-action-btn ghost" data-rr-send-ref="${r.driver_id}">Send link</button>
    </div>`).join("");
}

async function saveReferralSettings() {
  const enabled = document.getElementById("ref-toggle-enabled")?.classList.contains("on");
  const weeks   = parseInt(document.getElementById("ref-weeks")?.value || "4", 10);
  const payout  = Math.round(parseFloat(document.getElementById("ref-payout-input")?.value || "0") * 100);
  const { error } = await sb.rpc("referral_settings_save", {
    p_payload: { enabled, weeks, payout_cents: payout },
  });
  if (error) { toast("Save failed: " + error.message, "warn"); return; }
  toast("Referral settings saved", "success");
  loadReferralsSummary();
}

// Capture-phase delegate for referral actions.
document.addEventListener("click", async (e) => {
  const sendBtn = e.target.closest("[data-rr-send-ref]");
  if (sendBtn && !sendBtn.disabled) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const id = sendBtn.getAttribute("data-rr-send-ref");
    sendBtn.disabled = true;
    const { error } = await sb.rpc("send_referral_link", { p_driver_id: id });
    sendBtn.disabled = false;
    if (error) { toast("Send failed: " + error.message, "warn"); return; }
    toast("Referral link sent", "success");
    return;
  }
  const campBtn = e.target.closest("[data-rr-send-campaign]");
  if (campBtn && !campBtn.disabled) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!confirm("Send the referral link to ALL active + onboarding drivers right now?")) return;
    campBtn.disabled = true;
    const { data, error } = await sb.rpc("send_referral_campaign");
    campBtn.disabled = false;
    if (error) { toast("Campaign failed: " + error.message, "warn"); return; }
    toast(`Campaign sent · ${data?.sent ?? 0} drivers`, "success");
    return;
  }
  const copyBtn = e.target.closest("[data-rr-copy-master-ref]");
  if (copyBtn) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const txt = document.getElementById("ref-master-link")?.textContent;
    if (!txt) return;
    try { await navigator.clipboard.writeText(txt); toast("Link copied", "success"); }
    catch { toast("Couldn't copy — " + txt, "warn"); }
  }
}, true);


// ─── Calendar tab ──────────────────────────────────────────────────────────
//
// Top half  → upcoming bookings list (live cal_events).
// Bottom    → RouteReady-branded availability editor that pushes changes
//             through to Cal.com via the cal-availability edge function.

const CAL_DAY_LABELS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

const CAL_TZS = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Etc/UTC",
];

async function loadCalendarTab() {
  await Promise.all([loadCalBookingsList(), loadCalAvailabilityEditor()]);
}

async function loadCalAvailabilityEditor() {
  const card = document.getElementById("cal-edit-card");
  const meta = document.getElementById("cal-edit-meta");
  if (!card) return;
  card.innerHTML = `<div class="rr-loading">Loading availability</div>`;
  if (meta) meta.textContent = "";

  // Call the edge function. JWT-gated → uses the user's session.
  const { data, error } = await sb.functions.invoke("cal-availability", {
    method: "GET",
  });

  if (error || data?.error) {
    const msg = error?.message || data?.error || "Couldn't load availability";
    card.innerHTML = `
      <div style="padding:24px">
        <div style="font-size:var(--fs-md);color:var(--red);font-weight:600;margin-bottom:8px">Couldn't load availability</div>
        <div style="font-size:var(--fs-sm);color:var(--text-subtle);line-height:1.5">${escapeHtml(msg)}</div>
      </div>`;
    return;
  }

  renderCalAvailabilityEditor(data);
  if (meta) meta.textContent = `Event "${data.eventType?.title || ""}" · ${data.eventType?.length ?? 30} min`;
}

function renderCalAvailabilityEditor(payload) {
  const card = document.getElementById("cal-edit-card");
  if (!card) return;

  const tz = payload.schedule?.timeZone || "America/New_York";
  const avail = payload.schedule?.availability || [];
  const locations = payload.eventType?.locations || [];

  // Collect ALL windows for each day. Each schedule block is shaped like
  //   { days: [0..6], startTime: "HH:MM:SS", endTime: "HH:MM:SS" }
  // and may apply to multiple days at once. We expand into per-day arrays
  // so the editor can surface (and re-edit) every window independently.
  const perDay = { 0:[], 1:[], 2:[], 3:[], 4:[], 5:[], 6:[] };
  for (const block of avail) {
    const start = (block.startTime || "09:00:00").slice(0, 5);
    const end   = (block.endTime   || "17:00:00").slice(0, 5);
    for (const d of (block.days || [])) {
      if (perDay[d]) perDay[d].push({ start, end });
    }
  }
  // Sort each day's windows by start time for predictable rendering.
  for (const d of Object.keys(perDay)) {
    perDay[d].sort((a, b) => a.start.localeCompare(b.start));
  }

  const loc = locations[0] || { type: "address", address: "" };
  const isVideo = (loc.type || "").startsWith("integrations:") || loc.type === "link";
  const locDetail = loc.address || loc.link || "";

  const tzOptions = (CAL_TZS.includes(tz) ? CAL_TZS : [tz, ...CAL_TZS])
    .map(z => `<option value="${z}" ${z === tz ? "selected" : ""}>${z.replace("_"," ")}</option>`)
    .join("");

  const dayRows = Array.from({ length: 7 }, (_, d) => renderDayRow(d, perDay[d])).join("");

  // Current-availability summary so the operator sees at a glance what
  // applicants will be offered without scanning seven day rows. Groups
  // contiguous days that share the same window set; e.g. Mon–Fri 9–5.
  const fmt12 = (hhmm) => {
    const [h, m] = (hhmm || "").split(":").map(Number);
    if (!Number.isFinite(h)) return hhmm;
    const ampm = h >= 12 ? "PM" : "AM";
    const h12  = (h % 12) || 12;
    return `${h12}:${String(m || 0).padStart(2, "0")} ${ampm}`;
  };
  const winSig = (windows) => windows.map(w => `${w.start}-${w.end}`).sort().join("|");
  const winText = (windows) => windows.map(w => `${fmt12(w.start)} – ${fmt12(w.end)}`).join(", ");
  const DAY_LABELS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const groups = [];
  for (let d = 0; d < 7; d++) {
    const w = perDay[d];
    if (!w || w.length === 0) continue;
    const sig = winSig(w);
    const last = groups[groups.length - 1];
    if (last && last.sig === sig && last.endDay === d - 1) {
      last.endDay = d;
    } else {
      groups.push({ startDay: d, endDay: d, sig, windows: w });
    }
  }
  const summaryHtml = groups.length === 0
    ? `<span style="color:var(--red);font-weight:600">No availability set</span> — applicants can't book interviews until at least one day is enabled below.`
    : groups.map(g => {
        const days = g.startDay === g.endDay
          ? DAY_LABELS[g.startDay]
          : `${DAY_LABELS[g.startDay]}–${DAY_LABELS[g.endDay]}`;
        return `<strong style="color:var(--text)">${days}</strong> <span style="color:var(--text-subtle)">${escapeHtml(winText(g.windows))}</span>`;
      }).join(" &nbsp;·&nbsp; ");

  card.innerHTML = `
    <div class="cal-edit-section" data-rr-cal-summary style="background:var(--canvas);padding:12px 14px;border-radius:8px;margin-bottom:14px">
      <div class="cal-edit-label" style="margin-bottom:6px">Current availability</div>
      <div style="font-size:var(--fs-md);line-height:1.5">${summaryHtml}</div>
      <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:6px">Time zone: ${escapeHtml(tz)}</div>
    </div>

    <div class="cal-edit-section">
      <div class="cal-edit-label">Time zone</div>
      <select id="cal-tz" class="cal-edit-input" style="max-width:280px">${tzOptions}</select>
    </div>

    <div class="cal-edit-section">
      <div class="cal-edit-label">Days &amp; times</div>
      <div id="cal-day-grid">${dayRows}</div>
    </div>

    <div class="cal-edit-section">
      <div class="cal-edit-label">Location</div>
      <div style="display:flex;gap:8px;align-items:center">
        <select id="cal-loc-type" class="cal-edit-input" style="max-width:200px">
          <option value="address" ${!isVideo ? "selected" : ""}>In-person address</option>
          <option value="link"     ${isVideo  ? "selected" : ""}>Video / meeting link</option>
        </select>
      </div>
      <input id="cal-loc-detail" class="cal-edit-input cal-loc-detail" placeholder="${isVideo ? "https://meet.google.com/…" : "1234 Main St, City, State 00000"}" value="${escapeHtml(locDetail)}" />
    </div>

    <div class="cal-edit-foot">
      <div class="cal-edit-status" id="cal-edit-status"></div>
      <button class="btn btn-primary" data-rr-cal-save>Save availability</button>
    </div>`;

  wireDayRowEvents(card);
}

// Renders a single day row. `windows` is an array of { start, end }; if
// empty, the day is "off" and we render a single hidden window with
// default values so the user can flip the checkbox to enable it.
function renderDayRow(d, windows) {
  const on = windows.length > 0;
  const items = on ? windows : [{ start: "09:00", end: "17:00" }];
  const winHtml = items.map(w => renderDayWindow(w)).join("");
  return `
    <div class="cal-day-row ${on ? "" : "off"}" data-day="${d}">
      <label>
        <input type="checkbox" data-rr-day-on ${on ? "checked" : ""} />
        ${CAL_DAY_LABELS[d]}
      </label>
      <div class="cal-day-windows">
        ${winHtml}
        <button type="button" class="cal-add-window" data-rr-add-window ${on ? "" : "disabled"}>+ Add window</button>
      </div>
    </div>`;
}

function renderDayWindow(w, removable) {
  // The first window per day is always present; only extras get a remove
  // button. We render the remove button on every window and let the
  // wiring decide whether to actually remove (kept simple for now: any
  // window can be removed; if all are gone, the day flips to "off").
  return `
    <div class="cal-day-window">
      <input type="time" data-rr-day-start value="${w.start}" step="900" />
      <span class="cal-day-sep">to</span>
      <input type="time" data-rr-day-end value="${w.end}" step="900" />
      <button type="button" class="cal-remove-window" data-rr-remove-window aria-label="Remove">×</button>
    </div>`;
}

function wireDayRowEvents(card) {
  // Day-level on/off toggles enable/disable all the day's time inputs.
  card.querySelectorAll("[data-rr-day-on]").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const row = e.target.closest(".cal-day-row");
      const on  = e.target.checked;
      row.classList.toggle("off", !on);
      row.querySelectorAll('input[type=time]').forEach(t => { t.disabled = !on; });
      const addBtn = row.querySelector("[data-rr-add-window]");
      if (addBtn) addBtn.disabled = !on;
    });
  });
}

// Click delegate: add window / remove window inside a day row.
document.addEventListener("click", (e) => {
  const addBtn = e.target.closest("[data-rr-add-window]");
  if (addBtn && !addBtn.disabled) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const row = addBtn.closest(".cal-day-row");
    if (!row) return;
    const wrap = row.querySelector(".cal-day-windows");
    const tmp = document.createElement("div");
    tmp.innerHTML = renderDayWindow({ start: "09:00", end: "17:00" });
    const newWin = tmp.firstElementChild;
    wrap.insertBefore(newWin, addBtn);
    return;
  }
  const remBtn = e.target.closest("[data-rr-remove-window]");
  if (remBtn) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const win = remBtn.closest(".cal-day-window");
    const row = remBtn.closest(".cal-day-row");
    if (!win || !row) return;
    win.remove();
    // If no windows remain, flip the day to off so the layout stays sane.
    if (row.querySelectorAll(".cal-day-window").length === 0) {
      const cb = row.querySelector("[data-rr-day-on]");
      if (cb) { cb.checked = false; cb.dispatchEvent(new Event("change", { bubbles: true })); }
      // Re-add an empty default window so the user can re-enable the day.
      const wrap = row.querySelector(".cal-day-windows");
      const addBtn = wrap.querySelector("[data-rr-add-window]");
      const tmp = document.createElement("div");
      tmp.innerHTML = renderDayWindow({ start: "09:00", end: "17:00" });
      const def = tmp.firstElementChild;
      def.querySelectorAll('input[type=time]').forEach(t => { t.disabled = true; });
      wrap.insertBefore(def, addBtn);
    }
  }
}, true);

async function saveCalAvailability() {
  const card = document.getElementById("cal-edit-card");
  const status = document.getElementById("cal-edit-status");
  if (!card) return;

  const tz = card.querySelector("#cal-tz").value;
  const availability = [];
  card.querySelectorAll(".cal-day-row").forEach((row) => {
    const on = row.querySelector("[data-rr-day-on]").checked;
    if (!on) return;
    const day = parseInt(row.getAttribute("data-day"), 10);
    row.querySelectorAll(".cal-day-window").forEach((win) => {
      const start = win.querySelector("[data-rr-day-start]").value;
      const end   = win.querySelector("[data-rr-day-end]").value;
      if (!start || !end || start >= end) return;
      availability.push({
        days:      [day],
        startTime: start.length === 5 ? start + ":00" : start,
        endTime:   end.length   === 5 ? end   + ":00" : end,
      });
    });
  });

  const locType = card.querySelector("#cal-loc-type").value;
  const locDetail = card.querySelector("#cal-loc-detail").value.trim();
  const locations = [];
  if (locType === "link" && locDetail) {
    locations.push({ type: "link", link: locDetail });
  } else if (locType === "address" && locDetail) {
    locations.push({ type: "address", address: locDetail, public: true });
  }

  status.className = "cal-edit-status";
  status.textContent = "Saving…";

  const { data, error } = await sb.functions.invoke("cal-availability", {
    method: "POST",
    body: { timeZone: tz, availability, locations },
  });

  if (error || data?.error) {
    const msg = error?.message || data?.error || "Save failed";
    status.className = "cal-edit-status err";
    status.textContent = msg;
    return;
  }

  status.className = "cal-edit-status ok";
  status.textContent = `Saved at ${new Date().toLocaleTimeString()}`;
  toast("Availability saved", "success");
  // Refetch from cal.com so the "Current availability" banner shows
  // what cal.com actually has, not what the operator just typed. If
  // anything got dropped or transformed (timezone shift, day mapping,
  // event-type buffer), the banner makes that visible immediately
  // instead of pretending the save worked. The form fields are NOT
  // re-rendered, so in-flight edits aren't wiped.
  try {
    const fresh = await sb.functions.invoke("cal-availability", { method: "GET" });
    const data = fresh?.data;
    if (data?.schedule) {
      _refreshCalAvailabilityBanner(
        data.schedule.timeZone || tz,
        data.schedule.availability || [],
      );
    } else {
      _refreshCalAvailabilityBanner(tz, availability);
    }
  } catch {
    _refreshCalAvailabilityBanner(tz, availability);
  }
  loadCalBookingsList();
}

// Rebuild only the "Current availability" summary banner without
// touching the rest of the editor.  Mirrors the logic in
// renderCalAvailabilityEditor() that builds the same banner on first
// render — keep them in sync if either side changes.
function _refreshCalAvailabilityBanner(tz, availability) {
  const card = document.getElementById("cal-edit-card");
  if (!card) return;
  const banner = card.querySelector("[data-rr-cal-summary]");
  if (!banner) return;

  const perDay = { 0:[], 1:[], 2:[], 3:[], 4:[], 5:[], 6:[] };
  for (const block of (availability || [])) {
    const start = (block.startTime || "09:00:00").slice(0, 5);
    const end   = (block.endTime   || "17:00:00").slice(0, 5);
    for (const d of (block.days || [])) if (perDay[d]) perDay[d].push({ start, end });
  }
  for (const d of Object.keys(perDay)) perDay[d].sort((a, b) => a.start.localeCompare(b.start));

  const fmt12 = (hhmm) => {
    const [h, m] = (hhmm || "").split(":").map(Number);
    if (!Number.isFinite(h)) return hhmm;
    const ampm = h >= 12 ? "PM" : "AM";
    const h12  = (h % 12) || 12;
    return `${h12}:${String(m || 0).padStart(2, "0")} ${ampm}`;
  };
  const winSig  = (w) => w.map(x => `${x.start}-${x.end}`).sort().join("|");
  const winText = (w) => w.map(x => `${fmt12(x.start)} – ${fmt12(x.end)}`).join(", ");
  const DAY_LABELS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const groups = [];
  for (let d = 0; d < 7; d++) {
    const w = perDay[d];
    if (!w || w.length === 0) continue;
    const sig = winSig(w);
    const last = groups[groups.length - 1];
    if (last && last.sig === sig && last.endDay === d - 1) last.endDay = d;
    else groups.push({ startDay: d, endDay: d, sig, windows: w });
  }
  const summaryHtml = groups.length === 0
    ? `<span style="color:var(--red);font-weight:600">No availability set</span> — applicants can't book interviews until at least one day is enabled below.`
    : groups.map(g => {
        const days = g.startDay === g.endDay
          ? DAY_LABELS[g.startDay]
          : `${DAY_LABELS[g.startDay]}–${DAY_LABELS[g.endDay]}`;
        return `<strong style="color:var(--text)">${days}</strong> <span style="color:var(--text-subtle)">${escapeHtml(winText(g.windows))}</span>`;
      }).join(" &nbsp;·&nbsp; ");
  banner.innerHTML = `
    <div class="cal-edit-label" style="margin-bottom:6px">Current availability</div>
    <div style="font-size:var(--fs-md);line-height:1.5">${summaryHtml}</div>
    <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:6px">Time zone: ${escapeHtml(tz)}</div>`;
}

// Auto-save: any change inside the availability editor (day toggle, time
// change, location pick, tz pick, prompt edit) debounces a save so the
// operator never has to hunt for a button. The explicit Save button
// still works as a manual fallback.
let _calAutoSaveTimer = null;
function _scheduleCalAutoSave() {
  if (_calAutoSaveTimer) clearTimeout(_calAutoSaveTimer);
  _calAutoSaveTimer = setTimeout(() => {
    _calAutoSaveTimer = null;
    saveCalAvailability().catch(err => {
      const status = document.getElementById("cal-edit-status");
      if (status) { status.className = "cal-edit-status err"; status.textContent = err?.message || String(err); }
    });
  }, 600);
}
document.addEventListener("change", (e) => {
  const card = document.getElementById("cal-edit-card");
  if (!card || !card.contains(e.target)) return;
  if (e.target.closest("[data-rr-day-on], #cal-tz, #cal-loc-type, [data-rr-day-start], [data-rr-day-end]")) {
    _scheduleCalAutoSave();
  }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "cal-loc-detail") _scheduleCalAutoSave();
});

// Capture-phase delegate for the save button.
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-rr-cal-save]");
  if (!btn) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  btn.disabled = true;
  try { await saveCalAvailability(); }
  finally { btn.disabled = false; }
}, true);

async function loadCalBookingsList() {
  const list = document.getElementById("cal-bookings-list");
  if (!list) return;
  list.innerHTML = `<div class="rr-loading">Loading</div>`;

  const { data: rows, error } = await sb.from("cal_events")
    .select("id, applicant_id, kind, status, starts_at, ends_at, meeting_url, location, applicants:applicant_id (full_name, email, phone)")
    .eq("dsp_id", window.RR.dsp.id)
    .gte("starts_at", new Date(Date.now() - 1000 * 60 * 60 * 12).toISOString())
    .in("status", ["scheduled", "rescheduled"])
    .order("starts_at", { ascending: true })
    .limit(100);

  if (error) {
    list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--red);font-size:var(--fs-md)">Couldn't load bookings: ${error.message}</div>`;
    return;
  }
  if (!rows || rows.length === 0) {
    list.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-subtle);font-size:var(--fs-md)"><strong style="color:var(--text-muted);display:block;margin-bottom:4px">No upcoming bookings</strong>Once applicants book a slot, their interview will land here.</div>`;
    return;
  }

  // Group by date so the list reads like a schedule.
  const byDate = new Map();
  for (const r of rows) {
    const d = new Date(r.starts_at);
    const key = d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(r);
  }

  const html = [];
  for (const [date, items] of byDate) {
    html.push(`<div style="padding:10px 16px;background:var(--canvas);font-size:var(--fs-xs);font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted);border-top:1px solid var(--border)">${date}</div>`);
    for (const r of items) {
      const start = new Date(r.starts_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const end = r.ends_at ? new Date(r.ends_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
      const a = r.applicants || {};
      const kindBadge = r.kind === "orientation"
        ? `<span style="font-size:var(--fs-xs);font-weight:700;padding:2px 7px;border-radius:5px;background:rgba(124,58,237,.12);color:#7C3AED;letter-spacing:.04em;text-transform:uppercase">Orientation</span>`
        : `<span style="font-size:var(--fs-xs);font-weight:700;padding:2px 7px;border-radius:5px;background:var(--accent-soft);color:var(--accent-text);letter-spacing:.04em;text-transform:uppercase">Interview</span>`;
      const statusBadge = r.status === "rescheduled"
        ? `<span style="font-size:var(--fs-xs);font-weight:600;color:var(--amber-dark);margin-left:6px">rescheduled</span>`
        : "";

      html.push(`
        <div style="display:grid;grid-template-columns:90px 1fr auto;gap:14px;align-items:center;padding:14px 16px;border-top:1px solid var(--border)">
          <div style="font-variant-numeric:tabular-nums;font-size:var(--fs-md);font-weight:600">${start}<div style="font-size:var(--fs-xs);color:var(--text-subtle);font-weight:400">${end}</div></div>
          <div>
            <div style="font-size:var(--fs-md);font-weight:600;margin-bottom:2px">${escapeHtml(rrTitleCaseName(a.full_name) || "Unknown")}</div>
            <div style="font-size:var(--fs-xs);color:var(--text-subtle)">${[a.phone, a.email].filter(Boolean).join(" · ") || "no contact on file"}</div>
            <div style="margin-top:6px">${kindBadge}${statusBadge}</div>
          </div>
          <div>${r.meeting_url ? `<a class="btn btn-sm" href="${r.meeting_url}" target="_blank" rel="noreferrer">Join</a>` : ""}</div>
        </div>`);
    }
  }
  list.innerHTML = html.join("");
}


// ─── Settings → Screening Questions ────────────────────────────────────────
//
// The mockup has a static `.settings-section[data-set="screening"]` panel
// with hardcoded `<div class="question-row">` rows. We replace the row
// container with a live-rendered list backed by public.screening_questions
// CRUD. Inline edit toggles between a read row and a tiny form.

async function loadScreeningQuestionsList() {
  // Lives in Settings → Screening questions. Use a global selector so we
  // also catch the row container if the section markup ever moves again.
  const container = document.querySelector("[data-rr-questions]");
  if (!container) return;
  // Also rehydrate the video settings card (same Settings section).
  loadVideoScreeningSettings();

  const { data: rows, error } = await sb.from("screening_questions")
    .select("id, prompt, field_type, options, required, hard_filter, scoring, display_order, active")
    .eq("dsp_id", window.RR.dsp.id)
    .order("display_order", { ascending: true });
  if (error) {
    container.innerHTML = `<div style="padding:16px;color:var(--red);font-size:var(--fs-sm)">${escapeHtml(error.message)}</div>`;
    return;
  }

  const sub = document.getElementById("rr-screening-sub");
  if (sub) sub.textContent = `${(rows ?? []).length} questions · sent to applicants via SMS or email.`;

  if (!rows || rows.length === 0) {
    container.innerHTML = `<div class="rr-empty-inline">No questions yet — click + Add question to start.</div>`;
    return;
  }
  container.innerHTML = rows.map(renderScreeningQuestionRow).join("");
}

function renderScreeningQuestionRow(q) {
  const reqPill = q.required ? "Required" : "Optional";
  const subBits = [];
  subBits.push(({ yes_no: "Yes/No", single: "Single-select", multi: "Multi-select", text: "Text", number: "Number", date: "Date" })[q.field_type] || q.field_type);
  if (q.hard_filter && q.hard_filter.answer != null) subBits.push(`auto-fail if "${q.hard_filter.answer}"`);
  if (q.scoring) subBits.push("scoring");
  if (!q.active) subBits.push("disabled");

  return `
    <div class="question-row" data-question-id="${q.id}" ${q.active ? "" : 'style="opacity:.5"'}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"/></svg>
      <div class="question-text">${escapeHtml(q.prompt)}<small>${subBits.join(" · ")}</small></div>
      <span class="role-pill">${reqPill}</span>
      <button class="btn btn-sm" data-rr-edit-question="${q.id}">Edit</button>
      <button class="btn btn-sm" data-rr-toggle-question="${q.id}" data-active="${q.active}">${q.active ? "Disable" : "Enable"}</button>
      <button class="btn btn-sm" data-rr-delete-question="${q.id}" style="color:var(--red)">Delete</button>
    </div>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function openQuestionEditor(question) {
  const isEdit = !!question;
  const q = question || {
    prompt: "", field_type: "yes_no",
    options: ["Yes","No"], required: true,
    hard_filter: null, scoring: null,
    display_order: 99, active: true,
  };

  // Build a tiny modal inline (no need to add it to the static HTML).
  let m = document.getElementById("rr-question-modal");
  if (m) m.remove();
  m = document.createElement("div");
  m.id = "rr-question-modal";
  m.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px";
  m.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;max-width:520px;width:100%;max-height:90vh;overflow:auto">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <h3 style="margin:0;font-size:var(--fs-lg);font-weight:600">${isEdit ? "Edit question" : "Add question"}</h3>
        <button data-rr-q-cancel style="background:none;border:0;font-size:20px;cursor:pointer;color:var(--text-muted)">×</button>
      </div>
      <label style="display:block;font-size:var(--fs-xs);font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Prompt</label>
      <textarea data-rr-q-prompt class="form-input" style="width:100%;min-height:60px;margin-bottom:14px">${escapeHtml(q.prompt)}</textarea>
      <label style="display:block;font-size:var(--fs-xs);font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Type</label>
      <select data-rr-q-type class="form-input" style="width:100%;margin-bottom:14px">
        ${["yes_no","single","multi","text","number","date"].map(v => `<option value="${v}" ${q.field_type === v ? "selected" : ""}>${v}</option>`).join("")}
      </select>
      <label style="display:block;font-size:var(--fs-xs);font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Options (one per line — only for single / multi)</label>
      <textarea data-rr-q-options class="form-input" style="width:100%;min-height:70px;margin-bottom:14px;font-family:monospace">${(q.options || []).join("\n")}</textarea>
      <label style="display:block;font-size:var(--fs-xs);font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Auto-decline if answer equals (leave blank for none)</label>
      <input data-rr-q-hardfail class="form-input" style="width:100%;margin-bottom:14px" value="${escapeHtml(q.hard_filter?.answer ?? "")}" placeholder="e.g. No" />
      <label style="display:flex;align-items:center;gap:10px;margin-bottom:8px"><input type="checkbox" data-rr-q-required ${q.required ? "checked" : ""}/>Required</label>
      <label style="display:flex;align-items:center;gap:10px;margin-bottom:14px"><input type="checkbox" data-rr-q-active ${q.active ? "checked" : ""}/>Active (shown to applicants)</label>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn" data-rr-q-cancel>Cancel</button>
        <button class="btn btn-primary" data-rr-q-save>${isEdit ? "Save changes" : "Add question"}</button>
      </div>
    </div>`;
  document.body.appendChild(m);

  m.addEventListener("click", async (e) => {
    if (e.target.closest("[data-rr-q-cancel]")) { m.remove(); return; }
    if (e.target.closest("[data-rr-q-save]")) {
      const prompt = m.querySelector("[data-rr-q-prompt]").value.trim();
      if (!prompt) { toast("Prompt is required", "warn"); return; }
      const fieldType = m.querySelector("[data-rr-q-type]").value;
      const optsText  = m.querySelector("[data-rr-q-options]").value.trim();
      const opts = optsText ? optsText.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : null;
      const hardAns = m.querySelector("[data-rr-q-hardfail]").value.trim();
      const required = m.querySelector("[data-rr-q-required]").checked;
      const active = m.querySelector("[data-rr-q-active]").checked;

      const payload = {
        dsp_id: window.RR.dsp.id,
        prompt,
        field_type: fieldType,
        options: opts && (fieldType === "single" || fieldType === "multi") ? opts : null,
        required,
        hard_filter: hardAns ? { answer: hardAns } : null,
        scoring: q.scoring ?? null,
        display_order: q.display_order ?? 99,
        active,
      };
      if (isEdit) {
        const { error } = await sb.from("screening_questions").update(payload).eq("id", q.id);
        if (error) { toast("Save failed: " + error.message, "warn"); return; }
      } else {
        const { error } = await sb.from("screening_questions").insert(payload);
        if (error) { toast("Add failed: " + error.message, "warn"); return; }
      }
      m.remove();
      await loadScreeningQuestionsList();
      toast(isEdit ? "Question saved" : "Question added", "success");
    }
  });
}

// Capture-phase delegate for the question editor / toggle / delete / add.
document.addEventListener("click", async (e) => {
  const editBtn = e.target.closest("[data-rr-edit-question]");
  if (editBtn) {
    e.preventDefault(); e.stopImmediatePropagation();
    const id = editBtn.getAttribute("data-rr-edit-question");
    const { data: q, error } = await sb.from("screening_questions").select("*").eq("id", id).single();
    if (error) { toast("Couldn't load question", "warn"); return; }
    openQuestionEditor(q);
    return;
  }
  const delBtn = e.target.closest("[data-rr-delete-question]");
  if (delBtn) {
    e.preventDefault(); e.stopImmediatePropagation();
    if (!confirm("Delete this question? Existing responses will be removed.")) return;
    const id = delBtn.getAttribute("data-rr-delete-question");
    const { error } = await sb.from("screening_questions").delete().eq("id", id);
    if (error) { toast("Delete failed: " + error.message, "warn"); return; }
    await loadScreeningQuestionsList();
    toast("Question deleted", "warn");
    return;
  }
  const togBtn = e.target.closest("[data-rr-toggle-question]");
  if (togBtn) {
    e.preventDefault(); e.stopImmediatePropagation();
    const id = togBtn.getAttribute("data-rr-toggle-question");
    const wasActive = togBtn.getAttribute("data-active") === "true";
    const { error } = await sb.from("screening_questions").update({ active: !wasActive }).eq("id", id);
    if (error) { toast("Update failed: " + error.message, "warn"); return; }
    await loadScreeningQuestionsList();
    return;
  }
  const addBtn = e.target.closest("[data-rr-add-question]");
  if (addBtn) {
    e.preventDefault(); e.stopImmediatePropagation();
    openQuestionEditor(null);
  }
}, true);

// (Settings → Screening Questions was relocated to Pipeline → Screening.
//  No setSettingsSection hook needed.)


// ─── Video screening settings (Pipeline → Screening, lower card) ──────────

async function loadVideoScreeningSettings() {
  // Read straight from the cached dsp metadata (loaded at boot in window.RR.dsp).
  const v = window.RR?.dsp?.metadata?.video || {};
  const tg = document.getElementById("rr-video-enabled-toggle");
  if (tg) tg.classList.toggle("on", v.enabled !== false);
  const prompt = document.getElementById("rr-video-prompt");
  if (prompt) prompt.value = v.prompt || "Tell us about yourself and why you'd be a great fit for our team.";
  const max = document.getElementById("rr-video-max-seconds");
  if (max) max.value = v.max_seconds || 60;
}

async function saveVideoScreeningSettings() {
  const status = document.getElementById("rr-video-status");
  const enabled = document.getElementById("rr-video-enabled-toggle")?.classList.contains("on");
  const prompt  = document.getElementById("rr-video-prompt")?.value.trim() || "";
  const maxStr  = document.getElementById("rr-video-max-seconds")?.value;
  const max     = Math.min(180, Math.max(15, parseInt(maxStr || "60", 10)));

  status.className = "cal-edit-status";
  status.textContent = "Saving…";

  // Read current metadata, deep-merge the video block, write back.
  const { data: dsp, error: rErr } = await sb.from("dsps").select("metadata").eq("id", window.RR.dsp.id).single();
  if (rErr) { status.className = "cal-edit-status err"; status.textContent = rErr.message; return; }
  const md = dsp.metadata || {};
  md.video = { enabled, prompt, max_seconds: max };

  const { error: wErr } = await sb.from("dsps").update({ metadata: md }).eq("id", window.RR.dsp.id);
  if (wErr) { status.className = "cal-edit-status err"; status.textContent = wErr.message; return; }

  // Refresh the cached copy so subsequent loads see the new settings.
  window.RR.dsp.metadata = md;
  status.className = "cal-edit-status ok";
  status.textContent = `Saved at ${new Date().toLocaleTimeString()}`;
}

// Capture-phase delegate for the video toggle + save.
// ─── Driver detail drawer ─────────────────────────────────────────────────
//
// Opens when an operator clicks a row in the Drivers tab. Four internal
// tabs: Overview · License · Coaching · Documents.
//
// We also stub out the legacy mockup `openDriverDetail` so the old
// hardcoded "Marcus Davidson" aside drawer doesn't fire alongside ours.

window.openDriverDetail = function () { /* superseded by openDriverDrawer */ };

let _ddDriver = null;
let _ddTab = "profile";
// Buffer for fields edited on a tab the user later switches away from.
// renderDriverDrawerTab() rebuilds the body each time, so without this the
// values typed into Profile would be lost when the operator clicked
// Employment.  Save merges _ddPending with the currently visible inputs.
let _ddPending = {};

// Coaching-only drawer. Opens from the global Coaching feed when an
// operator clicks a driver row. Shows just that driver's coaching
// record + Log button + Copy driver link, NOT the rest of the driver
// record (employment / availability / license / docs).
async function openCoachingDrawer(driverId) {
  let drawer = document.getElementById("rr-cd-drawer");
  if (drawer) drawer.remove();

  const { data, error } = await sb.rpc("driver_record", { p_id: driverId });
  if (error) { toast("Couldn't load driver: " + error.message, "warn"); return; }
  // Reuse the same _ddDriver state so the existing log/edit/archive
  // handlers (data-rr-add-coaching, data-rr-coach-resolve, etc.) work
  // without rewiring.
  _ddDriver = data;

  drawer = document.createElement("div");
  drawer.id = "rr-cd-drawer";
  drawer.innerHTML = `
    <style>
      #rr-cd-drawer{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;justify-content:flex-end}
      #rr-cd-drawer .cd-panel{background:var(--surface);width:min(720px,100%);height:100%;display:flex;flex-direction:column;box-shadow:-8px 0 32px rgba(0,0,0,.18)}
      #rr-cd-drawer .cd-head{padding:18px 22px;border-bottom:1px solid var(--border);display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
      #rr-cd-drawer .cd-title{font-size:20px;font-weight:700;letter-spacing:-.01em;margin:0}
      #rr-cd-drawer .cd-sub{font-size:var(--fs-sm);color:var(--text-subtle);margin-top:2px}
      #rr-cd-drawer .cd-eyebrow{font-size:var(--fs-xs);font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px}
      #rr-cd-drawer .cd-close{background:transparent;border:0;font-size:var(--fs-xxl);color:var(--text-subtle);cursor:pointer;line-height:1;padding:0}
      #rr-cd-drawer .cd-body{flex:1;overflow-y:auto;padding:18px 22px}
    </style>
    <div class="cd-panel">
      <div class="cd-head">
        <div>
          <div class="cd-eyebrow">Coaching record</div>
          <h2 class="cd-title" id="rr-cd-title">—</h2>
          <div class="cd-sub" id="rr-cd-sub"></div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
          <button class="btn btn-sm" type="button" id="rr-cd-export"
            title="Open a print/PDF-friendly view of this driver's full coaching record. Use the browser's Print menu to save as PDF or send to a printer.">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;vertical-align:-2px"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
            Export / Print
          </button>
          <button class="cd-close" data-rr-cd-close aria-label="Close">×</button>
        </div>
      </div>
      <div class="cd-body" id="rr-cd-body"><div class="rr-loading">Loading</div></div>
    </div>`;
  document.body.appendChild(drawer);

  drawer.addEventListener("click", (e) => {
    if (e.target === drawer || e.target.closest("[data-rr-cd-close]")) { drawer.remove(); return; }
    if (e.target.closest("#rr-cd-export")) {
      e.preventDefault();
      openCoachingPrintView(driverId);
    }
  });

  const drv = data.driver;
  const titleEl = document.getElementById("rr-cd-title");
  if (titleEl) titleEl.textContent = displayDriverName(drv) || "—";
  const subEl = document.getElementById("rr-cd-sub");
  if (subEl) {
    const bits = [];
    if (drv.station_id) bits.push("Station");
    if (drv.hire_date)  bits.push(`Hired ${new Date(drv.hire_date).toLocaleDateString()}`);
    bits.push(`${(data.coachings || []).length} record${(data.coachings || []).length === 1 ? "" : "s"}`);
    subEl.textContent = bits.join(" · ");
  }
  const bodyEl = document.getElementById("rr-cd-body");
  if (bodyEl) bodyEl.innerHTML = renderCoachingTab(data.coachings, drv);
}

// Coaching record · printable export. Opens a self-contained HTML page
// in a new window with the driver's full coaching history formatted for
// printing or saving as PDF. Operator can use the browser's Print menu
// (Save as PDF) to send to HR / unemployment hearings / legal counsel.
async function openCoachingPrintView(driverId) {
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;

  const [driverRes, coachingsRes, editsRes, attRes, dspRes] = await Promise.all([
    sb.from("drivers").select("*").eq("id", driverId).single(),
    sb.from("coachings").select("*").eq("driver_id", driverId).order("occurred_at", { ascending: false }),
    sb.from("coaching_edits").select("*").order("edited_at", { ascending: false }),
    sb.from("coaching_attachments").select("coaching_id, file_name, mime_type, size_bytes, uploaded_at"),
    sb.from("dsps").select("name, short_code, metadata").eq("id", dspId).single(),
  ]);

  const drv  = driverRes?.data;
  const list = (coachingsRes?.data || []);
  const edits = (editsRes?.data || []);
  const attachments = (attRes?.data || []);
  const dsp = dspRes?.data || {};
  if (!drv) { toast("Couldn't load driver", "warn"); return; }

  const editsByCoaching = new Map();
  for (const ed of edits) {
    if (!editsByCoaching.has(ed.coaching_id)) editsByCoaching.set(ed.coaching_id, []);
    editsByCoaching.get(ed.coaching_id).push(ed);
  }
  const attByCoaching = new Map();
  for (const a of attachments) {
    if (!attByCoaching.has(a.coaching_id)) attByCoaching.set(a.coaching_id, []);
    attByCoaching.get(a.coaching_id).push(a);
  }

  const generated = new Date().toLocaleString();
  const escape = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const sevColor = (s) => ({info:"#475569", concern:"var(--blue-dark)", warning:"var(--amber-dark)", final:"var(--red)"}[s] || "#475569");
  const sevLabel = (s) => ({info:"Info", concern:"Concern", warning:"Warning", final:"Final"}[s] || s);

  const totalsBySeverity = list.reduce((acc, c) => {
    const k = c.severity || "concern";
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  const ackLabel = (m) => ({verbal:"Verbal", signed:"Signed", sms:"SMS confirmation", email:"Email confirmation"}[m] || m || "—");
  const actionLabel = {
    verbal: "Verbal warning", written: "Written warning", retraining: "Retraining",
    route_change: "Route change", suspension: "Suspension", no_action: "No action",
  };
  const renderActions = (a) => {
    if (!a || typeof a !== "object") return "—";
    const list = Object.keys(a).filter(k => a[k]).map(k => actionLabel[k] || k);
    return list.length ? list.map(escape).join(" · ") : "—";
  };

  const recordsHtml = list.length === 0
    ? `<div class="empty">No coaching records on file.</div>`
    : list.map((c, i) => {
        const eds = editsByCoaching.get(c.id) || [];
        const atts = attByCoaching.get(c.id) || [];
        const ack = (c.acknowledgment && c.acknowledgment !== "none")
          ? `${ackLabel(c.acknowledgment)} on ${c.acknowledged_at ? new Date(c.acknowledged_at).toLocaleString() : "—"}`
          : (c.driver_visible ? "Awaiting driver acknowledgment" : "Not visible to driver");
        const sigImg = (c.acknowledgment === "signed" && c.ack_signature_b64)
          ? `<div class="sig"><div class="sig-label">Driver signature</div><img alt="Signature" src="${escape(c.ack_signature_b64)}"/></div>`
          : "";
        return `
        <section class="rec">
          <div class="rec-head">
            <div>
              <span class="sev" style="background:${sevColor(c.severity)};">${escape(sevLabel(c.severity))}</span>
              <span class="rec-num">Record ${list.length - i} of ${list.length}</span>
            </div>
            <div class="rec-occurred">${c.occurred_at ? new Date(c.occurred_at).toLocaleString() : "—"}</div>
          </div>
          <div class="rec-meta">
            <div><span class="lbl">Topic</span><span>${escape(c.topic || "—")}</span></div>
            <div><span class="lbl">Type</span><span>${escape((c.type || "—").replace(/_/g, " "))}</span></div>
            <div><span class="lbl">Incident date</span><span>${c.incident_date ? new Date(c.incident_date + "T12:00:00").toLocaleDateString() : "—"}</span></div>
            <div><span class="lbl">Coached by</span><span>${escape(c.coached_by_name || "—")}</span></div>
          </div>
          <div class="rec-summary">${escape(c.summary || "(no summary)")}</div>
          ${c.notes ? `<div class="rec-notes">${escape(c.notes)}</div>` : ""}
          <div class="rec-fields">
            <div><span class="lbl">Action taken</span><span>${renderActions(c.action_taken)}</span></div>
            ${c.witness_name ? `<div><span class="lbl">Witness</span><span>${escape(c.witness_name)}${c.witness_role ? ` (${escape(c.witness_role)})` : ""}</span></div>` : ""}
            ${c.follow_up_at ? `<div><span class="lbl">Follow-up</span><span>${new Date(c.follow_up_at).toLocaleDateString()}${c.resolved_at ? ` · resolved ${new Date(c.resolved_at).toLocaleDateString()}` : ""}</span></div>` : ""}
            <div><span class="lbl">Driver acknowledgment</span><span>${escape(ack)}</span></div>
            ${c.privacy_tier === "hr_only" ? `<div><span class="lbl">Privacy</span><span class="hr-only">HR-only</span></div>` : ""}
            ${atts.length ? `<div><span class="lbl">Attachments</span><span>${atts.map(a => escape(a.file_name)).join(" · ")}</span></div>` : ""}
          </div>
          ${sigImg}
          ${eds.length ? `
            <details class="audit">
              <summary>Edit history (${eds.length})</summary>
              <table>
                <thead><tr><th>When</th><th>Who</th><th>Field</th><th>From</th><th>To</th></tr></thead>
                <tbody>${eds.map(ed => `
                  <tr>
                    <td>${new Date(ed.edited_at).toLocaleString()}</td>
                    <td>${escape(ed.edited_by_name || "—")}</td>
                    <td>${escape(ed.field_name)}</td>
                    <td>${escape(ed.old_value || "—")}</td>
                    <td>${escape(ed.new_value || "—")}</td>
                  </tr>`).join("")}</tbody>
              </table>
            </details>
          ` : ""}
        </section>`;
      }).join("");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Coaching record · ${escape(displayDriverName(drv))}</title>
<style>
  *{box-sizing:border-box}
  html,body{margin:0;background:#f5f5f5;color:#0f172a;font-family:Inter,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:var(--fs-md);line-height:1.55}
  .toolbar{position:sticky;top:0;background:#0f172a;color:#fff;padding:10px 18px;display:flex;align-items:center;justify-content:space-between;font-size:var(--fs-sm);z-index:5}
  .toolbar button{background:#fff;color:#0f172a;border:0;border-radius:6px;font:inherit;font-weight:600;padding:6px 12px;cursor:pointer}
  .page{max-width:780px;margin:18px auto 80px;background:#fff;padding:34px 44px;box-shadow:0 1px 4px rgba(0,0,0,.08);border-radius:6px}
  header{border-bottom:2px solid #0f172a;padding-bottom:14px;margin-bottom:18px}
  .brand{font-size:var(--fs-xs);font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#475569}
  h1{margin:4px 0 2px;font-size:var(--fs-xxl);letter-spacing:-.01em}
  .meta-line{font-size:var(--fs-sm);color:#475569}
  .totals{display:flex;gap:14px;flex-wrap:wrap;margin:14px 0 0;font-size:var(--fs-sm);color:#475569}
  .totals strong{color:#0f172a;font-weight:700}
  .rec{padding:18px 0;border-bottom:1px solid #e2e8f0;page-break-inside:avoid;break-inside:avoid}
  .rec:last-child{border-bottom:0}
  .rec-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
  .sev{display:inline-block;color:#fff;font-size:var(--fs-xs);font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:3px 9px;border-radius:10px;margin-right:8px}
  .rec-num{font-size:var(--fs-xs);color:#94a3b8}
  .rec-occurred{font-size:var(--fs-sm);color:#475569;font-variant-numeric:tabular-nums}
  .rec-meta{display:grid;grid-template-columns:repeat(2,1fr);gap:6px 18px;margin-bottom:10px}
  .rec-meta>div{display:flex;gap:8px;font-size:var(--fs-sm)}
  .lbl{display:inline-block;min-width:120px;color:#94a3b8;font-weight:600;font-size:var(--fs-xs);letter-spacing:.04em;text-transform:uppercase}
  .rec-summary{font-size:var(--fs-lg);font-weight:600;line-height:1.4;margin:6px 0}
  .rec-notes{white-space:pre-wrap;color:#334155;background:#f8fafc;padding:10px 12px;border-left:3px solid #cbd5e1;border-radius:3px;margin:8px 0}
  .rec-fields>div{display:flex;gap:8px;font-size:var(--fs-sm);margin-bottom:4px}
  .hr-only{color:var(--red);font-weight:700}
  .sig{margin-top:12px;border:1px solid #e2e8f0;padding:10px 12px;border-radius:4px;background:#fafafa}
  .sig-label{font-size:var(--fs-xs);font-weight:600;color:#94a3b8;letter-spacing:.05em;text-transform:uppercase;margin-bottom:6px}
  .sig img{max-width:300px;max-height:120px;display:block}
  .audit{margin-top:10px}
  .audit summary{cursor:pointer;font-size:var(--fs-xs);color:#475569;font-weight:600}
  .audit table{width:100%;border-collapse:collapse;font-size:var(--fs-xs);margin-top:8px}
  .audit th,.audit td{text-align:left;padding:5px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top}
  .audit th{background:#f8fafc;color:#475569;font-weight:600}
  .empty{padding:60px 0;text-align:center;color:#94a3b8;font-size:var(--fs-md)}
  footer{margin-top:30px;padding-top:14px;border-top:1px solid #e2e8f0;font-size:var(--fs-xs);color:#94a3b8;line-height:1.5}
  @media print {
    .toolbar{display:none}
    body{background:#fff}
    .page{box-shadow:none;margin:0;max-width:100%;padding:0 0;border-radius:0}
    .audit{display:block !important}
    .audit summary{display:none}
    .audit table{margin-top:4px}
  }
</style>
</head>
<body>
<div class="toolbar">
  <span>Coaching record · ${escape(displayDriverName(drv))} · generated ${escape(generated)}</span>
  <button type="button" onclick="window.print()">Print / Save as PDF</button>
</div>
<div class="page">
  <header>
    <div class="brand">${escape(dsp.name || "RouteReady")} · Coaching record</div>
    <h1>${escape(displayDriverName(drv))}</h1>
    <div class="meta-line">
      ${drv.hire_date ? `Hired ${new Date(drv.hire_date + "T12:00:00").toLocaleDateString()}` : ""}
      ${drv.dl_expires_on ? ` · DL expires ${new Date(drv.dl_expires_on + "T12:00:00").toLocaleDateString()}` : ""}
      ${drv.phone ? ` · ${escape(drv.phone)}` : ""}
      ${drv.email ? ` · ${escape(drv.email)}` : ""}
    </div>
    <div class="totals">
      <div><strong>${list.length}</strong> total record${list.length === 1 ? "" : "s"}</div>
      ${Object.entries(totalsBySeverity).map(([k, n]) => `<div><strong>${n}</strong> ${escape(sevLabel(k).toLowerCase())}</div>`).join("")}
    </div>
  </header>
  ${recordsHtml}
  <footer>
    Generated ${escape(generated)} for ${escape(dsp.name || "RouteReady")}.
    This document includes every coaching record on file for this driver, the audit trail of edits, and any driver acknowledgments captured.
    Records flagged HR-only have been included; redact before sharing externally if appropriate.
  </footer>
</div>
</body>
</html>`;

  const w = window.open("", "_blank");
  if (!w) { toast("Pop-up blocked. Allow pop-ups for this site to export the record.", "warn"); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

async function openDriverDrawer(driverId, opts) {
  // opts.tab — open the drawer with that tab pre-selected (e.g. the
  // Attendance Report row click drops the operator straight into the
  // driver's Attendance tab).
  const initialTab = (opts && opts.tab) || "profile";
  let drawer = document.getElementById("rr-dd-drawer");
  if (drawer) drawer.remove();
  drawer = document.createElement("div");
  drawer.id = "rr-dd-drawer";
  drawer.innerHTML = `
    <style>
      #rr-dd-drawer{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;justify-content:flex-end}
      #rr-dd-panel{width:760px;max-width:100%;background:var(--surface);height:100%;overflow-y:auto;border-left:1px solid var(--border);display:flex;flex-direction:column}
      .dd-head{padding:20px 28px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
      .dd-head h3{margin:0;font-size:20px;font-weight:600;letter-spacing:-.01em}
      .dd-head .sub{font-size:var(--fs-sm);color:var(--text-subtle);margin-top:2px}
      .dd-tabs{display:flex;gap:2px;background:var(--canvas);padding:3px;border-radius:9px;margin:16px 28px 0}
      .dd-tab{flex:1;background:transparent;border:0;font:inherit;font-size:var(--fs-sm);font-weight:600;color:var(--text-subtle);padding:8px 12px;border-radius:6px;cursor:pointer;transition:background .12s,color .12s}
      .dd-tab:hover{color:var(--text)}
      .dd-tab.active{background:var(--surface);color:var(--text);box-shadow:var(--shadow-sm)}
      .dd-body{padding:22px 28px;flex:1}
      /* Section header inside a tab — visually breaks up long forms and
         carries the self-serve vs DSP-only contract for the upcoming
         driver-app integration. */
      .dd-section{margin:0 0 18px;padding:0}
      .dd-section + .dd-section{margin-top:24px;padding-top:18px;border-top:1px solid var(--border)}
      .dd-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}
      .dd-section-title{font-size:var(--fs-md);font-weight:700;color:var(--text);letter-spacing:-.005em}
      .dd-section-sub{font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px;line-height:1.4}
      .dd-badge{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:3px 8px;border-radius:10px;white-space:nowrap}
      .dd-badge.driver{background:var(--green-soft);color:var(--green)}
      .dd-badge.dsp{background:var(--canvas);color:var(--text-muted);border:1px solid var(--border)}
      .dd-row{display:grid;grid-template-columns:180px 1fr;gap:14px;align-items:center;padding:10px 0;border-top:1px solid var(--border)}
      .dd-row:first-of-type{border-top:0}
      .dd-row label{font-size:var(--fs-sm);color:var(--text-muted);font-weight:500}
      .dd-row input,.dd-row select,.dd-row textarea{width:100%;background:var(--canvas);border:1px solid var(--border);border-radius:6px;padding:8px 10px;font:inherit;font-size:var(--fs-md);color:var(--text)}
      .dd-row input:focus,.dd-row select:focus,.dd-row textarea:focus{outline:none;border-color:var(--accent)}
      .dd-foot{padding:14px 28px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;background:var(--surface);position:sticky;bottom:0}
      .dd-list-row{display:grid;grid-template-columns:1fr auto;gap:12px;padding:12px 0;border-top:1px solid var(--border)}
      .dd-list-row:first-of-type{border-top:0}
      .dd-list-title{font-size:var(--fs-md);font-weight:600}
      .dd-list-sub{font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px}
      .dd-callout{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:8px;font-size:var(--fs-sm);line-height:1.5}
      .dd-callout.warn{background:var(--amber-soft);color:var(--text)}
      .dd-callout.warn strong{color:var(--amber)}
      .dd-callout svg{flex-shrink:0;margin-top:2px}
    </style>
    <div id="rr-dd-panel">
      <div class="dd-head">
        <div style="display:flex;align-items:center;gap:14px;min-width:0">
          <div class="avatar-sm" id="rr-dd-avatar" data-rr-driver-id="" style="width:48px;height:48px;font-size:var(--fs-lg);flex-shrink:0">--</div>
          <div style="min-width:0">
            <h3 id="rr-dd-title">Driver record</h3>
            <div class="sub" id="rr-dd-sub"></div>
          </div>
        </div>
        <button id="rr-dd-close" style="background:none;border:0;font-size:var(--fs-xl);cursor:pointer;color:var(--text-muted);padding:0 6px">×</button>
      </div>
      <div class="dd-tabs">
        <button type="button" class="dd-tab active" data-rr-dd-tab="profile">Profile</button>
        <button type="button" class="dd-tab" data-rr-dd-tab="employment">Employment</button>
        <button type="button" class="dd-tab" data-rr-dd-tab="license">License &amp; Certs</button>
        <button type="button" class="dd-tab" data-rr-dd-tab="attendance">Attendance</button>
        <button type="button" class="dd-tab" data-rr-dd-tab="availability">Availability</button>
        <button type="button" class="dd-tab" data-rr-dd-tab="documents">Documents</button>
      </div>
      <div class="dd-body" id="rr-dd-body"><div class="rr-loading">Loading</div></div>
      <div class="dd-foot" id="rr-dd-foot"></div>
    </div>`;
  document.body.appendChild(drawer);

  drawer.addEventListener("click", (e) => {
    if (e.target === drawer || e.target.id === "rr-dd-close" || e.target.closest("[data-rr-dd-close]")) drawer.remove();
  });

  _ddTab = initialTab;
  _ddPending = {};
  if (driverId) {
    await loadDriverDrawer(driverId);
  } else {
    // CREATE mode — empty placeholders, no fetch.
    _ddDriver = { driver: { id: null, status: "onboarding", hire_date: fmtIsoDate(new Date()) }, coachings: [], documents: [] };
    document.getElementById("rr-dd-title").textContent = "Add driver";
    document.getElementById("rr-dd-sub").textContent = "New record";
    // All tabs are clickable in CREATE mode so the operator can see
    // every field they'll fill out.  The per-tab save handlers still
    // require an existing driver record (Availability / License / DOT
    // / Documents all reference drivers.id) — they toast a "Save the
    // record first" prompt when triggered before the Overview save.
    renderDriverDrawerTab();
  }
}

async function loadDriverDrawer(driverId) {
  // Coaching-only drawer doesn't have rr-dd-* elements — refresh that
  // drawer instead and bail. Caller doesn't need to know which is open.
  if (document.getElementById("rr-cd-drawer") && !document.getElementById("rr-dd-drawer")) {
    return openCoachingDrawer(driverId);
  }
  if (!document.getElementById("rr-dd-drawer")) return;

  const { data, error } = await sb.rpc("driver_record", { p_id: driverId });
  if (error) { toast("Couldn't load driver: " + error.message, "warn"); return; }
  _ddDriver = data;

  const drv = data.driver;
  const titleEl = document.getElementById("rr-dd-title");
  if (!titleEl) return;
  titleEl.textContent = displayDriverName(drv) || "—";
  const sub = [
    drv.station_id ? "Station —" : "No station",
    drv.hire_date ? `Hired ${new Date(drv.hire_date).toLocaleDateString()}` : null,
    drv.tier ? `Tier ${drv.tier}` : null,
  ].filter(Boolean).join(" · ");
  document.getElementById("rr-dd-sub").textContent = sub;

  // Avatar in the drawer header — initials by default; the photo
  // painter (boot-time MutationObserver) replaces them with the
  // driver's photo when one's set.
  const avEl = document.getElementById("rr-dd-avatar");
  if (avEl) {
    avEl.setAttribute("data-rr-driver-id", drv.id);
    avEl.classList.remove("tier-a","tier-b","tier-c","tier-d");
    if (drv.tier) avEl.classList.add("tier-" + String(drv.tier).toLowerCase());
    avEl.textContent = displayDriverInitials(drv);
    delete avEl.dataset.rrPhotoPainted;
    avEl.style.backgroundImage = "";
    avEl.style.color           = "";
    _paintDriverAvatars(avEl.parentElement || document);
  }

  renderDriverDrawerTab();
}

// Capture every visible data-rr-dd-field input into _ddPending so its
// value survives a tab switch (each tab re-renders the body from scratch).
function _ddCaptureVisibleFields() {
  document.querySelectorAll("#rr-dd-drawer [data-rr-dd-field]").forEach(el => {
    const name = el.getAttribute("data-rr-dd-field");
    _ddPending[name] = el.type === "checkbox" ? el.checked : el.value;
  });
}

function renderDriverDrawerTab() {
  _ddCaptureVisibleFields();
  document.querySelectorAll("#rr-dd-drawer .dd-tab").forEach(t => {
    t.classList.toggle("active", t.getAttribute("data-rr-dd-tab") === _ddTab);
  });
  const body = document.getElementById("rr-dd-body");
  if (_ddTab === "profile")      renderProfileTab(body, _ddDriver.driver);
  if (_ddTab === "employment")   renderEmploymentTab(body, _ddDriver.driver);
  if (_ddTab === "license")      renderLicenseTab(body, _ddDriver.driver);
  if (_ddTab === "attendance")   renderAttendanceTab(body, _ddDriver.driver);
  if (_ddTab === "availability") renderAvailabilityTab(body, _ddDriver.driver, _ddDriver);
  if (_ddTab === "coaching")     body.innerHTML = renderCoachingTab(_ddDriver.coachings, _ddDriver.driver);
  if (_ddTab === "documents")    body.innerHTML = renderDocumentsTab(_ddDriver.documents);
  setDriverDrawerFoot();
}

function setDriverDrawerFoot() {
  const foot = document.getElementById("rr-dd-foot");
  if (!foot) return;
  if (_ddTab === "profile" || _ddTab === "employment" || _ddTab === "license") {
    foot.innerHTML = `<button class="btn btn-primary" data-rr-dd-save>Save record</button>`;
  } else if (_ddTab === "availability") {
    foot.innerHTML = `<button class="btn btn-primary" data-rr-avail-save>Save availability</button>`;
  } else {
    // Coaching / Documents add items inline; offer just a Close in the foot
    // so the layout is identical across tabs.
    foot.innerHTML = `<button class="btn" data-rr-dd-close>Close</button>`;
  }
}

function renderAvailabilityTab(body, d, record) {
  const meta = d.metadata || {};
  const avail = meta.availability || {};
  const days = avail.days || [];
  const earliest = typeof avail.earliest_start === "string" ? avail.earliest_start : "";
  const preferred = new Set(Array.isArray(avail.preferred_days) ? avail.preferred_days.filter(k => days.includes(k)) : []);
  const isAvail = (k) => days.includes(k);
  const dayKey = ["mon","tue","wed","thu","fri","sat","sun"];
  const dayLabel = { mon:"Mon", tue:"Tue", wed:"Wed", thu:"Thu", fri:"Fri", sat:"Sat", sun:"Sun" };
  const availBoxes = dayKey.map(k => `
    <label style="display:flex;align-items:center;gap:8px;font-size:var(--fs-md);padding:6px 10px;border:1px solid var(--border);border-radius:6px;cursor:pointer;background:var(--canvas);user-select:none">
      <input type="checkbox" data-rr-avail-day="${k}" ${isAvail(k) ? "checked" : ""}/>
      <span style="font-weight:600">${dayLabel[k]}</span>
    </label>`).join("");
  const prefBoxes = dayKey.map(k => `
    <label style="display:flex;align-items:center;gap:8px;font-size:var(--fs-md);padding:6px 10px;border:1px solid var(--border);border-radius:6px;cursor:${isAvail(k) ? "pointer" : "not-allowed"};background:var(--canvas);user-select:none;${isAvail(k) ? "" : "opacity:.4"}">
      <input type="checkbox" data-rr-avail-pref="${k}" ${preferred.has(k) ? "checked" : ""} ${isAvail(k) ? "" : "disabled"}/>
      <span style="font-weight:600">${dayLabel[k]}</span>
    </label>`).join("");

  // Surface the request workflow state so the operator understands
  // why the checkboxes might not match a recent approval (with the
  // default lead time, an approved change doesn't take effect — and
  // doesn't change metadata.availability.days — until effective_from).
  const todayIso   = new Date().toISOString().slice(0, 10);
  const pending    = record?.availability_pending || null;
  const latest     = record?.availability_latest  || null;
  const fmtDays    = (arr) => (Array.isArray(arr) && arr.length)
    ? arr.map((k) => dayLabel[k] || k).join(", ")
    : "no days";

  const startStr = (v) => (v && _fmtTime12(v)) || v || "";
  const pendStart = pending && startStr(pending.earliest_start) ? `, earliest start ${escapeHtml(startStr(pending.earliest_start))}` : "";
  const latStart  = latest  && startStr(latest.earliest_start)  ? `, earliest start ${escapeHtml(startStr(latest.earliest_start))}`  : "";

  let stateBanner = "";
  if (pending) {
    stateBanner = `
      <div style="margin-bottom:var(--s-3);padding:8px 12px;border-radius:var(--r-md);background:var(--amber-soft);border:1px solid rgba(217,119,6,.2);font-size:var(--fs-sm);color:var(--amber);line-height:1.5">
        <strong>Driver requested a change</strong> — ${escapeHtml(fmtDays(pending.days))}${pendStart}.
        Awaiting your decision in Drivers → Availability.
      </div>`;
  } else if (latest && latest.status === "approved" && latest.effective_from && latest.effective_from > todayIso) {
    // Approved but not yet effective — explains the mismatch.
    stateBanner = `
      <div style="margin-bottom:var(--s-3);padding:8px 12px;border-radius:var(--r-md);background:var(--accent-soft);border:1px solid var(--accent-border);font-size:var(--fs-sm);color:var(--accent-text);line-height:1.5">
        <strong>Approved change takes effect ${escapeHtml(_fmtAvailDateShort(latest.effective_from))}</strong>
        ${latest.effective_until ? ` – ${escapeHtml(_fmtAvailDateShort(latest.effective_until))}` : ""}:
        ${escapeHtml(fmtDays(latest.days))}${latStart}.
        The toggles below still show today's live availability until then.
      </div>`;
  } else if (latest && latest.status === "approved" && latest.effective_until && latest.effective_until >= todayIso) {
    // Currently in effect.
    stateBanner = `
      <div style="margin-bottom:var(--s-3);padding:8px 12px;border-radius:var(--r-md);background:var(--green-soft);border:1px solid rgba(5,150,105,.2);font-size:var(--fs-sm);color:var(--green);line-height:1.5">
        Current availability is from an approved request, in effect through ${escapeHtml(_fmtAvailDateShort(latest.effective_until))}.
      </div>`;
  }

  body.innerHTML = `
    ${stateBanner}
    <div class="dd-row" style="grid-template-columns:160px 1fr;align-items:flex-start">
      <label>Available days</label>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">${availBoxes}</div>
    </div>
    <div class="dd-row" style="grid-template-columns:160px 1fr;align-items:center">
      <label>Earliest start</label>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <select data-rr-avail-start style="font:inherit;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--canvas);color:var(--text)">${_availStartOptionsHtml(earliest)}</select>
        <span style="font-size:var(--fs-xs);color:var(--text-subtle)">Earliest time of day this driver can begin a shift.</span>
      </div>
    </div>
    <div class="dd-row" style="grid-template-columns:160px 1fr;align-items:flex-start">
      <label>Preferred days</label>
      <div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">${prefBoxes}</div>
        <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:6px">Days the driver most wants to work. Only days in their available set can be preferred.</div>
      </div>
    </div>`;
}

// _ddVal — read a field's display value, preferring an unsaved edit
// captured on a prior tab over the canonical record value.  Lets the
// operator type into Profile, switch to Employment, hit Save, and have
// both sets of changes land in the same RPC call.
function _ddVal(name, fallback) {
  return Object.prototype.hasOwnProperty.call(_ddPending, name) ? _ddPending[name] : (fallback ?? "");
}

// Profile — what the driver themselves can edit from the driver app.
// Identity / contact / emergency contact.  Carries the green "Driver
// self-serve" badge so operators know these fields will be writeable
// from the driver app.
function renderProfileTab(body, d) {
  const showPronouns = window.RR.dsp?.metadata?.drivers?.show_pronouns !== false;
  const v = (s) => escapeHtml(s ?? "");
  body.innerHTML = `
    <div class="dd-section">
      <div class="dd-section-head">
        <div>
          <div class="dd-section-title">Identity</div>
          <div class="dd-section-sub">Name and personal details shown across the dashboard and driver app.</div>
        </div>
        <span class="dd-badge driver">Driver self-serve</span>
      </div>
      <div class="dd-row"><label>Full name</label><input data-rr-dd-field="full_name" data-rr-capitalize autocapitalize="words" value="${v(_ddVal("full_name", d.full_name))}"/></div>
      <div class="dd-row"><label>Preferred name</label><input data-rr-dd-field="preferred_name" data-rr-capitalize autocapitalize="words" value="${v(_ddVal("preferred_name", d.preferred_name))}"/></div>
      ${showPronouns ? `<div class="dd-row"><label>Pronouns</label><input data-rr-dd-field="pronouns" placeholder="he/him · she/her · they/them" value="${v(_ddVal("pronouns", d.pronouns))}"/></div>` : ""}
    </div>

    <div class="dd-section">
      <div class="dd-section-head">
        <div>
          <div class="dd-section-title">Contact</div>
          <div class="dd-section-sub">How RouteReady reaches the driver — phone for SMS, email for magic-link sign-in.</div>
        </div>
        <span class="dd-badge driver">Driver self-serve</span>
      </div>
      <div class="dd-row"><label>Phone</label><input data-rr-dd-field="phone" value="${v(_ddVal("phone", d.phone))}"/></div>
      <div class="dd-row"><label>Email</label><input type="email" data-rr-dd-field="email" value="${v(_ddVal("email", d.email))}"/></div>
      <div class="dd-row"><label>Address</label><input data-rr-dd-field="address" value="${v(_ddVal("address", d.address))}"/></div>
    </div>

    <div class="dd-section">
      <div class="dd-section-head">
        <div>
          <div class="dd-section-title">Emergency contact</div>
          <div class="dd-section-sub">Who to call if the driver is in an accident or medical emergency.</div>
        </div>
        <span class="dd-badge driver">Driver self-serve</span>
      </div>
      <div class="dd-row"><label>Contact name</label><input data-rr-dd-field="emergency_contact_name" placeholder="Name" value="${v(_ddVal("emergency_contact_name", d.emergency_contact_name))}"/></div>
      <div class="dd-row"><label>Contact phone</label><input data-rr-dd-field="emergency_contact_phone" placeholder="Phone" value="${v(_ddVal("emergency_contact_phone", d.emergency_contact_phone))}"/></div>
    </div>`;
}

// Employment — DSP-only.  Status / station / dates / pay / onboarding
// milestones / driver-app invite.  The driver app does NOT show this
// data: it's the operator's record of how the driver fits into the
// business.
async function renderEmploymentTab(body, d) {
  const v = (s) => escapeHtml(s ?? "");
  const stations = await getDriverStationsCached();
  const currentStation = _ddVal("station_id", d.station_id);
  const stationOptions = `<option value="">— No station —</option>` +
    stations.map(s => `<option value="${s.id}" ${s.id === currentStation ? "selected" : ""}>${escapeHtml(s.code)}${s.name ? ` · ${escapeHtml(s.name)}` : ""}</option>`).join("");
  const currentStatus = _ddVal("status", d.status);
  const payRate = _ddVal("pay_hourly", d.metadata?.pay?.hourly_rate ?? "");
  body.innerHTML = `
    <div class="dd-section">
      <div class="dd-section-head">
        <div>
          <div class="dd-section-title">Assignment</div>
          <div class="dd-section-sub">Where this driver works and their current employment state.</div>
        </div>
        <span class="dd-badge dsp">DSP only</span>
      </div>
      <div class="dd-row"><label>Status</label>
        <select data-rr-dd-field="status">
          ${["onboarding","active","leave","inactive","terminated"].map(s => `<option value="${s}" ${s === currentStatus ? "selected" : ""}>${s}</option>`).join("")}
        </select>
      </div>
      <div class="dd-row"><label>Station</label>
        <select data-rr-dd-field="station_id">${stationOptions}</select>
      </div>
    </div>

    <div class="dd-section">
      <div class="dd-section-head">
        <div>
          <div class="dd-section-title">Dates</div>
          <div class="dd-section-sub">Birthday is used for tier eligibility and milestone reminders.</div>
        </div>
        <span class="dd-badge dsp">DSP only</span>
      </div>
      <div class="dd-row"><label>Birthday</label><input type="date" data-rr-dd-field="birthday" value="${v(_ddVal("birthday", d.birthday))}"/></div>
      <div class="dd-row"><label>Hire date</label><input type="date" data-rr-dd-field="hire_date" value="${v(_ddVal("hire_date", d.hire_date))}"/></div>
    </div>

    <div class="dd-section">
      <div class="dd-section-head">
        <div>
          <div class="dd-section-title">Compensation</div>
          <div class="dd-section-sub">Used to project payroll on the schedule grid.</div>
        </div>
        <span class="dd-badge dsp">DSP only</span>
      </div>
      <div class="dd-row"><label>Pay rate</label>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="color:var(--text-subtle)">$</span>
          <input type="number" min="0" max="200" step="0.01" data-rr-dd-field="pay_hourly" placeholder="22.50" value="${v(payRate)}" style="max-width:140px"/>
          <span style="color:var(--text-subtle);font-size:var(--fs-sm)">/ hour</span>
        </div>
      </div>
    </div>

    <div class="dd-section">
      <div class="dd-section-head">
        <div>
          <div class="dd-section-title">Onboarding</div>
          <div class="dd-section-sub">Milestones recorded by the DSP during hire.</div>
        </div>
        <span class="dd-badge dsp">DSP only</span>
      </div>
      <div class="dd-row"><label>Background check</label><input type="datetime-local" data-rr-dd-field="background_check_completed_at" value="${v((_ddVal("background_check_completed_at", d.background_check_completed_at) || '').slice(0,16))}"/></div>
      <div class="dd-row"><label>Drug test</label><input type="datetime-local" data-rr-dd-field="drug_test_completed_at" value="${v((_ddVal("drug_test_completed_at", d.drug_test_completed_at) || '').slice(0,16))}"/></div>
      <div class="dd-row"><label>Training scheduled</label><input type="datetime-local" data-rr-dd-field="training_scheduled_at" value="${v((_ddVal("training_scheduled_at", d.training_scheduled_at) || '').slice(0,16))}"/></div>
      <div class="dd-row"><label>Training date</label><input type="date" data-rr-dd-field="training_date" value="${v(_ddVal("training_date", d.training_date))}"/></div>
    </div>

    <div class="dd-section">
      <div class="dd-section-head">
        <div>
          <div class="dd-section-title">Driver app access</div>
          <div class="dd-section-sub">Issue an invite code so the driver can sign into the RouteReady app.</div>
        </div>
        <span class="dd-badge dsp">DSP only</span>
      </div>
      <div class="dd-row" style="grid-template-columns:1fr;gap:10px">
        <div>
          <button type="button" class="btn btn-sm" data-rr-issue-invite>Generate invite code</button>
          <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:6px;line-height:1.4">Driver enters this on the RouteReady app at <strong>gorouteready.com/app/</strong>. One active code at a time · expires in 14 days.</div>
          <div data-rr-invite-display style="margin-top:10px;display:none"></div>
        </div>
      </div>
    </div>`;
}

// License & Certs — license number / image upload (driver self-serve)
// + expiration verification + DOT/XL certs (DSP only).  When the
// driver has uploaded an image but no expiration date is on file, an
// amber callout reminds the DSP to type the date off the photo.
async function renderLicenseTab(body, d) {
  const v = (s) => escapeHtml(s ?? "");
  // Resolve a viewable URL for the stored DL image, if any.
  let imgUrl = null;
  if (d.dl_image_path) {
    const { data: signed } = await sb.storage.from("driver-documents")
      .createSignedUrl(d.dl_image_path, 60 * 60);
    imgUrl = signed?.signedUrl || null;
  }

  // Expiry visual: pill colors past = red, ≤30 days = amber, else neutral.
  const currentExpiry = _ddVal("dl_expires_on", d.dl_expires_on);
  let expiryPill = '<span style="color:var(--text-subtle);font-size:var(--fs-sm)">No expiry on file</span>';
  if (currentExpiry) {
    const exp = new Date(currentExpiry);
    const days = Math.floor((exp.getTime() - Date.now()) / 86400000);
    let style = "background:var(--canvas);color:var(--text-muted)";
    let suffix = `${days} days from today`;
    if (days < 0)        { style = "background:var(--red-soft);color:var(--red)";   suffix = `Expired ${-days} days ago`; }
    else if (days <= 30) { style = "background:var(--amber-soft);color:var(--amber)"; suffix = `Expires in ${days} days`; }
    expiryPill = `<span class="tag" style="${style}">${exp.toLocaleDateString()} · ${suffix}</span>`;
  }

  // The verification callout fires when the driver has uploaded an
  // image but the expiration date is still blank — a real-world
  // scenario once the driver app DL upload ships.
  const needsVerify = !!d.dl_image_path && !currentExpiry;
  const verifyCallout = needsVerify ? `
    <div class="dd-callout warn" style="margin-top:12px">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
      <div><strong>Verification needed.</strong> Driver uploaded a license image but no expiration is on file. Read the date off the photo and enter it above.</div>
    </div>` : "";

  const dotChecked = _ddVal("dot_certified", d.dot_certified) ? "checked" : "";
  const xlChecked  = _ddVal("xl_certified",  d.xl_certified)  ? "checked" : "";

  body.innerHTML = `
    <div class="dd-section">
      <div class="dd-section-head">
        <div>
          <div class="dd-section-title">Driver's license</div>
          <div class="dd-section-sub">Driver enters the number and uploads a photo from the app. The DSP verifies the expiration date.</div>
        </div>
        <span class="dd-badge driver">Driver upload</span>
      </div>
      <div class="dd-row"><label>License number</label><input data-rr-dd-field="dl_number" placeholder="DL number" value="${v(_ddVal("dl_number", d.dl_number))}"/></div>
      <div class="dd-row"><label>Expiration <span class="dd-badge dsp" style="margin-left:6px">DSP verifies</span></label>
        <div>
          <input type="date" data-rr-dd-field="dl_expires_on" value="${v(currentExpiry)}" style="margin-bottom:6px"/>
          ${expiryPill}
        </div>
      </div>
      <div style="margin-top:14px">
        <div style="font-size:var(--fs-xs);font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px">License image</div>
        ${imgUrl
          ? `<a href="${imgUrl}" target="_blank" rel="noreferrer" style="display:block">
               <img src="${imgUrl}" style="max-width:100%;max-height:320px;border:1px solid var(--border);border-radius:8px;background:var(--canvas)" alt="Drivers license"/>
             </a>
             <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
               <input type="file" id="rr-dl-file" accept="image/*" />
               <button class="btn btn-sm" data-rr-dl-upload>Replace</button>
               <button class="btn btn-sm" data-rr-dl-remove style="color:var(--red)">Remove</button>
             </div>`
          : `<div style="border:1px dashed var(--border);border-radius:8px;padding:24px;text-align:center;color:var(--text-subtle);font-size:var(--fs-md);margin-bottom:10px">No image uploaded yet. Driver can upload from the app, or you can attach one here.</div>
             <div style="display:flex;gap:8px;align-items:center">
               <input type="file" id="rr-dl-file" accept="image/*" />
               <button class="btn btn-primary btn-sm" data-rr-dl-upload>Upload license image</button>
             </div>`}
        ${verifyCallout}
      </div>
    </div>

    <div class="dd-section">
      <div class="dd-section-head">
        <div>
          <div class="dd-section-title">Certifications</div>
          <div class="dd-section-sub">Smart Fill uses these gates to decide who can be assigned to certified service types.</div>
        </div>
        <span class="dd-badge dsp">DSP only</span>
      </div>
      <div class="dd-row" style="align-items:flex-start">
        <label>DOT certification</label>
        <div>
          <label style="display:flex;gap:10px;align-items:center;cursor:pointer;padding:8px 0">
            <input type="checkbox" data-rr-dd-field="dot_certified" ${dotChecked} style="cursor:pointer;width:16px;height:16px"/>
            <span style="font-size:var(--fs-md);color:var(--text)">Driver is DOT certified</span>
          </label>
          <div style="font-size:var(--fs-xs);color:var(--text-subtle);line-height:1.4;margin-top:4px">Required for Step Van routes. Smart Fill blocks DOT-required service types unless this is checked.</div>
        </div>
      </div>
      <div class="dd-row" style="align-items:flex-start">
        <label>XL certification</label>
        <div>
          <label style="display:flex;gap:10px;align-items:center;cursor:pointer;padding:8px 0">
            <input type="checkbox" data-rr-dd-field="xl_certified" ${xlChecked} style="cursor:pointer;width:16px;height:16px"/>
            <span style="font-size:var(--fs-md);color:var(--text)">Driver is XL certified</span>
          </label>
          <div style="font-size:var(--fs-xs);color:var(--text-subtle);line-height:1.4;margin-top:4px">Required for Extra-Large vans. Smart Fill blocks XL routes unless this is checked.</div>
        </div>
      </div>
    </div>`;
}

// ─── Driver drawer · Attendance tab ───────────────────────────────────
//
// Per-driver attendance report: where the driver currently stands
// against the policy, recent stats, every counted event in the
// window, every coaching they've received.  Lets the dispatcher get
// the full story without leaving the drawer.
async function renderAttendanceTab(body, d) {
  if (!d || !d.id) {
    body.innerHTML = `<div class="rr-empty-inline">Save the driver record first, then their attendance history will appear here.</div>`;
    return;
  }
  body.innerHTML = `<div class="rr-loading">Loading</div>`;
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;

  const evalP = (typeof _evalPolicy === "function") ? _evalPolicy() : null;
  const decay = evalP?.decay_days || 90;
  const sinceDate = new Date(); sinceDate.setDate(sinceDate.getDate() - decay);
  const sinceIso  = fmtIsoDate(sinceDate);
  const todayIso  = fmtIsoDate(new Date());

  const [shiftsRes, coachRes] = await Promise.all([
    sb.from("shifts")
      .select("id, date, status")
      .eq("dsp_id", dspId)
      .eq("driver_id", d.id)
      .gte("date", sinceIso)
      .lte("date", todayIso)
      .order("date", { ascending: false }),
    sb.from("coachings")
      .select("id, severity, occurred_at, acknowledged_at, signed_at, delivery_required, summary, notes, triggering_shift_id")
      .eq("dsp_id", dspId)
      .eq("driver_id", d.id)
      .eq("topic", "attendance")
      .eq("driver_visible", true)
      .gte("occurred_at", sinceDate.toISOString())
      .is("archived_at", null)
      .order("occurred_at", { ascending: false }),
  ]);

  const shifts    = shiftsRes?.data    || [];
  const coachings = coachRes?.data     || [];

  // Stats over the policy window.
  const sched   = shifts.length;
  const present = shifts.filter(s => s.status === "completed").length;
  const late    = shifts.filter(s => s.status === "late").length;
  const callout = shifts.filter(s => s.status === "called_off").length;
  const noshow  = shifts.filter(s => s.status === "no_show").length;
  const vto     = shifts.filter(s => s.status === "vto").length;
  const attRate = sched > 0 ? Math.round(((present + late) / sched) * 100) : 0;

  // Points & ladder rung from the policy blocks.
  const ptsCallout = evalP?.events?.callout ? Number(evalP.events.callout.points) || 0 : 0;
  const ptsNoshow  = evalP?.events?.no_show ? Number(evalP.events.no_show.points) || 0 : 0;
  const ptsLate    = evalP?.events?.late    ? Number(evalP.events.late.points)    || 0 : 0;
  const points = (callout * ptsCallout) + (noshow * ptsNoshow) + (late * ptsLate);

  let standingLabel = "Clear";
  let standingClass = "ok";
  let nextRung = null;
  let pointsToNext = 0;
  if (evalP && evalP.enabled) {
    const rung = (typeof _evalLadderRung === "function") ? _evalLadderRung(evalP, points) : null;
    if (rung) {
      standingLabel = (_COACHING_SEV_LABEL && _COACHING_SEV_LABEL[rung.severity]) || rung.severity;
      standingClass = rung.severity === "verbal" ? "warn" : "bad";
    }
    // Forecast — find the next-higher unreached rung.
    for (const r of (evalP.ladder || [])) {
      if (r.threshold > points) { nextRung = r; pointsToNext = r.threshold - points; break; }
    }
  } else {
    standingLabel = "Policy off";
  }

  // Build per-shift event rows so the timeline shows the coaching
  // (if any) that each event triggered.
  const coachByShift = new Map();
  for (const c of coachings) {
    if (c.triggering_shift_id && !coachByShift.has(c.triggering_shift_id)) coachByShift.set(c.triggering_shift_id, c);
  }
  const eventRows = shifts
    .filter(s => ["called_off", "no_show", "late"].includes(s.status))
    .map(s => {
      const label  = s.status === "called_off" ? "Callout" : s.status === "no_show" ? "No-show" : "Late";
      const color  = s.status === "called_off" ? "var(--amber)" : s.status === "no_show" ? "var(--red)" : "var(--text-muted)";
      const points = s.status === "called_off" ? ptsCallout : s.status === "no_show" ? ptsNoshow : ptsLate;
      const c = coachByShift.get(s.id);
      const triggered = c
        ? ` <span style="color:var(--text-subtle);font-size:var(--fs-xs)">→ triggered ${escapeHtml(_COACHING_SEV_LABEL?.[c.severity] || c.severity)}</span>`
        : "";
      return `
        <div class="att-tl-row">
          <div class="att-tl-date">${new Date(s.date + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div>
          <div class="att-tl-event"><span style="color:${color};font-weight:600">${escapeHtml(label)}</span>${triggered}</div>
          <div class="att-tl-pts" style="color:var(--text-subtle);font-size:var(--fs-xs)">${points > 0 ? "+" + points + " pt" + (points === 1 ? "" : "s") : "—"}</div>
        </div>`;
    }).join("");

  const coachRows = coachings.map(c => {
    const sevLabel = (_COACHING_SEV_LABEL && _COACHING_SEV_LABEL[c.severity]) || c.severity;
    const ack = c.acknowledged_at
      ? `<span class="att-coach-chip done">✓ ${c.signed_at ? "Signed" : "Acknowledged"}</span>`
      : (c.delivery_required && c.delivery_required !== "none"
          ? `<span class="att-coach-chip pending">Awaiting ack</span>`
          : `<span class="att-coach-chip">Sent</span>`);
    return `
      <div class="att-tl-row">
        <div class="att-tl-date">${new Date(c.occurred_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div>
        <div class="att-tl-event"><span style="font-weight:600">${escapeHtml(sevLabel)}</span>${c.summary ? ` <span style="color:var(--text-subtle)">· ${escapeHtml(c.summary)}</span>` : ""}</div>
        <div class="att-tl-pts">${ack}</div>
      </div>`;
  }).join("");

  const forecast = evalP && evalP.enabled && nextRung
    ? `<div class="dd-callout warn" style="margin-top:8px">
         <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
         <div><strong>${pointsToNext} more point${pointsToNext === 1 ? "" : "s"}</strong> until ${escapeHtml(_COACHING_SEV_LABEL?.[nextRung.severity] || nextRung.severity)} (${escapeHtml(String(nextRung.threshold))} pts).</div>
       </div>`
    : "";

  body.innerHTML = `
    <div class="dd-section">
      <div class="dd-section-head">
        <div>
          <div class="dd-section-title">Current standing</div>
          <div class="dd-section-sub">Last ${decay} days · per the active attendance policy</div>
        </div>
        <span class="status-pill status-pill-${standingClass === "warn" ? "warning" : standingClass === "bad" ? "danger" : "neutral"}">${escapeHtml(standingLabel)}</span>
      </div>
      <div class="att-stat-grid">
        <div class="att-stat"><div class="att-stat-label">Points</div><div class="att-stat-value">${points}</div></div>
        <div class="att-stat"><div class="att-stat-label">Attendance</div><div class="att-stat-value">${attRate}%</div></div>
        <div class="att-stat"><div class="att-stat-label">Scheduled</div><div class="att-stat-value">${sched}</div></div>
        <div class="att-stat"><div class="att-stat-label">Callouts</div><div class="att-stat-value">${callout}</div></div>
        <div class="att-stat"><div class="att-stat-label">No-shows</div><div class="att-stat-value">${noshow}</div></div>
        <div class="att-stat"><div class="att-stat-label">Late</div><div class="att-stat-value">${late}</div></div>
        <div class="att-stat"><div class="att-stat-label">VTO</div><div class="att-stat-value">${vto}</div></div>
      </div>
      ${forecast}
    </div>

    <div class="dd-section">
      <div class="dd-section-head">
        <div>
          <div class="dd-section-title">Attendance timeline</div>
          <div class="dd-section-sub">Every counted event in the window.</div>
        </div>
      </div>
      ${eventRows || '<div class="rr-empty-inline">No callouts, no-shows, or late arrivals in the last ' + decay + ' days.</div>'}
    </div>

    <div class="dd-section">
      <div class="dd-section-head">
        <div>
          <div class="dd-section-title">Coachings</div>
          <div class="dd-section-sub">Sent under the attendance policy.</div>
        </div>
        <button type="button" class="btn btn-sm" data-rr-coach-report="1"
          data-rr-coach-driver="${escapeHtml(d.id)}"
          data-rr-coach-driver-name="${escapeHtml(displayDriverName(d) || "")}"
          data-rr-coach-severity="${escapeHtml((evalP?.ladder?.find(r => r.threshold > 0)?.severity) || "verbal")}"
          data-rr-coach-summary="Attendance · ${callout} callout${callout === 1 ? "" : "s"}, ${noshow} no-show${noshow === 1 ? "" : "s"}, ${late} late"
          data-rr-coach-points="${points}"
          data-rr-coach-callouts="${callout}"
          data-rr-coach-noshows="${noshow}"
          data-rr-coach-late="${late}"
          data-rr-coach-occ="${callout + noshow + late}">Send coaching</button>
      </div>
      ${coachRows || '<div class="rr-empty-inline">No coachings yet.</div>'}
    </div>`;
}

// ─── Driver chat inbox · Messages view ────────────────────────────────
// Unified view of every driver's thread. Left list is fed by
// dispatch_chat_threads(); right panel shows the selected driver's
// messages via dispatch_chat_thread() and accepts replies via
// dispatch_chat_send(). Both sides poll every 8s while the view is
// active.
let _msgInboxList = [];
let _msgInboxSelectedId = null;
let _msgInboxListTimer = null;
let _msgInboxThreadTimer = null;

async function loadDriverChatInbox() {
  await refreshDriverChatList(true);
  if (_msgInboxListTimer) clearInterval(_msgInboxListTimer);
  _msgInboxListTimer = setInterval(() => {
    // Only poll while the operator is on the direct messages tab.  Without
    // the mode guard this timer overwrites the list element with direct
    // chats every 8 seconds even when the operator has switched to the
    // Channels tab — flicker + bouncing them off Channels back to Direct.
    if (
      document.getElementById("view-messages")?.classList.contains("active") &&
      _msgInboxMode === "direct"
    ) {
      refreshDriverChatList(false);
    } else {
      clearInterval(_msgInboxListTimer); _msgInboxListTimer = null;
    }
  }, 8000);
}

// Compute the actual available height for the messaging shell from
// its position on the page minus a small buffer.  This avoids the
// fragile calc(100vh - 240px) approximation, which guesses chrome
// height and overflows the viewport when the guess is off.  Called
// on Messages-view enter + on resize.
function _fitMsgShell() {
  const el = document.querySelector(".msg-shell");
  if (!el) return;
  const top = el.getBoundingClientRect().top;
  // Page padding-bottom is 0; we just want a tiny breathing-room
  // gap so the shell doesn't kiss the very edge.
  const target = Math.max(380, window.innerHeight - top - 16);
  el.style.height = target + "px";
  // The 520px min-height was forcing a too-tall shell on small
  // viewports.  Drop it once we're driving height ourselves.
  el.style.minHeight = "0";
}
// `_syncComposerPos` was the JS-driven coordinator for the previous
// `position:fixed` composer (PRs #582, #587, #598): it wrote
// `--rr-mc-left/width/bottom` to keep the floating composer aligned
// with the conv pane, and `--rr-mc-thread-pad` to reserve a gap at
// the bottom of the thread so bubbles wouldn't land behind the
// overlay.  That math was a moving target — typing-pill flickers,
// ResizeObserver lag, textarea overflow-y gutter, image-load
// reflow — and the bottom bubble kept clipping behind the composer.
//
// The composer is now a real grid child of `.rr-mc-shell` (see
// `.rr-mc-composer` CSS in index.html).  Layout is mechanical: the
// thread and composer occupy adjacent grid rows, so they cannot
// overlap and no bottom padding is required on the thread.
//
// We keep this function as a no-op stub so the dozens of callers
// scattered through this file (form input, view-switch, etc.) keep
// working without a coordinated edit.  It also clears any stale
// CSS variables left over from before the refactor in case the page
// was loaded with an older cached HTML/CSS.
function _syncComposerPos() {
  const root = document.documentElement;
  // Belt-and-suspenders: if a stale CSS rule somewhere still reads
  // these vars, force them to neutral values that won't move the
  // composer or pad the thread.
  root.style.setProperty("--rr-mc-thread-pad", "0px");
  root.style.setProperty("--rr-mc-bottom", "0px");
  root.style.setProperty("--rr-mc-left", "0px");
  root.style.setProperty("--rr-mc-width", "auto");
}
// `_ensureComposerResizeWatch` was binding a ResizeObserver to the
// composer that re-fired `_syncComposerPos` on every height change
// (textarea grow, typing pill toggle).  With the composer now a
// regular grid child, height changes shrink the thread row via the
// grid track sizing algorithm — no JS coordination needed.  Kept as
// a no-op so existing call sites compile.
function _ensureComposerResizeWatch() { /* deprecated — see _syncComposerPos */ }
window.addEventListener("resize", () => { _fitMsgShell(); });
// Run whenever the Messages view becomes active (the goto wrapper
// adds 'active' to the corresponding .view).  MutationObserver
// avoids touching every goto site.
new MutationObserver(() => {
  if (document.getElementById("view-messages")?.classList.contains("active")) {
    _fitMsgShell();
  }
}).observe(document.body, { attributes: true, subtree: true, attributeFilter: ["class"] });
// First paint pass.
setTimeout(_fitMsgShell, 0);

// Belt-and-suspenders: if the CmdK overflow:hidden ever leaks
// (e.g. tab close with palette open, navigation while open), strip
// it on Messages-view enter so the body can scroll if the layout
// math somehow still leaves the composer below the fold.
new MutationObserver(() => {
  if (document.getElementById("view-messages")?.classList.contains("active")) {
    document.body.classList.remove("rr-cmdk-open");
  }
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });


async function refreshDriverChatList(autoSelect) {
  const list = document.getElementById("rr-msg-driver-list");
  if (!list) return;
  const { data, error } = await sb.rpc("dispatch_chat_threads");
  if (error) {
    if (_isAuthError(error)) {
      list.innerHTML = `<div style="padding:32px 20px;text-align:center"><div style="font-weight:600;color:var(--text);margin-bottom:6px">Your session expired</div><div style="color:var(--text-subtle);font-size:var(--fs-sm);margin-bottom:14px">Sign in again to load your conversations.</div><button type="button" data-rr-relogin style="background:var(--accent,#3b5bdb);color:#fff;border:0;border-radius:6px;padding:8px 14px;cursor:pointer;font-size:var(--fs-sm);font-weight:600">Sign in again</button></div>`;
      list.querySelector("[data-rr-relogin]")?.addEventListener("click", () => _forceRelogin("session_expired"));
      return;
    }
    list.innerHTML = `<div style="padding:24px;color:var(--red);font-size:var(--fs-sm)">${escapeHtml(error.message)}</div>`;
    return;
  }
  _msgInboxList = data || [];
  if (_msgInboxList.length === 0) {
    list.innerHTML = `<div class="rr-empty-inline">No active drivers yet.</div>`;
    return;
  }
  // Sort: unread first, then most-recent activity, then alpha for inactive.
  _msgInboxList.sort((a, b) => {
    if ((b.unread > 0) !== (a.unread > 0)) return (b.unread > 0) - (a.unread > 0);
    if (b.last_at && a.last_at) return new Date(b.last_at) - new Date(a.last_at);
    if (b.last_at) return 1;
    if (a.last_at) return -1;
    return (a.name || "").localeCompare(b.name || "");
  });
  const fmtRelative = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    const m = Math.floor(diffMs / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const days = Math.floor(h / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString();
  };
  list.innerHTML = _msgInboxList.map((t) => {
    const initials = (t.name || "").split(/\s+/).map(p => p[0]).filter(Boolean).slice(0,2).join("").toUpperCase() || "?";
    const lastBody = t.last_message?.body
      ? (t.last_message.sender_kind === "dispatch" ? "You: " : "") + t.last_message.body
      : "Tap to start the conversation";
    const lastBodyTrunc = lastBody.length > 60 ? lastBody.slice(0, 57) + "…" : lastBody;
    const isActive = _msgInboxSelectedId === t.driver_id;
    return `<div class="msg-item ${isActive ? "active" : ""}" data-rr-thread="${t.driver_id}" data-rr-driver-id="${t.driver_id}">
      <div class="msg-item-avatar"><div class="avatar-sm">${escapeHtml(initials)}</div><span class="msg-item-presence"></span></div>
      <div><div class="msg-item-name">${escapeHtml(t.name)}${t.station_code ? ` <span style="color:var(--text-subtle);font-weight:400">· ${escapeHtml(t.station_code)}</span>` : ""}</div><div class="msg-item-preview">${escapeHtml(lastBodyTrunc)}</div></div>
      <div><div class="msg-item-time">${escapeHtml(fmtRelative(t.last_at))}</div>${t.unread > 0 ? `<div class="msg-item-unread">${t.unread}</div>` : ""}</div>
    </div>`;
  }).join("");
  // Paint the green dot after the rows mount.  Presence state may have
  // already populated by the time the list first renders.
  _presencePaintList();
  list.querySelectorAll("[data-rr-thread]").forEach((el) => {
    el.addEventListener("click", () => openDriverChatThread(el.dataset.rrThread));
  });
  // Auto-open first unread thread on initial load if nothing's selected.
  if (autoSelect && !_msgInboxSelectedId && _msgInboxList.length > 0) {
    const target = _msgInboxList.find(t => t.unread > 0) || _msgInboxList[0];
    openDriverChatThread(target.driver_id);
  }
}

async function openDriverChatThread(driverId) {
  _msgInboxSelectedId = driverId;
  document.querySelectorAll("#rr-msg-driver-list [data-rr-thread]").forEach((el) => {
    el.classList.toggle("active", el.dataset.rrThread === driverId);
  });
  await refreshDriverChatThread(true);
  if (_msgInboxThreadTimer) clearInterval(_msgInboxThreadTimer);
  // Realtime (postgres_changes on driver_messages) is the primary
  // delivery path now; this interval is just a safety net for missed
  // events or transient socket disconnects.  30s is plenty.
  _msgInboxThreadTimer = setInterval(() => {
    if (!document.getElementById("view-messages")?.classList.contains("active") || _msgInboxSelectedId !== driverId) {
      clearInterval(_msgInboxThreadTimer); _msgInboxThreadTimer = null; return;
    }
    refreshDriverChatThread(false);
  }, 30000);
}

async function refreshDriverChatThread(scrollToBottom) {
  const conv = document.getElementById("rr-msg-conv");
  if (!conv) return;
  if (!_msgInboxSelectedId) {
    conv.innerHTML = `<div style="margin:auto;text-align:center;color:var(--text-subtle);font-size:var(--fs-md);padding:40px">Pick a driver from the list to open their thread.</div>`;
    return;
  }
  const driverId = _msgInboxSelectedId;

  // First render against an unknown driver — paint the shell + skeleton
  // bubbles synchronously so the conversation pane never shows a blank
  // canvas while the RPC is in flight.  Subsequent polls keep the same
  // shell, so the skeleton only fires on initial open.
  const isFirstPaint = conv.dataset.rrDriverId !== driverId;

  const { data, error } = await sb.rpc("dispatch_chat_thread", { p_driver_id: driverId, p_limit: 200 });
  if (error) {
    if (_isAuthError(error)) {
      conv.innerHTML = `<div style="margin:auto;text-align:center;padding:40px"><div style="font-weight:600;color:var(--text);margin-bottom:6px">Your session expired</div><div style="color:var(--text-subtle);font-size:var(--fs-sm);margin-bottom:14px">Sign in again to load this conversation.</div><button type="button" data-rr-relogin style="background:var(--accent,#3b5bdb);color:#fff;border:0;border-radius:6px;padding:8px 14px;cursor:pointer;font-size:var(--fs-sm);font-weight:600">Sign in again</button></div>`;
      conv.querySelector("[data-rr-relogin]")?.addEventListener("click", () => _forceRelogin("session_expired"));
      return;
    }
    conv.innerHTML = `<div style="margin:auto;color:var(--red);padding:40px">${escapeHtml(error.message)}</div>`;
    return;
  }
  const drv = data?.driver || {};
  const msgs = data?.messages || [];
  const peerReadAt = data?.peer_last_read_at ? new Date(data.peer_last_read_at).getTime() : 0;

  // First render: build the shell. After that, only re-render the thread
  // body and leave the composer / textarea state alone.
  if (isFirstPaint) {
    conv.dataset.rrDriverId = driverId;
    conv.innerHTML = `
      <div class="rr-mc-shell">
        <div class="rr-mc-head" data-rr-driver-id="${escapeHtml(driverId)}">
          <div class="avatar-sm" style="position:relative">
            ${escapeHtml((drv.name || "?").split(/\s+/).map(p => p[0]).filter(Boolean).slice(0,2).join("").toUpperCase())}
            <span class="rr-mc-head-presence"></span>
          </div>
          <div>
            <div class="rr-mc-name">${escapeHtml(drv.name || "")}</div>
            <div class="rr-mc-sub">Driver chat</div>
          </div>
        </div>
        <div class="rr-mc-thread" id="rr-mc-thread" data-rr-anchor="1">
          <div class="rr-msg-skeleton">
            <div class="rr-msg-skeleton-row"><div class="rr-msg-skeleton-bubble" style="width:62%"></div></div>
            <div class="rr-msg-skeleton-row right"><div class="rr-msg-skeleton-bubble" style="width:48%"></div></div>
            <div class="rr-msg-skeleton-row"><div class="rr-msg-skeleton-bubble" style="width:38%"></div></div>
            <div class="rr-msg-skeleton-row right"><div class="rr-msg-skeleton-bubble" style="width:55%"></div></div>
          </div>
          <button type="button" class="rr-msg-jump" id="rr-mc-jump" aria-label="Jump to latest">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            New messages
          </button>
          <div class="rr-mc-bottom-sentinel" id="rr-mc-bottom-sentinel" aria-hidden="true"></div>
        </div>
        <form class="rr-mc-composer" id="rr-mc-form">
          <input type="file" id="rr-mc-file" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt" hidden>
          <button type="button" id="rr-mc-attach" title="Attach photo or document"
                  style="background:transparent;border:0;color:var(--text-muted);cursor:pointer;width:36px;height:36px;border-radius:18px;display:flex;align-items:center;justify-content:center">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          </button>
          <div style="flex:1;display:flex;flex-direction:column;gap:6px;min-width:0">
            <div id="rr-mc-attach-preview" style="display:none"></div>
            <textarea id="rr-mc-input" rows="1" placeholder="Reply to ${escapeHtml(drv.name || "driver")}…" maxlength="2000"></textarea>
          </div>
          <button class="rr-mc-send" type="submit">Send</button>
        </form>
      </div>`;
    const ta = document.getElementById("rr-mc-input");
    ta.addEventListener("input", () => {
      ta.style.height = "auto"; ta.style.height = Math.min(160, ta.scrollHeight) + "px";
      // Keep the caret visible inside the textarea — once the draft
      // exceeds max-height, the textarea internally scrolls.  We pin
      // its scrollTop to the bottom on every keystroke so the line
      // currently being typed is always visible.  This is the fix for
      // the "I can not see the message I am preparing to send" report:
      // long drafts were being clipped by max-height with the caret
      // off-screen because some browsers don't auto-scroll a textarea
      // to caret when the height is JS-driven.
      ta.scrollTop = ta.scrollHeight;
      // Composer growth is now handled by the grid track sizing —
      // taller composer shrinks the thread row, no JS coordination
      // required.  `_syncComposerPos` is a no-op stub kept for
      // call-site compatibility (see its definition).
      if (typeof _syncComposerPos === "function") _syncComposerPos();
      // Throttled typing broadcast — keeps the driver's "typing…"
      // indicator alive while the operator is composing.
      if (_msgInboxSelectedId) _presenceBroadcastTyping(_msgInboxSelectedId);
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        document.getElementById("rr-mc-form").requestSubmit();
      }
    });

    // Attachment picker — paperclip opens the file input.  Pending
    // file sits on window._rrMcPending until send.
    const fileInput = document.getElementById("rr-mc-file");
    const previewEl = document.getElementById("rr-mc-attach-preview");
    document.getElementById("rr-mc-attach").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const f = fileInput.files?.[0];
      if (!f) { window._rrMcPending = null; previewEl.style.display = "none"; previewEl.innerHTML = ""; return; }
      if (f.size > 15 * 1024 * 1024) { toast("File too large (max 15 MB)", "warn"); fileInput.value = ""; return; }
      window._rrMcPending = f;
      const isImg = f.type.startsWith("image/");
      const sizeKb = Math.round(f.size / 1024);
      previewEl.style.display = "";
      previewEl.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;background:var(--canvas);border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:var(--fs-sm)">
          ${isImg ? `<img src="${URL.createObjectURL(f)}" alt="" style="width:32px;height:32px;border-radius:4px;object-fit:cover">`
                  : `<span style="font-size:var(--fs-lg)">📎</span>`}
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(f.name)}</div>
            <div style="color:var(--text-subtle)">${sizeKb} KB</div>
          </div>
          <button type="button" id="rr-mc-attach-clear" aria-label="Remove" style="background:none;border:0;color:var(--text-subtle);cursor:pointer;font-size:var(--fs-lg);line-height:1;padding:2px">×</button>
        </div>`;
      document.getElementById("rr-mc-attach-clear").addEventListener("click", () => {
        fileInput.value = "";
        window._rrMcPending = null;
        previewEl.style.display = "none";
        previewEl.innerHTML = "";
      });
    });

    document.getElementById("rr-mc-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = (ta.value || "").trim();
      const file = window._rrMcPending;
      if (!body && !file) return;
      const send = e.target.querySelector(".rr-mc-send");
      send.disabled = true;

      // ─── Optimistic stub ────────────────────────────────────────────
      // Drop a pending bubble in the thread immediately so the operator
      // sees their message land before the round trip.  We use a temp
      // id so the next refresh (post-RPC) can wipe the stub when the
      // canonical row arrives.  If the send fails, we keep the stub
      // marked .failed so they can copy the text and retry instead of
      // losing it.
      const stubId = "rrmc-stub-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
      const threadEl = document.getElementById("rr-mc-thread");
      const stubBody = body ? `<div>${escapeHtml(body).replace(/\n/g, "<br>")}</div>` : "";
      const stubAttach = file ? `<div style="font-size:var(--fs-xs);opacity:.85;margin-bottom:4px">📎 ${escapeHtml(file.name)} (uploading…)</div>` : "";
      const nowTime = new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      const stubHtml = `<div class="rr-mc-bubble dispatch pending" data-rr-stub="${stubId}" data-group-pos="single">
        ${stubAttach}${stubBody}
        <div class="rr-mc-time">${escapeHtml(nowTime)} · sending</div>
      </div>`;
      // Drop the optimistic bubble just before the jump-pill (which sits
      // just before the bottom sentinel).
      const jumpPill = document.getElementById("rr-mc-jump");
      if (jumpPill) jumpPill.insertAdjacentHTML("beforebegin", stubHtml);
      else threadEl.insertAdjacentHTML("beforeend", stubHtml);
      // Re-arm the bottom-anchor and clear the composer.  Order:
      //   1. Flip anchor flag back on (operator just sent — they want
      //      to track new content from here on out).
      //   2. Reset textarea to single row.  The composer shrinks; the
      //      grid's middle track grows to fill, and CSS scroll-anchoring
      //      on the bottom sentinel keeps the latest content pinned
      //      across that reflow without a JS re-pin.
      //   3. Bring the just-inserted stub into view via the bottom
      //      sentinel.  We use scrollTop + scrollIntoView together so
      //      ANY one mechanism succeeding is sufficient.
      threadEl.dataset.rrAnchor = "1";
      const savedBody = body;
      ta.value = ""; ta.style.height = "auto";
      // Direct scrollTop write — the cheap path.  The thread's bottom
      // edge sits just above the composer (grid layout), so scrollHeight
      // lands the just-inserted stub flush above the composer.
      threadEl.scrollTop = threadEl.scrollHeight;
      // PR #601 belt-and-suspenders: also call scrollIntoView on the
      // bottom sentinel.  scrollTop = scrollHeight CAN miss in the
      // narrow window where the stub is in DOM but layout hasn't yet
      // measured its height (browser pipelines insertAdjacentHTML +
      // layout in different ticks under certain extension scenarios).
      // scrollIntoView reads layout for us and is guaranteed to land
      // the sentinel inside the scroll container.  We pass `block:"end"`
      // so the sentinel snaps to the bottom edge of the viewport, and
      // `behavior:"instant"` so the operator never sees animation.
      // Using the sentinel (not the stub) avoids a transient overshoot
      // when the stub's bubble-in transform is still active (translateY
      // would temporarily put part of the bubble below its final spot).
      const sentinel = document.getElementById("rr-mc-bottom-sentinel");
      if (sentinel && typeof sentinel.scrollIntoView === "function") {
        try { sentinel.scrollIntoView({ block: "end", behavior: "instant" }); }
        catch { sentinel.scrollIntoView(false); }
      }
      // rAF re-pin: catches late layout (bubble fade-in transform,
      // attachment thumbnail painting) and re-asserts bottom-pin while
      // the anchor flag is on.
      requestAnimationFrame(() => {
        if (threadEl.dataset.rrAnchor === "1") {
          threadEl.scrollTop = threadEl.scrollHeight;
          const s = document.getElementById("rr-mc-bottom-sentinel");
          if (s && typeof s.scrollIntoView === "function") {
            try { s.scrollIntoView({ block: "end", behavior: "instant" }); }
            catch { s.scrollIntoView(false); }
          }
        }
      });
      if (file) {
        window._rrMcPending = null;
        fileInput.value = "";
        previewEl.style.display = "none";
        previewEl.innerHTML = "";
      }

      let attachment = null;
      if (file) {
        const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "file";
        const dspId = window.RR?.dsp?.id || "unknown";
        const path  = `${dspId}/${_msgInboxSelectedId}/${Date.now()}-${safe}`;
        const { error: upErr } = await sb.storage
          .from("driver-chat-attachments").upload(path, file, { contentType: file.type, upsert: false });
        if (upErr) {
          send.disabled = false;
          const stub = threadEl.querySelector(`[data-rr-stub="${stubId}"]`);
          if (stub) {
            stub.classList.remove("pending");
            stub.classList.add("failed");
            stub.querySelector(".rr-mc-time").textContent = "upload failed";
          }
          ta.value = savedBody; // restore so they can retry
          toast("Upload failed: " + upErr.message, "warn");
          return;
        }
        attachment = { path, mime: file.type, name: file.name, size: file.size };
      }

      const { error } = await sb.rpc("dispatch_chat_send", {
        p_driver_id:             _msgInboxSelectedId,
        p_body:                  savedBody || null,
        p_attachment_path:       attachment?.path || null,
        p_attachment_mime:       attachment?.mime || null,
        p_attachment_name:       attachment?.name || null,
        p_attachment_size_bytes: attachment?.size || null,
      });
      send.disabled = false;
      if (error) {
        const stub = threadEl.querySelector(`[data-rr-stub="${stubId}"]`);
        if (stub) {
          stub.classList.remove("pending");
          stub.classList.add("failed");
          stub.querySelector(".rr-mc-time").textContent = "send failed · click to retry";
          stub.style.cursor = "pointer";
          stub.addEventListener("click", () => { ta.value = savedBody; ta.focus(); stub.remove(); }, { once:true });
        }
        ta.value = savedBody;
        toast("Couldn't send: " + error.message, "warn");
        return;
      }
      // Don't force a scroll on the refresh — the operator was already
      // pinned at bottom (we scrolled them when the stub appeared).
      // The smart-scroll logic in the renderer will keep them there.
      await refreshDriverChatThread(false);
      refreshDriverChatList(false);
    });
  }

  const thread = document.getElementById("rr-mc-thread");
  if (!thread) return;

  // ─── Smart scroll anchor ────────────────────────────────────────────
  // Capture whether the operator was pinned within ~120px of the bottom
  // BEFORE we re-render. If they were, we re-pin after the swap so new
  // messages don't push them away.  If they weren't (they scrolled up
  // to read history), we leave their position untouched and surface the
  // jump-to-latest pill if the message count just grew.
  const prevScrollTop    = thread.scrollTop;
  const prevScrollHeight = thread.scrollHeight;
  const prevClientHeight = thread.clientHeight;
  const wasNearBottom    = (prevScrollHeight - prevScrollTop - prevClientHeight) < 120;
  const prevMsgCount     = parseInt(thread.dataset.rrMsgCount || "-1", 10);
  thread.dataset.rrMsgCount = String(msgs.length);

  // Build the bubble list with sender-grouping + date dividers.
  // Group rules: same sender_kind + within 5 minutes of the prior msg
  //              => continuation of the same group.
  // Date rules : show a divider whenever the calendar day changes from
  //              the previous bubble (or on the first bubble of the
  //              thread, but only if that bubble isn't from today —
  //              "Today" without context above feels odd).
  const renderEmpty = () => `<div class="rr-mc-empty">No messages yet. Start the thread below.</div>`;
  const dayLabel = (d) => {
    const today = new Date();
    today.setHours(0,0,0,0);
    const yest = new Date(today); yest.setDate(yest.getDate() - 1);
    const cur = new Date(d); cur.setHours(0,0,0,0);
    if (cur.getTime() === today.getTime()) return "Today";
    if (cur.getTime() === yest.getTime()) return "Yesterday";
    const sameYear = cur.getFullYear() === today.getFullYear();
    return cur.toLocaleDateString(undefined, sameYear
      ? { weekday: "long", month: "long", day: "numeric" }
      : { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  };

  // Strip optimistic stubs whose body now appears in the canonical
  // server-rendered set.  Anything left over is still in flight or
  // failed; we leave those in place.
  const stubBodies = new Set(
    Array.from(thread.querySelectorAll(".rr-mc-bubble.pending"))
      .map((el) => (el.textContent || "").trim().slice(0, 200))
  );

  // Index of the LAST dispatcher-sent message whose created_at is at
  // or before the driver's read marker — that's where we hang the
  // single "Read" pill.  -1 if nothing's been read yet.
  let lastReadDispatchIdx = -1;
  if (peerReadAt > 0) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.sender_kind !== "dispatch") continue;
      if (new Date(m.created_at).getTime() <= peerReadAt) { lastReadDispatchIdx = i; break; }
    }
  }

  let html = "";
  if (msgs.length === 0) {
    html = renderEmpty();
  } else {
    let lastSender = null;
    let lastTimeMs = 0;
    let lastDateKey = "";
    msgs.forEach((m, i) => {
      const t = new Date(m.created_at);
      const time = t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      const dateKey = t.toDateString();
      if (dateKey !== lastDateKey) {
        html += `<div class="rr-msg-day">${escapeHtml(dayLabel(t))}</div>`;
        lastDateKey = dateKey;
        lastSender = null;
      }

      const sameAsPrev = m.sender_kind === lastSender && (t.getTime() - lastTimeMs) < 5 * 60 * 1000;
      const next = msgs[i + 1];
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

      let attach = "";
      if (m.attachment_path) {
        const isImg = (m.attachment_mime || "").startsWith("image/");
        const name  = m.attachment_name || "Attachment";
        const sizeKb = m.attachment_size_bytes ? Math.round(m.attachment_size_bytes / 1024) : null;
        attach = isImg
          // width/height HTML attributes (NOT just CSS) give the browser
          // the intrinsic size BEFORE any stylesheet parses — the box
          // is 240×240 from the first style-resolution tick.  Combined
          // with object-fit:cover from CSS, the image NEVER changes its
          // own height once src lands, so there's nothing for the
          // browser's scroll-anchor algorithm to "preserve" (which is
          // what was yanking the operator UP to a fixed image position).
          ? `<img data-rr-mc-attach="${escapeHtml(m.attachment_path)}" alt="${escapeHtml(name)}" width="240" height="240" loading="eager" decoding="async" style="max-width:240px;border-radius:10px;margin-bottom:6px;cursor:zoom-in" onclick="window.open(this.src,'_blank')"/>`
          : `<a data-rr-mc-attach="${escapeHtml(m.attachment_path)}" target="_blank" rel="noopener" style="display:flex;gap:8px;align-items:center;padding:6px 10px;background:rgba(255,255,255,.15);border-radius:8px;margin-bottom:6px;text-decoration:none;color:inherit;max-width:240px"><span>📎</span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:var(--fs-sm)">${escapeHtml(name)}</span>${sizeKb != null ? `<span style="font-size:var(--fs-xs);opacity:.8">${sizeKb} KB</span>` : ""}</a>`;
      }
      const isDeleted = !!m.deleted_at;
      const isMine    = m.sender_kind === "dispatch";
      const editedTag = m.edited_at && !isDeleted
        ? `<span class="rr-mc-edited" title="Edited ${new Date(m.edited_at).toLocaleString()}">edited</span>`
        : "";
      let bodyHtml = "";
      if (isDeleted) {
        bodyHtml = `<div class="rr-mc-deleted-body">Message deleted</div>`;
      } else if (m.body) {
        bodyHtml = `<div>${escapeHtml(m.body).replace(/\n/g, "<br>")}</div>`;
      }
      // Hover actions — only on the dispatcher's own non-deleted
      // bubbles within the 15-minute edit window.  Visual affordance
      // only; the RPCs re-check the window server-side.
      const within = (Date.now() - t.getTime()) < 15 * 60 * 1000;
      const actions = (isMine && !isDeleted && within)
        ? `<div class="rr-mc-bubble-actions">
            <button type="button" data-rr-mc-edit="${escapeHtml(m.id)}" aria-label="Edit message" title="Edit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
            <button type="button" data-rr-mc-delete="${escapeHtml(m.id)}" aria-label="Delete message" title="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>
          </div>`
        : "";
      const deletedClass = isDeleted ? " is-deleted" : "";
      html += `<div class="rr-mc-bubble ${m.sender_kind}${deletedClass}" data-group-pos="${pos}" data-rr-mc-msg="${escapeHtml(m.id)}">
        ${actions}
        ${attach}${bodyHtml}
        <div class="rr-mc-time">${escapeHtml(time)}${editedTag}</div>
      </div>`;
      // Drop the read-receipt pill immediately after the last
      // dispatcher-sent message that's been read.  Single placement
      // is intentional — Slack/iMessage style, not "Read" on every
      // bubble.
      if (i === lastReadDispatchIdx) {
        html += `<div class="rr-mc-read-receipt">Read</div>`;
      }
    });
  }

  // Preserve the jump pill + bottom sentinel across the re-render (both
  // live as sibling children of the thread, AFTER the bubble list).
  // Sentinel must be the LAST child for browser scroll-anchoring to
  // pick it as the anchor when the operator is at the bottom.
  const jumpPillHtml = `<button type="button" class="rr-msg-jump" id="rr-mc-jump" aria-label="Jump to latest">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      New messages
    </button>`;
  const sentinelHtml = `<div class="rr-mc-bottom-sentinel" id="rr-mc-bottom-sentinel" aria-hidden="true"></div>`;

  // Carry forward any still-pending or failed optimistic stubs that
  // the server hasn't yet echoed back.
  const liveStubs = Array.from(thread.querySelectorAll(".rr-mc-bubble.pending, .rr-mc-bubble.failed"))
    .filter((el) => !stubBodies.has((el.textContent || "").trim().slice(0, 200)))
    .map((el) => el.outerHTML)
    .join("");

  // ─── DOM swap ──────────────────────────────────────────────────────
  // innerHTML rewrite is synchronous, so the browser does not paint
  // any intermediate state.  scrollTop is preserved across innerHTML
  // assignment when the new content is taller than the viewport, so
  // the position the operator was at stays valid.  Browser scroll-
  // anchoring (overflow-anchor:auto on the sentinel; none on
  // everything else) handles re-pinning across subsequent reflows
  // (image loads, padding changes, content additions) WITHOUT a
  // JS-driven re-pin — that is what eliminates the visible glitch.
  thread.innerHTML = html + liveStubs + jumpPillHtml + sentinelHtml;
  // Install the MutationObserver-based anchor enforcer.  Idempotent —
  // bound once per thread element.  This is the safety net that
  // re-pins to bottom whenever ANY descendant mutates while the
  // anchor flag is on (image-load, attribute changes, child inserts).
  _rrMcInstallAnchorEnforcer(thread);
  // Sign attachment paths so they render — bucket is private.
  setTimeout(() => _rrMcSignAttachments(), 0);

  // Wire the jump pill (re-rendered each time, so we re-bind every poll).
  const jump = document.getElementById("rr-mc-jump");
  if (jump) {
    jump.addEventListener("click", () => {
      // Re-arm the anchor BEFORE scrolling so the post-scroll reflow
      // (read-receipt land, image hydration) keeps the operator pinned.
      thread.dataset.rrAnchor = "1";
      jump.classList.remove("show");
      // Smooth scroll on the THREAD only — never via scrollIntoView,
      // which animates ancestor scroll containers too and would jolt
      // the surrounding page chrome.
      thread.scrollTo({ top: thread.scrollHeight, behavior: "smooth" });
    });
  }

  // Composer is a normal grid child (see `.rr-mc-shell` rule).  The
  // calls below are no-op stubs kept for compatibility with the
  // pre-grid `position:fixed` composer; they currently just clear
  // any stale CSS variables set by an older cached HTML.
  if (typeof _syncComposerPos === "function") _syncComposerPos();
  if (typeof _ensureComposerResizeWatch === "function") _ensureComposerResizeWatch();

  // Smart-scroll: pin to bottom if the operator was already near it,
  // or if the caller forced it (e.g. opening a new thread).  Otherwise
  // surface the jump pill if the message count grew under their feet.
  if (scrollToBottom || wasNearBottom) {
    thread.dataset.rrAnchor = "1";
    if (jump) jump.classList.remove("show");
    // Multi-pass pin to bottom.  Each pass uses scrollTop assignment
    // (NOT scrollIntoView, which walks ancestors and can jolt the
    // page-level scroll).  The MutationObserver-based enforcer
    // installed above will also re-pin on every subsequent DOM
    // mutation while the anchor flag is on, so this is just the
    // synchronous bring-up.
    //
    //   Pass 1 (sync):  immediately after innerHTML lands, so the
    //                   operator never sees a flash at scrollTop=0.
    //   Pass 2 (rAF):   after layout settles for the new bubbles —
    //                   fade-in transform + composer ResizeObserver
    //                   may have grown the content between the swap
    //                   and the first frame.
    //   Pass 3 (180ms): catches the image-decode reflow.  Even though
    //                   our images are HEIGHT-LOCKED (CSS height:240px
    //                   + HTML height="240"), some browsers/extensions
    //                   inject styles that can momentarily reflow the
    //                   <img> until decoding completes.  This pass
    //                   catches that case.  At 180ms it's well past
    //                   first paint but quick enough that the operator
    //                   never sees movement — the prior pass already
    //                   placed them at bottom; this one just reaffirms.
    thread.scrollTop = thread.scrollHeight;
    requestAnimationFrame(() => {
      if (thread.dataset.rrAnchor === "1") {
        thread.scrollTop = thread.scrollHeight;
      }
    });
    // Cancel any prior in-flight guard re-pin from a previous refresh
    // before scheduling a new one — avoids stacked timers if
    // refreshDriverChatThread fires twice quickly (e.g. open + first
    // realtime echo on a brand-new thread).
    if (thread._rrGuardPin) clearTimeout(thread._rrGuardPin);
    thread._rrGuardPin = setTimeout(() => {
      thread._rrGuardPin = null;
      if (thread.dataset.rrAnchor === "1") {
        thread.scrollTop = thread.scrollHeight;
      }
    }, 180);

    // Release anchor only on a meaningful scroll-up (>80px from
    // bottom).  Bound once per thread element.  Wheel/touchmove/keydown
    // tell us the OPERATOR initiated the scroll; we only flip the
    // anchor off if they actually moved away from the bottom.
    if (!thread._rrAnchorReleaseBound) {
      thread._rrAnchorReleaseBound = true;
      const release = () => {
        requestAnimationFrame(() => {
          const cur = thread.scrollTop;
          const max = thread.scrollHeight;
          const view = thread.clientHeight;
          if ((max - cur - view) > 80) thread.dataset.rrAnchor = "0";
          else thread.dataset.rrAnchor = "1";
        });
      };
      thread.addEventListener("wheel",     release, { passive: true });
      thread.addEventListener("touchmove", release, { passive: true });
      thread.addEventListener("keydown",   release);
    }
  } else if (prevMsgCount >= 0 && msgs.length > prevMsgCount) {
    if (jump) jump.classList.add("show");
  }

  if (msgs.some((m) => m.sender_kind === "driver")) {
    sb.rpc("dispatch_chat_mark_read", { p_driver_id: driverId }).then(undefined, () => {});
  }
  // Refresh head presence dot/sub-line in case the driver came online
  // between the open and the data resolve.
  _presencePaintThreadHead(driverId);
}

// ─── Edit / delete on dispatcher's own bubbles ───────────────────────────
//
// Hover actions on .rr-mc-bubble.dispatch trigger inline edit (a
// floating textarea atop the bubble) or soft-delete (with confirm).
// Both call the 15-minute-windowed RPCs from migration 0123.

document.addEventListener("click", async (e) => {
  const editBtn = e.target.closest("[data-rr-mc-edit]");
  if (editBtn) {
    e.preventDefault(); e.stopPropagation();
    const id = editBtn.getAttribute("data-rr-mc-edit");
    const bubble = editBtn.closest(".rr-mc-bubble");
    if (!bubble) return;
    // Pull current body text (excluding time + actions).
    const bodyEl = Array.from(bubble.children).find(
      (c) => c.tagName === "DIV" && !c.classList.contains("rr-mc-time") && !c.classList.contains("rr-mc-bubble-actions")
    );
    const current = bodyEl ? bodyEl.textContent.trim() : "";
    // Open a tiny inline editor — positioned over the bubble itself.
    const root = document.createElement("div");
    root.className = "rr-mc-edit-overlay";
    root.innerHTML = `
      <div class="rr-mc-edit-card">
        <div class="rr-mc-edit-title">Edit message</div>
        <textarea class="rr-mc-edit-ta" maxlength="2000">${escapeHtml(current)}</textarea>
        <div class="rr-mc-edit-actions">
          <button type="button" class="btn btn-sm" data-rr-mc-edit-cancel>Cancel</button>
          <button type="button" class="btn btn-sm btn-primary" data-rr-mc-edit-save>Save</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    const ta = root.querySelector(".rr-mc-edit-ta");
    ta.focus(); ta.select();
    const close = () => root.remove();
    root.addEventListener("click", (ev) => {
      if (ev.target === root || ev.target.closest("[data-rr-mc-edit-cancel]")) close();
    });
    root.querySelector("[data-rr-mc-edit-save]").addEventListener("click", async () => {
      const next = ta.value.trim();
      if (!next || next === current) { close(); return; }
      const { error } = await sb.rpc("dispatch_chat_edit", { p_message_id: id, p_body: next });
      if (error) { toast("Edit failed: " + error.message, "warn"); return; }
      close();
      refreshDriverChatThread(false);
    });
    ta.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") close();
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); root.querySelector("[data-rr-mc-edit-save]").click(); }
    });
    return;
  }

  const delBtn = e.target.closest("[data-rr-mc-delete]");
  if (delBtn) {
    e.preventDefault(); e.stopPropagation();
    const id = delBtn.getAttribute("data-rr-mc-delete");
    if (!confirm("Delete this message? The driver's copy will show 'Message deleted'.")) return;
    const { error } = await sb.rpc("dispatch_chat_delete", { p_message_id: id });
    if (error) { toast("Delete failed: " + error.message, "warn"); return; }
    refreshDriverChatThread(false);
  }
});

async function _rrMcSignAttachments() {
  const els = document.querySelectorAll("[data-rr-mc-attach]:not([data-rr-mc-resolved])");
  for (const el of els) {
    const path = el.getAttribute("data-rr-mc-attach");
    el.setAttribute("data-rr-mc-resolved", "1");
    try {
      const { data, error } = await sb.storage
        .from("driver-chat-attachments")
        .createSignedUrl(path, 60 * 60 * 8);
      if (error || !data?.signedUrl) continue;
      if (el.tagName === "IMG") {
        // Bind load/error BEFORE setting src so we never miss the
        // event (cached images can fire load synchronously inside
        // the assignment).  When the image finishes decoding the box
        // dimensions are unchanged (240×240, locked via CSS height +
        // HTML attributes) — we just stop the shimmer overlay.
        const onSettled = () => {
          el.setAttribute("data-rr-loaded", "1");
        };
        el.addEventListener("load",  onSettled, { once: true });
        el.addEventListener("error", onSettled, { once: true });
        el.src = data.signedUrl;
        // If the browser already has it cached, .complete is true on
        // the next tick — synthesize the loaded mark immediately.
        if (el.complete && el.naturalWidth > 0) onSettled();
      } else {
        el.href = data.signedUrl;
      }
    } catch {}
  }
}

// ─── Anchor enforcer ─────────────────────────────────────────────────────
//
// Belt-and-suspenders re-pin for the messaging thread.  CSS
// scroll-anchoring (overflow-anchor on the bottom sentinel) is the
// PRIMARY mechanism that keeps the operator at the bottom across
// image-load reflows / composer-padding shifts.  This MutationObserver
// is the SECONDARY mechanism that catches anything CSS anchoring
// missed — e.g. when the operator opens a thread and the first paint
// happens before all images have finished decoding.
//
// Rules:
//   • Only re-pins when `data-rr-anchor="1"` on the thread.  When the
//     operator scrolls up to read history, the anchor flag is cleared
//     and this function becomes a no-op — so we never fight the
//     operator's scroll gesture.
//   • Uses scrollTop = scrollHeight (NOT smooth, NOT scrollIntoView)
//     so the re-pin is invisible.
//   • No polling / interval / timer.  Fires only on DOM mutations
//     under the thread.
function _rrMcInstallAnchorEnforcer(thread) {
  if (!thread || thread._rrAnchorEnforcerBound) return;
  thread._rrAnchorEnforcerBound = true;
  const pinIfAnchored = () => {
    if (thread.dataset.rrAnchor !== "1") return;
    // Only pin if we're actually drifted away from the bottom.  If
    // we're already at the bottom (or sentinel is in view), skip — no
    // need to re-write scrollTop and risk a flicker.
    const drift = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
    if (drift > 1) thread.scrollTop = thread.scrollHeight;
  };
  const mo = new MutationObserver(() => {
    // rAF defers the re-pin to AFTER layout has settled for this
    // mutation batch, so scrollHeight reflects the new content.
    requestAnimationFrame(pinIfAnchored);
  });
  mo.observe(thread, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "data-rr-loaded"] });
  thread._rrAnchorEnforcerMo = mo;
}


// ─── Channels (group rooms) ──────────────────────────────────────────────
// Driver-to-driver group messaging with dispatcher oversight.  Channels
// can be tied to a station_id; drivers at that station auto-join via
// the trigger in migration 0073.  Dispatchers see every channel in
// their DSP and can post / manage members from this same Messages view.
let _msgInboxMode        = "direct"; // "direct" | "channels"
let _msgChannelList      = [];
let _msgChannelSelectedId = null;
let _msgChannelListTimer  = null;
let _msgChannelThreadTimer = null;

// Override the static msgListTab handler so clicking Channels actually
// loads channel data.  All / Direct / Broadcasts still fall through to
// the existing driver-chat list for now.
window.msgListTab = function (btn) {
  document.querySelectorAll(".msg-list-tab").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  const label = (btn.textContent || "").trim().toLowerCase();
  const mode = label === "channels" ? "channels" : "direct";
  if (mode === _msgInboxMode) return;
  _msgInboxMode = mode;
  // Drop any open thread when switching modes — the conv pane would
  // render the wrong shape otherwise.
  _msgInboxSelectedId  = null;
  _msgChannelSelectedId = null;
  // Stop EVERY mode-specific timer before starting the new one.  The
  // direct-chat list timer was previously left running when the operator
  // switched to Channels, so 8 seconds later it overwrote the list with
  // direct chats and bounced them out of the Channels view.
  if (_msgInboxThreadTimer)   { clearInterval(_msgInboxThreadTimer);   _msgInboxThreadTimer = null; }
  if (_msgChannelThreadTimer) { clearInterval(_msgChannelThreadTimer); _msgChannelThreadTimer = null; }
  if (_msgInboxListTimer)     { clearInterval(_msgInboxListTimer);     _msgInboxListTimer = null; }
  if (_msgChannelListTimer)   { clearInterval(_msgChannelListTimer);   _msgChannelListTimer = null; }
  const conv = document.getElementById("rr-msg-conv");
  if (conv) {
    conv.innerHTML = `<div style="margin:auto;text-align:center;color:var(--text-subtle);font-size:var(--fs-md);padding:40px">${
      mode === "channels" ? "Pick a channel from the list — or create one." : "Pick a driver from the list to open their thread."
    }</div>`;
    delete conv.dataset.rrDriverId;
    delete conv.dataset.rrChannelId;
  }
  if (mode === "channels") {
    refreshChannelList(true);
    _msgChannelListTimer = setInterval(() => {
      if (document.getElementById("view-messages")?.classList.contains("active") && _msgInboxMode === "channels") {
        refreshChannelList(false);
      } else {
        clearInterval(_msgChannelListTimer); _msgChannelListTimer = null;
      }
    }, 8000);
  } else {
    // loadDriverChatInbox restores both the list and its 8-second poll.
    // Without re-arming the poll, the direct list would never refresh
    // again after the operator's first Channels → Direct round-trip.
    loadDriverChatInbox();
  }
};

async function refreshChannelList(autoSelect) {
  const list = document.getElementById("rr-msg-driver-list");
  if (!list) return;
  const { data, error } = await sb.rpc("dispatch_channels_list");
  if (error) {
    list.innerHTML = `
      <div style="padding:14px">
        <button class="btn btn-primary btn-sm" data-rr-channel-new style="width:100%;margin-bottom:10px">+ New channel</button>
        <div style="color:var(--red);font-size:var(--fs-sm)">${escapeHtml(error.message)}</div>
      </div>`;
    list.querySelector("[data-rr-channel-new]")?.addEventListener("click", openChannelCreateModal);
    return;
  }
  _msgChannelList = data?.channels || [];
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
  const headerBtn = `
    <div style="padding:10px 12px;border-bottom:1px solid var(--border)">
      <button class="btn btn-primary btn-sm" data-rr-channel-new style="width:100%">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;vertical-align:-2px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        New channel
      </button>
    </div>`;
  if (_msgChannelList.length === 0) {
    list.innerHTML = headerBtn + `<div class="rr-empty-inline">No channels yet.<br>Create one to start group comms.</div>`;
    list.querySelector("[data-rr-channel-new]")?.addEventListener("click", openChannelCreateModal);
    return;
  }
  list.innerHTML = headerBtn + _msgChannelList.map((c) => {
    const isActive = _msgChannelSelectedId === c.id;
    const archChip = c.archived_at
      ? `<span class="status-pill status-pill-neutral" style="margin-left:6px">Archived</span>`
      : "";
    const stationChip = c.station_code
      ? `<span style="font-size:var(--fs-xs);color:var(--text-subtle);background:var(--canvas);padding:1px 6px;border-radius:8px;margin-left:6px">${escapeHtml(c.station_code)}</span>`
      : "";
    const lastBody = c.last_message
      ? (c.last_sender ? `${c.last_sender}: ` : "") + c.last_message
      : `${c.member_count || 0} member${c.member_count === 1 ? "" : "s"}`;
    const lastBodyTrunc = lastBody.length > 60 ? lastBody.slice(0, 57) + "…" : lastBody;
    return `<div class="msg-item ${isActive ? "active" : ""}" data-rr-channel="${escapeHtml(c.id)}">
      <div class="msg-item-avatar"><div class="avatar-sm" style="background:var(--accent-soft);color:var(--accent-text);font-size:var(--fs-md)">#</div></div>
      <div><div class="msg-item-name">${escapeHtml(c.name)}${stationChip}${archChip}</div><div class="msg-item-preview">${escapeHtml(lastBodyTrunc)}</div></div>
      <div><div class="msg-item-time">${escapeHtml(fmtRel(c.last_message_at))}</div></div>
    </div>`;
  }).join("");
  list.querySelector("[data-rr-channel-new]")?.addEventListener("click", openChannelCreateModal);
  list.querySelectorAll("[data-rr-channel]").forEach((el) => {
    el.addEventListener("click", () => openChannelThread(el.dataset.rrChannel));
  });
  if (autoSelect && !_msgChannelSelectedId && _msgChannelList.length > 0) {
    openChannelThread(_msgChannelList[0].id);
  }
}

async function openChannelThread(channelId) {
  _msgChannelSelectedId = channelId;
  document.querySelectorAll("#rr-msg-driver-list [data-rr-channel]").forEach((el) => {
    el.classList.toggle("active", el.dataset.rrChannel === channelId);
  });
  await refreshChannelThread(true);
  if (_msgChannelThreadTimer) clearInterval(_msgChannelThreadTimer);
  _msgChannelThreadTimer = setInterval(() => {
    if (!document.getElementById("view-messages")?.classList.contains("active")
        || _msgInboxMode !== "channels"
        || _msgChannelSelectedId !== channelId) {
      clearInterval(_msgChannelThreadTimer); _msgChannelThreadTimer = null; return;
    }
    refreshChannelThread(false);
  }, 8000);
}

async function refreshChannelThread(scrollToBottom) {
  const conv = document.getElementById("rr-msg-conv");
  if (!conv || !_msgChannelSelectedId) return;
  const channelId = _msgChannelSelectedId;
  const meta = _msgChannelList.find(c => c.id === channelId) || {};

  const { data, error } = await sb.rpc("dispatch_channel_messages", {
    p_channel_id: channelId, p_limit: 200,
  });
  if (error) {
    conv.innerHTML = `<div style="margin:auto;color:var(--red);padding:40px">${escapeHtml(error.message)}</div>`;
    return;
  }
  const msgs = data?.messages || [];

  if (conv.dataset.rrChannelId !== channelId) {
    conv.dataset.rrChannelId = channelId;
    delete conv.dataset.rrDriverId;
    const stationLine = meta.station_code ? ` · station ${escapeHtml(meta.station_code)}` : "";
    const memberCount = meta.member_count || 0;
    conv.innerHTML = `
      <div class="rr-cc-shell">
        <div class="rr-cc-head">
          <div class="avatar-sm" style="background:var(--accent-soft);color:var(--accent-text)">#</div>
          <div style="flex:1;min-width:0">
            <div class="rr-cc-name">${escapeHtml(meta.name || "")}</div>
            <div class="rr-cc-sub">${memberCount} member${memberCount === 1 ? "" : "s"}${stationLine}${meta.archived_at ? " · archived" : ""}</div>
          </div>
          <div class="rr-cc-head-actions">
            <button class="btn btn-sm" data-rr-channel-members="${escapeHtml(channelId)}">Members</button>
            <button class="btn btn-sm" data-rr-channel-archive="${escapeHtml(channelId)}">${meta.archived_at ? "Unarchive" : "Archive"}</button>
          </div>
        </div>
        <div class="rr-cc-thread" id="rr-cc-thread"></div>
        <form class="rr-cc-composer" id="rr-cc-form" style="${meta.archived_at ? "opacity:.5;pointer-events:none" : ""}">
          <input type="file" id="rr-cc-file" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt" hidden>
          <button type="button" id="rr-cc-attach" title="Attach photo or document"
                  style="background:transparent;border:0;color:var(--text-muted);cursor:pointer;width:36px;height:36px;border-radius:18px;display:flex;align-items:center;justify-content:center">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          </button>
          <div style="flex:1;display:flex;flex-direction:column;gap:6px;min-width:0">
            <div id="rr-cc-attach-preview" style="display:none"></div>
            <textarea id="rr-cc-input" rows="1" placeholder="Post to #${escapeHtml(meta.name || "channel")}…" maxlength="2000"></textarea>
          </div>
          <button class="rr-cc-send" type="submit">Send</button>
        </form>
      </div>`;

    const ta = document.getElementById("rr-cc-input");
    ta.addEventListener("input", () => {
      ta.style.height = "auto"; ta.style.height = Math.min(160, ta.scrollHeight) + "px";
      // Caret-follow + composer-position resync — same pattern as
      // rr-mc-input above.  Keeps the typed line visible when the
      // draft overflows max-height, and keeps the thread's bottom
      // padding matched to the composer's actual height.
      ta.scrollTop = ta.scrollHeight;
      if (typeof _syncComposerPos === "function") _syncComposerPos();
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        document.getElementById("rr-cc-form").requestSubmit();
      }
    });

    const fileInput = document.getElementById("rr-cc-file");
    const previewEl = document.getElementById("rr-cc-attach-preview");
    document.getElementById("rr-cc-attach").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const f = fileInput.files?.[0];
      if (!f) { window._rrCcPending = null; previewEl.style.display = "none"; previewEl.innerHTML = ""; return; }
      if (f.size > 15 * 1024 * 1024) { toast("File too large (max 15 MB)", "warn"); fileInput.value = ""; return; }
      window._rrCcPending = f;
      const isImg = f.type.startsWith("image/");
      const sizeKb = Math.round(f.size / 1024);
      previewEl.style.display = "";
      previewEl.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;background:var(--canvas);border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:var(--fs-sm)">
          ${isImg ? `<img src="${URL.createObjectURL(f)}" alt="" style="width:32px;height:32px;border-radius:4px;object-fit:cover">`
                  : `<span style="font-size:var(--fs-lg)">📎</span>`}
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(f.name)}</div>
            <div style="color:var(--text-subtle)">${sizeKb} KB</div>
          </div>
          <button type="button" id="rr-cc-attach-clear" aria-label="Remove" style="background:none;border:0;color:var(--text-subtle);cursor:pointer;font-size:var(--fs-lg);line-height:1;padding:2px">×</button>
        </div>`;
      document.getElementById("rr-cc-attach-clear").addEventListener("click", () => {
        fileInput.value = "";
        window._rrCcPending = null;
        previewEl.style.display = "none";
        previewEl.innerHTML = "";
      });
    });

    document.getElementById("rr-cc-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = (ta.value || "").trim();
      const file = window._rrCcPending;
      if (!body && !file) return;
      const send = e.target.querySelector(".rr-cc-send");
      send.disabled = true;

      let attachment = null;
      if (file) {
        const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "file";
        const dspId = window.RR?.dsp?.id || "unknown";
        const path  = `${dspId}/channels/${_msgChannelSelectedId}/${Date.now()}-${safe}`;
        const { error: upErr } = await sb.storage
          .from("driver-chat-attachments").upload(path, file, { contentType: file.type, upsert: false });
        if (upErr) {
          send.disabled = false;
          toast("Upload failed: " + upErr.message, "warn");
          return;
        }
        attachment = { path, mime: file.type, name: file.name, size: file.size };
      }

      const { error } = await sb.rpc("dispatch_channel_post", {
        p_channel_id:            _msgChannelSelectedId,
        p_body:                  body || null,
        p_attachment_path:       attachment?.path || null,
        p_attachment_mime:       attachment?.mime || null,
        p_attachment_name:       attachment?.name || null,
        p_attachment_size_bytes: attachment?.size || null,
      });
      send.disabled = false;
      if (error) { toast("Couldn't post: " + error.message, "warn"); return; }
      ta.value = ""; ta.style.height = "auto";
      // Composer is a regular grid child now — track sizing handles
      // the height shrink mechanically.  The call below is a no-op
      // stub kept for compatibility (see _syncComposerPos definition).
      if (typeof _syncComposerPos === "function") _syncComposerPos();
      if (file) {
        window._rrCcPending = null;
        fileInput.value = "";
        previewEl.style.display = "none";
        previewEl.innerHTML = "";
      }
      await refreshChannelThread(true);
      refreshChannelList(false);
    });
  }

  const thread = document.getElementById("rr-cc-thread");
  if (!thread) return;
  // Channel thread uses the same overflow-anchor sentinel pattern as
  // direct chat (see .rr-cc-bottom-sentinel CSS) so reflows above the
  // sentinel (bubble inserts, composer height changes via the grid's
  // track sizing, image decodes) don't visibly jump the scroll
  // position.
  if (!thread.hasAttribute("data-rr-anchor")) thread.setAttribute("data-rr-anchor", "1");
  const ccSentinelHtml = `<div class="rr-cc-bottom-sentinel" id="rr-cc-bottom-sentinel" aria-hidden="true"></div>`;
  if (msgs.length === 0) {
    thread.innerHTML = `<div class="rr-cc-empty">No messages yet. Start the channel below.</div>` + ccSentinelHtml;
  } else {
    // Sender + time grouping for channels: same author within 5
    // minutes collapses into one block — sender label only on the
    // first bubble of the group, single timestamp on the last.
    // Same vocabulary as the direct-chat (rr-mc) renderer.
    let lastSender = null;
    let lastTimeMs = 0;
    let lastSenderId = null;
    thread.innerHTML = msgs.map((m, i) => {
      const t = new Date(m.created_at);
      const time = t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      const senderKey = m.sender_kind + "|" + (m.sender_id || m.sender_user_id || m.sender_name || "");
      const sameAsPrev = senderKey === lastSenderId && (t.getTime() - lastTimeMs) < 5 * 60 * 1000;
      const next = msgs[i + 1];
      const nextKey = next ? next.sender_kind + "|" + (next.sender_id || next.sender_user_id || next.sender_name || "") : null;
      const sameAsNext = next
        && nextKey === senderKey
        && (new Date(next.created_at).getTime() - t.getTime()) < 5 * 60 * 1000;
      let pos = "single";
      if      (sameAsPrev && sameAsNext) pos = "middle";
      else if (sameAsPrev)               pos = "last";
      else if (sameAsNext)               pos = "first";
      lastSender = m.sender_kind;
      lastSenderId = senderKey;
      lastTimeMs = t.getTime();

      let attach = "";
      if (m.attachment_path) {
        const isImg = (m.attachment_mime || "").startsWith("image/");
        const name  = m.attachment_name || "Attachment";
        const sizeKb = m.attachment_size_bytes ? Math.round(m.attachment_size_bytes / 1024) : null;
        attach = isImg
          // Same fixed-box treatment as the direct-chat renderer above
          // — width/height attributes lock the layout box at 240×240
          // BEFORE any image data lands, so the bubble cannot grow on
          // image load and the scroll-anchor algorithm has nothing to
          // walk up to preserve.
          ? `<img data-rr-mc-attach="${escapeHtml(m.attachment_path)}" alt="${escapeHtml(name)}" width="240" height="240" loading="eager" decoding="async" style="max-width:240px;border-radius:8px;margin-bottom:6px;cursor:zoom-in" onclick="window.open(this.src,'_blank')"/>`
          : `<a data-rr-mc-attach="${escapeHtml(m.attachment_path)}" target="_blank" rel="noopener" style="display:flex;gap:8px;align-items:center;padding:6px 10px;background:rgba(255,255,255,.15);border-radius:8px;margin-bottom:6px;text-decoration:none;color:inherit;max-width:240px"><span>📎</span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:var(--fs-sm)">${escapeHtml(name)}</span>${sizeKb != null ? `<span style="font-size:var(--fs-xs);opacity:.8">${sizeKb} KB</span>` : ""}</a>`;
      }
      const senderLabel = m.sender_kind === "dispatch"
        ? (m.sender_name ? `Dispatch · ${m.sender_name}` : "Dispatch")
        : (m.sender_name || "Driver");
      const bodyHtml = m.body ? `<div>${escapeHtml(m.body).replace(/\n/g, "<br>")}</div>` : "";
      const showSender = (pos === "first" || pos === "single");
      return `<div class="rr-cc-bubble ${m.sender_kind}" data-group-pos="${pos}">
        ${showSender ? `<div class="rr-cc-sender">${escapeHtml(senderLabel)}</div>` : ""}
        ${attach}
        ${bodyHtml}
        <div class="rr-cc-time">${escapeHtml(time)}</div>
      </div>`;
    }).join("") + ccSentinelHtml;
    setTimeout(() => _rrMcSignAttachments(), 0);
  }
  if (typeof _syncComposerPos === "function") _syncComposerPos();
  if (typeof _ensureComposerResizeWatch === "function") _ensureComposerResizeWatch();
  // Same MutationObserver-based anchor enforcer as direct chat —
  // re-pins to bottom on any descendant mutation while the anchor
  // flag is on.  Idempotent.
  if (typeof _rrMcInstallAnchorEnforcer === "function") _rrMcInstallAnchorEnforcer(thread);
  if (scrollToBottom) {
    thread.dataset.rrAnchor = "1";
    thread.scrollTop = thread.scrollHeight;
    requestAnimationFrame(() => {
      if (thread.dataset.rrAnchor === "1") {
        thread.scrollTop = thread.scrollHeight;
      }
    });
    if (thread._rrGuardPin) clearTimeout(thread._rrGuardPin);
    thread._rrGuardPin = setTimeout(() => {
      thread._rrGuardPin = null;
      if (thread.dataset.rrAnchor === "1") {
        thread.scrollTop = thread.scrollHeight;
      }
    }, 180);
  }
  // Release the anchor flag when the operator actually scrolls UP
  // to read history — same logic as direct chat.  Bound once per
  // thread element so identical poll cycles don't stack listeners.
  if (!thread._rrAnchorReleaseBound) {
    thread._rrAnchorReleaseBound = true;
    const release = () => {
      requestAnimationFrame(() => {
        const cur = thread.scrollTop;
        const max = thread.scrollHeight;
        const view = thread.clientHeight;
        if ((max - cur - view) > 80) thread.dataset.rrAnchor = "0";
        else thread.dataset.rrAnchor = "1";
      });
    };
    thread.addEventListener("wheel",     release, { passive: true });
    thread.addEventListener("touchmove", release, { passive: true });
    thread.addEventListener("keydown",   release);
  }
  sb.rpc("dispatch_channel_mark_read", { p_channel_id: channelId }).then(undefined, () => {});
}

// Channel head buttons (Members, Archive) — single delegate.
document.addEventListener("click", async (e) => {
  const memBtn = e.target.closest("[data-rr-channel-members]");
  if (memBtn) {
    e.preventDefault();
    openChannelMembersModal(memBtn.getAttribute("data-rr-channel-members"));
    return;
  }
  const archBtn = e.target.closest("[data-rr-channel-archive]");
  if (archBtn) {
    e.preventDefault();
    const id = archBtn.getAttribute("data-rr-channel-archive");
    const meta = _msgChannelList.find(c => c.id === id) || {};
    const goingArchive = !meta.archived_at;
    if (!confirm(goingArchive ? "Archive this channel? Members keep history but can't post." : "Unarchive this channel?")) return;
    const { error } = await sb.rpc("dispatch_channel_archive", { p_channel_id: id, p_archived: goingArchive });
    if (error) { toast(error.message, "warn"); return; }
    delete document.getElementById("rr-msg-conv")?.dataset.rrChannelId;
    await refreshChannelList(false);
    await refreshChannelThread(false);
  }
});

// ── Create channel modal ──
function openChannelCreateModal() {
  // Pull active stations for the dropdown.  All stations under the
  // current DSP — operator can leave it blank for an org-wide channel.
  const stationsPromise = sb.from("stations").select("id, code, name").order("code");

  const wrap = document.createElement("div");
  wrap.id = "rr-channel-create-modal";
  wrap.className = "modal-backdrop open";
  wrap.innerHTML = `
    <form id="rr-channel-create-form" class="modal-card" style="max-width:440px">
      <div class="modal-head">
        <div>
          <p class="modal-title">New channel</p>
          <p class="modal-sub">Group room for drivers + dispatch</p>
        </div>
        <button type="button" class="modal-close" id="rr-cc-new-close" aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <label class="modal-field-label" for="rr-cc-new-name">Name</label>
        <input id="rr-cc-new-name" class="form-input form-input-block" required maxlength="80" placeholder="morning-wave">
        <label class="modal-field-label" for="rr-cc-new-desc">Description <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-subtle)">(optional)</span></label>
        <input id="rr-cc-new-desc" class="form-input form-input-block" maxlength="280" placeholder="What this channel is for">
        <label class="modal-field-label" for="rr-cc-new-station">Station scope</label>
        <select id="rr-cc-new-station" class="form-input form-input-block">
          <option value="">All stations · DSP-wide</option>
        </select>
        <span class="form-help">Drivers at this station auto-join. Leave blank to add members manually.</span>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn" id="rr-cc-new-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Create</button>
      </div>
    </form>`;
  document.body.appendChild(wrap);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) wrap.remove(); });
  document.getElementById("rr-cc-new-cancel").addEventListener("click", () => wrap.remove());
  document.getElementById("rr-cc-new-close").addEventListener("click", () => wrap.remove());

  stationsPromise.then(({ data }) => {
    const sel = document.getElementById("rr-cc-new-station");
    if (!sel) return;
    for (const s of (data || [])) {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = `${s.code || ""}${s.name ? " · " + s.name : ""}`;
      sel.appendChild(opt);
    }
  });

  document.getElementById("rr-channel-create-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("rr-cc-new-name").value.trim();
    const desc = document.getElementById("rr-cc-new-desc").value.trim();
    const sid  = document.getElementById("rr-cc-new-station").value || null;
    if (!name) return;
    const { data, error } = await sb.rpc("dispatch_channel_create", {
      p_name: name, p_description: desc || null, p_station_id: sid,
    });
    if (error) { toast("Create failed: " + error.message, "warn"); return; }
    wrap.remove();
    toast("Channel created", "good");
    await refreshChannelList(false);
    if (data?.id) openChannelThread(data.id);
  });
}

// ── Members modal ──
async function openChannelMembersModal(channelId) {
  const meta = _msgChannelList.find(c => c.id === channelId) || {};
  const wrap = document.createElement("div");
  wrap.id = "rr-channel-members-modal";
  wrap.className = "modal-backdrop open";
  wrap.innerHTML = `
    <div class="modal-card" style="max-width:520px;max-height:80vh;display:flex;flex-direction:column">
      <div class="modal-head">
        <div>
          <p class="modal-title">Members of #${escapeHtml(meta.name || "")}</p>
          <p class="modal-sub">Add or remove drivers from this channel</p>
        </div>
        <button type="button" class="modal-close" id="rr-cc-mem-close" aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body" style="overflow-y:auto;min-height:0">
        <div style="display:flex;gap:var(--s-2)">
          <select id="rr-cc-mem-add-driver" class="form-input form-input-block">
            <option value="">Add a driver…</option>
          </select>
          <button type="button" class="btn btn-primary" id="rr-cc-mem-add-btn">Add</button>
        </div>
        <div id="rr-cc-mem-list" style="border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden">
          <div class="rr-loading">Loading</div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) wrap.remove(); });
  document.getElementById("rr-cc-mem-close").addEventListener("click", () => wrap.remove());

  async function paint() {
    const [{ data: memData, error: memErr }, { data: drvData }] = await Promise.all([
      sb.rpc("dispatch_channel_members", { p_channel_id: channelId }),
      sb.from("drivers").select("id, full_name, status").in("status", ["active","onboarding"]).order("full_name"),
    ]);
    const list = document.getElementById("rr-cc-mem-list");
    if (memErr) {
      list.innerHTML = `<div style="padding:20px;color:var(--red);font-size:var(--fs-sm)">${escapeHtml(memErr.message)}</div>`;
      return;
    }
    const members = memData?.members || [];
    const memberIds = new Set(members.map(m => m.driver_id));
    const sel = document.getElementById("rr-cc-mem-add-driver");
    sel.innerHTML = `<option value="">Add a driver…</option>` + (drvData || [])
      .filter(d => !memberIds.has(d.id))
      .map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.full_name)}</option>`).join("");
    if (members.length === 0) {
      list.innerHTML = `<div class="rr-empty-inline">No members yet.</div>`;
      return;
    }
    list.innerHTML = members.map(m => `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border)">
        <div style="flex:1">
          <div style="font-size:var(--fs-md);font-weight:600;color:var(--text)">${escapeHtml(m.full_name || "")}</div>
          <div style="font-size:var(--fs-xs);color:var(--text-subtle)">${m.station_code ? escapeHtml(m.station_code) + " · " : ""}${escapeHtml(m.status || "")}</div>
        </div>
        <button class="btn btn-sm" data-rr-cc-mem-remove="${escapeHtml(m.driver_id)}">Remove</button>
      </div>`).join("");
    list.querySelectorAll("[data-rr-cc-mem-remove]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const did = btn.getAttribute("data-rr-cc-mem-remove");
        const { error } = await sb.rpc("dispatch_channel_remove_member", { p_channel_id: channelId, p_driver_id: did });
        if (error) { toast(error.message, "warn"); return; }
        await paint();
        refreshChannelList(false);
      });
    });
  }
  await paint();

  document.getElementById("rr-cc-mem-add-btn").addEventListener("click", async () => {
    const did = document.getElementById("rr-cc-mem-add-driver").value;
    if (!did) return;
    const { error } = await sb.rpc("dispatch_channel_add_member", { p_channel_id: channelId, p_driver_id: did });
    if (error) { toast(error.message, "warn"); return; }
    await paint();
    refreshChannelList(false);
  });
}

function _coachSeverityChip(sev, level) {
  // Prefer the precise ladder step stored in metadata.level — falls
  // back to the legacy severity enum (info/concern/warning/final)
  // for older rows that don't carry a level.
  const LEVEL_LABEL = {
    verbal:             "Verbal",
    verbal_attendance:  "Verbal · Attendance",
    written:            "Written",
    written_attendance: "Written · Attendance",
    final_attendance:   "Final · Attendance",
    termination:        "Termination",
  };
  const SEV_LABEL = { info: "Info", concern: "Concern", warning: "Warning", final: "Final" };
  const label = LEVEL_LABEL[level] || SEV_LABEL[sev] || sev || "Coaching";
  // Neutral chip — no stoplight tints on the coaching log.
  return `<span style="font-size:var(--fs-xs);font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:2px 7px;border-radius:10px;background:var(--canvas);color:var(--text-muted);border:1px solid var(--border)">${escapeHtml(label)}</span>`;
}

function _coachActionList(actionTaken) {
  if (!actionTaken || typeof actionTaken !== "object") return "";
  const labels = {
    verbal: "Verbal warning", written: "Written warning",
    retraining: "Retraining", route_change: "Route change",
    suspension: "Suspension", no_action: "No action",
  };
  const taken = Object.keys(actionTaken).filter(k => actionTaken[k]).map(k => labels[k] || k);
  if (taken.length === 0) return "";
  return `<div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:4px">Action: <strong style="color:var(--text)">${taken.map(escapeHtml).join(" · ")}</strong></div>`;
}

function renderCoachingTab(coachings, driver) {
  const items = (coachings || []).filter(c => !c.archived_at);
  const list = items.map(c => {
    const occurred = c.occurred_at ? new Date(c.occurred_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";
    const ackChip = c.acknowledgment && c.acknowledgment !== "none"
      ? `<span class="status-pill status-pill-acknowledged">Acknowledged · ${escapeHtml(c.acknowledgment)}</span>`
      : (c.driver_visible ? `<span class="status-pill status-pill-pending">Awaiting acknowledgment</span>` : "");
    const followBadge = c.follow_up_at && !c.resolved_at
      ? `<span class="status-pill status-pill-followup">Follow-up ${new Date(c.follow_up_at).toLocaleDateString()}</span>`
      : "";
    const privBadge = c.privacy_tier === "hr_only"
      ? `<span class="status-pill status-pill-error">HR-only</span>`
      : "";
    const witness = c.witness_name
      ? `<div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">Witness: <strong style="color:var(--text)">${escapeHtml(c.witness_name)}${c.witness_role ? ` (${escapeHtml(c.witness_role)})` : ""}</strong></div>`
      : "";
    // For auto-fired coachings the "coached by" name is the system
    // user (e.g. RouteReady Support).  Operators want the delivery
    // channel there instead — Driver app, SMS, or whichever route
    // the auto-fire actually used.  Manual coachings still show the
    // operator's name.
    const md = c.metadata || {};
    const isAuto = md.source === "attendance_decide" || md.auto === true;
    const channel = md.channel
      || (md.auto_message_pending === false && md.auto_notify_pending ? "Notification"
        : md.auto_message_pending ? "Driver app"
        : md.auto ? "Driver app"      // existing auto path inserts a chat message
        : null);
    const originBadge = isAuto
      ? `<span class="origin-badge origin-auto" title="Auto-fired by the attendance policy">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
           Auto
         </span>`
      : (c.coached_by_name
        ? `<span class="origin-badge origin-manual" title="Logged manually by ${escapeHtml(c.coached_by_name)}">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
             ${escapeHtml(c.coached_by_name)}
           </span>`
        : "");
    // Subtitle keeps the delivery-channel detail (Driver app / SMS /
    // Notification) for auto rows; manual rows already carry the
    // operator name in the badge above.
    const coachLine = isAuto && channel
      ? `<div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">via <strong style="color:var(--text)">${escapeHtml(channel)}</strong></div>`
      : "";
    return `
    <div class="dd-list-row" data-rr-coaching-id="${c.id}" style="display:block;padding:12px 14px">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px">
        ${_coachSeverityChip(c.severity, c.metadata?.level)}
        ${originBadge}
        <span style="font-size:var(--fs-xs);color:var(--text-subtle)">${(c.topic || "").replace(/_/g," ")} · ${(c.type || "").replace(/_/g," ")} · ${escapeHtml(occurred)}</span>
        ${followBadge} ${ackChip} ${privBadge}
      </div>
      <div class="dd-list-title">${escapeHtml(c.summary || c.topic || "(no summary)")}</div>
      ${c.notes ? `<div style="font-size:var(--fs-sm);color:var(--text-muted);margin-top:6px;line-height:1.5;white-space:pre-wrap">${escapeHtml(c.notes)}</div>` : ""}
      ${_coachActionList(c.action_taken)}
      ${witness}
      ${coachLine}
      <div style="display:flex;gap:6px;margin-top:8px">
        ${!c.resolved_at ? `<button class="btn btn-sm" data-rr-coach-resolve="${c.id}">Mark resolved</button>` : `<span style="font-size:var(--fs-xs);color:var(--green)">Resolved ${new Date(c.resolved_at).toLocaleDateString()}</span>`}
        <button class="btn btn-sm" data-rr-coach-archive="${c.id}">Archive</button>
        <button class="btn btn-sm" data-rr-coach-history="${c.id}">Edit history</button>
      </div>
    </div>`;
  }).join("");
  // Driver-facing link — operator copies and sends via SMS/email so the
  // driver can read + acknowledge their visible coaching records.
  const token = driver?.coaching_view_token;
  const base = window.RR?.dsp?.metadata?.public_base_url || window.RR_CONFIG?.PUBLIC_BASE_URL || location.origin;
  const linkBtn = token
    ? `<button class="btn btn-sm" data-rr-coach-copy-link="${escapeHtml(base.replace(/\/$/, ""))}/c/${encodeURIComponent(token)}" style="margin-left:8px">Copy driver link</button>`
    : "";
  // Drop the "+ Log coaching" button on a driver's coaching record —
  // operators log new coachings from the global Coaching feed and
  // from the daily-attendance approve flow.  The driver record is a
  // read + acknowledge view, not a re-entry point.
  return `
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
      ${linkBtn}
    </div>
    <div>${list || `<div class="rr-empty-inline">No coachings logged yet.</div>`}</div>`;
}

function renderDocumentsTab(docs) {
  const list = (docs || []).map(x => `
    <div class="dd-list-row">
      <div>
        <div class="dd-list-title">${escapeHtml(x.label || x.kind.replace(/_/g," "))}</div>
        <div class="dd-list-sub">${(x.kind || "").replace(/_/g," ")} · ${x.expires_on ? "Expires " + new Date(x.expires_on).toLocaleDateString() : "No expiry"}</div>
      </div>
      <div><button class="btn btn-sm" data-rr-doc-open="${escapeHtml(x.file_path)}">Open</button></div>
    </div>`).join("");
  return `
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <select id="rr-doc-kind" class="dd-row-input" style="background:var(--canvas);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font:inherit;font-size:var(--fs-md)">
        ${["drivers_license","mvr","dot_medical","background_check","social_security","i9","w4","direct_deposit","vehicle_registration","insurance","other"].map(k => `<option value="${k}">${k.replace(/_/g," ")}</option>`).join("")}
      </select>
      <input type="file" id="rr-doc-file" />
      <button class="btn btn-primary" data-rr-doc-upload>Upload</button>
    </div>
    <div>${list || `<div class="rr-empty-inline">No documents on file.</div>`}</div>`;
}

// Title-case name fields when the operator leaves the input. Marked via
// data-rr-capitalize. Splits on whitespace, uppercases each word's first
// char, leaves the rest untouched (so 'McNeil' stays 'McNeil' if typed,
// but 'mcneil' becomes 'Mcneil' — operators can fix surname casing manually).
document.addEventListener("focusout", (e) => {
  const el = e.target;
  if (!el || !el.matches || !el.matches("[data-rr-capitalize]")) return;
  const raw = (el.value || "").trim();
  if (!raw) return;
  const titled = raw.split(/\s+/).map(w =>
    w.length === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)
  ).join(" ");
  if (titled !== el.value) el.value = titled;
});

// Click delegate for the drawer (tabs, save, coaching log, doc upload).
document.addEventListener("click", async (e) => {
  // Coaching feed rows route to the dedicated Coaching drawer instead
  // of the full driver record drawer.
  const coachRow = e.target.closest("[data-rr-coach-feed-driver]");
  if (coachRow && !e.target.closest("button, a[href], input, select, textarea, [data-rr-no-drawer]")) {
    const id = coachRow.getAttribute("data-rr-coach-feed-driver");
    if (id) { e.preventDefault(); await openCoachingDrawer(id); return; }
  }
  // Attendance Report row → open drawer on the Attendance tab so the
  // operator drills into the per-driver report directly.
  const attRow = e.target.closest("#att-report-body [data-rr-att-row]");
  if (attRow && !e.target.closest("button, a[href], input, select, textarea, [data-rr-no-drawer]")) {
    const id = attRow.getAttribute("data-rr-att-row");
    if (id) { e.preventDefault(); await openDriverDrawer(id, { tab: "attendance" }); return; }
  }
  // Open drawer from any element marked with data-rr-driver-id (e.g. driver
  // names anywhere on the dashboard — scorecards, schedule chips, attendance
  // rows). Don't intercept clicks on form controls inside such elements.
  const named = e.target.closest("[data-rr-driver-id]");
  if (named && !e.target.closest("button, a[href], input, select, textarea, [data-rr-no-drawer]")) {
    const id = named.getAttribute("data-rr-driver-id");
    if (id) { e.preventDefault(); await openDriverDrawer(id); return; }
  }
  // Legacy: open drawer from a full row marked with [data-rr-open-driver].
  const row = e.target.closest("[data-rr-open-driver]");
  if (row && !e.target.closest("[data-rr-no-drawer]")) {
    const id = row.getAttribute("data-driver-id");
    if (id) await openDriverDrawer(id);
    return;
  }

  // Tab switch inside drawer
  const tab = e.target.closest("#rr-dd-drawer [data-rr-dd-tab]");
  if (tab) {
    e.preventDefault();
    e.stopImmediatePropagation();
    _ddTab = tab.getAttribute("data-rr-dd-tab");
    renderDriverDrawerTab();
    return;
  }

  // Availability save (own button — writes drivers.metadata.availability)
  if (e.target.closest("[data-rr-avail-save]")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const driverId = _ddDriver?.driver?.id;
    if (!driverId) { toast("Save the driver first, then set availability", "warn"); return; }
    const days = Array.from(document.querySelectorAll("#rr-dd-drawer [data-rr-avail-day]"))
      .filter(el => el.checked)
      .map(el => el.dataset.rrAvailDay);
    const startSel = document.querySelector("#rr-dd-drawer [data-rr-avail-start]");
    const earliest = startSel && startSel.value ? startSel.value : null;
    const preferred = Array.from(document.querySelectorAll("#rr-dd-drawer [data-rr-avail-pref]"))
      .filter(el => el.checked)
      .map(el => el.dataset.rrAvailPref)
      .filter(k => days.includes(k));   // a preferred day must be in the available set
    const meta = _ddDriver.driver.metadata || {};
    const availObj = { ...(meta.availability || {}), days, preferred_days: preferred };
    if (earliest) availObj.earliest_start = earliest; else delete availObj.earliest_start;
    const newMeta = { ...meta, availability: availObj };
    const { error } = await sb.from("drivers").update({ metadata: newMeta }).eq("id", driverId);
    if (error) { toast("Save failed: " + error.message, "warn"); return; }
    _ddDriver.driver.metadata = newMeta;
    toast("Availability saved", "success");
    const drawer3 = document.getElementById("rr-dd-drawer");
    if (drawer3) drawer3.remove();
    return;
  }

  // Generate driver-app invite code (renders the code inline + Copy)
  if (e.target.closest("[data-rr-issue-invite]")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const driverId = _ddDriver?.driver?.id;
    if (!driverId) { toast("Save the driver first, then generate a code", "warn"); return; }
    const btn = e.target.closest("[data-rr-issue-invite]");
    btn.disabled = true; btn.textContent = "Generating…";
    const { data, error } = await sb.rpc("issue_driver_invite", { p_driver_id: driverId });
    btn.disabled = false; btn.textContent = "Generate invite code";
    if (error) { toast("Failed: " + error.message, "warn"); return; }
    const code = data;
    const display = document.querySelector("#rr-dd-drawer [data-rr-invite-display]");
    if (display) {
      display.style.display = "block";
      display.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;background:var(--canvas);padding:10px 14px;border-radius:8px;border:1px solid var(--border)">
          <div style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:18px;font-weight:700;letter-spacing:.18em">${escapeHtml(code)}</div>
          <button type="button" class="btn btn-sm" data-rr-copy-code="${escapeHtml(code)}">Copy</button>
        </div>
        <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:6px">Share this code with the driver. Generating a new one invalidates this one.</div>`;
    }
    toast("Code generated", "success");
    return;
  }

  // Copy invite code to clipboard
  const copyBtn = e.target.closest("[data-rr-copy-code]");
  if (copyBtn) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const code = copyBtn.dataset.rrCopyCode;
    try { await navigator.clipboard.writeText(code); toast("Copied", "success"); }
    catch { toast("Copy failed — select and copy manually", "warn"); }
    return;
  }

  // Save record
  if (e.target.closest("[data-rr-dd-save]")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    // Start with anything captured from tabs the operator already
    // navigated away from, then layer the currently visible inputs on
    // top so live edits win.
    const payload = { ..._ddPending };
    document.querySelectorAll("#rr-dd-drawer [data-rr-dd-field]").forEach(el => {
      const name = el.getAttribute("data-rr-dd-field");
      payload[name] = el.type === "checkbox" ? el.checked : el.value;
    });
    if (payload.first_name === undefined && payload.full_name) {
      const parts = (payload.full_name || "").split(/\s+/);
      payload.first_name = parts[0] || null;
      payload.last_name  = parts.slice(1).join(" ") || null;
    }

    const isCreate = !_ddDriver?.driver?.id;
    if (isCreate) {
      // Validation
      if (!payload.full_name || !payload.full_name.trim()) { toast("Full name required", "warn"); return; }
      if (!payload.phone && !payload.email) { toast("Phone or email required", "warn"); return; }
      const dspId = window.RR?.dsp?.id;
      if (!dspId) { toast("DSP not loaded — refresh and try again", "warn"); return; }

      // Build INSERT row, normalizing empty strings to null for typed columns.
      const blank = (v) => (v === "" || v == null ? null : v);
      const payHourly = payload.pay_hourly === "" || payload.pay_hourly == null ? null : Number(payload.pay_hourly);
      const insertRow = {
        dsp_id:                  dspId,
        station_id:              blank(payload.station_id),
        full_name:               payload.full_name.trim(),
        first_name:              blank(payload.first_name),
        last_name:               blank(payload.last_name),
        preferred_name:          blank(payload.preferred_name),
        pronouns:                blank(payload.pronouns),
        phone:                   payload.phone ? toE164(payload.phone) : null,
        email:                   blank(payload.email),
        address:                 blank(payload.address),
        birthday:                blank(payload.birthday),
        emergency_contact_name:  blank(payload.emergency_contact_name),
        emergency_contact_phone: blank(payload.emergency_contact_phone),
        hire_date:               blank(payload.hire_date) || fmtIsoDate(new Date()),
        status:                  blank(payload.status) || "onboarding",
        background_check_completed_at: blank(payload.background_check_completed_at),
        drug_test_completed_at:        blank(payload.drug_test_completed_at),
        training_scheduled_at:         blank(payload.training_scheduled_at),
        training_date:                 blank(payload.training_date),
        metadata:                Number.isFinite(payHourly) ? { pay: { hourly_rate: payHourly } } : {},
      };
      const { error } = await sb.from("drivers").insert(insertRow);
      if (error) {
        // Surface the full error so we can diagnose. Toasts disappear too
        // quickly to read; alert blocks until acknowledged.
        console.error("driver insert failed:", error);
        alert("Add driver failed:\n\n" + (error.message || "Unknown error") + (error.details ? "\n\nDetails: " + error.details : "") + (error.hint ? "\n\nHint: " + error.hint : ""));
        return;
      }
      const drawer = document.getElementById("rr-dd-drawer");
      if (drawer) drawer.remove();
      _ddPending = {};
      await loadDriversRoster();
      toast(`${insertRow.full_name} added`, "success");
      return;
    }

    // EDIT — RPC doesn't include station_id or metadata; handle those via direct update.
    const stationId = payload.station_id;
    const payHourlyRaw = payload.pay_hourly;
    const rpcPayload = { ...payload };
    delete rpcPayload.station_id;
    delete rpcPayload.pay_hourly;
    const { error } = await sb.rpc("update_driver_record", { p_id: _ddDriver.driver.id, p_payload: rpcPayload });
    if (error) { toast("Save failed: " + error.message, "warn"); return; }
    if (stationId !== undefined && stationId !== _ddDriver.driver.station_id) {
      const { error: stErr } = await sb.from("drivers")
        .update({ station_id: stationId || null })
        .eq("id", _ddDriver.driver.id);
      if (stErr) { toast("Station save failed: " + stErr.message, "warn"); return; }
    }
    if (payHourlyRaw !== undefined) {
      const newRate = payHourlyRaw === "" ? null : Number(payHourlyRaw);
      const existingRate = _ddDriver.driver.metadata?.pay?.hourly_rate ?? null;
      if (newRate !== existingRate) {
        const newMeta = { ..._ddDriver.driver.metadata || {}, pay: { ...(_ddDriver.driver.metadata?.pay || {}), hourly_rate: newRate } };
        const { error: payErr } = await sb.from("drivers")
          .update({ metadata: newMeta })
          .eq("id", _ddDriver.driver.id);
        if (payErr) { toast("Pay rate save failed: " + payErr.message, "warn"); return; }
        _ddDriver.driver.metadata = newMeta;
      }
    }
    toast("Driver record saved", "success");
    const drawer2 = document.getElementById("rr-dd-drawer");
    if (drawer2) drawer2.remove();
    _ddPending = {};
    await loadDriversRoster();
    return;
  }

  // Add coaching
  if (e.target.closest("[data-rr-add-coaching]")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    openCoachingForm(_ddDriver.driver.id);
    return;
  }

  // License-tab upload
  if (e.target.closest("[data-rr-dl-upload]")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const file = document.getElementById("rr-dl-file")?.files?.[0];
    if (!file) { toast("Choose an image first", "warn"); return; }
    const path = `${window.RR.dsp.id}/${_ddDriver.driver.id}/license-${Date.now()}-${file.name}`;
    const { error: upErr } = await sb.storage.from("driver-documents").upload(path, file, {
      contentType: file.type, upsert: false,
    });
    if (upErr) { toast("Upload failed: " + upErr.message, "warn"); return; }
    // Remove any previous DL image from storage so we don't accumulate.
    if (_ddDriver.driver.dl_image_path) {
      sb.storage.from("driver-documents").remove([_ddDriver.driver.dl_image_path]).catch(() => {});
    }
    const { error: updErr } = await sb.from("drivers")
      .update({ dl_image_path: path }).eq("id", _ddDriver.driver.id);
    if (updErr) { toast("Save failed: " + updErr.message, "warn"); return; }
    toast("License image saved", "success");
    await loadDriverDrawer(_ddDriver.driver.id);
    return;
  }
  if (e.target.closest("[data-rr-dl-remove]")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!confirm("Remove the license image?")) return;
    if (_ddDriver.driver.dl_image_path) {
      await sb.storage.from("driver-documents").remove([_ddDriver.driver.dl_image_path]).catch(() => {});
    }
    await sb.from("drivers").update({ dl_image_path: null }).eq("id", _ddDriver.driver.id);
    toast("License image removed", "warn");
    await loadDriverDrawer(_ddDriver.driver.id);
    return;
  }

  // Open document — fetch a signed URL
  const docBtn = e.target.closest("[data-rr-doc-open]");
  if (docBtn) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const path = docBtn.getAttribute("data-rr-doc-open");
    const { data: signed } = await sb.storage.from("driver-documents").createSignedUrl(path, 60 * 60);
    if (signed?.signedUrl) window.open(signed.signedUrl, "_blank");
    return;
  }

  // Upload document
  if (e.target.closest("[data-rr-doc-upload]")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const file = document.getElementById("rr-doc-file")?.files?.[0];
    const kind = document.getElementById("rr-doc-kind")?.value;
    if (!file) { toast("Choose a file first", "warn"); return; }
    const path = `${window.RR.dsp.id}/${_ddDriver.driver.id}/${Date.now()}-${file.name}`;
    const { error: upErr } = await sb.storage.from("driver-documents").upload(path, file, {
      contentType: file.type, upsert: false,
    });
    if (upErr) { toast("Upload failed: " + upErr.message, "warn"); return; }
    const { error: insErr } = await sb.from("driver_documents").insert({
      dsp_id: window.RR.dsp.id,
      driver_id: _ddDriver.driver.id,
      kind, label: file.name, file_path: path,
      file_size: file.size, mime_type: file.type,
    });
    if (insErr) { toast("Save failed: " + insErr.message, "warn"); return; }
    toast("Document uploaded", "success");
    await loadDriverDrawer(_ddDriver.driver.id);
  }
}, true);

async function openCoachingForm(driverId) {
  let m = document.getElementById("rr-coach-modal");
  if (m) m.remove();

  // Pull the last 30d of coaching for this driver to drive the pattern strip.
  const since = new Date(); since.setDate(since.getDate() - 30);
  const { data: recent } = await sb.from("coachings")
    .select("id, severity, topic, occurred_at")
    .eq("driver_id", driverId)
    .is("archived_at", null)
    .gte("occurred_at", since.toISOString());
  const recent30 = (recent || []).length;
  const sameTopic = (recent || []).filter(r => r.topic === "safety").length;

  m = document.createElement("div");
  m.id = "rr-coach-modal";
  m.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px;overflow-y:auto";
  const today = new Date().toISOString().slice(0, 10);

  m.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;max-width:600px;width:100%;max-height:90vh;overflow-y:auto;display:flex;flex-direction:column">

      <!-- Header -->
      <div style="padding:20px 24px 14px;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
          <div>
            <h3 style="margin:0;font-size:var(--fs-lg);font-weight:600">Log a coaching</h3>
            <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:3px">Cmd / Ctrl + Enter to save</div>
          </div>
          ${recent30 >= 3
            ? `<div style="font-size:var(--fs-xs);color:var(--text-muted);background:var(--canvas);border:1px solid var(--border);padding:6px 10px;border-radius:6px;line-height:1.4;max-width:240px"><strong>${recent30}</strong> coachings in the last 30 days · consider escalating.</div>`
            : ""}
        </div>
      </div>

      <!-- Body -->
      <div style="padding:18px 24px;display:flex;flex-direction:column;gap:16px">

        <!-- Section 1: What happened -->
        <div>
          <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-subtle);letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px">The event</div>
          <div style="display:grid;grid-template-columns:1fr 1.3fr;gap:10px;margin-bottom:10px">
            <div>
              <label class="dd-eyebrow" style="display:block;margin-bottom:6px">Topic</label>
              <select id="rr-coach-topic" class="form-input" style="width:100%">
                ${["safety","performance","attendance","behavior","scorecard","conduct","theft","recognition","other"].map(t => `<option value="${t}">${t}</option>`).join("")}
              </select>
            </div>
            <div>
              <label class="dd-eyebrow" style="display:block;margin-bottom:6px">Coaching level</label>
              <select id="rr-coach-severity" class="form-input" style="width:100%">
                <optgroup label="Attendance ladder">
                  <option value="verbal_attendance">Verbal — Attendance</option>
                  <option value="written_attendance">Written — Attendance</option>
                  <option value="final_attendance">Final — Attendance</option>
                </optgroup>
                <optgroup label="Conduct / performance ladder">
                  <option value="verbal" selected>Verbal</option>
                  <option value="written">Written</option>
                  <option value="termination">Termination</option>
                </optgroup>
              </select>
            </div>
          </div>
          <label class="dd-eyebrow" style="display:block;margin-bottom:6px">Summary</label>
          <input id="rr-coach-summary" class="form-input" style="width:100%;margin-bottom:10px" placeholder="One-line headline" autofocus/>
          <label class="dd-eyebrow" style="display:block;margin-bottom:6px">Notes</label>
          <textarea id="rr-coach-notes" class="form-input" style="width:100%;min-height:88px" placeholder="What happened, what was discussed, what's next."></textarea>
        </div>

        <!-- Section 2: Driver acknowledgment -->
        <div style="background:var(--canvas);border:1px solid var(--border);border-radius:10px;padding:12px 14px">
          <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-subtle);letter-spacing:.06em;text-transform:uppercase;margin-bottom:6px">Driver acknowledgment</div>
          <label style="font-size:var(--fs-md);cursor:pointer;display:flex;align-items:flex-start;gap:10px">
            <input id="rr-coach-driver-visible" type="checkbox" style="margin-top:3px"/>
            <span style="flex:1">
              <strong>Request Confirmation</strong>
              <div id="rr-coach-rc-help" style="font-size:var(--fs-xs);color:var(--text-subtle);font-weight:400;margin-top:3px;line-height:1.5">When ON, the coaching shows up on the driver's record in their RouteReady app and they get a tappable link to read and sign-acknowledge.  When OFF, the coaching is logged on your side only — useful for sensitive notes or when you've already coached in person.</div>
            </span>
          </label>
          <div id="rr-coach-rc-locked" style="display:none;font-size:var(--fs-xs);color:var(--text-muted);background:var(--surface);border:1px dashed var(--border-strong);border-radius:6px;padding:8px 10px;margin-top:8px;line-height:1.4">
            <strong>Required at this level.</strong>  Written and Final coachings always Request Confirmation so the driver's signature is on file before the next escalation.
          </div>
        </div>

        <!-- Section 3: Details (collapsible) -->
        <button type="button" id="rr-coach-more-toggle" style="font-size:var(--fs-sm);font-weight:600;color:var(--accent-text);background:transparent;border:0;cursor:pointer;padding:0;align-self:flex-start">+ More details (type, incident date, witness, privacy, attachments)</button>

        <div id="rr-coach-more" style="display:none;display:flex;flex-direction:column;gap:14px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label class="dd-eyebrow" style="display:block;margin-bottom:6px">Type</label>
              <select id="rr-coach-type" class="form-input" style="width:100%">
                ${["in_person","sms","email","phone_call","video_call","documented_warning"].map(t => `<option value="${t}">${t.replace(/_/g," ")}</option>`).join("")}
              </select>
            </div>
            <div>
              <label class="dd-eyebrow" style="display:block;margin-bottom:6px">Incident date</label>
              <input id="rr-coach-incident-date" type="date" class="form-input" style="width:100%" value="${today}"/>
            </div>
          </div>

          <details>
            <summary style="cursor:pointer;font-size:var(--fs-sm);color:var(--text-muted);font-weight:600">Witness · 3rd party in the conversation</summary>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
              <input id="rr-coach-witness-name" class="form-input" placeholder="Witness name"/>
              <input id="rr-coach-witness-role" class="form-input" placeholder="Role (e.g. HR, Lead)"/>
            </div>
          </details>

          <div>
            <label class="dd-eyebrow" style="display:block;margin-bottom:6px">Privacy</label>
            <select id="rr-coach-privacy" class="form-input" style="width:100%;max-width:260px">
              <option value="standard">Standard (DSP staff)</option>
              <option value="hr_only">HR-only (sensitive)</option>
            </select>
          </div>

          <div>
            <label class="dd-eyebrow" style="display:block;margin-bottom:6px">Attachments</label>
            <input id="rr-coach-files" type="file" multiple style="font-size:var(--fs-sm)"/>
            <div id="rr-coach-upload-status" style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:6px"></div>
            <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:4px">Photos, scorecard screenshots, signed forms.</div>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div style="padding:14px 24px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end;background:var(--canvas)">
        <button class="btn" data-rr-coach-cancel type="button">Cancel</button>
        <button class="btn btn-primary" data-rr-coach-save type="button">Log it</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  // Auto-focus the summary so the operator can start typing immediately.
  setTimeout(() => m.querySelector("#rr-coach-summary")?.focus(), 0);

  // Toggle the More options block.
  m.querySelector("#rr-coach-more-toggle").addEventListener("click", () => {
    const more = m.querySelector("#rr-coach-more");
    const tg   = m.querySelector("#rr-coach-more-toggle");
    if (more.style.display === "none") {
      more.style.display = "flex";
      tg.textContent = "− Hide details";
    } else {
      more.style.display = "none";
      tg.textContent = "+ More details (type, incident date, witness, privacy, attachments)";
    }
  });

  // Severity → Request Confirmation lock.  Written and Final coachings
  // (both attendance and conduct ladders) always need a signed
  // acknowledgment so the next escalation has a paper trail.  When
  // one of those levels is selected, force the toggle on and disable
  // it so the operator can't accidentally skip the signature step.
  const SERIOUS_LEVELS = new Set([
    "written_attendance",
    "final_attendance",
    "written",
    "final",
  ]);
  const _applyConfirmationLock = () => {
    const sev = m.querySelector("#rr-coach-severity")?.value;
    const cb  = m.querySelector("#rr-coach-driver-visible");
    const lock= m.querySelector("#rr-coach-rc-locked");
    const help= m.querySelector("#rr-coach-rc-help");
    if (!cb) return;
    if (SERIOUS_LEVELS.has(sev)) {
      cb.checked = true;
      cb.disabled = true;
      if (lock) lock.style.display = "";
      if (help) help.style.display = "none";
    } else {
      cb.disabled = false;
      if (lock) lock.style.display = "none";
      if (help) help.style.display = "";
    }
  };
  m.querySelector("#rr-coach-severity").addEventListener("change", _applyConfirmationLock);
  _applyConfirmationLock();

  // Cmd/Ctrl + Enter saves.
  m.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      m.querySelector("[data-rr-coach-save]")?.click();
    }
  });

  // HR-only forces driver-visible off.
  m.querySelector("#rr-coach-privacy").addEventListener("change", (e) => {
    if (e.target.value === "hr_only") {
      const dv = m.querySelector("#rr-coach-driver-visible");
      if (dv) { dv.checked = false; dv.disabled = true; }
    } else {
      const dv = m.querySelector("#rr-coach-driver-visible");
      if (dv) dv.disabled = false;
    }
  });

  m.addEventListener("click", async (e) => {
    if (e.target.closest("[data-rr-coach-cancel]") || e.target === m) { m.remove(); return; }
    if (!e.target.closest("[data-rr-coach-save]")) return;

    // Read the operator's selected coaching level — it carries more
    // detail than the existing 4-value coaching_severity enum (which
    // is only info/concern/warning/final).  Map the precise level
    // onto the closest enum value for storage, but stash the exact
    // ladder step in metadata.level so downstream rendering can show
    // "Verbal — Attendance" vs. "Verbal" with no migration needed.
    const level = document.getElementById("rr-coach-severity").value;
    const levelToSeverity = {
      verbal:             "concern",
      verbal_attendance:  "concern",
      written:            "warning",
      written_attendance: "warning",
      final_attendance:   "final",
      termination:        "final",
    };
    const payload = {
      dsp_id:        window.RR.dsp.id,
      driver_id:     driverId,
      coach_user_id: window.RR.user.id,
      topic:         document.getElementById("rr-coach-topic").value,
      type:          document.getElementById("rr-coach-type")?.value || "in_person",
      severity:      levelToSeverity[level] || "concern",
      metadata:      { level },
      summary:       document.getElementById("rr-coach-summary").value.trim() || null,
      notes:         document.getElementById("rr-coach-notes").value.trim() || null,
      incident_date: document.getElementById("rr-coach-incident-date")?.value || null,
      witness_name:  document.getElementById("rr-coach-witness-name")?.value.trim() || null,
      witness_role:  document.getElementById("rr-coach-witness-role")?.value.trim() || null,
      driver_visible: !!document.getElementById("rr-coach-driver-visible")?.checked,
      privacy_tier:   document.getElementById("rr-coach-privacy")?.value || "standard",
    };
    if (!payload.summary && !payload.notes) { toast("Add a summary or notes", "warn"); return; }

    const { data: inserted, error } = await sb.from("coachings").insert(payload).select("id").single();
    if (error) { toast("Save failed: " + error.message, "warn"); return; }

    // When the operator checked "Driver can view this", post a chat
    // message to the driver in their RouteReady app so they actually
    // know a new coaching landed on their record.  Same delivery path
    // as auto-coached attendance events — uses dispatch_chat_send
    // which inserts a driver_messages row + triggers the existing
    // web-push pipeline.  Without this the coaching just sits silently
    // on the driver's record until they happen to open the app.
    if (payload.driver_visible) {
      const dspName = window.RR?.dsp?.name || "Dispatch";
      const sevWord = (() => {
        const s = (payload.metadata?.level || payload.severity || "").toLowerCase();
        if (s === "verbal_attendance"   || s === "verbal")  return "coaching note";
        if (s === "written_attendance"  || s === "written") return "written warning";
        if (s === "final_attendance")                        return "final written warning";
        if (s === "termination")                             return "termination notice";
        return "coaching";
      })();
      const headline = payload.summary || (payload.topic ? `${payload.topic} ${sevWord}` : "New coaching");

      // Pull the driver's public coaching-view token so we can paste
      // a clickable link in the message.  The driver taps it → public
      // coaching page opens in their browser → they read the full
      // record and tap to sign-acknowledge.  Without the URL, the
      // existing message just told the driver to "open the app" but
      // the coaching record isn't actually rendered anywhere in the
      // PWA today, so they had no way to acknowledge it.
      const { data: tokRow } = await sb.from("drivers")
        .select("coaching_view_token")
        .eq("id", driverId)
        .single();
      const base = window.RR?.dsp?.metadata?.public_base_url
        || window.RR_CONFIG?.PUBLIC_BASE_URL
        || location.origin;
      const link = tokRow?.coaching_view_token
        ? `${base.replace(/\/$/, "")}/c/${encodeURIComponent(tokRow.coaching_view_token)}`
        : null;

      const body = link
        ? `New ${sevWord} from ${dspName}: ${headline}.\n\nReview and sign here: ${link}`
        : `New ${sevWord} from ${dspName}: ${headline}.  Reach out to dispatch to review and sign.`;

      const { error: msgErr } = await sb.rpc("dispatch_chat_send", {
        p_driver_id: driverId,
        p_body:      body,
      });
      if (msgErr) console.warn("coaching · driver notify failed:", msgErr.message);
    }

    // Upload attachments → storage and write rows in coaching_attachments.
    const fileInput = document.getElementById("rr-coach-files");
    const status = document.getElementById("rr-coach-upload-status");
    const files = Array.from(fileInput?.files || []);
    if (files.length && inserted?.id) {
      for (const [i, f] of files.entries()) {
        const path = `${window.RR.dsp.id}/${inserted.id}/${Date.now()}-${f.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        if (status) status.textContent = `Uploading ${i + 1}/${files.length}…`;
        const { error: upErr } = await sb.storage.from("coaching-attachments").upload(path, f);
        if (upErr) { console.warn("upload failed:", upErr); continue; }
        await sb.from("coaching_attachments").insert({
          coaching_id: inserted.id,
          storage_path: path,
          file_name: f.name,
          mime_type: f.type,
          size_bytes: f.size,
          uploaded_by: window.RR.user.id,
        });
      }
    }

    m.remove();
    toast("Coaching logged", "success");
    await loadDriverDrawer(driverId);
  });
}

// Resolve / archive / edit-history / copy-link actions on the coaching tab.
document.addEventListener("click", async (e) => {
  const copyBtn = e.target.closest("[data-rr-coach-copy-link]");
  if (copyBtn) {
    const url = copyBtn.getAttribute("data-rr-coach-copy-link");
    try { await navigator.clipboard.writeText(url); toast("Link copied · paste into SMS or email", "success"); }
    catch { prompt("Copy this link to send to the driver:", url); }
    return;
  }
  const resolveBtn = e.target.closest("[data-rr-coach-resolve]");
  if (resolveBtn) {
    const id = resolveBtn.getAttribute("data-rr-coach-resolve");
    const { error } = await sb.rpc("coaching_resolve", { p_id: id });
    if (error) { toast("Resolve failed: " + error.message, "warn"); return; }
    toast("Marked resolved", "success");
    if (_ddDriver?.driver?.id) await loadDriverDrawer(_ddDriver.driver.id);
    return;
  }
  const archiveBtn = e.target.closest("[data-rr-coach-archive]");
  if (archiveBtn) {
    const id = archiveBtn.getAttribute("data-rr-coach-archive");
    const reason = prompt("Reason for archiving?\n(Coaching records are quasi-legal documents — they're hidden, not deleted.)");
    if (reason == null) return;
    const { error } = await sb.rpc("coaching_archive", { p_id: id, p_reason: reason });
    if (error) { toast("Archive failed: " + error.message, "warn"); return; }
    toast("Archived", "success");
    if (_ddDriver?.driver?.id) await loadDriverDrawer(_ddDriver.driver.id);
    return;
  }
  const histBtn = e.target.closest("[data-rr-coach-history]");
  if (histBtn) {
    const id = histBtn.getAttribute("data-rr-coach-history");
    const { data: edits } = await sb.from("coaching_edits")
      .select("*").eq("coaching_id", id).order("edited_at", { ascending: false });
    const rows = (edits || []).map(ed =>
      `<div style="font-size:var(--fs-sm);border-bottom:1px solid var(--border);padding:8px 0">
         <div style="color:var(--text-muted)">${new Date(ed.edited_at).toLocaleString()} · ${escapeHtml(ed.edited_by_name || "—")}</div>
         <div><strong>${escapeHtml(ed.field_name)}</strong> · "${escapeHtml(ed.old_value || "")}" → "${escapeHtml(ed.new_value || "")}"</div>
       </div>`).join("") || `<div style="color:var(--text-subtle);font-size:var(--fs-md)">No edits.</div>`;
    const w = document.createElement("div");
    w.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10001;display:flex;align-items:center;justify-content:center;padding:24px";
    w.innerHTML = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:22px;max-width:560px;width:100%;max-height:80vh;overflow-y:auto">
      <h3 style="margin:0 0 12px">Edit history</h3>
      ${rows}
      <div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn" type="button">Close</button></div>
    </div>`;
    w.addEventListener("click", (ev) => { if (ev.target === w || ev.target.closest("button")) w.remove(); });
    document.body.appendChild(w);
  }
});


// ─── Drivers · Coaching feed (global, sortable) ───────────────────────

let _coachFeedCache = null; // { rows, drivers }

const _COACH_SEV_RANK = { final: 0, warning: 1, concern: 2, info: 3 };

// ─── Availability requests · approve/deny queue ──────────────────────
const _AVAIL_DAY_LABELS = { mon:"Mon", tue:"Tue", wed:"Wed", thu:"Thu", fri:"Fri", sat:"Sat", sun:"Sun" };
const _AVAIL_DAY_ORDER  = ["mon","tue","wed","thu","fri","sat","sun"];

function _availDaysHtml(days, dim) {
  const set = new Set(Array.isArray(days) ? days : []);
  return _AVAIL_DAY_ORDER.map((k) => {
    const on = set.has(k);
    const bg = on ? "var(--accent)" : "var(--canvas)";
    const fg = on ? "#fff" : "var(--text-subtle)";
    const op = dim ? .55 : 1;
    return `<span style="display:inline-block;min-width:32px;text-align:center;padding:3px 6px;border-radius:5px;background:${bg};color:${fg};font-size:var(--fs-xs);font-weight:600;opacity:${op}">${_AVAIL_DAY_LABELS[k]}</span>`;
  }).join(" ");
}

function _fmtRel(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// Module-level state for the availability tab so sort + filter survive
// re-renders triggered by approval/denial.
let _availRequestsCache = [];
let _availSortKey = "default"; // default | driver | station | submitted | status | requests
let _availSortDir = "asc";     // asc | desc
let _availSearchTerm = "";     // filters rows by driver name

// Build the KPI strip + management panels + sortable header inside
// the Drivers → Availability sub-view.  Idempotent — the dataset flag
// keeps re-renders from stacking shells.  Was lost in an earlier
// merge, which made loadAvailabilityRequests crash with a
// ReferenceError every time it ran (Drivers nav, Schedule nav via
// the goto chain, etc.) — and that exception broke the goto chain
// mid-cascade, leaving the operator on whichever view was active
// before the click.
function _renderAvailabilityShell() {
  const host = document.getElementById("dr-sub-availability");
  if (!host) return;
  if (host.dataset.rrShell === "1") return;
  host.dataset.rrShell = "1";

  // The page-level settings drawer was removed; lead-time / auto-
  // responses / blackout windows now live exclusively in
  // Settings → Availability rules (reachable via the topbar gear).
  // KPI / settings / blackouts containers still live in static HTML
  // — the renderers populate them in place.

  const list = document.getElementById("rr-avail-req-list");
  if (list) {
    list.insertAdjacentHTML("beforebegin", `
      <div id="rr-avail-toolbar" style="display:flex;align-items:center;gap:12px;padding:10px 18px;border-bottom:1px solid var(--border-subtle);background:var(--canvas);flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:200px;background:var(--surface);border:1px solid var(--border-strong);border-radius:var(--r-md);padding:6px 10px">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--text-subtle);flex-shrink:0"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="search" id="rr-avail-search" placeholder="Find a driver…" autocomplete="off"
                 style="flex:1;border:0;outline:0;background:transparent;font:inherit;font-size:var(--fs-sm);color:var(--text)" />
        </div>
        <div style="display:flex;gap:8px;align-items:center;font-size:var(--fs-xs);font-weight:600;color:var(--text-subtle);text-transform:uppercase;letter-spacing:.04em">
          <span style="margin-right:2px">Sort:</span>
          <button class="avail-sort-btn" data-rr-sort="driver">Driver</button>
          <button class="avail-sort-btn" data-rr-sort="station">Station</button>
          <button class="avail-sort-btn" data-rr-sort="submitted">Submitted</button>
          <button class="avail-sort-btn" data-rr-sort="status">Status</button>
          <button class="avail-sort-btn" data-rr-sort="requests">Requests</button>
        </div>
      </div>
    `);
    if (!document.getElementById("rr-avail-sort-style")) {
      const st = document.createElement("style");
      st.id = "rr-avail-sort-style";
      st.textContent = `
        .avail-sort-btn{font:inherit;text-transform:inherit;letter-spacing:inherit;
          color:var(--text-subtle);background:none;border:0;padding:2px 6px;border-radius:4px;cursor:pointer}
        .avail-sort-btn:hover{color:var(--text)}
        .avail-sort-btn.active{color:var(--accent);background:var(--accent-soft)}
      `;
      document.head.appendChild(st);
    }
    document.getElementById("rr-avail-search").addEventListener("input", (e) => {
      _availSearchTerm = (e.target.value || "").trim().toLowerCase();
      _renderAvailabilityRows();
    });
    document.getElementById("rr-avail-toolbar").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-rr-sort]");
      if (!btn) return;
      const k = btn.dataset.rrSort;
      if (_availSortKey === k) {
        _availSortDir = _availSortDir === "asc" ? "desc" : "asc";
      } else {
        _availSortKey = k;
        // request-count default to descending (most-active drivers up top)
        _availSortDir = (k === "requests" || k === "submitted") ? "desc" : "asc";
      }
      _renderAvailabilityRows();
    });
  }
}

async function loadAvailabilityRequests() {
  const wrap = document.getElementById("rr-avail-req-list");
  if (!wrap) return;

  // Header + KPI shells render synchronously so the operator sees
  // structure even while the data loads.
  _renderAvailabilityShell();
  wrap.innerHTML = `<div class="rr-loading">Loading requests</div>`;

  // Fire all five endpoints in parallel.  The decision-support
  // numbers under each pending request need:
  //   - Active drivers' saved availability (drivers + metadata.days)
  //   - OKAMI demand per day across the next four weeks
  // Both already exist for the Insights view; we re-fetch them here
  // so impact rendering doesn't depend on the operator having
  // visited Insights first.
  const today = new Date();
  const monday = startOfWeekMonday(today);
  const startIso = fmtIsoDate(monday);
  const [reqRes, kpiRes, blackRes, setRes, drvRes, gridRes] = await Promise.all([
    sb.rpc("availability_request_list"),
    sb.rpc("availability_kpis"),
    sb.rpc("availability_blackout_list"),
    sb.rpc("availability_settings_get"),
    sb.from("drivers")
      .select("id, status, score, metadata")
      .eq("dsp_id", window.RR.dsp.id)
      .in("status", ["active", "onboarding"]),
    sb.rpc("okami_grid", { p_start: startIso, p_weeks: 4 }),
  ]);
  if (reqRes.error) {
    wrap.innerHTML = `<div style="padding:24px;color:var(--red);font-size:var(--fs-md)">${escapeHtml(reqRes.error.message)}</div>`;
    return;
  }
  _availRequestsCache = reqRes.data || [];
  const pendingCount = _availRequestsCache.filter((r) => r.status === "pending").length;
  _updateAvailReqBadge(pendingCount);

  // Build an availability-by-day index so each pending row can show
  // "8 drivers still available Monday" inline.  Falls back gracefully
  // if metadata.availability.days isn't populated for some drivers.
  _availImpactCtx = _buildAvailImpactCtx(drvRes.data || [], gridRes.data || []);

  // KPIs + blackouts + settings rendered into their own slots.
  // The old "coverage by day" card moved into the Least-covered-day
  // KPI drilldown — no longer rendered standalone.
  _renderAvailabilityKpis(kpiRes.data || {}, _availRequestsCache);
  _renderAvailabilityBlackouts(blackRes.data || []);
  _renderAvailabilitySettingsPanel(setRes.data || {});
  _renderAvailabilityRows();
}

// Pre-compute per-DOW supply (drivers available) + peak demand
// (max routes that day across the next 4 weeks) once per page load.
// Ignores the requester's current availability — the row renderer
// applies the "what if" math on top of this baseline.  Was lost in
// the same merge that dropped _renderAvailabilityShell — without
// these the loadAvailabilityRequests continuation throws a
// ReferenceError, and that broke the goto chain (clicking Schedule
// would briefly render then snap back to whichever view was active
// before the click).
let _availImpactCtx = null;
function _buildAvailImpactCtx(drivers, okamiGrid) {
  const DOW = ["mon","tue","wed","thu","fri","sat","sun"];
  const supplyByDow = Object.fromEntries(DOW.map(d => [d, 0]));
  const totalActive = drivers.length;
  // Per-driver availability so the new Availability KPIs (FT/PT,
  // average days, weekend coverage, flex capacity) can compute against
  // the same source the bars read from.
  const driverDays = [];
  for (const d of drivers) {
    const days = d.metadata?.availability?.days;
    const arr = Array.isArray(days) ? days.filter(x => supplyByDow[x] !== undefined) : [];
    for (const dow of arr) supplyByDow[dow] += 1;
    driverDays.push({
      id:    d.id,
      name:  d.full_name || d.preferred_name || "",
      days:  arr,
      score: typeof d.score === "number" ? d.score : null,
    });
  }
  const demandByDow = Object.fromEntries(DOW.map(d => [d, 0]));
  const JS_DOW = { 0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat" };
  for (const cell of (okamiGrid || [])) {
    if (!cell?.date) continue;
    const dow = JS_DOW[new Date(cell.date + "T12:00:00").getDay()];
    const routes = Number(cell.routes_planned ?? cell.routes ?? 0);
    if (routes > demandByDow[dow]) demandByDow[dow] = routes;
  }
  return { supplyByDow, demandByDow, totalActive, driverDays };
}

function _availImpactFor(req) {
  if (!_availImpactCtx) return null;
  const cur = new Set(req.current_days || []);
  const next = new Set(req.days || []);
  const drops = [...cur].filter(d => !next.has(d));
  const adds  = [...next].filter(d => !cur.has(d));
  const DOW_LABEL = { mon:"Mon", tue:"Tue", wed:"Wed", thu:"Thu", fri:"Fri", sat:"Sat", sun:"Sun" };
  const supply = _availImpactCtx.supplyByDow;
  const demand = _availImpactCtx.demandByDow;

  // Driver themselves is already counted in `supply` (they're active),
  // so subtract 1 to model the after-change state.
  const dropImpact = drops.map(d => {
    const after = (supply[d] || 0) - 1;
    const peak  = demand[d] || 0;
    return {
      day:    d,
      label:  DOW_LABEL[d] || d,
      after,
      peak,
      tight:  peak > 0 && after < peak,
    };
  });
  const addImpact = adds.map(d => ({
    day:   d,
    label: DOW_LABEL[d] || d,
    after: (supply[d] || 0) + 1,
    peak:  demand[d] || 0,
  }));
  return { drops: dropImpact, adds: addImpact };
}

// KPI cards + repeat-requesters panel for Drivers → Availability.  Was
// dropped in the same merge that lost _renderAvailabilityShell and
// _buildAvailImpactCtx, which left the Availability sub-tab spinning
// forever (loadAvailabilityRequests threw a ReferenceError after the
// Promise.all resolved).  Restored verbatim from 053968c.
// Day-of-week constants reused across the KPIs + drilldowns.
const _AVAIL_DOW       = ["mon","tue","wed","thu","fri","sat","sun"];
const _AVAIL_DOW_LABEL = { mon:"Mon", tue:"Tue", wed:"Wed", thu:"Thu", fri:"Fri", sat:"Sat", sun:"Sun" };
const _AVAIL_DOW_FULL  = { mon:"Monday", tue:"Tuesday", wed:"Wednesday", thu:"Thursday", fri:"Friday", sat:"Saturday", sun:"Sunday" };

let _availKpiDetailKpi = null;   // 'leastCovered' | 'ftpt' | 'avgDays' | 'weekend' | null

// Hide the drilldown + clear state.  Wired into drSub() and goto()
// below so re-entering the page always starts with the panel closed.
function _closeAvailKpiDetail() {
  _availKpiDetailKpi = null;
  const panel = document.getElementById("rr-avail-kpi-detail");
  if (panel) { panel.style.display = "none"; panel.innerHTML = ""; }
  document.querySelectorAll("[data-rr-avail-kpi]").forEach(el => el.classList.remove("active"));
}

// Compute the four KPI values from _availImpactCtx.  Each value comes
// back with `display`, the full label-line `sub`, and the raw numbers
// the drilldown will need.
function _computeAvailKpis() {
  const ctx = _availImpactCtx;
  const out = {
    leastCovered: { display: "—", sub: "no drivers yet" },
    ftpt:         { display: "—", sub: "no drivers yet", ft: 0, pt: 0 },
    avgDays:      { display: "—", sub: "no drivers yet" },
    weekend:      { display: "—", sub: "no drivers yet" },
  };
  if (!ctx || ctx.totalActive === 0) return out;

  // Least covered day (lowest supply%)
  let minDow = "mon", minPct = Infinity;
  for (const d of _AVAIL_DOW) {
    const pct = Math.round((ctx.supplyByDow[d] / ctx.totalActive) * 100);
    if (pct < minPct) { minPct = pct; minDow = d; }
  }
  out.leastCovered = {
    display: `${minPct}%`,
    sub:     `${_AVAIL_DOW_FULL[minDow]} · ${ctx.supplyByDow[minDow]}/${ctx.totalActive} drivers`,
    minDow, minPct,
  };

  // FT / PT split — assume 1 day = 10 hours; ≥4 days = FT, ≤3 = PT.
  // Surfaced as a single % so the KPI reads "X% of drivers are FT" at
  // a glance; raw counts move to the supporting sub-line.
  let ft = 0, pt = 0;
  for (const d of ctx.driverDays) {
    if (d.days.length >= 4) ft++;
    else if (d.days.length > 0) pt++;
    // Drivers with no availability data are excluded from the split.
  }
  const ratioPct = (ft + pt) > 0 ? Math.round((ft / (ft + pt)) * 100) : 0;
  out.ftpt = {
    display: `${ratioPct}%`,
    sub:     `${ft} FT · ${pt} PT  ·  4+ days = FT`,
    ft, pt, ratioPct,
  };

  // Avg days / driver — only across drivers who set any availability.
  const withDays = ctx.driverDays.filter(d => d.days.length > 0);
  const totalDays = withDays.reduce((s, d) => s + d.days.length, 0);
  const avg = withDays.length > 0 ? totalDays / withDays.length : 0;
  out.avgDays = {
    display: withDays.length > 0 ? avg.toFixed(1) : "—",
    sub:     withDays.length > 0
      ? `across ${withDays.length} of ${ctx.totalActive} active drivers`
      : "no availability set yet",
    avg, withDaysCount: withDays.length,
  };

  // Weekend coverage — % of active drivers available either Sat or Sun.
  const weekendDrivers = ctx.driverDays.filter(d => d.days.includes("sat") || d.days.includes("sun"));
  const wkPct = Math.round((weekendDrivers.length / ctx.totalActive) * 100);
  out.weekend = {
    display: `${wkPct}%`,
    sub:     `${weekendDrivers.length}/${ctx.totalActive} cover Sat or Sun`,
    weekendCount: weekendDrivers.length,
  };

  return out;
}

function _renderAvailabilityKpis(k, rows) {
  const host = document.getElementById("dr-sub-availability");
  const el = host?.querySelector("[data-rr-avail-kpis]");
  if (!el) return;

  const kpis = _computeAvailKpis();
  const card = (key, label, value, sub) => `
    <div class="di-card di-card-clickable" data-rr-avail-kpi="${key}" role="button" tabindex="0" aria-label="Open ${escapeHtml(label)} detail">
      <div class="di-label">${escapeHtml(label)}</div>
      <div class="di-val">${escapeHtml(String(value))}</div>
      <div class="di-sub">${escapeHtml(sub)}</div>
    </div>`;
  el.innerHTML = [
    card("leastCovered", "Least covered day", kpis.leastCovered.display, kpis.leastCovered.sub),
    card("ftpt",         "Full-time drivers", kpis.ftpt.display,         kpis.ftpt.sub),
    card("avgDays",      "Avg days / driver", kpis.avgDays.display,      kpis.avgDays.sub),
    card("weekend",      "Weekend coverage",  kpis.weekend.display,      kpis.weekend.sub),
  ].join("");

  // Re-render the open drilldown if one was active (driver list changed
  // or RPC roundtrip finished).  Closed-by-default behavior is preserved
  // — _availKpiDetailKpi only gets set by an explicit click.
  if (_availKpiDetailKpi) _renderAvailKpiDetail();
}

// ─── Availability KPI drilldown panel ────────────────────────────────
//
// Click handlers below set _availKpiDetailKpi and call this; toggle off
// by clicking the same card again.  Mirrors the attendance-page pattern
// (di-card-clickable + caret) so the affordance reads the same.

function _availKpiPanelShell(title, sub, body) {
  return `<div class="card" style="padding:var(--s-5)">
    <div style="margin-bottom:var(--s-3)">
      <div style="font-size:var(--fs-lg);font-weight:700;color:var(--text);letter-spacing:-.01em">${escapeHtml(title)}</div>
      ${sub ? `<div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">${escapeHtml(sub)}</div>` : ""}
    </div>
    ${body}
  </div>`;
}

function _renderAvailKpiDetail() {
  const panel = document.getElementById("rr-avail-kpi-detail");
  if (!panel) return;
  document.querySelectorAll("[data-rr-avail-kpi]").forEach(el => {
    el.classList.toggle("active", el.dataset.rrAvailKpi === _availKpiDetailKpi);
  });
  if (!_availKpiDetailKpi) { panel.style.display = "none"; panel.innerHTML = ""; return; }
  panel.style.display = "block";

  const ctx  = _availImpactCtx;
  const kpis = _computeAvailKpis();
  if (!ctx || ctx.totalActive === 0) {
    panel.innerHTML = _availKpiPanelShell(
      "No data yet",
      "Add active drivers and have them submit availability to see the breakdown.",
      "");
    return;
  }

  if (_availKpiDetailKpi === "leastCovered") {
    // The same per-DOW bar chart that used to live on the page,
    // surfaced here as the drilldown for "least covered day".
    const total = ctx.totalActive;
    const bars = _AVAIL_DOW.map(d => {
      const supply = ctx.supplyByDow[d] || 0;
      const peak   = ctx.demandByDow[d] || 0;
      const pct    = total > 0 ? Math.round((supply / total) * 100) : 0;
      const isMin  = d === kpis.leastCovered.minDow;
      return `
        <div style="display:grid;grid-template-columns:48px 1fr 90px 130px;align-items:center;gap:12px;padding:6px 0">
          <div style="font-size:var(--fs-sm);font-weight:600;color:${isMin ? "var(--red)" : "var(--text)"}">${_AVAIL_DOW_LABEL[d]}</div>
          <div style="background:var(--accent-soft);height:10px;border-radius:5px;overflow:hidden">
            <div style="background:${isMin ? "var(--red)" : "var(--accent)"};height:100%;width:${pct}%;transition:width .3s"></div>
          </div>
          <div style="font-size:var(--fs-md);font-weight:700;color:${isMin ? "var(--red)" : "var(--text)"};text-align:right;font-variant-numeric:tabular-nums">${pct}%</div>
          <div style="font-size:var(--fs-xs);color:var(--text-subtle);text-align:right;font-variant-numeric:tabular-nums">${supply}/${total}${peak > 0 ? ` · peak demand ${peak}` : ""}</div>
        </div>`;
    }).join("");
    panel.innerHTML = _availKpiPanelShell(
      "Coverage by day",
      `% of the ${total} active driver${total === 1 ? "" : "s"} available each day. The lowest day is highlighted.`,
      bars);
    return;
  }

  if (_availKpiDetailKpi === "ftpt") {
    // Composite-score comparison: FT vs PT averages.
    // Score is the per-driver composite (0–100) on the drivers table;
    // we compare the two groups' averages so operators can see whether
    // their FT roster outperforms their PT roster (or vice versa).
    const ftDrivers = ctx.driverDays.filter(d => d.days.length >= 4);
    const ptDrivers = ctx.driverDays.filter(d => d.days.length > 0 && d.days.length <= 3);

    const ftScored = ftDrivers.filter(d => typeof d.score === "number");
    const ptScored = ptDrivers.filter(d => typeof d.score === "number");
    const avg = (arr) => arr.length === 0 ? null : arr.reduce((s, d) => s + d.score, 0) / arr.length;
    const ftAvg = avg(ftScored);
    const ptAvg = avg(ptScored);
    const fmt   = (v) => v == null ? "—" : v.toFixed(1);

    // Tier color for a score: green ≥ 85, amber 70–84, red < 70.
    const tier = (v) => v == null ? "var(--text-subtle)" : v >= 85 ? "var(--green)" : v >= 70 ? "var(--amber)" : "var(--red)";

    const card = (label, count, scored, avgVal, sub) => `
      <div style="background:var(--canvas);border:1px solid var(--border);border-radius:10px;padding:18px 20px">
        <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">${label}</div>
        <div style="display:flex;align-items:baseline;gap:10px;margin-top:6px">
          <div style="font-size:36px;font-weight:700;color:${tier(avgVal)};letter-spacing:-.02em;line-height:1">${fmt(avgVal)}</div>
          <div style="font-size:var(--fs-xs);color:var(--text-subtle)">avg composite score</div>
        </div>
        <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:8px;line-height:1.5">${sub}<br/>${scored} of ${count} ${count === 1 ? "driver has" : "drivers have"} a score on file</div>
      </div>`;

    let delta = "";
    if (ftAvg != null && ptAvg != null) {
      const diff = Math.abs(ftAvg - ptAvg);
      const winner = ftAvg > ptAvg ? "Full-time" : (ptAvg > ftAvg ? "Part-time" : null);
      if (winner) {
        delta = `<div style="margin-top:var(--s-3);padding:12px 14px;background:var(--accent-soft);border-radius:8px;font-size:var(--fs-sm);color:var(--text);line-height:1.5">
          <strong>${winner} drivers score ${diff.toFixed(1)} points higher</strong> on average than the other group.
        </div>`;
      } else {
        delta = `<div style="margin-top:var(--s-3);padding:12px 14px;background:var(--canvas);border:1px solid var(--border);border-radius:8px;font-size:var(--fs-sm);color:var(--text-muted);line-height:1.5">Both groups average the same composite score.</div>`;
      }
    }

    const empty = (ftScored.length + ptScored.length === 0)
      ? `<div class="rr-empty-inline" style="padding:20px 0;margin-top:var(--s-3)">No driver scores on file yet — composite scores live on the Drivers table; once they're populated this comparison fills in.</div>`
      : "";

    panel.innerHTML = _availKpiPanelShell(
      "Composite score · FT vs PT",
      `Side-by-side average of each driver's composite score (0–100). FT = 4+ available days, PT = 1–3.`,
      `<div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--s-3)">
        ${card("Full-time", ftDrivers.length, ftScored.length, ftAvg, `4+ available days per week`)}
        ${card("Part-time", ptDrivers.length, ptScored.length, ptAvg, `1–3 available days per week`)}
      </div>${delta}${empty}`);
    return;
  }

  if (_availKpiDetailKpi === "avgDays") {
    // Histogram: drivers per "days available" bucket (1 → 7).
    const buckets = [0, 0, 0, 0, 0, 0, 0]; // 1d..7d
    let zero = 0;
    for (const d of ctx.driverDays) {
      if (d.days.length === 0) zero++;
      else if (d.days.length <= 7) buckets[d.days.length - 1] += 1;
    }
    const max = Math.max(1, ...buckets);
    const totalSet = buckets.reduce((s, n) => s + n, 0);
    const histRows = buckets.map((n, i) => {
      const days = i + 1;
      const pct  = totalSet > 0 ? Math.round((n / totalSet) * 100) : 0;
      const w    = (n / max) * 100;
      const tier = days >= 4 ? "FT" : "PT";
      return `<div style="display:grid;grid-template-columns:96px 1fr 90px 90px;gap:14px;align-items:center;padding:8px 0">
        <div style="font-size:var(--fs-sm);font-weight:600;color:var(--text)">${days} day${days === 1 ? "" : "s"} <span style="font-size:var(--fs-xs);color:var(--text-subtle);font-weight:500;margin-left:4px">${tier}</span></div>
        <div style="background:var(--canvas);border-radius:6px;height:14px;overflow:hidden;border:1px solid var(--border)">
          <div style="background:${days >= 4 ? "var(--accent)" : "var(--amber)"};height:100%;width:${w.toFixed(1)}%;transition:width .3s"></div>
        </div>
        <div style="text-align:right;font-size:var(--fs-sm);color:var(--text-muted)"><strong style="color:var(--text)">${n}</strong> · ${pct}%</div>
      </div>`;
    }).join("");
    const footer = zero > 0
      ? `<div style="font-size:var(--fs-xs);color:var(--text-subtle);padding-top:8px;border-top:1px solid var(--border);margin-top:8px">${zero} driver${zero === 1 ? " hasn't" : "s haven't"} set their availability yet — excluded from the average.</div>`
      : `<div style="font-size:var(--fs-xs);color:var(--text-subtle);padding-top:8px;border-top:1px solid var(--border);margin-top:8px">All ${ctx.totalActive} drivers have availability on file.</div>`;
    panel.innerHTML = _availKpiPanelShell(
      "Days-available distribution",
      `Average is ${kpis.avgDays.display} day${kpis.avgDays.display === "1.0" ? "" : "s"} per driver. Bars amber for PT (1–3) and brand-blue for FT (4–7).`,
      `${histRows}${footer}`);
    return;
  }

  if (_availKpiDetailKpi === "weekend") {
    // Sat / Sun breakdown.  Buckets: Sat-only, Sun-only, both, neither.
    let bothCount = 0, satOnly = 0, sunOnly = 0, neither = 0;
    for (const d of ctx.driverDays) {
      const sat = d.days.includes("sat");
      const sun = d.days.includes("sun");
      if (sat && sun)      bothCount++;
      else if (sat)        satOnly++;
      else if (sun)        sunOnly++;
      else                 neither++;
    }
    const total = ctx.totalActive;
    const satTotal = ctx.supplyByDow.sat || 0;
    const sunTotal = ctx.supplyByDow.sun || 0;
    const cell = (label, n, color) => {
      const pct = total > 0 ? Math.round((n / total) * 100) : 0;
      return `<div style="display:grid;grid-template-columns:160px 1fr 90px;gap:14px;align-items:center;padding:8px 0">
        <div style="font-size:var(--fs-sm);font-weight:600;color:var(--text)">${label}</div>
        <div style="background:var(--canvas);border-radius:6px;height:14px;overflow:hidden;border:1px solid var(--border)">
          <div style="background:${color};height:100%;width:${pct}%;transition:width .3s"></div>
        </div>
        <div style="text-align:right;font-size:var(--fs-sm);color:var(--text-muted)"><strong style="color:var(--text)">${n}</strong> · ${pct}%</div>
      </div>`;
    };
    panel.innerHTML = _availKpiPanelShell(
      "Weekend coverage",
      `Saturday and Sunday are usually the leanest days. Track who's covering each so swaps don't gut a weekend.`,
      `<div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--s-4);margin-bottom:var(--s-3)">
        <div style="background:var(--canvas);border-radius:8px;padding:12px 14px">
          <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Saturday</div>
          <div style="font-size:var(--fs-xl);font-weight:700;color:var(--text);margin-top:4px">${satTotal}<span style="font-size:var(--fs-xs);color:var(--text-subtle);font-weight:500;margin-left:4px">drivers</span></div>
        </div>
        <div style="background:var(--canvas);border-radius:8px;padding:12px 14px">
          <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Sunday</div>
          <div style="font-size:var(--fs-xl);font-weight:700;color:var(--text);margin-top:4px">${sunTotal}<span style="font-size:var(--fs-xs);color:var(--text-subtle);font-weight:500;margin-left:4px">drivers</span></div>
        </div>
      </div>
      ${cell("Cover both Sat + Sun", bothCount, "var(--green)")}
      ${cell("Saturday only",         satOnly,   "var(--accent)")}
      ${cell("Sunday only",           sunOnly,   "var(--accent)")}
      ${cell("Neither weekend day",   neither,   "var(--red)")}`);
    return;
  }
}

// Click handler: KPI card opens / closes its own detail panel.
document.addEventListener("click", (e) => {
  const card = e.target.closest("[data-rr-avail-kpi]");
  if (!card) return;
  const kpi = card.dataset.rrAvailKpi;
  _availKpiDetailKpi = (_availKpiDetailKpi === kpi) ? null : kpi;
  _renderAvailKpiDetail();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const card = e.target.closest("[data-rr-avail-kpi]");
  if (!card) return;
  e.preventDefault();
  card.click();
});

function _renderAvailabilityBlackouts(rows) {
  // The blackout container moved from the Availability page modal
  // (deleted) to Settings → Availability rules.  Look up the element
  // anywhere in the document rather than scoping to dr-sub-availability.
  const el = document.querySelector("[data-rr-avail-blackouts]");
  if (!el) return;
  const list = (rows || []).map(b => `
    <div style="display:grid;grid-template-columns:140px 140px 1fr auto;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);align-items:center;font-size:var(--fs-md)">
      <div>${escapeHtml(b.start_date || "")}</div>
      <div>${escapeHtml(b.end_date || "")}</div>
      <div style="color:var(--text-muted)">${escapeHtml(b.reason || "")}</div>
      <button class="btn btn-sm btn-danger" data-rr-blackout-delete="${escapeHtml(b.id)}">Delete</button>
    </div>`).join("");
  el.innerHTML = `
    <form id="rr-avail-blackout-form" style="display:grid;grid-template-columns:140px 140px 1fr auto;gap:10px;align-items:end;margin:6px 0 14px">
      <div>
        <label style="display:block;font-size:var(--fs-xs);font-weight:600;color:var(--text-subtle);margin-bottom:4px">Start</label>
        <input type="date" id="rr-bl-start" required class="form-input form-input-block"/>
      </div>
      <div>
        <label style="display:block;font-size:var(--fs-xs);font-weight:600;color:var(--text-subtle);margin-bottom:4px">End</label>
        <input type="date" id="rr-bl-end" required class="form-input form-input-block"/>
      </div>
      <div>
        <label style="display:block;font-size:var(--fs-xs);font-weight:600;color:var(--text-subtle);margin-bottom:4px">Reason (optional)</label>
        <input type="text" id="rr-bl-reason" placeholder="e.g. Holiday peak — no availability changes" class="form-input form-input-block"/>
      </div>
      <button type="submit" class="btn btn-sm btn-primary">Add blackout</button>
    </form>
    ${list || `<div style="font-size:var(--fs-sm);color:var(--text-subtle);padding:8px 0">No blackouts. Drivers can submit any day.</div>`}
  `;
  document.getElementById("rr-avail-blackout-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const start_date = document.getElementById("rr-bl-start").value;
    const end_date   = document.getElementById("rr-bl-end").value;
    const reason     = document.getElementById("rr-bl-reason").value;
    if (!start_date || !end_date) return;
    const { error } = await sb.rpc("availability_blackout_upsert", {
      p_id: null, p_start_date: start_date, p_end_date: end_date, p_reason: reason,
    });
    if (error) { toast("Failed: " + error.message, "warn"); return; }
    toast("Blackout added", "success");
    loadAvailabilityRequests();
  });
}

function _renderAvailabilitySettingsPanel(s) {
  // Like _renderAvailabilityBlackouts above — the settings form lives
  // in Settings → Availability rules now, so query the document
  // globally instead of scoping to dr-sub-availability.
  const el = document.querySelector("[data-rr-avail-settings]");
  if (!el) return;
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:200px 1fr;gap:14px;margin-top:8px;align-items:start">
      <label style="font-size:var(--fs-md);font-weight:600">Lead time<br><span style="font-size:var(--fs-xs);color:var(--text-subtle);font-weight:400">Days from approval until the change is live for scheduling.</span></label>
      <div>
        <input type="number" id="rr-avail-lead" min="0" max="60" value="${Number(s.lead_days ?? 7)}" class="form-input form-input-sm" style="max-width:120px"/>
        <span style="font-size:var(--fs-sm);color:var(--text-subtle);margin-left:6px">days</span>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:200px 1fr;gap:14px;margin-top:14px;align-items:start">
      <label style="font-size:var(--fs-md);font-weight:600">Approve auto-response<br><span style="font-size:var(--fs-xs);color:var(--text-subtle);font-weight:400">Sent to the driver when you approve. Placeholders: {days} {effective_from} {effective_until} {note}</span></label>
      <textarea id="rr-avail-approve-tmpl" rows="3" class="form-input form-input-block">${escapeHtml(s.approve_template || "")}</textarea>
    </div>
    <div style="display:grid;grid-template-columns:200px 1fr;gap:14px;margin-top:14px;align-items:start">
      <label style="font-size:var(--fs-md);font-weight:600">Deny auto-response<br><span style="font-size:var(--fs-xs);color:var(--text-subtle);font-weight:400">Sent to the driver when you deny. Placeholders: {days} {note}</span></label>
      <textarea id="rr-avail-deny-tmpl" rows="3" class="form-input form-input-block">${escapeHtml(s.deny_template || "")}</textarea>
    </div>
    <div id="rr-avail-settings-status" style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:14px;text-align:right;min-height:14px">Auto-saves when you click outside a field.</div>`;

  // Auto-save on blur. One submit per field-change is fine — the RPC
  // takes all three values, the database does an upsert, and the
  // values we send are read live from the inputs each time.
  const status = document.getElementById("rr-avail-settings-status");
  const lead   = document.getElementById("rr-avail-lead");
  const appr   = document.getElementById("rr-avail-approve-tmpl");
  const deny   = document.getElementById("rr-avail-deny-tmpl");
  const snapshot = () => ({
    lead: lead.value, appr: appr.value, deny: deny.value,
  });
  let lastSaved = snapshot();
  const persist = async () => {
    const cur = snapshot();
    if (cur.lead === lastSaved.lead && cur.appr === lastSaved.appr && cur.deny === lastSaved.deny) return;
    status.textContent = "Saving…";
    status.style.color = "var(--text-subtle)";
    const { error } = await sb.rpc("availability_settings_set", {
      p_lead_days:        Number(cur.lead || 7),
      p_approve_template: cur.appr,
      p_deny_template:    cur.deny,
    });
    if (error) {
      status.textContent = "Save failed: " + error.message;
      status.style.color = "var(--red)";
      return;
    }
    lastSaved = cur;
    const t = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    status.textContent = `Saved at ${t}`;
    status.style.color = "var(--text-subtle)";
  };
  lead.addEventListener("blur", persist);
  lead.addEventListener("change", persist);
  appr.addEventListener("blur", persist);
  deny.addEventListener("blur", persist);
}

// Last of the merge-loss casualties — without this _renderAvailabilityRows
// throws on its first call and the Pending availability requests panel
// stays on "Loading…" forever.  Restored from 053968c.
function _sortAvailRows(rows) {
  const dir = _availSortDir === "asc" ? 1 : -1;
  const cmp = (a, b) => {
    let av, bv;
    switch (_availSortKey) {
      case "driver":    av = (a.driver_name || "").toLowerCase(); bv = (b.driver_name || "").toLowerCase(); break;
      case "station":   av = (a.station_code || "").toLowerCase(); bv = (b.station_code || "").toLowerCase(); break;
      case "status":    av = a.status; bv = b.status; break;
      case "submitted": av = a.submitted_at || ""; bv = b.submitted_at || ""; break;
      case "requests":  av = a.request_count ?? 0; bv = b.request_count ?? 0; break;
      default: {
        // default: pending first, then newest decided
        const ap = a.status === "pending" ? 0 : 1;
        const bp = b.status === "pending" ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return (b.submitted_at || "").localeCompare(a.submitted_at || "");
      }
    }
    if (av < bv) return -dir;
    if (av > bv) return  dir;
    return 0;
  };
  return rows.slice().sort(cmp);
}

function _renderAvailabilityRows() {
  const wrap = document.getElementById("rr-avail-req-list");
  if (!wrap) return;

  // Reflect active sort on the toolbar buttons.  Each button's base
  // label lives in data-rr-label so toggling the ↑/↓ arrow is clean.
  document.querySelectorAll("[data-rr-sort]").forEach(b => {
    if (!b.dataset.rrLabel) b.dataset.rrLabel = b.textContent;
    const active = b.dataset.rrSort === _availSortKey;
    b.classList.toggle("active", active);
    b.textContent = active
      ? b.dataset.rrLabel + (_availSortDir === "asc" ? " ↑" : " ↓")
      : b.dataset.rrLabel;
  });

  if (_availRequestsCache.length === 0) {
    wrap.innerHTML = `
      <div class="rr-empty">
        <div class="rr-empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
        </div>
        <div class="rr-empty-title">No availability requests</div>
        <div class="rr-empty-sub">When a driver submits a change to their available days, it'll show up here for approval.</div>
      </div>`;
    return;
  }

  // Apply the driver-name search filter, then sort.
  const filtered = _availSearchTerm
    ? _availRequestsCache.filter((r) =>
        (r.driver_name || "").toLowerCase().includes(_availSearchTerm) ||
        (r.station_code || "").toLowerCase().includes(_availSearchTerm))
    : _availRequestsCache;

  if (filtered.length === 0) {
    wrap.innerHTML = `<div class="rr-empty" style="padding:32px 18px">
      <div class="rr-empty-title">No requests match "${escapeHtml(_availSearchTerm)}"</div>
      <div class="rr-empty-sub">Clear the search to see all ${_availRequestsCache.length} requests.</div>
    </div>`;
    return;
  }

  const rows = _sortAvailRows(filtered);

  wrap.innerHTML = rows.map((r) => {
    const same = JSON.stringify((r.days || []).slice().sort()) === JSON.stringify(((r.current_days || []).slice()).sort());
    const isPending  = r.status === "pending";
    const isApproved = r.status === "approved";
    const isDenied   = r.status === "denied";

    let statusPill = "";
    if (isPending)  statusPill = `<span class="status-pill status-pill-pending">Pending</span>`;
    if (isApproved) statusPill = `<span class="status-pill status-pill-approved">Approved</span>`;
    if (isDenied)   statusPill = `<span class="status-pill status-pill-denied">Denied</span>`;

    let metaLine;
    if (isPending) {
      metaLine = `submitted ${escapeHtml(_fmtRel(r.submitted_at))}`;
    } else if (isApproved) {
      // Show the full effective window — "effective through X" was
      // misleading because it hid the START date.  With the default
      // 7-day lead, approved changes don't take effect immediately;
      // the operator needs to see WHEN they kick in.
      const todayIso  = new Date().toISOString().slice(0, 10);
      const fromIso   = r.effective_from  || null;   // ISO "YYYY-MM-DD" — sorts lexically
      const untilIso  = r.effective_until || null;
      const fromLabel  = fromIso  ? _fmtAvailDateShort(fromIso)  : null;
      const untilLabel = untilIso ? _fmtAvailDateShort(untilIso) : null;
      let effPart;
      if (fromIso && fromIso <= todayIso && untilLabel) {
        effPart = `effective now through ${escapeHtml(untilLabel)}`;
      } else if (fromLabel && untilLabel) {
        effPart = `effective ${escapeHtml(fromLabel)} – ${escapeHtml(untilLabel)}`;
      } else if (fromLabel) {
        effPart = `effective ${escapeHtml(fromLabel)}`;
      } else {
        effPart = "effective date pending";
      }
      metaLine = `approved ${escapeHtml(_fmtRel(r.decided_at))} · ${effPart}`;
    } else {
      metaLine = `denied ${escapeHtml(_fmtRel(r.decided_at))}`;
    }

    const noteLine = r.decision_note
      ? `<div style="font-size:var(--fs-sm);color:var(--text-muted);margin-top:6px;font-style:italic">"${escapeHtml(r.decision_note)}"</div>`
      : "";

    const actions = isPending
      ? `<div style="display:flex;gap:var(--s-2);align-items:center">
           <button class="btn btn-sm btn-danger" data-rr-avail-deny="${escapeHtml(r.id)}">Deny</button>
           <button class="btn btn-sm btn-primary" data-rr-avail-approve="${escapeHtml(r.id)}">Approve</button>
         </div>`
      : `<div style="font-size:var(--fs-xs);color:var(--text-subtle)">—</div>`;

    let impactBlock = "";
    if (isPending && !same) {
      const im = _availImpactFor(r);
      if (im && (im.drops.length || im.adds.length)) {
        const total = _availImpactCtx?.totalActive || 0;
        const pctOf = (n) => total > 0 ? Math.round((n / total) * 100) : 0;
        const tightAny = im.drops.some(d => d.tight);
        const arrow = (before, after) => {
          if (before === after) return `${pctOf(before)}%`;
          return `${pctOf(before)}% → <strong>${pctOf(after)}%</strong>`;
        };
        const dropChips = im.drops.map(d => {
          const before = (d.after + 1); // pre-change supply
          const tight  = d.tight;
          return `<span style="display:inline-flex;align-items:center;gap:6px;background:${tight ? "rgba(220,38,38,.10)" : "var(--canvas)"};border:1px solid ${tight ? "rgba(220,38,38,.4)" : "var(--border)"};color:${tight ? "var(--red)" : "var(--text-muted)"};padding:3px 9px;border-radius:10px;font-size:var(--fs-xs);font-weight:600">
            <span>−${escapeHtml(d.label)}</span>
            <span style="font-weight:500">${arrow(before, d.after)}</span>
          </span>`;
        }).join("");
        const addChips = im.adds.map(a => {
          const before = (a.after - 1);
          return `<span style="display:inline-flex;align-items:center;gap:6px;background:var(--canvas);border:1px solid var(--border);color:var(--text-muted);padding:3px 9px;border-radius:10px;font-size:var(--fs-xs);font-weight:600">
            <span>+${escapeHtml(a.label)}</span>
            <span style="font-weight:500">${arrow(before, a.after)}</span>
          </span>`;
        }).join("");
        const verdict = tightAny
          ? `<span style="color:var(--red);font-weight:600">Coverage tight</span> — at least one dropped day would fall below peak demand.  Reach out before approving.`
          : (im.drops.length === 0
              ? `<span style="color:var(--text);font-weight:600">No dropped days.</span>  Driver is widening availability — safe to approve.`
              : `Coverage holds — every dropped day still has enough drivers for peak demand.`);
        impactBlock = `
          <div style="grid-column:1/-1;margin-top:10px;padding:10px 12px;background:var(--canvas);border-radius:8px;border:1px solid var(--border)">
            <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-subtle);letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px">If approved · coverage shift</div>
            ${(dropChips || addChips) ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px">${dropChips}${addChips}</div>` : ""}
            <div style="font-size:var(--fs-xs);color:var(--text-subtle);line-height:1.5">${verdict}</div>
          </div>`;
      }
    }

    // History context · "this is their Nth request · last change M ago".
    const reqCount = r.request_count ?? 1;
    const ordinal = (n) => {
      const s = ["th","st","nd","rd"], v = n % 100;
      return n + (s[(v - 20) % 10] || s[v] || s[0]);
    };
    let historyLine = "";
    if (reqCount > 1) {
      const prevAgo = r.prev_submitted_at ? _fmtRel(r.prev_submitted_at) : null;
      historyLine = `<div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <span style="display:inline-flex;align-items:center;gap:4px;background:var(--canvas);border:1px solid var(--border);border-radius:9px;padding:1px 7px;font-weight:600">
          ${reqCount >= 5 ? `<span style="color:var(--amber)">●</span>` : ""}${ordinal(reqCount)} request
        </span>
        ${prevAgo ? `<span>· previous change ${escapeHtml(prevAgo)}</span>` : ""}
        <button type="button" data-rr-avail-history="${escapeHtml(r.driver_id)}" data-rr-avail-history-name="${escapeHtml(r.driver_name || "")}"
                style="font:inherit;font-size:var(--fs-xs);background:none;border:0;color:var(--accent-text);cursor:pointer;text-decoration:underline;text-decoration-color:rgba(15,108,189,.3);padding:0">
          view history
        </button>
      </div>`;
    }

    return `
      <div class="avail-req-row" data-rr-req-id="${escapeHtml(r.id)}" style="padding:14px 18px;border-bottom:1px solid var(--border);display:grid;grid-template-columns:220px 1fr auto;gap:16px;align-items:start;${isPending ? "" : "background:var(--canvas)"}">
        <div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-size:var(--fs-base);font-weight:600;color:var(--text)">${escapeHtml(r.driver_name || "")}</span>
            ${statusPill}
          </div>
          <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:3px">${escapeHtml(r.station_code || "—")} · ${metaLine}</div>
          ${historyLine}
          ${noteLine}
        </div>
        <div>
          <div style="font-size:var(--fs-xs);font-weight:600;color:var(--text-subtle);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">${isApproved ? "Approved" : "Requested"}</div>
          <div>${_availDaysHtml(r.days, false)}</div>
          ${r.earliest_start ? `<div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:4px">Earliest start · ${escapeHtml(_fmtTime12(r.earliest_start) || r.earliest_start)}</div>` : ""}
          ${(isPending && !same) ? `
            <div style="font-size:var(--fs-xs);font-weight:600;color:var(--text-subtle);text-transform:uppercase;letter-spacing:.04em;margin:8px 0 4px">Currently approved</div>
            <div>${_availDaysHtml(r.current_days, true)}</div>
            ${r.current_earliest_start ? `<div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:4px">Earliest start · ${escapeHtml(_fmtTime12(r.current_earliest_start) || r.current_earliest_start)}</div>` : ""}
          ` : ""}
        </div>
        ${actions}
        ${impactBlock}
      </div>`;
  }).join("");
}

function _fmtAvailDateShort(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso + "T12:00:00");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch { return iso; }
}

// "09:30" → "9:30 AM".  Empty string for anything that isn't an HH:MM.
function _fmtTime12(hhmm) {
  if (typeof hhmm !== "string" || !/^\d{1,2}:\d{2}$/.test(hhmm)) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const ap = h < 12 ? "AM" : "PM";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, "0")} ${ap}`;
}

// <option> list for an "earliest start" picker: "Any" + 4:00 AM → 2:00 PM
// in 30-minute steps, plus the current value if it falls outside that.
function _availStartOptionsHtml(selected) {
  const sel = typeof selected === "string" ? selected : "";
  const canned = /^(0[4-9]|1[0-4]):(00|30)$/;
  let out = `<option value=""${sel ? "" : " selected"}>Any start time</option>`;
  if (sel && !canned.test(sel)) out += `<option value="${escapeHtml(sel)}" selected>${escapeHtml(_fmtTime12(sel) || sel)}</option>`;
  for (let mm = 4 * 60; mm <= 14 * 60; mm += 30) {
    const v = `${String(Math.floor(mm / 60)).padStart(2, "0")}:${String(mm % 60).padStart(2, "0")}`;
    out += `<option value="${v}"${v === sel ? " selected" : ""}>${escapeHtml(_fmtTime12(v))}</option>`;
  }
  return out;
}

// Lightweight modal showing a driver's full availability-request
// timeline.  Backed by availability_request_history (migration 0132).
// Built ad-hoc — no static HTML — since it's small + single-purpose.
async function _showAvailabilityHistory(driverId, driverName) {
  // Remove any prior instance.
  document.getElementById("rr-avail-history-modal")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "rr-avail-history-modal";
  overlay.className = "modal-backdrop open";
  overlay.style.zIndex = "90";
  overlay.innerHTML = `
    <div class="modal-card" style="max-width:560px">
      <div class="modal-head">
        <div>
          <p class="modal-title">Availability history</p>
          <p class="modal-sub">${escapeHtml(driverName)}</p>
        </div>
        <button class="modal-close" type="button" data-rr-ahist-close aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body" id="rr-ahist-body" style="max-height:60vh;overflow-y:auto">
        <div class="rr-loading">Loading history</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
  const close = () => { overlay.remove(); document.body.style.overflow = ""; };
  overlay.addEventListener("click", (e) => { if (e.target === overlay || e.target.closest("[data-rr-ahist-close]")) close(); });

  const { data, error } = await sb.rpc("availability_request_history", { p_driver_id: driverId });
  const body = document.getElementById("rr-ahist-body");
  if (!body) return;
  if (error) {
    body.innerHTML = `<div style="color:var(--red);font-size:var(--fs-sm)">Couldn't load history: ${escapeHtml(error.message)}</div>`;
    return;
  }
  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) {
    body.innerHTML = `<div style="color:var(--text-subtle);font-size:var(--fs-sm)">No availability requests on record for this driver.</div>`;
    return;
  }

  const dayLbl = { mon:"Mon", tue:"Tue", wed:"Wed", thu:"Thu", fri:"Fri", sat:"Sat", sun:"Sun" };
  const fmtDays = (arr) => (Array.isArray(arr) && arr.length) ? arr.map((k) => dayLbl[k] || k).join(", ") : "no days";
  const statusPill = (s) =>
    s === "approved" ? `<span class="status-pill status-pill-approved">Approved</span>` :
    s === "denied"   ? `<span class="status-pill status-pill-denied">Denied</span>` :
                       `<span class="status-pill status-pill-pending">Pending</span>`;

  body.innerHTML = `
    <div style="font-size:var(--fs-sm);color:var(--text-muted);margin-bottom:var(--s-3)">
      ${rows.length} request${rows.length === 1 ? "" : "s"} on record, newest first.
    </div>
    <div style="display:flex;flex-direction:column;gap:var(--s-2)">
      ${rows.map((r) => {
        const eff = (r.effective_from || r.effective_until)
          ? ` · effective ${r.effective_from ? _fmtAvailDateShort(r.effective_from) : "?"}${r.effective_until ? " – " + _fmtAvailDateShort(r.effective_until) : ""}`
          : "";
        const decided = r.decided_at ? ` · decided ${_fmtRel(r.decided_at)}` : "";
        const startTxt = r.earliest_start ? (_fmtTime12(r.earliest_start) || r.earliest_start) : "";
        return `<div style="padding:10px 12px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--surface)">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
            ${statusPill(r.status)}
            <span style="font-size:var(--fs-xs);color:var(--text-subtle)">submitted ${escapeHtml(_fmtRel(r.submitted_at))}${decided}${eff}</span>
          </div>
          <div style="font-size:var(--fs-sm);color:var(--text)">${escapeHtml(fmtDays(r.days))}${startTxt ? ` · earliest start ${escapeHtml(startTxt)}` : ""}</div>
          ${r.decision_note ? `<div style="font-size:var(--fs-xs);color:var(--text-muted);font-style:italic;margin-top:4px">"${escapeHtml(r.decision_note)}"</div>` : ""}
        </div>`;
      }).join("")}
    </div>`;
}

function _updateAvailReqBadge(count) {
  const badge = document.getElementById("rr-avail-req-badge");
  if (!badge) return;
  if (count > 0) {
    badge.textContent = String(count);
    badge.style.display = "inline-block";
  } else {
    badge.style.display = "none";
  }
}

document.addEventListener("click", async (e) => {
  // "view history" link on an availability request row → open a
  // lightweight modal with the driver's full request timeline.
  const histBtn = e.target.closest("[data-rr-avail-history]");
  if (histBtn) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const driverId   = histBtn.getAttribute("data-rr-avail-history");
    const driverName = histBtn.getAttribute("data-rr-avail-history-name") || "Driver";
    await _showAvailabilityHistory(driverId, driverName);
    return;
  }

  // Approve / deny
  const approve = e.target.closest("[data-rr-avail-approve]");
  const deny    = e.target.closest("[data-rr-avail-deny]");
  if (approve || deny) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const id = (approve || deny).getAttribute(approve ? "data-rr-avail-approve" : "data-rr-avail-deny");
    const note = deny ? (prompt("Note for the driver (optional):", "") || null) : null;
    if (deny && note === null) return;
    const btn = approve || deny;
    btn.disabled = true; btn.textContent = approve ? "Approving…" : "Denying…";
    const { error } = await sb.rpc("availability_request_decide", {
      p_request_id: id, p_approve: !!approve, p_note: note,
    });
    if (error) { toast("Failed: " + error.message, "warn"); btn.disabled = false; btn.textContent = approve ? "Approve" : "Deny"; return; }
    toast(approve ? "Approved" : "Denied", "success");
    loadAvailabilityRequests();

    // Cache invalidation · the approval RPC just wrote to
    // drivers.metadata.availability.days for the affected driver,
    // but the dashboard's roster cache + any open driver-record
    // drawer are still holding the old metadata.  Without these
    // refreshes the operator sees the new availability in the
    // approval queue (which we just reloaded) but stale data in
    // the driver record card itself — the bug reported on
    // 2026-05-09.  Denials don't touch metadata, so only refresh
    // on approve.
    if (approve) {
      if (typeof loadDriversRoster === "function") loadDriversRoster();
      if (_ddDriver?.driver?.id) {
        const { data: fresh, error: refetchErr } = await sb.rpc(
          "driver_record",
          { p_id: _ddDriver.driver.id }
        );
        if (!refetchErr && fresh) {
          _ddDriver = fresh;
          if (typeof renderDriverDrawerTab === "function") renderDriverDrawerTab();
        }
      }
    }
    return;
  }
  // Blackout delete
  const blDel = e.target.closest("[data-rr-blackout-delete]");
  if (blDel) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!confirm("Delete this blackout?")) return;
    const id = blDel.getAttribute("data-rr-blackout-delete");
    const { error } = await sb.rpc("availability_blackout_delete", { p_id: id });
    if (error) { toast("Delete failed: " + error.message, "warn"); return; }
    toast("Blackout deleted", "success");
    loadAvailabilityRequests();
    return;
  }
});

async function loadCoachingFeed() {
  const wrap = document.getElementById("rr-coach-feed");
  if (!wrap) return;
  wrap.innerHTML = `<div class="rr-loading">Loading</div>`;

  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;

  const [coachRes, drvRes] = await Promise.all([
    sb.from("coachings")
      .select("*")
      .eq("dsp_id", dspId)
      .order("occurred_at", { ascending: false })
      .limit(500),
    sb.from("drivers")
      .select("id, full_name, preferred_name, station:stations(code)")
      .eq("dsp_id", dspId),
  ]);
  if (coachRes.error) {
    wrap.innerHTML = `<div style="padding:24px;color:var(--red);font-size:var(--fs-md)">Could not load coachings: ${escapeHtml(coachRes.error.message)}</div>`;
    return;
  }
  const drvById = new Map((drvRes.data || []).map(d => [d.id, d]));
  _coachFeedCache = { rows: coachRes.data || [], drivers: drvById };

  // Update the subnav badge (open follow-ups)
  const openFollowups = (coachRes.data || []).filter(c => c.follow_up_at && !c.resolved_at && !c.archived_at).length;
  const badge = document.getElementById("rr-coach-feed-badge");
  if (badge) {
    if (openFollowups > 0) { badge.style.display = ""; badge.textContent = String(openFollowups); }
    else badge.style.display = "none";
  }

  _renderCoachFeed();
}

// Click-to-sort state for the coaching table.  Default newest first.
let _coachSort = { col: "date", dir: "desc" };

function _renderCoachFeed() {
  const wrap = document.getElementById("rr-coach-feed");
  if (!wrap || !_coachFeedCache) return;

  const search = (document.getElementById("rr-coach-search")?.value || "").toLowerCase().trim();
  let rows = _coachFeedCache.rows.slice().filter(c => !c.archived_at);

  if (search) {
    rows = rows.filter(c => {
      const drv = _coachFeedCache.drivers.get(c.driver_id);
      const name = drv ? (drv.preferred_name || drv.full_name || "").toLowerCase() : "";
      return (
        (c.summary || "").toLowerCase().includes(search) ||
        (c.notes || "").toLowerCase().includes(search) ||
        name.includes(search) ||
        (c.coached_by_name || "").toLowerCase().includes(search)
      );
    });
  }

  // Sort by clicked column.
  const driverNameOf = (c) => {
    const drv = _coachFeedCache.drivers.get(c.driver_id);
    return drv ? (drv.preferred_name || drv.full_name || "") : "";
  };
  const cmp = (a, b) => {
    let av, bv;
    switch (_coachSort.col) {
      case "date":     av = new Date(a.occurred_at).getTime(); bv = new Date(b.occurred_at).getTime(); break;
      case "driver":   av = driverNameOf(a).toLowerCase(); bv = driverNameOf(b).toLowerCase(); break;
      case "severity": av = _COACH_SEV_RANK[a.severity] ?? 9; bv = _COACH_SEV_RANK[b.severity] ?? 9; break;
      case "topic":    av = (a.topic || "").toLowerCase(); bv = (b.topic || "").toLowerCase(); break;
      case "coach":    av = (a.coached_by_name || "").toLowerCase(); bv = (b.coached_by_name || "").toLowerCase(); break;
      case "followup": av = a.follow_up_at ? new Date(a.follow_up_at).getTime() : Infinity;
                       bv = b.follow_up_at ? new Date(b.follow_up_at).getTime() : Infinity; break;
      case "status":   av = a.archived_at ? 2 : (a.resolved_at ? 1 : 0); bv = b.archived_at ? 2 : (b.resolved_at ? 1 : 0); break;
      default: return 0;
    }
    if (av < bv) return _coachSort.dir === "asc" ? -1 : 1;
    if (av > bv) return _coachSort.dir === "asc" ? 1 : -1;
    return 0;
  };
  rows.sort(cmp);

  if (rows.length === 0) {
    wrap.innerHTML = `<div class="rr-empty-inline">No coachings match the current filter.</div>`;
    return;
  }

  const caret = (col) => {
    if (_coachSort.col !== col) return "";
    return _coachSort.dir === "asc"
      ? ' <span style="font-size:9px">▲</span>'
      : ' <span style="font-size:9px">▼</span>';
  };
  const th = (col, label) =>
    `<th data-rr-coach-sort="${col}" style="text-align:left;padding:10px 14px;font-size:var(--fs-xs);font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted);cursor:pointer;user-select:none">${label}${caret(col)}</th>`;

  const head = `<thead><tr style="background:var(--canvas);border-bottom:1px solid var(--border)">
    ${th("date",     "Date")}
    ${th("driver",   "Driver")}
    ${th("severity", "Severity")}
    ${th("topic",    "Topic")}
    <th style="text-align:left;padding:10px 14px;font-size:var(--fs-xs);font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Summary</th>
    ${th("coach",    "Coached by")}
    ${th("followup", "Follow-up")}
    ${th("status",   "Status")}
  </tr></thead>`;

  const body = rows.map(c => {
    const drv = _coachFeedCache.drivers.get(c.driver_id);
    const name = drv ? (drv.preferred_name || drv.full_name || "—") : "—";
    const sevChip = _coachSeverityChip(c.severity, c.metadata?.level);
    const occurred = new Date(c.occurred_at).toLocaleDateString();
    const followCell = c.follow_up_at
      ? (c.resolved_at
          ? `<span style="font-size:var(--fs-xs);color:var(--green)">Resolved</span>`
          : `<span style="font-size:var(--fs-xs);color:${new Date(c.follow_up_at) < new Date() ? "var(--red)" : "var(--accent-text)"}">${new Date(c.follow_up_at).toLocaleDateString()}</span>`)
      : `<span style="color:var(--text-subtle)">—</span>`;
    const ack = c.acknowledgment && c.acknowledgment !== "none"
      ? `<span class="status-pill status-pill-acknowledged">Ack</span>`
      : (c.driver_visible ? `<span class="status-pill status-pill-pending">Pending ack</span>` : "");
    const status = c.archived_at
      ? `<span style="font-size:var(--fs-xs);color:var(--text-subtle)">Archived</span>`
      : (c.resolved_at
          ? `<span style="font-size:var(--fs-xs);color:var(--green)">Resolved</span>`
          : ack || `<span style="font-size:var(--fs-xs);color:var(--text-subtle)">Open</span>`);

    return `<tr style="border-top:1px solid var(--border);cursor:pointer" data-rr-coach-feed-driver="${c.driver_id}">
      <td style="padding:10px 14px;font-size:var(--fs-sm);font-variant-numeric:tabular-nums;color:var(--text-muted)">${escapeHtml(occurred)}</td>
      <td style="padding:10px 14px"><strong>${escapeHtml(name)}</strong>${drv?.station?.code ? `<div style="font-size:var(--fs-xs);color:var(--text-subtle)">${escapeHtml(drv.station.code)}</div>` : ""}</td>
      <td style="padding:10px 14px">${sevChip}</td>
      <td style="padding:10px 14px;font-size:var(--fs-sm);text-transform:capitalize">${escapeHtml(c.topic || "")}</td>
      <td style="padding:10px 14px;font-size:var(--fs-md);max-width:320px">${escapeHtml(c.summary || c.notes?.slice(0, 80) || "—")}</td>
      <td style="padding:10px 14px;font-size:var(--fs-sm);color:var(--text-muted)">${escapeHtml(c.coached_by_name || "—")}</td>
      <td style="padding:10px 14px">${followCell}</td>
      <td style="padding:10px 14px">${status}</td>
    </tr>`;
  }).join("");

  wrap.innerHTML = `<table style="width:100%;border-collapse:collapse">${head}<tbody>${body}</tbody></table>`;
}

document.addEventListener("input", (e) => {
  if (e.target.id === "rr-coach-search") _renderCoachFeed();
});

// Click any sortable header to toggle direction (or set new column at
// its default direction). Keeps the same pattern as the Drivers Roster
// + Attendance Report tables.
document.addEventListener("click", (e) => {
  const th = e.target.closest("[data-rr-coach-sort]");
  if (!th) return;
  const col = th.dataset.rrCoachSort;
  if (_coachSort.col === col) {
    _coachSort.dir = _coachSort.dir === "asc" ? "desc" : "asc";
  } else {
    _coachSort.col = col;
    // Sensible defaults: dates desc (newest first), text asc.
    _coachSort.dir = (col === "date" || col === "followup" || col === "severity" || col === "status") ? "desc" : "asc";
  }
  _renderCoachFeed();
});


// Toggle now saves immediately — no separate Save button. The textarea
// (prompt) and number input (max seconds) persist on blur/change so
// nothing is lost when the operator switches contexts.
document.addEventListener("click", async (e) => {
  const tgBtn = e.target.closest("[data-rr-video-toggle]");
  if (!tgBtn) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  tgBtn.classList.toggle("on");
  await saveVideoScreeningSettings();
}, true);

document.addEventListener("change", async (e) => {
  if (e.target.id === "rr-video-max-seconds") {
    await saveVideoScreeningSettings();
  }
});

document.addEventListener("blur", async (e) => {
  if (e.target.id === "rr-video-prompt") {
    await saveVideoScreeningSettings();
  }
}, true);


// ─── Messages tab ─────────────────────────────────────────────────────────
//
// Lists every message_templates row for the DSP, grouped by trigger.
// Operator can edit subject/body. Tokens like {{first_name}} / {{link}}
// stay as-is in the text and the render_template SQL substitutes them
// at send time. Attachments are deferred to a follow-up.

const RR_TEMPLATE_LABELS = {
  "applicant.invite_screening": "Screening invitation",
  "applicant.invite_interview": "Interview booking",
  "applicant.invite_orientation": "Orientation booking",
  "applicant.outcome_hired": "Hired notice",
  "applicant.outcome_no_hire": "Not-hired notice",
  "applicant.outcome_no_show": "No-show notice",
  "applicant.decline": "Decline notice",
  "driver.referral_invite": "Driver referral invite",
};

async function loadMessagesTab() {
  const list = document.getElementById("rr-messages-list");
  if (!list) return;

  const { data: rows, error } = await sb.from("message_templates")
    .select("id, channel, key, name, subject, body, active")
    .eq("dsp_id", window.RR.dsp.id)
    .order("key", { ascending: true })
    .order("channel", { ascending: true });

  if (error) {
    list.innerHTML = `<div style="padding:24px;color:var(--red);font-size:var(--fs-md)">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!rows || rows.length === 0) {
    list.innerHTML = `<div class="rr-empty-inline">No templates yet.</div>`;
    return;
  }

  list.innerHTML = rows.map(renderMessageRow).join("");
}

function renderMessageRow(t) {
  const label = RR_TEMPLATE_LABELS[t.key] || t.key;
  const preview = (t.subject || t.body || "").replace(/\s+/g, " ").trim();
  return `
    <div class="msg-row" data-template-id="${t.id}">
      <div>
        <div class="msg-row-label">${escapeHtml(label)}</div>
        <div class="msg-row-sub">${escapeHtml(t.key)}</div>
      </div>
      <div><span class="msg-channel-pill ${t.channel}">${t.channel}</span></div>
      <div class="msg-body-preview" title="${escapeHtml(preview)}">${escapeHtml(preview)}</div>
      <div style="text-align:right">
        <button class="btn btn-sm" data-rr-edit-template="${t.id}">Edit</button>
      </div>
    </div>`;
}

function openMessageEditor(template) {
  const t = template;
  const isEmail = t.channel === "email";
  // Local working copy of the attachments array — lets the operator
  // upload + remove files before saving.
  let attachments = Array.isArray(t.attachments) ? [...t.attachments] : [];

  let m = document.getElementById("rr-msg-modal");
  if (m) m.remove();
  m = document.createElement("div");
  m.id = "rr-msg-modal";
  m.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px";

  function attachmentsHtml() {
    if (attachments.length === 0) {
      return `<div style="font-size:var(--fs-sm);color:var(--text-subtle);padding:8px 0">No attachments yet.</div>`;
    }
    return attachments.map((a, i) => `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;background:var(--canvas);border:1px solid var(--border);border-radius:8px;margin-top:6px">
        <div style="min-width:0">
          <div style="font-size:var(--fs-sm);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(a.name || "attachment")}</div>
          <div style="font-size:var(--fs-xs);color:var(--text-subtle)">${a.content_type || ""} · ${a.size ? Math.round(a.size/1024)+" KB" : ""}</div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <a class="btn btn-sm" href="${a.url}" target="_blank" rel="noreferrer">Open</a>
          <button class="btn btn-sm" data-rr-att-remove="${i}" style="color:var(--red)">Remove</button>
        </div>
      </div>`).join("");
  }
  function rerenderAttachments() {
    const wrap = m.querySelector("[data-rr-att-list]");
    if (wrap) wrap.innerHTML = attachmentsHtml();
  }

  m.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;max-width:640px;width:100%;max-height:90vh;overflow:auto">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div>
          <h3 style="margin:0;font-size:var(--fs-lg);font-weight:600">${escapeHtml(RR_TEMPLATE_LABELS[t.key] || t.key)}</h3>
          <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">${escapeHtml(t.key)} · ${t.channel}</div>
        </div>
        <button data-rr-msg-cancel style="background:none;border:0;font-size:20px;cursor:pointer;color:var(--text-muted)">×</button>
      </div>

      ${isEmail ? `
        <label style="display:block;font-size:var(--fs-xs);font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Subject</label>
        <input data-rr-msg-subject class="form-input" style="width:100%;margin-bottom:14px" value="${escapeHtml(t.subject || "")}" />
      ` : ""}

      <label style="display:block;font-size:var(--fs-xs);font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Body</label>
      <textarea data-rr-msg-body class="form-input" style="width:100%;min-height:160px;font-family:'SF Mono',Menlo,monospace;font-size:var(--fs-md);line-height:1.5">${escapeHtml(t.body || "")}</textarea>
      <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:6px;line-height:1.5">
        Tokens: <code>{{first_name}}</code> · <code>{{link}}</code>. Paste any URL into the body — applicants tap it directly.
        ${!isEmail ? `<br/><strong style="color:var(--text-muted)">Keep SMS under 160 chars when possible</strong> — longer messages split into multiple texts.` : ""}
      </div>

      <div style="margin-top:18px">
        <label style="display:block;font-size:var(--fs-xs);font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Attachments</label>
        <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-bottom:8px">
          ${isEmail
            ? `Email attachments are sent as files (Resend fetches the URL)`
            : `SMS attachments turn the text into MMS — Twilio fetches each file. Up to 10 per message.`}
        </div>
        <div data-rr-att-list>${attachmentsHtml()}</div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:10px">
          <input type="file" data-rr-att-file />
          <button class="btn btn-sm" data-rr-att-upload>Upload</button>
        </div>
      </div>

      <label style="display:flex;align-items:center;gap:10px;margin:18px 0 4px"><input type="checkbox" data-rr-msg-active ${t.active !== false ? "checked" : ""}/>Active (used for outgoing sends)</label>

      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px">
        <button class="btn" data-rr-msg-cancel>Cancel</button>
        <button class="btn btn-primary" data-rr-msg-save>Save</button>
      </div>
    </div>`;
  document.body.appendChild(m);

  m.addEventListener("click", async (e) => {
    if (e.target.closest("[data-rr-msg-cancel]")) { m.remove(); return; }

    const removeBtn = e.target.closest("[data-rr-att-remove]");
    if (removeBtn) {
      const idx = parseInt(removeBtn.getAttribute("data-rr-att-remove"), 10);
      attachments.splice(idx, 1);
      rerenderAttachments();
      return;
    }

    if (e.target.closest("[data-rr-att-upload]")) {
      const input = m.querySelector("[data-rr-att-file]");
      const file = input?.files?.[0];
      if (!file) { toast("Choose a file first", "warn"); return; }
      const path = `${window.RR.dsp.id}/${t.id}/${Date.now()}-${file.name}`;
      const { error: upErr } = await sb.storage.from("message-attachments").upload(path, file, {
        contentType: file.type, upsert: false,
      });
      if (upErr) { toast("Upload failed: " + upErr.message, "warn"); return; }
      const { data: pub } = sb.storage.from("message-attachments").getPublicUrl(path);
      attachments.push({
        name: file.name, url: pub.publicUrl,
        content_type: file.type, size: file.size,
      });
      input.value = "";
      rerenderAttachments();
      toast("Attachment uploaded", "success");
      return;
    }

    if (e.target.closest("[data-rr-msg-save]")) {
      const body = m.querySelector("[data-rr-msg-body]").value;
      if (!body.trim()) { toast("Body is required", "warn"); return; }
      const subject = isEmail ? m.querySelector("[data-rr-msg-subject]").value : t.subject;
      const active = m.querySelector("[data-rr-msg-active]").checked;
      const { error } = await sb.from("message_templates")
        .update({ body, subject, active, attachments })
        .eq("id", t.id);
      if (error) { toast("Save failed: " + error.message, "warn"); return; }
      m.remove();
      toast("Template saved", "success");
      await loadMessagesTab();
    }
  });
}

// Capture-phase delegate for the message-template Edit button.
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-rr-edit-template]");
  if (!btn) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const id = btn.getAttribute("data-rr-edit-template");
  const { data: t, error } = await sb.from("message_templates").select("*").eq("id", id).single();
  if (error) { toast("Couldn't load template", "warn"); return; }
  openMessageEditor(t);
}, true);


// ─── Boot: if pipeline view is the default, populate immediately ──────────
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { loadPipeline("all"); loadPipelineKpis(); });
} else {
  loadPipeline("all");
  loadPipelineKpis();
}


// ─── Live freshness: Realtime + window focus + interval ──────────────────
//
// Three layers so the operator never has to F5 to see new data:
//
//   1. Supabase Realtime channel — pushed updates from postgres on
//      tables enabled in the supabase_realtime publication (0024).
//      Debounced so a burst of writes doesn't hammer the renders.
//   2. window 'focus' — when the operator tabs back in.
//   3. setInterval — every 30s as a safety net for the rare case
//      Realtime drops (websocket disconnect).

function refreshActiveView() {
  const activeView = document.querySelector(".view.active")?.id || "";
  if (activeView === "view-pipeline") {
    const sub = document.querySelector("#view-pipeline .pipe-subview.active, #view-pipeline .pipe-subview[style*='display: \"\"']")?.id || "pipe-sub-funnel";
    if (sub === "pipe-sub-funnel" || !sub) {
      loadPipeline(getActiveStage());
      loadPipelineKpis();
    } else if (sub === "pipe-sub-interview")  loadInterviewDay();
    else if (sub === "pipe-sub-calendar")     loadCalendarTab();
  } else if (activeView === "view-drivers") {
    const subActive = document.querySelector(".dr-subview.active")?.id;
    if (subActive === "dr-sub-licenses") loadDriverLicensesView();
    else loadDriversRoster();
  }
}

let _refreshDebounce = null;
function scheduleRefresh() {
  clearTimeout(_refreshDebounce);
  _refreshDebounce = setTimeout(refreshActiveView, 600);
}

// ─── Cmd+K thread quick-switcher ─────────────────────────────────────────
//
// Linear / Slack-style command palette scoped to the Messages view.
// Cmd+K (Ctrl+K on Linux/Windows) opens an overlay with the
// conversation list pre-loaded; typing filters it; ↑/↓ navigate;
// Enter opens the highlighted thread; Esc closes.
//
// Pulls from the in-memory _msgInboxList that the existing
// refreshDriverChatList already keeps fresh, so the palette is
// instant — no extra RPC, no skeleton flash.

let _cmdkSelectedIdx = 0;
let _cmdkLastQuery = "";

function _cmdkFiltered(q) {
  const list = Array.isArray(_msgInboxList) ? _msgInboxList : [];
  if (!q) return list.slice(0, 50);
  const needle = q.toLowerCase();
  return list.filter((t) => {
    const name = (t.name || "").toLowerCase();
    const code = (t.station_code || "").toLowerCase();
    const body = (t.last_message?.body || "").toLowerCase();
    return name.includes(needle) || code.includes(needle) || body.includes(needle);
  }).slice(0, 50);
}

function _cmdkRender() {
  const root = document.getElementById("rr-cmdk-root");
  if (!root) return;
  const input = document.getElementById("rr-cmdk-input");
  const q = (input?.value || "").trim();
  const rows = _cmdkFiltered(q);
  if (_cmdkSelectedIdx >= rows.length) _cmdkSelectedIdx = Math.max(0, rows.length - 1);
  const list = document.getElementById("rr-cmdk-list");
  if (!list) return;
  if (rows.length === 0) {
    list.innerHTML = `<div class="rr-cmdk-empty">No threads match "${escapeHtml(q)}"</div>`;
    return;
  }
  list.innerHTML = rows.map((t, i) => {
    const initials = (t.name || "").split(/\s+/).map(p => p[0]).filter(Boolean).slice(0,2).join("").toUpperCase() || "?";
    const lastBody = t.last_message?.body
      ? (t.last_message.sender_kind === "dispatch" ? "You: " : "") + t.last_message.body
      : "No messages yet";
    const trunc = lastBody.length > 70 ? lastBody.slice(0, 67) + "…" : lastBody;
    return `<div class="rr-cmdk-row ${i === _cmdkSelectedIdx ? "active" : ""}" data-rr-cmdk-row="${i}" data-rr-driver-id="${escapeHtml(t.driver_id)}">
      <div class="rr-cmdk-avatar">${escapeHtml(initials)}</div>
      <div class="rr-cmdk-meta">
        <div class="rr-cmdk-name">${escapeHtml(t.name)}${t.station_code ? `<span class="rr-cmdk-code">${escapeHtml(t.station_code)}</span>` : ""}</div>
        <div class="rr-cmdk-preview">${escapeHtml(trunc)}</div>
      </div>
      ${t.unread > 0 ? `<div class="rr-cmdk-unread">${t.unread}</div>` : ""}
    </div>`;
  }).join("");
  // Wire row clicks (full row, not just inner text — palette feels
  // crisper with hit-area covering whole row).
  list.querySelectorAll("[data-rr-cmdk-row]").forEach((el) => {
    el.addEventListener("mouseenter", () => {
      _cmdkSelectedIdx = parseInt(el.getAttribute("data-rr-cmdk-row"), 10);
      _cmdkUpdateActive();
    });
    el.addEventListener("click", () => _cmdkPick(el.getAttribute("data-rr-driver-id")));
  });
  // Scroll the active row into view.
  const active = list.querySelector(".rr-cmdk-row.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function _cmdkUpdateActive() {
  const list = document.getElementById("rr-cmdk-list");
  if (!list) return;
  list.querySelectorAll(".rr-cmdk-row").forEach((el, i) => {
    el.classList.toggle("active", i === _cmdkSelectedIdx);
  });
  const active = list.querySelector(".rr-cmdk-row.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function _cmdkPick(driverId) {
  if (!driverId) return;
  _cmdkClose();
  // Make sure we're on Messages — Cmd+K is bound globally so the
  // shortcut might be hit from any view.
  if (typeof goto === "function") goto("messages");
  setTimeout(() => openDriverChatThread(driverId), 0);
}

function _cmdkOpen() {
  // Build the root if it isn't there yet.
  let root = document.getElementById("rr-cmdk-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "rr-cmdk-root";
    root.className = "rr-cmdk";
    root.innerHTML = `
      <div class="rr-cmdk-backdrop"></div>
      <div class="rr-cmdk-panel" role="dialog" aria-label="Quick switcher">
        <div class="rr-cmdk-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input id="rr-cmdk-input" type="text" placeholder="Jump to a driver thread…" autocomplete="off" spellcheck="false">
          <kbd class="rr-cmdk-hint">Esc</kbd>
        </div>
        <div id="rr-cmdk-list" class="rr-cmdk-list"></div>
        <div class="rr-cmdk-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>`;
    document.body.appendChild(root);
    root.querySelector(".rr-cmdk-backdrop").addEventListener("click", _cmdkClose);
    const input = root.querySelector("#rr-cmdk-input");
    input.addEventListener("input", () => { _cmdkSelectedIdx = 0; _cmdkRender(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        _cmdkSelectedIdx = Math.min(_cmdkSelectedIdx + 1, _cmdkFiltered(input.value).length - 1);
        _cmdkUpdateActive();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        _cmdkSelectedIdx = Math.max(0, _cmdkSelectedIdx - 1);
        _cmdkUpdateActive();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const rows = _cmdkFiltered(input.value);
        const pick = rows[_cmdkSelectedIdx];
        if (pick?.driver_id) _cmdkPick(pick.driver_id);
      } else if (e.key === "Escape") {
        _cmdkClose();
      }
    });
  }
  // Reset state, populate, focus.
  const input = document.getElementById("rr-cmdk-input");
  input.value = _cmdkLastQuery;
  _cmdkSelectedIdx = 0;
  root.classList.add("open");
  document.body.classList.add("rr-cmdk-open");
  // Defer the render until after open class triggers transition so
  // the list appears with the panel rather than after.
  requestAnimationFrame(() => {
    _cmdkRender();
    input.focus();
    input.select();
  });
  // Pre-warm the list if it's empty (operator hit Cmd+K before
  // visiting Messages this session).
  if (!Array.isArray(_msgInboxList) || _msgInboxList.length === 0) {
    if (typeof refreshDriverChatList === "function") {
      refreshDriverChatList(false).then(() => _cmdkRender());
    }
  }
}

function _cmdkClose() {
  const root = document.getElementById("rr-cmdk-root");
  if (!root) return;
  const input = document.getElementById("rr-cmdk-input");
  if (input) _cmdkLastQuery = input.value;
  root.classList.remove("open");
  document.body.classList.remove("rr-cmdk-open");
}

// Global keyboard binding — Cmd+K on Mac, Ctrl+K on Windows/Linux.
// Captured on the window so it works regardless of focus.
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    if (document.getElementById("rr-cmdk-root")?.classList.contains("open")) {
      _cmdkClose();
    } else {
      _cmdkOpen();
    }
  }
});


// ─── Presence + typing indicators ────────────────────────────────────────
//
// One Supabase Realtime channel per DSP carries two things:
//   1. Presence — drivers / dispatchers track themselves on join, untrack
//      on close.  The dispatcher uses the merged presence map to paint
//      the online dot on the Messages list and beside the open thread's
//      avatar.
//   2. Broadcast typing pings — when a driver types in their dispatch
//      chat, they send a tiny { type: "typing", from: driverId } event;
//      the dispatcher renders "X is typing…" above the composer for the
//      open thread (cleared after 4s of silence).  Dispatcher sends
//      mirror events so the driver app can show the same.
//
// Broadcast keeps these signals OFF the database — they're ephemeral
// and don't deserve a write per keystroke.

const _presence = {
  channel: null,
  online: new Set(),  // driver IDs currently online in this DSP
  typingByDriver: new Map(),  // driverId -> timeoutId
  lastBroadcast: 0,
};

function _presencePaintList() {
  // Update the .online class on each conversation row.  The presence
  // dot element is already in the DOM (built by refreshDriverChatList);
  // here we just toggle the modifier class.
  document.querySelectorAll("#rr-msg-driver-list .msg-item").forEach((row) => {
    const id = row.getAttribute("data-rr-driver-id");
    const dot = row.querySelector(".msg-item-presence");
    if (!dot) return;
    dot.classList.toggle("online", _presence.online.has(id));
  });
}

function _presencePaintThreadHead(driverId) {
  // Decorate the open thread's header avatar with an online ring + a
  // subtle "online" sub-line.  Uses the same .online class as the list.
  const head = document.querySelector(".rr-mc-head[data-rr-driver-id]");
  if (!head) return;
  const isOpen = head.getAttribute("data-rr-driver-id") === driverId;
  if (!isOpen) return;
  const sub = head.querySelector(".rr-mc-sub");
  if (sub) {
    if (_presence.online.has(driverId)) {
      sub.innerHTML = `<span class="rr-mc-online-pip"></span> Online`;
    } else {
      sub.textContent = "Driver chat";
    }
  }
}

function _presenceShowTyping(driverId) {
  // Show "X is typing…" inside the open thread's composer area.  Pulled
  // out as a function so the same indicator works whether the typing
  // event arrived before or after the thread opened.
  const head = document.querySelector(".rr-mc-head[data-rr-driver-id]");
  if (!head || head.getAttribute("data-rr-driver-id") !== driverId) return;
  let pill = document.getElementById("rr-mc-typing");
  if (!pill) {
    const composer = document.getElementById("rr-mc-form");
    if (!composer) return;
    pill = document.createElement("div");
    pill.id = "rr-mc-typing";
    pill.className = "rr-mc-typing";
    pill.innerHTML = `
      <span class="rr-mc-typing-dots"><span></span><span></span><span></span></span>
      <span class="rr-mc-typing-label">typing…</span>`;
    composer.parentNode.insertBefore(pill, composer);
  }
  pill.classList.add("show");
  // Clear 4s after the last typing event.
  clearTimeout(_presence.typingByDriver.get(driverId));
  _presence.typingByDriver.set(driverId, setTimeout(() => {
    const el = document.getElementById("rr-mc-typing");
    if (el) el.classList.remove("show");
  }, 4000));
}

function _presenceWire() {
  const dspId  = window.RR?.dsp?.id;
  const userId = window.RR?.user?.id;
  if (!dspId || !userId) return;
  if (_presence.channel) return; // already wired
  const channel = sb.channel("rr-presence-dsp-" + dspId, {
    config: { presence: { key: "dispatch:" + userId } },
  });

  channel
    .on("presence", { event: "sync" }, () => {
      const state = channel.presenceState();
      _presence.online = new Set();
      Object.values(state).flat().forEach((entry) => {
        if (entry?.kind === "driver" && entry?.id) _presence.online.add(entry.id);
      });
      _presencePaintList();
      if (_msgInboxSelectedId) _presencePaintThreadHead(_msgInboxSelectedId);
    })
    .on("broadcast", { event: "typing" }, ({ payload }) => {
      if (!payload || payload.from_kind !== "driver") return;
      // Only act on typing events from a driver in our DSP.
      _presenceShowTyping(payload.from);
    })
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel.track({ kind: "dispatch", id: userId, online_at: new Date().toISOString() });
      }
    });

  _presence.channel = channel;

  // Untrack when leaving the page so the green dot disappears for
  // drivers within ~1s of dispatcher closing the tab.
  window.addEventListener("beforeunload", () => {
    try { channel.untrack(); sb.removeChannel(channel); } catch {}
  });
}

// Broadcast a typing event from the dispatcher.  Throttled so we send
// at most one event every 1500ms during a typing burst.
function _presenceBroadcastTyping(toDriverId) {
  if (!_presence.channel) return;
  const now = Date.now();
  if (now - _presence.lastBroadcast < 1500) return;
  _presence.lastBroadcast = now;
  try {
    _presence.channel.send({
      type: "broadcast",
      event: "typing",
      payload: { from: window.RR?.user?.id, from_kind: "dispatch", to: toDriverId, ts: now },
    });
  } catch {}
}

// Wire on first appearance — RR is ready by the time live.js runs.
setTimeout(_presenceWire, 0);

// Targeted handler for inbound chat events.  We don't want to bounce
// the entire view on every keystroke from a driver, so this debounces
// to ~250ms and only fires the chat-specific refreshers when the
// Messages view is the active one.  When the thread for the new
// message is currently open, refreshDriverChatThread re-renders with
// smart-scroll so the operator stays anchored if they're reading
// history.
let _chatRealtimeDebounce = null;
function scheduleChatRealtime(payload) {
  clearTimeout(_chatRealtimeDebounce);
  _chatRealtimeDebounce = setTimeout(() => {
    if (!document.getElementById("view-messages")?.classList.contains("active")) return;
    // List always refreshes (it shows last-message + unread counts).
    if (typeof refreshDriverChatList === "function") refreshDriverChatList(false);
    // Thread only refreshes if the event matches the open thread.
    const newRow = payload?.new || payload?.record || {};
    const driverId = newRow.driver_id;
    if (driverId && _msgInboxSelectedId === driverId) {
      refreshDriverChatThread(false);
    }
  }, 250);
}

// Realtime subscriptions — one channel covers all the tables we care about.
sb.channel("rr-dashboard")
  .on("postgres_changes", { event: "*", schema: "public", table: "applicants" },              scheduleRefresh)
  .on("postgres_changes", { event: "*", schema: "public", table: "cal_events" },              scheduleRefresh)
  .on("postgres_changes", { event: "*", schema: "public", table: "sms_messages" },            scheduleRefresh)
  .on("postgres_changes", { event: "*", schema: "public", table: "email_messages" },          scheduleRefresh)
  .on("postgres_changes", { event: "*", schema: "public", table: "interview_outcomes" },      scheduleRefresh)
  .on("postgres_changes", { event: "*", schema: "public", table: "interview_days" },          scheduleRefresh)
  .on("postgres_changes", { event: "*", schema: "public", table: "drivers" },                 scheduleRefresh)
  .on("postgres_changes", { event: "*", schema: "public", table: "coachings" },               scheduleRefresh)
  .on("postgres_changes", { event: "*", schema: "public", table: "driver_documents" },        scheduleRefresh)
  // Chat tables get the targeted handler — sub-second delivery for
  // the active thread without re-rendering unrelated views.
  .on("postgres_changes", { event: "INSERT", schema: "public", table: "driver_messages" },         scheduleChatRealtime)
  .on("postgres_changes", { event: "UPDATE", schema: "public", table: "driver_messages" },         scheduleChatRealtime)
  .on("postgres_changes", { event: "INSERT", schema: "public", table: "driver_channel_messages" }, scheduleChatRealtime)
  .subscribe();

window.addEventListener("focus", refreshActiveView);
setInterval(refreshActiveView, 30 * 1000);


// ─── Drag-to-reorder sidebar nav ─────────────────────────────────────────
//
// HTML5 drag-and-drop on .nav-item buttons. Final order saved to
// localStorage (per-user) and re-applied on every page load.

const RR_NAV_ORDER_KEY = "rr-nav-order-v1";

function applyStoredNavOrder() {
  const raw = localStorage.getItem(RR_NAV_ORDER_KEY);
  if (!raw) return;
  let order;
  try { order = JSON.parse(raw); } catch { return; }
  if (!Array.isArray(order)) return;

  // Scope strictly to the sidebar so we don't accidentally reach into
  // settings <nav> or some other future nav element.
  const nav = document.querySelector(".sidebar .nav, .sidebar nav");
  if (!nav) return;

  const items = Array.from(nav.querySelectorAll(".nav-item[data-view]"));
  const byView = new Map(items.map(el => [el.getAttribute("data-view"), el]));

  // Defensive: if the stored order is missing any view that currently
  // exists in source, the nav was edited (a new sidebar item shipped)
  // since the order was saved.  Don't partially apply the stale order
  // — that's how items like Messages went visually missing when the
  // sidebar was drag-reordered before that sidebar item shipped.
  // Reset and let the source order win until the operator drags again.
  for (const view of byView.keys()) {
    if (!order.includes(view)) {
      localStorage.removeItem(RR_NAV_ORDER_KEY);
      return;
    }
  }

  for (const view of order) {
    const el = byView.get(view);
    if (el) nav.appendChild(el);
  }
}

function persistNavOrder() {
  const items = document.querySelectorAll(".nav-item[data-view]");
  const order = [...items].map(el => el.getAttribute("data-view"));
  localStorage.setItem(RR_NAV_ORDER_KEY, JSON.stringify(order));
}

function wireSidebarDrag() {
  const items = document.querySelectorAll(".nav-item[data-view]");
  if (items.length === 0) return;
  let dragged = null;

  items.forEach((el) => {
    el.setAttribute("draggable", "true");
    el.style.cursor = "grab";

    el.addEventListener("dragstart", (e) => {
      dragged = el;
      el.style.opacity = "0.4";
      e.dataTransfer.effectAllowed = "move";
      // Required for Firefox to fire the drag.
      try { e.dataTransfer.setData("text/plain", el.getAttribute("data-view") || ""); } catch { /* */ }
    });

    el.addEventListener("dragend", () => {
      el.style.opacity = "";
      dragged = null;
      persistNavOrder();
    });

    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!dragged || dragged === el) return;
      const rect = el.getBoundingClientRect();
      const before = (e.clientY - rect.top) < (rect.height / 2);
      el.parentNode.insertBefore(dragged, before ? el : el.nextSibling);
    });
  });
}

applyStoredNavOrder();
wireSidebarDrag();

// Initial load: if the dashboard is the active view at boot, populate
// the tasks card AND the Today's Plan body.  Without the loadTodayPlan
// kick the page sat on the static "Loading today's plan…" placeholder
// until the operator clicked the Today nav explicitly.
if (document.querySelector(".view.active")?.id === "view-dashboard") {
  setTimeout(() => {
    loadDashboardTasks?.();
    loadDashboardWeather?.();
    if (typeof loadTodayPlan === "function") loadTodayPlan();
  }, 0);
}

// Inline runtime styles for live-rendered surfaces.
const _styleEl = document.createElement("style");
_styleEl.textContent = `
[data-rr-pool-shift]{cursor:grab}
[data-rr-pool-shift]:hover{box-shadow:0 1px 4px rgba(0,0,0,.06);transform:translateY(-1px)}
[data-rr-pool-shift].rr-dragging{opacity:.5}
.cal-cell.rr-drop-active{background:var(--accent-soft) !important;outline:2px dashed var(--accent);outline-offset:-2px}
/* Slim, subtle scrollbar on the Open Shifts pool so it doesn't read as a 'gray band' */
aside.driver-pool { scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }
aside.driver-pool::-webkit-scrollbar { width: 6px; }
aside.driver-pool::-webkit-scrollbar-track { background: transparent; }
aside.driver-pool::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 3px; }
aside.driver-pool::-webkit-scrollbar-thumb:hover { background: var(--text-subtle); }
/* OKAMI table — strip every mockup pill/color (operator wanted plain table) */
.plan-gap, .plan-gap.ok, .plan-gap.warn, .plan-gap.bad { color: var(--text-muted) !important; }
.plan-status-pill, .plan-status-pill.ok, .plan-status-pill.warn, .plan-status-pill.bad {
  background: transparent !important; color: var(--text-muted) !important; border: 0 !important;
  font-weight: 500 !important; padding: 0 !important;
}
.plan-status-pill .dot { display: none !important; }
.strategy-pill, .strategy-pill.active, .strategy-pill.active.hire, .strategy-pill.active.adw, .strategy-pill.active.ot, .strategy-pill.active.seasonal {
  background: transparent !important; color: var(--text-muted) !important; border-color: transparent !important;
  font-weight: 500 !important;
}
/* Kill HVE row highlights + the tag pills on week labels */
.okami-table tr.hve, .okami-table tr.hve > td { background: transparent !important; }
.okami-week-tag, .okami-week-tag.hve, .okami-week-tag.peak, .okami-week-tag.cycle { display: none !important; }
.plan-calc-sub { display: none !important; }
/* Hide the Strategy / Hire by / Status columns (operator: not needed) */
.okami-table th:nth-child(6),
.okami-table th:nth-child(7),
.okami-table th:nth-child(8),
.okami-table tr:not(.okami-detail) > td:nth-child(6),
.okami-table tr:not(.okami-detail) > td:nth-child(7),
.okami-table tr:not(.okami-detail) > td:nth-child(8) { display: none !important; }
/* Kill mockup row decorations: cycle-end blue underline + HVE yellow stripe. */
.okami-table tbody tr.cycle-end { border-bottom: 1px solid var(--border) !important; background: transparent !important; }
.okami-table tbody tr.hve { background: transparent !important; }
/* Driver names anywhere are clickable — open the driver record drawer. */
[data-rr-driver-id]{cursor:pointer}
[data-rr-driver-id]:hover{text-decoration:underline;text-underline-offset:2px}
[data-rr-open-driver]{cursor:pointer}
[data-rr-open-driver]:hover .cell-name{text-decoration:underline;text-underline-offset:2px}`;
document.head.appendChild(_styleEl);


// ─── OKAMI (demand) + Schedule (supply) ───────────────────────────────────
//
// OKAMI: 3-week per-day per-station route TARGET grid. Editable.
// Schedule: 3-week per-day per-station coverage view (filled vs needed),
// plus time-off and open-shifts panels.

const RR_SCHED_WEEKS = 3;
const RR_DAY_SHORT   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

function startOfWeekMonday(d) {
  const date = new Date(d);
  const day = date.getDay();             // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? -6 : 1 - day; // shift back to Monday
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}
function fmtIsoDate(d) { return d.toISOString().slice(0, 10); }
function fmtMD(d) { return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }


// NOTE — earlier iteration of this code overwrote the OKAMI table and
// Schedule subview innerHTML, replacing the polished mockup layout with
// a generic grid. Operator pushed back; mockup design is the source of
// truth. Wiring live data INTO the mockup elements (without touching
// the structure) is queued as a follow-up.
//
// For now: leave the mockup OKAMI + Schedule views untouched. Schema
// (0025) and RPCs are still deployed and usable from SQL / future UI.

let _okamiStations = [];
let _schedDriverList = [];
// Driver column sort mode: "alpha" (A–Z, default), "wave" (by primary
// wave assignment that week), or "hours" (by hours scheduled, desc).
// Session-only — not persisted across reloads.
let _schedDriverSort = "alpha";

// Click handler for the schedule driver-sort icon — opens a small
// popover with three options (matches the Turnover KPI pattern).
document.addEventListener("click", (e) => {
  const btn = e.target.closest("#rr-sched-driver-sort-toggle");
  if (btn) {
    e.stopPropagation();
    e.preventDefault();
    const head = btn.parentElement;
    const existing = head.querySelector(".rr-tf-popover");
    if (existing) { existing.remove(); return; }
    document.querySelectorAll(".rr-tf-popover").forEach(el => el.remove());
    const opts = [
      { v: "alpha", l: "A – Z" },
      { v: "wave",  l: "By wave" },
      { v: "hours", l: "By hours" },
    ];
    const pop = document.createElement("div");
    pop.className = "rr-tf-popover";
    pop.style.top = "26px";
    pop.style.right = "0";
    pop.innerHTML = opts.map(o =>
      `<button data-rr-sched-sort="${o.v}" class="${o.v === _schedDriverSort ? "active" : ""}">${o.l}</button>`
    ).join("");
    head.appendChild(pop);
    return;
  }
  const opt = e.target.closest("[data-rr-sched-sort]");
  if (opt) {
    _schedDriverSort = opt.dataset.rrSchedSort || "alpha";
    document.querySelectorAll(".rr-tf-popover").forEach(el => el.remove());
    if (typeof renderScheduleWeek === "function") renderScheduleWeek();
    return;
  }
});
let _okamiStart = null;
let _schedStart = null;

async function loadOkamiView() {
  await renderOkamiLive();
  bindOkamiHandlers();
}

// ─── OKAMI · 13-week list (live render + save) ─────────────────────────────

const RR_OKAMI_WEEKS = 13;
const RR_OKAMI_HIRE_LEAD_DAYS = 28; // training/onboarding lead time

function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

let _okamiActiveCount = 0;
let _okamiTotalsByDateCache = null;
let _okamiStartCache = null;

// Document-level listener for the Plan Pad slider so timing of when
// bindOkamiHandlers runs can't break it. Fires on every drag tick.
let _okamiPadSaveTimer = null;
document.addEventListener("input", (e) => {
  if (e.target?.id !== "rr-okami-pad") return;
  const pct = Math.max(0, Math.min(50, parseInt(e.target.value, 10) || 0));
  const lbl = document.getElementById("rr-okami-pad-val");
  if (lbl) lbl.textContent = `${pct}%`;
  if (window.RR?.dsp?.metadata) {
    window.RR.dsp.metadata.staffing = { ...(window.RR.dsp.metadata.staffing || {}), plan_pad_pct: pct };
  }
  // If the cache hasn't populated yet (rare — operator opened OKAMI and
  // dragged before the first fetch completed), fall back to renderOkamiLive
  // so the cells eventually update.
  if (!_okamiTotalsByDateCache) {
    if (typeof renderOkamiLive === "function") renderOkamiLive();
  } else {
    _okamiRecomputeFromCache(pct);
  }
  if (_okamiPadSaveTimer) clearTimeout(_okamiPadSaveTimer);
  _okamiPadSaveTimer = setTimeout(async () => {
    const dspId = window.RR?.dsp?.id;
    if (!dspId) return;
    const meta = window.RR.dsp.metadata || {};
    await sb.from("dsps").update({ metadata: meta }).eq("id", dspId);
  }, 500);
});

// Recompute Drivers Needed + Gap cells from cached data, no network call.
// Used when the operator drags the Staffing Plan Pad slider — instant
// feedback without waiting for okami_grid to round-trip.
function _okamiRecomputeFromCache(padPct) {
  if (!_okamiTotalsByDateCache || !_okamiStartCache) return;
  const okTbody = document.getElementById("okami-tbody");
  const allOkamiRows = okTbody
    ? Array.from(okTbody.querySelectorAll("tr:not(.okami-detail)"))
    : [];
  for (let w = 0; w < allOkamiRows.length; w++) {
    const row = allOkamiRows[w];
    const weekStart = addDays(_okamiStartCache, w * 7);
    let routesMax = 0;
    for (let d = 0; d < 7; d++) {
      const t = _okamiTotalsByDateCache.get(fmtIsoDate(addDays(weekStart, d))) || 0;
      if (t > routesMax) routesMax = t;
    }
    const needed = routesMax > 0 ? Math.ceil(routesMax * 2 * (1 + padPct / 100)) : 0;
    const gap = _okamiActiveCount - needed;
    const tdCells = row.querySelectorAll("td");
    if (tdCells[2]) tdCells[2].innerHTML = `<div class="plan-calc">${needed}</div>`;
    if (tdCells[3]) tdCells[3].innerHTML = `<div class="plan-calc">${_okamiActiveCount}</div>`;
    const gapEl = tdCells[4]?.querySelector(".plan-gap");
    if (gapEl) {
      gapEl.textContent = (gap >= 0 ? "+" : "") + gap;
      gapEl.classList.remove("ok", "warn", "bad");
    }
  }
}
let _okamiCushionPct = 10;

async function renderOkamiLive() {
  return _renderOkamiLiveImpl();
}
// Attach to window at module load so the mockup recalcOkami stub can
// always find it. Same pattern as renderOkamiDailyPanel.
window.renderOkamiLive = renderOkamiLive;
// The inline oninput="recalcOkami()" on every Routes (max) input would
// refetch the row from DB on every keystroke and reset the value the
// operator just typed. Make it a no-op — the document-level input
// delegate handles the debounced save + re-render.
window.recalcOkami = function () { /* no-op */ };

async function _renderOkamiLiveImpl() {
  const tbody = document.getElementById("okami-tbody");
  if (!tbody) return;
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;

  // Anchor OKAMI to the actual current week by default so the
  // 13-week planner rolls forward as the calendar advances. When
  // the operator opens OKAMI from a specific Week view (Route
  // planning button), `window._rrOkamiAnchorOverride` lets that
  // overlay anchor on the visible week instead, so each week
  // really gets "its own" planning horizon. Cleared after read so
  // the next non-overlay refresh snaps back to the rolling anchor.
  const _override = window._rrOkamiAnchorOverride;
  if (_override) {
    _okamiStart = _override;
    window._rrOkamiAnchorOverride = null;
  } else {
    _okamiStart = fmtIsoDate(startOfWeekMonday(new Date()));
  }
  const start = new Date(_okamiStart + "T12:00:00");

  const [gridRes, drvRes] = await Promise.all([
    sb.rpc("okami_grid", { p_start: _okamiStart, p_weeks: RR_OKAMI_WEEKS }),
    sb.from("drivers")
      .select("id, status", { count: "exact", head: true })
      .eq("dsp_id", dspId)
      .in("status", ["active", "onboarding"]),
  ]);

  if (gridRes.error) { console.warn("okami_grid:", gridRes.error.message); return; }
  if (drvRes.error)  { console.warn("driver count:", drvRes.error.message); return; }

  const cells = gridRes.data || [];
  _okamiActiveCount = drvRes.count || 0;

  // Sum target_routes per ISO date across all stations.
  const totalsByDate = new Map();
  for (const c of cells) {
    totalsByDate.set(c.date, (totalsByDate.get(c.date) || 0) + (c.target_routes || 0));
  }
  // Cache for fast slider re-renders (no network round-trip per drag tick).
  _okamiTotalsByDateCache = totalsByDate;
  _okamiStartCache = start;

  // Staffing Plan Pad — 0–50% buffer above the 2× per-route baseline.
  // Persisted on dsps.metadata.staffing.plan_pad_pct, defaults to 10%.
  // This is OKAMI-only — totally separate from the schedule cushion.
  const padPct = Math.max(0, Math.min(50,
    Number(window.RR?.dsp?.metadata?.staffing?.plan_pad_pct ?? 10) || 0));
  const padInput = document.getElementById("rr-okami-pad");
  const padLabel = document.getElementById("rr-okami-pad-val");
  if (padInput && Number(padInput.value) !== padPct) padInput.value = padPct;
  if (padLabel) padLabel.textContent = `${padPct}%`;

  // Mockup only assigned id='okami-row-N' to the first three rows; rows
  // 3..12 had no id, so the older lookup silently skipped them and W21
  // through W30 never got their labels rewritten. Use every non-detail
  // row inside #okami-tbody in document order instead.
  const okTbody = document.getElementById("okami-tbody");
  const allOkamiRows = okTbody
    ? Array.from(okTbody.querySelectorAll("tr:not(.okami-detail)"))
    : [];

  for (let w = 0; w < RR_OKAMI_WEEKS; w++) {
    const row = allOkamiRows[w];
    if (!row) continue;
    const weekStart = addDays(start, w * 7);
    const weekEnd   = addDays(weekStart, 6);

    // Routes per day across the week, then peak.
    let routesMax = 0;
    for (let d = 0; d < 7; d++) {
      const iso = fmtIsoDate(addDays(weekStart, d));
      const t = totalsByDate.get(iso) || 0;
      if (t > routesMax) routesMax = t;
    }

    // Drivers Needed = ceil(routes_max × 2 × (1 + plan_pad/100)).
    // 2× = the per-route baseline (1 primary + 1 backup); pad layers
    // additional buffer for callouts/turnover at the staffing-plan level.
    const needed = routesMax > 0
      ? Math.ceil(routesMax * 2 * (1 + padPct / 100))
      : 0;
    const gap     = _okamiActiveCount - needed;
    const hireBy  = addDays(weekStart, -RR_OKAMI_HIRE_LEAD_DAYS);

    // Update week label + dates (without disturbing the expand button or tags).
    const labelEl = row.querySelector(".plan-week-label");
    const datesEl = row.querySelector(".plan-week-dates");
    if (labelEl) labelEl.textContent = `W${isoWeekNumber(weekStart)}`;
    if (datesEl) datesEl.textContent = `${fmtMD(weekStart)}–${weekEnd.getDate()}`;

    // Routes (max) is now READ-ONLY — operator edits per-day in the
    // daily drill-down panel and Routes (max) reflects the peak day.
    // Editing the cell directly used to overwrite all 7 days, which
    // destroyed per-day variation. Set readOnly + light styling so it
    // looks like a display value, not an input.
    const input = row.querySelector(".plan-route-input");
    if (input) {
      input.value = routesMax;
      input.readOnly = false;
      input.style.background = "";
      input.style.border = "";
      input.style.cursor = "";
      input.title = "Type a value to set all 7 days. Use the drill-down panel for per-day variation.";
      input.dataset.rrOkamiWeekIdx = String(w);
    }

    const tdCells = row.querySelectorAll("td");
    // [0]=Week, [1]=Routes input, [2]=Needed, [3]=Available, [4]=Gap, [5]=Strategy, [6]=Hire by, [7]=Status
    if (tdCells[2]) tdCells[2].innerHTML = `<div class="plan-calc">${needed}</div>`;
    if (tdCells[3]) tdCells[3].innerHTML = `<div class="plan-calc">${_okamiActiveCount}</div>`;

    // Plain numbers — no color codes / pills (operator wanted less noise).
    const gapEl = tdCells[4]?.querySelector(".plan-gap");
    if (gapEl) {
      gapEl.textContent = (gap >= 0 ? "+" : "") + gap;
      gapEl.classList.remove("ok", "warn", "bad");
    }

    const stratEl = tdCells[5]?.querySelector(".strategy-pills");
    if (stratEl) {
      const text = gap >= 0 ? "Hold" : (gap >= -10 ? "+8h OT" : "Hire");
      stratEl.innerHTML = `<span style="font-size:var(--fs-sm);color:var(--text-muted)">${text}</span>`;
    }

    const hireByEl = tdCells[6]?.querySelector(".plan-calc");
    if (hireByEl) {
      hireByEl.textContent = gap >= 0 ? "—" : fmtMD(hireBy);
    }

    const statusPill = tdCells[7]?.querySelector(".plan-status-pill");
    if (statusPill) {
      statusPill.classList.remove("ok", "warn", "bad");
      const text = gap >= 0 ? "On track" : (gap >= -10 ? "Tight" : "Critical");
      statusPill.outerHTML = `<span style="font-size:var(--fs-sm);color:var(--text-muted)">${text}</span>`;
    }
  }

  // Update top hires-needed summary cell, if present.
  let totalHires = 0;
  for (let w = 0; w < RR_OKAMI_WEEKS; w++) {
    const row = allOkamiRows[w];
    const gapEl = row?.querySelectorAll("td")[4]?.querySelector(".plan-gap");
    if (!gapEl) continue;
    const g = parseInt(gapEl.textContent, 10);
    if (Number.isFinite(g) && g < 0) totalHires += -g;
  }
  const sumValue = document.querySelector(".okami-summary-grid .okami-sum:first-child .okami-sum-value");
  if (sumValue) sumValue.textContent = totalHires;
}

let _okamiBound = false;
let _okamiSaveTimers = new Map();
const _okamiDirtyWeeks = new Set();

function _setOkamiSaveStatus(text, kind) {
  const el = document.getElementById("rr-okami-save-status");
  if (!el) return;
  el.textContent = text || "";
  el.style.color = kind === "warn" ? "var(--red)" : kind === "ok" ? "var(--green)" : "var(--text-subtle)";
}

function bindOkamiHandlers() {
  if (_okamiBound) return;
  _okamiBound = true;

  // The mockup's recalcOkami fires on every DPR / ADW / OT / cushion
  // slider tick and writes hardcoded okamiAvail values to every row's
  // cells, overwriting our live render. Neutralize it so only our
  // renderOkamiLive controls the table. Set at module top level (no-op);
  // do NOT reassign here — the inline oninput handlers on Routes (max)
  // inputs would refetch on every keystroke and clobber typed values.

  // Slider is wired via the document-level delegate at module top level
  // so it survives any DOM re-render or re-bind timing.

  // Sync schedule: take the visible week's OKAMI route targets and
  // push them into the shifts table so the operator sees the open-
  // shift count = (route plan + cushion) match what they planned.
  //
  // Daily route values auto-save on every keystroke via saveOkamiDaily;
  // this button is the explicit "now build the shifts from those
  // targets" action. It runs the same per-week pipeline that Settings
  // → Save uses:
  //   1. regenerate_week_shifts(_schedStart) — wipes unassigned
  //      scheduled rows in the week, regenerates from okami_demand,
  //      re-stamps starts_at to wave_time − report_lead.
  //   2. apply_cushion_to_week(_schedStart) — adds cushion shifts
  //      on top so the visible total = target × (1 + cushion%).
  //
  // Previously this loop iterated every okami_demand row DSP-wide
  // and only called generate_shifts_for_date — so reducing a target
  // didn't trim excess open shifts, and cushion was never applied.
  const saveBtn = document.getElementById("rr-okami-save-plan");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      const dspId = window.RR?.dsp?.id;
      if (!dspId) { _setOkamiSaveStatus("DSP not loaded", "warn"); return; }
      const ws = _schedStart;
      if (!ws) { _setOkamiSaveStatus("Pick a week first", "warn"); return; }
      saveBtn.disabled = true;
      _setOkamiSaveStatus("Saving inputs…");
      try {
        // Flush any pending debounced okami_set_target writes so the
        // rebuild reads the latest typed values. Without this, a
        // quick "type 5 → click Save" sequence (within the 400ms
        // debounce window) regenerates from stale demand.
        await flushOkamiDailyPending();
        _setOkamiSaveStatus("Building shifts…");
        const { error: regenErr } = await sb.rpc("regenerate_week_shifts", { p_week_start: ws });
        if (regenErr) throw regenErr;

        let cushionAdded = 0;
        try {
          const { data, error: cushionErr } = await sb.rpc("apply_cushion_to_week", { p_week_start: ws });
          if (cushionErr) console.warn(`apply_cushion_to_week (${ws}):`, cushionErr.message);
          else cushionAdded = data || 0;
        } catch (e) {
          console.warn(`apply_cushion_to_week (${ws}) threw:`, e);
        }

        _setOkamiSaveStatus(`Schedule synced ✓${cushionAdded ? ` · +${cushionAdded} cushion` : ""}`, "ok");
        toast(`Schedule synced for week of ${ws}${cushionAdded ? ` · +${cushionAdded} cushion` : ""}`, "success");

        // Re-render the calendar behind the overlay so the open-shifts
        // pool reflects the new totals as soon as the operator closes.
        if (typeof renderScheduleWeek === "function") {
          try { await renderScheduleWeek(); } catch (e) { console.warn("re-render after OKAMI sync:", e); }
        }

        // Auto-close after a beat so the operator lands back on the
        // calendar showing the new shift count, matching the
        // "auto-populate into the open shift box after I hit save"
        // expectation. They can re-open if they want more edits.
        setTimeout(() => {
          if (typeof closeOkamiOverlay === "function") closeOkamiOverlay();
          _setOkamiSaveStatus("");
        }, 900);
      } catch (err) {
        _setOkamiSaveStatus("Failed: " + (err.message || err), "warn");
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  // Cushion slider — save on commit (mouseup/keyup), not every drag tick.
  const cushion = document.getElementById("okami-cushion");
  if (cushion) {
    cushion.addEventListener("change", async () => {
      const pct = parseInt(cushion.value, 10) || 0;
      const { error } = await sb.rpc("okami_set_cushion", { p_pct: pct });
      if (error) { toast("Save failed: " + error.message, "warn"); return; }
      _okamiCushionPct = pct;
      await renderOkamiLive();
    });
  }
  // DPR + ADW + OT are UI-only (no storage yet); recalc on change.
  ["okami-dpr", "okami-adw", "okami-ot"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => renderOkamiLive());
  });

  // Override the mockup toggle so the drill-down panel renders from real data.
  window.okamiToggleDaily = function (weekIdx) {
    const detail = document.getElementById(`okami-detail-${weekIdx}`);
    const btn = document.querySelector(`#okami-row-${weekIdx} .okami-expand-btn`);
    if (!detail || !btn) return;
    const isOpen = detail.classList.toggle("open");
    btn.classList.toggle("expanded", isOpen);
    if (isOpen) renderOkamiDailyPanel(weekIdx);
  };

  // The mockup's okamiRenderDailyPanel was deleted in index.html and now
  // delegates here via window. Expose the live renderer on window so the
  // mockup stub can find it.
  window.okamiRenderDailyPanel = renderOkamiDailyPanel;
  window.renderOkamiDailyPanel = renderOkamiDailyPanel;
}

async function saveOkamiWeek(w, routesMax) {
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;
  if (!_okamiStart) return;
  const weekStart = addDays(new Date(_okamiStart + "T12:00:00"), w * 7);

  if (!_okamiStations || _okamiStations.length === 0) {
    const { data, error } = await sb.from("stations")
      .select("id, code, active").eq("dsp_id", dspId).eq("active", true);
    if (error) { toast("Save failed: " + error.message, "warn"); return; }
    _okamiStations = data || [];
  }
  if (_okamiStations.length === 0) {
    toast("No stations configured — add a station before setting OKAMI", "warn");
    return;
  }

  // Single-station mode: full value to first station, zero out the rest.
  // set_okami_week_demand wrote to ALL stations which inflated the displayed
  // peak by N× when multiple active stations existed.
  const target = Math.max(0, parseInt(routesMax, 10) || 0);
  const calls = [];
  for (let d = 0; d < 7; d++) {
    const iso = fmtIsoDate(addDays(weekStart, d));
    _okamiStations.forEach((s, idx) => {
      calls.push(sb.rpc("okami_set_target", { p_date: iso, p_station_id: s.id, p_target: idx === 0 ? target : 0 }));
    });
  }
  const results = await Promise.all(calls);
  const firstErr = results.find(r => r.error);
  if (firstErr) { toast("Save failed: " + firstErr.error.message, "warn"); return; }
  await renderOkamiLive();
}

// Debounced save when the operator types into a Routes (max) cell.
const _okamiWeekSaveTimers = new Map();
document.addEventListener("input", (e) => {
  const inp = e.target.closest("input.plan-route-input");
  if (!inp) return;
  const w = parseInt(inp.dataset.rrOkamiWeekIdx ?? "-1", 10);
  if (!Number.isFinite(w) || w < 0) return;
  const prev = _okamiWeekSaveTimers.get(w);
  if (prev) clearTimeout(prev);
  _okamiWeekSaveTimers.set(w, setTimeout(() => {
    saveOkamiWeek(w, parseInt(inp.value, 10) || 0);
  }, 600));
});

// ─── OKAMI · daily drill-down panel (PR C) ─────────────────────────────────

const RR_OKAMI_DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const _okamiDailySaveTimers = new Map();
let _okamiDailyDelegated = false;

async function recommendOkamiCushion(dspId) {
  const since = new Date(); since.setDate(since.getDate() - 30);
  const sinceIso = fmtIsoDate(since);
  const [scheduledRes, absentRes] = await Promise.all([
    sb.from("shifts").select("id", { count: "exact", head: true })
      .eq("dsp_id", dspId).gte("date", sinceIso)
      .in("status", ["scheduled", "completed", "called_off", "no_show"]),
    sb.from("shifts").select("id", { count: "exact", head: true })
      .eq("dsp_id", dspId).gte("date", sinceIso)
      .in("status", ["called_off", "no_show"]),
  ]);
  if (scheduledRes.error || absentRes.error) {
    return { percent: 10, source: "Using default — no data yet", absences: 0, total: 0 };
  }
  const total = scheduledRes.count || 0;
  const absences = absentRes.count || 0;
  if (total === 0) {
    return { percent: 10, source: "No scheduled shifts in last 30d", absences: 0, total: 0 };
  }
  const rate = absences / total;
  const recommended = Math.max(5, Math.min(20, Math.round(rate * 100 * 1.5)));
  return {
    percent: recommended,
    absences,
    total,
    source: `${absences} callout${absences === 1 ? "" : "s"} + no-shows over ${total} scheduled last 30d = ${(rate * 100).toFixed(1)}% absence · 1.5× safety`,
  };
}

async function renderOkamiDailyPanel(weekIdx) {
  return _renderOkamiDailyPanelImpl(weekIdx);
}
// Attach to window at module load so the mockup stub in index.html can
// always find it, regardless of whether OKAMI has been bound yet.
window.renderOkamiDailyPanel = renderOkamiDailyPanel;
window.okamiRenderDailyPanel = renderOkamiDailyPanel;

async function _renderOkamiDailyPanelImpl(weekIdx) {
  const container = document.getElementById(`okami-detail-content-${weekIdx}`);
  if (!container) return;
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;
  if (!_okamiStart) return;

  const weekStart = addDays(new Date(_okamiStart + "T12:00:00"), weekIdx * 7);
  const startIso = fmtIsoDate(weekStart);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const todayIso = fmtIsoDate(new Date());

  container.innerHTML = `<div class="rr-loading">Loading</div>`;

  // Pull demand grid + cushion recommendation + this week's waves in one go.
  // Waves come from scheduling_settings (per-week, with DSP-level fallback)
  // so the OKAMI panel always matches what Schedule will use.
  const [gridRes, recommendation, settingsRes] = await Promise.all([
    sb.rpc("okami_grid", { p_start: startIso, p_weeks: 1 }),
    recommendOkamiCushion(dspId),
    sb.rpc("scheduling_settings_for_week", { p_week_start: startIso }),
  ]);
  if (gridRes.error) {
    container.innerHTML = `<div style="padding:18px;color:var(--red);font-size:var(--fs-sm)">Failed to load: ${escapeHtml(gridRes.error.message)}</div>`;
    return;
  }
  const cells = gridRes.data || [];
  const settings = settingsRes?.data || {};
  const waves = (Array.isArray(settings.waves) && settings.waves.length > 0)
    ? settings.waves
    : [{ start: "07:00" }];
  const waveCount = waves.length;

  // Active service types determine how many rows per wave to render.
  // A DSP with only SP active (the default) gets a single row per wave,
  // looking exactly like pre-0050. Activating XL / HUB / ASU adds rows.
  if (!_okamiServiceTypes) {
    const stRes = await sb.rpc("list_service_types");
    _okamiServiceTypes = (stRes.data || []);
  }
  const activeTypes = _okamiServiceTypes.filter(t => t.active);
  if (activeTypes.length === 0) {
    activeTypes.push({ id: null, code: "SP", label: "Standard Parcel", color: "#0F6CBD" });
  }
  const showTypeLabel = activeTypes.length > 1;

  // Per-(wave × type) totals: dailyByBucket[waveIdx][typeIdx][dayIdx].
  // okami_grid returns one row per (date, station) with targets_by_wave
  // carrying { wave_index, service_type_code, target_routes } entries.
  const dailyByBucket = waves.map(() => activeTypes.map(() => Array(7).fill(0)));
  for (const c of cells) {
    const dayIdx = days.findIndex(d => fmtIsoDate(d) === c.date);
    if (dayIdx < 0) continue;
    const byWave = Array.isArray(c.targets_by_wave) ? c.targets_by_wave : [];
    for (const w of byWave) {
      const wIdx = w?.wave_index ?? 0;
      const stCode = w?.service_type_code || "SP";
      const tIdx = activeTypes.findIndex(t => t.code === stCode);
      if (wIdx >= 0 && wIdx < waveCount && tIdx >= 0) {
        dailyByBucket[wIdx][tIdx][dayIdx] += (w?.target_routes || 0);
      }
    }
  }

  // Day totals + week stats sum across every bucket so the footer line
  // ("Week total / Peak day") reflects all-types-all-waves demand.
  const dayTotals = Array(7).fill(0);
  for (const waveBuckets of dailyByBucket) {
    for (const typeBuckets of waveBuckets) {
      for (let i = 0; i < 7; i++) dayTotals[i] += typeBuckets[i];
    }
  }
  const totalRoutes = dayTotals.reduce((s, n) => s + n, 0);
  const peakRoutes  = dayTotals.reduce((m, n) => n > m ? n : m, 0);

  const headerLabel = `W${isoWeekNumber(weekStart)} · ${fmtMD(weekStart)}–${addDays(weekStart, 6).getDate()}`;

  // One row per (wave × active type). Single-wave + single-type weeks
  // render exactly like pre-0050. Multi-wave or multi-type weeks get
  // one labelled row per bucket — labels include type code only when
  // 2+ types active (single-type weeks just say "Routes planned").
  const rowsHtml = waves.flatMap((wave, wIdx) => {
    const waveStart = wave?.start || "07:00";
    return activeTypes.map((st, tIdx) => {
      const labelParts = ["Routes planned"];
      if (showTypeLabel) labelParts.push(escapeHtml(st.code));
      if (waveCount > 1) labelParts.push(`Wave ${wIdx + 1} (${escapeHtml(waveStart)})`);
      const label = labelParts.join(" · ");
      const stIdAttr = st.id ? `data-service-type-id="${st.id}"` : "";
      const cellsHtml = days.map((d, i) => {
        const iso = fmtIsoDate(d);
        const isToday = iso === todayIso;
        return `<div class="okami-daily-cell${isToday ? " is-today" : ""}"><input type="number" min="0" max="200" value="${dailyByBucket[wIdx][tIdx][i]}" data-rr-okami-daily="${weekIdx}" data-iso="${iso}" data-wave="${wIdx}" ${stIdAttr}/></div>`;
      }).join("");
      return `<div class="okami-daily-row">
        <div class="okami-daily-label">${label}</div>
        ${cellsHtml}
      </div>`;
    });
  }).join("");

  container.innerHTML = `
    <div class="okami-daily-panel" style="grid-template-columns:1fr">
      <div class="okami-daily-grid">
        <div class="okami-daily-grid-head">
          <div>${escapeHtml(headerLabel)}</div>
          ${RR_OKAMI_DAY_LABELS.map(l => `<div>${l}</div>`).join("")}
        </div>
        ${rowsHtml}
      </div>
      <div style="grid-column:1 / -1;display:flex;justify-content:space-between;font-size:var(--fs-xs);color:var(--text-subtle);padding:10px 4px 0">
        <span>Week total <strong style="color:var(--text)">${totalRoutes}</strong> routes</span>
        <span>Peak day <strong style="color:var(--text)">${peakRoutes} routes</strong> · cushion applied in Schedule</span>
      </div>
    </div>`;

  bindOkamiDailyDelegation();
}

function bindOkamiDailyDelegation() {
  if (_okamiDailyDelegated) return;
  _okamiDailyDelegated = true;
  const tbody = document.getElementById("okami-tbody");
  if (!tbody) return;

  tbody.addEventListener("input", (e) => {
    const inp = e.target.closest("input[data-rr-okami-daily]");
    if (!inp) return;
    const weekIdx = parseInt(inp.dataset.rrOkamiDaily, 10);
    const iso = inp.dataset.iso;
    const waveIdx = parseInt(inp.dataset.wave || "0", 10) || 0;
    const stId = inp.dataset.serviceTypeId || null;
    if (!iso || !Number.isFinite(weekIdx)) return;
    const key = `${weekIdx}|${iso}|${waveIdx}|${stId || "default"}`;
    const prev = _okamiDailySaveTimers.get(key);
    if (prev) clearTimeout(prev.timeoutId);
    // CRITICAL: don't close over the input DOM node. If the panel
    // re-renders between input event and the 400ms timer fire (a
    // cushion change, tab refresh tick, etc. all replace
    // container.innerHTML), the captured `inp` becomes detached and
    // its .value freezes at detach time. Some keystrokes commit,
    // others don't — produces the operator's "I typed 5 but got
    // 2,2,5,5,2,2,5" symptom.
    //
    // Instead: resolve the input by its own data attributes at fire
    // time so we always read the live DOM node's current value.
    const stSelector = stId
      ? `[data-service-type-id="${stId}"]`
      : ":not([data-service-type-id])";
    const liveSelector = `input[data-rr-okami-daily="${weekIdx}"][data-iso="${iso}"][data-wave="${waveIdx}"]${stSelector}`;
    const args = {
      weekIdx, iso, waveIdx, stId,
      getValue: () => {
        const live = document.querySelector(liveSelector);
        return live ? (parseInt(live.value, 10) || 0) : (parseInt(inp.value, 10) || 0);
      },
    };
    const timeoutId = setTimeout(() => {
      _okamiDailySaveTimers.delete(key);
      saveOkamiDaily(args.weekIdx, args.iso, args.getValue(), args.waveIdx, args.stId);
    }, 400);
    _okamiDailySaveTimers.set(key, { timeoutId, args });
  });

  tbody.addEventListener("change", async (e) => {
    const cushionInp = e.target.closest("input[data-rr-okami-cushion-pct]");
    if (cushionInp) {
      const pct = Math.max(0, Math.min(50, parseInt(cushionInp.value, 10) || 0));
      const { error } = await sb.rpc("okami_set_cushion", { p_pct: pct });
      if (error) { toast("Save failed: " + error.message, "warn"); return; }
      _okamiCushionPct = pct;
      const topInp = document.getElementById("okami-cushion");
      if (topInp) topInp.value = pct;
      const topVal = document.getElementById("okami-cushion-val");
      if (topVal) topVal.innerHTML = `${pct}<span class="frac">%</span>`;
      const openIdx = openOkamiDetailIndex();
      if (openIdx != null) renderOkamiDailyPanel(openIdx);
      renderOkamiLive();
      return;
    }
  });

  tbody.addEventListener("click", async (e) => {
    const apply = e.target.closest("[data-rr-okami-apply-rec]");
    if (!apply) return;
    const pct = parseInt(apply.dataset.rrOkamiApplyRec, 10);
    if (!Number.isFinite(pct)) return;
    const { error } = await sb.rpc("okami_set_cushion", { p_pct: pct });
    if (error) { toast("Save failed: " + error.message, "warn"); return; }
    _okamiCushionPct = pct;
    const topInp = document.getElementById("okami-cushion");
    if (topInp) topInp.value = pct;
    const topVal = document.getElementById("okami-cushion-val");
    if (topVal) topVal.innerHTML = `${pct}<span class="frac">%</span>`;
    const openIdx = openOkamiDetailIndex();
    if (openIdx != null) renderOkamiDailyPanel(openIdx);
    renderOkamiLive();
    toast(`Cushion set to ${pct}%`, "success");
  });
}

function openOkamiDetailIndex() {
  for (let i = 0; i < RR_OKAMI_WEEKS; i++) {
    const d = document.getElementById(`okami-detail-${i}`);
    if (d && d.classList.contains("open")) return i;
  }
  return null;
}

// Force every pending debounced okami_set_target save to fire NOW
// and await them all. Used before regenerate_week_shifts so the
// rebuild reads the latest typed values, not 400ms-old stale demand.
async function flushOkamiDailyPending() {
  const pending = Array.from(_okamiDailySaveTimers.values());
  _okamiDailySaveTimers.clear();
  for (const { timeoutId } of pending) clearTimeout(timeoutId);
  await Promise.all(pending.map(({ args }) =>
    saveOkamiDaily(args.weekIdx, args.iso, args.getValue(), args.waveIdx, args.stId)
  ));
}

async function saveOkamiDaily(weekIdx, iso, routes, waveIdx = 0, stId = null) {
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;
  if (!_okamiStations || _okamiStations.length === 0) {
    // Order by code so saveOkamiDaily's "first station gets the
    // value, others zero" semantics is deterministic across sessions.
    const { data, error } = await sb.from("stations")
      .select("id, code, active")
      .eq("dsp_id", dspId)
      .eq("active", true)
      .order("code");
    if (error) { toast("Save failed: " + error.message, "warn"); return; }
    _okamiStations = data || [];
  }
  if (_okamiStations.length === 0) {
    toast("No stations configured — add a station before setting OKAMI", "warn");
    return;
  }
  // Single-station mode: write the full value to the first station and
  // zero out the rest. Avoids the rounding drift you'd get from
  // round(routes / station_count) when station_count > 1.
  const calls = _okamiStations.map((s, idx) =>
    sb.rpc("okami_set_target", {
      p_date:             iso,
      p_station_id:       s.id,
      p_target:           idx === 0 ? routes : 0,
      p_wave_index:       waveIdx,
      p_service_type_id:  stId,
    })
  );
  const results = await Promise.all(calls);
  const firstErr = results.find(r => r.error);
  if (firstErr) { toast("Save failed: " + firstErr.error.message, "warn"); return; }
  // Don't re-render anything after a daily save — that's what was causing
  // the per-keystroke glitch. The operator's input keeps focus + value;
  // the 13-week Routes(max) cell will refresh on next view focus
  // (window.focus listener + 30s heartbeat both call refreshActiveView).
}

// ─── Settings · Scheduling (block hours, cushion, waves) ───────────────────

async function loadSchedulingSettings() {
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;
  if (!_schedStart) _schedStart = fmtIsoDate(startOfWeekMonday(new Date()));

  const { data, error } = await sb.rpc("scheduling_settings_for_week", { p_week_start: _schedStart });
  if (error) { console.warn("scheduling settings load:", error.message); return; }
  const s = data || {};

  const blockEl  = document.getElementById("rr-set-block-hours");
  const cushEl   = document.getElementById("rr-set-cushion-pct");
  const maxDaysEl = document.getElementById("rr-set-max-days");
  const leadEl    = document.getElementById("rr-set-report-lead");
  const wavesEl  = document.getElementById("rr-set-waves");
  const statusEl = document.getElementById("rr-set-sched-status");

  if (blockEl)   blockEl.value   = s.default_block_hours ?? 10;
  if (cushEl)    cushEl.value    = s.cushion_pct ?? 10;
  if (maxDaysEl) maxDaysEl.value = s.max_days_per_week ?? 5;
  if (leadEl)    leadEl.value    = s.report_lead_minutes ?? 0;

  // Read-only attendance rate label next to the cushion field. Operator
  // looks at it and decides their own cushion %. No click handler, no
  // mutation of any other element — kept deliberately minimal after the
  // recommendation chip kept breaking the dashboard.
  (async () => {
    try {
      const dspId = window.RR?.dsp?.id;
      const labelEl = document.getElementById("rr-cushion-rec");
      if (!dspId || !labelEl) return;
      const since = new Date(); since.setDate(since.getDate() - 30);
      const sinceIso = since.toISOString().slice(0, 10);
      const [scheduledRes, absentRes] = await Promise.all([
        sb.from("shifts").select("id", { count: "exact", head: true })
          .eq("dsp_id", dspId).gte("date", sinceIso)
          .in("status", ["scheduled", "completed", "called_off", "no_show"]),
        sb.from("shifts").select("id", { count: "exact", head: true })
          .eq("dsp_id", dspId).gte("date", sinceIso)
          .in("status", ["called_off", "no_show"]),
      ]);
      if (scheduledRes.error || absentRes.error) return;
      const total = scheduledRes.count || 0;
      const absences = absentRes.count || 0;
      const rate = total > 0 ? (absences / total * 100) : 0;
      // Inline absence rate hint inside the Cushion field's help line.
      // The span lives in the help text and just shows informational
      // rate; no longer a button.
      labelEl.textContent = total > 0
        ? ` · ${rate.toFixed(1)}% absence last 30d`
        : "";
      labelEl.title = total > 0
        ? `${absences} callouts + no-shows over ${total} scheduled shifts`
        : "";
    } catch (e) {
      console.warn("attendance rate label:", e);
    }
  })();
  const overrideEl = document.getElementById("rr-set-availability-override");
  if (overrideEl) overrideEl.checked = !!s.allow_availability_override;
  const tbEl = document.getElementById("rr-set-pref-tiebreaker");
  if (tbEl) tbEl.value = ["least_loaded","seniority","fairness"].includes(s.preference_tiebreaker) ? s.preference_tiebreaker : "least_loaded";
  // Cache the effective settings so auto-assign reads the per-week values.
  window._rrEffectiveSettings = s;
  if (wavesEl) {
    const waves = Array.isArray(s.waves) && s.waves.length ? s.waves : [{ start: "07:00" }];
    wavesEl.innerHTML = waves.map(w => _renderWaveRow(w.start)).join("");
  }
  // Cache finalized state for guard checks.
  window._rrWeekFinalized = !!s.finalized;
  _updateFinalizeButton();
  if (statusEl) {
    statusEl.style.color = "var(--text-subtle)";
    statusEl.textContent = s.is_inherited
      ? "Inherited from a previous week — Save to make this week's settings independent"
      : `Custom settings for week of ${_schedStart}`;
  }
  loadServiceTypes();
}

let _okamiServiceTypes = null;
async function loadServiceTypes() {
  const wrap = document.getElementById("rr-set-service-types");
  const { data, error } = await sb.rpc("list_service_types");
  if (error) {
    if (wrap) wrap.innerHTML = `<div style="font-size:var(--fs-xs);color:var(--red)">Failed to load: ${escapeHtml(error.message)}</div>`;
    return;
  }
  const types = data || [];
  _okamiServiceTypes = types;
  if (!wrap) return;
  wrap.innerHTML = types.map(t => `
    <div data-rr-st="${t.id}" class="rr-drawer-st-row">
      <label class="rr-toggle" title="Active in OKAMI">
        <input type="checkbox" data-rr-st-active ${t.active ? "checked" : ""}/>
        <span class="rr-toggle-track"><span class="rr-toggle-thumb"></span></span>
      </label>
      <span class="rr-drawer-st-dot" style="background:${escapeHtml(t.color)}"></span>
      <span class="rr-drawer-st-code">${escapeHtml(t.code)}</span>
      <input type="text" data-rr-st-label class="rr-drawer-st-label" value="${escapeHtml(t.label)}"/>
    </div>`).join("");
}

function _renderWaveRow(start) {
  return `<div data-rr-wave class="rr-drawer-wave-row">
    <input type="time" class="form-input" data-rr-wave-time value="${escapeHtml(start || "07:00")}"/>
    <button type="button" class="rr-drawer-wave-remove" data-rr-remove-wave title="Remove" aria-label="Remove wave">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  </div>`;
}

// Service type: toggle active. Refreshes OKAMI rendering since the
// per-(wave × type) row count is driven by the active-type list.
document.addEventListener("change", async (e) => {
  const cb = e.target.closest?.("[data-rr-st-active]");
  if (cb) {
    const row = cb.closest("[data-rr-st]");
    const id = row?.dataset.rrSt;
    if (!id) return;
    const { error } = await sb.rpc("set_service_type", { p_id: id, p_active: cb.checked });
    if (error) { toast("Save failed: " + error.message, "warn"); cb.checked = !cb.checked; return; }
    _okamiServiceTypes = null; // bust cache so OKAMI re-renders with the new active set
    if (typeof renderOkamiLive === "function") renderOkamiLive();
    const openIdx = openOkamiDetailIndex?.();
    if (openIdx != null) renderOkamiDailyPanel(openIdx);
    toast(`${cb.checked ? "Activated" : "Deactivated"} ${row.querySelector("strong")?.textContent || "type"}`, "success");
  }
});

// Service type: rename label on blur.
document.addEventListener("blur", async (e) => {
  const inp = e.target.closest?.("[data-rr-st-label]");
  if (!inp) return;
  const row = inp.closest("[data-rr-st]");
  const id = row?.dataset.rrSt;
  if (!id) return;
  const newLabel = (inp.value || "").trim();
  if (!newLabel) return;
  const { error } = await sb.rpc("set_service_type", { p_id: id, p_label: newLabel });
  if (error) toast("Save failed: " + error.message, "warn");
}, true);

document.addEventListener("click", async (e) => {
  // Add a wave row.
  if (e.target.id === "rr-set-add-wave") {
    e.preventDefault();
    const wavesEl = document.getElementById("rr-set-waves");
    if (!wavesEl) return;
    // Suggest the next slot 25 min after the last wave.
    const lastInput = wavesEl.querySelector("[data-rr-wave]:last-child [data-rr-wave-time]");
    let next = "07:00";
    if (lastInput?.value) {
      const [h, m] = lastInput.value.split(":").map(n => parseInt(n, 10));
      const total = h * 60 + m + 25;
      next = `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    }
    wavesEl.insertAdjacentHTML("beforeend", _renderWaveRow(next));
    return;
  }

  // Remove a wave row. closest() instead of matches() so clicks on
  // the inner SVG icon bubble up to the button correctly.
  if (e.target.closest?.("[data-rr-remove-wave]")) {
    e.preventDefault();
    const row = e.target.closest("[data-rr-wave]");
    if (row) row.remove();
    return;
  }

  // Save scheduling settings.
  if (e.target.id === "rr-set-sched-save") {
    e.preventDefault();
    const dspId = window.RR?.dsp?.id;
    if (!dspId) return;
    if (!_schedStart) _schedStart = fmtIsoDate(startOfWeekMonday(new Date()));

    const block = parseInt(document.getElementById("rr-set-block-hours")?.value, 10) || 10;
    const cushion = parseInt(document.getElementById("rr-set-cushion-pct")?.value, 10) || 0;
    const maxDays = Math.max(1, Math.min(7, parseInt(document.getElementById("rr-set-max-days")?.value, 10) || 5));
    const reportLead = Math.max(0, Math.min(120, parseInt(document.getElementById("rr-set-report-lead")?.value, 10) || 0));
    const allowOverride = !!document.getElementById("rr-set-availability-override")?.checked;
    const waves = Array.from(document.querySelectorAll("#rr-set-waves [data-rr-wave-time]"))
      .map(inp => ({ start: inp.value || "07:00" }))
      .filter(w => w.start);
    if (waves.length === 0) waves.push({ start: "07:00" });
    const tz = (Intl?.DateTimeFormat?.().resolvedOptions().timeZone) || "UTC";

    const status = document.getElementById("rr-set-sched-status");
    const ws = _schedStart;
    if (status) { status.style.color = "var(--text-subtle)"; status.textContent = `Saving settings for week of ${ws}…`; }

    // Per-week save: write a single scheduling_settings row for the
    // visible week. Future weeks without their own row inherit from
    // this one via private.get_week_settings (which falls back to the
    // most-recent prior saved week).
    const prefTiebreaker = (() => {
      const v = document.getElementById("rr-set-pref-tiebreaker")?.value;
      return ["least_loaded","seniority","fairness"].includes(v) ? v : "least_loaded";
    })();
    const payload = {
      week_start: ws,
      default_block_hours: block,
      cushion_pct: cushion,
      max_days_per_week: maxDays,
      allow_availability_override: allowOverride,
      report_lead_minutes: reportLead,
      preference_tiebreaker: prefTiebreaker,
      waves,
      timezone: tz,
    };

    let cushionDelta = 0;
    let failed = null;

    const { error: upErr } = await sb.rpc("upsert_scheduling_settings", { p_payload: payload });
    if (upErr) { failed = upErr.message; }

    if (!failed) {
      const { error: regenErr } = await sb.rpc("regenerate_week_shifts", { p_week_start: ws });
      if (regenErr) { failed = regenErr.message; }
    }

    if (!failed) {
      try {
        const { data, error: cushionErr } = await sb.rpc("apply_cushion_to_week", { p_week_start: ws });
        if (cushionErr) console.warn(`apply_cushion_to_week (${ws}):`, cushionErr.message);
        else cushionDelta = data || 0;
      } catch (e) {
        console.warn(`apply_cushion_to_week (${ws}) threw:`, e);
      }
    }

    if (failed) {
      if (status) { status.style.color = "var(--red)"; status.textContent = "Failed: " + failed; }
      toast("Settings save failed: " + failed, "warn");
      return;
    }

    if (status) {
      status.style.color = "var(--green)";
      const cushionNote = cushionDelta !== 0 ? ` · cushion ${cushionDelta > 0 ? "+" : ""}${cushionDelta}` : "";
      status.textContent = `Saved for week of ${ws} ✓${cushionNote}`;
    }
    setTimeout(() => { if (status) status.textContent = ""; }, 3000);
    toast(`Scheduling settings saved for week of ${ws}`, "success");

    // Refresh schedule view if active.
    if (typeof renderScheduleWeek === "function") {
      const sub = document.getElementById("sched-sub-week");
      if (sub) renderScheduleWeek();
    }
    // Reload settings panel so the inheritance hint updates, then
    // close the drawer so the operator sees the calendar reflecting
    // the new rule.
    loadSchedulingSettings();
    closeSchedSettingsDrawer();
    return;
  }
});

// ─── Schedule · Settings drawer ────────────────────────────────────────
// Settings used to be a full sub-tab under Schedule. It lives next to
// the calendar now: a gear button in the Week-view toolbar opens this
// drawer, and the existing inline "go to settings" links route here
// too.
function openSchedSettingsDrawer() {
  const drawer = document.getElementById("sched-sub-settings");
  const back   = document.getElementById("rr-sched-settings-backdrop");
  if (!drawer || !back) return;
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  back.classList.add("open");
  // Refresh form values against the visible week.
  if (typeof loadSchedulingSettings === "function") loadSchedulingSettings();
}
function closeSchedSettingsDrawer() {
  const drawer = document.getElementById("sched-sub-settings");
  const back   = document.getElementById("rr-sched-settings-backdrop");
  if (drawer) { drawer.classList.remove("open"); drawer.setAttribute("aria-hidden", "true"); }
  if (back)   back.classList.remove("open");
}
window.openSchedSettingsDrawer  = openSchedSettingsDrawer;
window.closeSchedSettingsDrawer = closeSchedSettingsDrawer;

// ─── Schedule · OKAMI overlay ───────────────────────────────────────
// Route planning used to be a separate Schedule sub-tab that called
// goto('okami'). Operators wanted it to live with the week they were
// editing, "kinda like Settings does." A new "Route planning" button
// in the Week-view toolbar opens #view-okami as a full-screen overlay
// anchored on the visible week (_schedStart), instead of always
// rolling forward to "this week + 12".
async function openOkamiOverlay() {
  const okami = document.getElementById("view-okami");
  if (!okami) return;
  // Anchor OKAMI on the week the operator is editing. _renderOkamiLiveImpl
  // reads this override on its next call and clears it.
  if (typeof _schedStart === "string" && _schedStart) {
    window._rrOkamiAnchorOverride = _schedStart;
  }

  // Update the page title BEFORE making the overlay visible. If we
  // add the overlay class first, the operator sees a brief flash of
  // the default "OKAMI" title before our setter swaps it to
  // "Route planning · week of Mon, May 4". Order matters.
  const titleEl = document.getElementById("rr-okami-page-title");
  if (titleEl && typeof _schedStart === "string" && _schedStart) {
    const d = new Date(_schedStart + "T12:00:00");
    const lbl = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    titleEl.textContent = `Route planning · week of ${lbl}`;
  }

  okami.classList.add("rr-okami-overlay");
  const backdrop = document.getElementById("rr-okami-backdrop");
  if (backdrop) backdrop.classList.add("open");

  // Wait for OKAMI to render the 13-week table, then auto-expand
  // week-0's detail panel — that's the daily route-planning editor
  // and the only thing the overlay shows (CSS hides every other
  // row). Without this, the operator opens the overlay and sees an
  // empty white page.
  if (typeof loadOkamiView === "function") {
    try { await loadOkamiView(); } catch (e) { console.warn("OKAMI overlay load:", e); }
  }
  if (typeof window.okamiToggleDaily === "function") {
    const detail = document.getElementById("okami-detail-0");
    if (detail && !detail.classList.contains("open")) {
      window.okamiToggleDaily(0);
    } else if (typeof window.renderOkamiDailyPanel === "function") {
      // Already open from a prior session — just refresh content
      // against the new anchor week.
      window.renderOkamiDailyPanel(0);
    }
  }
}
function closeOkamiOverlay() {
  const okami = document.getElementById("view-okami");
  if (okami) okami.classList.remove("rr-okami-overlay");
  const backdrop = document.getElementById("rr-okami-backdrop");
  if (backdrop) backdrop.classList.remove("open");
  // Restore the strategic page title for the next time someone
  // navigates to OKAMI through any non-overlay path.
  const titleEl = document.getElementById("rr-okami-page-title");
  if (titleEl) {
    titleEl.innerHTML = `OKAMI <span class="rr-okami-13week-badge" style="font-size:var(--fs-xs);font-weight:500;color:var(--text-subtle);background:var(--canvas);border:1px solid var(--border);padding:3px 8px;border-radius:6px;margin-left:8px;letter-spacing:0;text-transform:none;vertical-align:middle" title="Amazon's term for the 13-week DSP route plan horizon">13-week plan</span>`;
  }
}
window.openOkamiOverlay  = openOkamiOverlay;
window.closeOkamiOverlay = closeOkamiOverlay;

// Close the OKAMI overlay when the operator navigates to a different
// sidebar view, so it doesn't sit on top of an unrelated screen.
const _origGotoForOkamiOverlay = window.goto;
window.goto = function (view) {
  if (typeof _origGotoForOkamiOverlay === "function") _origGotoForOkamiOverlay(view);
  if (view !== "schedule" && view !== "okami") closeOkamiOverlay();
};

document.addEventListener("click", (e) => {
  if (e.target.closest("#rr-sched-settings-open")) {
    e.preventDefault();
    openSchedSettingsDrawer();
    return;
  }
  if (e.target.closest("#rr-sched-settings-close") || e.target.id === "rr-sched-settings-backdrop") {
    e.preventDefault();
    closeSchedSettingsDrawer();
    return;
  }
  if (e.target.closest("#rr-sched-okami-open")) {
    e.preventDefault();
    openOkamiOverlay();
    return;
  }
  if (e.target.id === "rr-okami-backdrop") {
    e.preventDefault();
    closeOkamiOverlay();
    return;
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const drawer = document.getElementById("sched-sub-settings");
    if (drawer && drawer.classList.contains("open")) { closeSchedSettingsDrawer(); return; }
    const okami = document.getElementById("view-okami");
    if (okami && okami.classList.contains("rr-okami-overlay")) closeOkamiOverlay();
  }
});

// ─── Schedule · Finalize-and-push + live-edit guard ────────────────────

// Page-header CTA: Finalize & push to drivers, with a Live/Unfinalize
// state once the week is finalized. Was briefly stage-aware (swapped
// to "Smart Fill" when open shifts > 0) but operators expected to
// see Finalize at all times — Smart Fill lives in the toolbar
// alongside it.
function _updateFinalizeButton() {
  const btn = document.getElementById("schedule-cta");
  if (!btn) return;
  const isFinal = !!window._rrWeekFinalized;
  btn.dataset.rrStage = isFinal ? "live" : "finalize";

  // Toolbar pill styling — transparent by default like the other
  // tool buttons. Once the week is finalized we tint it green-soft
  // with a checkmark so the operator can see "live" at a glance
  // without it screaming as a primary CTA.
  if (isFinal) {
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Live`;
    btn.style.background = "var(--green-soft)";
    btn.style.color = "var(--green)";
    btn.style.fontWeight = "600";
    btn.title = "This week is live · drivers see it. Click to take it back to draft.";
  } else {
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> Finalize`;
    btn.style.background = "";
    btn.style.color = "";
    btn.style.fontWeight = "";
    btn.title = "Push this week's schedule to drivers";
  }
}
window._rrUpdateScheduleCta = _updateFinalizeButton;

async function _setWeekFinalized(target) {
  const dspId = window.RR?.dsp?.id;
  if (!dspId || !_schedStart) return;
  const { error } = await sb.rpc("set_schedule_finalized", { p_week_start: _schedStart, p_finalized: target });
  if (error) { toast("Failed: " + error.message, "warn"); return; }
  window._rrWeekFinalized = target;
  _updateFinalizeButton();
  toast(target ? "Schedule finalized · drivers can see it" : "Unfinalized · back to draft", "success");
}

// Returns true if the operator confirms editing a live schedule. Always true
// when the week isn't finalized.
function _confirmLiveScheduleEdit() {
  if (!window._rrWeekFinalized) return true;
  return confirm("This week's schedule is LIVE — drivers may have already seen it.\n\nMake the change anyway?");
}

document.addEventListener("click", async (e) => {
  if (e.target.closest("#schedule-cta")) {
    e.preventDefault();
    const target = !window._rrWeekFinalized;
    if (target) {
      if (!confirm("Finalize this week and mark it as live for drivers? Edits after this will trigger a warning prompt.")) return;
    }
    await _setWeekFinalized(target);
  }
});

// Wrap the mockup schedSub so the new Insights tab loads live data.
const _legacySchedSub = window.schedSub;
window.schedSub = function (sub) {
  if (typeof _legacySchedSub === "function") _legacySchedSub(sub);
  if (sub === "insights") loadScheduleInsights();
  if (sub === "rules")  { loadStationGeofences(); loadAttendanceWindows(); }
};

async function loadAttendanceWindows() {
  const wrap = document.getElementById("rr-att-windows");
  if (!wrap) return;
  if (wrap.dataset.rrWired === "1") return;
  wrap.dataset.rrWired = "1";
  const { data, error } = await sb.rpc("attendance_settings_get");
  if (error) return;
  const lead  = document.getElementById("rr-att-lead");
  const grace = document.getElementById("rr-att-grace");
  const ncns  = document.getElementById("rr-att-ncns");
  if (lead)  lead.value  = Number(data?.checkin_lead_minutes ?? 15);
  if (grace) grace.value = Number(data?.tardy_grace_minutes  ?? 10);
  if (ncns)  ncns.value  = Number(data?.ncns_after_minutes   ?? 60);
  document.getElementById("rr-att-windows-save").addEventListener("click", async () => {
    const btn = document.getElementById("rr-att-windows-save");
    btn.disabled = true; const orig = btn.textContent; btn.textContent = "Saving…";
    const { error: se } = await sb.rpc("attendance_settings_set", {
      p_lead:  Number(lead.value || 15),
      p_grace: Number(grace.value || 10),
      p_ncns:  Number(ncns.value || 60),
    });
    btn.disabled = false; btn.textContent = orig;
    if (se) { toast("Save failed: " + se.message, "warn"); return; }
    toast("Attendance windows saved", "success");
  });
}

// ─── Schedule · Rules · station geofences ─────────────────────────────
async function loadStationGeofences() {
  const wrap = document.getElementById("rr-station-geofences");
  if (!wrap) return;
  const { data, error } = await sb.rpc("stations_with_geofence");
  if (error) {
    wrap.innerHTML = `<div style="padding:14px;color:var(--red);font-size:var(--fs-md)">${escapeHtml(error.message)}</div>`;
    return;
  }
  const rows = data || [];
  if (rows.length === 0) {
    wrap.innerHTML = `<div class="rr-empty-inline">No active stations.</div>`;
    return;
  }
  wrap.innerHTML = rows.map((s) => {
    const hasPin = s.latitude != null && s.longitude != null;
    const lat = s.latitude  != null ? Number(s.latitude).toFixed(6)  : "";
    const lng = s.longitude != null ? Number(s.longitude).toFixed(6) : "";
    return `
      <div class="station-geofence" data-rr-station-id="${escapeHtml(s.id)}" style="display:grid;grid-template-columns:120px 160px 160px 100px auto;gap:10px;padding:12px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--surface);margin-bottom:10px;align-items:end">
        <div>
          <label style="display:block;font-size:var(--fs-xs);font-weight:600;color:var(--text-subtle);margin-bottom:3px">Station</label>
          <div style="font-size:var(--fs-base);font-weight:600">${escapeHtml(s.code)}</div>
          <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:1px">${hasPin ? "Pin set" : "No pin yet"}</div>
        </div>
        <div>
          <label style="display:block;font-size:var(--fs-xs);font-weight:600;color:var(--text-subtle);margin-bottom:3px">Latitude</label>
          <input class="rr-station-lat field" style="font-size:var(--fs-md);padding:8px 10px" value="${escapeHtml(lat)}" placeholder="e.g. 40.712776"/>
        </div>
        <div>
          <label style="display:block;font-size:var(--fs-xs);font-weight:600;color:var(--text-subtle);margin-bottom:3px">Longitude</label>
          <input class="rr-station-lng field" style="font-size:var(--fs-md);padding:8px 10px" value="${escapeHtml(lng)}" placeholder="e.g. -74.005974"/>
        </div>
        <div>
          <label style="display:block;font-size:var(--fs-xs);font-weight:600;color:var(--text-subtle);margin-bottom:3px">Radius (m)</label>
          <input class="rr-station-radius field" type="number" min="25" max="2000" style="font-size:var(--fs-md);padding:8px 10px" value="${Number(s.geofence_radius_meters || 150)}"/>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm" data-rr-station-locate type="button" title="Use this device's GPS">Use current</button>
          <button class="btn btn-sm btn-primary" data-rr-station-save type="button">Save</button>
        </div>
      </div>`;
  }).join("");

  if (wrap.dataset.rrWired === "1") return;
  wrap.dataset.rrWired = "1";
  wrap.addEventListener("click", async (e) => {
    const row = e.target.closest(".station-geofence");
    if (!row) return;
    const id  = row.getAttribute("data-rr-station-id");
    const latI = row.querySelector(".rr-station-lat");
    const lngI = row.querySelector(".rr-station-lng");
    const radI = row.querySelector(".rr-station-radius");

    if (e.target.closest("[data-rr-station-locate]")) {
      if (!("geolocation" in navigator)) { toast("Geolocation not available", "warn"); return; }
      const btn = e.target.closest("[data-rr-station-locate]");
      btn.disabled = true; const orig = btn.textContent; btn.textContent = "Locating…";
      navigator.geolocation.getCurrentPosition((pos) => {
        latI.value = pos.coords.latitude.toFixed(6);
        lngI.value = pos.coords.longitude.toFixed(6);
        btn.disabled = false; btn.textContent = orig;
      }, (err) => {
        btn.disabled = false; btn.textContent = orig;
        toast("Couldn't get location: " + err.message, "warn");
      }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
      return;
    }

    if (e.target.closest("[data-rr-station-save]")) {
      const lat = Number(latI.value);
      const lng = Number(lngI.value);
      const r   = Number(radI.value);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) { toast("Enter valid lat/lng", "warn"); return; }
      const btn = e.target.closest("[data-rr-station-save]");
      btn.disabled = true; const orig = btn.textContent; btn.textContent = "Saving…";
      const { error } = await sb.rpc("station_set_geofence", {
        p_station_id: id, p_latitude: lat, p_longitude: lng, p_radius_m: r,
      });
      btn.disabled = false; btn.textContent = orig;
      if (error) { toast("Save failed: " + error.message, "warn"); return; }
      toast("Saved", "success");
      loadStationGeofences();
    }
  });
}

// ─── Schedule · Insights · driver availability by day of week ──────────
// Hosted in #sched-sub-insights when called with no args; accepts a
// scope element so the same chart can be reused inside the Drivers →
// Availability → Insights sub-tab. Looks up DOM via getAttribute hooks
// so two copies can coexist on the page without ID collisions.
async function loadScheduleInsights(scope) {
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;
  scope = scope || document;
  const wrap       = scope.querySelector ? scope.querySelector("[data-rr-avail-bars]")    || document.getElementById("rr-avail-bars")    : document.getElementById("rr-avail-bars");
  const summaryEl  = scope.querySelector ? scope.querySelector("[data-rr-avail-summary]") || document.getElementById("rr-avail-summary") : document.getElementById("rr-avail-summary");
  const insightEl  = scope.querySelector ? scope.querySelector("[data-rr-avail-insight]") || document.getElementById("rr-avail-insight") : document.getElementById("rr-avail-insight");
  if (!wrap) return;

  const today = new Date();
  const monday = startOfWeekMonday(today);
  const startIso = fmtIsoDate(monday);
  const horizonWeeks = 4;

  // Pull active drivers (with availability metadata) + OKAMI demand for
  // the next 4 weeks so we can compute peak demand per day of week.
  const [drvRes, gridRes] = await Promise.all([
    sb.from("drivers")
      .select("id, full_name, status, metadata")
      .eq("dsp_id", dspId)
      .in("status", ["active", "onboarding"]),
    sb.rpc("okami_grid", { p_start: startIso, p_weeks: horizonWeeks }),
  ]);
  if (drvRes.error) {
    wrap.innerHTML = `<div style="padding:18px;color:var(--red);font-size:var(--fs-md)">Failed to load drivers: ${escapeHtml(drvRes.error.message)}</div>`;
    return;
  }
  const drivers = drvRes.data || [];

  // Per-day available count from drivers.metadata.availability.days.
  const DOW = ["mon","tue","wed","thu","fri","sat","sun"];
  const DOW_LABEL = { mon:"Mon", tue:"Tue", wed:"Wed", thu:"Thu", fri:"Fri", sat:"Sat", sun:"Sun" };
  const availByDay = Object.fromEntries(DOW.map(d => [d, 0]));
  let driversWithoutAvailability = 0;
  for (const d of drivers) {
    const days = d.metadata?.availability?.days;
    if (!Array.isArray(days) || days.length === 0) {
      driversWithoutAvailability += 1;
      continue;
    }
    for (const day of days) {
      if (availByDay.hasOwnProperty(day)) availByDay[day] += 1;
    }
  }

  // Per-day peak demand from OKAMI: max routes_max for any week of that
  // day of week, × 2 × (1 + plan_pad/100). The same math used in OKAMI.
  const padPct = Math.max(0, Math.min(50, Number(window.RR?.dsp?.metadata?.staffing?.plan_pad_pct ?? 10) || 0));
  const cells = (gridRes?.data || []);
  // Routes total per date, summed across stations.
  const routesByDate = new Map();
  for (const c of cells) routesByDate.set(c.date, (routesByDate.get(c.date) || 0) + (c.target_routes || 0));
  // Peak routes per day-of-week across the horizon.
  const peakRoutesByDow = Object.fromEntries(DOW.map(d => [d, 0]));
  // JS getDay: 0=Sun, 1=Mon, ..., 6=Sat. Map to our DOW key.
  const JS_DOW = { 0:"sun", 1:"mon", 2:"tue", 3:"wed", 4:"thu", 5:"fri", 6:"sat" };
  for (const [iso, routes] of routesByDate.entries()) {
    const dow = JS_DOW[new Date(iso + "T12:00:00").getDay()];
    if (routes > peakRoutesByDow[dow]) peakRoutesByDow[dow] = routes;
  }
  const neededByDow = {};
  for (const d of DOW) {
    neededByDow[d] = peakRoutesByDow[d] > 0 ? Math.ceil(peakRoutesByDow[d] * 2 * (1 + padPct / 100)) : 0;
  }

  // Bar chart. Width scales to total active drivers so the longest bar
  // shows roster-wide availability. Color reflects gap to needed.
  const totalDrivers = drivers.length;
  const maxBar = Math.max(1, totalDrivers);
  const tightDays = [];
  const shortDays = [];
  const okDays = [];

  // Percent of roster available per day. Color thresholds based on the
  // share of the roster, not absolute headcount.
  const rows = DOW.map(day => {
    const avail = availByDay[day];
    const needed = neededByDow[day];
    const pct = totalDrivers > 0 ? (avail / totalDrivers) * 100 : 0;
    const widthPct = Math.round(pct);
    let color = "var(--green-bright)", note = "";
    if (totalDrivers === 0) {
      color = "var(--text-muted)";
      note = "no roster";
      okDays.push(day);
    } else if (pct >= 75) {
      color = "var(--green-bright)";
      note = needed > 0 && avail < needed ? `short by ${needed - avail}` : "healthy";
      okDays.push(day);
    } else if (pct >= 50) {
      color = "var(--amber)";
      note = needed > 0 && avail < needed ? `short by ${needed - avail}` : "tight";
      tightDays.push(day);
    } else {
      color = "var(--red)";
      note = needed > 0 && avail < needed ? `short by ${needed - avail}` : "low coverage";
      shortDays.push(day);
    }
    return `
      <div style="display:grid;grid-template-columns:60px 1fr 90px 110px;align-items:center;gap:12px;padding:6px 0">
        <div style="font-size:var(--fs-sm);font-weight:600;color:var(--text)">${DOW_LABEL[day]}</div>
        <div style="background:var(--canvas);height:14px;border-radius:7px;overflow:hidden">
          <div style="background:${color};height:100%;width:${widthPct}%;transition:width .3s"></div>
        </div>
        <div style="font-size:var(--fs-md);color:var(--text);font-variant-numeric:tabular-nums"><strong>${widthPct}%</strong> <span style="color:var(--text-subtle);font-size:var(--fs-xs)">${avail}/${totalDrivers}</span></div>
        <div style="font-size:var(--fs-xs);color:var(--text-subtle)">${note}</div>
      </div>`;
  }).join("");

  wrap.innerHTML = rows;

  if (summaryEl) {
    summaryEl.textContent = `${totalDrivers} active driver${totalDrivers === 1 ? "" : "s"}${driversWithoutAvailability > 0 ? ` · ${driversWithoutAvailability} without availability set` : ""}`;
  }

  if (insightEl) {
    const dayName = (k) => DOW_LABEL[k];
    const lines = [];
    if (totalDrivers === 0) {
      lines.push("Add active drivers to see availability coverage.");
    } else if (driversWithoutAvailability === totalDrivers) {
      lines.push(`No drivers have availability set yet. Open a driver record → Availability tab and check the days they can work.`);
    } else {
      if (shortDays.length > 0) {
        lines.push(`<strong style="color:var(--red)">Low coverage:</strong> ${shortDays.map(dayName).join(", ")} — under 50% of your roster is available. Hire or expand availability for these days.`);
      }
      if (tightDays.length > 0) {
        lines.push(`<strong style="color:var(--amber)">Tight:</strong> ${tightDays.map(dayName).join(", ")} — 50–75% of your roster is available. One callout strains the day.`);
      }
      if (shortDays.length === 0 && tightDays.length === 0) {
        lines.push(`<strong style="color:var(--green)">Healthy across the week.</strong> Every day has 75%+ of your roster available.`);
      }
      if (driversWithoutAvailability > 0) {
        lines.push(`${driversWithoutAvailability} driver${driversWithoutAvailability === 1 ? "" : "s"} ${driversWithoutAvailability === 1 ? "has" : "have"} no availability set — they aren't counted above. Set their days in the driver record → Availability tab.`);
      }
    }
    insightEl.innerHTML = lines.join("<br>");
  }

  // Cache the math context for the (i) popover.
  _availMath = { totalDrivers, driversWithoutAvailability, padPct, horizonWeeks, peakRoutesByDow, neededByDow, availByDay };
}

let _availMath = null;
document.addEventListener("click", (e) => {
  if (!e.target.closest("#rr-avail-info")) return;
  e.preventDefault();
  const m = _availMath;
  if (!m) return;
  const old = document.getElementById("rr-avail-popover");
  if (old) { old.remove(); return; }
  const DOW = ["mon","tue","wed","thu","fri","sat","sun"];
  const DOW_LABEL = { mon:"Mon", tue:"Tue", wed:"Wed", thu:"Thu", fri:"Fri", sat:"Sat", sun:"Sun" };
  const tableRows = DOW.map(d => {
    const pct = m.totalDrivers > 0 ? Math.round((m.availByDay[d] / m.totalDrivers) * 100) : 0;
    const pctColor = pct >= 75 ? "var(--green)" : pct >= 50 ? "var(--amber)" : "var(--red)";
    return `
    <tr>
      <td style="padding:5px 10px;border-bottom:1px solid var(--border)"><strong>${DOW_LABEL[d]}</strong></td>
      <td style="padding:5px 10px;border-bottom:1px solid var(--border);text-align:right">${m.availByDay[d]}</td>
      <td style="padding:5px 10px;border-bottom:1px solid var(--border);text-align:right;font-weight:700;color:${pctColor}">${pct}%</td>
      <td style="padding:5px 10px;border-bottom:1px solid var(--border);text-align:right;color:var(--text-subtle)">${m.neededByDow[d] || "—"}</td>
    </tr>`;
  }).join("");
  const pop = document.createElement("div");
  pop.id = "rr-avail-popover";
  pop.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px";
  pop.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:22px;max-width:560px;width:100%;font-size:var(--fs-md);line-height:1.55;color:var(--text);max-height:80vh;overflow-y:auto">
      <h3 style="margin:0 0 14px;font-size:var(--fs-lg);font-weight:600">Availability insight · the math</h3>

      <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.05em;text-transform:uppercase;margin-bottom:6px">Inputs</div>
      <div>Active roster: <strong>${m.totalDrivers}</strong> driver${m.totalDrivers === 1 ? "" : "s"}</div>
      <div>Without availability set: <strong>${m.driversWithoutAvailability}</strong></div>
      <div>Plan Pad: <strong>${m.padPct}%</strong> <span style="color:var(--text-subtle)">(from OKAMI)</span></div>
      <div>Horizon: next <strong>${m.horizonWeeks}</strong> weeks of OKAMI demand</div>

      <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.05em;text-transform:uppercase;margin-top:14px;margin-bottom:6px">Per-day math</div>
      <div style="font-size:var(--fs-sm);color:var(--text-subtle);margin-bottom:6px">For each day, we count the active drivers whose availability includes that day, then divide by total active drivers.</div>
      <div style="font-family:ui-monospace,monospace;font-size:var(--fs-xs);background:var(--canvas);padding:8px 10px;border-radius:4px;color:var(--text)">% available = available_drivers ÷ total_active_drivers</div>
      <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:6px">Needed column shows OKAMI peak demand for context: <code>ceil(peak_routes × 2 × (1 + ${m.padPct}%))</code>.</div>
      <table style="width:100%;border-collapse:collapse;font-size:var(--fs-sm);margin-top:10px">
        <thead>
          <tr>
            <th style="padding:6px 10px;text-align:left;background:var(--canvas);font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Day</th>
            <th style="padding:6px 10px;text-align:right;background:var(--canvas);font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Available</th>
            <th style="padding:6px 10px;text-align:right;background:var(--canvas);font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">% of roster</th>
            <th style="padding:6px 10px;text-align:right;background:var(--canvas);font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Needed</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>

      <div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-muted);letter-spacing:.05em;text-transform:uppercase;margin-top:14px;margin-bottom:6px">Color thresholds</div>
      <div>· <strong style="color:var(--green-bright)">Green</strong> = 75%+ of roster available</div>
      <div>· <strong style="color:var(--amber)">Amber</strong> = 50–75% available (tight)</div>
      <div>· <strong style="color:var(--red)">Red</strong> = under 50% available (low coverage)</div>

      <div style="margin-top:18px;display:flex;justify-content:flex-end">
        <button class="btn btn-sm" type="button" id="rr-avail-popover-close">Close</button>
      </div>
    </div>`;
  pop.addEventListener("click", (ev) => {
    if (ev.target === pop || ev.target.id === "rr-avail-popover-close") pop.remove();
  });
  document.body.appendChild(pop);
});

async function loadScheduleView() {
  // Wrap every step so a single thrown function (missing helper,
  // schema mismatch, etc.) can't blank the entire schedule view.
  // Each error gets a console warning; the page keeps rendering.
  try { _clearScheduleMockup(); } catch (e) { console.warn("schedule · clearMockup:", e); }
  try { loadTimeOffList();      } catch (e) { console.warn("schedule · timeOff:", e); }
  try { loadOpenShifts();       } catch (e) { console.warn("schedule · openShifts:", e); }
  try {
    // Settings has to land BEFORE renderScheduleWeek runs — it reads
    // window._rrWeekFinalized to decide whether to show the LIVE
    // banner.  Previously these ran in parallel, which made the
    // banner flicker.
    await loadSchedulingSettings();
  } catch (e) { console.warn("schedule · settings:", e); }
  try { await renderScheduleWeek(); } catch (e) {
    console.warn("schedule · renderWeek:", e);
    const sub = document.getElementById("sched-sub-week");
    if (sub) {
      sub.innerHTML = `<div style="padding:48px;text-align:center;color:var(--red);font-size:var(--fs-md)">Couldn't render the schedule week.<br><small>${escapeHtml(e?.message || String(e))}</small></div>`;
    }
  }
  try { bindSchedWeekNav(); } catch (e) { console.warn("schedule · navBind:", e); }
}

function _clearScheduleMockup() {
  // Neutralize the mockup OKAMI day-shifts injector — it runs 50ms after
  // view switch and stamps 'ø XX shifts' onto every cell head, undoing
  // our live render.
  if (typeof window !== "undefined") {
    window.okamiRenderScheduleDayHeaders = function () {};
  }
  const sub = document.getElementById("sched-sub-week");
  if (!sub) return;
  const wrap = sub.querySelector(".cal-wrap");
  if (wrap) {
    Array.from(wrap.children).forEach(el => {
      if (!el.classList.contains("head")) el.remove();
    });
    // Strip any leftover .day-shifts spans on heads.
    wrap.querySelectorAll(".cal-cell-head .day-shifts").forEach(el => el.remove());
  }
  const aside = sub.querySelector("aside.driver-pool");
  if (aside) {
    Array.from(aside.children).forEach(el => {
      if (!el.classList.contains("pool-head") && el.tagName !== "INPUT") el.remove();
    });
  }
  // Remove the dynamically-injected mockup license banner if present.
  const lic = document.getElementById("sched-license-banner");
  if (lic) lic.remove();
}

// Override the mockup AI-schedule modal — replace with a real auto-fill that
// creates open shifts wherever OKAMI demand exceeds current shift count.
window.openAiSchedule = async function () {
  await autoFillScheduleWeek();
};

async function autoFillScheduleWeek() {
  const dspId = window.RR?.dsp?.id;
  if (!dspId) { toast("DSP not loaded", "warn"); return; }
  if (!_schedStart) _schedStart = fmtIsoDate(startOfWeekMonday(new Date()));
  if (!_confirmLiveScheduleEdit()) return;

  // Use generate_shifts_for_date instead of raw create_shift — this both
  // FILLS gaps and TRIMS excess, so the schedule mirrors OKAMI exactly
  // and any drifted-up counts get cleaned up.
  const { data: cells, error } = await sb.rpc("okami_grid", { p_start: _schedStart, p_weeks: 1 });
  if (error) { toast("Sync failed: " + error.message, "warn"); return; }

  const dateStations = new Map();
  for (const c of (cells || [])) {
    if (!c.station_id) continue;
    dateStations.set(`${c.date}|${c.station_id}`, { date: c.date, station_id: c.station_id });
  }
  if (dateStations.size === 0) { toast("No OKAMI demand for this week", "warn"); return; }

  const calls = Array.from(dateStations.values()).map(d =>
    sb.rpc("generate_shifts_for_date", { p_date: d.date, p_station_id: d.station_id })
  );

  const results = await Promise.all(calls);
  const failed = results.filter(r => r.error);
  if (failed.length === calls.length) {
    toast("Sync failed: " + (failed[0].error?.message || "unknown error"), "warn");
    return;
  }
  if (failed.length > 0) {
    toast(`Synced ${calls.length - failed.length} of ${calls.length} day-stations · ${failed.length} failed`, "warn");
  } else {
    // Now try to auto-assign drivers to the freshly-generated open shifts
    // based on each driver's availability metadata.
    const { assigned, skippedExpired } = await autoAssignDriversForWeek();
    if (assigned > 0) {
      toast(`Schedule synced · ${assigned} shift${assigned === 1 ? "" : "s"} auto-assigned`, "success");
    } else {
      toast("Schedule synced with OKAMI plan", "success");
    }
    // Surface drivers blocked by expired/missing license. Use alert so
    // the operator actually sees it (toast vanishes too quick to act on).
    if (skippedExpired && skippedExpired.length > 0) {
      const lines = skippedExpired.map(s =>
        `  • ${s.full_name} — expired ${new Date(s.expires_on + "T12:00:00").toLocaleDateString()}`
      ).join("\n");
      alert(`Auto-schedule skipped ${skippedExpired.length} driver${skippedExpired.length === 1 ? "" : "s"} with an expired driver's license:\n\n${lines}\n\nUpdate the expiration in the driver record → License tab to include them in future runs.`);
    }
  }
  await renderScheduleWeek();
}

// Auto-assign drivers to open shifts in the current week based on each
// driver's metadata.availability.days (mon/tue/wed/...). Skips drivers who
// are on approved PTO that day or already have a shift on that date.
// Picks the least-loaded eligible driver each round so workload spreads.
async function autoAssignDriversForWeek() {
  const dspId = window.RR?.dsp?.id;
  if (!dspId || !_schedStart) return 0;

  const weekEnd = addDays(new Date(_schedStart + "T12:00:00"), 6);
  const weekEndIso = fmtIsoDate(weekEnd);

  // Read the per-week settings (max days, override flag, preferred-day
  // tiebreaker) so they come from the visible week, not stale DSP metadata.
  let maxDays = 5;
  let allowOverride = false;
  let tiebreaker = "least_loaded";
  try {
    const { data: ws } = await sb.rpc("scheduling_settings_for_week", { p_week_start: _schedStart });
    if (ws) {
      maxDays = Math.max(1, Math.min(7, ws.max_days_per_week ?? 5));
      allowOverride = !!ws.allow_availability_override;
      if (["seniority","fairness"].includes(ws.preference_tiebreaker)) tiebreaker = ws.preference_tiebreaker;
    }
  } catch (_) { /* fall back to defaults */ }

  // Pull drivers + their cert flags, the per-week shifts (with their
  // service_type_id so we can check cert requirements), the active
  // service types (which carry requires_dot / requires_xl), and any
  // approved PTO inside the week.
  const [driversRes, ptoRes, shiftsRes, svcRes] = await Promise.all([
    sb.from("drivers")
      .select("id, full_name, hire_date, metadata, dl_expires_on, dot_certified, xl_certified")
      .eq("dsp_id", dspId)
      .eq("status", "active")
      .order("full_name"),
    sb.from("time_off_requests")
      .select("driver_id, start_date, end_date")
      .eq("dsp_id", dspId)
      .eq("status", "approved")
      .lte("start_date", weekEndIso)
      .gte("end_date", _schedStart),
    sb.from("shifts")
      .select("id, date, station_id, driver_id, status, starts_at, ends_at, is_cushion, service_type_id")
      .eq("dsp_id", dspId)
      .gte("date", _schedStart)
      .lte("date", weekEndIso),
    sb.from("service_types")
      .select("id, code, label, requires_dot, requires_xl")
      .eq("dsp_id", dspId),
  ]);

  if (driversRes.error || shiftsRes.error) {
    console.warn("auto-assign load failed:", driversRes.error || shiftsRes.error);
    return { assigned: 0, skippedExpired: [] };
  }

  const drivers = driversRes.data || [];
  const pto     = ptoRes.data     || [];
  // Map service_type_id → { requires_dot, requires_xl } so we can
  // gate driver eligibility per shift.
  const serviceCerts = new Map();
  for (const s of (svcRes?.data || [])) {
    serviceCerts.set(s.id, { requires_dot: !!s.requires_dot, requires_xl: !!s.requires_xl });
  }
  const driverHasCertsFor = (driver, serviceTypeId) => {
    const cert = serviceCerts.get(serviceTypeId);
    if (!cert) return true; // unknown service type → don't gate
    if (cert.requires_dot && !driver.dot_certified) return false;
    if (cert.requires_xl  && !driver.xl_certified)  return false;
    return true;
  };
  let   shifts  = shiftsRes.data  || [];

  // Per-(driver, date) effective availability — picks the latest
  // approved availability request whose effective_from <= shift_date,
  // falling back to drivers.metadata.availability.days. So a future
  // approval (lead-time > 0) doesn't bleed into shifts dated before
  // its effective_from.
  const effAvail = new Map(); // key = `${driver_id}:${iso}` → string[] of day codes
  if (drivers.length > 0) {
    const datesIso = [];
    {
      let cur = new Date(_schedStart + "T12:00:00");
      const end = new Date(weekEndIso + "T12:00:00");
      while (cur <= end) { datesIso.push(fmtIsoDate(cur)); cur = addDays(cur, 1); }
    }
    const { data: effRows, error: effErr } = await sb.rpc("driver_effective_days_for_drivers", {
      p_driver_ids: drivers.map(d => d.id),
      p_dates:      datesIso,
    });
    if (effErr) {
      console.warn("driver_effective_days_for_drivers failed:", effErr);
    } else if (Array.isArray(effRows)) {
      for (const row of effRows) {
        effAvail.set(`${row.driver_id}:${row.on_date}`, row.days || []);
      }
    }
  }
  const driverDaysOn = (driverId, iso) => {
    const v = effAvail.get(`${driverId}:${iso}`);
    if (Array.isArray(v)) return v;
    // Fallback to legacy metadata when the RPC didn't return a row.
    const d = drivers.find(x => x.id === driverId);
    return (d?.metadata?.availability?.days) || [];
  };

  // License rule: drivers.dl_expires_on must be on/after the SHIFT date.
  // A driver whose DL expires Wednesday gets auto-assigned to Mon/Tue/Wed
  // but blocked from Thu/Fri. No other document type (DOT, background
  // check, etc.) blocks here — only the drivers license. Drivers without
  // dl_expires_on aren't blocked (operator hasn't filled it in yet).
  const todayIso = fmtIsoDate(new Date());
  const driverLicenseOkForDate = (d, isoDate) => {
    if (!d.dl_expires_on) return true;
    return d.dl_expires_on >= isoDate;
  };
  // Pre-loop notification still uses today: "currently expired" drivers
  // are the ones the operator should renew. A driver expiring mid-week
  // surfaces as missing assignments for those days rather than a banner.
  const driverLicenseOk = (d) => driverLicenseOkForDate(d, todayIso);

  // Pre-collect drivers blocked by an expired license so we can notify
  // the operator after the run.
  const skippedExpired = [];
  for (const d of drivers) {
    if (!driverLicenseOk(d)) {
      skippedExpired.push({
        id: d.id,
        full_name: d.full_name,
        expires_on: d.dl_expires_on,
      });
    }
  }

  // Aggressive reset: unassign EVERY driver from EVERY shift so the
  // priority sort (regular → cushion) runs from a clean slate. Anything
  // good will be re-assigned identically in the loop below; anything
  // misplaced gets re-prioritized.
  const allAssigned = shifts.filter(sh => sh.driver_id && sh.status === "scheduled");
  if (allAssigned.length > 0) {
    const ids = allAssigned.map(sh => sh.id);
    const { error: clearErr } = await sb.from("shifts")
      .update({ driver_id: null })
      .in("id", ids);
    if (clearErr) {
      console.warn("auto-assign clear failed:", clearErr);
    } else {
      const cleared = new Set(ids);
      shifts = shifts.map(sh => cleared.has(sh.id) ? { ...sh, driver_id: null } : sh);
    }
  }

  const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

  // Per-driver: dates already booked (so we don't double-assign one driver
  // to two shifts on the same day).
  const driverShiftDates = new Map();
  for (const sh of shifts) {
    if (!sh.driver_id) continue;
    if (!driverShiftDates.has(sh.driver_id)) driverShiftDates.set(sh.driver_id, new Set());
    driverShiftDates.get(sh.driver_id).add(sh.date);
  }

  // PTO map: driver_id -> Set<iso>.
  const driverPtoDates = new Map();
  for (const t of pto) {
    if (!driverPtoDates.has(t.driver_id)) driverPtoDates.set(t.driver_id, new Set());
    let cur = new Date(t.start_date + "T12:00:00");
    const end = new Date(t.end_date + "T12:00:00");
    while (cur <= end) {
      driverPtoDates.get(t.driver_id).add(fmtIsoDate(cur));
      cur = addDays(cur, 1);
    }
  }

  // Sort: date asc → regular shifts before cushion (extras) → starts_at asc.
  // Default rule per the operator: fill non-cushion before EX shifts so the
  // buffer only gets a driver after all the planned routes are covered.
  const openShifts = shifts.filter(sh => !sh.driver_id && sh.status === "scheduled")
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      const ac = a.is_cushion ? 1 : 0;
      const bc = b.is_cushion ? 1 : 0;
      if (ac !== bc) return ac - bc;
      return (a.starts_at || "").localeCompare(b.starts_at || "");
    });

  // ── Preferred days ──────────────────────────────────────────────────
  // Each driver's preferred days (clamped to their available set), the
  // lifetime "preference honored" counter for the 'fairness' tiebreaker.
  const preferredOf = new Map();
  const prefBase    = new Map();
  for (const d of drivers) {
    preferredOf.set(d.id, _preferredDaysOf(d));
    prefBase.set(d.id, Number(d.metadata?.scheduling?.pref_honored) || 0);
  }

  // Every hard gate except the day-of-week one (kept separate so the
  // preference pass can restrict to "available AND prefers this day").
  // Expired DL / missing cert / PTO / already-shifted-that-day / over the
  // weekly cap / can't-start-that-early all block regardless of override.
  const eligible = (d, sh, booked) => {
    if (!driverLicenseOkForDate(d, sh.date)) return false;
    if (!driverHasCertsFor(d, sh.service_type_id)) return false;
    if (driverPtoDates.get(d.id)?.has(sh.date)) return false;
    if (booked.get(d.id)?.has(sh.date)) return false;
    if ((booked.get(d.id)?.size || 0) >= maxDays) return false;
    const es = d.metadata?.availability?.earliest_start;
    if (es && _startsBeforeEarliest(_shiftStartHM(sh.starts_at), es)) return false;
    return true;
  };
  const availableOn = (d, sh, dow) => driverDaysOn(d.id, sh.date).includes(dow);
  const loadOf = (id, booked) => booked.get(id)?.size || 0;

  // Winner among candidates per the DSP's configured tiebreaker; all modes
  // fall back to least-loaded so a tie is still resolved deterministically.
  const pickWinner = (cands, booked, prefBumps) => {
    const score = (d) => {
      if (tiebreaker === "seniority") return [d.hire_date || "9999-12-31", loadOf(d.id, booked)];
      if (tiebreaker === "fairness")  return [(prefBase.get(d.id) || 0) + (prefBumps.get(d.id) || 0), loadOf(d.id, booked)];
      return [loadOf(d.id, booked), 0];
    };
    let best = null, bestScore = null;
    for (const d of cands) {
      const s = score(d);
      if (!best) { best = d; bestScore = s; continue; }
      let cmp = 0;
      for (let i = 0; i < s.length; i++) { if (s[i] < bestScore[i]) { cmp = -1; break; } if (s[i] > bestScore[i]) { cmp = 1; break; } }
      if (cmp < 0) { best = d; bestScore = s; }
    }
    return best;
  };

  // Build an assignment plan (no DB writes). With usePreferences on, a
  // first pass seats drivers on shifts that land on a day they prefer
  // (per the tiebreaker), then a second pass fills the rest by
  // least-loaded — with the availability-override fallback when allowed.
  const buildPlan = (usePreferences) => {
    const booked = new Map();
    for (const [k, v] of driverShiftDates) booked.set(k, new Set(v));
    const prefBumps = new Map();
    const assignments = new Map();
    const seat = (sh, d) => {
      assignments.set(sh.id, d.id);
      if (!booked.has(d.id)) booked.set(d.id, new Set());
      booked.get(d.id).add(sh.date);
    };
    if (usePreferences) {
      for (const sh of openShifts) {
        const dow = DOW[new Date(sh.date + "T12:00:00").getDay()];
        const cands = drivers.filter(d => preferredOf.get(d.id)?.has(dow) && availableOn(d, sh, dow) && eligible(d, sh, booked));
        if (cands.length === 0) continue;
        const w = pickWinner(cands, booked, prefBumps);
        if (!w) continue;
        seat(sh, w);
        prefBumps.set(w.id, (prefBumps.get(w.id) || 0) + 1);
      }
    }
    for (const sh of openShifts) {
      if (assignments.has(sh.id)) continue;
      const dow = DOW[new Date(sh.date + "T12:00:00").getDay()];
      let cands = drivers.filter(d => availableOn(d, sh, dow) && eligible(d, sh, booked));
      if (cands.length === 0 && allowOverride) cands = drivers.filter(d => eligible(d, sh, booked));
      if (cands.length === 0) continue;
      cands.sort((a, b) => loadOf(a.id, booked) - loadOf(b.id, booked));
      seat(sh, cands[0]);
    }
    return { assignments, prefBumps, covered: assignments.size };
  };

  // Honor preferences when it doesn't cost coverage: keep the
  // preference-aware plan unless the preference-blind one covers strictly
  // more shifts.
  const planPref = buildPlan(true);
  const planCov  = buildPlan(false);
  const plan = planPref.covered >= planCov.covered ? planPref : planCov;

  let assigned = 0;
  for (const [shiftId, driverId] of plan.assignments) {
    const { error } = await sb.rpc("assign_shift", { p_id: shiftId, p_driver_id: driverId });
    if (!error) assigned += 1;
  }

  // Bump the lifetime "preference honored" counter for the fairness
  // tiebreaker — only when the plan we shipped actually honored some.
  if (plan === planPref && plan.prefBumps.size > 0) {
    await Promise.all([...plan.prefBumps].map(([id, n]) => {
      const d = drivers.find(x => x.id === id);
      const meta = d?.metadata || {};
      const sched = { ...(meta.scheduling || {}), pref_honored: (Number(meta.scheduling?.pref_honored) || 0) + n };
      return sb.from("drivers").update({ metadata: { ...meta, scheduling: sched } }).eq("id", id)
        .then(({ error }) => { if (error) console.warn("pref_honored bump:", error.message); })
        .catch(e => console.warn("pref_honored bump:", e));
    }));
  }

  return { assigned, skippedExpired };
}

function renderScheduleGrid() { /* removed */ }

// ─── Schedule · Week view (read-only render) ───────────────────────────────

function fmtTimeShort(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).toLowerCase().replace(" ", "");
  } catch { return ""; }
}

// Wall-clock "HH:MM" (browser-local) of a shift's start timestamp — the
// same value the schedule grid shows via fmtHM / fmtTimeShort.
function _shiftStartHM(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
// True when a shift starting at shiftHM begins before the driver's earliest
// available start time earliestHM.  Both "HH:MM"; false if either is absent.
function _startsBeforeEarliest(shiftHM, earliestHM) {
  const norm = (s) => /^\d{1,2}:\d{2}$/.test(s || "") ? (String(s).length === 4 ? "0" + s : String(s)) : "";
  const a = norm(shiftHM), b = norm(earliestHM);
  return !!a && !!b && a < b;
}

// "YYYY-MM-DD" → day-of-week key ('sun'..'sat'), matching availability keys.
const _RR_DOW_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
function _dowKey(iso) {
  const d = new Date(iso + "T12:00:00");
  return isNaN(d.getTime()) ? "" : _RR_DOW_KEYS[d.getDay()];
}
// A driver's preferred days, clamped to their currently-available days.
function _preferredDaysOf(driver) {
  const av = driver?.metadata?.availability || {};
  const days = Array.isArray(av.days) ? av.days : [];
  const pref = Array.isArray(av.preferred_days) ? av.preferred_days : [];
  return new Set(pref.filter(k => days.includes(k)));
}

// Format a 'HH:MM' wave-time string as e.g. '1:00pm'. Used when we don't
// have a full timestamp — only a configured wave start.
function fmtWaveTime(hhmm) {
  if (!hhmm) return "";
  const parts = String(hhmm).split(":");
  const h = parseInt(parts[0], 10);
  const m = parts.length > 1 ? parseInt(parts[1], 10) : 0;
  if (!Number.isFinite(h)) return hhmm;
  const hour12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
  const ampm = h >= 12 ? "pm" : "am";
  return `${hour12}:${String(m || 0).padStart(2, "0")}${ampm}`;
}

// Add `hours` to an 'HH:MM' string, returning the new 'HH:MM'. Wraps midnight.
function addHoursToWaveTime(hhmm, hours) {
  if (!hhmm) return "";
  const parts = String(hhmm).split(":");
  const h = parseInt(parts[0], 10);
  const m = parts.length > 1 ? parseInt(parts[1], 10) : 0;
  if (!Number.isFinite(h)) return hhmm;
  const total = (h * 60 + m + (hours || 0) * 60 + 24 * 60) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// Edit modal for an assigned shift. Loads the row, lets the operator
// nudge start_time / end_time (free-text HH:MM) and Save or Remove.
// Save preserves the shift's date timezone — we only swap the time
// portion of starts_at / ends_at, not the date.
async function openShiftEditModal(shiftId) {
  let m = document.getElementById("rr-shift-edit-modal");
  if (m) m.remove();

  const { data: sh, error } = await sb
    .from("shifts")
    .select("id, date, starts_at, ends_at, driver_id, route_code, drivers(full_name, preferred_name)")
    .eq("id", shiftId)
    .single();
  if (error || !sh) {
    toast("Couldn't load shift: " + (error?.message || "not found"), "warn");
    return;
  }

  const driver = sh.drivers?.preferred_name?.trim() || sh.drivers?.full_name || "Driver";
  const route  = sh.route_code || "shift";
  const fmtHM  = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const startHM = fmtHM(sh.starts_at);
  const endHM   = fmtHM(sh.ends_at);

  m = document.createElement("div");
  m.id = "rr-shift-edit-modal";
  m.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px";
  m.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;width:100%;max-width:440px;overflow:hidden">
      <div style="padding:18px 22px;border-bottom:1px solid var(--border)">
        <div style="font-size:var(--fs-lg);font-weight:600">Edit shift</div>
        <div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px">${escapeHtml(driver)} · ${escapeHtml(route)} · ${escapeHtml(sh.date)}</div>
      </div>
      <div style="padding:18px 22px;display:flex;flex-direction:column;gap:14px">
        <label style="display:flex;align-items:center;gap:14px">
          <span style="flex:0 0 90px;font-size:var(--fs-sm);font-weight:600">Start time</span>
          <input type="time" id="rr-shift-edit-start" value="${escapeHtml(startHM)}" class="form-input" style="max-width:160px" />
        </label>
        <label style="display:flex;align-items:center;gap:14px">
          <span style="flex:0 0 90px;font-size:var(--fs-sm);font-weight:600">End time</span>
          <input type="time" id="rr-shift-edit-end" value="${escapeHtml(endHM)}" class="form-input" style="max-width:160px" />
        </label>
        <div id="rr-shift-edit-status" style="font-size:var(--fs-xs);color:var(--text-subtle);min-height:14px"></div>
      </div>
      <div style="display:flex;justify-content:space-between;gap:8px;padding:14px 22px;border-top:1px solid var(--border);background:var(--canvas)">
        <button class="btn btn-sm" data-rr-shift-edit-remove style="color:var(--red);border-color:rgba(220,38,38,.3)">Remove shift</button>
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm" data-rr-shift-edit-cancel>Cancel</button>
          <button class="btn btn-sm btn-primary" data-rr-shift-edit-save>Save</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(m);

  const close = () => m.remove();
  m.addEventListener("click", async (e) => {
    if (e.target === m || e.target.closest("[data-rr-shift-edit-cancel]")) { close(); return; }

    if (e.target.closest("[data-rr-shift-edit-remove]")) {
      if (!confirm("Remove this shift?")) return;
      const { error: delErr } = await sb.from("shifts").delete().eq("id", shiftId);
      if (delErr) { toast("Delete failed: " + delErr.message, "warn"); return; }
      toast("Shift removed", "success");
      close();
      renderScheduleWeek();
      return;
    }

    if (e.target.closest("[data-rr-shift-edit-save]")) {
      const status = document.getElementById("rr-shift-edit-status");
      const newStart = document.getElementById("rr-shift-edit-start").value;
      const newEnd   = document.getElementById("rr-shift-edit-end").value;
      if (!newStart || !newEnd) { status.textContent = "Both times are required."; status.style.color = "var(--red)"; return; }
      // Swap only the time-of-day on the existing timestamps so the
      // shift's date + tz are preserved. Browser's <input type="time">
      // gives us local HH:MM, which is what the operator sees on the
      // chip.
      const swapTime = (iso, hhmm) => {
        const d = new Date(iso);
        const [h, mi] = hhmm.split(":").map(Number);
        d.setHours(h, mi, 0, 0);
        return d.toISOString();
      };
      const newStartIso = swapTime(sh.starts_at, newStart);
      const newEndIso   = swapTime(sh.ends_at,   newEnd);
      // End must be after start within the same shift; if the operator
      // entered an end <= start, assume they want next-day end (rare
      // but possible for overnight shifts) and roll it 24h.
      let endIso = newEndIso;
      if (new Date(endIso) <= new Date(newStartIso)) {
        endIso = new Date(new Date(endIso).getTime() + 24 * 60 * 60 * 1000).toISOString();
      }

      status.textContent = "Saving…";
      status.style.color = "var(--text-subtle)";
      const { error: upErr } = await sb
        .from("shifts")
        .update({ starts_at: newStartIso, ends_at: endIso })
        .eq("id", shiftId);
      if (upErr) {
        status.textContent = "Save failed: " + upErr.message;
        status.style.color = "var(--red)";
        return;
      }
      toast("Shift updated", "success");
      close();
      renderScheduleWeek();
    }
  });
}

function _schedShiftChip(sh) {
  const r = sh.route_code ? escapeHtml(sh.route_code) : (sh.starts_at ? fmtTimeShort(sh.starts_at) : "shift");
  const time = (sh.starts_at && sh.ends_at) ? `${fmtTimeShort(sh.starts_at)} – ${fmtTimeShort(sh.ends_at)}` : "";
  const ex = sh.is_cushion
    ? `<span style="display:inline-block;background:#FEF3C7;color:var(--amber-dark);font-size:9px;font-weight:700;padding:0 4px;border-radius:3px;margin-left:4px;letter-spacing:.04em">EX</span>`
    : "";
  // Service-type badge — shown for any non-SP shift so an XL/HUB/ASU
  // shift is visually distinguishable. SP shifts (the default) get no
  // badge to keep the chip clean for single-type DSPs.
  const stCode = sh.service_type_code;
  const stColor = sh.service_type_color || "#0F6CBD";
  const stBadge = (stCode && stCode !== "SP")
    ? `<span style="display:inline-block;background:${escapeHtml(stColor)}20;color:${escapeHtml(stColor)};font-size:9px;font-weight:700;padding:0 4px;border-radius:3px;margin-left:4px;letter-spacing:.04em" title="${escapeHtml(sh.service_type_label || stCode)}">${escapeHtml(stCode)}</span>`
    : "";
  const baseStyle = sh.is_cushion ? 'border-color:#FCD34D;' : '';
  return `<div class="shift-chip" data-rr-shift-id="${sh.id}" style="${baseStyle}cursor:pointer" title="Click to edit start / end time or remove"><div class="shift-chip-route">${r}${ex}${stBadge}</div>${time ? `<div class="shift-chip-time">${time}</div>` : ""}</div>`;
}

function _schedDriverInitials(name) {
  return (name || "").split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
}

async function renderScheduleWeek() {
  const sub = document.getElementById("sched-sub-week");
  if (!sub) return;
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;

  if (!_schedStart) _schedStart = fmtIsoDate(startOfWeekMonday(new Date()));
  const weekStart = new Date(_schedStart + "T12:00:00");
  const weekEnd   = addDays(weekStart, 6);
  const weekEndIso = fmtIsoDate(weekEnd);
  const todayIso  = fmtIsoDate(new Date());

  const [gridRes, driversRes, toRes] = await Promise.all([
    sb.rpc("schedule_grid", { p_start: _schedStart, p_weeks: 1 }),
    sb.from("drivers")
      .select("id, full_name, first_name, last_name, preferred_name, status, station_id, hire_date, tier, metadata, dl_expires_on, dot_certified, xl_certified, station:station_id (code)")
      .eq("dsp_id", dspId)
      .eq("status", "active")
      .order("full_name"),
    sb.from("time_off_requests")
      .select("id, driver_id, start_date, end_date, status")
      .eq("dsp_id", dspId)
      .eq("status", "approved")
      .lte("start_date", weekEndIso)
      .gte("end_date", _schedStart),
  ]);

  if (gridRes.error)    { console.warn("schedule_grid:", gridRes.error.message); return; }
  if (driversRes.error) { console.warn("drivers load:", driversRes.error.message); return; }
  if (toRes.error)      { console.warn("time_off load:", toRes.error.message); return; }

  const grid    = gridRes.data    || { coverage: [], shifts: [] };
  const drivers = driversRes.data || [];
  const timeOff = toRes.data      || [];

  _schedDriverList = drivers; // existing add-shift modal reads this list

  // Driver-column sort lives in a small popover behind a sort icon —
  // matches the Turnover KPI's time-frame switcher pattern (see
  // .rr-tf-icon / .rr-tf-popover).  Bound once at document level
  // below; nothing to wire here per render.

  // visibleDriverIds: only drivers with status='active' are loaded
  // into `drivers` (line ~13217). Shifts assigned to drivers outside
  // this set (terminated, onboarding, on extended leave) need to be
  // treated as open — they have a driver_id, but that driver can't
  // actually work the shift, so they need re-staffing. Without this
  // check the math goes inconsistent: Coverage 87% with "0 open
  // shifts" because the 7 missing shifts are pinned to inactive
  // drivers and don't get counted as either.
  const visibleDriverIds = new Set(drivers.map(d => d.id));

  // Index shifts by driver/date and collect open shifts by date.
  const shiftsByDriverDate = new Map();
  const openShiftsByDate = new Map();
  const hoursPerDriver = new Map(); // driver_id -> total HOURS this week
  const shiftCountPerDriver = new Map(); // driver_id -> shift count (for least-loaded sort)
  const _shiftHours = (sh) => {
    if (sh.starts_at && sh.ends_at) {
      const h = (new Date(sh.ends_at) - new Date(sh.starts_at)) / 3600000;
      if (h > 0 && h <= 24) return h;
    }
    return Number(sh.block_hours) || 10;
  };
  // Per-driver wave histogram so "By wave" sort can pick each driver's
  // primary wave for the week (the wave they're most often assigned to;
  // ties broken by the lower wave_index).
  const waveCountsPerDriver = new Map(); // driver_id -> Map<wave_index, count>
  for (const sh of (grid.shifts || [])) {
    // A shift counts as truly assigned only when its driver_id points
    // to a driver in the visible (active) roster. Otherwise we treat
    // it as open — the assignment is effectively orphaned and the
    // operator needs to re-staff it.
    const isAssigned = sh.driver_id && visibleDriverIds.has(sh.driver_id);
    if (isAssigned) {
      const k = `${sh.driver_id}|${sh.date}`;
      if (!shiftsByDriverDate.has(k)) shiftsByDriverDate.set(k, []);
      shiftsByDriverDate.get(k).push(sh);
      hoursPerDriver.set(sh.driver_id, (hoursPerDriver.get(sh.driver_id) || 0) + _shiftHours(sh));
      shiftCountPerDriver.set(sh.driver_id, (shiftCountPerDriver.get(sh.driver_id) || 0) + 1);
      const wIdx = Number.isFinite(sh.wave_index) ? sh.wave_index : 0;
      const wm = waveCountsPerDriver.get(sh.driver_id) || new Map();
      wm.set(wIdx, (wm.get(wIdx) || 0) + 1);
      waveCountsPerDriver.set(sh.driver_id, wm);
    } else if (sh.status === "scheduled") {
      // Only surface scheduled shifts as open. completed / no_show /
      // called_off rows are historical and shouldn't reappear in the
      // pool even if their driver_id is now inactive.
      if (!openShiftsByDate.has(sh.date)) openShiftsByDate.set(sh.date, []);
      openShiftsByDate.get(sh.date).push(sh);
    }
  }
  // Primary wave per driver: most-frequent wave_index this week. Drivers
  // with no shifts get Infinity so they sort to the bottom in "By wave".
  const primaryWavePerDriver = new Map();
  for (const [drvId, wm] of waveCountsPerDriver.entries()) {
    let bestWave = Infinity, bestCount = -1;
    for (const [w, c] of wm.entries()) {
      if (c > bestCount || (c === bestCount && w < bestWave)) { bestCount = c; bestWave = w; }
    }
    primaryWavePerDriver.set(drvId, bestWave);
  }

  // Apply the operator's chosen driver-column sort. Default ("alpha") is
  // a no-op since the SQL already returned drivers ordered by full_name.
  const _alphaKey = (d) => (displayDriverName(d) || d.full_name || "").toLowerCase();
  if (_schedDriverSort === "wave") {
    drivers.sort((a, b) => {
      const aw = primaryWavePerDriver.has(a.id) ? primaryWavePerDriver.get(a.id) : Infinity;
      const bw = primaryWavePerDriver.has(b.id) ? primaryWavePerDriver.get(b.id) : Infinity;
      if (aw !== bw) return aw - bw;
      return _alphaKey(a).localeCompare(_alphaKey(b));
    });
  } else if (_schedDriverSort === "hours") {
    drivers.sort((a, b) => {
      const ah = hoursPerDriver.get(a.id) || 0;
      const bh = hoursPerDriver.get(b.id) || 0;
      if (ah !== bh) return bh - ah; // descending
      return _alphaKey(a).localeCompare(_alphaKey(b));
    });
  }

  // Index PTO by driver.
  const ptoByDriver = new Map();
  for (const t of timeOff) {
    if (!ptoByDriver.has(t.driver_id)) ptoByDriver.set(t.driver_id, []);
    ptoByDriver.get(t.driver_id).push(t);
  }
  const ptoOn = (driverId, iso) => (ptoByDriver.get(driverId) || []).some(t => iso >= t.start_date && iso <= t.end_date);

  // Coverage rolled up by date.
  // Denominator = shifts in the table for the day (scheduled +
  // completed, base + cushion). Filled = shifts that are either
  // already done (completed) or currently assigned to a visible
  // active driver. Past days with completed shifts read 100% as the
  // operator expects; future days work as before.
  const coverageByDate = new Map();
  for (const sh of (grid.shifts || [])) {
    if (!["scheduled", "completed"].includes(sh.status)) continue;
    const a = coverageByDate.get(sh.date) || { needed: 0, filled: 0 };
    a.needed += 1;
    const isFilled =
      sh.status === "completed" ||
      (sh.driver_id && visibleDriverIds.has(sh.driver_id));
    if (isFilled) a.filled += 1;
    coverageByDate.set(sh.date, a);
  }
  let totalNeeded = 0, totalFilled = 0;
  for (const a of coverageByDate.values()) { totalNeeded += a.needed; totalFilled += a.filled; }
  const pct = totalNeeded ? Math.round(totalFilled / totalNeeded * 100) : 0;

  // Virtual open shifts: for each (date, station), needed − filled minus
  // any real unassigned shift rows already in the DB. Filled here only
  // counts shifts assigned to VISIBLE active drivers (matches the
  // coverage-strip math), so orphan shifts assigned to inactive drivers
  // don't suppress legitimate virtual open chips.
  const realOpenByDateStation = new Map();
  const visibleFilledByDateStation = new Map();
  for (const sh of (grid.shifts || [])) {
    const k = `${sh.date}|${sh.station_id}`;
    if (!sh.driver_id) {
      realOpenByDateStation.set(k, (realOpenByDateStation.get(k) || 0) + 1);
    } else if (visibleDriverIds.has(sh.driver_id) && ["scheduled", "completed"].includes(sh.status)) {
      visibleFilledByDateStation.set(k, (visibleFilledByDateStation.get(k) || 0) + 1);
    }
  }
  // Virtual chips get the wave time at their position in the day's lineup.
  // Single-wave config → every virtual chip shows the same wave time.
  // Read from the per-week effective settings cache (populated by
  // loadSchedulingSettings) so the visible week's waves drive the
  // chip layout, not the stale DSP-default metadata.
  // Virtual chips ("from plan" placeholders for okami_demand rows
  // without corresponding shifts) used to be synthesized here. After
  // Route planning → Save became canonical (#530), the shifts table
  // IS the route plan + cushion — there's no legitimate gap to
  // surface, only stale state. Removed entirely; only real open
  // shifts populate the pool now.
  const virtualByDate = new Map();
  const totalVirtual = 0;

  // ── Toolbar
  // Populate the 4-week tab strip. The first tab is always the actual
  // current week; the next three are the following weeks. Whichever
  // tab matches _schedStart gets the active state.
  const tabsEl = sub.querySelector("#rr-sched-week-tabs");
  if (tabsEl) {
    const today = new Date();
    const baseMonday = startOfWeekMonday(today);
    const fmtRange = (m) => {
      const e = addDays(m, 6);
      const sameMonth = m.getMonth() === e.getMonth();
      return sameMonth
        ? `${m.toLocaleDateString(undefined, { month: "short", day: "numeric" })}–${e.getDate()}`
        : `${m.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${e.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    };
    const activeIso = _schedStart || fmtIsoDate(baseMonday);
    tabsEl.querySelectorAll(".sched-week-tab").forEach((btn) => {
      const offset = parseInt(btn.dataset.rrWeekOffset, 10) || 0;
      const monday = addDays(baseMonday, offset * 7);
      const iso = fmtIsoDate(monday);
      btn.dataset.rrWeekStart = iso;
      btn.textContent = offset === 0 ? "This week" : fmtRange(monday);
      btn.classList.toggle("active", iso === activeIso);
    });
  }

  // Page-sub line in the header (Schedule view) — replace the mockup
  // 'Week of May 1–7 · 78 drivers · ...' with live numbers.
  const pageSub = document.getElementById("rr-sched-page-sub");
  if (pageSub) {
    const wkRange = `${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${weekEnd.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    const finalPill = window._rrWeekFinalized
      ? `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--green);color:#fff;font-size:var(--fs-xs);font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:2px 8px;border-radius:10px;margin-left:8px;vertical-align:middle"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Live</span>`
      : "";
    pageSub.innerHTML = `Week of ${wkRange} · ${drivers.length} active driver${drivers.length === 1 ? "" : "s"}${finalPill}`;
  }

  // Finalized banner — full-width strip above the toolbar that drivers
  // can see this week's schedule. Only renders when _rrWeekFinalized.
  let banner = sub.querySelector("#rr-sched-finalize-banner");
  if (window._rrWeekFinalized) {
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "rr-sched-finalize-banner";
      banner.style.cssText = "display:flex;align-items:center;gap:10px;background:rgba(34,197,94,.10);border:1px solid var(--green);border-left-width:4px;color:var(--green);font-weight:600;font-size:var(--fs-md);padding:10px 14px;border-radius:8px;margin-bottom:var(--s-3)";
      banner.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        <span>This week is <strong>LIVE</strong> — drivers can see this schedule. Edits notify the affected drivers.</span>`;
      const toolbar = sub.querySelector(".sched-toolbar-rail, .sched-toolbar");
      if (toolbar) toolbar.parentNode.insertBefore(banner, toolbar);
    }
  } else if (banner) {
    banner.remove();
  }

  // ── KPI strip (hours, coverage, open shifts, violations) + per-day status
  // computed from the same data as the grid below.
  const days = Array.from({ length: 7 }, (_, i) => fmtIsoDate(addDays(weekStart, i)));
  const totalHoursWeek = Array.from(hoursPerDriver.values()).reduce((s, n) => s + n, 0);
  // Real open shifts (unassigned scheduled rows) — sum across all dates.
  let totalRealOpen = 0;
  for (const list of openShiftsByDate.values()) totalRealOpen += list.length;
  const totalAllOpen = totalRealOpen + totalVirtual;
  // Expose for the stage-aware page-header CTA. Re-evaluated every
  // render so the button text/handler swaps as the operator drags
  // chips into drivers (open count drops to 0 → Finalize lights up).
  window._rrOpenShiftsCount = totalAllOpen;
  if (typeof window._rrUpdateScheduleCta === "function") window._rrUpdateScheduleCta();

  // Out-of-sync banner deleted per operator. Belt-and-braces: also
  // remove any stale node from a previous render so it can't linger
  // visually when the new code path doesn't recreate it.
  const _staleOos = sub.querySelector("#rr-sched-out-of-sync");
  if (_staleOos) _staleOos.remove();

  // Per-day fill: needed (from coverageByDate), filled (visible-driver shifts).
  const fillByDate = new Map();
  for (const iso of days) {
    const c = coverageByDate.get(iso) || { needed: 0, filled: 0 };
    fillByDate.set(iso, c);
  }
  // Overtime per driver: hours-scheduled-this-week beyond 40, billed at
  // time-and-a-half against drivers.metadata.pay.hourly_rate. Drivers
  // without a rate set are surfaced separately so the cost estimate
  // isn't silently low.
  let totalOvertimeHrs = 0;
  let estimatedOvertimeCost = 0;
  let estimatedPayrollCost = 0;
  let driversInOt = 0;
  let driversInOtMissingRate = 0;
  let driversWithHoursMissingRate = 0;
  for (const d of drivers) {
    const hrs = hoursPerDriver.get(d.id) || 0;
    if (hrs <= 0) continue;
    const ot       = Math.max(0, hrs - 40);
    const regular  = Math.min(hrs, 40);
    const rate     = Number(d.metadata?.pay?.hourly_rate) || 0;
    if (rate > 0) {
      // Total payroll = (regular × rate) + (OT × rate × 1.5).
      estimatedPayrollCost += regular * rate + ot * rate * 1.5;
    } else {
      driversWithHoursMissingRate += 1;
    }
    if (ot > 0) {
      totalOvertimeHrs += ot;
      driversInOt += 1;
      if (rate > 0) {
        estimatedOvertimeCost += ot * rate * 1.5;
      } else {
        driversInOtMissingRate += 1;
      }
    }
  }

  // Rule violations across assigned shifts in the week (now includes WOC).
  const violations = await _computeWeekViolations(grid.shifts || [], drivers, timeOff, _schedStart, fmtIsoDate(weekEnd));

  // Preferred-day coverage: of the shifts assigned to drivers who flagged
  // preferred days, how many landed on one of those days.
  const _prefByDriver = new Map();
  for (const d of drivers) _prefByDriver.set(d.id, _preferredDaysOf(d));
  let prefHonored = 0, prefDenom = 0;
  for (const sh of (grid.shifts || [])) {
    if (!sh.driver_id || sh.status !== "scheduled") continue;
    const pset = _prefByDriver.get(sh.driver_id);
    if (!pset || pset.size === 0) continue;
    prefDenom += 1;
    if (pset.has(_dowKey(sh.date))) prefHonored += 1;
  }

  // Render the Schedule KPIs using the same .stat-mini pattern that
  // Drivers Roster + the rest of the dashboard uses, so the cards
  // read at the same scale as the other KPI strips operators see.
  let kpis = sub.querySelector("#rr-sched-kpis");
  if (!kpis) {
    kpis = document.createElement("div");
    kpis.id = "rr-sched-kpis";
    kpis.className = "driver-stat-row";
    kpis.style.cssText = "grid-template-columns:repeat(6,minmax(0,1fr))";
    // Anchor: insert directly after the toolbar rail. Selector covers
    // both the new .sched-toolbar-rail (#524) and the legacy
    // .sched-toolbar in case any DSP is on a stale bundle.
    const toolbar = sub.querySelector(".sched-toolbar-rail, .sched-toolbar");
    if (toolbar) toolbar.insertAdjacentElement("afterend", kpis);
  } else {
    kpis.className = "driver-stat-row";
    kpis.style.cssText = "grid-template-columns:repeat(6,minmax(0,1fr))";
  }
  const kpiCard = (label, value, sublabel, tone) => {
    const c = tone === "bad" ? "var(--red)" : tone === "warn" ? "var(--amber)" : tone === "ok" ? "var(--green)" : "";
    return `<div class="stat-mini">
      <div class="stat-mini-label">${label}</div>
      <div class="stat-mini-value"${c ? ` style="color:${c}"` : ""}>${value}</div>
      <div class="stat-mini-sub">${sublabel}</div>
    </div>`;
  };
  const coverageTone = pct >= 100 ? "ok" : pct >= 90 ? "warn" : "bad";
  const violationsTone = violations.length === 0 ? "ok" : violations.length <= 3 ? "warn" : "bad";
  const otTone = totalOvertimeHrs === 0 ? "ok" : totalOvertimeHrs <= 10 ? "warn" : "bad";
  const otValue = totalOvertimeHrs === 0 ? "0h" : `${Math.round(totalOvertimeHrs * 10) / 10}h`;
  let otSub;
  if (totalOvertimeHrs === 0) {
    otSub = "no OT";
  } else if (driversInOtMissingRate > 0 && estimatedOvertimeCost === 0) {
    otSub = `${driversInOt} driver${driversInOt === 1 ? "" : "s"} · set pay rate to estimate cost`;
  } else if (driversInOtMissingRate > 0) {
    otSub = `~$${Math.round(estimatedOvertimeCost).toLocaleString()} @ 1.5× · ${driversInOtMissingRate} no rate`;
  } else {
    otSub = `~$${Math.round(estimatedOvertimeCost).toLocaleString()} @ 1.5× · ${driversInOt} driver${driversInOt === 1 ? "" : "s"}`;
  }
  kpis.innerHTML =
    kpiCard(
      "Hours scheduled",
      `${Math.round(totalHoursWeek)}h`,
      estimatedPayrollCost > 0
        ? `~$${Math.round(estimatedPayrollCost).toLocaleString()} payroll${driversWithHoursMissingRate > 0 ? ` · ${driversWithHoursMissingRate} no rate` : ""}`
        : `${shiftCountPerDriver.size} driver${shiftCountPerDriver.size === 1 ? "" : "s"}${driversWithHoursMissingRate > 0 ? ` · set pay rate to estimate` : ""}`,
      "default"
    ) +
    kpiCard("Overtime", otValue, otSub, otTone) +
    kpiCard("Coverage", `${pct}%`, `${totalFilled} / ${totalNeeded} shifts`, coverageTone) +
    kpiCard("Open shifts", String(totalAllOpen), totalAllOpen === 0 ? "fully covered" : "drivers needed", totalAllOpen === 0 ? "ok" : "warn") +
    kpiCard("Rule violations", String(violations.length), violations.length === 0 ? "all clear" : "click to review", violationsTone) +
    kpiCard("Preferences",
      prefDenom === 0 ? "—" : `${prefHonored} / ${prefDenom}`,
      prefDenom === 0 ? "no preferences set" : (prefHonored === prefDenom ? "all on a preferred day" : "★ on the grid = preferred day"),
      prefDenom === 0 ? "default" : (prefHonored === prefDenom ? "ok" : "warn"));
  kpis.dataset.rrViolations = JSON.stringify(violations);
  // Visual cue that the violations card opens a modal — match the
  // .stat-mini-clickable pattern other KPI strips use.
  const violationsCard = kpis.querySelector("div:nth-child(5)");
  if (violationsCard) {
    violationsCard.style.cursor = "pointer";
    violationsCard.style.transition = "border-color .12s, box-shadow .12s";
    violationsCard.title = violations.length === 0 ? "No rule violations this week" : `Review ${violations.length} rule violation${violations.length === 1 ? "" : "s"}`;
  }

  // ── Day headers (skip first cell which is "Driver")
  const headRow = sub.querySelector(".cal-grid.head");
  if (headRow) {
    const heads = headRow.querySelectorAll(".cal-cell-head");
    for (let i = 0; i < 7; i++) {
      const cellHead = heads[i + 1];
      if (!cellHead) break;
      const dt = addDays(weekStart, i);
      const iso = fmtIsoDate(dt);
      const c = fillByDate.get(iso) || { needed: 0, filled: 0 };
      cellHead.classList.toggle("today", iso === todayIso);
      let status = "";
      if (c.needed > 0) {
        if (c.filled >= c.needed) {
          status = `<div style="font-size:var(--fs-xs);font-weight:600;color:var(--green);margin-top:2px">✓ Complete</div>`;
        } else {
          const tone = c.filled === 0 ? "var(--red)" : "var(--amber)";
          status = `<div style="font-size:var(--fs-xs);font-weight:600;color:${tone};margin-top:2px">${c.filled} / ${c.needed}</div>`;
        }
      }
      cellHead.innerHTML = `${RR_DAY_SHORT[dt.getDay()]}<span class="day-num">${dt.getDate()}</span>${status}`;
    }
  }

  // ── Driver rows + Unassigned + Coverage strip
  const wrap = sub.querySelector(".cal-wrap");
  if (!wrap) return;
  Array.from(wrap.children).forEach(el => {
    if (!el.classList.contains("head")) el.remove();
  });

  const driverRowsHtml = drivers.map(d => {
    const initials = displayDriverInitials(d);
    const display = displayDriverName(d);
    const tier = d.tier ? `tier-${String(d.tier).toLowerCase()}` : "";
    const station = d.station?.code || "—";
    const tenure = d.hire_date ? tenureLabel(d.hire_date) : "—";
    const totalHours = hoursPerDriver.get(d.id) || 0;
    const shiftCount = shiftCountPerDriver.get(d.id) || 0;
    const hoursLabel = totalHours > 0
      ? `${Math.round(totalHours * 10) / 10}h scheduled · ${shiftCount} shift${shiftCount === 1 ? "" : "s"}`
      : "0h scheduled";
    // Expired-DL flag — passive visual cue next to the driver name so
    // the operator sees at a glance that scheduling will trigger a warning.
    const todayIsoForDL = fmtIsoDate(new Date());
    const dlExpired = d.dl_expires_on && d.dl_expires_on < todayIsoForDL;
    const dlFlag = dlExpired
      ? `<span title="Driver's license expired ${new Date(d.dl_expires_on + "T12:00:00").toLocaleDateString()}" style="display:inline-flex;align-items:center;gap:3px;background:rgba(239,68,68,.12);color:var(--red);font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;margin-left:6px;letter-spacing:.04em;vertical-align:middle"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>DL EXP</span>`
      : "";
    const prefSet = _prefByDriver.get(d.id) || null;
    const cells = days.map(iso => {
      const cls = `cal-cell${iso === todayIso ? " today" : ""}`;
      const data = `data-rr-cell="driver-day" data-rr-cell-date="${iso}" data-rr-cell-driver="${d.id}"${d.station_id ? ` data-rr-cell-station="${d.station_id}"` : ""}`;
      const isPref = !!prefSet && prefSet.size > 0 && prefSet.has(_dowKey(iso));
      if (ptoOn(d.id, iso))
        return `<div class="${cls}" ${data}><div class="shift-chip timeoff"><div class="shift-chip-route">PTO</div></div></div>`;
      const list = shiftsByDriverDate.get(`${d.id}|${iso}`) || [];
      // ★ = a day the driver flagged as preferred.  Green when they're
      // actually scheduled that day, amber when they wanted it but aren't.
      const star = isPref
        ? `<span title="${list.length > 0 ? "Scheduled on a preferred day" : "Driver prefers this day"}" style="position:absolute;top:1px;right:3px;font-size:9px;line-height:1;color:${list.length > 0 ? "var(--green)" : "var(--amber)"}">★</span>`
        : "";
      const rel = isPref ? ' style="position:relative"' : "";
      if (list.length === 0)
        return `<div class="${cls}"${rel} ${data}>${star}<div class="shift-chip off">Off</div></div>`;
      return `<div class="${cls}"${rel} ${data}>${star}${list.map(_schedShiftChip).join("")}</div>`;
    }).join("");
    return `<div class="cal-grid">
      <div class="cal-row-label"><div class="avatar-sm ${tier}" data-rr-driver-id="${d.id}">${initials}</div><div><div class="cal-row-label-name" data-rr-driver-id="${d.id}">${escapeHtml(display)}${dlFlag}</div><div class="cal-row-label-meta">${escapeHtml(station)} · ${escapeHtml(tenure)} · ${escapeHtml(hoursLabel)}</div></div></div>
      ${cells}
    </div>`;
  }).join("");

  // Unassigned slots → one row per Potential Driver (PD). Total PD rows
  // equal the peak unfilled day across the week. For each PD row r, each
  // day cell shows an open chip if that day still has unfilled demand at
  // slot index r — real open shifts first, then virtual chips computed
  // from OKAMI demand.
  const stationCodeById = new Map();
  for (const c of (grid.coverage || [])) {
    if (c.station_id) stationCodeById.set(c.station_id, c.station_code);
  }
  const openSlotsByDate = new Map();
  for (const iso of days) {
    const slots = [];
    for (const sh of (openShiftsByDate.get(iso) || [])) {
      slots.push({
        kind: "real",
        shift_id: sh.id,
        route_code: sh.route_code,
        station_code: stationCodeById.get(sh.station_id) || "open",
        starts_at: sh.starts_at,
        ends_at: sh.ends_at,
        is_cushion: sh.is_cushion,
      });
    }
    for (const v of (virtualByDate.get(iso) || [])) {
      slots.push({ kind: "virtual", station_id: v.station_id, station_code: v.station_code, wave_start: v.wave_start });
    }
    openSlotsByDate.set(iso, slots);
  }
  let peakUnfilled = 0;
  for (const slots of openSlotsByDate.values()) {
    if (slots.length > peakUnfilled) peakUnfilled = slots.length;
  }

  const pdRowsHtml = peakUnfilled === 0 ? "" : Array.from({ length: peakUnfilled }, (_, r) => {
    const cells = days.map(iso => {
      const cls = `cal-cell${iso === todayIso ? " today" : ""}`;
      const slots = openSlotsByDate.get(iso) || [];
      if (r >= slots.length) return `<div class="${cls}"><div class="shift-chip off"></div></div>`;
      const slot = slots[r];
      const data = `data-rr-cell="open" data-rr-cell-date="${iso}"`;
      if (slot.kind === "real") {
        const startLbl = slot.starts_at ? fmtTimeShort(slot.starts_at) : "";
        const endLbl   = slot.ends_at   ? fmtTimeShort(slot.ends_at)   : "";
        const label = startLbl && endLbl ? `${startLbl} – ${endLbl}` : (startLbl || slot.route_code || "open");
        const ex = slot.is_cushion
          ? `<span style="display:inline-block;background:#FEF3C7;color:var(--amber-dark);font-size:9px;font-weight:700;padding:0 4px;border-radius:3px;margin-left:4px;letter-spacing:.04em">EX</span>`
          : "";
        const style = slot.is_cushion ? ' style="border-color:#FCD34D"' : "";
        return `<div class="${cls}" ${data}><div class="shift-chip open" data-rr-shift-id="${slot.shift_id}"${style}>+ ${escapeHtml(label)}${ex}</div></div>`;
      }
      const eff = window._rrEffectiveSettings || {};
      const blockH = eff.default_block_hours
        || window.RR?.dsp?.metadata?.scheduling?.default_block_hours
        || 10;
      const lead = Math.max(0, parseInt(eff.report_lead_minutes, 10) || 0);
      const reportStart = addHoursToWaveTime(slot.wave_start, -lead / 60);
      const vStart = fmtWaveTime(reportStart);
      const vEnd   = fmtWaveTime(addHoursToWaveTime(reportStart, blockH));
      const virtLabel = vStart && vEnd ? `${vStart} – ${vEnd}` : (vStart || "open");
      return `<div class="${cls}" ${data}><div class="shift-chip open" data-rr-virtual-station="${slot.station_id}" style="opacity:.65;border-style:dashed" title="From OKAMI demand · drag a driver to fill">+ ${escapeHtml(virtLabel)}</div></div>`;
    }).join("");
    const pdNum = r + 1;
    return `<div class="cal-grid" style="background:var(--canvas)">
      <div class="cal-row-label" style="background:var(--canvas)">
        <div class="avatar-sm" style="background:var(--canvas);color:var(--text-subtle);border:1.5px dashed var(--border-strong);font-weight:700;font-size:var(--fs-xs)">PD</div>
        <div><div class="cal-row-label-name" style="color:var(--text-muted)">PD ${pdNum}</div><div class="cal-row-label-meta">Potential driver slot</div></div>
      </div>
      ${cells}
    </div>`;
  }).join("");

  // Coverage strip.
  const covCellCls = (filled, needed) => {
    if (needed === 0) return "coverage-cell full";
    if (filled >= needed) return "coverage-cell full";
    if (filled >= needed * 0.95) return "coverage-cell partial";
    return "coverage-cell gap";
  };
  const coverageStripHtml = `<div class="coverage-strip">
    <div class="coverage-cell">Coverage</div>
    ${days.map(iso => { const a = coverageByDate.get(iso) || { needed: 0, filled: 0 }; return `<div class="${covCellCls(a.filled, a.needed)}">${a.filled} / ${a.needed}</div>`; }).join("")}
  </div>`;

  const emptyHtml = drivers.length === 0
    ? `<div class="rr-empty-inline">No active drivers yet. <span style="color:var(--accent-text);cursor:pointer" data-rr-goto-drivers>Add drivers →</span></div>`
    : "";

  // PD rows removed — Open Shifts pool on the right covers the same need
  // without taking grid real estate. Coverage strip stays.
  wrap.insertAdjacentHTML("beforeend", driverRowsHtml + coverageStripHtml + emptyHtml);

  // Strip mockup-injected banners that reference fake RR_DRIVERS data.
  const lic = document.getElementById("sched-license-banner");
  if (lic) lic.remove();

  renderSchedOpenShiftsPool(sub, grid.shifts || [], drivers, hoursPerDriver, shiftCountPerDriver, ptoByDriver, virtualByDate);
}

let _poolSortMode = "day"; // 'day' | 'wave'

function renderSchedOpenShiftsPool(sub, allShifts, drivers, hoursPerDriver, shiftCountPerDriver, ptoByDriver, virtualByDate) {
  const aside = sub.querySelector("aside.driver-pool");
  if (!aside) return;

  // Real open shifts = unassigned scheduled shifts in the visible week.
  const realOpen = (allShifts || []).filter(sh => !sh.driver_id && sh.status === "scheduled");

  // Virtual gaps = slots needed by OKAMI demand minus real shift rows. We
  // synthesize a chip per gap so the operator can drag-fill them; the drop
  // handler creates the missing shift row at that point.
  const virtualChips = [];
  if (virtualByDate) {
    for (const [date, list] of virtualByDate.entries()) {
      list.forEach((g, idx) => {
        virtualChips.push({
          virtual: true,
          synthId: `v:${date}:${g.station_id}:${idx}`,
          date,
          station_id: g.station_id,
          station_code: g.station_code,
          starts_at: `${date}T${g.wave_start || "07:00"}:00`,
          wave_start: g.wave_start || "07:00",
        });
      });
    }
  }

  const allChips = [...realOpen, ...virtualChips];
  const sorted = allChips.sort((a, b) => {
    if (_poolSortMode === "wave") {
      const at = (a.starts_at || "").slice(11, 16);
      const bt = (b.starts_at || "").slice(11, 16);
      if (at !== bt) return at < bt ? -1 : 1;
      return a.date < b.date ? -1 : 1;
    }
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.starts_at || "").localeCompare(b.starts_at || "");
  });

  const dayLabel = (iso) => {
    const d = new Date(iso + "T12:00:00");
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  };

  const fmtVirtualTime = (sh) => {
    // virtual chips don't have a real ends_at — derive a label from the
    // wave start + the configured block hours so the chip reads naturally.
    // Subtract report_lead_minutes so the chip shows the time we're
    // actually telling the driver to arrive at the station, matching
    // the real-shift chips after the DB-side fix.
    if (!sh.virtual) return (sh.starts_at && sh.ends_at) ? `${fmtTimeShort(sh.starts_at)} – ${fmtTimeShort(sh.ends_at)}` : "";
    const eff = window._rrEffectiveSettings || {};
    const block = eff.default_block_hours
      || (window.RR?.dsp?.metadata?.scheduling?.default_block_hours)
      || 10;
    const lead = Math.max(0, parseInt(eff.report_lead_minutes, 10) || 0);
    const [h, m] = (sh.wave_start || "07:00").split(":").map(Number);
    const startMins = ((h || 0) * 60 + (m || 0)) - lead;
    const endMins = startMins + block * 60;
    const fmt = (mins) => {
      // Wrap negatives (e.g. wave 00:10 minus 20min lead) cleanly.
      const total = ((mins % 1440) + 1440) % 1440;
      let hh = Math.floor(total / 60);
      const mm = total % 60;
      const ampm = hh >= 12 ? "pm" : "am";
      hh = hh % 12 || 12;
      return `${hh}:${String(mm).padStart(2,"0")}${ampm}`;
    };
    return `${fmt(startMins)} – ${fmt(endMins)}`;
  };

  const shiftItem = (sh, opts) => {
    const showDayLabel = !opts || opts.includeDay !== false;
    const time = fmtVirtualTime(sh);
    const ex = !sh.virtual && sh.is_cushion
      ? `<span style="display:inline-block;background:#FEF3C7;color:var(--amber-dark);font-size:9px;font-weight:700;padding:0 4px;border-radius:3px;margin-left:6px;letter-spacing:.04em">EX</span>`
      : "";
    const stCode = sh.service_type_code;
    const stColor = sh.service_type_color || "#0F6CBD";
    const stBadge = (!sh.virtual && stCode && stCode !== "SP")
      ? `<span style="display:inline-block;background:${escapeHtml(stColor)}20;color:${escapeHtml(stColor)};font-size:9px;font-weight:700;padding:0 4px;border-radius:3px;margin-left:6px;letter-spacing:.04em" title="${escapeHtml(sh.service_type_label || stCode)}">${escapeHtml(stCode)}</span>`
      : "";
    const newTag = sh.virtual
      ? `<span style="display:inline-block;background:rgba(37,99,235,.12);color:var(--accent-text);font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;margin-left:6px;letter-spacing:.04em" title="From route plan · open Route planning → Save to build">From plan</span>`
      : "";
    const route = (!sh.virtual && sh.route_code) ? `<span style="font-weight:600">${escapeHtml(sh.route_code)}</span>` : "";
    const headLine = showDayLabel
      ? `<div style="font-size:var(--fs-sm);font-weight:600;color:var(--text)">${dayLabel(sh.date)}${ex}${stBadge}${newTag}</div>
         <div style="font-size:var(--fs-xs);color:var(--text-subtle);font-variant-numeric:tabular-nums">${time}${route ? ` · ${route}` : ""}</div>`
      : `<div style="font-size:var(--fs-sm);font-weight:600;color:var(--text);font-variant-numeric:tabular-nums">${time}${ex}${stBadge}${newTag}</div>${route ? `<div style="font-size:var(--fs-xs);color:var(--text-subtle)">${route}</div>` : ""}`;
    const dragId = sh.virtual ? sh.synthId : sh.id;
    const virtAttrs = sh.virtual
      ? ` data-rr-pool-virtual="1" data-rr-pool-station="${sh.station_id}" data-rr-pool-wave="${sh.wave_start}"`
      : "";
    const styleEx = sh.virtual
      ? `border-style:dashed;background:repeating-linear-gradient(45deg,var(--surface),var(--surface) 6px,var(--canvas) 6px,var(--canvas) 12px)`
      : `background:var(--surface)`;
    const tooltip = sh.virtual
      ? "OKAMI gap · drag onto a driver to create + assign"
      : "Drag onto a driver to assign";
    return `<div class="rr-pool-shift" draggable="true"
        data-rr-pool-shift="${dragId}" data-rr-pool-shift-date="${sh.date}"${virtAttrs}
        style="display:flex;align-items:center;gap:10px;padding:6px 10px;border:1px solid var(--border);border-radius:8px;${styleEx};cursor:grab;margin-bottom:4px"
        title="${tooltip}">
      <div style="flex:1;min-width:0">${headLine}</div>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;color:var(--text-subtle);flex-shrink:0"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>
    </div>`;
  };

  // Group by day when sortMode === 'day' (more legible).
  let listHtml;
  if (sorted.length === 0) {
    listHtml = '<div style="padding:14px;font-size:var(--fs-sm);color:var(--text-subtle);text-align:center">All shifts assigned</div>';
  } else if (_poolSortMode === "day") {
    const byDay = new Map();
    for (const sh of sorted) {
      if (!byDay.has(sh.date)) byDay.set(sh.date, []);
      byDay.get(sh.date).push(sh);
    }
    listHtml = Array.from(byDay.entries()).map(([d, list]) =>
      `<div style="margin-bottom:10px"><div style="font-size:var(--fs-xs);font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin:8px 0 6px">${dayLabel(d)} · ${list.length}</div>${list.map(sh => shiftItem(sh, { includeDay: false })).join("")}</div>`
    ).join("");
  } else {
    listHtml = sorted.map(shiftItem).join("");
  }

  const totalCount = sorted.length;
  const countLabel = `${totalCount} open`;

  aside.innerHTML = `
    <div class="pool-head">
      <span>Open shifts</span>
      <span style="font-weight:600;letter-spacing:0;text-transform:none;color:var(--text-subtle);font-size:var(--fs-xs)">${countLabel}</span>
    </div>
    <button type="button" id="rr-unassign-week"
      style="width:100%;margin-bottom:8px;padding:6px 10px;font-size:var(--fs-xs);font-weight:600;color:var(--red);background:transparent;border:1px solid var(--border);border-radius:6px;cursor:pointer">
      Unassign all shifts this week
    </button>
    <div style="display:flex;gap:4px;background:var(--canvas);padding:3px;border-radius:6px;margin-bottom:8px">
      <button type="button" class="rr-pool-sort-btn" data-rr-pool-sort="day"
        style="flex:1;border:0;background:${_poolSortMode === 'day' ? 'var(--surface)' : 'transparent'};font:inherit;font-size:var(--fs-xs);font-weight:600;color:${_poolSortMode === 'day' ? 'var(--text)' : 'var(--text-muted)'};padding:5px 8px;border-radius:4px;cursor:pointer">Day</button>
      <button type="button" class="rr-pool-sort-btn" data-rr-pool-sort="wave"
        style="flex:1;border:0;background:${_poolSortMode === 'wave' ? 'var(--surface)' : 'transparent'};font:inherit;font-size:var(--fs-xs);font-weight:600;color:${_poolSortMode === 'wave' ? 'var(--text)' : 'var(--text-muted)'};padding:5px 8px;border-radius:4px;cursor:pointer">Wave time</button>
    </div>
    <div>${listHtml}</div>
    ${(() => {
      const ptoDrivers = drivers.filter(d => ptoByDriver?.has(d.id));
      if (ptoDrivers.length === 0) return "";
      const item = (d) => {
        const t = (ptoByDriver.get(d.id) || [])[0];
        const range = t ? `PTO ${t.start_date.slice(5)}–${t.end_date.slice(5)}` : "Off";
        return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:var(--fs-xs);color:var(--text-subtle)"><span>${escapeHtml(displayDriverName(d))}</span><span style="margin-left:auto">${escapeHtml(range)}</span></div>`;
      };
      return `<div style="margin-top:14px;border-top:1px solid var(--border);padding-top:10px">
        <div style="font-size:var(--fs-xs);font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px">PTO this week</div>
        ${ptoDrivers.map(item).join("")}
      </div>`;
    })()}
  `;
}

let _schedNavBound = false;
function bindSchedWeekNav() {
  if (_schedNavBound) return;
  const sub = document.getElementById("sched-sub-week");
  if (!sub) return;
  _schedNavBound = true;

  sub.addEventListener("click", (e) => {
    // 4-week tab strip — replaces the prev/next/Today buttons.
    const tab = e.target.closest(".sched-week-tab");
    if (tab && tab.dataset.rrWeekStart) {
      _schedStart = tab.dataset.rrWeekStart;
      // Settings must populate _rrEffectiveSettings before render so
      // the open-shifts pool reads this week's lead/waves.
      (async () => {
        try { await loadSchedulingSettings(); } catch (e) { console.warn("settings reload:", e); }
        try { await renderScheduleWeek();    } catch (e) { console.warn("render reload:", e); }
      })();
      return;
    }
    if (e.target.closest("[data-rr-goto-drivers]")) { if (typeof window.goto === "function") window.goto("drivers"); return; }

    // Click an ASSIGNED shift chip (not open, off, or timeoff) → open
    // edit modal with start/end inputs + a Remove option, instead of
    // the old confirm-and-delete flow. Operators wanted to nudge a
    // single driver's report time without removing-and-re-adding.
    const assignedChip = e.target.closest(".shift-chip[data-rr-shift-id]");
    if (assignedChip
        && !assignedChip.classList.contains("open")
        && !assignedChip.classList.contains("off")
        && !assignedChip.classList.contains("timeoff")) {
      e.stopPropagation();
      const id = assignedChip.dataset.rrShiftId;
      if (!id) return;
      if (!_confirmLiveScheduleEdit()) return;
      openShiftEditModal(id);
      return;
    }

    // Click empty driver-row cell → open add-shift modal pre-filled.
    const cell = e.target.closest('[data-rr-cell="driver-day"]');
    if (cell) {
      const hasShift = cell.querySelector(".shift-chip:not(.off):not(.timeoff)");
      if (hasShift) return;
      const date = cell.dataset.rrCellDate;
      const stationId = cell.dataset.rrCellStation;
      const driverId = cell.dataset.rrCellDriver;
      if (!date || !stationId) {
        toast(stationId ? "" : "Driver has no station — assign one in the Drivers page", "warn");
        return;
      }
      openAddShiftModal(date, stationId, driverId);
    }
  });

  // ── KPI: clicking the Rule violations card opens a list modal.
  sub.addEventListener("click", (e) => {
    const kpiHost = document.getElementById("rr-sched-kpis");
    if (!kpiHost) return;
    if (!e.target.closest("#rr-sched-kpis > div:nth-child(5)")) return;
    let v = [];
    try { v = JSON.parse(kpiHost.dataset.rrViolations || "[]"); } catch {}
    let m = document.getElementById("rr-violations-modal");
    if (m) m.remove();
    m = document.createElement("div");
    m.id = "rr-violations-modal";
    m.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px";
    const list = v.length === 0
      ? '<div class="rr-empty-inline">No rule violations this week ✓</div>'
      : v.map(x => `<div style="padding:10px 14px;border-top:1px solid var(--border);display:flex;gap:12px;align-items:center"><div style="flex:1"><div style="font-size:var(--fs-md);font-weight:600">${escapeHtml(x.driver)}</div><div style="font-size:var(--fs-xs);color:var(--text-subtle)">${escapeHtml(x.note)}</div></div><span style="font-size:var(--fs-xs);font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--red)">${x.kind.replace(/_/g, " ")}</span></div>`).join("");
    m.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;max-width:540px;width:100%;max-height:80vh;overflow-y:auto">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid var(--border)">
          <div><div style="font-size:var(--fs-base);font-weight:600">Rule violations</div><div style="font-size:var(--fs-sm);color:var(--text-subtle)">${v.length} this week</div></div>
          <button type="button" id="rr-vio-close" style="background:none;border:0;font-size:var(--fs-xl);cursor:pointer;color:var(--text-muted);padding:0 6px">×</button>
        </div>
        <div>${list}</div>
      </div>`;
    document.body.appendChild(m);
    m.addEventListener("click", (ev) => { if (ev.target === m || ev.target.id === "rr-vio-close") m.remove(); });
  });

  // ── Pool sort toggle (Day / Wave time)
  sub.addEventListener("click", (e) => {
    const sortBtn = e.target.closest("[data-rr-pool-sort]");
    if (!sortBtn) return;
    const mode = sortBtn.dataset.rrPoolSort;
    if (!mode || mode === _poolSortMode) return;
    _poolSortMode = mode;
    renderScheduleWeek();
  });

  // ── Unassign all shifts this week
  sub.addEventListener("click", async (e) => {
    if (e.target.id !== "rr-unassign-week") return;
    e.preventDefault();
    const dspId = window.RR?.dsp?.id;
    if (!dspId || !_schedStart) return;
    if (!_confirmLiveScheduleEdit()) return;
    const weekEndIso = fmtIsoDate(addDays(new Date(_schedStart + "T12:00:00"), 6));
    if (!confirm(`Unassign every driver from every shift between ${_schedStart} and ${weekEndIso}?\n\nShifts stay; only the driver assignments are cleared.`)) return;
    e.target.disabled = true;
    e.target.textContent = "Unassigning…";
    const { error, count } = await sb.from("shifts")
      .update({ driver_id: null }, { count: "exact" })
      .eq("dsp_id", dspId)
      .gte("date", _schedStart)
      .lte("date", weekEndIso)
      .not("driver_id", "is", null);
    e.target.disabled = false;
    e.target.textContent = "Unassign all shifts this week";
    if (error) { toast("Unassign failed: " + error.message, "warn"); return; }
    toast(`Unassigned ${count ?? "all"} shifts for the week`, "success");
    renderScheduleWeek();
  });

  // ── Drag-and-drop: pool SHIFT → driver-day cell.
  sub.addEventListener("dragstart", (e) => {
    const ps = e.target.closest("[data-rr-pool-shift]");
    if (!ps) return;
    e.dataTransfer.effectAllowed = "move";
    const isVirtual = ps.dataset.rrPoolVirtual === "1";
    e.dataTransfer.setData("application/x-rr-shift", JSON.stringify({
      id: ps.dataset.rrPoolShift,
      date: ps.dataset.rrPoolShiftDate,
      virtual: isVirtual,
      station_id: ps.dataset.rrPoolStation || null,
      wave_start: ps.dataset.rrPoolWave || null,
    }));
    ps.classList.add("rr-dragging");
  });
  sub.addEventListener("dragend", (e) => {
    const ps = e.target.closest("[data-rr-pool-shift]");
    if (ps) ps.classList.remove("rr-dragging");
    sub.querySelectorAll(".rr-drop-active").forEach(el => el.classList.remove("rr-drop-active"));
  });
  sub.addEventListener("dragover", (e) => {
    const cell = e.target.closest('[data-rr-cell="driver-day"]');
    if (!cell) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    cell.classList.add("rr-drop-active");
  });
  sub.addEventListener("dragleave", (e) => {
    const cell = e.target.closest('[data-rr-cell="driver-day"]');
    if (cell) cell.classList.remove("rr-drop-active");
  });
  sub.addEventListener("drop", async (e) => {
    const cell = e.target.closest('[data-rr-cell="driver-day"]');
    if (!cell) return;
    e.preventDefault();
    cell.classList.remove("rr-drop-active");
    const raw = e.dataTransfer.getData("application/x-rr-shift");
    if (!raw) return;
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    if (!payload?.id) return;
    const driverId = cell.dataset.rrCellDriver;
    if (!driverId) return;
    if (payload.virtual) {
      await materializeVirtualShiftToDriver(payload, driverId, cell);
    } else {
      await assignShiftToDriverWithRules(payload.id, payload.date, driverId, cell);
    }
  });
}

// Pre-assign rule check. Returns a list of human-readable violation
// strings; empty means clear to assign.
// Per-week violation summary for the KPI strip. Walks every assigned shift
// and surfaces issues operators care about: PTO conflicts, double-booking,
// over the max-days cap, and (when override is off) availability mismatches.
async function _computeWeekViolations(shifts, drivers, timeOff, weekStartIso, weekEndIso) {
  const violations = [];

  // Per-week settings.
  let maxDays = 5;
  let allowOverride = false;
  try {
    const { data: ws } = await sb.rpc("scheduling_settings_for_week", { p_week_start: weekStartIso });
    if (ws) {
      maxDays = Math.max(1, Math.min(7, ws.max_days_per_week ?? 5));
      allowOverride = !!ws.allow_availability_override;
    }
  } catch (_) {}

  // Service-type cert map — same gate Smart Fill uses. A driver assigned
  // to a shift whose service type requires DOT or XL certification but
  // the driver doesn't hold it surfaces here so the operator sees the
  // mistake on the weekly card.
  const serviceCerts = new Map();
  try {
    const dspId = window.RR?.dsp?.id;
    if (dspId) {
      const { data: svcs } = await sb.from("service_types")
        .select("id, code, label, requires_dot, requires_xl")
        .eq("dsp_id", dspId);
      for (const s of (svcs || [])) {
        serviceCerts.set(s.id, {
          requires_dot: !!s.requires_dot,
          requires_xl:  !!s.requires_xl,
          code:         s.code,
          label:        s.label,
        });
      }
    }
  } catch (_) {}

  const drvById = new Map(drivers.map(d => [d.id, d]));
  const ptoByDriver = new Map();
  for (const t of timeOff) {
    if (!ptoByDriver.has(t.driver_id)) ptoByDriver.set(t.driver_id, []);
    ptoByDriver.get(t.driver_id).push(t);
  }

  // Group assigned shifts per driver to detect over-cap and double-booking.
  const datesByDriver = new Map();
  for (const sh of shifts) {
    if (!sh.driver_id || sh.status !== "scheduled") continue;
    if (!datesByDriver.has(sh.driver_id)) datesByDriver.set(sh.driver_id, []);
    datesByDriver.get(sh.driver_id).push(sh);
  }

  const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

  for (const [driverId, list] of datesByDriver) {
    const d = drvById.get(driverId);
    if (!d) continue;
    const display = displayDriverName(d);

    // Over max-days
    const distinctDates = new Set(list.map(sh => sh.date));
    if (distinctDates.size > maxDays) {
      violations.push({ driver: display, date: null, kind: "max_days", note: `${distinctDates.size} shifts (cap ${maxDays})` });
    }

    // Double-bookings + PTO + availability per shift
    const seenDates = new Set();
    for (const sh of list) {
      if (seenDates.has(sh.date)) {
        violations.push({ driver: display, date: sh.date, kind: "double_book", note: `Two shifts on ${sh.date}` });
      }
      seenDates.add(sh.date);

      // Driver's license expired on or before this shift's date.
      // Mirrors the assignment-time check in _checkAssignViolations so a
      // driver scheduled with an expired DL surfaces in the weekly card.
      if (d.dl_expires_on && d.dl_expires_on < sh.date) {
        const expDate = new Date(d.dl_expires_on + "T12:00:00").toLocaleDateString();
        violations.push({ driver: display, date: sh.date, kind: "expired_dl", note: `License expired ${expDate}` });
      }

      // Service-type cert gate: same logic Smart Fill uses to skip
      // ineligible drivers. Surfaces when an operator manually assigned
      // a non-DOT driver onto a Step Van shift, etc.
      const cert = serviceCerts.get(sh.service_type_id);
      if (cert) {
        const stLabel = cert.label || cert.code || "this service type";
        if (cert.requires_dot && !d.dot_certified) {
          violations.push({ driver: display, date: sh.date, kind: "missing_dot",
            note: `${stLabel} requires DOT certification` });
        }
        if (cert.requires_xl && !d.xl_certified) {
          violations.push({ driver: display, date: sh.date, kind: "missing_xl",
            note: `${stLabel} requires XL certification` });
        }
      }

      // PTO
      const ptos = ptoByDriver.get(driverId) || [];
      if (ptos.some(t => sh.date >= t.start_date && sh.date <= t.end_date)) {
        violations.push({ driver: display, date: sh.date, kind: "pto", note: `Approved PTO on ${sh.date}` });
      }

      // Availability (skipped when override on)
      if (!allowOverride) {
        const days = (d.metadata?.availability?.days) || [];
        if (days.length > 0) {
          const dt = new Date(sh.date + "T12:00:00");
          if (!days.includes(DOW[dt.getDay()])) {
            violations.push({ driver: display, date: sh.date, kind: "availability", note: `Not available on ${dt.toLocaleDateString(undefined, { weekday: "long" })}` });
          }
        }
      }

      // Earliest-start: the shift begins before the time of day the driver
      // flagged as the earliest they can start. Surfaces even under an
      // availability override — "can't physically be there yet" is a hard rule.
      {
        const es  = d.metadata?.availability?.earliest_start;
        const shm = _shiftStartHM(sh.starts_at);
        if (es && shm && _startsBeforeEarliest(shm, es)) {
          violations.push({ driver: display, date: sh.date, kind: "earliest_start",
            note: `Shift starts ${_fmtTime12(shm) || shm}; available from ${_fmtTime12(es) || es}` });
        }
      }
    }

    // ── Working hours compliance (WOC) ────────────────────────────────
    const WOC = { max_hours_per_week: 55, max_consecutive_days: 6, min_rest_hours: 10 };

    // Total hours this week
    const totalHrs = list.reduce((s, sh) => {
      if (sh.starts_at && sh.ends_at) return s + Math.max(0, (new Date(sh.ends_at) - new Date(sh.starts_at)) / 3600000);
      return s + (Number(sh.block_hours) || 10);
    }, 0);
    if (totalHrs > WOC.max_hours_per_week) {
      violations.push({ driver: display, date: null, kind: "woc_max_hours",
        note: `${Math.round(totalHrs)}h scheduled (cap ${WOC.max_hours_per_week}h)` });
    }

    // Max consecutive days — sort dates, find longest run.
    const sortedDates = [...new Set(list.map(sh => sh.date))].sort();
    let runStart = null, runLen = 0, maxRun = 0;
    for (const iso of sortedDates) {
      if (!runStart) { runStart = iso; runLen = 1; }
      else {
        const prev = new Date(runStart + "T12:00:00");
        const cur  = new Date(iso + "T12:00:00");
        const diff = Math.round((cur - prev) / 86400000);
        if (diff === runLen) runLen += 1;
        else { if (runLen > maxRun) maxRun = runLen; runStart = iso; runLen = 1; }
      }
    }
    if (runLen > maxRun) maxRun = runLen;
    if (maxRun > WOC.max_consecutive_days) {
      violations.push({ driver: display, date: null, kind: "woc_consecutive",
        note: `${maxRun} days in a row (cap ${WOC.max_consecutive_days})` });
    }

    // Min rest between consecutive shifts.
    const sortedShifts = [...list].filter(sh => sh.starts_at && sh.ends_at)
      .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
    for (let i = 1; i < sortedShifts.length; i++) {
      const prev = sortedShifts[i - 1];
      const curr = sortedShifts[i];
      const gap = (new Date(curr.starts_at) - new Date(prev.ends_at)) / 3600000;
      if (gap >= 0 && gap < WOC.min_rest_hours) {
        violations.push({ driver: display, date: curr.date, kind: "woc_rest",
          note: `Only ${gap.toFixed(1)}h rest before ${curr.date} (min ${WOC.min_rest_hours}h)` });
      }
    }
  }

  return violations;
}

async function _checkAssignViolations(shiftId, shiftDate, driverId, candidateShiftOverride) {
  const dspId = window.RR?.dsp?.id;
  if (!dspId || !_schedStart) return [];
  const violations = [];

  // Per-week settings (max-days + override flag).
  let maxDays = 5;
  let allowOverride = false;
  try {
    const { data: ws } = await sb.rpc("scheduling_settings_for_week", { p_week_start: _schedStart });
    if (ws) {
      maxDays = Math.max(1, Math.min(7, ws.max_days_per_week ?? 5));
      allowOverride = !!ws.allow_availability_override;
    }
  } catch (_) {}

  const weekEnd = addDays(new Date(_schedStart + "T12:00:00"), 6);
  const weekEndIso = fmtIsoDate(weekEnd);

  // For virtual chips we don't have a real shift row to fetch. The caller
  // passes a synthesized candidate (date + starts_at + ends_at + block) so
  // the WOC math can run identically.
  const candidateFetch = candidateShiftOverride
    ? Promise.resolve({ data: candidateShiftOverride })
    : sb.from("shifts").select("id, date, starts_at, ends_at, block_hours, service_type_id").eq("id", shiftId).single();

  const [drvRes, ptoRes, shiftsRes, candidateRes, svcRes] = await Promise.all([
    sb.from("drivers").select("id, full_name, metadata, dl_expires_on, dot_certified, xl_certified").eq("id", driverId).single(),
    sb.from("time_off_requests").select("start_date, end_date")
      .eq("dsp_id", dspId).eq("driver_id", driverId).eq("status", "approved")
      .lte("start_date", weekEndIso).gte("end_date", _schedStart),
    sb.from("shifts").select("id, date, status, driver_id, starts_at, ends_at, block_hours")
      .eq("dsp_id", dspId).eq("driver_id", driverId)
      .gte("date", _schedStart).lte("date", weekEndIso),
    candidateFetch,
    sb.from("service_types").select("id, code, label, requires_dot, requires_xl").eq("dsp_id", dspId),
  ]);

  const driver = drvRes.data;
  if (!driver) { violations.push("Driver not found"); return violations; }

  // Driver's license check: DL must be valid on the shift date. Drivers
  // without dl_expires_on set aren't blocked here (operator hasn't filled
  // it in yet) — same rule auto-assign uses.
  if (driver.dl_expires_on && driver.dl_expires_on < shiftDate) {
    const expDate = new Date(driver.dl_expires_on + "T12:00:00").toLocaleDateString();
    violations.push(`Driver's license expired ${expDate}`);
  }

  // Service-type cert gate: Step Vans need DOT, XL needs XL.  candShift
  // is fetched above; for virtual chips the override may not carry a
  // service_type_id so the gate quietly no-ops in that case.
  const candShiftEarly = candidateRes?.data;
  const stId = candShiftEarly?.service_type_id;
  if (stId) {
    const st = (svcRes?.data || []).find(s => s.id === stId);
    if (st) {
      const stLabel = st.label || st.code || "this service type";
      if (st.requires_dot && !driver.dot_certified) {
        violations.push(`${stLabel} requires DOT certification`);
      }
      if (st.requires_xl && !driver.xl_certified) {
        violations.push(`${stLabel} requires XL certification`);
      }
    }
  }

  // PTO check
  for (const t of (ptoRes.data || [])) {
    if (shiftDate >= t.start_date && shiftDate <= t.end_date) {
      violations.push(`Driver has approved PTO on ${shiftDate}`);
      break;
    }
  }

  // Already-shifted-that-day check
  const sameDay = (shiftsRes.data || []).find(sh => sh.date === shiftDate && sh.id !== shiftId && sh.status === "scheduled");
  if (sameDay) violations.push(`Driver already has a shift on ${shiftDate}`);

  // Max-days check (count distinct dates assigned this week, excluding the
  // shift being moved if it's already assigned to this driver — not the case here).
  const datesThisWeek = new Set((shiftsRes.data || []).filter(sh => sh.status === "scheduled").map(sh => sh.date));
  if (!datesThisWeek.has(shiftDate) && datesThisWeek.size >= maxDays) {
    violations.push(`Driver already has ${datesThisWeek.size} shifts this week (cap: ${maxDays})`);
  }

  // Availability check (skip if override is on)
  if (!allowOverride) {
    const days = (driver.metadata?.availability?.days) || [];
    const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const dt = new Date(shiftDate + "T12:00:00");
    const dow = DOW[dt.getDay()];
    if (days.length === 0) {
      violations.push("Driver has no availability set");
    } else if (!days.includes(dow)) {
      violations.push(`Driver isn't available on ${dt.toLocaleDateString(undefined, { weekday: "long" })}`);
    }
  }

  // Earliest-start time the driver can begin a shift (metadata.availability).
  {
    const es  = driver.metadata?.availability?.earliest_start;
    const shm = _shiftStartHM(candShiftEarly?.starts_at);
    if (es && shm && _startsBeforeEarliest(shm, es)) {
      violations.push(`Shift starts ${_fmtTime12(shm) || shm}, driver available from ${_fmtTime12(es) || es}`);
    }
  }

  // ── Working hours compliance (WOC) on the proposed assignment.
  const WOC = { max_hours_per_week: 55, max_consecutive_days: 6, min_rest_hours: 10 };
  const candShift = candidateRes?.data;
  const existing = (shiftsRes.data || []).filter(sh => sh.status === "scheduled" && sh.id !== shiftId);
  const allShifts = [...existing, candShift].filter(Boolean);
  const shiftHours = (sh) => {
    if (sh.starts_at && sh.ends_at) return Math.max(0, (new Date(sh.ends_at) - new Date(sh.starts_at)) / 3600000);
    return Number(sh.block_hours) || 10;
  };
  // Total hours
  const totalHrs = allShifts.reduce((s, sh) => s + shiftHours(sh), 0);
  if (totalHrs > WOC.max_hours_per_week) {
    violations.push(`Would push driver to ${Math.round(totalHrs)}h this week (cap ${WOC.max_hours_per_week}h)`);
  }
  // Consecutive days
  const sortedDates = [...new Set(allShifts.map(sh => sh.date))].sort();
  let runStart = null, runLen = 0, maxRun = 0;
  for (const iso of sortedDates) {
    if (!runStart) { runStart = iso; runLen = 1; }
    else {
      const prev = new Date(runStart + "T12:00:00");
      const cur  = new Date(iso + "T12:00:00");
      const diff = Math.round((cur - prev) / 86400000);
      if (diff === runLen) runLen += 1;
      else { if (runLen > maxRun) maxRun = runLen; runStart = iso; runLen = 1; }
    }
  }
  if (runLen > maxRun) maxRun = runLen;
  if (maxRun > WOC.max_consecutive_days) {
    violations.push(`Would put driver on ${maxRun} consecutive days (cap ${WOC.max_consecutive_days})`);
  }
  // Min rest between adjacent shifts
  const sortedShifts = allShifts.filter(sh => sh.starts_at && sh.ends_at)
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  for (let i = 1; i < sortedShifts.length; i++) {
    const gap = (new Date(sortedShifts[i].starts_at) - new Date(sortedShifts[i - 1].ends_at)) / 3600000;
    if (gap >= 0 && gap < WOC.min_rest_hours) {
      violations.push(`Less than ${WOC.min_rest_hours}h rest between shifts (${gap.toFixed(1)}h)`);
      break;
    }
  }

  return violations;
}

async function assignShiftToDriverWithRules(shiftId, shiftDate, driverId, cell) {
  if (!_confirmLiveScheduleEdit()) return;
  const violations = await _checkAssignViolations(shiftId, shiftDate, driverId);
  if (violations.length > 0) {
    const msg = "Rule violations:\n\n• " + violations.join("\n• ") + "\n\nSchedule anyway?";
    if (!confirm(msg)) return;
  }
  const { error } = await sb.rpc("assign_shift", { p_id: shiftId, p_driver_id: driverId });
  if (error) { toast("Assign failed: " + error.message, "warn"); return; }
  toast(violations.length > 0 ? "Assigned (override)" : "Shift assigned", "success");
  renderScheduleWeek();
}

// Materialize a virtual gap chip into a real shifts row owned by the
// chosen driver. Honors the cell's date (so dragging a Monday gap onto
// a Friday cell creates Friday's shift), and runs the same rule checks
// real-shift assignments do.
async function materializeVirtualShiftToDriver(payload, driverId, cell) {
  if (!_confirmLiveScheduleEdit()) return;
  // Drop target's date wins — the operator is choosing the day they're
  // putting the driver on, not honoring the gap's original day.
  const date = cell.dataset.rrCellDate || payload.date;
  const stationId = cell.dataset.rrCellStation || payload.station_id;
  const block = (window.RR?.dsp?.metadata?.scheduling?.default_block_hours) || 10;
  const wave = payload.wave_start || "07:00";
  const startsLocal = `${date}T${wave}:00`;
  const startsAt = new Date(startsLocal);
  const endsAt = new Date(startsAt.getTime() + block * 3600 * 1000);

  const violations = await _checkAssignViolations(null, date, driverId, {
    id: null,
    date,
    starts_at: startsAt.toISOString(),
    ends_at:   endsAt.toISOString(),
    block_hours: block,
  });
  if (violations.length > 0) {
    const msg = "Rule violations:\n\n• " + violations.join("\n• ") + "\n\nSchedule anyway?";
    if (!confirm(msg)) return;
  }

  const insertPayload = {
    date,
    station_id: stationId,
    driver_id: driverId,
    starts_at: startsAt.toISOString(),
    ends_at:   endsAt.toISOString(),
    source: "manual",
  };
  const { error } = await sb.rpc("create_shift", { p_payload: insertPayload });
  if (error) { toast("Create + assign failed: " + error.message, "warn"); return; }
  toast(violations.length > 0 ? "Created (override)" : "Shift created and assigned", "success");
  renderScheduleWeek();
}

function openAddShiftModal(date, stationId, prefDriverId) {
  let m = document.getElementById("rr-shift-modal");
  if (m) m.remove();
  m = document.createElement("div");
  m.id = "rr-shift-modal";
  m.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px";
  m.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;max-width:440px;width:100%">
      <h3 style="margin:0 0 14px;font-size:var(--fs-lg);font-weight:600">Add shift</h3>
      <label style="display:block;font-size:var(--fs-xs);font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Date</label>
      <input type="date" id="rr-sh-date" class="form-input" style="width:100%;margin-bottom:10px" value="${date}"/>
      <label style="display:block;font-size:var(--fs-xs);font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Driver (optional · leave blank for open shift)</label>
      <select id="rr-sh-driver" class="form-input" style="width:100%;margin-bottom:10px">
        <option value="">— Open shift —</option>
        ${_schedDriverList.map(d => `<option value="${d.id}"${prefDriverId === d.id ? " selected" : ""}>${escapeHtml(displayDriverName(d))}</option>`).join("")}
      </select>
      <label style="display:block;font-size:var(--fs-xs);font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Route</label>
      <input id="rr-sh-route" class="form-input" style="width:100%;margin-bottom:14px" placeholder="e.g. KMO1-14B"/>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn" data-rr-sh-cancel>Cancel</button>
        <button class="btn btn-primary" data-rr-sh-save>Add shift</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener("click", async (e) => {
    if (e.target.closest("[data-rr-sh-cancel]") || e.target === m) { m.remove(); return; }
    if (e.target.closest("[data-rr-sh-save]")) {
      const payload = {
        date: document.getElementById("rr-sh-date").value,
        station_id: stationId,
        driver_id: document.getElementById("rr-sh-driver").value || null,
        route_code: document.getElementById("rr-sh-route").value.trim() || null,
      };
      if (!_confirmLiveScheduleEdit()) return;
      const { error } = await sb.rpc("create_shift", { p_payload: payload });
      if (error) { toast("Save failed: " + error.message, "warn"); return; }
      m.remove();
      toast("Shift added", "success");
      loadScheduleView();
    }
  });
}

function openAssignShiftModal(shiftId) {
  let m = document.getElementById("rr-shift-modal");
  if (m) m.remove();
  m = document.createElement("div");
  m.id = "rr-shift-modal";
  m.className = "modal-backdrop open";
  m.innerHTML = `
    <div class="modal-card" style="max-width:380px">
      <div class="modal-head">
        <div>
          <p class="modal-title">Assign shift</p>
          <p class="modal-sub">Pick a driver to take this open slot</p>
        </div>
        <button type="button" class="modal-close" data-rr-as-cancel aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <select id="rr-as-driver" class="form-input" style="width:100%">
          ${_schedDriverList.map(d => `<option value="${d.id}">${escapeHtml(displayDriverName(d))}</option>`).join("")}
        </select>
      </div>
      <div class="modal-foot">
        <button class="btn" data-rr-as-cancel>Cancel</button>
        <button class="btn btn-primary" data-rr-as-save>Assign</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener("click", async (e) => {
    if (e.target.closest("[data-rr-as-cancel]") || e.target === m) { m.remove(); return; }
    if (e.target.closest("[data-rr-as-save]")) {
      if (!_confirmLiveScheduleEdit()) return;
      const did = document.getElementById("rr-as-driver").value;
      const { error } = await sb.rpc("assign_shift", { p_id: shiftId, p_driver_id: did });
      if (error) { toast("Assign failed: " + error.message, "warn"); return; }
      m.remove();
      toast("Shift assigned", "success");
      loadScheduleView();
    }
  });
}


// ─── Time off ─────────────────────────────────────────────────────────────

async function loadTimeOffList() {
  const sub = document.getElementById("sched-sub-timeoff");
  if (!sub) return;
  const { data: rows, error } = await sb.from("time_off_requests")
    .select("id, driver_id, start_date, end_date, reason, status, decided_at, drivers:driver_id (full_name)")
    .eq("dsp_id", window.RR.dsp.id)
    .order("start_date", { ascending: false })
    .limit(200);
  if (error) { sub.innerHTML = `<div style="padding:24px;color:var(--red)">${escapeHtml(error.message)}</div>`; return; }

  const pending = (rows || []).filter(r => r.status === "pending");
  const past    = (rows || []).filter(r => r.status !== "pending");

  sub.innerHTML = `
    <div style="margin-bottom:var(--s-3);display:flex;align-items:center;justify-content:space-between">
      <h3 style="margin:0;font-size:var(--fs-lg);font-weight:600">Time off</h3>
      <button class="btn btn-sm btn-primary" data-rr-add-time-off>+ Add request</button>
    </div>
    <div class="card card-flush">
      <div style="padding:8px 14px;background:var(--canvas);font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Pending (${pending.length})</div>
      ${pending.length === 0 ? `<div class="rr-empty-inline">No pending requests.</div>` : pending.map(timeOffRow).join("")}
      <div style="padding:8px 14px;background:var(--canvas);font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted);border-top:1px solid var(--border)">Past (${past.length})</div>
      ${past.length === 0 ? `<div class="rr-empty-inline">No past requests.</div>` : past.map(timeOffRow).join("")}
    </div>`;
}

function timeOffRow(r) {
  const range = r.start_date === r.end_date
    ? new Date(r.start_date + "T12:00:00").toLocaleDateString()
    : `${new Date(r.start_date + "T12:00:00").toLocaleDateString()} → ${new Date(r.end_date + "T12:00:00").toLocaleDateString()}`;
  const statusVariant = {
    pending:   "pending",
    approved:  "approved",
    denied:    "denied",
    cancelled: "neutral",
  }[r.status] || "neutral";
  return `
    <div style="display:grid;grid-template-columns:1fr 1fr 110px 1fr auto;gap:var(--s-3);align-items:center;padding:var(--s-3) var(--s-4);border-top:1px solid var(--border)">
      <div style="font-size:var(--fs-md);font-weight:600">${escapeHtml(r.drivers?.full_name || "—")}</div>
      <div style="font-size:var(--fs-sm)">${range}</div>
      <div><span class="status-pill status-pill-${statusVariant}">${escapeHtml(r.status)}</span></div>
      <div style="font-size:var(--fs-sm);color:var(--text-subtle)">${escapeHtml(r.reason || "")}</div>
      <div style="display:flex;gap:var(--s-2);justify-content:flex-end">${r.status === "pending" ? `
        <button class="btn btn-sm btn-danger" data-rr-time-off-decide="${r.id}" data-decision="deny">Deny</button>
        <button class="btn btn-sm btn-primary" data-rr-time-off-decide="${r.id}" data-decision="approve">Approve</button>
      ` : ""}</div>
    </div>`;
}

document.addEventListener("click", async (e) => {
  if (e.target.closest("[data-rr-add-time-off]")) {
    e.preventDefault(); e.stopImmediatePropagation();
    openTimeOffModal();
  }
  const dec = e.target.closest("[data-rr-time-off-decide]");
  if (dec) {
    e.preventDefault(); e.stopImmediatePropagation();
    const id = dec.getAttribute("data-rr-time-off-decide");
    const d  = dec.getAttribute("data-decision");
    const { error } = await sb.rpc("decide_time_off", { p_id: id, p_decision: d, p_notes: null });
    if (error) { toast("Update failed: " + error.message, "warn"); return; }
    toast(`Marked ${d}d`, "success");
    loadTimeOffList();
  }
}, true);

function openTimeOffModal() {
  let m = document.getElementById("rr-shift-modal");
  if (m) m.remove();
  m = document.createElement("div");
  m.id = "rr-shift-modal";
  m.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px";
  m.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;max-width:440px;width:100%">
      <h3 style="margin:0 0 14px;font-size:var(--fs-lg);font-weight:600">Time off request</h3>
      <label style="display:block;font-size:var(--fs-xs);font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Driver</label>
      <select id="rr-to-driver" class="form-input" style="width:100%;margin-bottom:10px">
        ${_schedDriverList.map(d => `<option value="${d.id}">${escapeHtml(displayDriverName(d))}</option>`).join("")}
      </select>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <div><label style="display:block;font-size:var(--fs-xs);font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Start</label><input type="date" id="rr-to-start" class="form-input" style="width:100%"/></div>
        <div><label style="display:block;font-size:var(--fs-xs);font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">End</label><input type="date" id="rr-to-end" class="form-input" style="width:100%"/></div>
      </div>
      <label style="display:block;font-size:var(--fs-xs);font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Reason</label>
      <input id="rr-to-reason" class="form-input" style="width:100%;margin-bottom:14px" placeholder="Vacation / personal / sick / …"/>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn" data-rr-to-cancel>Cancel</button>
        <button class="btn btn-primary" data-rr-to-save>Save request</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener("click", async (e) => {
    if (e.target.closest("[data-rr-to-cancel]") || e.target === m) { m.remove(); return; }
    if (e.target.closest("[data-rr-to-save]")) {
      const payload = {
        driver_id: document.getElementById("rr-to-driver").value,
        start_date: document.getElementById("rr-to-start").value,
        end_date:   document.getElementById("rr-to-end").value,
        reason:     document.getElementById("rr-to-reason").value.trim() || null,
      };
      if (!payload.start_date || !payload.end_date) { toast("Pick a date range", "warn"); return; }
      const { error } = await sb.rpc("request_time_off", { p_payload: payload });
      if (error) { toast("Save failed: " + error.message, "warn"); return; }
      m.remove();
      toast("Time off saved", "success");
      loadTimeOffList();
    }
  });
}


// ─── Open shifts ─────────────────────────────────────────────────────────

async function loadOpenShifts() {
  const sub = document.getElementById("sched-sub-open");
  if (!sub) return;
  const today = fmtIsoDate(new Date());
  const { data: rows, error } = await sb.from("shifts")
    .select("id, date, station_id, route_code, status, station:station_id (code)")
    .eq("dsp_id", window.RR.dsp.id)
    .is("driver_id", null)
    .gte("date", today)
    .order("date", { ascending: true })
    .limit(500);
  if (error) { sub.innerHTML = `<div style="padding:24px;color:var(--red)">${escapeHtml(error.message)}</div>`; return; }

  if (!rows || rows.length === 0) {
    sub.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-subtle);font-size:var(--fs-md)"><strong style="color:var(--text-muted);display:block;margin-bottom:4px">No open shifts</strong>Add shifts from the Week view, or leave the driver picker blank when adding to create one.</div>`;
    return;
  }
  sub.innerHTML = `
    <h3 style="margin:0 0 var(--s-3);font-size:var(--fs-lg);font-weight:600">Open shifts (${rows.length})</h3>
    <div class="card card-flush">
      <div style="display:grid;grid-template-columns:130px 90px 1fr 100px;gap:10px;padding:8px 14px;background:var(--canvas);font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">
        <div>Date</div><div>Station</div><div>Route</div><div></div>
      </div>
      ${rows.map(r => `
        <div style="display:grid;grid-template-columns:130px 90px 1fr 100px;gap:10px;align-items:center;padding:10px 14px;border-top:1px solid var(--border)">
          <div style="font-size:var(--fs-md);font-weight:600">${new Date(r.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</div>
          <div style="font-size:var(--fs-md)">${escapeHtml(r.station?.code || "—")}</div>
          <div style="font-size:var(--fs-md);font-family:'SF Mono',Menlo,monospace;color:var(--text-muted)">${escapeHtml(r.route_code || "—")}</div>
          <div><button class="btn btn-sm btn-primary" data-rr-shift-id="${r.id}">Assign</button></div>
        </div>`).join("")}
    </div>`;
}


// ─── Staffing outlook ──────────────────────────────────────────────────
// Forward-looking capacity check: across the next few weeks of generated
// shifts, can the current roster (availability + PTO + the weekly-day cap)
// cover the routes — and if not, who should the DSP talk to about opening
// their availability, and what days do they need to hire for?  All the
// math runs client-side from data the dashboard already has access to.

const _OUTLOOK_WEEKS   = 4;                                           // weeks ahead to model
const _OUTLOOK_DOW     = ["mon","tue","wed","thu","fri","sat","sun"]; // index 0 = Monday
const _OUTLOOK_DOW_LBL = { mon:"Mon", tue:"Tue", wed:"Wed", thu:"Thu", fri:"Fri", sat:"Sat", sun:"Sun" };
const _dowKeyMon = (iso) => _OUTLOOK_DOW[(new Date(iso + "T12:00:00").getDay() + 6) % 7]; // getDay 0=Sun → mon-indexed

// Match drivers to one week's dates: max-flow (Edmonds–Karp) over
// source → driver (cap = weekly day-cap) → date (cap 1 per available
// non-PTO day) → sink (cap = that date's demand).  Returns the number of
// shifts coverable and the per-date shortfall.
function _outlookMatchWeek(driverIds, driverDates, demandByDate, cap) {
  const dates = [...demandByDate.keys()];
  const totalDemand = dates.reduce((s, d) => s + demandByDate.get(d), 0);
  if (totalDemand === 0 || driverIds.length === 0 || cap <= 0) {
    return { covered: 0, demand: totalDemand, deficitByDate: new Map(dates.map(d => [d, demandByDate.get(d)])) };
  }
  const D = driverIds.length, K = dates.length;
  const S = 0, T = D + K + 1, n = T + 1;
  const dateNode = new Map(dates.map((d, i) => [d, 1 + D + i]));
  const g = Array.from({ length: n }, () => []);
  const addEdge = (u, v, c) => { g[u].push({ to: v, cap: c, rev: g[v].length }); g[v].push({ to: u, cap: 0, rev: g[u].length - 1 }); };
  driverIds.forEach((id, i) => {
    addEdge(S, 1 + i, cap);
    const can = driverDates.get(id);
    if (can) for (const d of can) if (dateNode.has(d)) addEdge(1 + i, dateNode.get(d), 1);
  });
  for (const d of dates) addEdge(dateNode.get(d), T, demandByDate.get(d));
  let covered = 0;
  for (;;) {
    const prevNode = new Array(n).fill(-1), prevEdge = new Array(n).fill(-1);
    const q = [S]; prevNode[S] = S;
    while (q.length) {
      const u = q.shift(); if (u === T) break;
      g[u].forEach((e, i) => { if (e.cap > 0 && prevNode[e.to] === -1) { prevNode[e.to] = u; prevEdge[e.to] = i; q.push(e.to); } });
    }
    if (prevNode[T] === -1) break;
    let aug = Infinity;
    for (let v = T; v !== S; v = prevNode[v]) aug = Math.min(aug, g[prevNode[v]][prevEdge[v]].cap);
    for (let v = T; v !== S; v = prevNode[v]) { const e = g[prevNode[v]][prevEdge[v]]; e.cap -= aug; g[v][e.rev].cap += aug; }
    covered += aug;
  }
  const deficitByDate = new Map();
  for (const d of dates) {
    const e = g[dateNode.get(d)].find(x => x.to === T);   // forward date→sink edge; residual cap = unfilled demand
    deficitByDate.set(d, e ? e.cap : demandByDate.get(d));
  }
  return { covered, demand: totalDemand, deficitByDate };
}

// ─── Hiring targets — the pipeline ↔ schedule bridge ───────────────────
// A hiring target turns a structural gap from the Staffing outlook ("short
// ~2 Saturday drivers") into something the Pipeline page tracks against
// ("Sat drivers: 1 of 2 — Devon onboarding ✓, need 1 more").

async function _fetchHiringTargets() {
  const { data, error } = await sb.rpc("hiring_target_list");
  if (error) { console.warn("hiring_target_list:", error.message); return []; }
  const list = Array.isArray(data) ? data : [];
  window._rrHiringTargets = list;
  return list;
}
function _hiringTargetRowHtml(t) {
  const need  = t.needed_count || 1;
  const got   = (t.matched || []).length;
  const met   = got >= need;
  const days  = (t.days || []).map(k => _OUTLOOK_DOW_LBL[k] || k).join(", ");
  const title = (t.label && t.label.trim()) || (days ? `${days} drivers` : "Drivers");
  const cert  = t.service_type_code ? ` · ${escapeHtml(t.service_type_code)}` : "";
  const es    = t.earliest_start_max ? ` · start ≤ ${escapeHtml(_fmtTime12(t.earliest_start_max) || t.earliest_start_max)}` : "";
  const names = (t.matched || []).map(m => escapeHtml(m.name)).join(", ");
  const badge = t.status === "filled"    ? `<span class="status-pill status-pill-approved">Filled</span>`
              : t.status === "cancelled" ? `<span class="status-pill status-pill-denied">Removed</span>`
              : (met ? `<span class="status-pill status-pill-approved">Met · ${got}/${need}</span>` : `<span class="status-pill status-pill-pending">${got}/${need}</span>`);
  return `<div style="padding:8px 12px;border-top:1px solid var(--border-subtle);display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <div style="flex:1;min-width:140px">
      <div style="font-weight:600;font-size:var(--fs-md)">${escapeHtml(title)}${days && !(t.label && t.label.trim()) ? "" : (days ? ` <span style="font-weight:400;color:var(--text-subtle);font-size:var(--fs-xs)">(${escapeHtml(days)})</span>` : "")}${cert}${es}</div>
      <div style="font-size:var(--fs-xs);color:var(--text-muted)">${got > 0 ? `In onboarding: ${names}` : "No onboarding drivers match this yet"}</div>
    </div>
    ${badge}
    <button class="btn btn-sm" type="button" data-rr-target-edit="${escapeHtml(t.id)}">Edit</button>
    ${t.status === "open"
      ? `<button class="btn btn-sm" type="button" data-rr-target-action="filled" data-rr-target-id="${escapeHtml(t.id)}">Close</button>`
      : `<button class="btn btn-sm" type="button" data-rr-target-action="open" data-rr-target-id="${escapeHtml(t.id)}">Reopen</button>`}
    <button class="btn btn-sm" type="button" data-rr-target-action="cancelled" data-rr-target-id="${escapeHtml(t.id)}" title="Remove this target">✕</button>
  </div>`;
}
function _renderHiringTargetsCard(elId, targets, opts = {}) {
  const el = document.getElementById(elId);
  if (!el) return;
  const show = (opts.includeClosed ? targets : targets.filter(t => t.status === "open")).slice(0, opts.includeClosed ? 12 : 50);
  el.innerHTML = `<div class="card" style="margin-bottom:16px">
    <div class="card-head" style="display:flex;align-items:center;justify-content:space-between"><div class="card-title">Hiring targets${opts.subtitle ? ` <span style="font-weight:400;color:var(--text-subtle);font-size:var(--fs-xs)">${escapeHtml(opts.subtitle)}</span>` : ""}</div><button class="btn btn-sm" type="button" data-rr-target-new>+ New target</button></div>
    ${show.length === 0
      ? `<div style="padding:12px 14px;color:var(--text-subtle);font-size:var(--fs-sm)">No open hiring targets — create one here, or from a gap on the Staffing outlook page.</div>`
      : show.map(_hiringTargetRowHtml).join("")}
  </div>`;
}
async function _reloadTargetsViews() {
  const targets = await _fetchHiringTargets();
  if (document.getElementById("rr-outlook-targets")) _renderHiringTargetsCard("rr-outlook-targets", targets, { includeClosed: true, subtitle: "open + recently closed" });
}
document.addEventListener("click", async (e) => {
  // Close / reopen / remove a target.
  const ta = e.target.closest("[data-rr-target-action]");
  if (ta) {
    e.preventDefault();
    const id = ta.getAttribute("data-rr-target-id");
    const status = ta.getAttribute("data-rr-target-action");
    if (status === "cancelled" && !confirm("Remove this hiring target?")) return;
    ta.disabled = true;
    const { error } = await sb.rpc("hiring_target_upsert", { p_payload: { id, status } });
    if (error) { toast("Failed: " + error.message, "warn"); ta.disabled = false; return; }
    toast(status === "filled" ? "Target closed" : status === "cancelled" ? "Target removed" : "Target reopened", "success");
    await _reloadTargetsViews();
    return;
  }
  // Create a target from a Staffing-outlook "hire for these days" row.
  const tc = e.target.closest("[data-rr-create-target]");
  if (tc) {
    e.preventDefault();
    const day   = tc.getAttribute("data-rr-create-target") || "";
    const count = Math.max(1, parseInt(tc.getAttribute("data-rr-create-count") || "1", 10) || 1);
    const label = day ? `${_OUTLOOK_DOW_LBL[day] || day} drivers` : "New hire";
    tc.disabled = true;
    const { error } = await sb.rpc("hiring_target_upsert", { p_payload: { label, needed_count: count, days: day ? [day] : [] } });
    if (error) { toast("Failed: " + error.message, "warn"); tc.disabled = false; return; }
    toast("Hiring target created — it's tracked on the Pipeline page", "success");
    await _reloadTargetsViews();
    return;
  }
  // New / edit a target via the full form.
  if (e.target.closest("[data-rr-target-new]")) { e.preventDefault(); _openHiringTargetModal(null); return; }
  const te = e.target.closest("[data-rr-target-edit]");
  if (te) {
    e.preventDefault();
    const id = te.getAttribute("data-rr-target-edit");
    const t = (window._rrHiringTargets || []).find(x => x.id === id);
    if (t) _openHiringTargetModal(t);
    return;
  }
});

// Create/edit form for a hiring target.  hiring_target_upsert accepts all
// of these fields; passing an `id` updates instead of inserting.
async function _openHiringTargetModal(target) {
  document.getElementById("rr-hiring-target-modal")?.remove();
  const dspId = window.RR?.dsp?.id;
  // Service types (for the optional cert requirement) — fetch once, cache.
  if (!window._rrServiceTypesCache && dspId) {
    const { data } = await sb.from("service_types").select("id, code, label").eq("dsp_id", dspId).order("code");
    window._rrServiceTypesCache = Array.isArray(data) ? data : [];
  }
  const svcs = window._rrServiceTypesCache || [];
  const t = target || {};
  const haveDays = new Set(Array.isArray(t.days) ? t.days : []);
  const dayBoxes = _OUTLOOK_DOW.map(k => `
    <label style="display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border:1px solid var(--border);border-radius:6px;background:var(--canvas);cursor:pointer;user-select:none;font-size:var(--fs-sm)">
      <input type="checkbox" data-rr-htf-day="${k}" ${haveDays.has(k) ? "checked" : ""}/><span style="font-weight:600">${_OUTLOOK_DOW_LBL[k]}</span>
    </label>`).join("");
  const svcOpts = `<option value="">No cert requirement</option>` + svcs.map(s => `<option value="${escapeHtml(s.id)}"${t.service_type_id === s.id ? " selected" : ""}>${escapeHtml(s.code || "")}${s.label ? ` — ${escapeHtml(s.label)}` : ""}</option>`).join("");
  const overlay = document.createElement("div");
  overlay.id = "rr-hiring-target-modal";
  overlay.className = "modal-backdrop open";
  overlay.style.zIndex = "95";
  overlay.innerHTML = `
    <div class="modal-card" style="max-width:480px">
      <div class="modal-head">
        <div><p class="modal-title">${target ? "Edit hiring target" : "New hiring target"}</p><p class="modal-sub">What kind of driver do you need, and how many?</p></div>
        <button class="modal-close" type="button" data-rr-htf-close aria-label="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:14px">
        <div><div style="font-weight:600;font-size:var(--fs-sm);margin-bottom:4px">Label</div><input type="text" id="rr-htf-label" class="form-input" placeholder="e.g. Saturday drivers" value="${escapeHtml(t.label || "")}"/></div>
        <div style="display:flex;gap:14px;align-items:flex-end">
          <div><div style="font-weight:600;font-size:var(--fs-sm);margin-bottom:4px">How many</div><input type="number" id="rr-htf-count" class="form-input" min="1" max="100" step="1" value="${Math.max(1, t.needed_count || 1)}" style="width:90px"/></div>
          <div style="flex:1"><div style="font-weight:600;font-size:var(--fs-sm);margin-bottom:4px">Can start by (latest)</div><select id="rr-htf-start" class="form-input">${_availStartOptionsHtml(t.earliest_start_max || "")}</select></div>
        </div>
        <div><div style="font-weight:600;font-size:var(--fs-sm);margin-bottom:6px">Must be able to work</div><div style="display:flex;flex-wrap:wrap;gap:6px">${dayBoxes}</div><div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-top:5px">Leave all unchecked for "any days".</div></div>
        ${svcs.length ? `<div><div style="font-weight:600;font-size:var(--fs-sm);margin-bottom:4px">Cert required</div><select id="rr-htf-svc" class="form-input">${svcOpts}</select></div>` : ""}
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px">
          <button class="btn" type="button" data-rr-htf-close>Cancel</button>
          <button class="btn btn-primary" type="button" id="rr-htf-save" data-rr-htf-id="${escapeHtml(t.id || "")}">${target ? "Save" : "Create target"}</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
  const close = () => { overlay.remove(); document.body.style.overflow = ""; };
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay || ev.target.closest("[data-rr-htf-close]")) close(); });
  document.getElementById("rr-htf-save").addEventListener("click", async () => {
    const id    = document.getElementById("rr-htf-save").getAttribute("data-rr-htf-id") || undefined;
    const label = (document.getElementById("rr-htf-label").value || "").trim();
    const count = Math.max(1, Math.min(100, parseInt(document.getElementById("rr-htf-count").value, 10) || 1));
    const start = document.getElementById("rr-htf-start").value || null;
    const svc   = document.getElementById("rr-htf-svc")?.value || null;
    const days  = _OUTLOOK_DOW.filter(k => document.querySelector(`#rr-hiring-target-modal [data-rr-htf-day="${k}"]`)?.checked);
    const btn = document.getElementById("rr-htf-save"); btn.disabled = true;
    const payload = { label, needed_count: count, days, earliest_start_max: start, service_type_id: svc };
    if (id) payload.id = id;
    const { error } = await sb.rpc("hiring_target_upsert", { p_payload: payload });
    if (error) { toast("Failed: " + error.message, "warn"); btn.disabled = false; return; }
    toast(id ? "Target updated" : "Target created", "success");
    close();
    await _reloadTargetsViews();
  });
}

const _ROUTE_FORECAST_WEEKS = 9;

async function loadStaffingOutlook() {
  const body = document.getElementById("rr-outlook-body");
  if (!body) return;
  body.innerHTML = `<div class="loader" style="margin:80px auto"></div>`;
  const dspId = window.RR?.dsp?.id;
  if (!dspId) { body.innerHTML = `<div class="empty-state">No workspace.</div>`; return; }

  const since60    = fmtIsoDate(addDays(new Date(), -60));
  const thisMonIso = fmtIsoDate(startOfWeekMonday(new Date()));
  const [fcRes, activeRes, onbRes, settingsRes, calloutRes, totalRes] = await Promise.all([
    sb.rpc("route_forecast_get", { p_weeks: _ROUTE_FORECAST_WEEKS }),
    sb.from("drivers").select("id, metadata, dl_expires_on").eq("dsp_id", dspId).eq("status", "active"),
    sb.from("drivers").select("id, metadata, dl_expires_on, hire_date").eq("dsp_id", dspId).eq("status", "onboarding"),
    sb.rpc("scheduling_settings_for_week", { p_week_start: thisMonIso }),
    sb.from("shifts").select("id", { count: "exact", head: true }).eq("dsp_id", dspId).gte("date", since60).in("status", ["called_off", "no_show"]),
    sb.from("shifts").select("id", { count: "exact", head: true }).eq("dsp_id", dspId).gte("date", since60).in("status", ["scheduled", "completed", "called_off", "no_show"]),
  ]);
  if (fcRes.error) { body.innerHTML = `<div class="empty-state" style="color:var(--red)">Couldn't load: ${escapeHtml(fcRes.error.message)}</div>`; return; }

  const fc          = fcRes.data || {};
  const weeksRaw    = Array.isArray(fc.weeks) ? fc.weeks : [];
  const startsAfter = fc.starts_after || null;
  const baseline    = Number(fc.baseline) || 0;
  const active      = activeRes.data || [];
  const onb         = onbRes.data || [];
  const maxDays     = (() => { const v = settingsRes.data?.max_days_per_week; return Number.isFinite(v) ? Math.max(1, Math.min(7, v)) : 5; })();
  const calloutRate = (totalRes.count || 0) > 0 ? Math.min(0.5, (calloutRes.count || 0) / totalRes.count) : 0;
  const showRate    = 1 - calloutRate;
  const showPct     = Math.round(showRate * 100);
  const calloutPct  = Math.round(calloutRate * 100);
  const dlOk        = (d, weekStart) => !(d.dl_expires_on && d.dl_expires_on < weekStart);
  const onbBy       = (d, weekStart) => (d.hire_date || "9999-12-31") <= weekStart;
  const noAvailCount = active.filter(d => !((d.metadata?.availability?.days) || []).length).length
                     + onb.filter(d => !((d.metadata?.availability?.days) || []).length).length;

  // Per-week model: input = the week's PEAK daily route count.  To dispatch
  // that many routes on the busiest day, allowing for call-offs, you need
  // ceil(peak / show-rate) drivers to actually show up.
  const rows = weeksRaw.map(w => ({
    week_start: w.week_start,
    saved:      (w.route_slots != null) ? Number(w.route_slots) : null,
    slots:      (w.route_slots != null) ? Number(w.route_slots) : baseline,
    estimated:  (w.route_slots == null),
  }));
  const compute = () => {
    for (const r of rows) {
      r.needed   = showRate > 0 ? Math.ceil(r.slots / showRate) : (r.slots > 0 ? Infinity : 0);
      r.youllHave = active.filter(d => dlOk(d, r.week_start)).length
                  + onb.filter(d => onbBy(d, r.week_start) && dlOk(d, r.week_start)).length;
      r.hire = Math.max(0, (Number.isFinite(r.needed) ? r.needed : 0) - r.youllHave);
    }
  };
  compute();
  const hireTotalOf = () => rows.reduce((m, r) => Math.max(m, r.hire), 0);
  const firstPeakOf = (h) => h > 0 ? rows.find(r => r.hire >= h) : null;
  const fmtWk = (iso) => new Date(iso + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });

  const onbTotal     = onb.length;
  const horizonStart = rows[0]?.week_start;
  const horizonEnd   = rows.length ? rows[rows.length - 1].week_start : null;

  const tableRows = rows.map((r) => `
    <tr>
      <td style="padding:8px 12px;white-space:nowrap">Week of ${escapeHtml(fmtWk(r.week_start))}</td>
      <td style="padding:8px 12px;text-align:right;white-space:nowrap"><input type="number" min="0" max="100000" step="1" value="${r.slots}" data-rr-fc-week="${escapeHtml(r.week_start)}" class="form-input" style="width:90px;text-align:right"/></td>
      <td data-rr-fc-need="${escapeHtml(r.week_start)}" style="padding:8px 12px;text-align:right">${Number.isFinite(r.needed) ? r.needed : "—"}</td>
      <td data-rr-fc-have="${escapeHtml(r.week_start)}" style="padding:8px 12px;text-align:right;color:var(--text-muted)">${r.youllHave}</td>
      <td data-rr-fc-hire="${escapeHtml(r.week_start)}" style="padding:8px 12px;text-align:right;font-weight:700;color:${r.hire > 0 ? "var(--red)" : "var(--green)"}">${r.hire > 0 ? `+${r.hire}` : "ok"}</td>
    </tr>`).join("");

  const h0  = hireTotalOf();
  const fp0 = firstPeakOf(h0);

  body.innerHTML = `
    <div class="driver-stat-row" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:18px">
      <div class="stat-mini"><div class="stat-mini-label">Drivers to hire</div><div id="rr-fc-hiretotal" class="stat-mini-value" style="color:${h0 === 0 ? "var(--green)" : "var(--red)"};font-size:32px;line-height:1.1">${h0}</div><div class="stat-mini-sub">${h0 === 0 ? `your roster covers the peak in all ${_ROUTE_FORECAST_WEEKS} forecast weeks` : `more drivers to cover your busiest day each of the next ${_ROUTE_FORECAST_WEEKS} weeks`}</div></div>
      <div class="stat-mini"><div class="stat-mini-label">${h0 === 0 ? "Status" : "Have them by"}</div><div id="rr-fc-byweek" class="stat-mini-value" style="font-size:var(--fs-lg)">${h0 === 0 ? "Covered" : (fp0 ? `Week of ${escapeHtml(fmtWk(fp0.week_start))}` : "—")}</div><div id="rr-fc-byweek-sub" class="stat-mini-sub">${h0 === 0 ? "no action needed" : "hire ahead of this week"}</div></div>
      <div class="stat-mini"><div class="stat-mini-label">Roster today</div><div class="stat-mini-value">${active.length}${onbTotal ? ` <span style="font-size:var(--fs-md);color:var(--text-subtle)">+${onbTotal}</span>` : ""}</div><div class="stat-mini-sub">active${onbTotal ? ` · +${onbTotal} onboarding` : ""} · ${maxDays}d/wk cap · ~${calloutPct}% call-offs</div></div>
    </div>

    <div class="card">
      <div class="card-head" style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap"><div class="card-title">Route forecast${horizonStart ? ` · weeks of ${escapeHtml(fmtWk(horizonStart))}–${escapeHtml(fmtWk(horizonEnd))}` : ""}</div><button class="btn btn-sm" type="button" id="rr-fc-fill-all" title="Copy the first week's number into every later week">Fill all weeks from the first</button></div>
      <div style="padding:10px 14px 4px;font-size:var(--fs-sm);color:var(--text-muted);line-height:1.5">${startsAfter ? `Picks up where the schedule ends — the last scheduled week is the week of ${escapeHtml(fmtWk(startsAfter))}, so the forecast starts the week after.` : `No schedule generated yet, so the forecast starts this week.`} For each week, enter <strong>the most routes you expect to run on your busiest day</strong> — RouteReady plans your headcount to that.</div>
      <table style="width:100%;border-collapse:collapse;font-size:var(--fs-md);margin-top:6px">
        <thead><tr style="color:var(--text-subtle);font-size:var(--fs-xs);text-transform:uppercase;letter-spacing:.04em"><th style="padding:8px 12px;text-align:left">Week</th><th style="padding:8px 12px;text-align:right">Peak routes / day</th><th style="padding:8px 12px;text-align:right">Drivers needed</th><th style="padding:8px 12px;text-align:right">You'll have</th><th style="padding:8px 12px;text-align:right">Hire</th></tr></thead>
        <tbody>${tableRows || `<tr><td colspan="5" style="padding:16px;color:var(--text-subtle)">No weeks to show.</td></tr>`}</tbody>
      </table>
      <div style="padding:8px 14px 14px;font-size:var(--fs-xs);color:var(--text-subtle);line-height:1.6">
        "Drivers needed" = peak routes &divide; ${showPct}% show rate, rounded up — enough bodies to dispatch your busiest day even with call-offs. "You'll have" counts your active drivers plus anyone in onboarding by that week, minus anyone whose license lapses first. "Hire" is the gap.${noAvailCount > 0 ? ` ${noAvailCount} driver${noAvailCount === 1 ? " has" : "s have"} no availability set.` : ""} This plans for the peak day; if you run a full week, your ${maxDays}-day cap means a roster sized to the peak can still be a touch short on the lighter days — nudge the number up if you want a full-week buffer. Numbers save as you type.
      </div>
    </div>`;

  const paint = () => {
    const h  = hireTotalOf();
    const fp = firstPeakOf(h);
    for (const r of rows) {
      const nd = body.querySelector(`[data-rr-fc-need="${CSS.escape(r.week_start)}"]`);
      const hv = body.querySelector(`[data-rr-fc-have="${CSS.escape(r.week_start)}"]`);
      const hi = body.querySelector(`[data-rr-fc-hire="${CSS.escape(r.week_start)}"]`);
      if (nd) nd.textContent = Number.isFinite(r.needed) ? r.needed : "—";
      if (hv) hv.textContent = r.youllHave;
      if (hi) { hi.textContent = r.hire > 0 ? `+${r.hire}` : "ok"; hi.style.color = r.hire > 0 ? "var(--red)" : "var(--green)"; }
    }
    const ht = document.getElementById("rr-fc-hiretotal");
    if (ht) { ht.textContent = h; ht.style.color = h === 0 ? "var(--green)" : "var(--red)"; }
    const bw = document.getElementById("rr-fc-byweek");
    if (bw) bw.textContent = h === 0 ? "Covered" : (fp ? `Week of ${fmtWk(fp.week_start)}` : "—");
    const bws = document.getElementById("rr-fc-byweek-sub");
    if (bws) bws.textContent = h === 0 ? "no action needed" : "hire ahead of this week";
  };
  const saveWeek = async (weekStart, val) => {
    const { error } = await sb.rpc("route_forecast_set", { p_week_start: weekStart, p_route_slots: val });
    if (error) toast("Save failed: " + error.message, "warn");
  };

  body.querySelectorAll("[data-rr-fc-week]").forEach(inp => {
    inp.addEventListener("change", async () => {
      const wk  = inp.getAttribute("data-rr-fc-week");
      const val = Math.max(0, Math.min(100000, parseInt(inp.value, 10) || 0));
      inp.value = String(val);
      const r = rows.find(x => x.week_start === wk);
      if (r) { r.slots = val; r.saved = val; r.estimated = false; }
      compute(); paint();
      await saveWeek(wk, val);
    });
  });
  const fillBtn = document.getElementById("rr-fc-fill-all");
  if (fillBtn) fillBtn.addEventListener("click", async () => {
    if (!rows.length) return;
    const v = rows[0].slots;
    fillBtn.disabled = true;
    for (const r of rows) {
      r.slots = v; r.saved = v; r.estimated = false;
      const inp = body.querySelector(`[data-rr-fc-week="${CSS.escape(r.week_start)}"]`);
      if (inp) inp.value = String(v);
    }
    compute(); paint();
    for (const r of rows) await saveWeek(r.week_start, v);
    fillBtn.disabled = false;
    toast("Filled all weeks", "success");
  });
}

// Refresh button + "open in Schedule →" deep links on the Staffing-outlook page.
document.addEventListener("click", (e) => {
  if (e.target.closest("#rr-outlook-refresh")) { loadStaffingOutlook(); return; }
  const wk = e.target.closest("[data-rr-outlook-week]");
  if (wk) {
    e.preventDefault();
    const off = wk.getAttribute("data-rr-outlook-week");
    if (typeof window.goto === "function") window.goto("schedule");
    setTimeout(() => { document.querySelector(`[data-rr-week-offset="${off}"]`)?.click(); }, 90);
  }
});


// Hook view + sub-view loaders.
const _origGotoForSched = window.goto;
window.goto = function (view) {
  if (typeof _origGotoForSched === "function") _origGotoForSched(view);
  if (view === "schedule") loadScheduleView();
  if (view === "okami")    loadOkamiView();
};

// Reset every view to its first sub-tab when the operator navigates
// to it.  Without this the dashboard remembers the last sub-tab they
// were on (e.g. they leave Drivers from the Coaching tab, come back
// later, and land on Coaching).  Operators want a clean start from
// the primary view every time, on EVERY sidebar item.
const _origGotoForSubReset = window.goto;
window.goto = function (view) {
  if (typeof _origGotoForSubReset === "function") _origGotoForSubReset(view);
  // Run after the legacy goto applied the .active class on the view.
  setTimeout(() => {
    const activeView = document.getElementById("view-" + view);
    if (!activeView) return;

    // Top-level subnav (Drivers / Schedule / Pipeline / Workflows /
    // Performance / Fleet / Finances / Today).  Click the first
    // tab-id-bearing subnav-item in document order so the operator
    // lands on the primary sub-view of every sidebar function.
    //
    // The selector intentionally requires [data-sub] or [data-pipesub]
    // — Schedule's "Plan ↗" link is also a .subnav-item but its
    // onclick is goto('okami'), and the tab-bar reorder logic
    // (_rrApplyTabbarOrder) appends every tracked tab to the end of
    // the bar, which shoves untracked children like Plan ↗ to the
    // FRONT.  Without the [data-sub] guard, Plan ↗ becomes "firstSub"
    // and we auto-click it — bouncing the operator off Schedule and
    // back into OKAMI a frame after they navigate to Schedule.
    const firstSub = activeView.querySelector(
      ".subnav .subnav-item[data-sub], .subnav .subnav-item[data-pipesub], " +
      ".subnav-item[data-sub], .subnav-item[data-pipesub]"
    );
    if (firstSub && !firstSub.classList.contains("active")) firstSub.click();

    // Settings has its own pane navigation (settings-nav-item /
    // setSettingsSection), not the .subnav structure.  Reset to the
    // first one too so opening the gear icon always lands on
    // Workspace rather than wherever they were last time.
    if (view === "settings") {
      const firstSetting = activeView.querySelector(".settings-nav-item");
      if (firstSetting && !firstSetting.classList.contains("active")) firstSetting.click();
    }

    // Drivers → Attendance has its own nested tabstrip (History /
    // Report / Event log).  When the operator returns to Drivers
    // and the sub-tab reset above lands on Roster, that's fine.
    // But if they navigate back into Attendance later, we want it
    // to start on the first tab in the strip too — handled by the
    // drSub wrap below.
  }, 0);
};

// drSub wrap — when the operator clicks Drivers → Attendance from the
// subnav, reset the att-tabstrip to the Report tab (the populated
// default) so they don't land on a blank History pane after navigation.
const _origDrSubForSubReset = window.drSub;
if (typeof _origDrSubForSubReset === "function") {
  window.drSub = function (sub) {
    const r = _origDrSubForSubReset(sub);
    if (sub === "attendance") {
      setTimeout(() => {
        const strip = document.getElementById("rr-att-tabstrip");
        if (!strip) return;
        const target = strip.querySelector('[data-att="report"]') || strip.querySelector("[data-att]");
        if (target && !target.classList.contains("active")) target.click();
      }, 0);
    }
    return r;
  };
}

const _origRefreshSched = refreshActiveView;
function refreshActiveViewWithSched() {
  _origRefreshSched();
  const v = document.querySelector(".view.active")?.id;
  if (v === "view-schedule") loadScheduleView();
  if (v === "view-okami")    loadOkamiView();
}
// Replace the inner loop's reference too: we monkey-patch by re-binding.
window.addEventListener("focus", () => {
  const v = document.querySelector(".view.active")?.id;
  if (v === "view-schedule") loadScheduleView();
  if (v === "view-okami")    loadOkamiView();
});


// ─── Rules tab: day-set toggles (Operating / Required days) ─────────
// Each container marked [data-rr-day-set="operating"] etc. has 7 buttons
// (one per day, identified by data-rr-day). Click toggles on/off and
// persists to localStorage. UI-only for now; auto-fill enforcement
// hooks in via the same key when wire-up lands.
(function rrInitDaySetToggles() {
  const KEY = "rr.day-set.";
  function applySaved() {
    document.querySelectorAll("[data-rr-day-set]").forEach(set => {
      const k = set.dataset.rrDaySet;
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(KEY + k) || "null"); } catch {}
      if (!Array.isArray(saved)) return;
      set.querySelectorAll("[data-rr-day]").forEach(btn => {
        btn.classList.toggle("on", saved.includes(btn.dataset.rrDay));
      });
    });
  }
  function save(set) {
    const k = set.dataset.rrDaySet;
    const days = Array.from(set.querySelectorAll(".day-toggle.on")).map(b => b.dataset.rrDay);
    try { localStorage.setItem(KEY + k, JSON.stringify(days)); } catch {}
  }
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-rr-day-set] [data-rr-day]");
    if (!btn) return;
    e.preventDefault();
    btn.classList.toggle("on");
    const set = btn.closest("[data-rr-day-set]");
    if (set) save(set);
  });
  if (document.body) applySaved();
  else document.addEventListener("DOMContentLoaded", applySaved);
})();


// ─── Rules tab: manual blackout list (UI-only, localStorage) ─────────
// Each entry { name, start, end }. Stored in localStorage so the
// operator's list survives reloads. Wire to a per-DSP table later if
// auto-fill needs to enforce these.
(function rrInitBlackoutList() {
  const KEY = "rr.blackouts";
  const fmtDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso + "T12:00:00");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  };
  function read() {
    try { const v = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  function write(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {}
  }
  function render() {
    const list = document.getElementById("rr-blackout-list");
    if (!list) return;
    const items = read();
    if (items.length === 0) {
      list.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-subtle);font-size:var(--fs-sm);border:1px dashed var(--border);border-radius:var(--r-md)">No blackouts yet. Click "+ Add blackout" to enter one.</div>`;
      return;
    }
    list.innerHTML = items.map((b, i) => `
      <div class="blackout-item" data-rr-blackout-idx="${i}" style="grid-template-columns:1fr auto auto auto;gap:8px">
        <input type="text" class="rule-input" data-rr-blackout-field="name" value="${escapeHtml(b.name || "")}" placeholder="Name (e.g. Prime Day)" style="width:auto;text-align:left"/>
        <input type="date" class="rule-input" data-rr-blackout-field="start" value="${escapeHtml(b.start || "")}" style="width:auto"/>
        <input type="date" class="rule-input" data-rr-blackout-field="end" value="${escapeHtml(b.end || "")}" style="width:auto"/>
        <button type="button" class="btn btn-sm" data-rr-blackout-remove style="color:var(--red)">Remove</button>
      </div>
    `).join("");
  }
  function attach() {
    if (!document.getElementById("rr-blackout-list") || document._rrBlackoutBound) return;
    document._rrBlackoutBound = true;
    document.addEventListener("click", (e) => {
      const addBtn = e.target.closest("#rr-blackout-add");
      if (addBtn) {
        e.preventDefault();
        const list = read();
        list.push({ name: "", start: "", end: "" });
        write(list);
        render();
        return;
      }
      const remBtn = e.target.closest("[data-rr-blackout-remove]");
      if (remBtn) {
        e.preventDefault();
        const idx = parseInt(remBtn.closest("[data-rr-blackout-idx]")?.dataset.rrBlackoutIdx, 10);
        if (!Number.isFinite(idx)) return;
        const list = read();
        list.splice(idx, 1);
        write(list);
        render();
      }
    });
    document.addEventListener("change", (e) => {
      const fld = e.target.closest("[data-rr-blackout-field]");
      if (!fld) return;
      const idx = parseInt(fld.closest("[data-rr-blackout-idx]")?.dataset.rrBlackoutIdx, 10);
      if (!Number.isFinite(idx)) return;
      const list = read();
      if (!list[idx]) return;
      list[idx][fld.dataset.rrBlackoutField] = fld.value;
      write(list);
    });
  }
  if (document.body) { attach(); render(); }
  else document.addEventListener("DOMContentLoaded", () => { attach(); render(); });
})();


// ─── Rules tab: persist <details> open/close state per-user ──────────
// Each rules-section + rules-sub stores its expand/collapse state in
// localStorage so the operator's layout choices stick across reloads.
(function rrInitRulesAccordion() {
  const KEY = "rr.rules-open.";
  function applySaved() {
    document.querySelectorAll("[data-rr-rules-section], [data-rr-rules-sub]").forEach(det => {
      if (!(det instanceof HTMLDetailsElement)) return;
      const k = det.dataset.rrRulesSection || det.dataset.rrRulesSub;
      const saved = localStorage.getItem(KEY + k);
      if (saved === "1") det.open = true;
      else if (saved === "0") det.open = false;
    });
  }
  document.addEventListener("toggle", (e) => {
    const det = e.target;
    if (!(det instanceof HTMLDetailsElement)) return;
    const k = det.dataset?.rrRulesSection || det.dataset?.rrRulesSub;
    if (!k) return;
    try { localStorage.setItem(KEY + k, det.open ? "1" : "0"); } catch {}
  }, true);
  if (document.body) applySaved();
  else document.addEventListener("DOMContentLoaded", applySaved);
})();


// ─── Drag-to-reorder for tab bars ─────────────────────────────────────
// Any container marked `data-rr-tabbar="some-key"` becomes a reorderable
// tab bar. Each child button is treated as a tab; its stable identifier
// is read from data-rr-tab → data-pipesub → data-sub → data-rr-dd-tab.
// Order is saved per-user in localStorage (rr.tab-order.<key>) and
// re-applied whenever the bar mounts. Survives re-renders via a
// MutationObserver that re-inits any bar that gets added or has its
// children replaced. No server round-trip; no DSP-shared state.
//
// Tabs keep their click handlers — drag and click coexist because
// HTML5 dragstart only fires on actual drag motion.

const RR_TAB_PREFIX = "rr.tab-order.";

(function injectRrTabbarStyle() {
  if (document.getElementById("rr-tabbar-style")) return;
  const s = document.createElement("style");
  s.id = "rr-tabbar-style";
  s.textContent = `
    [data-rr-tabbar] > [draggable="true"] { cursor: grab; }
    [data-rr-tabbar] > [draggable="true"]:active { cursor: grabbing; }
    .rr-tab-dragging { opacity: 0.4; }
    [data-rr-tabbar].rr-tabbar-dropzone { outline: 1px dashed var(--accent); outline-offset: 2px; border-radius: 6px; }
  `;
  document.head.appendChild(s);
})();

function _rrTabId(el) {
  if (!(el instanceof Element)) return null;
  return el.dataset.rrTab
    || el.dataset.pipesub
    || el.dataset.sub
    || el.dataset.stage
    || el.dataset.tab
    || el.dataset.rrDdTab
    || null;
}

function _rrTabbarChildren(bar) {
  return Array.from(bar.children).filter(c => _rrTabId(c));
}

function _rrApplyTabbarOrder(bar) {
  const key = bar.dataset.rrTabbar;
  if (!key) return;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(RR_TAB_PREFIX + key) || "null"); } catch {}
  if (!Array.isArray(saved) || saved.length === 0) return;
  const tabs = _rrTabbarChildren(bar);
  const byId = new Map(tabs.map(t => [_rrTabId(t), t]));
  // Build target order: saved-ids that exist, then any new tabs at the end.
  const target = [];
  const seen = new Set();
  for (const id of saved) {
    if (byId.has(id)) { target.push(id); seen.add(id); }
  }
  for (const t of tabs) {
    const id = _rrTabId(t);
    if (!seen.has(id)) target.push(id);
  }
  // No-op if the DOM already matches — critical: appendChild on a child
  // that's already at the right position still fires a MutationRecord,
  // which would re-trigger the observer and infinite-loop.
  const current = tabs.map(t => _rrTabId(t));
  if (target.length === current.length && target.every((id, i) => id === current[i])) return;
  // Anchor the tracked tabs against the first untracked sibling so
  // stragglers like Schedule's "Plan ↗" link (a .subnav-item with no
  // tab id) don't get shoved to the front when every tracked tab is
  // appended past them — that bug bounced operators out of Schedule
  // back into OKAMI a frame after navigation.
  const tracked = new Set(tabs);
  let anchor = null;
  for (const child of bar.children) {
    if (!tracked.has(child)) { anchor = child; break; }
  }
  for (const id of target) {
    const node = byId.get(id);
    if (anchor) bar.insertBefore(node, anchor);
    else bar.appendChild(node);
  }
}

function _rrSaveTabbarOrder(bar) {
  const key = bar.dataset.rrTabbar;
  if (!key) return;
  const ids = _rrTabbarChildren(bar).map(t => _rrTabId(t));
  try { localStorage.setItem(RR_TAB_PREFIX + key, JSON.stringify(ids)); } catch {}
}

function _rrInitTabbar(bar) {
  if (!bar) return;
  const firstInit = !bar._rrTabbarInit;
  bar._rrTabbarInit = true;
  // Mark each child draggable. Idempotent — skipped on tabs already set.
  for (const tab of _rrTabbarChildren(bar)) {
    if (!tab.getAttribute("draggable")) {
      tab.setAttribute("draggable", "true");
    }
  }
  // Apply saved order only on first init. Subsequent observer fires
  // (drag reparenting, badge counter updates, etc.) skip the apply
  // step so we never recurse into an infinite loop.
  if (firstInit) _rrApplyTabbarOrder(bar);
}

document.addEventListener("dragstart", (e) => {
  const tab = e.target.closest?.("[draggable=\"true\"]");
  if (!tab) return;
  const bar = tab.parentElement?.closest?.("[data-rr-tabbar]");
  if (!bar || tab.parentElement !== bar) return;
  bar._rrDragging = tab;
  tab.classList.add("rr-tab-dragging");
  bar.classList.add("rr-tabbar-dropzone");
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", _rrTabId(tab) || ""); } catch {}
  }
});

document.addEventListener("dragover", (e) => {
  const bar = e.target.closest?.("[data-rr-tabbar]");
  if (!bar || !bar._rrDragging) return;
  e.preventDefault();
  const target = e.target.closest?.("[draggable=\"true\"]");
  if (!target || target === bar._rrDragging || target.parentElement !== bar) return;
  const rect = target.getBoundingClientRect();
  const after = (e.clientX - rect.left) > rect.width / 2;
  if (after) target.after(bar._rrDragging);
  else target.before(bar._rrDragging);
});

document.addEventListener("dragend", (e) => {
  const tab = e.target.closest?.("[draggable=\"true\"]");
  if (!tab) return;
  const bar = tab.parentElement?.closest?.("[data-rr-tabbar]")
           || document.querySelector("[data-rr-tabbar].rr-tabbar-dropzone");
  if (bar) {
    bar.classList.remove("rr-tabbar-dropzone");
    if (bar._rrDragging) {
      bar._rrDragging.classList.remove("rr-tab-dragging");
      bar._rrDragging = null;
      _rrSaveTabbarOrder(bar);
    }
  } else {
    tab.classList.remove("rr-tab-dragging");
  }
});

function _rrInitAllTabbars() {
  document.querySelectorAll("[data-rr-tabbar]").forEach(_rrInitTabbar);
}

const _rrTabbarObserver = new MutationObserver((mutations) => {
  const dirty = new Set();
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (node.matches?.("[data-rr-tabbar]")) dirty.add(node);
      if (node.querySelectorAll) {
        node.querySelectorAll("[data-rr-tabbar]").forEach(b => dirty.add(b));
      }
      const ancestor = node.parentElement?.closest?.("[data-rr-tabbar]");
      if (ancestor) dirty.add(ancestor);
    }
  }
  for (const bar of dirty) _rrInitTabbar(bar);
});

if (document.body) {
  _rrTabbarObserver.observe(document.body, { childList: true, subtree: true });
  _rrInitAllTabbars();
} else {
  document.addEventListener("DOMContentLoaded", () => {
    _rrTabbarObserver.observe(document.body, { childList: true, subtree: true });
    _rrInitAllTabbars();
  });
}


// ─── Forms · build / save / publish / edit ─────────────────────────────
//
// State for the active builder session.  _formsState.editing is the
// row being edited (null on Create); _formsState.fields is the live
// fields array; _formsState.selectedId is the field whose props are
// shown on the right.  Save / Publish read from this state and
// upsert via public.upsert_form / public.publish_form.
const _formsState = { editing: null, fields: [], selectedId: null };

const _FIELD_TYPE_LABELS = {
  short_text: "Short text",  long_text: "Long text",
  email: "Email",            phone: "Phone",
  number: "Number",          single_choice: "Single choice",
  multi_choice: "Multi-select", dropdown: "Dropdown",
  yes_no: "Yes / No",        rating: "Rating · 1–5",
  date: "Date",              time: "Time",
  photo: "Photo capture",    file: "File upload",
  signature: "Signature",    gps: "GPS location",
  instructions: "Instructions",
  section_header: "Section header", divider: "Divider",
};

function _newFieldId() {
  return "f_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function _defaultFieldForType(type) {
  const base = { id: _newFieldId(), type, label: _FIELD_TYPE_LABELS[type] || "Untitled", help: "", required: false };
  if (type === "single_choice" || type === "multi_choice" || type === "dropdown") {
    base.options = ["Option 1", "Option 2"];
  }
  if (type === "instructions") {
    base.label = "Instructions";
    base.help  = "Read these before answering the questions below.";
  }
  return base;
}

async function loadFormSubmissions() {
  const list = document.getElementById("rr-subm-list");
  if (!list) return;
  list.innerHTML = `<div class="rr-loading">Loading</div>`;
  const { data, error } = await sb.rpc("list_form_submissions", { p_form_id: null });
  if (error) {
    list.innerHTML = `<div class="rr-empty-inline" style="color:var(--red)">Couldn't load submissions: ${escapeHtml(error.message)}</div>`;
    return;
  }
  const subs = data || [];
  if (subs.length === 0) {
    list.innerHTML = `<div class="rr-empty-inline">Submissions will appear here once drivers start filling out published forms.</div>`;
    return;
  }
  const rows = subs.map(s => {
    const when = s.submitted_at ? new Date(s.submitted_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    const answerCount = s.answers && typeof s.answers === "object" ? Object.keys(s.answers).length : 0;
    return `
      <div class="subm-row" data-rr-subm-id="${escapeHtml(s.id)}">
        <div class="form-card-icon" style="width:32px;height:32px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg></div>
        <div><div class="subm-form-name">${escapeHtml(s.form_title || "Form")} · ${escapeHtml(s.driver_name || "Driver")}</div><div class="subm-form-meta">${answerCount} answer${answerCount === 1 ? "" : "s"}</div></div>
        <span class="subm-status complete">${escapeHtml(s.status || "submitted")}</span>
        <div class="cell-time">${escapeHtml(when)}</div>
        <button class="btn btn-sm" type="button">View</button>
      </div>`;
  }).join("");
  list.innerHTML = `
    <div class="card card-flush">
      <div class="subm-row" style="background:var(--canvas);font-size:var(--fs-xs);font-weight:600;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase;cursor:default">
        <div></div><div>Form · Driver</div><div>Status</div><div>Submitted</div><div></div>
      </div>
      ${rows}
    </div>`;
}

async function loadFormsList() {
  const grid  = document.getElementById("rr-forms-grid");
  const empty = document.getElementById("rr-forms-empty");
  const count = document.getElementById("rr-forms-count-my");
  const sub   = document.getElementById("rr-forms-page-sub");
  if (!grid) return;
  grid.innerHTML = `<div class="rr-loading">Loading</div>`;

  const { data, error } = await sb.rpc("list_forms");
  if (error) {
    grid.innerHTML = "";
    if (empty) { empty.style.display = "block"; empty.textContent = "Couldn't load forms: " + error.message; }
    return;
  }
  const forms = data || [];
  if (count) count.textContent = String(forms.length);
  const published = forms.filter(f => f.status === "published").length;
  if (sub) sub.textContent = `${forms.length} form${forms.length === 1 ? "" : "s"}${published ? " · " + published + " published" : ""}`;

  if (forms.length === 0) {
    grid.innerHTML = "";
    if (empty) empty.style.display = "block";
    return;
  }
  if (empty) empty.style.display = "none";
  grid.innerHTML = forms.map(_formCardHtml).join("");
}

function _formCardHtml(f) {
  const fieldCount = Array.isArray(f.fields) ? f.fields.length : 0;
  const isPublished = f.status === "published";
  const statusLabel = isPublished
    ? `<span class="form-card-status"><span class="kpi-pip green"></span>Published</span>`
    : `<span class="form-card-status draft">Draft</span>`;
  const updated = f.updated_at ? new Date(f.updated_at).toLocaleDateString() : "";
  return `
    <div class="form-card" data-rr-form-edit="${escapeHtml(f.id)}">
      ${statusLabel}
      <div class="form-card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg></div>
      <div class="form-card-title">${escapeHtml(f.title || "Untitled form")}</div>
      <div class="form-card-desc">${escapeHtml(f.description || "")}</div>
      <div class="form-card-stats">
        <span><strong>${fieldCount}</strong> field${fieldCount === 1 ? "" : "s"}</span>
        ${updated ? `<span>Updated <strong>${escapeHtml(updated)}</strong></span>` : ""}
      </div>
    </div>`;
}

function openFormBuilder(form) {
  _formsState.editing = form || null;
  _formsState.fields  = form && Array.isArray(form.fields) ? JSON.parse(JSON.stringify(form.fields)) : [];
  _formsState.selectedId = null;
  const titleEl = document.getElementById("rr-builder-title");
  const descEl  = document.getElementById("rr-builder-desc");
  if (titleEl) titleEl.value = form?.title || "";
  if (descEl)  descEl.value  = form?.description || "";
  // Form-level settings — once_per_driver is the inverse of the
  // "Allow multiple submissions" toggle.  Default to allow.
  const allowResubmit = document.getElementById("rr-form-allow-resubmit");
  if (allowResubmit) {
    const oncePerDriver = !!form?.settings?.once_per_driver;
    allowResubmit.checked = !oncePerDriver;
  }
  _renderBuilderCanvas();
  _renderBuilderProps();
  if (typeof openModal === "function") openModal("modal-form-builder");
}

function _renderBuilderCanvas() {
  const list  = document.getElementById("rr-builder-fields");
  const empty = document.getElementById("rr-builder-empty");
  if (!list) return;
  if (_formsState.fields.length === 0) {
    list.innerHTML = "";
    if (empty) empty.style.display = "block";
    return;
  }
  if (empty) empty.style.display = "none";
  list.innerHTML = _formsState.fields.map((f, i) => _builderFieldHtml(f, i, f.id === _formsState.selectedId)).join("");
}

function _builderFieldHtml(f, idx, selected) {
  const req = f.required ? '<span class="req">*</span>' : "";
  const cls = selected ? "builder-field active" : "builder-field";
  const id  = escapeHtml(f.id);
  let body = "";
  switch (f.type) {
    case "short_text": case "email": case "phone": case "number":
      body = `<input class="builder-field-input" placeholder="${escapeHtml(_FIELD_TYPE_LABELS[f.type])}" disabled />`;
      break;
    case "long_text":
      body = `<textarea class="builder-field-input" rows="2" placeholder="Long answer" disabled></textarea>`;
      break;
    case "single_choice":
    case "multi_choice":
    case "dropdown": {
      const opts = (f.options || []).map(o => `<div class="builder-field-radio">${escapeHtml(o)}</div>`).join("");
      body = `<div class="builder-field-radio-row">${opts || '<div class="builder-field-radio">No options yet</div>'}</div>`;
      break;
    }
    case "yes_no":
      body = `<div class="builder-field-radio-row"><div class="builder-field-radio">Yes</div><div class="builder-field-radio">No</div></div>`;
      break;
    case "rating":
      body = `<div style="font-size:18px;letter-spacing:4px;color:var(--text-subtle)">★ ★ ★ ★ ★</div>`;
      break;
    case "date":
      body = `<input class="builder-field-input" type="date" disabled />`;
      break;
    case "time":
      body = `<input class="builder-field-input" type="time" disabled />`;
      break;
    case "photo":
      body = `<div class="builder-field-img-placeholder">Photo capture · driver tap to upload from camera</div>`;
      break;
    case "file":
      body = `<div class="builder-field-img-placeholder">File upload</div>`;
      break;
    case "signature":
      body = `<div class="builder-field-img-placeholder" style="background:repeating-linear-gradient(135deg,#FAFBFC 0,#FAFBFC 8px,#F1F5F9 8px,#F1F5F9 16px)">Tap to sign</div>`;
      break;
    case "gps":
      body = `<div class="builder-field-img-placeholder">GPS location · auto-captured on submit</div>`;
      break;
    case "section_header":
      return `<div class="${cls}" data-rr-field-pick="${id}" style="margin-top:14px"><div style="font-weight:700;font-size:var(--fs-md);color:var(--text)">${escapeHtml(f.label || "Section")}</div></div>`;
    case "divider":
      return `<div class="${cls}" data-rr-field-pick="${id}"><hr style="border:0;border-top:1px solid var(--border);margin:6px 0"/></div>`;
    case "instructions": {
      const text = (f.help || "").trim();
      return `<div class="${cls}" data-rr-field-pick="${id}" style="background:var(--accent-soft);border-color:var(--accent-border)">
        <button type="button" class="rr-field-remove" data-rr-field-remove="${id}" aria-label="Remove block">×</button>
        <div style="font-weight:700;font-size:var(--fs-md);color:var(--text);margin-bottom:6px">${escapeHtml(f.label || "Instructions")}</div>
        <div style="font-size:var(--fs-sm);color:var(--text-muted);line-height:1.5;white-space:pre-wrap">${escapeHtml(text || "Click here, then type instructions in the Help text field on the right.")}</div>
      </div>`;
    }
  }
  return `
    <div class="${cls}" data-rr-field-pick="${id}">
      <span class="builder-field-handle">⋮⋮</span>
      <button type="button" class="rr-field-remove" data-rr-field-remove="${id}" aria-label="Remove field">×</button>
      <label class="builder-field-label">${escapeHtml(f.label || "Untitled")}${req}</label>
      ${f.help ? `<div style="font-size:var(--fs-xs);color:var(--text-subtle);margin-bottom:6px">${escapeHtml(f.help)}</div>` : ""}
      ${body}
    </div>`;
}

function _renderBuilderProps() {
  const empty = document.getElementById("rr-builder-props-empty");
  const body  = document.getElementById("rr-builder-props-body");
  if (!body) return;
  const f = _formsState.fields.find(x => x.id === _formsState.selectedId);
  if (!f) {
    body.style.display = "none";
    if (empty) empty.style.display = "block";
    return;
  }
  if (empty) empty.style.display = "none";
  body.style.display = "block";
  const hasOptions = f.type === "single_choice" || f.type === "multi_choice" || f.type === "dropdown";
  const isInstructions = f.type === "instructions";
  const labelHeading = isInstructions ? "Heading" : "Question";
  const helpHeading  = isInstructions ? "Body" : "Help text";
  const helpInput = isInstructions
    ? `<textarea class="field-prop-input" data-rr-prop="help" rows="6" placeholder="What should the driver read before they start?">${escapeHtml(f.help || "")}</textarea>`
    : `<input class="field-prop-input" data-rr-prop="help" value="${escapeHtml(f.help || "")}" />`;
  const requiredRow = (isInstructions || f.type === "section_header" || f.type === "divider") ? "" : `
    <div class="field-prop-row"><span class="field-prop-label">Required</span>
      <label class="toggle"><input type="checkbox" data-rr-prop="required" ${f.required ? "checked" : ""}/><span class="toggle-slider"></span></label></div>`;
  body.innerHTML = `
    <div class="field-prop-row"><span class="field-prop-label">Field type</span>
      <div style="font-size:var(--fs-md);font-weight:600;color:var(--text)">${escapeHtml(_FIELD_TYPE_LABELS[f.type] || f.type)}</div></div>
    <div class="field-prop-row" style="flex-direction:column;align-items:stretch;gap:6px"><span class="field-prop-label">${escapeHtml(labelHeading)}</span>
      <input class="field-prop-input" data-rr-prop="label" value="${escapeHtml(f.label || "")}" /></div>
    <div class="field-prop-row" style="flex-direction:column;align-items:stretch;gap:6px"><span class="field-prop-label">${escapeHtml(helpHeading)}</span>
      ${helpInput}</div>
    ${requiredRow}
    ${hasOptions ? `
      <div class="field-prop-row" style="flex-direction:column;align-items:stretch;gap:6px">
        <span class="field-prop-label">Options</span>
        <textarea class="field-prop-input" data-rr-prop="options" rows="4" placeholder="One per line">${escapeHtml((f.options || []).join("\n"))}</textarea>
      </div>` : ""}
    <div class="field-prop-row" style="margin-top:8px">
      <button type="button" class="btn btn-sm" data-rr-field-remove="${escapeHtml(f.id)}" style="color:var(--red)">Delete field</button>
    </div>`;
}

// Refresh the Submissions tab when the operator clicks into it.
// Also refresh the My-forms grid on its own tab so submissions counts
// reflect anything the dispatcher may have just published.
document.addEventListener("click", (e) => {
  const sideItem = e.target.closest("#view-forms .forms-side-item");
  if (!sideItem) return;
  const txt = (sideItem.textContent || "").trim().toLowerCase();
  if (txt.startsWith("submissions")) loadFormSubmissions();
  if (txt.startsWith("my forms"))    loadFormsList();
});

// Event delegation — palette adds, canvas selects, props edits.
document.addEventListener("click", (e) => {
  // Open builder in CREATE mode
  if (e.target.closest("[data-rr-form-new]")) {
    e.preventDefault();
    openFormBuilder(null);
    return;
  }
  // Open builder in EDIT mode
  const card = e.target.closest("[data-rr-form-edit]");
  if (card) {
    e.preventDefault();
    const id = card.getAttribute("data-rr-form-edit");
    sb.rpc("get_form", { p_id: id }).then(({ data, error }) => {
      if (error || !data) { toast("Couldn't load form" + (error ? ": " + error.message : ""), "warn"); return; }
      openFormBuilder(data);
    });
    return;
  }
  // Add a field from the palette
  const add = e.target.closest("[data-rr-add-field]");
  if (add && document.getElementById("modal-form-builder")?.classList.contains("open")) {
    e.preventDefault();
    const t = add.getAttribute("data-rr-add-field");
    const f = _defaultFieldForType(t);
    _formsState.fields.push(f);
    _formsState.selectedId = f.id;
    _renderBuilderCanvas();
    _renderBuilderProps();
    return;
  }
  // Remove a field (from canvas or props panel)
  const rm = e.target.closest("[data-rr-field-remove]");
  if (rm) {
    e.preventDefault();
    e.stopPropagation();
    const id = rm.getAttribute("data-rr-field-remove");
    _formsState.fields = _formsState.fields.filter(f => f.id !== id);
    if (_formsState.selectedId === id) _formsState.selectedId = null;
    _renderBuilderCanvas();
    _renderBuilderProps();
    return;
  }
  // Pick a field for editing
  const pick = e.target.closest("[data-rr-field-pick]");
  if (pick) {
    const id = pick.getAttribute("data-rr-field-pick");
    _formsState.selectedId = id;
    _renderBuilderCanvas();
    _renderBuilderProps();
    return;
  }
  // Save draft / Publish
  if (e.target.closest("[data-rr-form-save]"))    { e.preventDefault(); _saveBuilder({ publish: false }); return; }
  if (e.target.closest("[data-rr-form-publish]")) { e.preventDefault(); _saveBuilder({ publish: true });  return; }
});

// Inputs in the props panel update _formsState in place.
document.addEventListener("input", (e) => {
  const propEl = e.target.closest("[data-rr-prop]");
  if (propEl) {
    const f = _formsState.fields.find(x => x.id === _formsState.selectedId);
    if (!f) return;
    const key = propEl.getAttribute("data-rr-prop");
    if (key === "required") {
      f.required = propEl.checked;
    } else if (key === "options") {
      f.options = propEl.value.split("\n").map(s => s.trim()).filter(Boolean);
    } else {
      f[key] = propEl.value;
    }
    _renderBuilderCanvas();
    return;
  }
  // Keep the canvas live with the title / description as the user types
  if (e.target.id === "rr-builder-title" || e.target.id === "rr-builder-desc") {
    // No state mirroring needed — read at save time.
    return;
  }
});

async function _saveBuilder({ publish }) {
  const titleEl = document.getElementById("rr-builder-title");
  const descEl  = document.getElementById("rr-builder-desc");
  const title   = (titleEl?.value || "").trim() || "Untitled form";
  const description = (descEl?.value || "").trim() || null;
  if (publish && _formsState.fields.length === 0) {
    toast("Add at least one field before publishing", "warn");
    return;
  }

  const allowResubmitEl = document.getElementById("rr-form-allow-resubmit");
  const settings = {
    ..._formsState.editing?.settings || {},
    once_per_driver: allowResubmitEl ? !allowResubmitEl.checked : false,
  };
  const payload = {
    title,
    description,
    fields:   _formsState.fields,
    settings,
  };
  const { data: saved, error } = await sb.rpc("upsert_form", {
    p_id:      _formsState.editing?.id || null,
    p_payload: payload,
  });
  if (error) { toast("Save failed: " + error.message, "warn"); return; }

  if (publish && saved?.id) {
    const { error: pubErr } = await sb.rpc("publish_form", { p_id: saved.id });
    if (pubErr) { toast("Publish failed: " + pubErr.message, "warn"); return; }
    toast("Form published", "success");
  } else {
    toast(_formsState.editing ? "Draft saved" : "Form created", "success");
  }
  if (typeof closeModal === "function") closeModal("modal-form-builder");
  loadFormsList();
}
