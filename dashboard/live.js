// Live data layer for the operator dashboard.
//
// The mockup HTML is the visual frame. live.js takes over once the page
// loads: requires auth, then hands the pipeline view real data via the
// pipeline_list / pipeline_counts RPCs, and rewires paAction(...) to
// call send_screening_link / send_booking_link / decline_applicant.
//
// Other tabs still show mockup data — they get wired up in follow-ups.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

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

// ─── Tiny DOM helpers ──────────────────────────────────────────────────────
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

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
    primaryBtn = `<button class="pa-disp-btn ghost" type="button" disabled>${when}</button>`;
  }

  const videoBtn = a.video_url
    ? `<button class="pa-disp-btn ghost" type="button" data-rr-action="play_video" data-video-url="${encodeURI(a.video_url)}">▶ Intro video</button>`
    : "";

  return `
    <div class="pa-card" data-stage="${stage}" data-applicant="${a.id}" data-applicant-slug="${slug}">
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
  if (view === "pipeline") loadPipeline(getActiveStage());
  if (view === "drivers")  loadDriversRoster();
};


// ─── Drivers roster ────────────────────────────────────────────────────────
//
// Replaces the mockup roster rows with live rows from public.drivers.
// Records are minimal today (name, contact, station, hire_date, status)
// so the columns the mockup defined for Score / Attendance / Coach show
// "—" until a future migration fills them in.

async function loadDriversRoster() {
  const tbody = document.getElementById("drivers-tbody");
  if (!tbody) return;

  const { data: rows, error } = await sb.from("drivers")
    .select("id, full_name, first_name, last_name, email, phone, status, hire_date, tier, score, station:station_id (code)")
    .eq("dsp_id", window.RR.dsp.id)
    .order("hire_date", { ascending: false })
    .limit(500);

  // Update the four mini-stat tiles at the top of the roster, regardless
  // of whether rows came back, so cleared data shows zeros.
  refreshDriverStatRow(rows ?? []);

  if (error) {
    tbody.innerHTML = `<tr><td colspan="8" style="padding:24px;text-align:center;color:var(--red);font-size:13px">${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  if (!rows || rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="padding:48px;text-align:center;color:var(--text-subtle);font-size:13px"><strong style="color:var(--text-muted);display:block;margin-bottom:4px">No drivers yet</strong>When you mark an applicant Hired in Interview Day, they show up here.</td></tr>`;
    // Reset the stage tab counts.
    document.querySelectorAll('.dr-subview .stage-tab .stage-tab-count').forEach(el => el.textContent = "0");
    return;
  }

  tbody.innerHTML = rows.map(renderDriverRow).join("");

  // Update the stage-tab counts on the drivers subview if those tabs exist.
  const counts = { active: 0, onboarding: 0, atrisk: 0, inactive: 0 };
  for (const r of rows) {
    if (counts[r.status] != null) counts[r.status]++;
    else if (r.status === "leave" || r.status === "terminated") counts.inactive++;
  }
  Object.entries(counts).forEach(([stage, n]) => {
    const el = document.querySelector(`.dr-subview .stage-tab[data-stage="${stage}"] .stage-tab-count`);
    if (el) el.textContent = n;
  });
}

function renderDriverRow(d) {
  const initials = (d.full_name || "").split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
  const tier = d.tier ? `tier-${String(d.tier).toLowerCase()}` : "tier-c";
  const tenure = d.hire_date ? tenureLabel(d.hire_date) : "—";
  const station = d.station?.code || "—";
  const contact = d.phone || d.email || "";
  const statusBadge = renderDriverStatusBadge(d.status);
  return `
    <tr data-driver-id="${d.id}">
      <td><div class="cell-driver"><div class="avatar-sm ${tier}">${initials}</div>
        <div><div class="cell-name">${escapeHtml(d.full_name ?? "")}</div>
        <div class="cell-name-sub">${escapeHtml(contact)}</div></div></div></td>
      <td>${escapeHtml(station)}</td>
      <td>${tenure}</td>
      <td>—</td>
      <td>—</td>
      <td>${statusBadge}</td>
      <td class="cell-time">—</td>
      <td></td>
    </tr>`;
}

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

  // "At risk" doesn't have a model yet — show 0 placeholder.
  const tiles = document.querySelectorAll(".driver-stat-row .stat-mini");
  if (tiles.length >= 4) {
    setStatTile(tiles[0], "Active",  counts.active,  `${counts.onboarding} onboarding · ${inactiveTotal} inactive`);
    setStatTile(tiles[1], "Avg score", avgScore,     "Per-driver score, latest");
    setStatTile(tiles[2], "At risk", 0,              "Below threshold");
    setStatTile(tiles[3], "Coached this week", coachedCount ?? 0, "From the coachings log");
  }
}

function setStatTile(tile, label, value, sub) {
  tile.querySelector(".stat-mini-label").textContent = label;
  tile.querySelector(".stat-mini-value").textContent = value;
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
// Replaces the mockup's hardcoded W19–W23 labels with current ISO week +
// next four. Demand/supply numbers stay TBD until OKAMI lands; we just
// render the week labels so the strip starts from the current week.

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function renderWeeksStrip() {
  const strip = document.getElementById("hp-weeks-strip");
  if (!strip) return;
  const today = new Date();
  const weeks = [];
  for (let i = 0; i < 5; i++) {
    const dt = new Date(today.getTime() + i * 7 * 86400000);
    weeks.push({ n: isoWeek(dt) });
  }
  strip.innerHTML = `
    <span class="hp-weeks-strip-label">Next 5 wk</span>
    ${weeks.map(w => `
      <span class="hp-week-cell"><span class="wk">W${w.n}</span> <span style="color:var(--text-subtle)">— / —</span></span>
    `).join("")}`;
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

  const loc = locations[0] || { type: "inPerson", address: "" };
  const isVideo = (loc.type || "").startsWith("integrations:") || loc.type === "link";
  const locDetail = loc.address || loc.link || "";

  const tzOptions = (CAL_TZS.includes(tz) ? CAL_TZS : [tz, ...CAL_TZS])
    .map(z => `<option value="${z}" ${z === tz ? "selected" : ""}>${z.replace("_"," ")}</option>`)
    .join("");

  const dayRows = Array.from({ length: 7 }, (_, d) => renderDayRow(d, perDay[d])).join("");

  card.innerHTML = `
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
          <option value="inPerson" ${!isVideo ? "selected" : ""}>In-person address</option>
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
  } else if (locType === "inPerson" && locDetail) {
    locations.push({ type: "inPerson", address: locDetail, displayLocationPublicly: true });
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
  await loadCalBookingsList();
}

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
document.addEventListener("click", async (e) => {
  const tgBtn = e.target.closest("[data-rr-video-toggle]");
  if (tgBtn) {
    e.preventDefault();
    e.stopImmediatePropagation();
    tgBtn.classList.toggle("on");
    return;
  }
  const saveBtn = e.target.closest("[data-rr-video-save]");
  if (saveBtn) {
    e.preventDefault();
    e.stopImmediatePropagation();
    saveBtn.disabled = true;
    try { await saveVideoScreeningSettings(); }
    finally { saveBtn.disabled = false; }
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

  let m = document.getElementById("rr-msg-modal");
  if (m) m.remove();
  m = document.createElement("div");
  m.id = "rr-msg-modal";
  m.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px";
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

      <label style="display:flex;align-items:center;gap:10px;margin:14px 0 4px"><input type="checkbox" data-rr-msg-active ${t.active !== false ? "checked" : ""}/>Active (used for outgoing sends)</label>

      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px">
        <button class="btn" data-rr-msg-cancel>Cancel</button>
        <button class="btn btn-primary" data-rr-msg-save>Save</button>
      </div>
    </div>`;
  document.body.appendChild(m);

  m.addEventListener("click", async (e) => {
    if (e.target.closest("[data-rr-msg-cancel]")) { m.remove(); return; }
    if (e.target.closest("[data-rr-msg-save]")) {
      const body = m.querySelector("[data-rr-msg-body]").value;
      if (!body.trim()) { toast("Body is required", "warn"); return; }
      const subject = isEmail ? m.querySelector("[data-rr-msg-subject]").value : t.subject;
      const active = m.querySelector("[data-rr-msg-active]").checked;
      const { error } = await sb.from("message_templates")
        .update({ body, subject, active })
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
