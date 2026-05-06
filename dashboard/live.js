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

// ─── Auth gate ─────────────────────────────────────────────────────────────
const { data: { session } } = await sb.auth.getSession();
if (!session) {
  const next = encodeURIComponent(location.pathname + location.search);
  location.replace(`./login.html?next=${next}`);
  throw new Error("redirecting to login");
}

const { data: profile, error: profileErr } = await sb.from("app_users")
  .select("id, dsp_id, email, full_name, role").eq("id", session.user.id).maybeSingle();

if (profileErr || !profile) {
  // Auth user exists but app_users row doesn't — auth hook failed (most
  // likely a non-allowed domain that slipped through). Send to login with
  // an error.
  await sb.auth.signOut();
  location.replace("./login.html?err=no_profile");
  throw new Error("no app_users row");
}
window.RR.user = profile;

const { data: dspRow } = await sb.from("dsps")
  .select("id, name, short_code, timezone, metadata").eq("id", profile.dsp_id).single();
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
  // Top-of-sidebar brand wordmark — same record drives it so the
  // operator sees their own DSP name where "RouteReady" used to be.
  const elBrand = document.getElementById("rr-brand-name");
  if (elBrand) elBrand.textContent = name;
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

function renderApplicantCard(a) {
  const stage = a.pipeline_stage;
  const slug  = (a.full_name || "").toLowerCase().replace(/\s+/g, "-");
  const subtitle = [
    a.station_code ? `Station ${a.station_code}` : null,
    a.source ? `via ${a.source}` : null,
  ].filter(Boolean).join(" · ");

  let primaryBtn = "";
  if (stage === "applied") {
    primaryBtn = `<button class="pa-disp-btn primary" type="button" data-rr-action="resend_screening">Resend screening</button>`;
  } else if (stage === "screened") {
    primaryBtn = `<button class="pa-disp-btn primary" type="button" data-rr-action="send_link">Send booking link</button>`;
  } else if (stage === "booking_pending") {
    primaryBtn = `<button class="pa-disp-btn primary" type="button" data-rr-action="resend_link">Resend booking link</button>`;
  } else if (stage === "booking_scheduled") {
    const when = a.next_event_starts_at ? `Booked ${fmtDate(a.next_event_starts_at)}` : "Booked";
    primaryBtn = `<button class="pa-disp-btn ghost" type="button" disabled>${when}</button>
                  <button class="pa-disp-btn danger" type="button" data-rr-action="cancel_interview">Cancel interview</button>`;
  }

  const videoBtn = a.video_url
    ? `<button class="pa-disp-btn ghost" type="button" data-rr-action="play_video" data-video-url="${encodeURI(a.video_url)}">▶ Intro video</button>`
    : "";

  return `
    <div class="pa-card" data-stage="${stage}" data-applicant="${a.id}" data-applicant-slug="${slug}"
         data-rr-pinnable data-rr-pin-kind="applicant" data-rr-pin-ref="${a.id}"
         data-rr-pin-label="${escapeHtml(a.full_name ?? "Applicant")}">
      <div class="pa-row">
        <div class="pa-id">
          <div class="pa-name">${a.full_name ?? ""}</div>
          <div class="pa-sub">${subtitle}</div>
        </div>
        <span class="pa-stage-pill ${stage}">${STAGE_LABELS[stage] ?? stage}</span>
      </div>
      <div class="pa-disp">
        <button class="pa-disp-btn ghost" type="button" data-rr-action="call">Call</button>
        ${videoBtn}
        <button class="pa-disp-btn danger" type="button" data-rr-action="decline">Decline</button>
        ${primaryBtn}
      </div>
    </div>`;
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
    || `<div style="padding:48px;text-align:center;color:var(--text-subtle);font-size:13px">No applicants yet — share your apply link or add one manually.</div>`;
}

// ─── paAction override ─────────────────────────────────────────────────────
//
// The mockup wires onclick="paAction(this,'send_link','Marcus Hill')". We
// intercept at the document level via delegated listener; if the button
// has data-rr-action (live cards), we use that and dispatch to the RPC.
// If it has the legacy onclick (static seeded HTML), we still handle it
// the same way using the card's data-applicant.

async function handleAction(btn) {
  const card = btn.closest(".pa-card");
  if (!card) return;
  const id     = card.getAttribute("data-applicant");
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
    } else if (action === "cancel_interview") {
      const reason = prompt("Cancellation reason? (optional · stays internal)");
      if (reason === null) { btn.disabled = false; return; }
      const { error } = await sb.rpc("cancel_interview", { p_applicant_id: id, p_reason: reason || null });
      if (error) throw error;
      toast("Interview cancelled · applicant texted a new booking link", "success");
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
    }
    await loadPipeline(getActiveStage());
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
  if (typeof _legacyGoto === "function") _legacyGoto(view);
  if (view === "pipeline")  loadPipeline(getActiveStage());
  if (view === "drivers")   { loadDriversRoster(); loadDriverInsights(); }
  if (view === "checkin")   loadCheckinView();
  if (view === "dashboard") { loadTodayPlan(); }
  if (view === "messages")  loadDriverChatInbox();
};


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
    .select(`id, full_name, first_name, last_name, preferred_name, email, phone, status, hire_date, tier, score,
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
    case "inactive":   out = rows.filter(r => ["leave","inactive","terminated"].includes(r.status)); break;
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
    tbody.innerHTML = `<tr><td colspan="${colspan}" style="padding:24px;text-align:center;color:var(--red);font-size:13px">${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  const visible = visibleDriversForStage(rows, _driverStage);
  if (visible.length === 0) {
    const empty = _driverStage === "onboarding"
      ? "No drivers in onboarding right now."
      : _driverStage === "active"
      ? "No active drivers yet. Hire someone in Interview Day to fill this list."
      : "No drivers in this stage.";
    tbody.innerHTML = `<tr><td colspan="${colspan}" style="padding:48px;text-align:center;color:var(--text-subtle);font-size:13px">${empty}</td></tr>`;
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
  const tier = d.tier ? `tier-${String(d.tier).toLowerCase()}` : "tier-c";
  const contact = d.phone || d.email || "";
  const days = d.hire_date
    ? Math.max(0, Math.floor((Date.now() - new Date(d.hire_date).getTime()) / 86400000))
    : null;
  const daysCell = days != null
    ? `<span style="font-weight:600">${days}</span> <span style="font-size:11px;color:var(--text-subtle)">day${days === 1 ? "" : "s"}</span>`
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
  const tier = d.tier ? `tier-${String(d.tier).toLowerCase()}` : "tier-c";
  const tenure = d.hire_date ? tenureLabel(d.hire_date) : "—";
  const station = d.station?.code || "—";
  const contact = d.phone || d.email || "";
  // Status column dropped from the active roster — it'd always read
  // "Active" by definition.  The Active / Onboarding / At risk /
  // Inactive stage tabs above already split that.
  return `
    <tr data-driver-id="${d.id}" data-rr-open-driver
        data-rr-pinnable data-rr-pin-kind="driver" data-rr-pin-ref="${d.id}"
        data-rr-pin-label="${escapeHtml(display || "Driver")}">
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
  if (body) body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-subtle);font-size:13px">Loading…</div>`;
}

// ─── Drivers · Attendance (live) ───────────────────────────────────────────
// The attendance report now renders against the policy decay window —
// it's the operator's "standing attendance" view, not a what-happened-
// in-the-last-N-days slice.  Window selector dropped per direction.
let _attReportSort = { col: "points", dir: "desc" };
let _attReportRows = [];

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
  // toward each driver's running total.
  const POLICY = _getAttPolicy();
  const decay  = Number(POLICY.decay_days) || 90;
  const sinceDate = new Date(); sinceDate.setDate(sinceDate.getDate() - decay);
  const sinceIso  = fmtIsoDate(sinceDate);
  const todayIso  = fmtIsoDate(new Date());

  const [driversRes, shiftsRes] = await Promise.all([
    sb.from("drivers")
      .select("id, full_name, first_name, last_name, preferred_name, status, hire_date, station:station_id (code)")
      .eq("dsp_id", dspId)
      .order("full_name"),
    sb.from("shifts")
      .select("driver_id, status, date")
      .eq("dsp_id", dspId)
      .gte("date", sinceIso)
      .lte("date", todayIso),
  ]);

  if (driversRes.error || shiftsRes.error) {
    console.warn("attendance load:", driversRes.error || shiftsRes.error);
    return;
  }

  const drivers = driversRes.data || [];
  const shifts  = shiftsRes.data  || [];

  // Per-driver tally — every column accumulates from check-in clicks.
  const acc = new Map();
  for (const sh of shifts) {
    if (!sh.driver_id) continue;
    let a = acc.get(sh.driver_id);
    if (!a) { a = { scheduled: 0, present: 0, late: 0, callouts: 0, noshows: 0, vto: 0, last: null }; acc.set(sh.driver_id, a); }
    a.scheduled += 1;
    if      (sh.status === "completed")  a.present  += 1;
    else if (sh.status === "late")       a.late     += 1;
    else if (sh.status === "called_off") a.callouts += 1;
    else if (sh.status === "no_show")    a.noshows  += 1;
    else if (sh.status === "vto")        a.vto      += 1;
    if (sh.status === "called_off" || sh.status === "no_show") {
      if (!a.last || sh.date > a.last) a.last = sh.date;
    }
  }

  let totalScheduled = 0, totalIncidents = 0, totalVto = 0, inAction = 0;
  const todayMs = Date.now();
  const rows = drivers.map(d => {
    const a = acc.get(d.id) || { scheduled: 0, present: 0, late: 0, callouts: 0, noshows: 0, vto: 0, last: null };
    const occ =
        (POLICY.count_tardy   ? a.late     : 0)
      + (POLICY.count_callout ? a.callouts : 0)
      + (POLICY.count_noshow  ? a.noshows  : 0);
    const points = occ;
    let statusLabel = "Good";
    let statusKind  = "ok";
    if (POLICY.policy_enabled === false) { statusLabel = "Policy off"; statusKind = "ok"; }
    else if (occ >= POLICY.threshold_action) { statusLabel = "Action"; statusKind = "bad"; }
    else if (occ >= POLICY.threshold_warn)   { statusLabel = "Warn";   statusKind = "warn"; }
    if (POLICY.first_30_strict && d.hire_date && occ > 0) {
      const daysSinceHire = Math.floor((todayMs - new Date(d.hire_date + "T12:00:00").getTime()) / 86400000);
      if (daysSinceHire >= 0 && daysSinceHire <= (POLICY.first_30_window_days || 30)) {
        statusLabel = "Action · first-30 rule";
        statusKind  = "bad";
      }
    }
    totalScheduled += a.scheduled;
    totalIncidents += occ;
    totalVto       += a.vto;
    if (statusKind !== "ok") inAction += 1;
    return { d, a, points, occ, statusLabel, statusKind };
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
  setKpi("att-kpi-rate", `${presentPct}%`, presentPct >= 95 ? "ok" : presentPct >= 90 ? "warn" : "bad");
  setKpi("att-kpi-vto", `${vtoPct}%`);
  const rateSubEl = document.getElementById("att-kpi-rate-sub");
  if (rateSubEl) rateSubEl.textContent = `${totalIncidents} absent / ${totalScheduled} scheduled · last ${decay}d`;
  const vtoSubEl = document.getElementById("att-kpi-vto-sub");
  if (vtoSubEl) vtoSubEl.textContent = `${totalVto} VTO / ${totalScheduled} scheduled · last ${decay}d`;

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

function _renderAttReportTbody() {
  const tbody = document.getElementById("att-report-body");
  if (!tbody) return;
  const rows = [..._attReportRows];
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="13" style="padding:24px;text-align:center;color:var(--text-subtle)">No drivers yet</td></tr>`;
    return;
  }

  // Apply current sort.  Direction: asc / desc.  Each column maps to
  // a comparator-friendly value via the keyOf table below.
  const STATUS_RANK = { "Action · first-30 rule": 3, "Action": 2, "Warn": 1, "Good": 0, "Policy off": -1 };
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
    status:    (r) => STATUS_RANK[r.statusLabel] ?? 0,
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

  tbody.innerHTML = rows.map(r => {
    const display = displayDriverName(r.d);
    const initials = displayDriverInitials(r.d);
    const station = r.d.station?.code || "—";
    const last = r.a.last ? new Date(r.a.last + "T12:00:00").toLocaleDateString() : "—";
    const statusColor = r.statusKind === "bad" ? "var(--red)" : r.statusKind === "warn" ? "var(--amber)" : "var(--green)";
    return `<tr>
      <td><div class="cell-driver"><div class="avatar-sm tier-c">${initials}</div><div><div class="cell-name" data-rr-driver-id="${r.d.id}">${escapeHtml(display)}</div></div></div></td>
      <td>${escapeHtml(station)}</td>
      <td style="text-align:right">${r.a.scheduled}</td>
      <td style="text-align:right">${r.a.present}</td>
      <td style="text-align:right">${r.a.late}</td>
      <td style="text-align:right">${r.a.callouts}</td>
      <td style="text-align:right">${r.a.noshows}</td>
      <td style="text-align:right">${r.a.vto}</td>
      <td style="text-align:right;font-weight:600">${r.points}</td>
      <td style="text-align:right">${r.occ}</td>
      <td><span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:${statusColor}1A;color:${statusColor}">${r.statusLabel}</span></td>
      <td>${last}</td>
      <td></td>
    </tr>`;
  }).join("");
}

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
      <div style="font-size:13px;color:var(--text);font-weight:600;margin-bottom:2px">Set your station location</div>
      <div style="font-size:11px;color:var(--text-subtle);line-height:1.4">Paste lat/lon from Google Maps in Settings → Workspace to enable the local weather forecast and severe-weather alerts.</div>`;
    return;
  }

  body.innerHTML = `<div class="task-eyebrow" style="margin-bottom:2px">Weather · station forecast</div>
    <div style="font-size:13px;color:var(--text-subtle)">Loading…</div>`;

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
        <div style="font-size:10px;color:var(--text-muted);font-weight:600">${fmtHour(h.startTime)}</div>
        <div style="font-size:13px;font-weight:700;color:${tempColor(h.temperature)};font-variant-numeric:tabular-nums;line-height:1">${h.temperature}°</div>
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
            return `<div style="font-size:11px;color:${sev};line-height:1.35"><strong>${escapeHtml(a.event || "Alert")}</strong>${a.headline ? ` — ${escapeHtml(a.headline.slice(0, 130))}` : ""}${exp}</div>`;
          }).join("")}
        </div>`;

    const advisoryHtml = advisories.length === 0
      ? ""
      : `<div style="margin-top:8px"><div class="task-eyebrow" style="margin-bottom:3px">Driver advisory</div>
          ${advisories.map(a => `<div style="font-size:11px;color:var(--text);line-height:1.4;margin:1px 0">• ${a}</div>`).join("")}
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
          return `<div style="font-size:11px;color:var(--text-subtle);margin-top:2px">☀ Sunrise <strong style="color:var(--text)">${sr}</strong> · Sunset <strong style="color:var(--text)">${ss}</strong>${ct ? ` · Headlights ${ct}` : ""}${cutoffNote}</div>`;
        })()
      : "";

    // "Right now" detail line — humidity, gust, pressure, visibility
    const obsBits = [];
    if (rhNow != null && rhNow >= 0) obsBits.push(`Humidity <strong style="color:var(--text)">${rhNow}%</strong>`);
    if (obsGustMph && obsGustMph > nowWind) obsBits.push(`Gust <strong style="color:${obsGustMph >= 25 ? "var(--red)" : obsGustMph >= 18 ? "var(--amber)" : "var(--text)"}">${obsGustMph} mph</strong>`);
    if (obsPressureInHg) obsBits.push(`Pressure <strong style="color:var(--text)">${obsPressureInHg} inHg</strong>`);
    if (obsVisibilityMi && parseFloat(obsVisibilityMi) < 5) obsBits.push(`Vis <strong style="color:var(--amber)">${obsVisibilityMi} mi</strong>`);
    const obsLine = obsBits.length
      ? `<div style="font-size:11px;color:var(--text-subtle);margin-top:2px">${obsBits.join(" · ")}</div>`
      : "";

    const today    = dayPairs[0];
    const tomorrow = dayPairs[1];
    const dayLine = (d) => d
      ? `<div style="font-size:11px;color:var(--text-subtle);line-height:1.4">
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
        <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em">${escapeHtml(wd)}</div>
        <div style="display:flex;align-items:baseline;gap:3px">
          <span style="font-size:13px;font-weight:700;color:${tempColor(d.hi)};font-variant-numeric:tabular-nums;line-height:1">${d.hi}°</span>
          ${d.lo!=null ? `<span style="font-size:10px;color:var(--text-subtle);font-variant-numeric:tabular-nums">${d.lo}°</span>` : ""}
        </div>
        <div style="font-size:9px;color:var(--text-subtle);text-align:center;line-height:1.15;max-width:72px">${escapeHtml(summary)}</div>
        ${d.precip ? `<div style="font-size:9px;font-weight:600;color:${precipColor(d.precip)};line-height:1">${d.precip}%</div>` : `<div style="height:9px"></div>`}
      </div>`;
    }).join("");

    body.innerHTML = `
      <div class="task-eyebrow" style="margin-bottom:2px">Weather${locName ? ` · ${escapeHtml(locName)}` : ""}${obsTimestamp ? ` · obs ${fmtTime(obsTimestamp)}` : ""}</div>
      <div style="display:flex;align-items:baseline;gap:10px;margin-top:2px;flex-wrap:wrap">
        <div style="font-size:26px;font-weight:700;color:var(--text);letter-spacing:-.02em;line-height:1;font-variant-numeric:tabular-nums">${tNow}°F</div>
        <div style="font-size:12px;color:var(--text);line-height:1.3;font-weight:600">${escapeHtml(now.shortForecast || "")}</div>
        ${feelsLike != null ? `<div style="font-size:11px;color:${feelsLike >= 100 ? "var(--red)" : feelsLike >= 90 ? "var(--amber)" : feelsLike <= 20 ? "#5b8def" : "var(--text-subtle)"};font-weight:600">${feelsKind} <span style="font-variant-numeric:tabular-nums">${feelsLike}°F</span></div>` : ""}
      </div>
      <div style="font-size:11px;color:var(--text-subtle);margin-top:2px">
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
      <div style="font-size:13px;color:var(--text-subtle);line-height:1.5">${detail}</div>`;
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
      radius: 193121, color: '#3b82f6', weight: 1.5, dashArray: '6 4',
      fillColor: '#3b82f6', fillOpacity: 0.04,
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
  const cardEl  = document.getElementById("rr-set-weather-show-card");
  const radarEl = document.getElementById("rr-set-weather-show-radar");
  if (cardEl)  cardEl.checked  = meta.show_card  !== false;
  if (radarEl) radarEl.checked = meta.show_radar !== false;

  // DSP brand · prefill from the live record so the operator can edit it.
  const nameEl = document.getElementById("rr-set-dsp-name");
  const codeEl = document.getElementById("rr-set-dsp-code");
  if (nameEl) nameEl.value = window.RR?.dsp?.name        || "";
  if (codeEl) codeEl.value = window.RR?.dsp?.short_code  || "";
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

// Persist the weather card/radar toggles to dsps.metadata.weather.
async function _saveWeatherToggle(field, value) {
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;
  const status = document.getElementById("rr-set-weather-toggle-status");
  if (status) { status.style.color = "var(--text-subtle)"; status.textContent = "Saving…"; }
  try {
    const { data: dsp } = await sb.from("dsps").select("metadata").eq("id", dspId).single();
    const meta = dsp?.metadata || {};
    const newWeather = { ...(meta.weather || {}), [field]: value };
    const newMeta = { ...meta, weather: newWeather };
    const { error } = await sb.from("dsps").update({ metadata: newMeta }).eq("id", dspId);
    if (error) throw error;
    if (window.RR?.dsp) window.RR.dsp.metadata = newMeta;
    if (status) { status.style.color = "var(--green, #22c55e)"; status.textContent = "Saved"; setTimeout(() => { if (status) status.textContent = ""; }, 1500); }
    if (typeof loadDashboardWeather === "function") loadDashboardWeather();
  } catch (err) {
    console.error("weather toggle save:", err);
    if (status) { status.style.color = "var(--red)"; status.textContent = "Save failed"; }
  }
}
document.addEventListener("change", (e) => {
  if (e.target.id === "rr-set-weather-show-card")  _saveWeatherToggle("show_card",  !!e.target.checked);
  if (e.target.id === "rr-set-weather-show-radar") _saveWeatherToggle("show_radar", !!e.target.checked);
});
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
      const tier = d.tier ? `tier-${String(d.tier).toLowerCase()}` : "tier-c";
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
    ? `<div style="padding:32px;text-align:center;color:var(--text-subtle)">No shifts scheduled for today.</div>`
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
  progressive_coaching: true,
  // Auto-coaching: master toggle + per-level toggles.  When the master
  // is ON and the per-level toggle for the recommended action is also
  // ON, hitting Approve on the daily tool fires the coaching record
  // and DMs the driver immediately.  Anything not auto-fired drops
  // into the coaching drawer for the leader to finalize.  Termination
  // is never auto — final-step decisions always need a human signoff.
  auto_coaching:    false,
  auto_verbal:      false,
  auto_written:     false,
  auto_final:       false,
  // First-30-days strict rule: any callout/no-show inside the
  // probationary window jumps the driver straight to Action.
  first_30_strict: false,
  first_30_window_days: 30,
};

function _getAttPolicy() {
  const p = window.RR?.dsp?.metadata?.attendance?.policy || {};
  // Translate legacy records (points-mode, single auto_coaching bool)
  // into the new shape.  Old fields are dropped on read — occurrence-
  // only is the supported model now.
  const merged = { ..._ATT_DEFAULT_POLICY, ...p };
  delete merged.mode;
  delete merged.points_per_tardy;
  delete merged.points_per_callout;
  delete merged.points_per_noshow;
  // Drop any old multi-action records — the model is now master toggle
  // + per-level toggles.
  delete merged.auto_coaching_actions;
  return merged;
}

async function loadAttendancePolicy() {
  const pane = document.getElementById("att-pane-policy");
  if (!pane) return;
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;

  // Pull both the policy (lives on dsps.metadata) and the timing
  // settings (lives on scheduling_settings) — the timing fields drive
  // when a driver shows as Tardy / NCNS in the daily roster, so they
  // belong in the same builder UI even though the schema stores them
  // separately.
  const [{ data: dspRow, error: dspErr }, { data: setRow }] = await Promise.all([
    sb.from("dsps").select("metadata").eq("id", dspId).single(),
    sb.from("scheduling_settings")
      .select("checkin_lead_minutes, tardy_grace_minutes, ncns_after_minutes")
      .eq("dsp_id", dspId).is("week_start", null).maybeSingle(),
  ]);
  if (dspErr) { console.warn("policy load:", dspErr.message); return; }
  const meta = dspRow?.metadata || {};
  if (window.RR?.dsp) window.RR.dsp.metadata = meta;
  const p = _getAttPolicy();
  const timing = {
    checkin_lead_minutes: setRow?.checkin_lead_minutes ?? 15,
    tardy_grace_minutes:  setRow?.tardy_grace_minutes  ?? 10,
    ncns_after_minutes:   setRow?.ncns_after_minutes   ?? 60,
  };

  // Reusable toggle row.  All yes/no settings on this page render this
  // way so the operator gets a consistent on-screen language.
  const toggleRow = (field, label, blurb) => `
    <label class="rr-pol-toggle-row" style="display:flex;align-items:flex-start;gap:14px;padding:12px 0;border-top:1px solid var(--border)">
      <span style="flex:1">
        <div style="font-size:13px;font-weight:600;color:var(--text)">${escapeHtml(label)}</div>
        <div style="font-size:11px;color:var(--text-subtle);margin-top:2px;line-height:1.5">${blurb}</div>
      </span>
      <label class="toggle" style="margin-top:2px">
        <input type="checkbox" data-rr-att-field-bool="${field}" ${p[field] ? "checked" : ""}/>
        <span class="toggle-slider"></span>
      </label>
    </label>`;

  pane.innerHTML = `
    <!-- Master enabled toggle -->
    <div class="pol-section" style="display:flex;align-items:center;gap:14px">
      <span style="flex:1">
        <h3 class="pol-section-title">Attendance policy</h3>
        <p class="pol-section-sub" style="margin:0">When ON, the dashboard scores every driver against the rules below and surfaces flags on Today's Plan. When OFF, attendance is logged but the dashboard does not flag, warn, or recommend actions.</p>
      </span>
      <label class="toggle">
        <input type="checkbox" data-rr-att-field-bool="policy_enabled" ${p.policy_enabled ? "checked" : ""}/>
        <span class="toggle-slider"></span>
      </label>
    </div>

    <!-- How occurrence-based scoring works -->
    <div class="pol-section">
      <h3 class="pol-section-title">How it works</h3>
      <p class="pol-section-sub">Every Amazon DSP that uses an attendance policy uses the <strong>occurrence model</strong>: each event you choose to count is worth one occurrence, and the dashboard tracks a running total over a rolling decay window.  When a driver crosses your <strong>Warn</strong> threshold the Today's Plan daily tool shows a yellow flag with a coaching prompt.  When they cross <strong>Action</strong> the row turns red and the dashboard recommends a write-up (or the next progressive step, see below).  Older events drop off as the decay window scrolls forward, so a driver who had a rough month can recover.</p>
    </div>

    <!-- Timing thresholds — when does Tardy / NCNS kick in -->
    <div class="pol-section">
      <h3 class="pol-section-title">Tardy &amp; NCNS timing</h3>
      <p class="pol-section-sub">How many minutes after a shift's start time before the dashboard considers the driver tardy or a no-call no-show. These drive the live status on Today's Plan and the orange/red flags on the daily approvals card.</p>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(200px,1fr));gap:14px;max-width:520px">
        <label style="display:flex;flex-direction:column;gap:4px">
          <span style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Tardy after (min)</span>
          <input type="number" min="0" max="120" step="1" class="form-input" data-rr-att-timing="tardy_grace_minutes" value="${timing.tardy_grace_minutes}"/>
          <span style="font-size:11px;color:var(--text-subtle)">Driver still hasn't checked in this many minutes <strong>after</strong> their shift start = <strong>Tardy</strong>. Common: 5–15 minutes.</span>
        </label>
        <label style="display:flex;flex-direction:column;gap:4px">
          <span style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">NCNS after (min)</span>
          <input type="number" min="30" max="240" step="30" class="form-input" data-rr-att-timing="ncns_after_minutes" value="${timing.ncns_after_minutes}"/>
          <span style="font-size:11px;color:var(--text-subtle)">No check-in <strong>and</strong> no callout this many minutes after start = <strong>No-call no-show</strong>. Adjusts in 30-minute steps.</span>
        </label>
      </div>
    </div>

    </div>

    <!-- Auto-escalations -->
    <div class="pol-section">
      <h3 class="pol-section-title">Auto-escalations</h3>
      <p class="pol-section-sub">Optional rules that bypass the normal threshold ladder for severe events.</p>
      ${toggleRow("ncns_terminates", "No-call no-show escalates to termination",
        "When ON, the dashboard recommends <strong>termination</strong> on the driver's first NCNS — regardless of running total.  Many DSPs run their policy this way because an NCNS is the single biggest hit to a station's reliability score.")}
      ${toggleRow("first_30_strict", "Strict no-absence rule for first " + (p.first_30_window_days || 30) + " days",
        "When ON, any callout or no-show inside the driver's probationary window jumps them straight to <strong>Action</strong> regardless of accrued occurrences.  Standard for new-hire periods.")}
      <label style="display:flex;flex-direction:column;gap:4px;padding:12px 0 0;max-width:200px">
        <span style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Probation window (days)</span>
        <input type="number" min="7" max="120" step="1" class="form-input" data-rr-att-field="first_30_window_days" value="${p.first_30_window_days}"/>
      </label>
    </div>

    <!-- Coaching style + auto-coaching -->
    <div class="pol-section">
      <h3 class="pol-section-title">Coaching style</h3>
      <p class="pol-section-sub">How the dashboard phrases its recommendations once a driver crosses a threshold, and which levels of coaching fire automatically when a leader hits Approve on the daily attendance card.</p>
      ${toggleRow("progressive_coaching", "Use progressive coaching steps",
        "When ON the recommended action escalates: <strong>Verbal</strong> coaching at the Warn threshold → <strong>Written</strong> warning at Action → <strong>Final</strong> written warning on a repeat → <strong>Termination</strong>.  Documents the conversation each time so an unemployment claim has a paper trail.<br>When OFF the dashboard recommends a single Coach action at Warn and a single Write-up at Action.")}
      ${toggleRow("auto_coaching", "Auto-coach when an event is approved",
        "When ON, approving an event on the daily attendance card automatically logs the coaching to the driver's record and DMs them in the RouteReady app.  Pick which levels auto-fire below — anything you don't auto-fire drops into the coaching drawer for a leader to finalize manually.<br>When OFF, every approved event drops into the coaching drawer regardless of level.")}

      <!-- Per-level auto-approval (only meaningful when auto_coaching is ON) -->
      <div id="rr-att-auto-levels" style="margin-top:6px;border-top:1px solid var(--border);padding-top:10px;${p.auto_coaching ? "" : "opacity:.45;pointer-events:none"}">
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px">Levels that auto-fire</div>
        ${toggleRow("auto_verbal",  "Verbal warnings auto-fire",
          "When the recommended action is a <strong>Verbal</strong> coaching, fire it without leader review.")}
        ${toggleRow("auto_written", "Written warnings auto-fire",
          "When the recommended action is a <strong>Written</strong> warning, fire it without leader review.")}
        ${toggleRow("auto_final",   "Final written warnings auto-fire",
          "When the recommended action is a <strong>Final</strong> written warning, fire it without leader review.")}
        <div style="font-size:11px;color:var(--text-subtle);padding:8px 0 0;line-height:1.5">
          <strong>Termination is never auto-approved.</strong>  A leader always confirms a termination from the coaching drawer.
        </div>
      </div>
    </div>

    <!-- Auto-coaching actions on Approve -->
    <div class="pol-section">
      <h3 class="pol-section-title">Auto-coach when an event is approved</h3>
      <p class="pol-section-sub">Pick which side effects fire automatically when a leader hits <strong>Approve</strong> on the daily attendance card.  Pick none and coaching is fully manual — the attendance report will flag the row as <em>Coaching pending</em> until a leader finalizes it from the coaching drawer.</p>
      ${(function () {
        const has = (v) => Array.isArray(p.auto_coaching_actions) && p.auto_coaching_actions.includes(v);
        const row = (val, label, blurb) => `
          <label class="rr-pol-toggle-row" style="display:flex;align-items:flex-start;gap:14px;padding:12px 0;border-top:1px solid var(--border)">
            <span style="flex:1">
              <div style="font-size:13px;font-weight:600;color:var(--text)">${escapeHtml(label)}</div>
              <div style="font-size:11px;color:var(--text-subtle);margin-top:2px;line-height:1.5">${blurb}</div>
            </span>
            <label class="toggle" style="margin-top:2px">
              <input type="checkbox" data-rr-att-action="${val}" ${has(val) ? "checked" : ""}/>
              <span class="toggle-slider"></span>
            </label>
          </label>`;
        return [
          row("message",      "Send a message in the driver's app",
            "Posts a chat message in the driver's RouteReady app explaining what was logged and why.  When the <strong>Coach drawer pending action</strong> below is also on, the message waits until the leader finalizes the coaching from the drawer.  Logged in the driver's coaching record either way."),
          row("notification", "Send a push notification",
            "Triggers a push notification on the driver's phone.  Same content as the in-app message; pairs naturally with the message option above so the driver sees it without having to open the app."),
          row("coach_drawer", "Add a pending action to the coaching drawer",
            "Creates a draft coaching record marked <em>Pending</em> and routes it to the coaching drawer.  The leader reviews, edits the notes, and finalizes — at which point any chosen message / notification fires.  Use this when you want a human eye before the driver hears about it."),
        ].join("");
      })()}
    </div>

    <!-- Save -->
    <div style="display:flex;align-items:center;gap:10px;margin-top:6px">
      <button class="btn btn-primary" type="button" id="rr-att-policy-save">Save policy</button>
      <span id="rr-att-policy-status" style="font-size:12px;color:var(--text-subtle)"></span>
    </div>`;

  // Apply the cascading disable rules now that the DOM is in place.
  _rrApplyPolicyDisabledStates();
}

document.addEventListener("click", async (e) => {
  // Save policy.  Mode is fixed to occurrence now — no mode selector.
  if (e.target.id === "rr-att-policy-save") {
    e.preventDefault();
    const dspId = window.RR?.dsp?.id;
    if (!dspId) return;
    const status = document.getElementById("rr-att-policy-status");
    const fields = {};
    document.querySelectorAll("[data-rr-att-field]").forEach(el => {
      fields[el.dataset.rrAttField] = Number(el.value);
    });
    document.querySelectorAll("[data-rr-att-field-bool]").forEach(el => {
      fields[el.dataset.rrAttFieldBool] = !!el.checked;
    });
    // Timing fields live on scheduling_settings, not in dsps.metadata.
    const timing = {};
    document.querySelectorAll("[data-rr-att-timing]").forEach(el => {
      const v = Number(el.value);
      if (Number.isFinite(v) && v >= 0) timing[el.dataset.rrAttTiming] = v;
    });
    // Multi-select auto-coaching actions.
    const auto_coaching_actions = [];
    document.querySelectorAll("[data-rr-att-action]").forEach(el => {
      if (el.checked) auto_coaching_actions.push(el.dataset.rrAttAction);
    });
    const newPolicy = { ..._ATT_DEFAULT_POLICY, ...fields, auto_coaching_actions };

    if (status) { status.style.color = "var(--text-subtle)"; status.textContent = "Saving…"; }

    // 1. Save the policy on dsps.metadata.
    const { data: row } = await sb.from("dsps").select("metadata").eq("id", dspId).single();
    const meta = row?.metadata || {};
    const newMeta = { ...meta, attendance: { ...(meta.attendance || {}), policy: newPolicy } };
    const { error: upErr } = await sb.from("dsps").update({ metadata: newMeta }).eq("id", dspId);
    if (upErr) { if (status) { status.style.color = "var(--red)"; status.textContent = "Failed: " + upErr.message; } return; }
    if (window.RR?.dsp) window.RR.dsp.metadata = newMeta;

    // 2. Save the tardy/NCNS timing on scheduling_settings — upsert the
    // dsp-default row (week_start IS NULL).  Two tries because the
    // existing row may or may not be there yet.
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
    // Refresh report tab to use the new thresholds.
    if (typeof loadAttendanceLive === "function") loadAttendanceLive();
  }
});

// Live enable/disable behavior on the policy builder.  Two cascading
// rules:
//   1. Master "Attendance policy" toggle off → grey out every other
//      input on the page (operator can't tweak rules that aren't
//      running).
//   2. "Auto-coach when an event is approved" off → grey out the per-
//      level toggles so it's clear they have no effect.
function _rrApplyPolicyDisabledStates() {
  const pane = document.getElementById("att-pane-policy");
  if (!pane) return;

  const masterEl = pane.querySelector('[data-rr-att-field-bool="policy_enabled"]');
  const policyEnabled = masterEl ? !!masterEl.checked : true;

  // Dim the whole page when the policy is off, except the master row.
  pane.querySelectorAll(".pol-section").forEach((sec, i) => {
    if (i === 0) return; // first section holds the master toggle
    sec.style.opacity       = policyEnabled ? ""    : "0.45";
    sec.style.pointerEvents = policyEnabled ? ""    : "none";
  });

  // Within Coaching style, grey out the level toggles when the
  // auto_coaching master is off (or the whole policy is off).
  const autoEl  = pane.querySelector('[data-rr-att-field-bool="auto_coaching"]');
  const autoOn  = autoEl ? !!autoEl.checked : false;
  const levels  = document.getElementById("rr-att-auto-levels");
  if (levels) {
    const off = !policyEnabled || !autoOn;
    levels.style.opacity       = off ? "0.45" : "";
    levels.style.pointerEvents = off ? "none" : "";
  }
}
document.addEventListener("change", (e) => {
  const f = e.target?.dataset?.rrAttFieldBool;
  if (f === "policy_enabled" || f === "auto_coaching") {
    _rrApplyPolicyDisabledStates();
  }
});


async function loadAttendanceEventLog() {
  const pane = document.getElementById("att-pane-log");
  if (!pane) return;
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;

  const policy = _getAttPolicy();
  const since = new Date(); since.setDate(since.getDate() - policy.decay_days);
  const sinceIso = fmtIsoDate(since);

  const [shiftsRes, driversRes] = await Promise.all([
    sb.from("shifts")
      .select("id, date, status, driver_id")
      .eq("dsp_id", dspId)
      .in("status", ["called_off", "no_show", "late"])
      .gte("date", sinceIso)
      .order("date", { ascending: false }),
    sb.from("drivers")
      .select("id, full_name, first_name, last_name, preferred_name, station:station_id (code), tier")
      .eq("dsp_id", dspId),
  ]);

  if (shiftsRes.error || driversRes.error) {
    console.warn("event log load:", shiftsRes.error || driversRes.error);
    return;
  }

  const drvById = new Map((driversRes.data || []).map(d => [d.id, d]));
  const events = (shiftsRes.data || []).filter(sh => sh.driver_id);

  const countEl = document.getElementById("att-log-count");
  if (countEl) countEl.textContent = String(events.length);

  if (events.length === 0) {
    pane.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-subtle);font-size:13px">No callouts, no-shows, or late events in the last ${policy.decay_days} days.</div>`;
    return;
  }

  const eventLabel = { called_off: "Callout", no_show: "No-show", late: "Late" };
  const eventColor = { called_off: "var(--amber)", no_show: "var(--red)", late: "var(--text-muted)" };

  // Occurrence model: each event is either +1 (counts) or 0 (doesn't),
  // based on the per-event toggles in the policy builder.
  const counts = (st) =>
       (st === "late"       && policy.count_tardy)
    || (st === "called_off" && policy.count_callout)
    || (st === "no_show"    && policy.count_noshow);

  pane.innerHTML = `
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Date</th><th>Driver</th><th>Station</th><th>Event</th><th style="text-align:right">Counts</th></tr></thead>
      <tbody>
        ${events.map(ev => {
          const d = drvById.get(ev.driver_id);
          const display = d ? displayDriverName(d) : "—";
          const station = d?.station?.code || "—";
          const initials = d ? displayDriverInitials(d) : "?";
          const tier = d?.tier ? `tier-${String(d.tier).toLowerCase()}` : "tier-c";
          const occ = counts(ev.status) ? 1 : 0;
          return `<tr>
            <td>${new Date(ev.date + "T12:00:00").toLocaleDateString()}</td>
            <td><div class="cell-driver"><div class="avatar-sm ${tier}">${initials}</div><div><div class="cell-name" data-rr-driver-id="${d?.id || ev.driver_id || ""}">${escapeHtml(display)}</div></div></div></td>
            <td>${escapeHtml(station)}</td>
            <td><span style="color:${eventColor[ev.status]};font-weight:600">${eventLabel[ev.status]}</span></td>
            <td style="text-align:right;font-weight:600;color:${occ ? "var(--text)" : "var(--text-subtle)"}">${occ ? "+1 occurrence" : "—"}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table></div>`;
}

// Hook attTab — operator clicks Report / Policy / Log inside the
// Drivers → Attendance subview. The mockup defines window.attTab on
// load; wrap it so we can also fire our live loaders.
const _legacyAttTab = window.attTab;
window.attTab = function (name) {
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
  if (name === "history") loadAttendanceHistory();
  if (name === "report")  loadAttendanceLive();
  if (name === "log")     loadAttendanceEventLog();
};

// Load the right data when the operator opens a settings section
// that's hosted by JS rather than baked into the HTML mockup.
document.addEventListener("click", (e) => {
  if (e.target.closest('.settings-nav-item[data-set="attendance"]')) {
    setTimeout(() => loadAttendancePolicy(), 0);
  }
  if (e.target.closest('.settings-nav-item[data-set="availability"]')) {
    setTimeout(() => loadAvailabilityRequests(), 0);
  }
});

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
      <div id="rr-tp-waves"   style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-bottom:14px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;height:108px"></div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;height:108px"></div>
      </div>
      <div id="rr-tp-meta"    style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:8px 14px;margin-bottom:14px;font-size:12px;color:var(--text-subtle)">Loading…</div>
      <div id="rr-tp-tool"    style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:14px">
        <div style="padding:12px 14px;background:var(--canvas);border-bottom:1px solid var(--border);font-size:13px;font-weight:700">Daily attendance · approvals</div>
        <div style="padding:18px;text-align:center;color:var(--text-subtle);font-size:12px">Loading…</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
        <div id="rr-tp-extras" style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">
          <div style="padding:12px 14px;background:var(--canvas);border-bottom:1px solid var(--border);font-size:13px;font-weight:700">Extra drivers (Ex)</div>
          <div style="padding:18px;text-align:center;color:var(--text-subtle);font-size:12px">Loading…</div>
        </div>
        <div id="rr-tp-cov" style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">
          <div style="padding:12px 14px;background:var(--canvas);border-bottom:1px solid var(--border);font-size:13px;font-weight:700">Coverage</div>
          <div style="padding:18px;text-align:center;color:var(--text-subtle);font-size:12px">Loading…</div>
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
    toolEl.innerHTML = `<div style="padding:12px 14px;background:var(--canvas);border-bottom:1px solid var(--border);font-size:13px;font-weight:700">Daily attendance · approvals</div>
      <div style="padding:18px;color:var(--red);font-size:12px;text-align:center">${escapeHtml(error.message || String(error))}</div>`;
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
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <div style="font-size:13px;font-weight:700;color:var(--text)">Wave ${escapeHtml(String(wave))}</div>
          <div style="font-size:11px;color:var(--text-subtle)">${b.scheduled} scheduled</div>
        </div>
        <div style="display:flex;gap:12px">
          <div style="flex:1">
            <div style="font-size:11px;color:var(--text-subtle);font-weight:600;letter-spacing:.04em;text-transform:uppercase">Checked in</div>
            <div style="font-size:24px;font-weight:700;color:var(--text)">${b.checkedIn}<span style="font-size:13px;color:var(--text-subtle);font-weight:600;margin-left:6px">${inPct}%</span></div>
          </div>
          <div style="flex:1">
            <div style="font-size:11px;color:var(--text-subtle);font-weight:600;letter-spacing:.04em;text-transform:uppercase">Not in</div>
            <div style="font-size:24px;font-weight:700;color:var(--text)">${b.notIn}<span style="font-size:13px;color:var(--text-subtle);font-weight:600;margin-left:6px">${outPct}%</span></div>
          </div>
        </div>
        <div style="height:6px;background:var(--canvas);border-radius:999px;overflow:hidden;display:flex">
          <div style="width:${inPct}%;background:var(--text-muted)"></div>
          <div style="width:${outPct}%;background:var(--border-strong)"></div>
        </div>
        ${flagged > 0
          ? `<div style="font-size:11px;color:var(--text);font-weight:600">${b.tardy} tardy · ${b.ncns} NCNS</div>`
          : `<div style="font-size:11px;color:var(--text-subtle)">No issues this wave</div>`}
      </div>`;
  };

  const sortedWaves = [...waveBuckets.entries()].sort((a, b) => a[0] - b[0]);
  wavesEl.innerHTML = sortedWaves.length === 0
    ? `<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;text-align:center;color:var(--text-subtle);font-size:13px">No drivers scheduled today.</div>`
    : sortedWaves.map(([w, b]) => waveCard(w, b)).join("");

  // ── Meta strip (service-type breakdown + as-of) ────────────────────
  const bySvc = {};
  for (const r of attRows) {
    const sv = r.service_type_code || "—";
    if (!bySvc[sv]) bySvc[sv] = { count: 0, color: r.service_type_color || "#94a3b8" };
    bySvc[sv].count++;
  }
  const svcChips = Object.entries(bySvc).map(([code, v]) =>
    `<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:10px;background:${v.color}22;color:${v.color};font-size:11px;font-weight:600;margin-right:4px">${escapeHtml(code)} · ${v.count}</span>`
  ).join("");
  metaEl.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <div>${svcChips || "<span style='color:var(--text-subtle)'>No service-type breakdown</span>"}</div>
      <div style="font-size:11px;color:var(--text-subtle)">As of ${escapeHtml(new Date(data.as_of).toLocaleTimeString())}</div>
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
    ? `<div style="padding:18px;text-align:center;color:var(--text-subtle);font-size:12px">No extras scheduled today.</div>`
    : extras.map(r => {
        const t = r.starts_at ? new Date(r.starts_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "—";
        // Neutral chip — Today page is a no-stoplight zone.
        const tone = { bg: "var(--canvas)", fg: "var(--text-muted)" };
        const label = _RR_OUTCOME_LABEL[r.computed_outcome] || r.computed_outcome;
        const initials = (r.driver_name || "?").split(/\s+/).map(p => p[0]).filter(Boolean).slice(0,2).join("").toUpperCase();
        return `
          <div style="display:grid;grid-template-columns:30px 1fr auto;gap:10px;align-items:center;padding:8px 14px;border-top:1px solid var(--border)">
            <div class="avatar-sm tier-c" data-rr-driver-id="${escapeHtml(r.driver_id)}" style="width:30px;height:30px;font-size:11px">${escapeHtml(initials)}</div>
            <div style="min-width:0">
              <div style="font-size:13px;font-weight:600" data-rr-driver-id="${escapeHtml(r.driver_id)}">${escapeHtml(r.driver_name)}</div>
              <div style="font-size:11px;color:var(--text-subtle)">${escapeHtml(r.station_code || "—")} · Wave ${r.wave_index ?? 0} · ${escapeHtml(t)}</div>
            </div>
            <span style="background:${tone.bg};color:${tone.fg};font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:3px 8px;border-radius:10px">${escapeHtml(label)}</span>
          </div>`;
      }).join("");
  extrasEl.innerHTML = `
    <div style="padding:12px 14px;background:var(--canvas);border-bottom:1px solid var(--border);font-size:13px;font-weight:700">
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
    <div style="padding:12px 14px;background:var(--canvas);border-bottom:1px solid var(--border);font-size:13px;font-weight:700">
      Daily attendance · approvals <span style="color:var(--text-subtle);font-weight:600">· ${n}</span>
    </div>`;

  if (flagged.length === 0) {
    toolEl.innerHTML = `${head(0)}
      <div style="padding:24px;text-align:center;color:var(--green);font-size:13px;font-weight:600">✓ No tardies or no-shows to approve right now.</div>`;
    return;
  }

  const policy = _getAttPolicy();
  const dspId  = window.RR?.dsp?.id;
  const since  = new Date(Date.now() - (policy.decay_days || 90) * 86400000)
    .toISOString().slice(0, 10);

  // If the policy is OFF, skip history + scoring entirely — operator
  // wants attendance logged but not flagged.
  let occMap = new Map();
  if (policy.policy_enabled !== false) {
    const ids = flagged.map(r => r.driver_id);
    const { data: hist } = await sb.from("shifts")
      .select("driver_id, status")
      .eq("dsp_id", dspId)
      .in("driver_id", ids)
      .in("status", ["called_off", "no_show", "late"])
      .gte("date", since);
    const counts = (st) =>
         (st === "late"       && policy.count_tardy)
      || (st === "called_off" && policy.count_callout)
      || (st === "no_show"    && policy.count_noshow);
    for (const h of (hist || [])) {
      if (!counts(h.status)) continue;
      occMap.set(h.driver_id, (occMap.get(h.driver_id) || 0) + 1);
    }
  }

  // Neutral palette — labels carry the meaning; no stoplight tints.
  const standing = (n) => {
    if (policy.policy_enabled === false) return { label: "Policy off", tone: "var(--text-subtle)" };
    if (n >= policy.threshold_action) return { label: "Action",        tone: "var(--text)" };
    if (n >= policy.threshold_warn)   return { label: "Warning",       tone: "var(--text-muted)" };
    return { label: "Good standing", tone: "var(--text-subtle)" };
  };

  // Compute the coaching level (verbal / written / final / termination /
  // none) that applies to this row.  Drives both the "Next:" label and
  // the auto-fire decision when the leader hits Approve.
  const levelFor = (outcome, nAfter) => {
    if (policy.policy_enabled === false) return null;
    if (outcome === "ncns" && policy.ncns_terminates) return "termination";
    const prog = !!policy.progressive_coaching;
    if (nAfter >= policy.threshold_action) return prog ? "final" : "written";
    if (nAfter >= policy.threshold_warn)   return prog ? "verbal" : "verbal";
    return null;
  };
  const recommend = (outcome, level) => {
    if (policy.policy_enabled === false) return "Logged · policy is off";
    if (level === "termination") return "Termination · review &amp; confirm";
    if (level === "final")       return "Final written warning · 1 step before termination";
    if (level === "written")     return "Written warning · log conversation";
    if (level === "verbal")      return "Verbal coaching · log conversation";
    if (outcome === "ncns")  return "Confirm no-call / no-show";
    if (outcome === "tardy") return "Note tardy · no formal action";
    return "Acknowledge missed day";
  };
  const willAutoFire = (level) => {
    if (!level || level === "termination") return false;
    if (policy.policy_enabled === false) return false;
    if (!policy.auto_coaching) return false;
    if (level === "verbal"  && policy.auto_verbal)  return true;
    if (level === "written" && policy.auto_written) return true;
    if (level === "final"   && policy.auto_final)   return true;
    return false;
  };

  const counted = (outcome) =>
       (outcome === "tardy"           && policy.count_tardy)
    || (outcome === "missed_reported" && policy.count_callout)
    || (outcome === "ncns"            && policy.count_noshow);

  const rows = flagged.map(r => {
    const before = occMap.get(r.driver_id) || 0;
    const add = (policy.policy_enabled !== false && counted(r.computed_outcome)) ? 1 : 0;
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
        <div class="avatar-sm tier-c" data-rr-driver-id="${escapeHtml(r.driver_id)}">${escapeHtml(initials)}</div>
        <div style="min-width:0">
          <div style="font-size:13px;font-weight:600" data-rr-driver-id="${escapeHtml(r.driver_id)}">${escapeHtml(r.driver_name)}</div>
          <div style="font-size:11px;color:var(--text-subtle)">${escapeHtml(r.station_code || "—")} · Wave ${r.wave_index ?? 0}</div>
        </div>
        <div>
          <span style="background:${tone.bg};color:${tone.fg};font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:3px 8px;border-radius:10px">${escapeHtml(label)}</span>
        </div>
        <div style="min-width:0">
          <div style="font-size:12px;color:var(--text)"><strong>${after} occ${after === 1 ? "" : "s"}</strong> · <span style="color:${st.tone};font-weight:600">${st.label}</span></div>
          <div style="font-size:11px;color:var(--text-subtle)">Next: ${rec}${auto ? " · auto-fires on Approve" : ""}</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm btn-primary"
                  data-rr-tp-approve="1"
                  data-shift-id="${escapeHtml(r.shift_id)}"
                  data-outcome="${escapeHtml(r.computed_outcome)}"
                  data-driver-name="${escapeHtml(r.driver_name)}"
                  data-level="${escapeHtml(lvl || '')}"
                  data-auto-fire="${auto ? '1' : '0'}"
                  type="button">Confirm</button>
          <button class="btn btn-sm"
                  data-rr-tp-deny="1"
                  data-shift-id="${escapeHtml(r.shift_id)}"
                  data-outcome="${escapeHtml(r.computed_outcome)}"
                  data-driver-name="${escapeHtml(r.driver_name)}"
                  data-level="${escapeHtml(lvl || '')}"
                  type="button">Decline</button>
        </div>
      </div>`;
  }).join("");

  // Footer summary — what happens on Confirm given the operator's
  // current Coaching style settings.
  let autoCoachNote;
  if (policy.policy_enabled === false) {
    autoCoachNote = "Attendance policy is OFF — Confirm logs the event as a manual coaching needed.";
  } else if (!policy.auto_coaching) {
    autoCoachNote = "Auto-coaching is OFF — Confirm logs the event as a manual coaching for the leader to file from the drawer.";
  } else {
    const levels = [];
    if (policy.auto_verbal)  levels.push("verbal");
    if (policy.auto_written) levels.push("written");
    if (policy.auto_final)   levels.push("final");
    autoCoachNote = levels.length === 0
      ? "Auto-coaching is ON but no levels auto-fire — every Confirm still routes through the coaching drawer as Pending."
      : "Auto-fires when level is: " + levels.join(", ") + ".  Other levels (and termination) drop into the coaching drawer as Pending.";
  }

  toolEl.innerHTML = `${head(flagged.length)}${rows}
    <div style="padding:10px 14px;background:var(--canvas);border-top:1px solid var(--border);font-size:11px;color:var(--text-subtle)">
      ${escapeHtml(autoCoachNote)}
    </div>`;
}

// Approve / decline on the daily tool.  Approve hits the
// attendance_decide RPC (which stamps shifts.status, writes a coaching
// row, and DMs the driver if auto_coaching is on).  Decline opens a
// notes prompt — server enforces notes on deny.
document.addEventListener("click", async (e) => {
  const ap = e.target.closest("[data-rr-tp-approve]");
  const dn = e.target.closest("[data-rr-tp-deny]");
  if (!ap && !dn) return;
  e.preventDefault();
  const btn = ap || dn;
  const row = btn.closest(".rr-tp-tool-row");
  if (!row) return;

  const shiftId    = btn.dataset.shiftId;
  const outcome   = btn.dataset.outcome;
  const driverName = btn.dataset.driverName || "driver";

  let notes = null;
  if (dn) {
    const reason = window.prompt(
      `Decline ${driverName}'s ${outcome.replace(/_/g, " ")}?\n\nNotes are required — explain why this event is excused (e.g. "approved leave", "system glitch", "documentation provided").`
    );
    if (reason === null) return;                       // cancelled
    if (!reason.trim()) { toast("Notes required to decline", "warn"); return; }
    notes = reason.trim();
  }

  const btnCell = btn.parentElement;
  btnCell.innerHTML = `<span style="font-size:11px;color:var(--text-subtle)">Saving…</span>`;

  const level    = btn.dataset.level || null;
  const autoFire = btn.dataset.autoFire === "1";

  const { data, error } = await sb.rpc("attendance_decide", {
    p_shift_id:  shiftId,
    p_outcome:   outcome,
    p_decision:  ap ? "approve" : "deny",
    p_notes:     notes,
    p_auto_fire: ap ? autoFire : false,
    p_level:     level,
  });

  if (error) {
    toast("Save failed: " + (error.message || String(error)), "warn");
    btnCell.innerHTML = `<span style="font-size:11px;color:var(--red)">${escapeHtml(error.message || "Failed")}</span>`;
    return;
  }

  const verb = ap ? "Approved" : "Declined";
  const tone = ap ? "var(--green)" : "var(--text-subtle)";
  row.style.opacity = "0.55";
  btnCell.innerHTML = `<span style="font-size:11px;font-weight:700;color:${tone};letter-spacing:.04em;text-transform:uppercase">${escapeHtml(verb)}</span>`;
  const tailParts = [];
  if (data?.auto_fired) tailParts.push("driver coached");
  else if (ap)          tailParts.push("queued for coaching drawer");
  const tail = tailParts.length ? " · " + tailParts.join(" · ") : "";
  toast(`${verb}${tail}`, "success");
});

function _renderTpCoverage(data, error) {
  const covEl = document.getElementById("rr-tp-cov");
  if (!covEl) return;

  const headHtml = (subtext) => `
    <div style="padding:12px 14px;background:var(--canvas);border-bottom:1px solid var(--border);font-size:13px;font-weight:700">
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
      <div style="padding:18px;color:var(--amber);font-size:12px;text-align:center">${escapeHtml(hint)}</div>`;
    return;
  }

  const open  = data?.open_shifts       || [];
  const dlExp = data?.dl_expiring       || [];
  const noDot = data?.not_dot_certified || [];

  const openRows = open.length === 0
    ? `<div style="padding:18px;text-align:center;color:var(--green);font-size:12px;font-weight:600">✓ All shifts assigned</div>`
    : open.map(o => {
        const t = o.starts_at ? new Date(o.starts_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "—";
        const svc = o.service_type_code ? `<span style="background:${o.service_type_color || "#94a3b8"}22;color:${o.service_type_color || "#94a3b8"};padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700;margin-left:6px">${escapeHtml(o.service_type_code)}</span>` : "";
        const cushion = o.is_cushion ? `<span style="background:rgba(180,83,9,.15);color:var(--amber);padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700;margin-left:6px">EX</span>` : "";
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 14px;border-top:1px solid var(--border);font-size:13px">
          <div><strong>${escapeHtml(o.station_code || "—")}</strong> · ${escapeHtml(t)} · Wave ${o.wave_index ?? 0}${svc}${cushion}</div>
          <button class="btn btn-sm" onclick="goto('schedule')">Assign</button>
        </div>`;
      }).join("");

  const dlRows = dlExp.length === 0 ? "" :
    `<div style="padding:10px 14px;background:var(--canvas);border-top:1px solid var(--border);font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Driver license expiring soon · ${dlExp.length}</div>`
    + dlExp.map(d => {
        const days = Number(d.days_left);
        const tone = days <= 0 ? "var(--red)" : (days <= 2 ? "var(--amber)" : "var(--text-muted)");
        const label = days < 0 ? `Expired ${-days}d ago` : days === 0 ? "Expires today" : `${days}d left`;
        return `<div style="display:grid;grid-template-columns:1fr auto;gap:10px;padding:8px 14px;border-top:1px solid var(--border);font-size:13px;align-items:center">
          <div data-rr-driver-id="${escapeHtml(d.driver_id)}" style="font-weight:600;cursor:pointer">${escapeHtml(d.driver_name)}</div>
          <span style="color:${tone};font-weight:700;font-size:12px">${escapeHtml(label)}</span>
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
    wrap.innerHTML = `<div style="padding:24px;color:var(--red);font-size:13px">${escapeHtml(error.message)}</div>`;
    return;
  }
  const rows = data?.rows || [];
  if (rows.length === 0) {
    wrap.innerHTML = `<div style="padding:48px;text-align:center;color:var(--text-subtle);font-size:13px">No drivers scheduled for today.</div>`;
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
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 14px">
      <div style="font-size:11px;font-weight:700;color:var(--text-subtle);letter-spacing:.06em;text-transform:uppercase">${escapeHtml(label)}</div>
      <div style="font-size:26px;font-weight:700;margin-top:4px;color:${tone || "var(--text)"}">${escapeHtml(String(value))}</div>
      ${sub ? `<div style="font-size:11px;color:var(--text-subtle);margin-top:2px">${sub}</div>` : ""}
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
        <div class="avatar-sm tier-c" data-rr-driver-id="${escapeHtml(r.driver_id)}">${escapeHtml((r.driver_name || "?").split(/\s+/).map(p => p[0]).filter(Boolean).slice(0,2).join("").toUpperCase())}</div>
        <div style="min-width:0">
          <div style="font-size:13px;font-weight:600;color:var(--text)">${escapeHtml(r.driver_name)}</div>
          <div style="font-size:11px;color:var(--text-subtle)">${escapeHtml(r.station_code || "—")} · ${escapeHtml(t)}${noteBits.length ? " · " + escapeHtml(noteBits.join(" · ")) : ""}</div>
        </div>
        <span style="background:${tone.bg};color:${tone.fg};font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:4px 10px;border-radius:10px">${escapeHtml(label)}</span>
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
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-bottom:14px;overflow:hidden">
        <div style="padding:10px 14px;background:var(--canvas);border-bottom:1px solid var(--border);font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">
          ${escapeHtml(label)} <span style="color:var(--text-subtle);font-weight:600">· ${items.length}</span>
        </div>
        ${items.map(rowHtml).join("")}
      </div>`;
  }).join("");

  const waveLine = Object.keys(byWave).sort()
    .map(w => `Wave ${w}: <strong>${byWave[w]}</strong>`).join(" · ");
  const svcChips = Object.entries(bySvc)
    .map(([code, v]) => `<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:10px;background:${v.color}22;color:${v.color};font-size:11px;font-weight:600;margin-right:4px">${escapeHtml(code)} · ${v.count}</span>`)
    .join("");

  wrap.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">
      ${kpiCard("Scheduled", cnt.total, waveLine || "today")}
      ${kpiCard("Not checked in", Math.max(0, notCheckedInYet), `${cnt.ready} ready · ${cnt.waiting} waiting`, notCheckedInYet > 0 ? "var(--amber)" : undefined)}
      ${kpiCard("Tardy / NCNS", cnt.tardy + cnt.ncns, `${cnt.tardy} tardy · ${cnt.ncns} no-show`, (cnt.tardy + cnt.ncns) > 0 ? "var(--red)" : undefined)}
      ${kpiCard("Working", cnt.working, `${cnt.missed} missed reported`, cnt.working > 0 ? "var(--green)" : undefined)}
    </div>

    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:12px;color:var(--text-muted);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <div>${svcChips || "<span style='color:var(--text-subtle)'>No service-type breakdown</span>"}</div>
      <div style="display:flex;gap:8px;align-items:center">
        <span style="font-size:11px;color:var(--text-subtle)">As of ${escapeHtml(new Date(data.as_of).toLocaleTimeString())}</span>
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


// ─── Drivers · Attendance · History ────────────────────────────────────
async function loadAttendanceHistory(opts) {
  const wrap = document.getElementById("rr-att-history-shell");
  if (!wrap) return;
  const today = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
  const defaultFrom = fmt(new Date(today.getTime() - 30 * 86400000));
  const defaultTo   = fmt(today);
  const fromIso = opts?.from || defaultFrom;
  const toIso   = opts?.to   || defaultTo;

  wrap.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-subtle);font-size:13px">Loading…</div>`;

  const { data, error } = await sb.rpc("attendance_history", { p_from: fromIso, p_to: toIso, p_driver_id: null });
  if (error) {
    wrap.innerHTML = `<div style="padding:24px;color:var(--red);font-size:13px">${escapeHtml(error.message)}</div>`;
    return;
  }
  const summary = data?.summary_by_driver || [];
  const events  = data?.rows || [];

  const sumRows = summary.length === 0
    ? `<div style="padding:18px;text-align:center;color:var(--text-subtle);font-size:13px">No finalized attendance in range.</div>`
    : summary.map(s => `
      <div style="display:grid;grid-template-columns:1fr 60px 60px 60px 60px 60px 70px;gap:8px;padding:10px 14px;border-top:1px solid var(--border);font-size:13px;align-items:center">
        <div style="font-weight:600">${escapeHtml(s.driver_name)}</div>
        <div style="text-align:right;color:var(--green);font-weight:600">${s.present}</div>
        <div style="text-align:right;color:var(--amber);font-weight:600">${s.tardy}</div>
        <div style="text-align:right;color:var(--red);font-weight:600">${s.ncns}</div>
        <div style="text-align:right;color:var(--text-muted)">${s.absent}</div>
        <div style="text-align:right;color:var(--text-muted)">${s.excused}</div>
        <div style="text-align:right;font-weight:700">${s.total}</div>
      </div>`).join("");

  wrap.innerHTML = `
    <div style="display:flex;gap:10px;margin-bottom:14px;align-items:end">
      <div>
        <label style="display:block;font-size:11px;font-weight:600;color:var(--text-subtle);margin-bottom:3px">From</label>
        <input type="date" id="rr-att-hist-from" value="${escapeHtml(fromIso)}" style="padding:8px 10px;border:1px solid var(--border);border-radius:6px"/>
      </div>
      <div>
        <label style="display:block;font-size:11px;font-weight:600;color:var(--text-subtle);margin-bottom:3px">To</label>
        <input type="date" id="rr-att-hist-to" value="${escapeHtml(toIso)}" style="padding:8px 10px;border:1px solid var(--border);border-radius:6px"/>
      </div>
      <button class="btn btn-sm btn-primary" id="rr-att-hist-go">Apply</button>
    </div>

    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:14px">
      <div style="display:grid;grid-template-columns:1fr 60px 60px 60px 60px 60px 70px;gap:8px;padding:10px 14px;background:var(--canvas);font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">
        <div>Driver</div>
        <div style="text-align:right">Present</div>
        <div style="text-align:right">Tardy</div>
        <div style="text-align:right">NCNS</div>
        <div style="text-align:right">Absent</div>
        <div style="text-align:right">Excused</div>
        <div style="text-align:right">Total</div>
      </div>
      ${sumRows}
    </div>

    <div style="font-size:11px;color:var(--text-subtle);margin-bottom:8px">${events.length} finalized event${events.length === 1 ? "" : "s"} · only finalized days appear in the permanent record.</div>
  `;

  document.getElementById("rr-att-hist-go").addEventListener("click", () => {
    loadAttendanceHistory({
      from: document.getElementById("rr-att-hist-from").value,
      to:   document.getElementById("rr-att-hist-to").value,
    });
  });
}


async function loadDriverLicensesView() {
  const body = document.getElementById("lic-renewals-body");
  const status = document.getElementById("lic-panel-status");
  if (!body) return;

  // Wipe synchronously so any mockup-rendered rows can't flash through
  // while the live select is in flight.
  body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-subtle);font-size:13px">Loading…</div>`;
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
    body.innerHTML = `<div style="padding:16px;color:var(--red);font-size:13px">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!rows || rows.length === 0) {
    body.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-subtle);font-size:13px">
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
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">
      <div style="display:grid;grid-template-columns:1fr 110px 110px 130px 90px;gap:12px;padding:10px 16px;background:var(--canvas);font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted)">
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
    pillStyle = "color:#B45309;font-weight:700";
    label = `Expires in ${days}d`;
  }
  const initials = displayDriverInitials(d);
  return `
    <div data-driver-id="${d.id}" data-rr-open-driver style="display:grid;grid-template-columns:1fr 110px 110px 130px 90px;gap:12px;padding:12px 16px;border-top:1px solid var(--border);align-items:center;cursor:pointer">
      <div style="display:flex;align-items:center;gap:10px">
        <div class="avatar-sm tier-c">${initials}</div>
        <div><div style="font-size:13px;font-weight:600">${escapeHtml(displayDriverName(d))}</div></div>
      </div>
      <div style="font-size:13px">${escapeHtml(d.station?.code || "—")}</div>
      <div style="font-size:13px;font-family:'SF Mono',Menlo,monospace">${escapeHtml(d.dl_number || "—")}</div>
      <div style="font-size:13px">${exp.toLocaleDateString()}<div style="font-size:11px;${pillStyle}">${label}</div></div>
      <div><button class="btn btn-sm" data-rr-open-driver data-driver-id="${d.id}">Edit</button></div>
    </div>`;
}

const _legacyDrSub = window.drSub;
window.drSub = function (sub) {
  if (typeof _legacyDrSub === "function") _legacyDrSub(sub);
  if (sub === "licenses")     loadDriverLicensesView();
  if (sub === "roster")       loadDriversRoster();
  if (sub === "attendance")   { loadAttendanceHistory(); _rrInitAttTabDnD(); }
  if (sub === "coaching")     loadCoachingFeed();
  if (sub === "insights")     loadDriverInsights();
  if (sub === "availability") loadAvailabilityRequests();
  _swapDriversCta(sub);
};

// Swap the page-level CTA so it matches the active subnav. On Coaching,
// 'Add driver' becomes 'Coach a driver' and opens a driver picker that
// drops into the coaching log form for the chosen driver.
function _swapDriversCta(sub) {
  const btn = document.getElementById("rr-drivers-cta");
  const lbl = document.getElementById("rr-drivers-cta-label");
  if (!btn || !lbl) return;
  if (sub === "coaching") {
    lbl.textContent = "Coach a driver";
    btn.onclick = (e) => { e.preventDefault(); openCoachDriverPicker(); };
  } else {
    lbl.textContent = "Add driver";
    btn.onclick = () => { if (typeof window.openModal === "function") window.openModal("modal-add-driver"); };
  }
}

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
      <h3 style="margin:0 0 10px;font-size:16px;font-weight:600">Coach a driver</h3>
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
      list.innerHTML = `<div style="padding:18px;text-align:center;color:var(--text-subtle);font-size:13px">No drivers match.</div>`;
      return;
    }
    list.innerHTML = matches.map(d => {
      const display = d.preferred_name || d.full_name || "—";
      const station = d.station?.code || "";
      return `<div class="rr-coach-pick" data-id="${d.id}" style="padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;justify-content:space-between;font-size:13px">
        <span><strong>${escapeHtml(display)}</strong>${station ? ` <span style="color:var(--text-subtle);font-weight:400;margin-left:6px">${escapeHtml(station)}</span>` : ""}</span>
        <span style="color:var(--text-subtle);font-size:11px">Coach →</span>
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

// ─── Drivers · Insights (KPIs + tenure distribution) ───────────────────
// Per-card timeframe selections (days). Persisted per-user in localStorage.
function _diTf(card, fallback) {
  try {
    const v = parseInt(localStorage.getItem("rr.insights.tf." + card) || "", 10);
    if (Number.isFinite(v) && v > 0) return v;
  } catch {}
  return fallback;
}
function _diSetTf(card, days) {
  try { localStorage.setItem("rr.insights.tf." + card, String(days)); } catch {}
}

// Dropdown change → save + re-render. Bound once at document level so we
// don't double-bind across re-renders.
document.addEventListener("change", (e) => {
  const sel = e.target.closest?.("[data-rr-di-tf]");
  if (!sel) return;
  const card = sel.dataset.rrDiTf;
  const days = parseInt(sel.value, 10) || 30;
  _diSetTf(card, days);
  loadDriverInsights();
});

async function loadDriverInsights() {
  const root = document.getElementById("dr-sub-insights");
  if (!root) return;
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;

  // Pull availability data + render the by-day insights into the
  // relocated panel at the bottom of this page.  Cheap re-call —
  // _renderAvailability* short-circuits if the anchor isn't in the
  // DOM, so this is safe to fire even when the operator's parked on
  // another sub-tab.
  loadAvailabilityRequests();
  loadScheduleInsights();

  // Apply persisted timeframe selections to the dropdowns before reading.
  document.querySelectorAll("[data-rr-di-tf]").forEach(sel => {
    const card = sel.dataset.rrDiTf;
    const saved = _diTf(card, parseInt(sel.value, 10) || 30);
    sel.value = String(saved);
  });

  const today = new Date();
  const todayMs = today.getTime();
  const tfTurnover   = _diTf("turnover",   30);
  const tfPast       = _diTf("past",       30);
  const tfAttendance = _diTf("attendance", 30);
  const tfDow        = _diTf("dow",        90);

  // Widest window we need to fetch: max of the per-card windows + a bit
  // of headroom for the prior-period delta on turnover (2× window).
  const fetchDays = Math.max(90, tfTurnover * 2, tfPast, tfAttendance, tfDow);
  const fetchAgoIso = fmtIsoDate(addDays(today, -fetchDays));
  const dowAgoIso   = fmtIsoDate(addDays(today, -tfDow));

  const [allDrvRes, shiftsRes, shifts90Res] = await Promise.all([
    // Note: drivers schema has no terminated_at column. We use updated_at
    // as a rough proxy for "when this driver moved to terminated".
    sb.from("drivers")
      .select("id, status, hire_date, updated_at, score, metadata")
      .eq("dsp_id", dspId),
    sb.from("shifts").select("driver_id, status, date")
      .eq("dsp_id", dspId)
      .gte("date", fetchAgoIso)
      .lte("date", fmtIsoDate(today)),
    sb.from("shifts").select("status, date")
      .eq("dsp_id", dspId)
      .gte("date", dowAgoIso)
      .lte("date", fmtIsoDate(today))
      .in("status", ["completed", "called_off", "no_show", "late", "vto"]),
  ]);

  const ago30Iso = fmtIsoDate(addDays(today, -tfTurnover));
  const ago60Iso = fmtIsoDate(addDays(today, -tfTurnover * 2));

  if (allDrvRes?.error) {
    console.warn("insights load (drivers):", allDrvRes.error);
    return;
  }

  const drivers = (allDrvRes?.data || []);
  const shifts  = (shiftsRes?.data  || []);

  // Active count = active + onboarding (not terminated/inactive/leave).
  const active = drivers.filter(d => d.status === "active" || d.status === "onboarding");
  const totalActive = active.length;

  // Tenure (months since hire_date) for active drivers only.
  const tenureMonths = active
    .filter(d => d.hire_date)
    .map(d => (todayMs - new Date(d.hire_date + "T12:00:00").getTime()) / (1000 * 60 * 60 * 24 * 30.4375));
  tenureMonths.sort((a, b) => a - b);
  const avgTenure = tenureMonths.length
    ? tenureMonths.reduce((s, n) => s + n, 0) / tenureMonths.length
    : 0;
  const medianTenure = tenureMonths.length
    ? tenureMonths[Math.floor(tenureMonths.length / 2)]
    : 0;
  const longestMonths = tenureMonths.length ? tenureMonths[tenureMonths.length - 1] : 0;

  // Turnover — use updated_at as a proxy for termination date since the
  // schema doesn't track it explicitly. Filter by status='terminated'.
  const termsLast30 = drivers.filter(d =>
    d.status === "terminated" && d.updated_at && d.updated_at.slice(0, 10) >= ago30Iso
  ).length;
  const termsPrior30 = drivers.filter(d => {
    if (d.status !== "terminated" || !d.updated_at) return false;
    const dIso = d.updated_at.slice(0, 10);
    return dIso >= ago60Iso && dIso < ago30Iso;
  }).length;
  // Anchor denominator at total roster size (active + recently-terminated).
  const denom = Math.max(1, totalActive + termsLast30);
  const turnover30Pct = (termsLast30 / denom) * 100;
  const turnoverPriorPct = (termsPrior30 / denom) * 100;
  const annualized = turnover30Pct * 12;

  // First-N retention (drivers past N days) — active drivers whose
  // hire_date is at least N days ago. N comes from the per-card timeframe.
  const past30 = active.filter(d => d.hire_date &&
    (todayMs - new Date(d.hire_date + "T12:00:00").getTime()) >= (tfPast * 86400000)).length;
  const past30Pct = totalActive > 0 ? Math.round((past30 / totalActive) * 100) : 0;

  // At-risk = active drivers with score < 75 OR an attendance/safety flag.
  // Attendance flag: 2+ callouts/no-shows in the chosen attendance window.
  const attCutoffIso = fmtIsoDate(addDays(today, -tfAttendance));
  const absencesByDriver = new Map();
  for (const sh of shifts) {
    if (sh.date < attCutoffIso) continue;
    if (sh.status === "called_off" || sh.status === "no_show") {
      absencesByDriver.set(sh.driver_id, (absencesByDriver.get(sh.driver_id) || 0) + 1);
    }
  }
  const atRisk = active.filter(d => {
    const lowScore = (d.score != null) && Number(d.score) < 75;
    const flag = (absencesByDriver.get(d.id) || 0) >= 2;
    return lowScore || flag;
  }).length;

  // Avg fleet score = mean of d.score across active with a value.
  const scored = active.filter(d => d.score != null && Number.isFinite(Number(d.score)));
  const avgScore = scored.length
    ? Math.round(scored.reduce((s, d) => s + Number(d.score), 0) / scored.length)
    : null;

  // Avg attendance over the chosen window: (scheduled - absences) / scheduled.
  let scheduled30 = 0, absent30 = 0;
  for (const sh of shifts) {
    if (!sh.driver_id) continue;
    if (sh.date < attCutoffIso) continue;
    if (["scheduled", "completed", "called_off", "no_show", "late"].includes(sh.status)) scheduled30 += 1;
    if (sh.status === "called_off" || sh.status === "no_show") absent30 += 1;
  }
  const attendancePct = scheduled30 > 0 ? Math.round(((scheduled30 - absent30) / scheduled30) * 100) : null;

  // Tenure buckets (in days).
  const buckets = { "0-30": 0, "30-90": 0, "90-365": 0, "365-730": 0, "730plus": 0 };
  for (const d of active) {
    if (!d.hire_date) continue;
    const days = (todayMs - new Date(d.hire_date + "T12:00:00").getTime()) / 86400000;
    if      (days < 30)       buckets["0-30"]    += 1;
    else if (days < 90)       buckets["30-90"]   += 1;
    else if (days < 365)      buckets["90-365"]  += 1;
    else if (days < 730)      buckets["365-730"] += 1;
    else                      buckets["730plus"] += 1;
  }
  const bucketMax = Math.max(1, ...Object.values(buckets));

  // ─── Apply to DOM ───
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  const setHtml = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  const setVal = (id, text, cls) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    if (cls) el.className = `di-val ${cls}`;
    else el.className = "di-val";
  };

  setVal("rr-di-total", String(totalActive));
  set("rr-di-total-sub", `Active + onboarding`);

  if (tenureMonths.length === 0) {
    setVal("rr-di-tenure", "—");
    set("rr-di-tenure-sub", "Set hire dates to see tenure");
  } else {
    setHtml("rr-di-tenure", `${avgTenure.toFixed(1)}<span class="frac"> mo</span>`);
    set("rr-di-tenure-sub", `Median ${medianTenure.toFixed(0)} mo · longest ${(longestMonths / 12).toFixed(1)} yr`);
  }

  // Insights tiles are intentionally rendered without stoplight
  // colors — operators want a neutral read of the numbers, not a
  // green/amber/red verdict baked into the dashboard.
  setVal("rr-di-turnover-30",
    totalActive === 0 ? "—" : `${turnover30Pct.toFixed(0)}%`);
  const trendDelta = turnover30Pct - turnoverPriorPct;
  set("rr-di-turnover-30-sub",
    termsLast30 + termsPrior30 === 0 ? `No terminations in last ${tfTurnover * 2}d`
    : `${termsLast30} term${termsLast30 === 1 ? "" : "s"} last ${tfTurnover}d · ${trendDelta >= 0 ? "+" : ""}${trendDelta.toFixed(1)}% vs prior ${tfTurnover}d`);

  setVal("rr-di-turnover-annual",
    totalActive === 0 ? "—" : `${Math.round(annualized)}%`);
  set("rr-di-turnover-annual-sub", `Industry avg ~35% · ${annualized < 35 ? "below avg" : "above avg"}`);

  setVal("rr-di-past30",
    totalActive === 0 ? "—" : `${past30}`);
  setHtml("rr-di-past30", `${past30}<span class="frac"> / ${totalActive}</span>`);
  set("rr-di-past30-sub", `First-${tfPast} retention: ${past30Pct}%`);

  setVal("rr-di-atrisk", String(atRisk));

  if (avgScore == null) {
    setVal("rr-di-fleetscore", "—");
    set("rr-di-fleetscore-sub", "No fleet scores recorded yet");
  } else {
    setVal("rr-di-fleetscore", String(avgScore));
    set("rr-di-fleetscore-sub", `Across ${scored.length} scored driver${scored.length === 1 ? "" : "s"}`);
  }

  if (attendancePct == null) {
    setVal("rr-di-attendance", "—");
    set("rr-di-attendance-sub", `No shifts in last ${tfAttendance}d`);
  } else {
    setVal("rr-di-attendance", `${attendancePct}%`);
    set("rr-di-attendance-sub", `${absent30} callouts/no-shows / ${scheduled30} scheduled`);
  }

  // Tenure distribution bars + counts.
  const setBar = (key, count) => {
    const widthPct = Math.round((count / bucketMax) * 100);
    const bar = document.getElementById(`rr-di-bar-${key}`);
    const cnt = document.getElementById(`rr-di-cnt-${key}`);
    if (bar) bar.style.width = `${widthPct}%`;
    if (cnt) cnt.textContent = String(count);
  };
  setBar("0-30",    buckets["0-30"]);
  setBar("30-90",   buckets["30-90"]);
  setBar("90-365",  buckets["90-365"]);
  setBar("365-730", buckets["365-730"]);
  setBar("730plus", buckets["730plus"]);

  // Insight footer.
  const under90 = buckets["0-30"] + buckets["30-90"];
  const under90Pct = totalActive > 0 ? Math.round((under90 / totalActive) * 100) : 0;
  const insightEl = document.getElementById("rr-di-insight");
  if (insightEl) {
    if (totalActive === 0) {
      insightEl.innerHTML = `<strong style="color:var(--text)">Insight:</strong> No active drivers yet — add drivers to see the tenure picture.`;
    } else if (under90Pct >= 30) {
      insightEl.innerHTML = `<strong style="color:var(--text)">Insight:</strong> ${under90Pct}% of your roster is under 90 days. The first-90 cliff is your biggest retention risk — focus coaching here.`;
    } else if (buckets["730plus"] >= Math.ceil(totalActive * 0.25)) {
      insightEl.innerHTML = `<strong style="color:var(--text)">Insight:</strong> ${buckets["730plus"]} of ${totalActive} drivers have 2+ years tenure. Strong retention — protect this group from burnout.`;
    } else {
      insightEl.innerHTML = `<strong style="color:var(--text)">Insight:</strong> Tenure is balanced — no single bucket dominates.`;
    }
  }

  // ─── Day-of-week absence pattern · rolling tfDow window ───
  const shifts90 = shifts90Res?.data || [];
  const DOW = ["mon","tue","wed","thu","fri","sat","sun"];
  const DOW_LABEL = { mon:"Mon", tue:"Tue", wed:"Wed", thu:"Thu", fri:"Fri", sat:"Sat", sun:"Sun" };
  const JS_DOW = { 0:"sun", 1:"mon", 2:"tue", 3:"wed", 4:"thu", 5:"fri", 6:"sat" };

  // Per-day: total = shifts that had any outcome (excludes pure 'scheduled'
  // since we don't know yet); absences = called_off + no_show.
  const dowTotal   = Object.fromEntries(DOW.map(d => [d, 0]));
  const dowAbsent  = Object.fromEntries(DOW.map(d => [d, 0]));
  let totalShifts90 = 0, totalAbsent90 = 0;
  for (const sh of shifts90) {
    const dow = JS_DOW[new Date(sh.date + "T12:00:00").getDay()];
    dowTotal[dow] += 1;
    totalShifts90 += 1;
    if (sh.status === "called_off" || sh.status === "no_show") {
      dowAbsent[dow] += 1;
      totalAbsent90 += 1;
    }
  }
  const overallRate = totalShifts90 > 0 ? (totalAbsent90 / totalShifts90) * 100 : 0;

  const dowBars = document.getElementById("rr-di-dow-bars");
  const dowSummary = document.getElementById("rr-di-dow-summary");
  const dowInsight = document.getElementById("rr-di-dow-insight");

  if (totalShifts90 === 0) {
    if (dowBars) dowBars.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-subtle);font-size:13px">No shift outcomes in the last ${tfDow} days yet.</div>`;
    if (dowSummary) dowSummary.textContent = "";
    if (dowInsight) dowInsight.innerHTML = `Patterns will appear once a few weeks of attendance data flows in.`;
  } else {
    const rates = DOW.map(d => ({
      day: d,
      total: dowTotal[d],
      absent: dowAbsent[d],
      rate: dowTotal[d] > 0 ? (dowAbsent[d] / dowTotal[d]) * 100 : 0,
    }));
    const maxRate = Math.max(1, ...rates.map(r => r.rate));

    if (dowBars) {
      dowBars.innerHTML = rates.map(r => {
        const widthPct = Math.round((r.rate / maxRate) * 100);
        const note = r.total === 0 ? "no shifts" : `${r.absent}/${r.total} absent`;
        return `
        <div style="display:grid;grid-template-columns:60px 1fr 80px 100px;align-items:center;gap:12px;padding:6px 0">
          <div style="font-size:12px;font-weight:600;color:var(--text)">${DOW_LABEL[r.day]}</div>
          <div style="background:var(--canvas);height:14px;border-radius:7px;overflow:hidden">
            <div style="background:${r.total === 0 ? "var(--text-muted)" : "var(--text-muted)"};height:100%;width:${widthPct}%;transition:width .3s"></div>
          </div>
          <div style="font-size:13px;font-weight:600;color:var(--text);font-variant-numeric:tabular-nums">${r.total === 0 ? "—" : r.rate.toFixed(1) + "%"}</div>
          <div style="font-size:11px;color:var(--text-subtle)">${note}</div>
        </div>`;
      }).join("");
    }
    if (dowSummary) {
      dowSummary.textContent = `${totalAbsent90} / ${totalShifts90} shifts (${overallRate.toFixed(1)}% overall) · last ${tfDow}d`;
    }
    if (dowInsight) {
      const sortedDesc = [...rates].filter(r => r.total >= 3).sort((a, b) => b.rate - a.rate);
      const worst = sortedDesc[0];
      const best  = sortedDesc[sortedDesc.length - 1];
      const lines = [];
      if (worst && best && worst.rate > best.rate * 1.5 && worst.rate > 5) {
        lines.push(`<strong style="color:var(--text)">${DOW_LABEL[worst.day]} is your weakest day</strong> — ${worst.rate.toFixed(1)}% absence vs. ${best.rate.toFixed(1)}% on ${DOW_LABEL[best.day]}. ${worst.rate >= overallRate * 1.5 ? "Consider VTO offers earlier in the week, scheduling backups, or coaching repeat offenders." : "Worth a focused look at coaching trends."}`);
      } else if (overallRate < 5 && totalAbsent90 > 0) {
        lines.push(`<strong style="color:var(--text)">No strong day pattern.</strong> Absences are spread across the week and overall rate (${overallRate.toFixed(1)}%) is healthy.`);
      } else if (totalAbsent90 === 0) {
        lines.push(`<strong style="color:var(--text)">Zero callouts or no-shows in the last 90 days.</strong> Whatever you're doing, keep it up.`);
      } else {
        lines.push(`Overall absence rate is ${overallRate.toFixed(1)}%. Days are roughly even — no single day stands out.`);
      }
      dowInsight.innerHTML = lines.join("");
    }
  }

  _dowMath = { dowTotal, dowAbsent, totalShifts90, totalAbsent90, overallRate };
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
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:22px;max-width:520px;width:100%;font-size:13px;line-height:1.55;color:var(--text);max-height:80vh;overflow-y:auto">
      <h3 style="margin:0 0 14px;font-size:17px;font-weight:600">Day-of-week absence · the math</h3>
      <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:.05em;text-transform:uppercase;margin-bottom:6px">Window</div>
      <div>Last <strong>90 days</strong>. Each shift counted once on the day it was scheduled.</div>
      <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:.05em;text-transform:uppercase;margin-top:14px;margin-bottom:6px">Definitions</div>
      <div>· <strong>Total</strong> = shifts that had any outcome (completed, late, called_off, no_show, vto). Pure 'scheduled' (not yet started) is excluded.</div>
      <div>· <strong>Absences</strong> = called_off + no_show only. VTO is operator-approved and doesn't count.</div>
      <div style="font-family:ui-monospace,monospace;font-size:11px;background:var(--canvas);padding:8px 10px;border-radius:4px;color:var(--text);margin-top:8px">% absent = absences ÷ total</div>
      <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:.05em;text-transform:uppercase;margin-top:14px;margin-bottom:6px">By day</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:6px">
        <thead>
          <tr>
            <th style="padding:6px 10px;text-align:left;background:var(--canvas);font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Day</th>
            <th style="padding:6px 10px;text-align:right;background:var(--canvas);font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Total</th>
            <th style="padding:6px 10px;text-align:right;background:var(--canvas);font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Absences</th>
            <th style="padding:6px 10px;text-align:right;background:var(--canvas);font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">% absent</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
      <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:.05em;text-transform:uppercase;margin-top:14px;margin-bottom:6px">Color thresholds</div>
      <div>· <strong style="color:var(--red)">Red</strong> = ≥1.5× the overall rate (and >5%)</div>
      <div>· <strong style="color:var(--amber)">Amber</strong> = ≥1.2× the overall rate</div>
      <div>· <strong style="color:#22c55e">Green</strong> = at or below the overall rate</div>
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

async function refreshDriverStatRow(rows) {
  // Active / onboarding / inactive counts.
  const counts = { active: 0, onboarding: 0, leave: 0, inactive: 0, terminated: 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  const inactiveTotal = (counts.inactive || 0) + (counts.leave || 0) + (counts.terminated || 0);

  // At-risk: drivers with status='active' AND score < 70 (placeholder
  // until the at-risk model lands).
  const atRiskCount = rows.filter(r => r.status === "active" && (r.score ?? 999) < 70).length;

  // Update the stage-tab badges (Active / Onboarding / At risk / Inactive).
  const tabCounts = {
    active:     counts.active,
    onboarding: counts.onboarding,
    atrisk:     atRiskCount,
    inactive:   inactiveTotal,
  };
  Object.entries(tabCounts).forEach(([stage, n]) => {
    const el = document.querySelector(`.dr-subview .stage-tab[data-stage="${stage}"] .stage-tab-count`);
    if (el) el.textContent = n;
  });

  // Coachings in last 7 days.
  const sevenAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const { count: coachedCount } = await sb.from("coachings")
    .select("*", { count: "exact", head: true })
    .eq("dsp_id", window.RR.dsp.id)
    .gte("occurred_at", sevenAgo);

  // Avg score (over rows that have a score).
  const scored = rows.filter(r => r.score != null);
  const avgScore = scored.length === 0
    ? "—"
    : Math.round(scored.reduce((s, r) => s + Number(r.score), 0) / scored.length);

  const tiles = document.querySelectorAll(".driver-stat-row .stat-mini");
  if (tiles.length >= 4) {
    setStatTile(tiles[0], "Active",  counts.active,  `${counts.onboarding} onboarding · ${inactiveTotal} inactive`);
    setStatTile(tiles[1], "Avg score", avgScore,     "Per-driver score, latest");
    setStatTile(tiles[2], "At risk", atRiskCount,    "Active drivers below 70");
    setStatTile(tiles[3], "Coached this week", coachedCount ?? 0, "From the coachings log");
  }
}

function setStatTile(tile, label, value, sub) {
  tile.querySelector(".stat-mini-label").textContent = label;
  const valEl = tile.querySelector(".stat-mini-value");
  valEl.textContent = value;
  // Force the at-risk count to render in the regular text color rather
  // than the legacy mockup amber.  The number itself still tells the
  // story; tinting it orange when there's no risk read like a warning.
  valEl.style.color = "";
  const s = tile.querySelector(".stat-mini-sub");
  if (s) s.textContent = sub;
}

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
  };

  const { data: applicant, error } = await sb.rpc("intake_applicant", { p_payload: payload });
  if (error) { toast("Add failed: " + error.message, "warn"); return; }

  if ((applicant.phone || applicant.email) && applicant.status === "applied") {
    await sb.rpc("send_screening_link", { p_id: applicant.id });
  }

  closeModal("modal-add-applicant");
  await loadPipeline("all");
  toast(`${applicant.full_name} added · screening invite queued`, "success");
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
};

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
  renderIndeedRecommendation(funnel);
}

// Latest math breakdown for the (i) info popover.
let _indeedMath = null;

async function renderIndeedRecommendation(funnel) {
  const card = document.getElementById("rr-indeed-card");
  if (!card) return;
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;

  const setStatus = (text, color) => {
    const el = document.getElementById("rr-indeed-status");
    if (el) { el.textContent = text; el.style.color = color || "var(--text)"; }
  };
  const setAction = (html) => {
    const el = document.getElementById("rr-indeed-action");
    if (el) el.innerHTML = html;
  };

  // Pull current driver state, terminations in last 30d, OKAMI demand for
  // the next 8 weeks, and the live applicant pool.
  const today = new Date();
  const ago30Iso = fmtIsoDate(addDays(today, -30));
  const monday = startOfWeekMonday(today);
  const startIso = fmtIsoDate(monday);

  const [drvRes, termsRes, gridRes, countsRes] = await Promise.all([
    sb.from("drivers").select("id", { count: "exact", head: true })
      .eq("dsp_id", dspId).in("status", ["active", "onboarding"]),
    sb.from("drivers").select("id", { count: "exact", head: true })
      .eq("dsp_id", dspId).eq("status", "terminated").gte("updated_at", ago30Iso),
    sb.rpc("okami_grid", { p_start: startIso, p_weeks: 8 }),
    sb.rpc("pipeline_counts"),
  ]);

  const currentDrivers = drvRes?.count || 0;
  const terms30        = termsRes?.count || 0;
  const cells          = gridRes?.data || [];
  const counts         = countsRes?.data || [];

  // Weekly attrition rate from monthly turnover.
  const monthlyRate = currentDrivers > 0 ? (terms30 / (currentDrivers + terms30)) : 0;
  const weeklyRate  = 1 - Math.pow(1 - monthlyRate, 1 / 4.33);
  const horizonWk   = 8;

  // Project supply 8 weeks out + find peak demand (Routes(max) × 2 × pad).
  const padPct = Math.max(0, Math.min(50, Number(window.RR?.dsp?.metadata?.staffing?.plan_pad_pct ?? 10) || 0));
  const totalsByDate = new Map();
  for (const c of cells) totalsByDate.set(c.date, (totalsByDate.get(c.date) || 0) + (c.target_routes || 0));

  let peakNeeded = 0;
  for (let w = 0; w < horizonWk; w++) {
    const wkStart = addDays(monday, w * 7);
    let routesMax = 0;
    for (let d = 0; d < 7; d++) {
      const t = totalsByDate.get(fmtIsoDate(addDays(wkStart, d))) || 0;
      if (t > routesMax) routesMax = t;
    }
    const needed = routesMax > 0 ? Math.ceil(routesMax * 2 * (1 + padPct / 100)) : 0;
    if (needed > peakNeeded) peakNeeded = needed;
  }
  const endAvailable = Math.round(currentDrivers * Math.pow(1 - weeklyRate, horizonWk));
  const driversToHire = Math.max(0, peakNeeded - endAvailable);

  // End-to-end conversion comes from the funnel KPI; default to 8% so
  // the card shows something reasonable while history is thin.
  const e2eRaw = Number(funnel?.e2e_pct ?? 0);
  const e2eFraction = e2eRaw > 0 ? e2eRaw / 100 : 0.08;
  const e2eIsEstimate = !(e2eRaw > 0);

  const targetApplicants = driversToHire > 0 ? Math.ceil(driversToHire / e2eFraction) : 0;

  // Current applicants = the 'all' row from pipeline_counts (excludes closed).
  const currentPipeline = Number((counts.find(c => c.stage === "all") || {}).count || 0);

  const ratio = targetApplicants > 0 ? (currentPipeline / targetApplicants) : Infinity;

  // Status / action.
  let status = "Hold", color = "var(--green)", action = "";
  if (driversToHire === 0 && currentDrivers > 0) {
    status = "Hold";
    color  = "var(--green)";
    action = `On track — no hires needed in the next ${horizonWk} weeks. Roster of ${currentDrivers} covers projected peak demand of ${peakNeeded} drivers.`;
  } else if (currentPipeline === 0 && driversToHire > 0) {
    status = "Critical";
    color  = "var(--red)";
    action = `Urgent — need ~${targetApplicants} applicants to hit ${driversToHire} hires by week ${horizonWk}. Pipeline is empty. Open Indeed spend now.`;
  } else if (ratio === Infinity) {
    status = "Hold";
    color  = "var(--text-muted)";
    action = `No hires needed and pipeline is empty. No action.`;
  } else if (ratio > 1.2) {
    const surplus = currentPipeline - targetApplicants;
    status = "Pause";
    color  = "var(--text-muted)";
    action = `Pause Indeed spend — pipeline has <strong>${currentPipeline}</strong> applicants vs target of <strong>${targetApplicants}</strong>. Surplus of ~${surplus}.`;
  } else if (ratio >= 0.8) {
    status = "Hold";
    color  = "var(--green)";
    action = `On track — pipeline of <strong>${currentPipeline}</strong> covers the target of <strong>${targetApplicants}</strong>.`;
  } else if (ratio >= 0.5) {
    const short = targetApplicants - currentPipeline;
    status = "Boost";
    color  = "var(--amber)";
    action = `Boost Indeed spend — short by <strong>~${short}</strong> applicants. Have ${currentPipeline}, need ${targetApplicants} for ${driversToHire} hires by week ${horizonWk}.`;
  } else {
    const short = targetApplicants - currentPipeline;
    status = "Critical";
    color  = "var(--red)";
    action = `Urgent — pipeline at <strong>${currentPipeline}</strong>, target <strong>${targetApplicants}</strong>. Gap of ${short} applicants. Increase Indeed spend immediately.`;
  }

  setStatus(status, color);
  setAction(action);

  _indeedMath = {
    horizonWk,
    currentDrivers,
    terms30,
    monthlyRate: monthlyRate * 100,
    weeklyRate: weeklyRate * 100,
    peakNeeded,
    padPct,
    endAvailable,
    driversToHire,
    e2ePct: e2eFraction * 100,
    e2eIsEstimate,
    currentPipeline,
    targetApplicants,
    ratio: ratio === Infinity ? null : ratio * 100,
  };
}

// (i) info icon → popover with the math.
document.addEventListener("click", (e) => {
  if (!e.target.closest("#rr-indeed-info")) return;
  e.preventDefault();
  const m = _indeedMath;
  if (!m) return;
  const old = document.getElementById("rr-indeed-popover");
  if (old) { old.remove(); return; }
  const pop = document.createElement("div");
  pop.id = "rr-indeed-popover";
  pop.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px";
  pop.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:22px;max-width:520px;width:100%;font-size:13px;line-height:1.55;color:var(--text)">
      <h3 style="margin:0 0 14px;font-size:17px;font-weight:600">Indeed recommendation · the math</h3>

      <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:.05em;text-transform:uppercase;margin-top:14px;margin-bottom:6px">Demand (next ${m.horizonWk} weeks)</div>
      <div>Peak drivers needed: <strong>${m.peakNeeded}</strong> <span style="color:var(--text-subtle)">(Routes(max) × 2 × ${m.padPct}% pad)</span></div>

      <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:.05em;text-transform:uppercase;margin-top:14px;margin-bottom:6px">Supply (with attrition)</div>
      <div>Current roster: <strong>${m.currentDrivers}</strong> active+onboarding</div>
      <div>30-day turnover: <strong>${m.monthlyRate.toFixed(1)}%</strong> <span style="color:var(--text-subtle)">(${m.terms30} terms last 30d)</span></div>
      <div>Weekly attrition: <strong>${m.weeklyRate.toFixed(2)}%</strong></div>
      <div>Available end of week ${m.horizonWk}: <strong>${m.endAvailable}</strong> <span style="color:var(--text-subtle)">(roster × (1 − weekly)<sup>${m.horizonWk}</sup>)</span></div>

      <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:.05em;text-transform:uppercase;margin-top:14px;margin-bottom:6px">Hires needed</div>
      <div>Drivers to hire: <strong>${m.driversToHire}</strong> <span style="color:var(--text-subtle)">(peak − end-of-horizon supply)</span></div>

      <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:.05em;text-transform:uppercase;margin-top:14px;margin-bottom:6px">Pipeline target</div>
      <div>End-to-end conversion: <strong>${m.e2ePct.toFixed(1)}%</strong>${m.e2eIsEstimate ? ' <span style="color:var(--amber);font-size:11px">· estimate, no history yet</span>' : ""}</div>
      <div>Target applicants: <strong>${m.targetApplicants}</strong> <span style="color:var(--text-subtle)">(hires ÷ conversion)</span></div>
      <div>Current pipeline: <strong>${m.currentPipeline}</strong> open applicants</div>
      <div>Coverage: <strong>${m.ratio == null ? "—" : Math.round(m.ratio) + "%"}</strong></div>

      <div style="margin-top:18px;display:flex;justify-content:flex-end">
        <button class="btn btn-sm" type="button" id="rr-indeed-popover-close">Close</button>
      </div>
    </div>`;
  pop.addEventListener("click", (ev) => {
    if (ev.target === pop || ev.target.id === "rr-indeed-popover-close") pop.remove();
  });
  document.body.appendChild(pop);
});

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

  // Build placeholders first so the strip never shows mockup data while
  // the live query is in flight.
  const placeholderWeeks = Array.from({ length: 5 }, (_, i) => isoWeek(addDays(monday, i * 7)));
  strip.innerHTML = `<span class="hp-weeks-strip-label">Next 5 wk</span>` +
    placeholderWeeks.map(n => `<span class="hp-week-cell"><span class="wk">W${n}</span> <span style="color:var(--text-subtle)">— / —</span></span>`).join("");

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
      out.push(`<span class="hp-week-cell"><span class="wk">${wkLabel}</span> <span style="color:var(--text-subtle)">set OKAMI</span></span>`);
      continue;
    }
    // OKAMI is exact demand now (post migration 0039); cushion is a
    // separate operator tool. needed = peak routes × DPR.
    const needed = Math.round(routesMax * dpr);
    const gap = available - needed;
    const gapClass = gap >= 0 ? "ok" : (gap >= -10 ? "tight" : "short");
    const gapText = (gap >= 0 ? "+" : "") + gap;
    out.push(`<span class="hp-week-cell"><span class="wk">${wkLabel}</span> ${available} / ${needed} <span class="gap ${gapClass}">${gapText}</span></span>`);
  }

  strip.innerHTML = `<span class="hp-weeks-strip-label">Next 5 wk</span>${out.join("")}`;
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

  // Pull all interview cal_events from yesterday onward to map out the
  // dates that have bookings. Used both for choosing the default date
  // and for prev/next navigation.
  const { data: events } = await sb.from("cal_events")
    .select("starts_at")
    .eq("dsp_id", window.RR.dsp.id)
    .eq("kind", "interview")
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
      <div style="padding:48px;text-align:center;color:var(--text-subtle);font-size:13px;background:var(--surface);border:1px solid var(--border);border-radius:12px">
        <strong style="color:var(--text-muted);display:block;margin-bottom:4px">No interviews booked for ${day.date}</strong>
        When applicants book via Cal.com, they'll show up here.
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
    closeBtn.style.cssText = "margin-top:14px;font-size:12px;color:var(--text-subtle);background:transparent;border:1px solid var(--border)";
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
      <div style="font-size:13px;font-weight:600">${label}</div>
      <div style="font-size:11px;color:var(--text-subtle);margin-top:2px">${relative}${day.closed_at ? " · day closed" : ""}</div>
    </div>
    <div style="display:flex;gap:6px">
      <button class="btn btn-sm" data-rr-iv-prev ${prev ? "" : "disabled"} style="font-size:11px">← Prev day</button>
      <button class="btn btn-sm" data-rr-iv-today style="font-size:11px">Today</button>
      <button class="btn btn-sm" data-rr-iv-next ${next ? "" : "disabled"} style="font-size:11px">Next day →</button>
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
    hired:   "background:rgba(22,163,74,.12);color:#16A34A",
    no_hire: "background:rgba(220,38,38,.12);color:#DC2626",
    no_show: "background:rgba(245,158,11,.18);color:#B45309",
  };
  const badge = outcome
    ? `<span class="iv-card-source" style="${sourceColors[outcome]}">${outcome.replace("_"," ")}</span>`
    : `<span class="iv-card-source" style="background:var(--accent-soft);color:var(--accent-text)">${r.source ?? "Indeed"}</span>`;

  const tags = [];
  if (r.video_url) tags.push(
    `<span class="iv-card-tag" data-rr-play-video data-video-url="${encodeURI(r.video_url)}" style="cursor:pointer">▶ Watch intro</span>`
  );

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
    // After close, jump forward to the next future day with bookings (or
    // today if there isn't one) so the closed day stops monopolizing the view.
    const today = localDate(new Date());
    const futureBookings = _ivDatesWithBookings.filter(d => d > _ivDate);
    _ivDate = futureBookings[0] || today;
    _ivDayId = null;
    await loadInterviewDay();
    await loadPipelineKpis();
    await loadPipeline(getActiveStage());
  }
}, true);

// Hook pipeSub so switching to a tab kicks off the right load.
const _legacyPipeSub = window.pipeSub;
window.pipeSub = function (sub) {
  if (typeof _legacyPipeSub === "function") _legacyPipeSub(sub);
  if (sub === "interview") loadInterviewDay();
  if (sub === "calendar")  loadCalendarTab();
  if (sub === "referrals") loadReferralsTab();
  if (sub === "screening") loadScreeningQuestionsList();
  if (sub === "messages")  loadMessagesTab();
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
    masterEl.textContent = `${baseUrl}/dashboard/refer.html?r=<driver-token>`;
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
    list.innerHTML = `<div style="padding:16px;color:var(--red);font-size:12px">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!rows || rows.length === 0) {
    list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-subtle);font-size:12px"><strong style="color:var(--text-muted);display:block;margin-bottom:4px">No referrals yet</strong>Send drivers their links and the leaderboard fills in.</div>`;
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
  card.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-subtle);font-size:13px">Loading availability…</div>`;
  if (meta) meta.textContent = "";

  // Call the edge function. JWT-gated → uses the user's session.
  const { data, error } = await sb.functions.invoke("cal-availability", {
    method: "GET",
  });

  if (error || data?.error) {
    const msg = error?.message || data?.error || "Couldn't load availability";
    card.innerHTML = `
      <div style="padding:24px">
        <div style="font-size:13px;color:var(--red);font-weight:600;margin-bottom:8px">Couldn't load availability</div>
        <div style="font-size:12px;color:var(--text-subtle);line-height:1.5">${escapeHtml(msg)}</div>
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
    <div class="cal-edit-section" style="background:var(--canvas);padding:12px 14px;border-radius:8px;margin-bottom:14px">
      <div class="cal-edit-label" style="margin-bottom:6px">Current availability</div>
      <div style="font-size:13px;line-height:1.5">${summaryHtml}</div>
      <div style="font-size:11px;color:var(--text-subtle);margin-top:6px">Time zone: ${escapeHtml(tz)}</div>
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
  // Re-render the editor so the "Current availability" banner reflects
  // the just-saved state. Also reloads bookings in case the new tz
  // shifted any visible times.
  await Promise.all([loadCalBookingsList(), loadCalAvailabilityEditor()]);
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
  list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-subtle);font-size:13px">Loading…</div>`;

  const { data: rows, error } = await sb.from("cal_events")
    .select("id, applicant_id, kind, status, starts_at, ends_at, meeting_url, location, applicants:applicant_id (full_name, email, phone)")
    .eq("dsp_id", window.RR.dsp.id)
    .gte("starts_at", new Date(Date.now() - 1000 * 60 * 60 * 12).toISOString())
    .in("status", ["scheduled", "rescheduled"])
    .order("starts_at", { ascending: true })
    .limit(100);

  if (error) {
    list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--red);font-size:13px">Couldn't load bookings: ${error.message}</div>`;
    return;
  }
  if (!rows || rows.length === 0) {
    list.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-subtle);font-size:13px"><strong style="color:var(--text-muted);display:block;margin-bottom:4px">No upcoming bookings</strong>Once applicants book a slot, their interview will land here.</div>`;
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
    html.push(`<div style="padding:10px 16px;background:var(--canvas);font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted);border-top:1px solid var(--border)">${date}</div>`);
    for (const r of items) {
      const start = new Date(r.starts_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const end = r.ends_at ? new Date(r.ends_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
      const a = r.applicants || {};
      const kindBadge = r.kind === "orientation"
        ? `<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:5px;background:rgba(124,58,237,.12);color:#7C3AED;letter-spacing:.04em;text-transform:uppercase">Orientation</span>`
        : `<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:5px;background:var(--accent-soft);color:var(--accent-text);letter-spacing:.04em;text-transform:uppercase">Interview</span>`;
      const statusBadge = r.status === "rescheduled"
        ? `<span style="font-size:10px;font-weight:600;color:#B45309;margin-left:6px">rescheduled</span>`
        : "";

      html.push(`
        <div style="display:grid;grid-template-columns:90px 1fr auto;gap:14px;align-items:center;padding:14px 16px;border-top:1px solid var(--border)">
          <div style="font-variant-numeric:tabular-nums;font-size:13px;font-weight:600">${start}<div style="font-size:11px;color:var(--text-subtle);font-weight:400">${end}</div></div>
          <div>
            <div style="font-size:13px;font-weight:600;margin-bottom:2px">${escapeHtml(a.full_name || "Unknown")}</div>
            <div style="font-size:11px;color:var(--text-subtle)">${[a.phone, a.email].filter(Boolean).join(" · ") || "no contact on file"}</div>
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
  // Now lives inside the Pipeline → Screening subtab. Containers are
  // pre-rendered in the static HTML; we just fill the row list.
  const subview = document.getElementById("pipe-sub-screening");
  if (!subview) return;
  // Also rehydrate the video settings card.
  loadVideoScreeningSettings();
  const container = subview.querySelector("[data-rr-questions]");
  if (!container) return;

  const { data: rows, error } = await sb.from("screening_questions")
    .select("id, prompt, field_type, options, required, hard_filter, scoring, display_order, active")
    .eq("dsp_id", window.RR.dsp.id)
    .order("display_order", { ascending: true });
  if (error) {
    container.innerHTML = `<div style="padding:16px;color:var(--red);font-size:12px">${escapeHtml(error.message)}</div>`;
    return;
  }

  const sub = document.getElementById("rr-screening-sub");
  if (sub) sub.textContent = `${(rows ?? []).length} questions · sent to applicants via SMS or email.`;

  if (!rows || rows.length === 0) {
    container.innerHTML = `<div style="padding:16px;color:var(--text-subtle);font-size:13px">No questions yet — click + Add question to start.</div>`;
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
        <h3 style="margin:0;font-size:17px;font-weight:600">${isEdit ? "Edit question" : "Add question"}</h3>
        <button data-rr-q-cancel style="background:none;border:0;font-size:20px;cursor:pointer;color:var(--text-muted)">×</button>
      </div>
      <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Prompt</label>
      <textarea data-rr-q-prompt class="form-input" style="width:100%;min-height:60px;margin-bottom:14px">${escapeHtml(q.prompt)}</textarea>
      <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Type</label>
      <select data-rr-q-type class="form-input" style="width:100%;margin-bottom:14px">
        ${["yes_no","single","multi","text","number","date"].map(v => `<option value="${v}" ${q.field_type === v ? "selected" : ""}>${v}</option>`).join("")}
      </select>
      <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Options (one per line — only for single / multi)</label>
      <textarea data-rr-q-options class="form-input" style="width:100%;min-height:70px;margin-bottom:14px;font-family:monospace">${(q.options || []).join("\n")}</textarea>
      <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Auto-decline if answer equals (leave blank for none)</label>
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
let _ddTab = "overview";

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
      #rr-cd-drawer .cd-sub{font-size:12px;color:var(--text-subtle);margin-top:2px}
      #rr-cd-drawer .cd-eyebrow{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px}
      #rr-cd-drawer .cd-close{background:transparent;border:0;font-size:24px;color:var(--text-subtle);cursor:pointer;line-height:1;padding:0}
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
      <div class="cd-body" id="rr-cd-body"><div style="padding:32px;text-align:center;color:var(--text-subtle)">Loading…</div></div>
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
  const sevColor = (s) => ({info:"#475569", concern:"#1d4ed8", warning:"#b45309", final:"#dc2626"}[s] || "#475569");
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
  html,body{margin:0;background:#f5f5f5;color:#0f172a;font-family:Inter,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:13px;line-height:1.55}
  .toolbar{position:sticky;top:0;background:#0f172a;color:#fff;padding:10px 18px;display:flex;align-items:center;justify-content:space-between;font-size:12px;z-index:5}
  .toolbar button{background:#fff;color:#0f172a;border:0;border-radius:6px;font:inherit;font-weight:600;padding:6px 12px;cursor:pointer}
  .page{max-width:780px;margin:18px auto 80px;background:#fff;padding:34px 44px;box-shadow:0 1px 4px rgba(0,0,0,.08);border-radius:6px}
  header{border-bottom:2px solid #0f172a;padding-bottom:14px;margin-bottom:18px}
  .brand{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#475569}
  h1{margin:4px 0 2px;font-size:24px;letter-spacing:-.01em}
  .meta-line{font-size:12px;color:#475569}
  .totals{display:flex;gap:14px;flex-wrap:wrap;margin:14px 0 0;font-size:12px;color:#475569}
  .totals strong{color:#0f172a;font-weight:700}
  .rec{padding:18px 0;border-bottom:1px solid #e2e8f0;page-break-inside:avoid;break-inside:avoid}
  .rec:last-child{border-bottom:0}
  .rec-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
  .sev{display:inline-block;color:#fff;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:3px 9px;border-radius:10px;margin-right:8px}
  .rec-num{font-size:11px;color:#94a3b8}
  .rec-occurred{font-size:12px;color:#475569;font-variant-numeric:tabular-nums}
  .rec-meta{display:grid;grid-template-columns:repeat(2,1fr);gap:6px 18px;margin-bottom:10px}
  .rec-meta>div{display:flex;gap:8px;font-size:12px}
  .lbl{display:inline-block;min-width:120px;color:#94a3b8;font-weight:600;font-size:11px;letter-spacing:.04em;text-transform:uppercase}
  .rec-summary{font-size:15px;font-weight:600;line-height:1.4;margin:6px 0}
  .rec-notes{white-space:pre-wrap;color:#334155;background:#f8fafc;padding:10px 12px;border-left:3px solid #cbd5e1;border-radius:3px;margin:8px 0}
  .rec-fields>div{display:flex;gap:8px;font-size:12px;margin-bottom:4px}
  .hr-only{color:#dc2626;font-weight:700}
  .sig{margin-top:12px;border:1px solid #e2e8f0;padding:10px 12px;border-radius:4px;background:#fafafa}
  .sig-label{font-size:10px;font-weight:600;color:#94a3b8;letter-spacing:.05em;text-transform:uppercase;margin-bottom:6px}
  .sig img{max-width:300px;max-height:120px;display:block}
  .audit{margin-top:10px}
  .audit summary{cursor:pointer;font-size:11px;color:#475569;font-weight:600}
  .audit table{width:100%;border-collapse:collapse;font-size:11px;margin-top:8px}
  .audit th,.audit td{text-align:left;padding:5px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top}
  .audit th{background:#f8fafc;color:#475569;font-weight:600}
  .empty{padding:60px 0;text-align:center;color:#94a3b8;font-size:13px}
  footer{margin-top:30px;padding-top:14px;border-top:1px solid #e2e8f0;font-size:10px;color:#94a3b8;line-height:1.5}
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

async function openDriverDrawer(driverId) {
  let drawer = document.getElementById("rr-dd-drawer");
  if (drawer) drawer.remove();
  drawer = document.createElement("div");
  drawer.id = "rr-dd-drawer";
  drawer.innerHTML = `
    <style>
      #rr-dd-drawer{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;justify-content:flex-end}
      #rr-dd-panel{width:560px;max-width:100%;background:var(--surface);height:100%;overflow-y:auto;border-left:1px solid var(--border);display:flex;flex-direction:column}
      .dd-head{padding:18px 22px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
      .dd-head h3{margin:0;font-size:18px;font-weight:600}
      .dd-head .sub{font-size:12px;color:var(--text-subtle);margin-top:2px}
      .dd-tabs{display:flex;gap:2px;background:var(--canvas);padding:3px;border-radius:8px;margin:14px 22px 0}
      .dd-tab{flex:1;background:transparent;border:0;font:inherit;font-size:12px;font-weight:600;color:var(--text-subtle);padding:8px 12px;border-radius:6px;cursor:pointer}
      .dd-tab.active{background:var(--surface);color:var(--text);box-shadow:var(--shadow-sm)}
      .dd-body{padding:18px 22px;flex:1}
      .dd-row{display:grid;grid-template-columns:160px 1fr;gap:12px;align-items:center;padding:8px 0;border-top:1px solid var(--border)}
      .dd-row:first-of-type{border-top:0}
      .dd-row label{font-size:12px;color:var(--text-muted);font-weight:500}
      .dd-row input,.dd-row select,.dd-row textarea{width:100%;background:var(--canvas);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font:inherit;font-size:13px;color:var(--text)}
      .dd-row input:focus,.dd-row select:focus,.dd-row textarea:focus{outline:none;border-color:var(--accent)}
      .dd-foot{padding:14px 22px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;background:var(--surface);position:sticky;bottom:0}
      .dd-list-row{display:grid;grid-template-columns:1fr auto;gap:12px;padding:12px 0;border-top:1px solid var(--border)}
      .dd-list-row:first-of-type{border-top:0}
      .dd-list-title{font-size:13px;font-weight:600}
      .dd-list-sub{font-size:11px;color:var(--text-subtle);margin-top:2px}
    </style>
    <div id="rr-dd-panel">
      <div class="dd-head">
        <div style="display:flex;align-items:center;gap:14px;min-width:0">
          <div class="avatar-sm" id="rr-dd-avatar" data-rr-driver-id="" style="width:44px;height:44px;font-size:15px;flex-shrink:0">--</div>
          <div style="min-width:0">
            <h3 id="rr-dd-title">Driver record</h3>
            <div class="sub" id="rr-dd-sub"></div>
          </div>
        </div>
        <button id="rr-dd-close" style="background:none;border:0;font-size:22px;cursor:pointer;color:var(--text-muted);padding:0 6px">×</button>
      </div>
      <div class="dd-tabs" data-rr-tabbar="dd-tabs">
        <button class="dd-tab active" data-rr-dd-tab="overview">Overview</button>
        <button class="dd-tab" data-rr-dd-tab="availability">Availability</button>
        <button class="dd-tab" data-rr-dd-tab="license">License</button>
        <button class="dd-tab" data-rr-dd-tab="dot">DOT</button>
        <button class="dd-tab" data-rr-dd-tab="documents">Documents</button>
      </div>
      <div class="dd-body" id="rr-dd-body"><div style="padding:32px;text-align:center;color:var(--text-subtle)">Loading…</div></div>
      <div class="dd-foot" id="rr-dd-foot"></div>
    </div>`;
  document.body.appendChild(drawer);

  drawer.addEventListener("click", (e) => {
    if (e.target === drawer || e.target.id === "rr-dd-close" || e.target.closest("[data-rr-dd-close]")) drawer.remove();
  });

  _ddTab = "overview";
  if (driverId) {
    await loadDriverDrawer(driverId);
  } else {
    // CREATE mode — empty placeholders, no fetch.
    _ddDriver = { driver: { id: null, status: "onboarding", hire_date: fmtIsoDate(new Date()) }, coachings: [], documents: [] };
    document.getElementById("rr-dd-title").textContent = "Add driver";
    document.getElementById("rr-dd-sub").textContent = "New record";
    // License / Coaching / Documents tabs need an existing driver — disable.
    drawer.querySelectorAll(".dd-tab").forEach(t => {
      const k = t.getAttribute("data-rr-dd-tab");
      if (k !== "overview") { t.disabled = true; t.style.opacity = "0.4"; t.style.cursor = "not-allowed"; }
    });
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

function renderDriverDrawerTab() {
  document.querySelectorAll("#rr-dd-drawer .dd-tab").forEach(t => {
    t.classList.toggle("active", t.getAttribute("data-rr-dd-tab") === _ddTab);
  });
  const body = document.getElementById("rr-dd-body");
  if (_ddTab === "overview")     renderOverviewForm(body, _ddDriver.driver);
  if (_ddTab === "availability") renderAvailabilityTab(body, _ddDriver.driver);
  if (_ddTab === "license")      renderLicenseTab(body, _ddDriver.driver);
  if (_ddTab === "dot")          renderDotTab(body, _ddDriver.driver);
  if (_ddTab === "coaching")     body.innerHTML = renderCoachingTab(_ddDriver.coachings, _ddDriver.driver);
  if (_ddTab === "documents")    body.innerHTML = renderDocumentsTab(_ddDriver.documents);
  setDriverDrawerFoot();
}

function setDriverDrawerFoot() {
  const foot = document.getElementById("rr-dd-foot");
  if (!foot) return;
  if (_ddTab === "overview" || _ddTab === "license" || _ddTab === "dot") {
    foot.innerHTML = `<button class="btn btn-primary" data-rr-dd-save>Save record</button>`;
  } else if (_ddTab === "availability") {
    foot.innerHTML = `<button class="btn btn-primary" data-rr-avail-save>Save availability</button>`;
  } else {
    // Coaching / Documents add items inline; offer just a Close in the foot
    // so the layout is identical across tabs.
    foot.innerHTML = `<button class="btn" data-rr-dd-close>Close</button>`;
  }
}

function renderAvailabilityTab(body, d) {
  const meta = d.metadata || {};
  const avail = meta.availability || {};
  const days = avail.days || [];
  const isAvail = (k) => days.includes(k);
  const dayKey = ["mon","tue","wed","thu","fri","sat","sun"];
  const dayLabel = { mon:"Mon", tue:"Tue", wed:"Wed", thu:"Thu", fri:"Fri", sat:"Sat", sun:"Sun" };
  const availBoxes = dayKey.map(k => `
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;cursor:pointer;background:var(--canvas);user-select:none">
      <input type="checkbox" data-rr-avail-day="${k}" ${isAvail(k) ? "checked" : ""}/>
      <span style="font-weight:600">${dayLabel[k]}</span>
    </label>`).join("");
  body.innerHTML = `
    <div class="dd-row" style="grid-template-columns:160px 1fr;align-items:flex-start">
      <label>Available days</label>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">${availBoxes}</div>
    </div>`;
}

async function renderOverviewForm(body, d) {
  const showPronouns = window.RR.dsp?.metadata?.drivers?.show_pronouns !== false;
  const v = (s) => escapeHtml(s ?? "");
  const stations = await getDriverStationsCached();
  const stationOptions = `<option value="">— No station —</option>` +
    stations.map(s => `<option value="${s.id}" ${s.id === d.station_id ? "selected" : ""}>${escapeHtml(s.code)}${s.name ? ` · ${escapeHtml(s.name)}` : ""}</option>`).join("");
  const payRate = d.metadata?.pay?.hourly_rate ?? "";
  body.innerHTML = `
    <div class="dd-row"><label>Full name</label><input data-rr-dd-field="full_name" data-rr-capitalize autocapitalize="words" value="${v(d.full_name)}"/></div>
    <div class="dd-row"><label>Preferred name</label><input data-rr-dd-field="preferred_name" data-rr-capitalize autocapitalize="words" value="${v(d.preferred_name)}"/></div>
    ${showPronouns ? `<div class="dd-row"><label>Pronouns</label><input data-rr-dd-field="pronouns" placeholder="he/him · she/her · they/them" value="${v(d.pronouns)}"/></div>` : ""}
    <div class="dd-row"><label>Phone</label><input data-rr-dd-field="phone" value="${v(d.phone)}"/></div>
    <div class="dd-row"><label>Email</label><input data-rr-dd-field="email" value="${v(d.email)}"/></div>
    <div class="dd-row"><label>Address</label><input data-rr-dd-field="address" value="${v(d.address)}"/></div>
    <div class="dd-row"><label>Birthday</label><input type="date" data-rr-dd-field="birthday" value="${v(d.birthday)}"/></div>
    <div class="dd-row"><label>Station</label>
      <select data-rr-dd-field="station_id">${stationOptions}</select>
    </div>
    <div class="dd-row"><label>Hire date</label><input type="date" data-rr-dd-field="hire_date" value="${v(d.hire_date)}"/></div>
    <div class="dd-row"><label>Status</label>
      <select data-rr-dd-field="status">
        ${["onboarding","active","leave","inactive","terminated"].map(s => `<option value="${s}" ${s === d.status ? "selected" : ""}>${s}</option>`).join("")}
      </select>
    </div>
    <div class="dd-row"><label>Pay rate</label>
      <div style="display:flex;align-items:center;gap:6px">
        <span style="color:var(--text-subtle)">$</span>
        <input type="number" min="0" max="200" step="0.01" data-rr-dd-field="pay_hourly" placeholder="22.50" value="${v(payRate)}" style="max-width:120px"/>
        <span style="color:var(--text-subtle);font-size:12px">/ hour</span>
      </div>
    </div>
    <div class="dd-row"><label>Emergency contact</label><input data-rr-dd-field="emergency_contact_name" placeholder="Name" value="${v(d.emergency_contact_name)}"/></div>
    <div class="dd-row"><label>Emergency phone</label><input data-rr-dd-field="emergency_contact_phone" placeholder="Phone" value="${v(d.emergency_contact_phone)}"/></div>
    <div class="dd-row"><label>Background check</label><input type="datetime-local" data-rr-dd-field="background_check_completed_at" value="${v((d.background_check_completed_at || '').slice(0,16))}"/></div>
    <div class="dd-row"><label>Drug test</label><input type="datetime-local" data-rr-dd-field="drug_test_completed_at" value="${v((d.drug_test_completed_at || '').slice(0,16))}"/></div>
    <div class="dd-row"><label>Training scheduled</label><input type="datetime-local" data-rr-dd-field="training_scheduled_at" value="${v((d.training_scheduled_at || '').slice(0,16))}"/></div>
    <div class="dd-row"><label>Training date</label><input type="date" data-rr-dd-field="training_date" value="${v(d.training_date)}"/></div>
    <div class="dd-row" style="border-top:1px solid var(--border);padding-top:14px;margin-top:6px">
      <label>Driver app</label>
      <div>
        <button type="button" class="btn btn-sm" data-rr-issue-invite>Generate invite code</button>
        <div style="font-size:11px;color:var(--text-subtle);margin-top:6px;line-height:1.4">Driver enters this on the RouteReady app at <strong>gorouteready.com/app/</strong>. One active code at a time · expires in 14 days.</div>
        <div data-rr-invite-display style="margin-top:10px;display:none"></div>
      </div>
    </div>`;
}

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
  let expiryPill = '<span style="color:var(--text-subtle);font-size:12px">No expiry on file</span>';
  if (d.dl_expires_on) {
    const exp = new Date(d.dl_expires_on);
    const days = Math.floor((exp.getTime() - Date.now()) / 86400000);
    let style = "background:var(--canvas);color:var(--text-muted)";
    let suffix = `${days} days from today`;
    if (days < 0)        { style = "background:var(--red-soft);color:var(--red)";   suffix = `Expired ${-days} days ago`; }
    else if (days <= 30) { style = "background:var(--amber-soft);color:var(--amber)"; suffix = `Expires in ${days} days`; }
    expiryPill = `<span class="tag" style="${style}">${exp.toLocaleDateString()} · ${suffix}</span>`;
  }

  body.innerHTML = `
    <div class="dd-row"><label>License number</label><input data-rr-dd-field="dl_number" placeholder="DL number" value="${v(d.dl_number)}"/></div>
    <div class="dd-row"><label>Expiration</label>
      <div>
        <input type="date" data-rr-dd-field="dl_expires_on" value="${v(d.dl_expires_on)}" style="margin-bottom:6px"/>
        ${expiryPill}
      </div>
    </div>

    <div style="margin-top:18px">
      <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px">License image</div>
      ${imgUrl
        ? `<a href="${imgUrl}" target="_blank" rel="noreferrer" style="display:block">
             <img src="${imgUrl}" style="max-width:100%;max-height:280px;border:1px solid var(--border);border-radius:8px;background:var(--canvas)" alt="Drivers license"/>
           </a>
           <div style="margin-top:8px;display:flex;gap:8px">
             <input type="file" id="rr-dl-file" accept="image/*" />
             <button class="btn btn-sm" data-rr-dl-upload>Replace</button>
             <button class="btn btn-sm" data-rr-dl-remove style="color:var(--red)">Remove</button>
           </div>`
        : `<div style="border:1px dashed var(--border);border-radius:8px;padding:24px;text-align:center;color:var(--text-subtle);font-size:13px;margin-bottom:10px">No image uploaded yet.</div>
           <div style="display:flex;gap:8px;align-items:center">
             <input type="file" id="rr-dl-file" accept="image/*" />
             <button class="btn btn-primary btn-sm" data-rr-dl-upload>Upload license image</button>
           </div>`}
    </div>`;
}

function renderDotTab(body, d) {
  const checked = d.dot_certified ? "checked" : "";
  body.innerHTML = `
    <div class="dd-row" style="align-items:flex-start">
      <label>DOT certification</label>
      <div>
        <label style="display:flex;gap:10px;align-items:center;cursor:pointer;padding:8px 0">
          <input type="checkbox" data-rr-dd-field="dot_certified" ${checked} style="cursor:pointer;width:16px;height:16px"/>
          <span style="font-size:13px;color:var(--text)">Driver is DOT certified</span>
        </label>
        <div style="font-size:11px;color:var(--text-subtle);line-height:1.4;margin-top:4px">Check this if the driver currently holds a valid DOT medical certification.</div>
      </div>
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
    if (document.getElementById("view-messages")?.classList.contains("active")) {
      refreshDriverChatList(false);
    } else {
      clearInterval(_msgInboxListTimer); _msgInboxListTimer = null;
    }
  }, 8000);
}

async function refreshDriverChatList(autoSelect) {
  const list = document.getElementById("rr-msg-driver-list");
  if (!list) return;
  const { data, error } = await sb.rpc("dispatch_chat_threads");
  if (error) {
    list.innerHTML = `<div style="padding:24px;color:var(--red);font-size:12px">${escapeHtml(error.message)}</div>`;
    return;
  }
  _msgInboxList = data || [];
  if (_msgInboxList.length === 0) {
    list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-subtle);font-size:12px">No active drivers yet.</div>`;
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
      <div class="msg-item-avatar"><div class="avatar-sm">${escapeHtml(initials)}</div></div>
      <div><div class="msg-item-name">${escapeHtml(t.name)}${t.station_code ? ` <span style="color:var(--text-subtle);font-weight:400">· ${escapeHtml(t.station_code)}</span>` : ""}</div><div class="msg-item-preview">${escapeHtml(lastBodyTrunc)}</div></div>
      <div><div class="msg-item-time">${escapeHtml(fmtRelative(t.last_at))}</div>${t.unread > 0 ? `<div class="msg-item-unread">${t.unread}</div>` : ""}</div>
    </div>`;
  }).join("");
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
  _msgInboxThreadTimer = setInterval(() => {
    if (!document.getElementById("view-messages")?.classList.contains("active") || _msgInboxSelectedId !== driverId) {
      clearInterval(_msgInboxThreadTimer); _msgInboxThreadTimer = null; return;
    }
    refreshDriverChatThread(false);
  }, 8000);
}

async function refreshDriverChatThread(scrollToBottom) {
  const conv = document.getElementById("rr-msg-conv");
  if (!conv) return;
  if (!_msgInboxSelectedId) {
    conv.innerHTML = `<div style="margin:auto;text-align:center;color:var(--text-subtle);font-size:13px;padding:40px">Pick a driver from the list to open their thread.</div>`;
    return;
  }
  const driverId = _msgInboxSelectedId;
  const { data, error } = await sb.rpc("dispatch_chat_thread", { p_driver_id: driverId, p_limit: 200 });
  if (error) {
    conv.innerHTML = `<div style="margin:auto;color:var(--red);padding:40px">${escapeHtml(error.message)}</div>`;
    return;
  }
  const drv = data?.driver || {};
  const msgs = data?.messages || [];

  // First render: build the shell. After that, only re-render the thread
  // body and leave the composer / textarea state alone.
  if (conv.dataset.rrDriverId !== driverId) {
    conv.dataset.rrDriverId = driverId;
    conv.innerHTML = `
      <style>
        .rr-mc-shell{position:absolute;inset:0;display:flex;flex-direction:column;overflow:hidden}
        .rr-mc-head{padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-shrink:0}
        .rr-mc-name{font-size:14px;font-weight:600}
        .rr-mc-sub{font-size:11px;color:var(--text-subtle);margin-top:2px}
        .rr-mc-thread{flex:1 1 0;min-height:0;overflow-y:auto;padding:16px 18px;display:flex;flex-direction:column;gap:6px;background:var(--canvas)}
        .rr-mc-bubble{max-width:78%;padding:9px 13px;border-radius:14px;font-size:14px;line-height:1.4;word-wrap:break-word}
        .rr-mc-bubble.driver{align-self:flex-start;background:var(--surface);color:var(--text);border:1px solid var(--border);border-bottom-left-radius:4px}
        .rr-mc-bubble.dispatch{align-self:flex-end;background:var(--accent);color:#fff;border-bottom-right-radius:4px}
        .rr-mc-time{font-size:10px;margin-top:3px;opacity:.7;text-align:right;font-variant-numeric:tabular-nums}
        .rr-mc-empty{margin:auto;text-align:center;color:var(--text-subtle);font-size:13px;padding:40px}
        .rr-mc-composer{display:flex;gap:8px;align-items:flex-end;padding:12px 18px;background:var(--surface);border-top:1px solid var(--border);flex-shrink:0}
        .rr-mc-composer textarea{flex:1;min-height:40px;max-height:140px;padding:9px 12px;font-size:14px;line-height:1.4;background:var(--canvas);border:1px solid var(--border);border-radius:8px;resize:none;font-family:inherit;color:var(--text)}
        .rr-mc-composer textarea:focus{outline:none;border-color:var(--accent)}
        .rr-mc-send{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:0 16px;font-weight:600;font-size:13px;cursor:pointer;min-height:40px}
        .rr-mc-send:disabled{opacity:.5;cursor:not-allowed}
      </style>
      <div class="rr-mc-shell">
        <div class="rr-mc-head" data-rr-driver-id="${escapeHtml(driverId)}">
          <div class="avatar-sm">${escapeHtml((drv.name || "?").split(/\s+/).map(p => p[0]).filter(Boolean).slice(0,2).join("").toUpperCase())}</div>
          <div>
            <div class="rr-mc-name">${escapeHtml(drv.name || "")}</div>
            <div class="rr-mc-sub">Driver chat</div>
          </div>
        </div>
        <div class="rr-mc-thread" id="rr-mc-thread"></div>
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
    ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(140, ta.scrollHeight) + "px"; });
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
        <div style="display:flex;align-items:center;gap:8px;background:var(--canvas);border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:12px">
          ${isImg ? `<img src="${URL.createObjectURL(f)}" alt="" style="width:32px;height:32px;border-radius:4px;object-fit:cover">`
                  : `<span style="font-size:16px">📎</span>`}
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(f.name)}</div>
            <div style="color:var(--text-subtle)">${sizeKb} KB</div>
          </div>
          <button type="button" id="rr-mc-attach-clear" aria-label="Remove" style="background:none;border:0;color:var(--text-subtle);cursor:pointer;font-size:16px;line-height:1;padding:2px">×</button>
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

      let attachment = null;
      if (file) {
        const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "file";
        const dspId = window.RR?.dsp?.id || "unknown";
        const path  = `${dspId}/${_msgInboxSelectedId}/${Date.now()}-${safe}`;
        const { error: upErr } = await sb.storage
          .from("driver-chat-attachments").upload(path, file, { contentType: file.type, upsert: false });
        if (upErr) {
          send.disabled = false;
          toast("Upload failed: " + upErr.message, "warn");
          return;
        }
        attachment = { path, mime: file.type, name: file.name, size: file.size };
      }

      const { error } = await sb.rpc("dispatch_chat_send", {
        p_driver_id:             _msgInboxSelectedId,
        p_body:                  body || null,
        p_attachment_path:       attachment?.path || null,
        p_attachment_mime:       attachment?.mime || null,
        p_attachment_name:       attachment?.name || null,
        p_attachment_size_bytes: attachment?.size || null,
      });
      send.disabled = false;
      if (error) { toast("Couldn't send: " + error.message, "warn"); return; }
      ta.value = ""; ta.style.height = "auto";
      if (file) {
        window._rrMcPending = null;
        fileInput.value = "";
        previewEl.style.display = "none";
        previewEl.innerHTML = "";
      }
      await refreshDriverChatThread(true);
      refreshDriverChatList(false);
    });
  }

  const thread = document.getElementById("rr-mc-thread");
  if (!thread) return;
  if (msgs.length === 0) {
    thread.innerHTML = `<div class="rr-mc-empty">No messages yet. Start the thread below.</div>`;
  } else {
    thread.innerHTML = msgs.map((m) => {
      const t = new Date(m.created_at);
      const time = t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      let attach = "";
      if (m.attachment_path) {
        const isImg = (m.attachment_mime || "").startsWith("image/");
        const name  = m.attachment_name || "Attachment";
        const sizeKb = m.attachment_size_bytes ? Math.round(m.attachment_size_bytes / 1024) : null;
        attach = isImg
          ? `<img data-rr-mc-attach="${escapeHtml(m.attachment_path)}" alt="${escapeHtml(name)}" style="display:block;max-width:240px;width:100%;border-radius:8px;margin-bottom:6px;cursor:zoom-in" onclick="window.open(this.src,'_blank')"/>`
          : `<a data-rr-mc-attach="${escapeHtml(m.attachment_path)}" target="_blank" rel="noopener" style="display:flex;gap:8px;align-items:center;padding:6px 10px;background:rgba(255,255,255,.15);border-radius:8px;margin-bottom:6px;text-decoration:none;color:inherit;max-width:240px"><span>📎</span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:12px">${escapeHtml(name)}</span>${sizeKb != null ? `<span style="font-size:11px;opacity:.8">${sizeKb} KB</span>` : ""}</a>`;
      }
      const bodyHtml = m.body ? `<div>${escapeHtml(m.body).replace(/\n/g, "<br>")}</div>` : "";
      return `<div class="rr-mc-bubble ${m.sender_kind}">
        ${attach}
        ${bodyHtml}
        <div class="rr-mc-time">${escapeHtml(time)}</div>
      </div>`;
    }).join("");
    // Sign attachment paths so they render — bucket is private.
    setTimeout(() => _rrMcSignAttachments(), 0);
  }
  if (scrollToBottom) thread.scrollTop = thread.scrollHeight;
  if (msgs.some((m) => m.sender_kind === "driver")) {
    sb.rpc("dispatch_chat_mark_read", { p_driver_id: driverId }).catch(() => {});
  }
}

<<<<<<< HEAD
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
      if (el.tagName === "IMG") el.src = data.signedUrl;
      else                       el.href = data.signedUrl;
    } catch {}
  }
}

=======
>>>>>>> origin/main
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
  return `<span style="font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:2px 7px;border-radius:10px;background:var(--canvas);color:var(--text-muted);border:1px solid var(--border)">${escapeHtml(label)}</span>`;
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
  return `<div style="font-size:11px;color:var(--text-subtle);margin-top:4px">Action: <strong style="color:var(--text)">${taken.map(escapeHtml).join(" · ")}</strong></div>`;
}

function renderCoachingTab(coachings, driver) {
  const items = (coachings || []).filter(c => !c.archived_at);
  const list = items.map(c => {
    const occurred = c.occurred_at ? new Date(c.occurred_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";
    const ackChip = c.acknowledgment && c.acknowledgment !== "none"
      ? `<span style="font-size:10px;font-weight:600;color:var(--green);background:rgba(34,197,94,.12);padding:2px 7px;border-radius:10px">Acknowledged · ${escapeHtml(c.acknowledgment)}</span>`
      : (c.driver_visible ? `<span style="font-size:10px;font-weight:600;color:var(--amber);background:rgba(245,158,11,.12);padding:2px 7px;border-radius:10px">Awaiting acknowledgment</span>` : "");
    const followBadge = c.follow_up_at && !c.resolved_at
      ? `<span style="font-size:10px;font-weight:600;color:var(--accent-text);background:var(--accent-soft);padding:2px 7px;border-radius:10px">Follow-up ${new Date(c.follow_up_at).toLocaleDateString()}</span>`
      : "";
    const privBadge = c.privacy_tier === "hr_only"
      ? `<span style="font-size:10px;font-weight:700;color:var(--red);background:rgba(229,62,62,.1);padding:2px 7px;border-radius:10px">HR-only</span>`
      : "";
    const witness = c.witness_name
      ? `<div style="font-size:11px;color:var(--text-subtle);margin-top:2px">Witness: <strong style="color:var(--text)">${escapeHtml(c.witness_name)}${c.witness_role ? ` (${escapeHtml(c.witness_role)})` : ""}</strong></div>`
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
    const coachLine = isAuto
      ? `<div style="font-size:11px;color:var(--text-subtle);margin-top:2px">Auto-coached · <strong style="color:var(--text)">${escapeHtml(channel || "Driver app")}</strong></div>`
      : (c.coached_by_name
        ? `<div style="font-size:11px;color:var(--text-subtle);margin-top:2px">Coached by <strong style="color:var(--text)">${escapeHtml(c.coached_by_name)}</strong></div>`
        : "");
    return `
    <div class="dd-list-row" data-rr-coaching-id="${c.id}" style="display:block;padding:12px 14px">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px">
        ${_coachSeverityChip(c.severity, c.metadata?.level)}
        <span style="font-size:11px;color:var(--text-subtle)">${(c.topic || "").replace(/_/g," ")} · ${(c.type || "").replace(/_/g," ")} · ${escapeHtml(occurred)}</span>
        ${followBadge} ${ackChip} ${privBadge}
      </div>
      <div class="dd-list-title">${escapeHtml(c.summary || c.topic || "(no summary)")}</div>
      ${c.notes ? `<div style="font-size:12px;color:var(--text-muted);margin-top:6px;line-height:1.5;white-space:pre-wrap">${escapeHtml(c.notes)}</div>` : ""}
      ${_coachActionList(c.action_taken)}
      ${witness}
      ${coachLine}
      <div style="display:flex;gap:6px;margin-top:8px">
        ${!c.resolved_at ? `<button class="btn btn-sm" data-rr-coach-resolve="${c.id}">Mark resolved</button>` : `<span style="font-size:11px;color:var(--green)">Resolved ${new Date(c.resolved_at).toLocaleDateString()}</span>`}
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
    ? `<button class="btn btn-sm" data-rr-coach-copy-link="${escapeHtml(base.replace(/\/$/, ""))}/dashboard/coaching.html?t=${encodeURIComponent(token)}" style="margin-left:8px">Copy driver link</button>`
    : "";
  // Drop the "+ Log coaching" button on a driver's coaching record —
  // operators log new coachings from the global Coaching feed and
  // from the daily-attendance approve flow.  The driver record is a
  // read + acknowledge view, not a re-entry point.
  return `
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
      ${linkBtn}
    </div>
    <div>${list || `<div style="padding:24px;text-align:center;color:var(--text-subtle);font-size:13px">No coachings logged yet.</div>`}</div>`;
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
      <select id="rr-doc-kind" class="dd-row-input" style="background:var(--canvas);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font:inherit;font-size:13px">
        ${["drivers_license","mvr","dot_medical","background_check","social_security","i9","w4","direct_deposit","vehicle_registration","insurance","other"].map(k => `<option value="${k}">${k.replace(/_/g," ")}</option>`).join("")}
      </select>
      <input type="file" id="rr-doc-file" />
      <button class="btn btn-primary" data-rr-doc-upload>Upload</button>
    </div>
    <div>${list || `<div style="padding:24px;text-align:center;color:var(--text-subtle);font-size:13px">No documents on file.</div>`}</div>`;
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
    const meta = _ddDriver.driver.metadata || {};
    const newMeta = { ...meta, availability: { days } };
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
        <div style="font-size:11px;color:var(--text-subtle);margin-top:6px">Share this code with the driver. Generating a new one invalidates this one.</div>`;
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
    const payload = {};
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
            <h3 style="margin:0;font-size:17px;font-weight:600">Log a coaching</h3>
            <div style="font-size:11px;color:var(--text-subtle);margin-top:3px">Cmd / Ctrl + Enter to save</div>
          </div>
          ${recent30 >= 3
            ? `<div style="font-size:11px;color:var(--text-muted);background:var(--canvas);border:1px solid var(--border);padding:6px 10px;border-radius:6px;line-height:1.4;max-width:240px"><strong>${recent30}</strong> coachings in the last 30 days · consider escalating.</div>`
            : ""}
        </div>
      </div>

      <!-- Body -->
      <div style="padding:18px 24px;display:flex;flex-direction:column;gap:16px">

        <!-- Section 1: What happened -->
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--text-subtle);letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px">The event</div>
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
          <div style="font-size:11px;font-weight:700;color:var(--text-subtle);letter-spacing:.06em;text-transform:uppercase;margin-bottom:6px">Driver acknowledgment</div>
          <label style="font-size:13px;cursor:pointer;display:flex;align-items:flex-start;gap:10px">
            <input id="rr-coach-driver-visible" type="checkbox" style="margin-top:3px"/>
            <span style="flex:1">
              <strong>Request Confirmation</strong>
              <div id="rr-coach-rc-help" style="font-size:11px;color:var(--text-subtle);font-weight:400;margin-top:3px;line-height:1.5">When ON, the coaching shows up on the driver's record in their RouteReady app and they get a tappable link to read and sign-acknowledge.  When OFF, the coaching is logged on your side only — useful for sensitive notes or when you've already coached in person.</div>
            </span>
          </label>
          <div id="rr-coach-rc-locked" style="display:none;font-size:11px;color:var(--text-muted);background:var(--surface);border:1px dashed var(--border-strong);border-radius:6px;padding:8px 10px;margin-top:8px;line-height:1.4">
            <strong>Required at this level.</strong>  Written and Final coachings always Request Confirmation so the driver's signature is on file before the next escalation.
          </div>
        </div>

        <!-- Section 3: Details (collapsible) -->
        <button type="button" id="rr-coach-more-toggle" style="font-size:12px;font-weight:600;color:var(--accent-text);background:transparent;border:0;cursor:pointer;padding:0;align-self:flex-start">+ More details (type, incident date, witness, privacy, attachments)</button>

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
            <summary style="cursor:pointer;font-size:12px;color:var(--text-muted);font-weight:600">Witness · 3rd party in the conversation</summary>
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
            <input id="rr-coach-files" type="file" multiple style="font-size:12px"/>
            <div id="rr-coach-upload-status" style="font-size:11px;color:var(--text-subtle);margin-top:6px"></div>
            <div style="font-size:11px;color:var(--text-subtle);margin-top:4px">Photos, scorecard screenshots, signed forms.</div>
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
        ? `${base.replace(/\/$/, "")}/dashboard/coaching.html?t=${encodeURIComponent(tokRow.coaching_view_token)}`
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
      `<div style="font-size:12px;border-bottom:1px solid var(--border);padding:8px 0">
         <div style="color:var(--text-muted)">${new Date(ed.edited_at).toLocaleString()} · ${escapeHtml(ed.edited_by_name || "—")}</div>
         <div><strong>${escapeHtml(ed.field_name)}</strong> · "${escapeHtml(ed.old_value || "")}" → "${escapeHtml(ed.new_value || "")}"</div>
       </div>`).join("") || `<div style="color:var(--text-subtle);font-size:13px">No edits.</div>`;
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
    return `<span style="display:inline-block;min-width:32px;text-align:center;padding:3px 6px;border-radius:5px;background:${bg};color:${fg};font-size:11px;font-weight:600;opacity:${op}">${_AVAIL_DAY_LABELS[k]}</span>`;
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
let _availSortKey = "default"; // default | driver | station | submitted | status
let _availSortDir = "asc";     // asc | desc

async function loadAvailabilityRequests() {
  const wrap = document.getElementById("rr-avail-req-list");
  if (!wrap) return;

  // Header + KPI shells render synchronously so the operator sees
  // structure even while the data loads.
  _renderAvailabilityShell();
  wrap.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-subtle);font-size:13px">Loading…</div>`;

  // Fire all three endpoints in parallel.
  const [reqRes, kpiRes, blackRes, setRes] = await Promise.all([
    sb.rpc("availability_request_list"),
    sb.rpc("availability_kpis"),
    sb.rpc("availability_blackout_list"),
    sb.rpc("availability_settings_get"),
  ]);
  if (reqRes.error) {
    wrap.innerHTML = `<div style="padding:24px;color:var(--red);font-size:13px">${escapeHtml(reqRes.error.message)}</div>`;
    return;
  }
  _availRequestsCache = reqRes.data || [];
  const pendingCount = _availRequestsCache.filter((r) => r.status === "pending").length;
  _updateAvailReqBadge(pendingCount);

  // KPIs + blackouts + settings rendered into their own slots.
  _renderAvailabilityKpis(kpiRes.data || {}, _availRequestsCache);
  _renderAvailabilityBlackouts(blackRes.data || []);
  _renderAvailabilitySettingsPanel(setRes.data || {});
  _renderAvailabilityRows();
}

// Drivers → Availability is now just the request queue.
//   - Insights moved to Drivers → Insights (data-rr-avail-* targets
//     live in dr-sub-insights now).
//   - Rules moved to Settings → Availability rules.
// Render the queue card and a sortable header bar; the renderer
// helpers below populate the relocated insights / rules panels via
// document.querySelector so they find the new homes.
function _renderAvailabilityShell() {
  const host = document.getElementById("dr-sub-availability");
  if (!host) return;
  if (host.dataset.rrShell === "1") return;
  host.dataset.rrShell = "1";

  const list = document.getElementById("rr-avail-req-list");
  if (list && !document.getElementById("rr-avail-sortbar")) {
    list.insertAdjacentHTML("beforebegin", `
      <div id="rr-avail-sortbar" style="display:grid;grid-template-columns:220px 1fr auto;gap:16px;padding:10px 18px;border-bottom:1px solid var(--border);font-size:11px;font-weight:600;color:var(--text-subtle);text-transform:uppercase;letter-spacing:.04em;background:var(--canvas)">
        <div style="display:flex;gap:10px;align-items:center">
          <button class="avail-sort-btn" data-rr-sort="driver">Driver</button>
          <button class="avail-sort-btn" data-rr-sort="station">Station</button>
        </div>
        <div style="display:flex;gap:10px;align-items:center">
          <button class="avail-sort-btn" data-rr-sort="submitted">Submitted</button>
          <button class="avail-sort-btn" data-rr-sort="status">Status</button>
        </div>
        <div></div>
      </div>
    `);
  }

  if (!document.getElementById("rr-avail-shell-style")) {
    const st = document.createElement("style");
    st.id = "rr-avail-shell-style";
    st.textContent = `
      .avail-sort-btn{font:inherit;text-transform:inherit;letter-spacing:inherit;
        color:var(--text-subtle);background:none;border:0;padding:2px 4px;border-radius:4px;cursor:pointer}
      .avail-sort-btn:hover{color:var(--text)}
      .avail-sort-btn.active{color:var(--accent);background:var(--accent-soft)}
    `;
    document.head.appendChild(st);
  }

  host.addEventListener("click", (e) => {
    const sortBtn = e.target.closest("[data-rr-sort]");
    if (sortBtn) {
      const k = sortBtn.dataset.rrSort;
      if (_availSortKey === k) {
        _availSortDir = _availSortDir === "asc" ? "desc" : "asc";
      } else {
        _availSortKey = k;
        _availSortDir = "asc";
      }
      _renderAvailabilityRows();
    }
  });
}

function _renderAvailabilityKpis(k, rows) {
  // Insights moved to Drivers → Insights, so search globally for the
  // target containers — they live wherever the operator put them.
  const el = document.querySelector("[data-rr-avail-kpis]");
  if (!el) return;
  const card = (label, value, sub) => `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 14px">
      <div style="font-size:11px;font-weight:600;color:var(--text-subtle);letter-spacing:.04em;text-transform:uppercase">${escapeHtml(label)}</div>
      <div style="font-size:24px;font-weight:700;margin-top:4px">${escapeHtml(String(value))}</div>
      ${sub ? `<div style="font-size:11px;color:var(--text-subtle);margin-top:2px">${sub}</div>` : ""}
    </div>`;
  el.innerHTML = [
    card("Pending",       k.pending_count ?? 0,  "awaiting review"),
    card("Approved · 30d", k.approved_30d ?? 0,  "decisions in last 30 days"),
    card("Denied · 30d",   k.denied_30d   ?? 0,  "decisions in last 30 days"),
    card("Avg decision time", k.avg_decision_hours_30d != null ? `${k.avg_decision_hours_30d}h` : "—", "from submit to decide"),
  ].join("");

  // "Repeat requesters" — operators want to know who's churning so they
  // can have a conversation. Lives on its own card now (the Driver
  // Availability by Day chart from Schedule Insights renders in the
  // card above).
  const repeatEl = document.querySelector("[data-rr-avail-repeats]");
  if (!repeatEl) return;
  const repeats = Array.isArray(k.repeat_requesters_30d) ? k.repeat_requesters_30d : [];
  const repeatList = repeats.length === 0
    ? `<div style="font-size:12px;color:var(--text-subtle)">No drivers have submitted more than once in the last 30 days.</div>`
    : repeats.slice(0, 12).map(r => `
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px">
          <span>${escapeHtml(r.driver_name || "")}</span>
          <span style="font-weight:600">${r.count} requests</span>
        </div>`).join("");
  repeatEl.innerHTML = `
    <div style="font-size:13px;font-weight:700;margin-bottom:8px">Repeat requesters · 30 days</div>
    <div style="font-size:11px;color:var(--text-subtle);margin-bottom:10px">Drivers who submitted 2+ availability changes recently. Worth a conversation if the pattern continues.</div>
    ${repeatList}`;
}

function _renderAvailabilityBlackouts(rows) {
  // Rules section moved to Settings; search globally so the blackout
  // editor renders wherever the [data-rr-avail-blackouts] anchor sits.
  const el = document.querySelector("[data-rr-avail-blackouts]");
  if (!el) return;
  const list = (rows || []).map(b => `
    <div style="display:grid;grid-template-columns:140px 140px 1fr auto;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);align-items:center;font-size:13px">
      <div>${escapeHtml(b.start_date || "")}</div>
      <div>${escapeHtml(b.end_date || "")}</div>
      <div style="color:var(--text-muted)">${escapeHtml(b.reason || "")}</div>
      <button class="btn btn-sm btn-danger" data-rr-blackout-delete="${escapeHtml(b.id)}">Delete</button>
    </div>`).join("");
  el.innerHTML = `
    <form id="rr-avail-blackout-form" style="display:grid;grid-template-columns:140px 140px 1fr auto;gap:10px;align-items:end;margin:6px 0 14px">
      <div>
        <label style="display:block;font-size:11px;font-weight:600;color:var(--text-subtle);margin-bottom:4px">Start</label>
        <input type="date" id="rr-bl-start" required style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px"/>
      </div>
      <div>
        <label style="display:block;font-size:11px;font-weight:600;color:var(--text-subtle);margin-bottom:4px">End</label>
        <input type="date" id="rr-bl-end" required style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px"/>
      </div>
      <div>
        <label style="display:block;font-size:11px;font-weight:600;color:var(--text-subtle);margin-bottom:4px">Reason (optional)</label>
        <input type="text" id="rr-bl-reason" placeholder="e.g. Holiday peak — no availability changes" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px"/>
      </div>
      <button type="submit" class="btn btn-sm btn-primary">Add blackout</button>
    </form>
    ${list || `<div style="font-size:12px;color:var(--text-subtle);padding:8px 0">No blackouts. Drivers can submit any day.</div>`}
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
  // Settings card moved to Settings → Availability rules.  Search
  // globally so it renders wherever the [data-rr-avail-settings]
  // anchor lives now.
  const el = document.querySelector("[data-rr-avail-settings]");
  if (!el) return;
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:200px 1fr;gap:14px;margin-top:8px;align-items:start">
      <label style="font-size:13px;font-weight:600">Lead time<br><span style="font-size:11px;color:var(--text-subtle);font-weight:400">Days from approval until the change is live for scheduling.</span></label>
      <div>
        <input type="number" id="rr-avail-lead" min="0" max="60" value="${Number(s.lead_days ?? 7)}" style="width:120px;padding:8px 10px;border:1px solid var(--border);border-radius:6px"/>
        <span style="font-size:12px;color:var(--text-subtle);margin-left:6px">days</span>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:200px 1fr;gap:14px;margin-top:14px;align-items:start">
      <label style="font-size:13px;font-weight:600">Approve auto-response<br><span style="font-size:11px;color:var(--text-subtle);font-weight:400">Sent to the driver when you approve. Placeholders: {days} {effective_from} {effective_until} {note}</span></label>
      <textarea id="rr-avail-approve-tmpl" rows="3" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;resize:vertical">${escapeHtml(s.approve_template || "")}</textarea>
    </div>
    <div style="display:grid;grid-template-columns:200px 1fr;gap:14px;margin-top:14px;align-items:start">
      <label style="font-size:13px;font-weight:600">Deny auto-response<br><span style="font-size:11px;color:var(--text-subtle);font-weight:400">Sent to the driver when you deny. Placeholders: {days} {note}</span></label>
      <textarea id="rr-avail-deny-tmpl" rows="3" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;resize:vertical">${escapeHtml(s.deny_template || "")}</textarea>
    </div>
    <div style="text-align:right;margin-top:14px">
      <button class="btn btn-primary" id="rr-avail-settings-save">Save settings</button>
    </div>`;
  document.getElementById("rr-avail-settings-save").addEventListener("click", async () => {
    const btn = document.getElementById("rr-avail-settings-save");
    btn.disabled = true; btn.textContent = "Saving…";
    const { error } = await sb.rpc("availability_settings_set", {
      p_lead_days:        Number(document.getElementById("rr-avail-lead").value || 7),
      p_approve_template: document.getElementById("rr-avail-approve-tmpl").value,
      p_deny_template:    document.getElementById("rr-avail-deny-tmpl").value,
    });
    btn.disabled = false; btn.textContent = "Save settings";
    if (error) { toast("Save failed: " + error.message, "warn"); return; }
    toast("Settings saved", "success");
  });
}

function _sortAvailRows(rows) {
  const dir = _availSortDir === "asc" ? 1 : -1;
  const cmp = (a, b) => {
    let av, bv;
    switch (_availSortKey) {
      case "driver":    av = (a.driver_name || "").toLowerCase(); bv = (b.driver_name || "").toLowerCase(); break;
      case "station":   av = (a.station_code || "").toLowerCase(); bv = (b.station_code || "").toLowerCase(); break;
      case "status":    av = a.status; bv = b.status; break;
      case "submitted": av = a.submitted_at || ""; bv = b.submitted_at || ""; break;
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

  // Reflect active sort.
  document.querySelectorAll("[data-rr-sort]").forEach(b => {
    b.classList.toggle("active", b.dataset.rrSort === _availSortKey);
    if (b.dataset.rrSort === _availSortKey) b.textContent = b.dataset.rrSort + (_availSortDir === "asc" ? " ↑" : " ↓");
    else b.textContent = b.dataset.rrSort;
  });

  if (_availRequestsCache.length === 0) {
    wrap.innerHTML = `<div style="padding:48px;text-align:center;color:var(--text-subtle);font-size:13px">No availability requests.</div>`;
    return;
  }

  const rows = _sortAvailRows(_availRequestsCache);

  wrap.innerHTML = rows.map((r) => {
    const same = JSON.stringify((r.days || []).slice().sort()) === JSON.stringify(((r.current_days || []).slice()).sort());
    const isPending  = r.status === "pending";
    const isApproved = r.status === "approved";
    const isDenied   = r.status === "denied";

    let statusPill = "";
    if (isPending)  statusPill = `<span style="background:#fef3c7;color:#92400e;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:3px 8px;border-radius:10px">Pending</span>`;
    if (isApproved) statusPill = `<span style="background:rgba(22,163,74,.12);color:var(--green);font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:3px 8px;border-radius:10px">Approved</span>`;
    if (isDenied)   statusPill = `<span style="background:rgba(220,38,38,.10);color:var(--red);font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:3px 8px;border-radius:10px">Denied</span>`;

    let metaLine;
    if (isPending) {
      metaLine = `submitted ${escapeHtml(_fmtRel(r.submitted_at))}`;
    } else if (isApproved) {
      metaLine = `approved ${escapeHtml(_fmtRel(r.decided_at))} · effective through ${escapeHtml(_fmtAvailDateShort(r.effective_until))}`;
    } else {
      metaLine = `denied ${escapeHtml(_fmtRel(r.decided_at))}`;
    }

    const noteLine = r.decision_note
      ? `<div style="font-size:12px;color:var(--text-muted);margin-top:6px;font-style:italic">"${escapeHtml(r.decision_note)}"</div>`
      : "";

    const actions = isPending
      ? `<div style="display:flex;gap:8px;align-items:center">
           <button class="btn btn-sm" data-rr-avail-deny="${escapeHtml(r.id)}">Deny</button>
           <button class="btn btn-sm btn-primary" data-rr-avail-approve="${escapeHtml(r.id)}">Approve</button>
         </div>`
      : `<div style="font-size:11px;color:var(--text-subtle)">—</div>`;

    return `
      <div class="avail-req-row" data-rr-req-id="${escapeHtml(r.id)}" style="padding:14px 18px;border-bottom:1px solid var(--border);display:grid;grid-template-columns:220px 1fr auto;gap:16px;align-items:center;${isPending ? "" : "background:var(--canvas)"}">
        <div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-size:14px;font-weight:600;color:var(--text)">${escapeHtml(r.driver_name || "")}</span>
            ${statusPill}
          </div>
          <div style="font-size:11px;color:var(--text-subtle);margin-top:3px">${escapeHtml(r.station_code || "—")} · ${metaLine}</div>
          ${noteLine}
        </div>
        <div>
          <div style="font-size:11px;font-weight:600;color:var(--text-subtle);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">${isApproved ? "Approved" : "Requested"}</div>
          <div>${_availDaysHtml(r.days, false)}</div>
          ${(isPending && !same) ? `
            <div style="font-size:11px;font-weight:600;color:var(--text-subtle);text-transform:uppercase;letter-spacing:.04em;margin:8px 0 4px">Currently approved</div>
            <div>${_availDaysHtml(r.current_days, true)}</div>
          ` : ""}
        </div>
        ${actions}
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
  wrap.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-subtle);font-size:13px">Loading…</div>`;

  // Always land on "All active" when (re)entering the feed, so leaving the
  // page and coming back resets the status filter regardless of what was
  // selected last time.
  const statusSel = document.getElementById("rr-coach-filter-status");
  if (statusSel) statusSel.value = "all";

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
    wrap.innerHTML = `<div style="padding:24px;color:var(--red);font-size:13px">Could not load coachings: ${escapeHtml(coachRes.error.message)}</div>`;
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

function _renderCoachFeed() {
  const wrap = document.getElementById("rr-coach-feed");
  if (!wrap || !_coachFeedCache) return;

  const search   = (document.getElementById("rr-coach-search")?.value || "").toLowerCase().trim();
  const sevFilt  = document.getElementById("rr-coach-filter-severity")?.value || "";
  const topFilt  = document.getElementById("rr-coach-filter-topic")?.value || "";
  const statFilt = document.getElementById("rr-coach-filter-status")?.value || "all";
  const sort     = document.getElementById("rr-coach-sort")?.value || "date_desc";

  let rows = _coachFeedCache.rows.slice();
  if (statFilt === "open")     rows = rows.filter(c => !c.archived_at && c.follow_up_at && !c.resolved_at);
  else if (statFilt === "all") rows = rows.filter(c => !c.archived_at);
  else if (statFilt === "archived") rows = rows.filter(c => !!c.archived_at);

  if (sevFilt) rows = rows.filter(c => c.severity === sevFilt);
  if (topFilt) rows = rows.filter(c => c.topic === topFilt);

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

  rows.sort((a, b) => {
    if (sort === "date_asc")   return new Date(a.occurred_at) - new Date(b.occurred_at);
    if (sort === "severity")   return (_COACH_SEV_RANK[a.severity] ?? 9) - (_COACH_SEV_RANK[b.severity] ?? 9) || (new Date(b.occurred_at) - new Date(a.occurred_at));
    if (sort === "topic")      return String(a.topic).localeCompare(String(b.topic)) || (new Date(b.occurred_at) - new Date(a.occurred_at));
    if (sort === "coach")      return String(a.coached_by_name || "").localeCompare(String(b.coached_by_name || ""));
    if (sort === "followup") {
      const aD = a.follow_up_at ? new Date(a.follow_up_at).getTime() : Infinity;
      const bD = b.follow_up_at ? new Date(b.follow_up_at).getTime() : Infinity;
      return aD - bD;
    }
    return new Date(b.occurred_at) - new Date(a.occurred_at);
  });

  if (rows.length === 0) {
    wrap.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-subtle);font-size:13px">No coachings match the current filter.</div>`;
    return;
  }

  const head = `<thead><tr style="background:var(--canvas);border-bottom:1px solid var(--border)">
    <th style="text-align:left;padding:10px 14px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Driver</th>
    <th style="text-align:left;padding:10px 14px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Severity</th>
    <th style="text-align:left;padding:10px 14px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Topic</th>
    <th style="text-align:left;padding:10px 14px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Summary</th>
    <th style="text-align:left;padding:10px 14px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Coached</th>
    <th style="text-align:left;padding:10px 14px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Follow-up</th>
    <th style="text-align:left;padding:10px 14px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Status</th>
  </tr></thead>`;

  const body = rows.map(c => {
    const drv = _coachFeedCache.drivers.get(c.driver_id);
    const name = drv ? (drv.preferred_name || drv.full_name || "—") : "—";
    const sevChip = _coachSeverityChip(c.severity, c.metadata?.level);
    const occurred = new Date(c.occurred_at).toLocaleDateString();
    const followCell = c.follow_up_at
      ? (c.resolved_at
          ? `<span style="font-size:11px;color:var(--green)">Resolved</span>`
          : `<span style="font-size:11px;color:${new Date(c.follow_up_at) < new Date() ? "var(--red)" : "var(--accent-text)"}">${new Date(c.follow_up_at).toLocaleDateString()}</span>`)
      : `<span style="color:var(--text-subtle)">—</span>`;
    const ack = c.acknowledgment && c.acknowledgment !== "none"
      ? `<span style="font-size:10px;font-weight:600;color:var(--green);background:rgba(34,197,94,.12);padding:1px 6px;border-radius:8px">Ack</span>`
      : (c.driver_visible ? `<span style="font-size:10px;font-weight:600;color:var(--amber);background:rgba(245,158,11,.12);padding:1px 6px;border-radius:8px">Pending ack</span>` : "");
    const status = c.archived_at
      ? `<span style="font-size:10px;color:var(--text-subtle)">Archived</span>`
      : (c.resolved_at
          ? `<span style="font-size:10px;color:var(--green)">Resolved</span>`
          : ack || `<span style="font-size:10px;color:var(--text-subtle)">Open</span>`);

    return `<tr style="border-top:1px solid var(--border);cursor:pointer" data-rr-coach-feed-driver="${c.driver_id}">
      <td style="padding:10px 14px"><strong>${escapeHtml(name)}</strong>${drv?.station?.code ? `<div style="font-size:10px;color:var(--text-subtle)">${escapeHtml(drv.station.code)}</div>` : ""}</td>
      <td style="padding:10px 14px">${sevChip}</td>
      <td style="padding:10px 14px;font-size:12px;text-transform:capitalize">${escapeHtml(c.topic || "")}</td>
      <td style="padding:10px 14px;font-size:13px;max-width:320px">${escapeHtml(c.summary || c.notes?.slice(0, 80) || "—")}</td>
      <td style="padding:10px 14px;font-size:11px;color:var(--text-muted)">${escapeHtml(occurred)}<div>${escapeHtml(c.coached_by_name || "")}</div></td>
      <td style="padding:10px 14px">${followCell}</td>
      <td style="padding:10px 14px">${status}</td>
    </tr>`;
  }).join("");

  wrap.innerHTML = `<table style="width:100%;border-collapse:collapse">${head}<tbody>${body}</tbody></table>`;
}

document.addEventListener("input", (e) => {
  if (["rr-coach-search"].includes(e.target.id)) _renderCoachFeed();
});
document.addEventListener("change", (e) => {
  if (["rr-coach-filter-severity","rr-coach-filter-topic","rr-coach-filter-status","rr-coach-sort"].includes(e.target.id)) _renderCoachFeed();
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
    list.innerHTML = `<div style="padding:24px;color:var(--red);font-size:13px">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!rows || rows.length === 0) {
    list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-subtle);font-size:13px">No templates yet.</div>`;
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
      return `<div style="font-size:12px;color:var(--text-subtle);padding:8px 0">No attachments yet.</div>`;
    }
    return attachments.map((a, i) => `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;background:var(--canvas);border:1px solid var(--border);border-radius:8px;margin-top:6px">
        <div style="min-width:0">
          <div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(a.name || "attachment")}</div>
          <div style="font-size:10px;color:var(--text-subtle)">${a.content_type || ""} · ${a.size ? Math.round(a.size/1024)+" KB" : ""}</div>
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
          <h3 style="margin:0;font-size:17px;font-weight:600">${escapeHtml(RR_TEMPLATE_LABELS[t.key] || t.key)}</h3>
          <div style="font-size:11px;color:var(--text-subtle);margin-top:2px">${escapeHtml(t.key)} · ${t.channel}</div>
        </div>
        <button data-rr-msg-cancel style="background:none;border:0;font-size:20px;cursor:pointer;color:var(--text-muted)">×</button>
      </div>

      ${isEmail ? `
        <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Subject</label>
        <input data-rr-msg-subject class="form-input" style="width:100%;margin-bottom:14px" value="${escapeHtml(t.subject || "")}" />
      ` : ""}

      <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Body</label>
      <textarea data-rr-msg-body class="form-input" style="width:100%;min-height:160px;font-family:'SF Mono',Menlo,monospace;font-size:13px;line-height:1.5">${escapeHtml(t.body || "")}</textarea>
      <div style="font-size:11px;color:var(--text-subtle);margin-top:6px;line-height:1.5">
        Tokens: <code>{{first_name}}</code> · <code>{{link}}</code>. Paste any URL into the body — applicants tap it directly.
        ${!isEmail ? `<br/><strong style="color:var(--text-muted)">Keep SMS under 160 chars when possible</strong> — longer messages split into multiple texts.` : ""}
      </div>

      <div style="margin-top:18px">
        <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Attachments</label>
        <div style="font-size:11px;color:var(--text-subtle);margin-bottom:8px">
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
    else if (sub === "pipe-sub-screening")    loadScreeningQuestionsList();
    else if (sub === "pipe-sub-messages")     loadMessagesTab();
    else if (sub === "pipe-sub-referrals")    loadReferralsTab();
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

// Realtime subscriptions — one channel covers all the tables we care about.
sb.channel("rr-dashboard")
  .on("postgres_changes", { event: "*", schema: "public", table: "applicants" },          scheduleRefresh)
  .on("postgres_changes", { event: "*", schema: "public", table: "cal_events" },          scheduleRefresh)
  .on("postgres_changes", { event: "*", schema: "public", table: "sms_messages" },        scheduleRefresh)
  .on("postgres_changes", { event: "*", schema: "public", table: "email_messages" },      scheduleRefresh)
  .on("postgres_changes", { event: "*", schema: "public", table: "interview_outcomes" }, scheduleRefresh)
  .on("postgres_changes", { event: "*", schema: "public", table: "interview_days" },     scheduleRefresh)
  .on("postgres_changes", { event: "*", schema: "public", table: "drivers" },             scheduleRefresh)
  .on("postgres_changes", { event: "*", schema: "public", table: "coachings" },           scheduleRefresh)
  .on("postgres_changes", { event: "*", schema: "public", table: "driver_documents" },    scheduleRefresh)
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

  const nav = document.querySelector(".sidebar nav, nav.sidebar-nav, nav") || document.querySelector(".nav-item")?.parentElement;
  if (!nav) return;

  const byView = new Map();
  nav.querySelectorAll(".nav-item[data-view]").forEach(el => byView.set(el.getAttribute("data-view"), el));
  for (const view of order) {
    const el = byView.get(view);
    if (el) nav.appendChild(el);  // appendChild moves the existing node
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


// ─── Pin to Dashboard ─────────────────────────────────────────────────────
//
// Generalized pinning. Any element marked with the data attributes
//
//   data-rr-pinnable
//   data-rr-pin-kind="kpi" | "applicant" | "driver"
//   data-rr-pin-ref="<id-or-key>"
//   data-rr-pin-label="<friendly label>"
//
// becomes pinnable. Long-press (~500ms mousedown / touchstart) reveals
// a small floating "📌 Pin" button. Click it to pin / unpin. Pinned
// items render as cards on the Dashboard view.
//
// Storage: localStorage 'rr-pins-v2' = [{kind, ref, label}, …].
// Cross-device persistence (per app_user) lands in a follow-up.

const RR_PINS_KEY = "rr-pins-v2";
function readPins() {
  try { return JSON.parse(localStorage.getItem(RR_PINS_KEY) || "[]"); }
  catch { return []; }
}
function writePins(pins) {
  localStorage.setItem(RR_PINS_KEY, JSON.stringify(pins));
}
function isPinned(kind, ref) {
  return readPins().some(p => p.kind === kind && p.ref === ref);
}
function togglePin(kind, ref, label) {
  const pins = readPins();
  const idx = pins.findIndex(p => p.kind === kind && p.ref === ref);
  if (idx >= 0) pins.splice(idx, 1);
  else          pins.push({ kind, ref, label, pinned_at: new Date().toISOString() });
  writePins(pins);
  renderPinnedDashboard();
  return idx < 0;
}

let _pressTimer = null;
let _pressTarget = null;

function startPress(e, target) {
  _pressTarget = target;
  _pressTimer = setTimeout(() => {
    if (_pressTarget) showPinOverlay(_pressTarget);
  }, 500);
}
function cancelPress() {
  if (_pressTimer) { clearTimeout(_pressTimer); _pressTimer = null; }
  _pressTarget = null;
}

document.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  // Don't long-press on actual buttons / form fields inside pinnables.
  if (e.target.closest("button, input, select, textarea, a")) return;
  const target = e.target.closest("[data-rr-pinnable]");
  if (target) startPress(e, target);
});
document.addEventListener("mouseup", cancelPress);
document.addEventListener("mouseleave", cancelPress);
document.addEventListener("touchstart", (e) => {
  if (e.target.closest("button, input, select, textarea, a")) return;
  const target = e.target.closest("[data-rr-pinnable]");
  if (target) startPress(e, target);
}, { passive: true });
document.addEventListener("touchend", cancelPress);
document.addEventListener("touchcancel", cancelPress);

function showPinOverlay(target) {
  const kind  = target.getAttribute("data-rr-pin-kind");
  const ref   = target.getAttribute("data-rr-pin-ref");
  const label = target.getAttribute("data-rr-pin-label");
  if (!kind || !ref) return;

  // Remove any existing overlay.
  document.getElementById("rr-pin-overlay")?.remove();

  const rect = target.getBoundingClientRect();
  const pinned = isPinned(kind, ref);

  const ov = document.createElement("div");
  ov.id = "rr-pin-overlay";
  ov.style.cssText = `
    position:fixed; z-index:9998;
    left:${Math.min(rect.right - 180, window.innerWidth - 200)}px;
    top:${Math.max(8, rect.top - 44)}px;
    background:var(--surface); border:1px solid var(--border);
    border-radius:10px; padding:6px 6px 6px 10px;
    box-shadow:0 6px 20px rgba(0,0,0,.25);
    display:flex; align-items:center; gap:8px;
    animation:rr-pop .12s ease-out;
    font-size:12px;
  `;
  ov.innerHTML = `
    <button class="btn btn-sm btn-primary" data-rr-pin-confirm style="font-size:12px;display:flex;align-items:center;gap:6px;margin:0">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14l-1.5-3.5V8a5.5 5.5 0 0 0-11 0v5.5z"/></svg>
      ${pinned ? "Unpin" : "Pin to dashboard"}
    </button>
    <button data-rr-pin-cancel aria-label="Cancel" style="background:none;border:0;font-size:18px;line-height:1;padding:2px 6px;cursor:pointer;color:var(--text-muted)">×</button>`;
  document.body.appendChild(ov);

  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);

  ov.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.target.closest("[data-rr-pin-cancel]")) { close(); return; }
    if (e.target.closest("[data-rr-pin-confirm]")) {
      const nowPinned = togglePin(kind, ref, label);
      toast(nowPinned ? `Pinned "${label}"` : `Unpinned "${label}"`, "success");
      close();
    }
  });
}


// ─── Hover pin icon (the easy desktop path) ──────────────────────────────
//
// In addition to the long-press gesture, every pinnable element gets a
// small floating pin icon visible on hover. One click toggles. This is
// the primary desktop interaction; long-press is the touch fallback.

function ensurePinIcon(el) {
  if (el.querySelector(":scope > .rr-pin-icon")) return;
  const kind = el.getAttribute("data-rr-pin-kind");
  const ref  = el.getAttribute("data-rr-pin-ref");
  if (!kind || !ref) return;

  // Position the icon absolutely; only show on hover. Inline styles so
  // we don't need extra CSS edits in the static HTML.
  if (getComputedStyle(el).position === "static") el.style.position = "relative";
  const icon = document.createElement("button");
  icon.className = "rr-pin-icon";
  icon.type = "button";
  icon.setAttribute("aria-label", "Pin to dashboard");
  icon.setAttribute("title", "Pin to dashboard");
  icon.style.cssText = `
    position:absolute; top:6px; right:6px; z-index:5;
    background:var(--surface); border:1px solid var(--border);
    border-radius:6px; padding:4px;
    width:24px; height:24px; cursor:pointer;
    display:none; align-items:center; justify-content:center;
    color:var(--text-muted);
  `;
  icon.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14l-1.5-3.5V8a5.5 5.5 0 0 0-11 0v5.5z"/></svg>`;
  el.appendChild(icon);

  el.addEventListener("mouseenter", () => { icon.style.display = "flex"; updatePinIconState(icon, kind, ref); });
  el.addEventListener("mouseleave", () => { icon.style.display = "none"; });
  icon.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const lab = el.getAttribute("data-rr-pin-label");
    const nowPinned = togglePin(kind, ref, lab);
    updatePinIconState(icon, kind, ref);
    toast(nowPinned ? `Pinned "${lab}"` : `Unpinned "${lab}"`, "success");
  });
}

function updatePinIconState(icon, kind, ref) {
  const on = isPinned(kind, ref);
  icon.style.color      = on ? "var(--accent-text)" : "var(--text-muted)";
  icon.style.background = on ? "var(--accent-soft)" : "var(--surface)";
  icon.style.borderColor = on ? "var(--accent)"     : "var(--border)";
}

// Walk the DOM whenever a render changes things, to ensure all pinnable
// elements have their hover icon. MutationObserver handles dynamic
// renders (loadPipeline, loadDriversRoster, etc.).
function syncPinIcons() {
  document.querySelectorAll("[data-rr-pinnable]").forEach(ensurePinIcon);
}
syncPinIcons();
new MutationObserver(syncPinIcons).observe(document.body, { childList: true, subtree: true });


// ─── Dashboard pinned cards ──────────────────────────────────────────────

function renderPinnedDashboard() {
  const queue = document.getElementById("action-queue");
  if (!queue) return;
  // Wipe previously-rendered RR pinned cards (idempotent re-render).
  queue.querySelectorAll(".task-card.rr-pinned").forEach(c => c.remove());

  const pins = readPins();
  if (pins.length === 0) return;

  for (const p of pins) {
    const card = buildPinnedCard(p);
    if (card) queue.insertBefore(card, queue.firstChild);
  }
}

function buildPinnedCard(p) {
  const card = document.createElement("div");
  card.className = "task-card rr-pinned";
  card.dataset.sev = "info";
  card.dataset.rrPinKind = p.kind;
  card.dataset.rrPinRef  = p.ref;

  card.innerHTML = `
    <div class="task-tools">
      <button class="task-tool" type="button" aria-label="Unpin"
              onclick="event.stopPropagation();window.RR_unpin('${p.kind}','${p.ref}');">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="task-head">
      <div class="task-eyebrow">${p.kind === "kpi" ? "Pipeline KPI" : p.kind === "applicant" ? "Applicant" : p.kind === "driver" ? "Driver" : p.kind}</div>
      <div class="task-title">${escapeHtml(p.label || p.ref)}</div>
    </div>
    <div class="task-msg" data-rr-pin-body>Loading…</div>
  `;
  // Async hydrate the card body based on kind.
  hydratePinnedCard(card, p);
  return card;
}

window.RR_unpin = function (kind, ref) {
  const pins = readPins().filter(p => !(p.kind === kind && p.ref === ref));
  writePins(pins);
  renderPinnedDashboard();
  toast("Unpinned", "warn");
};

async function hydratePinnedCard(card, p) {
  const body = card.querySelector("[data-rr-pin-body]");
  if (!body) return;

  if (p.kind === "kpi") {
    const [{ data: k }, { data: f }] = await Promise.all([
      sb.rpc("pipeline_kpis",        { p_window_days: 28 }),
      sb.rpc("pipeline_funnel_kpis", { p_window_days: 28 }),
    ]);
    const map = {
      contacted_pct: f?.contacted_pct,
      passed_pct:    f?.passed_pct,
      booked_rate:   f?.booked_rate,
      e2e_pct:       f?.e2e_pct,
      show_rate:     k ? Math.round(Number(k.show_rate ?? 0) * 100) : 0,
      hire_rate:     k ? Math.round(Number(k.hire_rate ?? 0) * 100) : 0,
    };
    const v = map[p.ref];
    body.innerHTML = `<span style="font-size:32px;font-weight:700;color:var(--text);letter-spacing:-.02em">${v ?? "—"}%</span>`;
    return;
  }

  if (p.kind === "applicant") {
    const { data: a } = await sb.from("applicants")
      .select("id, full_name, status, phone, email")
      .eq("id", p.ref).maybeSingle();
    if (!a) { body.innerHTML = `<span style="color:var(--text-subtle)">Removed.</span>`; return; }
    body.innerHTML = `<strong>${escapeHtml(a.full_name)}</strong> · ${a.status}<br/><span style="color:var(--text-subtle);font-size:12px">${a.phone || a.email || ""}</span>`;
    return;
  }

  if (p.kind === "driver") {
    const { data: d } = await sb.from("drivers")
      .select("id, full_name, status, hire_date")
      .eq("id", p.ref).maybeSingle();
    if (!d) { body.innerHTML = `<span style="color:var(--text-subtle)">Removed.</span>`; return; }
    const days = d.hire_date ? Math.floor((Date.now() - new Date(d.hire_date).getTime()) / 86400000) : null;
    body.innerHTML = `<strong>${escapeHtml(displayDriverName(d))}</strong> · ${d.status}${days != null ? ` · ${days}d` : ""}`;
    return;
  }

  body.innerHTML = `<span style="color:var(--text-subtle)">Pinned (${p.kind})</span>`;
}

// Re-render pinned dashboard cards on dashboard view + on data change.
const _origRefresh = refreshActiveView;
function refreshWithPins() {
  _origRefresh();
  if (document.querySelector(".view.active")?.id === "view-dashboard") {
    renderPinnedDashboard();
    if (typeof loadDashboardTasks === "function") loadDashboardTasks();
    if (typeof loadDashboardWeather === "function") loadDashboardWeather();
  }
}
window.addEventListener("focus", () => {
  if (document.querySelector(".view.active")?.id === "view-dashboard") {
    renderPinnedDashboard();
    if (typeof loadDashboardTasks === "function") loadDashboardTasks();
    if (typeof loadDashboardWeather === "function") loadDashboardWeather();
    if (typeof loadTodayPlan === "function") loadTodayPlan();
  }
});

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

// Initial render on load.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", renderPinnedDashboard);
} else {
  renderPinnedDashboard();
}

// Pop animation
const _styleEl = document.createElement("style");
_styleEl.textContent = `@keyframes rr-pop{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:scale(1)}} [data-rr-pinnable]{user-select:none}
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
let _schedDriverSortBound = false;
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

  // Always anchor OKAMI to the actual current week so the 13-week planner
  // rolls forward as the calendar advances. Operator's schedule view has
  // prev/next navigation; OKAMI is always 'this week + 12'.
  _okamiStart = fmtIsoDate(startOfWeekMonday(new Date()));
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
      stratEl.innerHTML = `<span style="font-size:12px;color:var(--text-muted)">${text}</span>`;
    }

    const hireByEl = tdCells[6]?.querySelector(".plan-calc");
    if (hireByEl) {
      hireByEl.textContent = gap >= 0 ? "—" : fmtMD(hireBy);
    }

    const statusPill = tdCells[7]?.querySelector(".plan-status-pill");
    if (statusPill) {
      statusPill.classList.remove("ok", "warn", "bad");
      const text = gap >= 0 ? "On track" : (gap >= -10 ? "Tight" : "Critical");
      statusPill.outerHTML = `<span style="font-size:12px;color:var(--text-muted)">${text}</span>`;
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

  // Save plan button now triggers a full regenerate of schedule shifts
  // from the current OKAMI demand. Daily values auto-save in the
  // drilldown panel; this button is the explicit "sync schedule with
  // plan" action that also trims any drift.
  const saveBtn = document.getElementById("rr-okami-save-plan");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      const dspId = window.RR?.dsp?.id;
      if (!dspId) { _setOkamiSaveStatus("DSP not loaded", "warn"); return; }
      saveBtn.disabled = true;
      _setOkamiSaveStatus("Regenerating shifts…");
      try {
        const { data: rows, error } = await sb.from("okami_demand")
          .select("date, station_id")
          .eq("dsp_id", dspId);
        if (error) throw error;
        for (const r of (rows || [])) {
          const { error: gErr } = await sb.rpc("generate_shifts_for_date", { p_date: r.date, p_station_id: r.station_id });
          if (gErr) throw gErr;
        }
        _setOkamiSaveStatus(`Synced ${rows?.length || 0} day${rows?.length === 1 ? "" : "s"} ✓`, "ok");
        setTimeout(() => _setOkamiSaveStatus(""), 2500);
        await renderOkamiLive();
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

  container.innerHTML = `<div style="padding:18px;color:var(--text-subtle);font-size:12px">Loading…</div>`;

  // Pull demand grid + cushion recommendation + this week's waves in one go.
  // Waves come from scheduling_settings (per-week, with DSP-level fallback)
  // so the OKAMI panel always matches what Schedule will use.
  const [gridRes, recommendation, settingsRes] = await Promise.all([
    sb.rpc("okami_grid", { p_start: startIso, p_weeks: 1 }),
    recommendOkamiCushion(dspId),
    sb.rpc("scheduling_settings_for_week", { p_week_start: startIso }),
  ]);
  if (gridRes.error) {
    container.innerHTML = `<div style="padding:18px;color:var(--red);font-size:12px">Failed to load: ${escapeHtml(gridRes.error.message)}</div>`;
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
    activeTypes.push({ id: null, code: "SP", label: "Standard Parcel", color: "#3b82f6" });
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
      <div style="grid-column:1 / -1;display:flex;justify-content:space-between;font-size:11px;color:var(--text-subtle);padding:10px 4px 0">
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
    if (prev) clearTimeout(prev);
    _okamiDailySaveTimers.set(key, setTimeout(() => saveOkamiDaily(weekIdx, iso, parseInt(inp.value, 10) || 0, waveIdx, stId), 400));
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

async function saveOkamiDaily(weekIdx, iso, routes, waveIdx = 0, stId = null) {
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;
  if (!_okamiStations || _okamiStations.length === 0) {
    const { data, error } = await sb.from("stations")
      .select("id, code, active")
      .eq("dsp_id", dspId)
      .eq("active", true);
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
  const wavesEl  = document.getElementById("rr-set-waves");
  const statusEl = document.getElementById("rr-set-sched-status");

  if (blockEl)   blockEl.value   = s.default_block_hours ?? 10;
  if (cushEl)    cushEl.value    = s.cushion_pct ?? 10;
  if (maxDaysEl) maxDaysEl.value = s.max_days_per_week ?? 5;

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
      labelEl.style.display = "inline-block";
      labelEl.style.cursor = "default";
      labelEl.style.background = "transparent";
      labelEl.style.border = "0";
      labelEl.style.padding = "0";
      labelEl.style.color = "var(--text-subtle)";
      labelEl.style.fontWeight = "500";
      labelEl.textContent = total > 0
        ? `${rate.toFixed(1)}% absence · last 30d`
        : "No data yet";
      labelEl.title = total > 0
        ? `${absences} callouts + no-shows over ${total} scheduled shifts`
        : "Once you have a few weeks of attendance data we'll show it here";
    } catch (e) {
      console.warn("attendance rate label:", e);
    }
  })();
  const overrideEl = document.getElementById("rr-set-availability-override");
  if (overrideEl) overrideEl.checked = !!s.allow_availability_override;
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
    if (wrap) wrap.innerHTML = `<div style="font-size:11px;color:var(--red)">Failed to load: ${escapeHtml(error.message)}</div>`;
    return;
  }
  const types = data || [];
  _okamiServiceTypes = types;
  if (!wrap) return;
  wrap.innerHTML = types.map(t => `
    <div data-rr-st="${t.id}" style="display:flex;gap:10px;align-items:center;padding:6px 8px;background:var(--canvas);border-radius:6px">
      <input type="checkbox" data-rr-st-active ${t.active ? "checked" : ""} style="cursor:pointer" title="Active in OKAMI"/>
      <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${escapeHtml(t.color)};flex-shrink:0"></span>
      <strong style="font-size:12px;letter-spacing:.04em;width:42px">${escapeHtml(t.code)}</strong>
      <input type="text" data-rr-st-label class="form-input" value="${escapeHtml(t.label)}" style="flex:1;font-size:12px;height:28px"/>
    </div>`).join("");
}

function _renderWaveRow(start) {
  return `<div data-rr-wave style="display:flex;gap:6px;align-items:center">
    <input type="time" class="form-input" data-rr-wave-time value="${escapeHtml(start || "07:00")}" style="max-width:140px"/>
    <button type="button" class="btn btn-sm" data-rr-remove-wave style="color:var(--red)">Remove</button>
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

  // Remove a wave row.
  if (e.target.matches?.("[data-rr-remove-wave]")) {
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
    const allowOverride = !!document.getElementById("rr-set-availability-override")?.checked;
    const waves = Array.from(document.querySelectorAll("#rr-set-waves [data-rr-wave-time]"))
      .map(inp => ({ start: inp.value || "07:00" }))
      .filter(w => w.start);
    if (waves.length === 0) waves.push({ start: "07:00" });
    const tz = (Intl?.DateTimeFormat?.().resolvedOptions().timeZone) || "UTC";

    const status = document.getElementById("rr-set-sched-status");
    if (status) { status.style.color = "var(--text-subtle)"; status.textContent = "Saving for week…"; }

    const { error: upErr } = await sb.rpc("upsert_scheduling_settings", {
      p_payload: {
        week_start: _schedStart,
        default_block_hours: block,
        cushion_pct: cushion,
        max_days_per_week: maxDays,
        allow_availability_override: allowOverride,
        waves,
        timezone: tz,
      },
    });
    if (upErr) {
      if (status) { status.style.color = "var(--red)"; status.textContent = "Failed: " + upErr.message; }
      return;
    }
    if (status) status.textContent = "Saved · syncing this week…";

    const { error: regenErr } = await sb.rpc("regenerate_week_shifts", { p_week_start: _schedStart });
    if (regenErr) {
      if (status) { status.style.color = "var(--red)"; status.textContent = "Saved · sync failed: " + regenErr.message; }
      toast("Settings saved · sync failed: " + regenErr.message, "warn");
      return;
    }

    // Reconcile cushion shifts to match the saved cushion %. Adds EX rows
    // when % goes up; removes unassigned EX rows when % drops; deletes all
    // unassigned EX rows when % is 0. RPC + behavior live in migration 0040.
    let cushionDelta = 0;
    try {
      const { data, error: cushionErr } = await sb.rpc("apply_cushion_to_week", { p_week_start: _schedStart });
      if (cushionErr) {
        console.warn("apply_cushion_to_week:", cushionErr.message);
      } else {
        cushionDelta = data || 0;
      }
    } catch (e) {
      console.warn("apply_cushion_to_week threw:", e);
    }

    if (status) {
      status.style.color = "var(--green)";
      const cushionNote = cushionDelta !== 0 ? ` · cushion ${cushionDelta > 0 ? "+" : ""}${cushionDelta}` : "";
      status.textContent = `Saved for week of ${_schedStart} ✓${cushionNote}`;
    }
    setTimeout(() => { if (status) status.textContent = ""; }, 3000);
    toast("Scheduling settings saved for this week", "success");

    // Refresh schedule view if active.
    if (typeof renderScheduleWeek === "function") {
      const sub = document.getElementById("sched-sub-week");
      if (sub) renderScheduleWeek();
    }
    // Reload settings panel so the inheritance hint updates.
    loadSchedulingSettings();
    return;
  }
});

// ─── Schedule · Finalize-and-push + live-edit guard ────────────────────

function _updateFinalizeButton() {
  const btn = document.getElementById("schedule-cta");
  if (!btn) return;
  const isFinal = !!window._rrWeekFinalized;
  btn.innerHTML = isFinal
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Live · Unfinalize`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> Finalize &amp; push to drivers`;
  btn.style.background = isFinal ? "var(--green)" : "";
  btn.style.borderColor = isFinal ? "var(--green)" : "";
  btn.title = isFinal ? "This week is live · drivers see it" : "Push this week's schedule to drivers";
}

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
    wrap.innerHTML = `<div style="padding:14px;color:var(--red);font-size:13px">${escapeHtml(error.message)}</div>`;
    return;
  }
  const rows = data || [];
  if (rows.length === 0) {
    wrap.innerHTML = `<div style="padding:14px;color:var(--text-subtle);font-size:13px">No active stations.</div>`;
    return;
  }
  wrap.innerHTML = rows.map((s) => {
    const hasPin = s.latitude != null && s.longitude != null;
    const lat = s.latitude  != null ? Number(s.latitude).toFixed(6)  : "";
    const lng = s.longitude != null ? Number(s.longitude).toFixed(6) : "";
    return `
      <div class="station-geofence" data-rr-station-id="${escapeHtml(s.id)}" style="display:grid;grid-template-columns:120px 160px 160px 100px auto;gap:10px;padding:12px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--surface);margin-bottom:10px;align-items:end">
        <div>
          <label style="display:block;font-size:11px;font-weight:600;color:var(--text-subtle);margin-bottom:3px">Station</label>
          <div style="font-size:14px;font-weight:600">${escapeHtml(s.code)}</div>
          <div style="font-size:11px;color:var(--text-subtle);margin-top:1px">${hasPin ? "Pin set" : "No pin yet"}</div>
        </div>
        <div>
          <label style="display:block;font-size:11px;font-weight:600;color:var(--text-subtle);margin-bottom:3px">Latitude</label>
          <input class="rr-station-lat field" style="font-size:13px;padding:8px 10px" value="${escapeHtml(lat)}" placeholder="e.g. 40.712776"/>
        </div>
        <div>
          <label style="display:block;font-size:11px;font-weight:600;color:var(--text-subtle);margin-bottom:3px">Longitude</label>
          <input class="rr-station-lng field" style="font-size:13px;padding:8px 10px" value="${escapeHtml(lng)}" placeholder="e.g. -74.005974"/>
        </div>
        <div>
          <label style="display:block;font-size:11px;font-weight:600;color:var(--text-subtle);margin-bottom:3px">Radius (m)</label>
          <input class="rr-station-radius field" type="number" min="25" max="2000" style="font-size:13px;padding:8px 10px" value="${Number(s.geofence_radius_meters || 150)}"/>
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
    wrap.innerHTML = `<div style="padding:18px;color:var(--red);font-size:13px">Failed to load drivers: ${escapeHtml(drvRes.error.message)}</div>`;
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
    let color = "#22c55e", note = "";
    if (totalDrivers === 0) {
      color = "var(--text-muted)";
      note = "no roster";
      okDays.push(day);
    } else if (pct >= 75) {
      color = "#22c55e";
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
        <div style="font-size:12px;font-weight:600;color:var(--text)">${DOW_LABEL[day]}</div>
        <div style="background:var(--canvas);height:14px;border-radius:7px;overflow:hidden">
          <div style="background:${color};height:100%;width:${widthPct}%;transition:width .3s"></div>
        </div>
        <div style="font-size:13px;color:var(--text);font-variant-numeric:tabular-nums"><strong>${widthPct}%</strong> <span style="color:var(--text-subtle);font-size:11px">${avail}/${totalDrivers}</span></div>
        <div style="font-size:11px;color:var(--text-subtle)">${note}</div>
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
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:22px;max-width:560px;width:100%;font-size:13px;line-height:1.55;color:var(--text);max-height:80vh;overflow-y:auto">
      <h3 style="margin:0 0 14px;font-size:17px;font-weight:600">Availability insight · the math</h3>

      <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:.05em;text-transform:uppercase;margin-bottom:6px">Inputs</div>
      <div>Active roster: <strong>${m.totalDrivers}</strong> driver${m.totalDrivers === 1 ? "" : "s"}</div>
      <div>Without availability set: <strong>${m.driversWithoutAvailability}</strong></div>
      <div>Plan Pad: <strong>${m.padPct}%</strong> <span style="color:var(--text-subtle)">(from OKAMI)</span></div>
      <div>Horizon: next <strong>${m.horizonWeeks}</strong> weeks of OKAMI demand</div>

      <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:.05em;text-transform:uppercase;margin-top:14px;margin-bottom:6px">Per-day math</div>
      <div style="font-size:12px;color:var(--text-subtle);margin-bottom:6px">For each day, we count the active drivers whose availability includes that day, then divide by total active drivers.</div>
      <div style="font-family:ui-monospace,monospace;font-size:11px;background:var(--canvas);padding:8px 10px;border-radius:4px;color:var(--text)">% available = available_drivers ÷ total_active_drivers</div>
      <div style="font-size:11px;color:var(--text-subtle);margin-top:6px">Needed column shows OKAMI peak demand for context: <code>ceil(peak_routes × 2 × (1 + ${m.padPct}%))</code>.</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:10px">
        <thead>
          <tr>
            <th style="padding:6px 10px;text-align:left;background:var(--canvas);font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Day</th>
            <th style="padding:6px 10px;text-align:right;background:var(--canvas);font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Available</th>
            <th style="padding:6px 10px;text-align:right;background:var(--canvas);font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">% of roster</th>
            <th style="padding:6px 10px;text-align:right;background:var(--canvas);font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Needed</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>

      <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:.05em;text-transform:uppercase;margin-top:14px;margin-bottom:6px">Color thresholds</div>
      <div>· <strong style="color:#22c55e">Green</strong> = 75%+ of roster available</div>
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
      sub.innerHTML = `<div style="padding:48px;text-align:center;color:var(--red);font-size:13px">Couldn't render the schedule week.<br><small>${escapeHtml(e?.message || String(e))}</small></div>`;
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

  // Read the per-week settings (max days + override) so the cap and
  // override flag come from the visible week, not stale DSP metadata.
  let maxDays = 5;
  let allowOverride = false;
  try {
    const { data: ws } = await sb.rpc("scheduling_settings_for_week", { p_week_start: _schedStart });
    if (ws) {
      maxDays = Math.max(1, Math.min(7, ws.max_days_per_week ?? 5));
      allowOverride = !!ws.allow_availability_override;
    }
  } catch (_) { /* fall back to defaults */ }

  // Query shifts directly (instead of via schedule_grid) so we always get
  // the is_cushion column even on DBs that haven't run migration 0027.
  const [driversRes, ptoRes, shiftsRes] = await Promise.all([
    sb.from("drivers")
      .select("id, full_name, metadata, dl_expires_on")
      .eq("dsp_id", dspId)
      .eq("status", "active"),
    sb.from("time_off_requests")
      .select("driver_id, start_date, end_date")
      .eq("dsp_id", dspId)
      .eq("status", "approved")
      .lte("start_date", weekEndIso)
      .gte("end_date", _schedStart),
    sb.from("shifts")
      .select("id, date, station_id, driver_id, status, starts_at, ends_at, is_cushion")
      .eq("dsp_id", dspId)
      .gte("date", _schedStart)
      .lte("date", weekEndIso),
  ]);

  if (driversRes.error || shiftsRes.error) {
    console.warn("auto-assign load failed:", driversRes.error || shiftsRes.error);
    return { assigned: 0, skippedExpired: [] };
  }

  const drivers = driversRes.data || [];
  const pto     = ptoRes.data     || [];
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

  let assigned = 0;
  for (const sh of openShifts) {
    const dt = new Date(sh.date + "T12:00:00");
    const dow = DOW[dt.getDay()];

    // Try strict-availability candidates first; if override is allowed
    // and none match, fall through to "any active non-PTO driver".
    // Expired drivers_license blocks regardless of override.
    const baseFilter = (d) => {
      if (!driverLicenseOkForDate(d, sh.date)) return false;
      if (driverPtoDates.get(d.id)?.has(sh.date)) return false;
      if (driverShiftDates.get(d.id)?.has(sh.date)) return false;
      if ((driverShiftDates.get(d.id)?.size || 0) >= maxDays) return false;
      return true;
    };
    let candidates = drivers.filter(d => {
      const days = driverDaysOn(d.id, sh.date);
      if (!days.includes(dow)) return false;
      return baseFilter(d);
    });
    if (candidates.length === 0 && allowOverride) {
      candidates = drivers.filter(baseFilter);
    }


    if (candidates.length === 0) continue;

    candidates.sort((a, b) => {
      const ac = driverShiftDates.get(a.id)?.size || 0;
      const bc = driverShiftDates.get(b.id)?.size || 0;
      return ac - bc;
    });
    const driver = candidates[0];

    const { error } = await sb.rpc("assign_shift", { p_id: sh.id, p_driver_id: driver.id });
    if (error) continue;

    if (!driverShiftDates.has(driver.id)) driverShiftDates.set(driver.id, new Set());
    driverShiftDates.get(driver.id).add(sh.date);
    assigned += 1;
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

function _schedShiftChip(sh) {
  const r = sh.route_code ? escapeHtml(sh.route_code) : (sh.starts_at ? fmtTimeShort(sh.starts_at) : "shift");
  const time = (sh.starts_at && sh.ends_at) ? `${fmtTimeShort(sh.starts_at)} – ${fmtTimeShort(sh.ends_at)}` : "";
  const ex = sh.is_cushion
    ? `<span style="display:inline-block;background:#FEF3C7;color:#92400E;font-size:9px;font-weight:700;padding:0 4px;border-radius:3px;margin-left:4px;letter-spacing:.04em">EX</span>`
    : "";
  // Service-type badge — shown for any non-SP shift so an XL/HUB/ASU
  // shift is visually distinguishable. SP shifts (the default) get no
  // badge to keep the chip clean for single-type DSPs.
  const stCode = sh.service_type_code;
  const stColor = sh.service_type_color || "#3b82f6";
  const stBadge = (stCode && stCode !== "SP")
    ? `<span style="display:inline-block;background:${escapeHtml(stColor)}20;color:${escapeHtml(stColor)};font-size:9px;font-weight:700;padding:0 4px;border-radius:3px;margin-left:4px;letter-spacing:.04em" title="${escapeHtml(sh.service_type_label || stCode)}">${escapeHtml(stCode)}</span>`
    : "";
  const baseStyle = sh.is_cushion ? 'border-color:#FCD34D;' : '';
  return `<div class="shift-chip" data-rr-shift-id="${sh.id}" style="${baseStyle}cursor:pointer" title="Click to remove shift"><div class="shift-chip-route">${r}${ex}${stBadge}</div>${time ? `<div class="shift-chip-time">${time}</div>` : ""}</div>`;
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
      .select("id, full_name, first_name, last_name, preferred_name, status, station_id, hire_date, tier, metadata, dl_expires_on, station:station_id (code)")
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

  // Bind the driver-column sort dropdown once. Re-renders the schedule
  // when the operator changes mode without round-tripping the server.
  const sortSel = document.getElementById("rr-sched-driver-sort");
  if (sortSel) {
    sortSel.value = _schedDriverSort;
    if (!_schedDriverSortBound) {
      _schedDriverSortBound = true;
      sortSel.addEventListener("change", () => {
        _schedDriverSort = sortSel.value || "alpha";
        renderScheduleWeek();
      });
    }
  }

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
    if (sh.driver_id) {
      const k = `${sh.driver_id}|${sh.date}`;
      if (!shiftsByDriverDate.has(k)) shiftsByDriverDate.set(k, []);
      shiftsByDriverDate.get(k).push(sh);
      hoursPerDriver.set(sh.driver_id, (hoursPerDriver.get(sh.driver_id) || 0) + _shiftHours(sh));
      shiftCountPerDriver.set(sh.driver_id, (shiftCountPerDriver.get(sh.driver_id) || 0) + 1);
      const wIdx = Number.isFinite(sh.wave_index) ? sh.wave_index : 0;
      const wm = waveCountsPerDriver.get(sh.driver_id) || new Map();
      wm.set(wIdx, (wm.get(wIdx) || 0) + 1);
      waveCountsPerDriver.set(sh.driver_id, wm);
    } else {
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
  // needed comes from okami_grid (source of truth). filled is computed
  // CLIENT-SIDE from shifts assigned to drivers we actually render
  // (status='active'); the server's grid.filled also counts shifts
  // assigned to inactive / terminated drivers that don't appear in the
  // grid, which made coverage display ghost-filled cells.
  const visibleDriverIds = new Set(drivers.map(d => d.id));
  const coverageByDate = new Map();
  for (const c of (grid.coverage || [])) {
    const a = coverageByDate.get(c.date) || { needed: 0, filled: 0 };
    a.needed += (c.needed || 0);
    coverageByDate.set(c.date, a);
  }
  for (const sh of (grid.shifts || [])) {
    if (!sh.driver_id) continue;
    if (!visibleDriverIds.has(sh.driver_id)) continue;
    if (!["scheduled", "completed"].includes(sh.status)) continue;
    const a = coverageByDate.get(sh.date) || { needed: 0, filled: 0 };
    a.filled += 1;
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
  const wavesArr = (window.RR?.dsp?.metadata?.scheduling?.waves) || [{ start: "07:00" }];
  const waveCount = Math.max(1, wavesArr.length);
  const virtualByDate = new Map();
  for (const c of (grid.coverage || [])) {
    const k = `${c.date}|${c.station_id}`;
    const real = realOpenByDateStation.get(k) || 0;
    const filled = visibleFilledByDateStation.get(k) || 0;
    const v = Math.max(0, (c.needed || 0) - filled - real);
    if (v > 0) {
      const list = virtualByDate.get(c.date) || [];
      const startPos = (filled + real);
      for (let i = 0; i < v; i++) {
        const pos = startPos + i;
        const waveStart = wavesArr[pos % waveCount]?.start || "07:00";
        list.push({ station_id: c.station_id, station_code: c.station_code, wave_start: waveStart });
      }
      virtualByDate.set(c.date, list);
    }
  }
  let totalVirtual = 0;
  for (const list of virtualByDate.values()) totalVirtual += list.length;

  // ── Toolbar
  const labelEl = sub.querySelector(".sched-week-label");
  if (labelEl) {
    labelEl.textContent = `${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${weekEnd.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
  }
  const subLineEl = sub.querySelector(".sched-week-sub");
  if (subLineEl) {
    subLineEl.innerHTML = `<span style="color:var(--accent-text);cursor:pointer" data-rr-goto-okami>Adjust in OKAMI →</span>`;
  }

  // Page-sub line in the header (Schedule view) — replace the mockup
  // 'Week of May 1–7 · 78 drivers · ...' with live numbers.
  const pageSub = document.getElementById("rr-sched-page-sub");
  if (pageSub) {
    const wkRange = `${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${weekEnd.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    const finalPill = window._rrWeekFinalized
      ? `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--green);color:#fff;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:2px 8px;border-radius:10px;margin-left:8px;vertical-align:middle"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Live</span>`
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
      banner.style.cssText = "display:flex;align-items:center;gap:10px;background:rgba(34,197,94,.10);border:1px solid var(--green);border-left-width:4px;color:var(--green);font-weight:600;font-size:13px;padding:10px 14px;border-radius:8px;margin-bottom:var(--s-3)";
      banner.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        <span>This week is <strong>LIVE</strong> — drivers can see this schedule. Edits notify the affected drivers.</span>`;
      const toolbar = sub.querySelector(".sched-toolbar");
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

  let kpis = sub.querySelector("#rr-sched-kpis");
  if (!kpis) {
    kpis = document.createElement("div");
    kpis.id = "rr-sched-kpis";
    kpis.style.cssText = "display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin-bottom:var(--s-3)";
    const toolbar = sub.querySelector(".sched-toolbar");
    if (toolbar) toolbar.insertAdjacentElement("afterend", kpis);
  } else {
    kpis.style.gridTemplateColumns = "repeat(5,minmax(0,1fr))";
  }
  const kpiCard = (label, value, sublabel, tone) => {
    const c = tone === "bad" ? "var(--red)" : tone === "warn" ? "var(--amber)" : tone === "ok" ? "var(--green)" : "var(--text)";
    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 12px">
      <div style="font-size:10px;font-weight:600;color:var(--text-muted);letter-spacing:.06em;text-transform:uppercase">${label}</div>
      <div style="font-size:18px;font-weight:700;color:${c};letter-spacing:-.02em;margin-top:2px;line-height:1.2">${value}</div>
      <div style="font-size:11px;color:var(--text-subtle);margin-top:1px">${sublabel}</div>
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
    kpiCard("Rule violations", String(violations.length), violations.length === 0 ? "all clear" : "click to review", violationsTone);
  kpis.dataset.rrViolations = JSON.stringify(violations);

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
          status = `<div style="font-size:10px;font-weight:600;color:var(--green);margin-top:2px">✓ Complete</div>`;
        } else {
          const tone = c.filled === 0 ? "var(--red)" : "var(--amber)";
          status = `<div style="font-size:10px;font-weight:600;color:${tone};margin-top:2px">${c.filled} / ${c.needed}</div>`;
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
    const tier = d.tier ? `tier-${String(d.tier).toLowerCase()}` : "tier-c";
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
      ? `<span title="Driver's license expired ${new Date(d.dl_expires_on + "T12:00:00").toLocaleDateString()}" style="display:inline-flex;align-items:center;gap:3px;background:rgba(239,68,68,.12);color:#dc2626;font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;margin-left:6px;letter-spacing:.04em;vertical-align:middle"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>DL EXP</span>`
      : "";
    const cells = days.map(iso => {
      const cls = `cal-cell${iso === todayIso ? " today" : ""}`;
      const data = `data-rr-cell="driver-day" data-rr-cell-date="${iso}" data-rr-cell-driver="${d.id}"${d.station_id ? ` data-rr-cell-station="${d.station_id}"` : ""}`;
      if (ptoOn(d.id, iso))
        return `<div class="${cls}" ${data}><div class="shift-chip timeoff"><div class="shift-chip-route">PTO</div></div></div>`;
      const list = shiftsByDriverDate.get(`${d.id}|${iso}`) || [];
      if (list.length === 0)
        return `<div class="${cls}" ${data}><div class="shift-chip off">Off</div></div>`;
      return `<div class="${cls}" ${data}>${list.map(_schedShiftChip).join("")}</div>`;
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
          ? `<span style="display:inline-block;background:#FEF3C7;color:#92400E;font-size:9px;font-weight:700;padding:0 4px;border-radius:3px;margin-left:4px;letter-spacing:.04em">EX</span>`
          : "";
        const style = slot.is_cushion ? ' style="border-color:#FCD34D"' : "";
        return `<div class="${cls}" ${data}><div class="shift-chip open" data-rr-shift-id="${slot.shift_id}"${style}>+ ${escapeHtml(label)}${ex}</div></div>`;
      }
      const blockH = window.RR?.dsp?.metadata?.scheduling?.default_block_hours || 10;
      const vStart = fmtWaveTime(slot.wave_start);
      const vEnd   = fmtWaveTime(addHoursToWaveTime(slot.wave_start, blockH));
      const virtLabel = vStart && vEnd ? `${vStart} – ${vEnd}` : (vStart || "open");
      return `<div class="${cls}" ${data}><div class="shift-chip open" data-rr-virtual-station="${slot.station_id}" style="opacity:.65;border-style:dashed" title="From OKAMI demand · drag a driver to fill">+ ${escapeHtml(virtLabel)}</div></div>`;
    }).join("");
    const pdNum = r + 1;
    return `<div class="cal-grid" style="background:var(--canvas)">
      <div class="cal-row-label" style="background:var(--canvas)">
        <div class="avatar-sm" style="background:var(--canvas);color:var(--text-subtle);border:1.5px dashed var(--border-strong);font-weight:700;font-size:11px">PD</div>
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
    ? `<div style="padding:32px;text-align:center;color:var(--text-subtle);font-size:13px">No active drivers yet. <span style="color:var(--accent-text);cursor:pointer" data-rr-goto-drivers>Add drivers →</span></div>`
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
    if (!sh.virtual) return (sh.starts_at && sh.ends_at) ? `${fmtTimeShort(sh.starts_at)} – ${fmtTimeShort(sh.ends_at)}` : "";
    const block = (window.RR?.dsp?.metadata?.scheduling?.default_block_hours) || 10;
    const [h, m] = (sh.wave_start || "07:00").split(":").map(Number);
    const startMins = (h || 0) * 60 + (m || 0);
    const endMins = startMins + block * 60;
    const fmt = (mins) => {
      let hh = Math.floor(mins / 60) % 24;
      const mm = mins % 60;
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
      ? `<span style="display:inline-block;background:#FEF3C7;color:#92400E;font-size:9px;font-weight:700;padding:0 4px;border-radius:3px;margin-left:6px;letter-spacing:.04em">EX</span>`
      : "";
    const stCode = sh.service_type_code;
    const stColor = sh.service_type_color || "#3b82f6";
    const stBadge = (!sh.virtual && stCode && stCode !== "SP")
      ? `<span style="display:inline-block;background:${escapeHtml(stColor)}20;color:${escapeHtml(stColor)};font-size:9px;font-weight:700;padding:0 4px;border-radius:3px;margin-left:6px;letter-spacing:.04em" title="${escapeHtml(sh.service_type_label || stCode)}">${escapeHtml(stCode)}</span>`
      : "";
    const newTag = sh.virtual
      ? `<span style="display:inline-block;background:rgba(37,99,235,.12);color:var(--accent-text);font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;margin-left:6px;letter-spacing:.04em">OKAMI</span>`
      : "";
    const route = (!sh.virtual && sh.route_code) ? `<span style="font-weight:600">${escapeHtml(sh.route_code)}</span>` : "";
    const headLine = showDayLabel
      ? `<div style="font-size:12px;font-weight:600;color:var(--text)">${dayLabel(sh.date)}${ex}${stBadge}${newTag}</div>
         <div style="font-size:11px;color:var(--text-subtle);font-variant-numeric:tabular-nums">${time}${route ? ` · ${route}` : ""}</div>`
      : `<div style="font-size:12px;font-weight:600;color:var(--text);font-variant-numeric:tabular-nums">${time}${ex}${stBadge}${newTag}</div>${route ? `<div style="font-size:11px;color:var(--text-subtle)">${route}</div>` : ""}`;
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
    listHtml = '<div style="padding:14px;font-size:12px;color:var(--text-subtle);text-align:center">All shifts assigned</div>';
  } else if (_poolSortMode === "day") {
    const byDay = new Map();
    for (const sh of sorted) {
      if (!byDay.has(sh.date)) byDay.set(sh.date, []);
      byDay.get(sh.date).push(sh);
    }
    listHtml = Array.from(byDay.entries()).map(([d, list]) =>
      `<div style="margin-bottom:10px"><div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin:8px 0 6px">${dayLabel(d)} · ${list.length}</div>${list.map(sh => shiftItem(sh, { includeDay: false })).join("")}</div>`
    ).join("");
  } else {
    listHtml = sorted.map(shiftItem).join("");
  }

  const totalCount = sorted.length;
  const virtualCount = virtualChips.length;
  const countLabel = virtualCount > 0
    ? `${totalCount} open · ${virtualCount} from OKAMI`
    : `${totalCount} open`;

  const explainer = virtualCount > 0
    ? `<div style="font-size:11px;color:var(--text-subtle);line-height:1.4;background:var(--canvas);border-left:2px solid var(--accent);padding:6px 8px;margin-bottom:8px;border-radius:3px">
        Striped <strong style="color:var(--accent-text)">OKAMI</strong> chips are slots your demand plan needs but no shift row exists yet. Drag onto a driver's day cell to create + assign the shift on <em>that</em> day.
       </div>`
    : "";

  aside.innerHTML = `
    <div class="pool-head">
      <span>Open shifts</span>
      <span style="font-weight:600;letter-spacing:0;text-transform:none;color:var(--text-subtle);font-size:11px">${countLabel}</span>
    </div>
    ${explainer}
    ${virtualCount > 0 ? `<button type="button" id="rr-sync-to-okami"
      style="width:100%;margin-bottom:8px;padding:6px 10px;font-size:11px;font-weight:600;color:var(--accent-text);background:var(--accent-soft);border:1px solid var(--accent-soft);border-radius:6px;cursor:pointer"
      title="Create the ${virtualCount} OKAMI gap shifts as real (unassigned) rows so you can drag drivers onto them.">
      Sync to OKAMI · create ${virtualCount} missing shift${virtualCount === 1 ? "" : "s"}
    </button>` : ""}
    <button type="button" id="rr-unassign-week"
      style="width:100%;margin-bottom:8px;padding:6px 10px;font-size:11px;font-weight:600;color:var(--red);background:transparent;border:1px solid var(--border);border-radius:6px;cursor:pointer">
      Unassign all shifts this week
    </button>
    <div style="display:flex;gap:4px;background:var(--canvas);padding:3px;border-radius:6px;margin-bottom:8px">
      <button type="button" class="rr-pool-sort-btn" data-rr-pool-sort="day"
        style="flex:1;border:0;background:${_poolSortMode === 'day' ? 'var(--surface)' : 'transparent'};font:inherit;font-size:11px;font-weight:600;color:${_poolSortMode === 'day' ? 'var(--text)' : 'var(--text-muted)'};padding:5px 8px;border-radius:4px;cursor:pointer">Day</button>
      <button type="button" class="rr-pool-sort-btn" data-rr-pool-sort="wave"
        style="flex:1;border:0;background:${_poolSortMode === 'wave' ? 'var(--surface)' : 'transparent'};font:inherit;font-size:11px;font-weight:600;color:${_poolSortMode === 'wave' ? 'var(--text)' : 'var(--text-muted)'};padding:5px 8px;border-radius:4px;cursor:pointer">Wave time</button>
    </div>
    <div>${listHtml}</div>
    ${(() => {
      const ptoDrivers = drivers.filter(d => ptoByDriver?.has(d.id));
      if (ptoDrivers.length === 0) return "";
      const item = (d) => {
        const t = (ptoByDriver.get(d.id) || [])[0];
        const range = t ? `PTO ${t.start_date.slice(5)}–${t.end_date.slice(5)}` : "Off";
        return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:11px;color:var(--text-subtle)"><span>${escapeHtml(displayDriverName(d))}</span><span style="margin-left:auto">${escapeHtml(range)}</span></div>`;
      };
      return `<div style="margin-top:14px;border-top:1px solid var(--border);padding-top:10px">
        <div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px">PTO this week</div>
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
    const arrow = e.target.closest(".sched-week-arrow");
    if (arrow) {
      const arrows = sub.querySelectorAll(".sched-week-nav .sched-week-arrow");
      const isPrev = arrows[0] === arrow;
      const cur = new Date((_schedStart || fmtIsoDate(startOfWeekMonday(new Date()))) + "T12:00:00");
      _schedStart = fmtIsoDate(addDays(cur, isPrev ? -7 : 7));
      renderScheduleWeek();
      loadSchedulingSettings();
      return;
    }
    const todayBtn = e.target.closest(".sched-week-nav .btn");
    if (todayBtn && todayBtn.textContent.trim() === "Today") {
      _schedStart = fmtIsoDate(startOfWeekMonday(new Date()));
      renderScheduleWeek();
      loadSchedulingSettings();
      return;
    }
    if (e.target.closest("[data-rr-goto-okami]"))   { if (typeof window.goto === "function") window.goto("okami"); return; }
    if (e.target.closest("[data-rr-goto-drivers]")) { if (typeof window.goto === "function") window.goto("drivers"); return; }

    // Click an ASSIGNED shift chip (not open, off, or timeoff) → confirm + delete.
    const assignedChip = e.target.closest(".shift-chip[data-rr-shift-id]");
    if (assignedChip
        && !assignedChip.classList.contains("open")
        && !assignedChip.classList.contains("off")
        && !assignedChip.classList.contains("timeoff")) {
      e.stopPropagation();
      const id = assignedChip.dataset.rrShiftId;
      if (!id) return;
      if (!_confirmLiveScheduleEdit()) return;
      if (!confirm("Remove this shift?")) return;
      sb.from("shifts").delete().eq("id", id).then(({ error }) => {
        if (error) { toast("Delete failed: " + error.message, "warn"); return; }
        toast("Shift removed", "success");
        renderScheduleWeek();
      });
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
      ? '<div style="padding:24px;text-align:center;color:var(--text-subtle)">No rule violations this week ✓</div>'
      : v.map(x => `<div style="padding:10px 14px;border-top:1px solid var(--border);display:flex;gap:12px;align-items:center"><div style="flex:1"><div style="font-size:13px;font-weight:600">${escapeHtml(x.driver)}</div><div style="font-size:11px;color:var(--text-subtle)">${escapeHtml(x.note)}</div></div><span style="font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--red)">${x.kind.replace(/_/g, " ")}</span></div>`).join("");
    m.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;max-width:540px;width:100%;max-height:80vh;overflow-y:auto">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid var(--border)">
          <div><div style="font-size:14px;font-weight:600">Rule violations</div><div style="font-size:12px;color:var(--text-subtle)">${v.length} this week</div></div>
          <button type="button" id="rr-vio-close" style="background:none;border:0;font-size:22px;cursor:pointer;color:var(--text-muted);padding:0 6px">×</button>
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

  // ── Sync to OKAMI: materialize all virtual gaps in one shot.
  sub.addEventListener("click", async (e) => {
    if (e.target.id !== "rr-sync-to-okami") return;
    e.preventDefault();
    if (!_confirmLiveScheduleEdit()) return;
    e.target.disabled = true;
    e.target.textContent = "Syncing…";
    const { error } = await sb.rpc("regenerate_week_shifts", { p_week_start: _schedStart });
    if (error) {
      e.target.disabled = false;
      toast("Sync failed: " + error.message, "warn");
      return;
    }
    toast("Schedule synced to OKAMI demand", "success");
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
    : sb.from("shifts").select("id, date, starts_at, ends_at, block_hours").eq("id", shiftId).single();

  const [drvRes, ptoRes, shiftsRes, candidateRes] = await Promise.all([
    sb.from("drivers").select("id, full_name, metadata, dl_expires_on").eq("id", driverId).single(),
    sb.from("time_off_requests").select("start_date, end_date")
      .eq("dsp_id", dspId).eq("driver_id", driverId).eq("status", "approved")
      .lte("start_date", weekEndIso).gte("end_date", _schedStart),
    sb.from("shifts").select("id, date, status, driver_id, starts_at, ends_at, block_hours")
      .eq("dsp_id", dspId).eq("driver_id", driverId)
      .gte("date", _schedStart).lte("date", weekEndIso),
    candidateFetch,
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
      <h3 style="margin:0 0 14px;font-size:17px;font-weight:600">Add shift</h3>
      <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Date</label>
      <input type="date" id="rr-sh-date" class="form-input" style="width:100%;margin-bottom:10px" value="${date}"/>
      <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Driver (optional · leave blank for open shift)</label>
      <select id="rr-sh-driver" class="form-input" style="width:100%;margin-bottom:10px">
        <option value="">— Open shift —</option>
        ${_schedDriverList.map(d => `<option value="${d.id}"${prefDriverId === d.id ? " selected" : ""}>${escapeHtml(displayDriverName(d))}</option>`).join("")}
      </select>
      <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Route</label>
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
  m.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px";
  m.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;max-width:380px;width:100%">
      <h3 style="margin:0 0 14px;font-size:17px;font-weight:600">Assign shift</h3>
      <select id="rr-as-driver" class="form-input" style="width:100%;margin-bottom:14px">
        ${_schedDriverList.map(d => `<option value="${d.id}">${escapeHtml(displayDriverName(d))}</option>`).join("")}
      </select>
      <div style="display:flex;gap:8px;justify-content:flex-end">
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
      <h3 style="margin:0;font-size:15px;font-weight:600">Time off</h3>
      <button class="btn btn-sm btn-primary" data-rr-add-time-off>+ Add request</button>
    </div>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">
      <div style="padding:8px 14px;background:var(--canvas);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Pending (${pending.length})</div>
      ${pending.length === 0 ? `<div style="padding:18px;text-align:center;color:var(--text-subtle);font-size:13px">No pending requests.</div>` : pending.map(timeOffRow).join("")}
      <div style="padding:8px 14px;background:var(--canvas);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted);border-top:1px solid var(--border)">Past (${past.length})</div>
      ${past.length === 0 ? `<div style="padding:18px;text-align:center;color:var(--text-subtle);font-size:13px">No past requests.</div>` : past.map(timeOffRow).join("")}
    </div>`;
}

function timeOffRow(r) {
  const range = r.start_date === r.end_date
    ? new Date(r.start_date + "T12:00:00").toLocaleDateString()
    : `${new Date(r.start_date + "T12:00:00").toLocaleDateString()} → ${new Date(r.end_date + "T12:00:00").toLocaleDateString()}`;
  const statusColor = {
    pending:   "color:#B45309",
    approved:  "color:var(--green)",
    denied:    "color:var(--red)",
    cancelled: "color:var(--text-subtle)",
  }[r.status];
  return `
    <div style="display:grid;grid-template-columns:1fr 1fr 100px 1fr auto;gap:10px;align-items:center;padding:10px 14px;border-top:1px solid var(--border)">
      <div><div style="font-size:13px;font-weight:600">${escapeHtml(r.drivers?.full_name || "—")}</div></div>
      <div style="font-size:12px">${range}</div>
      <div style="font-size:11px;font-weight:700;${statusColor};text-transform:uppercase">${r.status}</div>
      <div style="font-size:12px;color:var(--text-subtle)">${escapeHtml(r.reason || "")}</div>
      <div>${r.status === "pending" ? `
        <button class="btn btn-sm" data-rr-time-off-decide="${r.id}" data-decision="approve">Approve</button>
        <button class="btn btn-sm" data-rr-time-off-decide="${r.id}" data-decision="deny" style="color:var(--red)">Deny</button>
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
      <h3 style="margin:0 0 14px;font-size:17px;font-weight:600">Time off request</h3>
      <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Driver</label>
      <select id="rr-to-driver" class="form-input" style="width:100%;margin-bottom:10px">
        ${_schedDriverList.map(d => `<option value="${d.id}">${escapeHtml(displayDriverName(d))}</option>`).join("")}
      </select>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <div><label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Start</label><input type="date" id="rr-to-start" class="form-input" style="width:100%"/></div>
        <div><label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">End</label><input type="date" id="rr-to-end" class="form-input" style="width:100%"/></div>
      </div>
      <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Reason</label>
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
    sub.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-subtle);font-size:13px"><strong style="color:var(--text-muted);display:block;margin-bottom:4px">No open shifts</strong>Add shifts from the Week view, or leave the driver picker blank when adding to create one.</div>`;
    return;
  }
  sub.innerHTML = `
    <h3 style="margin:0 0 var(--s-3);font-size:15px;font-weight:600">Open shifts (${rows.length})</h3>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">
      <div style="display:grid;grid-template-columns:130px 90px 1fr 100px;gap:10px;padding:8px 14px;background:var(--canvas);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">
        <div>Date</div><div>Station</div><div>Route</div><div></div>
      </div>
      ${rows.map(r => `
        <div style="display:grid;grid-template-columns:130px 90px 1fr 100px;gap:10px;align-items:center;padding:10px 14px;border-top:1px solid var(--border)">
          <div style="font-size:13px;font-weight:600">${new Date(r.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</div>
          <div style="font-size:13px">${escapeHtml(r.station?.code || "—")}</div>
          <div style="font-size:13px;font-family:'SF Mono',Menlo,monospace;color:var(--text-muted)">${escapeHtml(r.route_code || "—")}</div>
          <div><button class="btn btn-sm btn-primary" data-rr-shift-id="${r.id}">Assign</button></div>
        </div>`).join("")}
    </div>`;
}


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
    // subnav-item in document order so the operator lands on the
    // primary sub-view of every sidebar function.
    const firstSub = activeView.querySelector(".subnav .subnav-item, .subnav-item");
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

// drSub wrap — when the operator clicks Drivers → Attendance from
// the subnav, reset the att-tabstrip to its first tab so they don't
// land on whatever they had open last.
const _origDrSubForSubReset = window.drSub;
if (typeof _origDrSubForSubReset === "function") {
  window.drSub = function (sub) {
    const r = _origDrSubForSubReset(sub);
    if (sub === "attendance") {
      setTimeout(() => {
        const strip = document.getElementById("rr-att-tabstrip");
        if (!strip) return;
        const first = strip.querySelector("[data-att]");
        if (first && !first.classList.contains("active")) first.click();
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
      list.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-subtle);font-size:12px;border:1px dashed var(--border);border-radius:var(--r-md)">No blackouts yet. Click "+ Add blackout" to enter one.</div>`;
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
  for (const id of target) bar.appendChild(byId.get(id));
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
