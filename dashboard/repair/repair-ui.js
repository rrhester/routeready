// ─── repair-ui.js · Repair Center — top-level dashboard view ───────────────
//
// Owns the whole Repair Center page (#view-repair). Loaded as a module
// from index.html (the parts-ui.js pattern), dispatched by live.js's
// goto() wrapper via window.RRRepair.loadView(). Uses the shared
// window.sb client and the pure repair-engine for every status /
// timer / money decision — no business math in the render layer.
//
// Phase 2 surface (repair-case foundation):
//   · summary pill strip (repair_center_summary RPC)
//   · Overview: needs-attention list + live activity feed
//   · Repair Queue: filterable case table
//   · case drawer: header, facts, stage actions, timeline, attachments
//   · new-case modal (vehicle picker prefilled from Fleet, grounding
//     writes through the sanctioned Fleet path server-side)
//   · log-update modal (phone/email/note entries onto the timeline)
//   · return-to-service confirm
//
// All case/shop text is escaped; success feedback follows the repo's
// Saved-chip convention (success toasts are swallowed by design —
// only warn/danger surface).
import {
  STAGES, STAGE_LABEL, STAGE_TONE, isOpenStage,
  AVAILABILITY_LABEL, AVAILABILITY_TONE,
  SHOP_STATUS_LABEL, SHOP_STATUS_TONE, CATEGORY_OPTIONS,
  msBetween, formatDuration, daysDown, daysDownTone, promiseState, downSince,
  formatCents, attentionScore, filterQueue, sortQueue,
  formatWhen, formatDay, vehicleShortDesc,
} from "./repair-engine.js";

(() => {
  "use strict";
  if (window.RRRepair) return;

  const S = {
    booted: false,
    loading: false,
    sub: "overview",
    rows: [],
    summary: null,
    activity: [],
    vehicles: [],          // fleet roster cache for the new-case picker
    filters: { search: "", stage: "", station: "", grounded: false, overdue: false, openOnly: true },
    drawerCase: null,
  };

  const sb = () => window.sb;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const el = (id) => document.getElementById(id);
  const nowIso = () => new Date().toISOString();
  const say = (msg, kind) => { if (typeof window.toast === "function") window.toast(msg, kind); };
  const fail = (prefix, error) => {
    console.warn(`[repair] ${prefix}:`, error);
    say(`${prefix} · ${error?.message || "try again"}`, "danger");
  };

  // ── tiny render helpers ──────────────────────────────────────────────
  const stagePill = (stage) =>
    `<span class="status-pill rp-pill-${esc(STAGE_TONE[stage] || "neutral")}">${esc(STAGE_LABEL[stage] || stage)}</span>`;

  const shopStatusPill = (st) => st
    ? `<span class="status-pill rp-pill-${esc(SHOP_STATUS_TONE[st] || "neutral")}">${esc(SHOP_STATUS_LABEL[st] || st)}</span>`
    : "";

  const availDot = (row) => {
    const a = row.availability || "in_service";
    const tone = AVAILABILITY_TONE[a] || "n";
    return `<span class="rp-ost rp-ost-${tone}"><span class="rp-ost-dot"></span>${esc(AVAILABILITY_LABEL[a] || a)}</span>`;
  };

  const downBadge = (row) => {
    const since = downSince(row);
    if (!since) return "";
    const d = daysDown(since, nowIso());
    const tone = daysDownTone(d);
    const title = `Out of service ${formatDuration(msBetween(since, nowIso()))}`;
    return `<span class="rp-days${tone ? ` rp-days-${tone}` : ""}" title="${esc(title)}">${d}d</span>`;
  };

  const promiseCell = (row) => {
    const p = promiseState(row, nowIso());
    if (p.state === "none") return `<span class="rp-muted">—</span>`;
    const day = formatDay(p.dueIso);
    if (p.state === "overdue") {
      return `<span class="rp-promise-overdue">${esc(day)} · missed</span>`
        + (row.revised_completion_at ? "" : `<span class="rp-cell-sub">${esc(formatDuration(p.overdueMs))} over</span>`);
    }
    if (p.state === "met") return `<span>${esc(day)}</span><span class="rp-cell-sub">met</span>`;
    if (p.state === "due_soon") return `<span class="rp-promise-soon">${esc(day)}</span><span class="rp-cell-sub">due soon</span>`;
    return `<span>${esc(day)}</span>`;
  };

  const moneyCell = (row) => {
    if (row.approved_total_cents != null) {
      return `<span class="rp-strong">${esc(formatCents(row.approved_total_cents))}</span><span class="rp-cell-sub">approved</span>`;
    }
    if (row.estimate_total_cents != null) {
      return `<span>${esc(formatCents(row.estimate_total_cents))}</span><span class="rp-cell-sub">estimate</span>`;
    }
    return `<span class="rp-muted">—</span>`;
  };

  // ── data loads ───────────────────────────────────────────────────────
  async function loadView(force) {
    if (S.loading) return;
    S.loading = true;
    try {
      const [list, summary] = await Promise.all([
        sb().rpc("repair_cases_list", { p_open_only: S.filters.openOnly }),
        sb().rpc("repair_center_summary"),
      ]);
      if (list.error) throw list.error;
      S.rows = Array.isArray(list.data) ? list.data : [];
      S.summary = summary.error ? null : summary.data;
      renderAll();
      loadActivity(); // deliberately not awaited — the queue paints first
      if (!S.booted) { S.booted = true; wireOnce(); }
    } catch (error) {
      fail("Couldn't load repair cases", error);
      const tbody = el("rr-repair-tbody");
      if (tbody) tbody.innerHTML = `<tr><td colspan="10" class="rp-table-empty rp-error">Couldn't load repair cases · ${esc(error?.message || "try again")}</td></tr>`;
      const att = el("rr-repair-attention");
      if (att) att.innerHTML = `<tr><td class="rp-table-empty rp-error">Couldn't load repair cases · ${esc(error?.message || "try again")}</td></tr>`;
    } finally {
      S.loading = false;
    }
  }

  async function loadActivity() {
    const host = el("rr-repair-activity");
    if (!host) return;
    const { data, error } = await sb()
      .from("repair_case_events")
      .select("id, repair_case_id, kind, message, previous_value, new_value, source, created_at")
      .order("created_at", { ascending: false })
      .limit(12);
    if (error) {
      host.innerHTML = `<div class="rp-table-empty">Couldn't load activity.</div>`;
      return;
    }
    S.activity = data || [];
    renderActivity();
  }

  async function loadVehicles() {
    if (S.vehicles.length) return S.vehicles;
    const { data, error } = await sb().rpc("vehicles_roster");
    if (error) { fail("Couldn't load the van roster", error); return []; }
    S.vehicles = (Array.isArray(data) ? data : [])
      .filter((v) => v.status !== "retired")
      .sort((a, b) => String(a.nickname || a.name).localeCompare(String(b.nickname || b.name)));
    return S.vehicles;
  }

  // ── render ───────────────────────────────────────────────────────────
  function renderAll() {
    paintSummary();
    renderAttention();
    renderQueue();
    paintStationFilter();
  }

  function paintSummary() {
    const strip = el("rr-repair-sum");
    if (!strip) return;
    const s = S.summary;
    if (!s) { strip.hidden = true; return; }
    const pill = (val, label, tone, sub) => `
      <div class="rp-kpi-pill" role="listitem">
        ${tone ? `<span class="rp-kpi-dot rp-kpi-dot-${tone}"></span>` : ""}
        <span class="rp-kpi-value">${esc(val)}</span>
        <span class="rp-kpi-name">${esc(label)}</span>
        ${sub ? `<span class="rp-kpi-sub">${esc(sub)}</span>` : ""}
      </div>`;
    const oldest = s.grounded_oldest_at
      ? `oldest ${formatDuration(msBetween(s.grounded_oldest_at, nowIso()))}` : "";
    strip.innerHTML =
      pill(s.open_cases ?? 0, "Open cases", "b")
      + pill(s.grounded ?? 0, "Grounded", s.grounded > 0 ? "r" : "g", oldest)
      + pill(s.needs_review ?? 0, "Needs review", s.needs_review > 0 ? "a" : "")
      + pill(s.quoting ?? 0, "Quoting", "")
      + pill(s.awaiting_approval ?? 0, "Awaiting approval", s.awaiting_approval > 0 ? "a" : "")
      + pill(s.scheduled ?? 0, "Scheduled", "")
      + pill(s.at_shop ?? 0, "At shop", "b", s.waiting_on_parts > 0 ? `${s.waiting_on_parts} on parts` : "")
      + pill(s.past_promise ?? 0, "Past promise", s.past_promise > 0 ? "r" : "g")
      + pill(s.ready_for_pickup ?? 0, "Ready for pickup", s.ready_for_pickup > 0 ? "g" : "")
      + pill(formatCents(s.approved_total_cents ?? 0), "Approved spend", "", "open cases")
      + pill(formatCents(s.estimate_total_cents ?? 0), "Est. exposure", "", "unapproved");
    strip.hidden = false;

    const cov = el("rr-repair-coverage");
    if (cov) {
      const out = (s.at_shop ?? 0) + (s.ready_for_pickup ?? 0);
      el("rr-repair-cov-num").textContent = String(out);
      const sub = el("rr-repair-cov-sub");
      if (s.past_promise > 0) {
        sub.textContent = `${s.past_promise} past promised completion`;
        sub.className = "rp-ab-coverage-sub rp-cov-bad";
      } else {
        sub.textContent = out > 0 ? "all within promise" : "no vans at shops";
        sub.className = "rp-ab-coverage-sub rp-cov-ok";
      }
      cov.hidden = false;
    }
    const cnt = el("rr-repair-tab-count");
    if (cnt) { cnt.textContent = String(s.open_cases ?? 0); cnt.hidden = !(s.open_cases > 0); }
  }

  function vehicleCell(row) {
    return `<div class="rp-veh">
      <span class="rp-veh-un">${esc(row.vehicle_nickname || row.vehicle_name || "—")}</span>
      <span class="rp-veh-sub">${esc([vehicleShortDesc(row), row.station_code].filter(Boolean).join(" · "))}</span>
    </div>`;
  }

  function renderAttention() {
    const tbody = el("rr-repair-attention");
    if (!tbody) return;
    const open = S.rows.filter((r) => isOpenStage(r.stage));
    if (!open.length) {
      tbody.innerHTML = `<tr><td class="rp-table-empty">No open repair cases — fleet is clean. Open one with <strong>New repair case</strong>, or convert a driver report from Fleet → Issues.</td></tr>`;
      return;
    }
    const top = sortQueue(open, nowIso(), "attention")
      .filter((r) => attentionScore(r, nowIso()) > 0)
      .slice(0, 6);
    if (!top.length) {
      tbody.innerHTML = `<tr><td class="rp-table-empty">Nothing needs attention right now.</td></tr>`;
      return;
    }
    tbody.innerHTML = top.map((r) => {
      const p = promiseState(r, nowIso());
      let headline; let sub;
      if (p.state === "overdue") {
        headline = "Promised completion passed";
        sub = [r.vendor_name, r.current_delay_reason].filter(Boolean).join(" · ") || r.title;
      } else if (r.stage === "awaiting_approval") {
        headline = "Awaiting approval";
        sub = r.title;
      } else if (r.stage === "ready_for_pickup") {
        headline = "Ready for pickup";
        sub = [r.vendor_name, r.title].filter(Boolean).join(" · ");
      } else if (r.stage === "reported" || r.stage === "review") {
        headline = "New report needs review";
        sub = r.title;
      } else {
        headline = STAGE_LABEL[r.stage] || r.stage;
        sub = r.title;
      }
      return `<tr class="rp-caserow" data-rp-case="${esc(r.id)}">
        <td>${vehicleCell(r)}</td>
        <td><span class="rp-strong">${esc(headline)}</span><span class="rp-cell-sub">${esc(sub || "")}</span></td>
        <td>${p.state === "overdue" ? `<span class="status-pill rp-pill-bad">Overdue</span>` : availDot(r)}</td>
        <td class="num">${downBadge(r) || `<span class="rp-muted">—</span>`}</td>
      </tr>`;
    }).join("");
  }

  function renderActivity() {
    const host = el("rr-repair-activity");
    if (!host) return;
    if (!S.activity.length) {
      host.innerHTML = `<div class="rp-table-empty">Case activity will appear here.</div>`;
      return;
    }
    const byCase = new Map(S.rows.map((r) => [r.id, r]));
    host.innerHTML = `<div class="rp-tl">` + S.activity.map((e) => {
      const c = byCase.get(e.repair_case_id);
      const who = c ? `${c.case_number} · ${c.vehicle_nickname || c.vehicle_name || ""}` : "";
      const tone = e.kind === "grounded" ? "r"
        : (e.kind === "returned_to_service" || e.kind === "ungrounded") ? "g"
        : (e.kind === "stage_changed" || e.kind === "created") ? "b" : "n";
      const label = e.kind === "stage_changed" && e.new_value
        ? `${STAGE_LABEL[e.new_value] || e.new_value}`
        : (e.message || e.kind);
      return `<div class="rp-tl-item rp-tl-${tone}${c ? " rp-caserow" : ""}" ${c ? `data-rp-case="${esc(c.id)}"` : ""}>
        <span class="rp-tl-dot"></span>
        <div class="rp-tl-body">
          <div class="rp-tl-title">${esc(label)}</div>
          <div class="rp-tl-sub">${esc([who, e.source !== "dsp" ? e.source : ""].filter(Boolean).join(" · "))}</div>
          <div class="rp-tl-when">${esc(formatWhen(e.created_at, nowIso()))}</div>
        </div>
      </div>`;
    }).join("") + `</div>`;
  }

  function paintStationFilter() {
    const sel = el("rr-repair-f-station");
    if (!sel) return;
    const stations = [...new Set(S.rows.map((r) => r.station_code).filter(Boolean))].sort();
    const current = S.filters.station;
    sel.innerHTML = `<option value="">Station: All</option>`
      + stations.map((s) => `<option value="${esc(s)}"${s === current ? " selected" : ""}>${esc(s)}</option>`).join("");
    const stageSel = el("rr-repair-f-stage");
    if (stageSel && stageSel.options.length <= 1) {
      stageSel.innerHTML = `<option value="">Stage: All</option>`
        + STAGES.filter(isOpenStage).map((s) =>
          `<option value="${esc(s)}">${esc(STAGE_LABEL[s])}</option>`).join("");
    }
  }

  function renderQueue() {
    const tbody = el("rr-repair-tbody");
    if (!tbody) return;
    const f = S.filters;
    const rows = sortQueue(filterQueue(S.rows, {
      search: f.search, stage: f.stage, station: f.station,
      groundedOnly: f.grounded, overdueOnly: f.overdue,
      openOnly: f.openOnly, nowIso: nowIso(),
    }), nowIso(), "attention");

    if (!rows.length) {
      const filtered = f.search || f.stage || f.station || f.grounded || f.overdue;
      tbody.innerHTML = `<tr><td colspan="10" class="rp-table-empty">${
        filtered ? "No repair cases match the current filters." :
        "No open repair cases — fleet is clean."}</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map((r) => {
      const shop = r.vendor_name
        ? `<span class="rp-strong">${esc(r.vendor_name)}</span>${r.shop_work_order_number || r.ro_code
            ? `<span class="rp-cell-sub rp-mono">${esc(r.shop_work_order_number ? `WO ${r.shop_work_order_number}` : r.ro_code)}</span>` : ""}`
        : `<span class="rp-muted">—</span>`;
      const stageSub = r.shop_status && r.stage === "at_shop" ? shopStatusPill(r.shop_status) : "";
      return `<tr class="rp-caserow" data-rp-case="${esc(r.id)}">
        <td class="rp-mono">${esc(r.case_number.replace(/^RC-\d{4}-/, "RC-"))}</td>
        <td>${vehicleCell(r)}</td>
        <td><span class="rp-strong">${esc(r.title)}</span><span class="rp-cell-sub">${esc([r.category, r.component].filter(Boolean).join(" · "))}</span></td>
        <td>${stageSub || stagePill(r.stage)}</td>
        <td>${availDot(r)}</td>
        <td>${shop}</td>
        <td>${promiseCell(r)}</td>
        <td class="num">${downBadge(r) || `<span class="rp-muted">—</span>`}</td>
        <td class="num">${moneyCell(r)}</td>
        <td class="rp-when">${esc(formatWhen(r.updated_at, nowIso()))}</td>
      </tr>`;
    }).join("");
  }

  // ── sub-view switching ───────────────────────────────────────────────
  function sub(name) {
    S.sub = name;
    document.querySelectorAll("#rr-repair-viewseg .rr-viewseg-btn").forEach((b) => {
      const on = b.getAttribute("data-sub") === name;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll("#view-repair .rp-sub").forEach((d) => {
      d.classList.toggle("active", d.id === `rp-sub-${name}`);
    });
  }

  // ── case drawer ──────────────────────────────────────────────────────
  async function openCase(caseId) {
    closeDrawer();
    const { data, error } = await sb().rpc("repair_case_get", { p_id: caseId });
    if (error || !data) { fail("Couldn't open the case", error || { message: "not found" }); return; }
    S.drawerCase = data;
    drawCaseDrawer(data);
  }

  function drawerFacts(c) {
    const v = c.vehicle || {};
    const facts = [
      ["Vehicle", `${v.year || ""} ${v.make || ""} ${v.model || ""}`.trim() || v.name || "—"],
      ["Unit", v.nickname || v.name || "—"],
      ["Station", v.station_code || "—"],
      ["VIN", v.vin ? `…${String(v.vin).slice(-8)}` : "—"],
      ["Odometer", c.odometer != null ? Number(c.odometer).toLocaleString("en-US") : (v.mileage != null ? Number(v.mileage).toLocaleString("en-US") : "—")],
      ["Category", [c.category, c.component].filter(Boolean).join(" · ") || "—"],
      ["Severity", c.severity || "—"],
      ["Reported", formatWhen(c.reported_at, nowIso())],
      ["Shop", c.vendor?.name || "—"],
      ["RO", c.ro?.code || "—"],
      ["WO #", c.visit?.shop_work_order_number || "—"],
      ["Promised", c.visit ? formatDay(c.visit.revised_completion_at || c.visit.promised_completion_at) : "—"],
      ["Needed by", formatDay(c.required_completion_at)],
      ["Approved", c.approved_total_cents != null ? formatCents(c.approved_total_cents) : "—"],
      ["Estimate", c.estimate_total_cents != null ? formatCents(c.estimate_total_cents) : "—"],
    ];
    return facts.map(([k, val]) =>
      `<div class="rp-fact"><span class="rp-fact-k">${esc(k)}</span><span class="rp-fact-v">${esc(val)}</span></div>`).join("");
  }

  function drawerTimeline(c) {
    const events = c.events || [];
    if (!events.length) return `<div class="rp-table-empty">No activity yet.</div>`;
    return `<div class="rp-tl">` + events.map((e) => {
      const tone = e.kind === "grounded" ? "r"
        : (e.kind === "returned_to_service" || e.kind === "ungrounded") ? "g"
        : (e.kind === "stage_changed" || e.kind === "created" || e.kind === "ro_linked") ? "b" : "n";
      const title = e.kind === "stage_changed" && e.new_value
        ? `Stage → ${STAGE_LABEL[e.new_value] || e.new_value}${e.message && e.message !== "Stage changed" ? ` — ${e.message}` : ""}`
        : (e.message || e.kind);
      const src = e.source && e.source !== "dsp" ? ` · via ${e.source.replace(/_/g, " ")}` : "";
      return `<div class="rp-tl-item rp-tl-${tone}">
        <span class="rp-tl-dot"></span>
        <div class="rp-tl-body">
          <div class="rp-tl-title">${esc(title)}</div>
          <div class="rp-tl-when">${esc(formatWhen(e.created_at, nowIso()))}${esc(e.actor_name ? ` · ${e.actor_name}` : "")}${esc(src)}</div>
        </div>
      </div>`;
    }).join("") + `</div>`;
  }

  function drawerAttachments(c) {
    const list = c.attachments || [];
    const items = list.map((a) => `
      <div class="rp-att" data-rp-att-path="${esc(a.storage_path)}" data-rp-att-bucket="${esc(a.storage_bucket)}" role="button" tabindex="0" title="Open ${esc(a.file_name)}">
        <span class="rp-att-name">${esc(a.file_name)}</span>
        <span class="rp-att-sub">${esc([a.attachment_type.replace(/_/g, " "), formatDay(a.created_at)].join(" · "))}</span>
      </div>`).join("");
    return `${items || `<div class="rp-table-empty rp-att-none">No attachments yet.</div>`}
      <label class="rp-att-add">
        <input type="file" id="rr-rp-att-input" multiple hidden>
        <span class="rp-link-btn">+ Add photos or documents</span>
      </label>`;
  }

  function stageActions(c) {
    const next = Array.isArray(c.allowed_next_stages) ? c.allowed_next_stages : [];
    const btns = [];
    for (const s of next) {
      if (s === "cancelled" || s === "returned") continue; // dedicated affordances
      btns.push(`<button type="button" class="rp-btn" data-rp-stage="${esc(s)}">${esc(STAGE_LABEL[s] || s)}</button>`);
    }
    if (next.includes("returned") || c.stage === "quality_check" || c.stage === "ready_for_pickup") {
      btns.push(`<button type="button" class="rp-btn rp-btn-primary" data-rp-return>Return to service…</button>`);
    }
    if (next.includes("cancelled")) {
      btns.push(`<button type="button" class="rp-btn rp-btn-danger" data-rp-stage="cancelled">Cancel case</button>`);
    }
    return btns.join("");
  }

  function drawCaseDrawer(c) {
    injectCss();
    const wrap = document.createElement("div");
    wrap.id = "rr-rp-drawer";
    const grounded = c.availability === "grounded" || c.vehicle?.operational_status === "grounded";
    const since = downSince({ ...c, grounded_since: c.grounded_since, dropped_off_at: c.visit?.dropped_off_at });
    const d = since ? daysDown(since, nowIso()) : null;
    const p = promiseState(c.visit, nowIso());
    wrap.innerHTML = `
      <div class="rp-drawer-scrim" data-rp-close></div>
      <aside class="rp-drawer-panel" role="dialog" aria-modal="true" aria-label="${esc(c.case_number)}">
        <header class="rp-drawer-head">
          <div class="rp-drawer-title">
            <span class="rp-mono rp-drawer-num">${esc(c.case_number)}</span>
            <h3>${esc(c.title)}</h3>
            <div class="rp-drawer-pills">
              ${c.visit?.shop_status && c.stage === "at_shop" ? shopStatusPill(c.visit.shop_status) : stagePill(c.stage)}
              ${grounded ? `<span class="rp-ost rp-ost-r"><span class="rp-ost-dot"></span>Grounded</span>` : availDot(c)}
              ${d != null ? `<span class="rp-days${daysDownTone(d) ? ` rp-days-${daysDownTone(d)}` : ""}">${d}d down</span>` : ""}
            </div>
          </div>
          <button type="button" class="rp-drawer-x" data-rp-close aria-label="Close">✕</button>
        </header>
        ${p.state === "overdue" ? `<div class="rp-callout rp-callout-bad">Promised completion passed ${esc(formatDay(p.dueIso))}${esc(c.visit?.current_delay_reason ? ` — ${c.visit.current_delay_reason}` : "")}.</div>` : ""}
        ${c.limitation_note ? `<div class="rp-callout rp-callout-warn">Limited use: ${esc(c.limitation_note)}</div>` : ""}
        <div class="rp-drawer-body">
          ${c.description ? `<p class="rp-drawer-desc">${esc(c.description)}</p>` : ""}
          <div class="rp-facts">${drawerFacts(c)}</div>
          <div class="rp-drawer-actions">${stageActions(c)}
            <button type="button" class="rp-btn" data-rp-log>Log update…</button>
            ${!c.ro ? `<button type="button" class="rp-btn" data-rp-link-ro>Open RO</button>` : ""}
            ${typeof window.openFleetDrawer === "function" ? `<button type="button" class="rp-btn" data-rp-fleet>Fleet record</button>` : ""}
          </div>
          <h4 class="rp-drawer-h4">Attachments</h4>
          <div class="rp-atts" id="rr-rp-atts">${drawerAttachments(c)}</div>
          <h4 class="rp-drawer-h4">Timeline</h4>
          ${drawerTimeline(c)}
        </div>
      </aside>`;
    document.body.appendChild(wrap);

    wrap.addEventListener("click", async (e) => {
      if (e.target.closest("[data-rp-close]")) { closeDrawer(); return; }
      const stageBtn = e.target.closest("[data-rp-stage]");
      if (stageBtn) { await doSetStage(c.id, stageBtn.getAttribute("data-rp-stage")); return; }
      if (e.target.closest("[data-rp-return]")) { await doReturnToService(c); return; }
      if (e.target.closest("[data-rp-log]")) { openLogModal(c.id); return; }
      if (e.target.closest("[data-rp-link-ro]")) { await doLinkRo(c.id); return; }
      if (e.target.closest("[data-rp-fleet]")) { closeDrawer(); window.openFleetDrawer(c.vehicle?.id); return; }
      const att = e.target.closest("[data-rp-att-path]");
      if (att) { await openAttachment(att.getAttribute("data-rp-att-bucket"), att.getAttribute("data-rp-att-path")); return; }
      if (e.target.closest(".rp-att-add .rp-link-btn")) { el("rr-rp-att-input")?.click(); }
    });
    const fileInput = wrap.querySelector("#rr-rp-att-input");
    if (fileInput) fileInput.addEventListener("change", () => uploadAttachments(c, fileInput.files));
    document.addEventListener("keydown", drawerEsc);
  }

  function drawerEsc(e) { if (e.key === "Escape") closeDrawer(); }
  function closeDrawer() {
    document.removeEventListener("keydown", drawerEsc);
    el("rr-rp-drawer")?.remove();
    S.drawerCase = null;
  }

  async function refreshDrawer(caseId) {
    await loadView(true);
    if (caseId) await openCase(caseId);
  }

  // ── actions ──────────────────────────────────────────────────────────
  async function doSetStage(caseId, stage) {
    let note = null;
    if (stage === "cancelled") {
      const ok = typeof window._rrConfirmDialog === "function"
        ? await window._rrConfirmDialog({ title: "Cancel this repair case?", body: "The case is kept for history but leaves the queue. The vehicle's status is not changed.", confirmLabel: "Cancel case" })
        : window.confirm("Cancel this repair case?");
      if (!ok) return;
    }
    const { error } = await sb().rpc("repair_case_set_stage", { p_id: caseId, p_stage: stage, p_note: note });
    if (error) { fail("Couldn't change the stage", error); return; }
    say("Stage updated");
    await refreshDrawer(caseId);
  }

  async function doReturnToService(c) {
    const current = c.odometer ?? c.vehicle?.mileage ?? "";
    const raw = window.prompt("Return to service — current odometer (leave blank to skip):", current);
    if (raw === null) return;
    const odo = raw.trim() === "" ? null : parseInt(raw.replace(/[^\d]/g, ""), 10);
    if (raw.trim() !== "" && !Number.isFinite(odo)) { say("Odometer must be a number", "warn"); return; }
    const { error } = await sb().rpc("repair_case_return_to_service", {
      p_id: c.id, p_odometer: odo, p_note: null, p_close: true,
    });
    if (error) { fail("Couldn't return the vehicle to service", error); return; }
    say("Vehicle returned to service");
    closeDrawer();
    await loadView(true);
  }

  async function doLinkRo(caseId) {
    const { error } = await sb().rpc("repair_case_link_ro", { p_case_id: caseId });
    if (error) { fail("Couldn't open the repair order", error); return; }
    say("Repair order linked");
    await refreshDrawer(caseId);
  }

  async function openAttachment(bucket, path) {
    const { data, error } = await sb().storage.from(bucket || "repair-attachments").createSignedUrl(path, 1800);
    if (error || !data?.signedUrl) { fail("Couldn't open the file", error || { message: "no url" }); return; }
    window.open(data.signedUrl, "_blank", "noopener");
  }

  async function uploadAttachments(c, files) {
    if (!files || !files.length) return;
    const dspId = window.RR?.dsp?.id;
    if (!dspId) { say("Couldn't resolve your workspace — reload and try again", "danger"); return; }
    for (const file of files) {
      if (file.size > 100 * 1024 * 1024) { say(`${file.name} is over 100 MB`, "warn"); continue; }
      const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(0, 120);
      const path = `${dspId}/${c.id}/${Date.now()}-${safeName}`;
      const up = await sb().storage.from("repair-attachments").upload(path, file, { upsert: false });
      if (up.error) { fail(`Couldn't upload ${file.name}`, up.error); continue; }
      const kind = /^image\//.test(file.type) ? "damage_photo"
        : /pdf$/.test(file.type) ? "estimate" : "other";
      const reg = await sb().rpc("repair_case_attachment_add", {
        p_case_id: c.id, p_storage_path: path, p_file_name: file.name,
        p_mime_type: file.type || null, p_byte_size: file.size,
        p_attachment_type: kind, p_shop_visible: false,
      });
      if (reg.error) { fail(`Couldn't attach ${file.name}`, reg.error); continue; }
    }
    say("Attachments added");
    await refreshDrawer(c.id);
  }

  // ── log-update modal ─────────────────────────────────────────────────
  function openLogModal(caseId) {
    injectCss();
    el("rr-rp-modal")?.remove();
    const wrap = document.createElement("div");
    wrap.id = "rr-rp-modal";
    wrap.innerHTML = `
      <div class="rp-modal-scrim" data-rp-mclose></div>
      <div class="rp-modal-card" role="dialog" aria-modal="true" aria-label="Log update">
        <header class="rp-modal-head"><h3>Log update</h3><button type="button" class="rp-drawer-x" data-rp-mclose aria-label="Close">✕</button></header>
        <div class="rp-modal-body">
          <label class="rp-field"><span>How did it arrive?</span>
            <select id="rr-rp-log-source" class="rp-input">
              <option value="phone">Phone call</option>
              <option value="dsp" selected>Internal note</option>
              <option value="email">Email (logged manually)</option>
              <option value="driver">Driver</option>
            </select>
          </label>
          <label class="rp-field"><span>Update</span>
            <textarea id="rr-rp-log-msg" class="rp-input rp-input-ta" rows="4" placeholder="e.g. Shop called — parts arrive Wednesday, revised completion Thursday EOD"></textarea>
          </label>
        </div>
        <footer class="rp-modal-foot">
          <button type="button" class="rp-btn" data-rp-mclose>Cancel</button>
          <button type="button" class="rp-btn rp-btn-primary" data-rp-log-save>Add to timeline</button>
        </footer>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener("click", async (e) => {
      if (e.target.closest("[data-rp-mclose]")) { wrap.remove(); return; }
      if (e.target.closest("[data-rp-log-save]")) {
        const msg = el("rr-rp-log-msg").value.trim();
        if (!msg) { say("Write the update first", "warn"); return; }
        const source = el("rr-rp-log-source").value;
        const { error } = await sb().rpc("repair_case_log_event", {
          p_case_id: caseId, p_kind: source === "phone" ? "shop_update" : "note",
          p_message: msg, p_source: source, p_visible_to_shop: false,
        });
        if (error) { fail("Couldn't log the update", error); return; }
        wrap.remove();
        say("Update logged");
        await refreshDrawer(caseId);
      }
    });
    el("rr-rp-log-msg")?.focus();
  }

  // ── new-case modal ───────────────────────────────────────────────────
  async function newCase(vehicleId) {
    injectCss();
    el("rr-rp-modal")?.remove();
    const vehicles = await loadVehicles();
    const wrap = document.createElement("div");
    wrap.id = "rr-rp-modal";
    const opts = vehicles.map((v) => {
      const label = [v.nickname || v.name,
        [v.year ? `'${String(v.year).slice(-2)}` : "", v.make || "", v.model || ""].join(" ").trim()]
        .filter(Boolean).join(" · ");
      return `<option value="${esc(v.id)}"${v.id === vehicleId ? " selected" : ""}>${esc(label)}${v.operational_status === "grounded" ? " — grounded" : ""}</option>`;
    }).join("");
    wrap.innerHTML = `
      <div class="rp-modal-scrim" data-rp-mclose></div>
      <div class="rp-modal-card rp-modal-wide" role="dialog" aria-modal="true" aria-label="New repair case">
        <header class="rp-modal-head"><h3>New repair case</h3><button type="button" class="rp-drawer-x" data-rp-mclose aria-label="Close">✕</button></header>
        <div class="rp-modal-body">
          <div class="rp-form-grid">
            <label class="rp-field rp-span2"><span>Vehicle <em>*</em></span>
              <select id="rr-rp-nc-vehicle" class="rp-input">${opts || `<option value="">No vans found</option>`}</select>
            </label>
            <label class="rp-field rp-span2"><span>Issue title <em>*</em></span>
              <input id="rr-rp-nc-title" class="rp-input" type="text" maxlength="140" placeholder="e.g. Sliding door cable snapped — door won't latch">
            </label>
            <label class="rp-field"><span>Category</span>
              <select id="rr-rp-nc-category" class="rp-input">
                ${CATEGORY_OPTIONS.map((cat) => `<option value="${esc(cat)}">${esc(cat[0].toUpperCase() + cat.slice(1))}</option>`).join("")}
              </select>
            </label>
            <label class="rp-field"><span>Severity</span>
              <select id="rr-rp-nc-severity" class="rp-input">
                <option value="low">Low</option>
                <option value="medium" selected>Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </label>
            <label class="rp-field rp-span2"><span>What's wrong?</span>
              <textarea id="rr-rp-nc-desc" class="rp-input rp-input-ta" rows="3" placeholder="Symptoms, when it started, warning lights, driver notes…"></textarea>
            </label>
            <label class="rp-field"><span>Safe to operate?</span>
              <select id="rr-rp-nc-safety" class="rp-input">
                <option value="safe" selected>Yes</option>
                <option value="limited">With limits</option>
                <option value="unsafe">No — ground it</option>
              </select>
            </label>
            <label class="rp-field"><span>Odometer</span>
              <input id="rr-rp-nc-odo" class="rp-input" type="text" inputmode="numeric" placeholder="mi">
            </label>
            <label class="rp-field rp-span2" id="rr-rp-nc-limit-wrap" hidden><span>Limitation note (dispatch sees this)</span>
              <input id="rr-rp-nc-limit" class="rp-input" type="text" maxlength="200" placeholder="e.g. No highway routes; brake noise worsens when loaded">
            </label>
            <label class="rp-field"><span>Needed back by</span>
              <input id="rr-rp-nc-needed" class="rp-input" type="date">
            </label>
            <label class="rp-field"><span>Towing needed?</span>
              <select id="rr-rp-nc-tow" class="rp-input">
                <option value="">No</option>
                <option value="yes">Yes</option>
              </select>
            </label>
          </div>
          <div class="rp-callout rp-callout-warn" id="rr-rp-nc-ground-note" hidden>
            Grounding takes the van out of scheduling immediately and starts the downtime clock — the same action as the Fleet roster's grounding flow.
          </div>
        </div>
        <footer class="rp-modal-foot">
          <button type="button" class="rp-btn" data-rp-mclose>Cancel</button>
          <button type="button" class="rp-btn rp-btn-primary" data-rp-nc-save>Create case</button>
        </footer>
      </div>`;
    document.body.appendChild(wrap);

    const safety = wrap.querySelector("#rr-rp-nc-safety");
    safety.addEventListener("change", () => {
      const v = safety.value;
      wrap.querySelector("#rr-rp-nc-limit-wrap").hidden = v !== "limited";
      wrap.querySelector("#rr-rp-nc-ground-note").hidden = v !== "unsafe";
    });

    wrap.addEventListener("click", async (e) => {
      if (e.target.closest("[data-rp-mclose]")) { wrap.remove(); return; }
      if (!e.target.closest("[data-rp-nc-save]")) return;
      const vehicle = wrap.querySelector("#rr-rp-nc-vehicle").value;
      const title = wrap.querySelector("#rr-rp-nc-title").value.trim();
      if (!vehicle) { say("Pick a vehicle", "warn"); return; }
      if (!title) { say("Give the issue a title", "warn"); return; }
      const safetyVal = safety.value;
      const odoRaw = wrap.querySelector("#rr-rp-nc-odo").value.replace(/[^\d]/g, "");
      const needed = wrap.querySelector("#rr-rp-nc-needed").value;
      const btn = e.target.closest("[data-rp-nc-save]");
      btn.disabled = true;
      const { data, error } = await sb().rpc("repair_case_create", {
        p_vehicle_id: vehicle,
        p_title: title,
        p_description: wrap.querySelector("#rr-rp-nc-desc").value.trim() || null,
        p_category: wrap.querySelector("#rr-rp-nc-category").value,
        p_severity: wrap.querySelector("#rr-rp-nc-severity").value,
        p_safety_status: safetyVal,
        p_drivable: safetyVal !== "unsafe",
        p_ground: safetyVal === "unsafe",
        p_ground_category: "other",
        p_limitation_note: safetyVal === "limited"
          ? (wrap.querySelector("#rr-rp-nc-limit").value.trim() || null) : null,
        p_towing_required: wrap.querySelector("#rr-rp-nc-tow").value === "yes",
        p_odometer: odoRaw ? parseInt(odoRaw, 10) : null,
        p_required_completion_at: needed ? new Date(`${needed}T23:59:00`).toISOString() : null,
      });
      btn.disabled = false;
      if (error) { fail("Couldn't create the case", error); return; }
      wrap.remove();
      say("Repair case created");
      await loadView(true);
      if (data?.id) await openCase(data.id);
    });
    wrap.querySelector("#rr-rp-nc-title")?.focus();
  }

  // ── one-time wiring ──────────────────────────────────────────────────
  function wireOnce() {
    const view = el("view-repair");
    if (!view || view.__rrRepairWired) return;
    view.__rrRepairWired = true;

    view.addEventListener("click", (e) => {
      const row = e.target.closest(".rp-caserow[data-rp-case]");
      if (row) openCase(row.getAttribute("data-rp-case"));
    });

    const search = el("rr-repair-search");
    if (search) search.addEventListener("input", () => { S.filters.search = search.value; renderQueue(); });
    const bind = (id, key, isCheck) => {
      const node = el(id);
      if (!node) return;
      node.addEventListener("change", () => {
        S.filters[key] = isCheck ? node.checked : node.value;
        renderQueue();
      });
    };
    bind("rr-repair-f-stage", "stage");
    bind("rr-repair-f-station", "station");
    bind("rr-repair-f-grounded", "grounded", true);
    bind("rr-repair-f-overdue", "overdue", true);
    const openSel = el("rr-repair-f-open");
    if (openSel) openSel.addEventListener("change", async () => {
      S.filters.openOnly = openSel.value !== "all";
      await loadView(true);
    });
  }

  // ── injected styles for JS-built overlays (tokens only) ─────────────
  let cssDone = false;
  function injectCss() {
    if (cssDone || el("rr-rp-css")) { cssDone = true; return; }
    cssDone = true;
    const style = document.createElement("style");
    style.id = "rr-rp-css";
    style.textContent = `
#rr-rp-drawer{position:fixed;inset:0;z-index:var(--z-modal,10000)}
#rr-rp-drawer .rp-drawer-scrim{position:absolute;inset:0;background:var(--overlay,rgba(15,23,42,.45))}
#rr-rp-drawer .rp-drawer-panel{position:absolute;top:0;right:0;bottom:0;width:640px;max-width:94vw;background:var(--surface);box-shadow:var(--shadow-xl);display:flex;flex-direction:column;overflow:hidden}
#rr-rp-drawer .rp-drawer-head{display:flex;align-items:flex-start;gap:var(--s-3);padding:var(--s-4) var(--s-5);border-bottom:1px solid var(--border-subtle)}
#rr-rp-drawer .rp-drawer-num{color:var(--text-muted);font-size:var(--fs-xs)}
#rr-rp-drawer .rp-drawer-title h3{margin:2px 0 var(--s-2);font-size:var(--fs-lg);color:var(--text)}
#rr-rp-drawer .rp-drawer-pills{display:flex;align-items:center;gap:var(--s-2);flex-wrap:wrap}
#rr-rp-drawer .rp-drawer-x{margin-left:auto;border:0;background:transparent;color:var(--text-subtle);font-size:var(--fs-md);cursor:pointer;padding:var(--s-1)}
#rr-rp-drawer .rp-drawer-body{padding:var(--s-4) var(--s-5) var(--s-6);overflow:auto}
#rr-rp-drawer .rp-drawer-desc{margin:0 0 var(--s-3);font-size:var(--fs-md);color:var(--text);line-height:1.55;max-width:70ch}
#rr-rp-drawer .rp-facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:var(--s-3) var(--s-4);margin-bottom:var(--s-4)}
#rr-rp-drawer .rp-fact-k{display:block;font-size:var(--fs-xs);font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text-subtle)}
#rr-rp-drawer .rp-fact-v{display:block;font-size:var(--fs-md);font-weight:600;color:var(--text);margin-top:2px}
#rr-rp-drawer .rp-drawer-actions{display:flex;gap:var(--s-2);flex-wrap:wrap;padding:var(--s-3) 0;border-top:1px solid var(--border-subtle);border-bottom:1px solid var(--border-subtle);margin-bottom:var(--s-4)}
#rr-rp-drawer .rp-drawer-h4{margin:var(--s-4) 0 var(--s-2);font-size:var(--fs-xs);font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted)}
#rr-rp-drawer .rp-atts{display:flex;flex-wrap:wrap;gap:var(--s-2);align-items:center}
#rr-rp-drawer .rp-att{border:1px solid var(--border);border-radius:var(--r-md);padding:var(--s-2) var(--s-3);cursor:pointer;background:var(--surface)}
#rr-rp-drawer .rp-att:hover{background:var(--surface-hover)}
#rr-rp-drawer .rp-att-name{display:block;font-size:var(--fs-sm);font-weight:600;color:var(--text)}
#rr-rp-drawer .rp-att-sub{display:block;font-size:var(--fs-xs);color:var(--text-muted)}
#rr-rp-drawer .rp-att-none{padding:var(--s-2) 0}
#rr-rp-modal{position:fixed;inset:0;z-index:var(--z-modal,10000);display:flex;align-items:flex-start;justify-content:center;padding:6vh var(--s-4)}
#rr-rp-modal .rp-modal-scrim{position:absolute;inset:0;background:var(--overlay,rgba(15,23,42,.45))}
#rr-rp-modal .rp-modal-card{position:relative;background:var(--surface);border-radius:var(--r-xl);box-shadow:var(--shadow-xl);width:100%;max-width:460px;max-height:88vh;display:flex;flex-direction:column}
#rr-rp-modal .rp-modal-wide{max-width:680px}
#rr-rp-modal .rp-modal-head{display:flex;align-items:center;gap:var(--s-3);padding:var(--s-4) var(--s-5);border-bottom:1px solid var(--border-subtle)}
#rr-rp-modal .rp-modal-head h3{margin:0;font-size:var(--fs-lg);color:var(--text);flex:1}
#rr-rp-modal .rp-modal-body{padding:var(--s-4) var(--s-5);overflow:auto}
#rr-rp-modal .rp-modal-foot{display:flex;justify-content:flex-end;gap:var(--s-2);padding:var(--s-3) var(--s-5);border-top:1px solid var(--border-subtle)}
#rr-rp-modal .rp-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:var(--s-3) var(--s-4)}
#rr-rp-modal .rp-span2{grid-column:1 / -1}
#rr-rp-modal .rp-field span,#rr-rp-modal .rp-field em{font-size:var(--fs-sm)}
.rp-field{display:flex;flex-direction:column;gap:var(--s-1)}
.rp-field>span{font-weight:600;color:var(--text)}
.rp-field em{color:var(--red);font-style:normal}
.rp-input{border:1px solid var(--border);border-radius:var(--r-md);background:var(--surface);color:var(--text);font:inherit;font-size:var(--fs-md);padding:var(--s-2) var(--s-2-5);min-height:34px}
.rp-input:focus-visible{outline:none;border-color:var(--accent);box-shadow:var(--ring-focus)}
.rp-input-ta{resize:vertical;line-height:1.5}
.rp-btn{display:inline-flex;align-items:center;gap:var(--s-1);border:1px solid var(--border);border-radius:var(--r-md);background:var(--surface);color:var(--text);font:inherit;font-size:var(--fs-sm);font-weight:600;padding:var(--s-2) var(--s-3);cursor:pointer}
.rp-btn:hover{background:var(--surface-hover)}
.rp-btn:focus-visible{outline:none;border-color:var(--accent);box-shadow:var(--ring-focus)}
.rp-btn-primary{background:var(--accent);border-color:var(--accent);color:var(--surface)}
.rp-btn-primary:hover{background:var(--accent-hover,var(--accent))}
.rp-btn-danger{color:var(--red);border-color:var(--red-border,var(--border))}
.rp-callout{border:1px solid var(--border);border-radius:var(--r-md);padding:var(--s-2-5) var(--s-3);font-size:var(--fs-sm);line-height:1.5;margin:0 var(--s-5) var(--s-2)}
#rr-rp-modal .rp-callout{margin:var(--s-3) 0 0}
.rp-callout-bad{background:var(--red-soft);border-color:var(--red-border,var(--border));color:var(--red-dark,var(--red))}
.rp-callout-warn{background:var(--amber-soft);border-color:var(--amber-border,var(--border));color:var(--amber-dark,var(--amber))}
@media (max-width:640px){
  #rr-rp-drawer .rp-drawer-panel{width:100vw;max-width:100vw}
  #rr-rp-modal .rp-form-grid{grid-template-columns:1fr}
}`;
    document.head.appendChild(style);
  }

  // ── public surface ───────────────────────────────────────────────────
  window.RRRepair = {
    loadView,
    sub,
    newCase,
    openCase,
    // Fleet-side hook: create a case pre-targeted at a vehicle.
    createForVehicle: (vehicleId) => newCase(vehicleId),
  };
})();
