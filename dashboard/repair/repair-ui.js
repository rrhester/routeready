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
  SHOP_STATUS_LABEL, SHOP_STATUS_TONE, SHOP_STATUS_FLOW, CATEGORY_OPTIONS,
  REQUEST_STATUS_LABEL, REQUEST_STATUS_TONE, SHOP_CLASS_LABEL, SHOP_CLASS_TONE,
  QUOTE_STATUS_LABEL, QUOTE_STATUS_TONE,
  AUTH_TYPE_LABEL, AUTH_STATUS_LABEL, AUTH_STATUS_TONE,
  INVOICE_STATUS_LABEL, INVOICE_STATUS_TONE, buildReconciliation,
  msBetween, formatDuration, daysDown, daysDownTone, promiseState, downSince,
  formatCents, sumCents, attentionScore, filterQueue, sortQueue,
  formatWhen, formatDay, vehicleShortDesc, parseOdometer, ODOMETER_MAX,
  parseMoney, buildComparison, comparableQuotes,
  // The ?v= token is rewritten per deploy by scripts/bust-cache.mjs
  // (this file is in its FILES list). Without it the browser can pair a
  // fresh repair-ui.js with a stale cached repair-engine.js — a missing
  // export then kills the whole module graph and the page never boots.
} from "./repair-engine.js?v=f7ce31199f74";

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
    shops: [],             // vendor directory cache
    shopsLoaded: false,
    reportLoaded: false,
    filters: { search: "", stage: "", station: "", grounded: false, overdue: false, openOnly: true },
    drawerCase: null,
    drawerQuotes: null,    // last repair_case_quotes payload for the open drawer
    drawerInvoices: null,  // last repair_case_invoices payload
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
    if (row.invoice_total_cents != null) {
      const over = row.approved_total_cents != null
        && row.invoice_total_cents > row.approved_total_cents;
      return `<span class="rp-strong${over ? " rp-money-over" : ""}">${esc(formatCents(row.invoice_total_cents))}</span><span class="rp-cell-sub${over ? " rp-money-over" : ""}">${over ? "over authorization" : "invoice"}</span>`;
    }
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
    injectCss(); // the frag's toolbar buttons use the injected classes
    // Master station lens · scope the whole Repair Center to the selected
    // station (id null ⇒ "All" ⇒ byte-identical to before). repair_cases_list
    // already accepts p_station_id; repair_center_summary gains it in 0530 —
    // fall back to the no-arg call so the KPI strip still renders pre-migration.
    const _stnId = (typeof window.rrStationScopeId === "function") ? window.rrStationScopeId() : null;
    try {
      const listArgs = { p_open_only: S.filters.openOnly };
      if (_stnId) listArgs.p_station_id = _stnId;
      let [list, summary] = await Promise.all([
        sb().rpc("repair_cases_list", listArgs),
        sb().rpc("repair_center_summary", _stnId ? { p_station_id: _stnId } : {}),
      ]);
      // Pre-0530 the arg'd summary overload 404s — retry the no-arg fn so the
      // strip still paints (DSP-wide until the migration lands).
      if (summary.error && _stnId) summary = await sb().rpc("repair_center_summary");
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
      const tone = (e.kind === "grounded" || e.kind === "email_bounced") ? "r"
        : (e.kind === "returned_to_service" || e.kind === "ungrounded"
           || e.kind === "authorization_acknowledged" || e.kind === "vehicle_picked_up"
           || e.kind === "invoice_settled") ? "g"
        : (e.kind === "stage_changed" || e.kind === "created"
           || e.kind === "authorization_issued"
           || e.kind === "visit_scheduled" || e.kind === "visit_checked_in") ? "b" : "n";
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
    // The global sidebar switcher is the one station control — retire this
    // per-page dropdown when it exists (the queue is already server-scoped).
    if (typeof window.rrStationScope === "function") {
      sel.style.display = "none";
      if (S.filters.station) { S.filters.station = ""; }
    }
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
    if (name === "shops" && !S.shopsLoaded) loadShops();
    if (name === "reports" && !S.reportLoaded) loadReport();
  }

  // ── reports (Phase 9) ────────────────────────────────────────────────
  // Every number arrives pre-derived from repair_center_report() — raw
  // timestamps and integer cents aggregated at query time, nothing
  // stored, nothing to drift. This renderer only formats.
  async function loadReport() {
    const tbody = el("rr-repair-rep-tbody");
    if (!tbody) return;
    const days = parseInt(el("rr-repair-rep-period")?.value || "30", 10);
    const { data, error } = await sb().rpc("repair_center_report", {
      p_from: new Date(Date.now() - days * 24 * 3600e3).toISOString(),
      p_to: new Date().toISOString(),
    });
    if (error || !data) {
      tbody.innerHTML = `<tr><td colspan="10" class="rp-table-empty rp-error">Couldn't load the report · ${esc(error?.message || "try again")}</td></tr>`;
      return;
    }
    S.reportLoaded = true;
    renderReport(data);
  }

  function renderReport(rep) {
    const s = rep.summary || {};
    const kpis = el("rr-repair-rep-kpis");
    if (kpis) {
      const pill = (val, label, tone, sub2) => `
        <div class="rp-kpi-pill" role="listitem">
          ${tone ? `<span class="rp-kpi-dot rp-kpi-dot-${tone}"></span>` : ""}
          <span class="rp-kpi-value">${esc(val)}</span>
          <span class="rp-kpi-name">${esc(label)}</span>
          ${sub2 ? `<span class="rp-kpi-sub">${esc(sub2)}</span>` : ""}
        </div>`;
      kpis.innerHTML =
        pill(s.cases_closed ?? 0, "Cases completed", "b", `${s.cases_opened ?? 0} opened`)
        + pill(s.avg_downtime_days != null ? `${s.avg_downtime_days}d` : "—", "Avg downtime", "", "report → back in service")
        + pill(formatCents(Number(s.settled_total_cents ?? 0)), "Repair spend", "", `${s.settled_invoices ?? 0} settled invoices`)
        + pill(formatCents(Number(s.variance_over_cents ?? 0)), "Over authorization",
               Number(s.variance_over_cents) > 0 ? "r" : "g",
               s.over_authorization_count ? `${s.over_authorization_count} invoice${s.over_authorization_count > 1 ? "s" : ""}` : "none")
        + pill(s.open_now ?? 0, "Open now", "");
      kpis.hidden = false;
    }
    const tbody = el("rr-repair-rep-tbody");
    if (!tbody) return;
    const shops = rep.shops || [];
    if (!shops.length) {
      tbody.innerHTML = `<tr><td colspan="10" class="rp-table-empty">No shop activity in this period yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = shops.map((r) => {
      const kept = r.promises_measured > 0
        ? Math.round((r.promises_on_time / r.promises_measured) * 100) : null;
      const keptTone = kept == null ? "" : kept >= 80 ? "ok" : kept >= 50 ? "warn" : "bad";
      const winRate = r.quotes_submitted > 0 && r.quotes_won != null
        ? ` · ${Math.round((r.quotes_won / r.quotes_submitted) * 100)}%` : "";
      const over = Number(r.variance_over_cents ?? 0);
      return `<tr>
        <td><span class="rp-strong">${esc(r.name)}</span><span class="rp-cell-sub">${esc(SHOP_CLASS_LABEL[r.preferred_status] || "")}</span></td>
        <td class="num">${esc(String(r.cases_completed ?? 0))}</td>
        <td class="num">${esc(String(r.open_cases ?? 0))}</td>
        <td class="num">${r.avg_response_hours != null ? `~${esc(String(r.avg_response_hours))}h` : `<span class="rp-muted">—</span>`}</td>
        <td class="num">${esc(String(r.quotes_won ?? 0))}<span class="rp-cell-sub">${esc(`${r.quotes_submitted ?? 0} quoted${winRate}`)}</span></td>
        <td>${kept != null
          ? `<span class="status-pill rp-pill-${keptTone}">${kept}%</span><span class="rp-cell-sub">${esc(`${r.promises_on_time}/${r.promises_measured} on time`)}</span>`
          : `<span class="rp-muted">—</span>`}</td>
        <td class="num">${r.avg_days_late != null && Number(r.avg_days_late) > 0 ? `${esc(String(r.avg_days_late))}d` : `<span class="rp-muted">—</span>`}</td>
        <td class="num rp-strong">${esc(formatCents(Number(r.settled_total_cents ?? 0)))}</td>
        <td class="num">${over > 0 ? `<span class="rp-money-over">${esc(formatCents(over))}</span>` : `<span class="rp-muted">—</span>`}</td>
        <td class="num">${r.disputes ? esc(String(r.disputes)) : `<span class="rp-muted">—</span>`}</td>
      </tr>`;
    }).join("");
  }

  // ── shop directory ───────────────────────────────────────────────────
  async function loadShops(force) {
    if (S.shopsLoaded && !force) { renderShops(); return S.shops; }
    const { data, error } = await sb().rpc("repair_vendors_list");
    if (error) {
      fail("Couldn't load the shop directory", error);
      const tbody = el("rr-repair-shops-tbody");
      if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="rp-table-empty rp-error">Couldn't load shops · ${esc(error.message)}</td></tr>`;
      return [];
    }
    S.shops = Array.isArray(data) ? data : [];
    S.shopsLoaded = true;
    renderShops();
    return S.shops;
  }

  const shopClassPill = (s) =>
    `<span class="status-pill rp-pill-${esc(SHOP_CLASS_TONE[s.preferred_status] || "neutral")}">${esc(SHOP_CLASS_LABEL[s.preferred_status] || s.preferred_status || "Approved")}</span>`;

  function renderShops() {
    const tbody = el("rr-repair-shops-tbody");
    if (!tbody) return;
    const count = el("rr-repair-shops-count");
    if (count) {
      const pref = S.shops.filter((s) => s.preferred_status === "preferred").length;
      const blocked = S.shops.filter((s) => s.preferred_status === "blocked").length;
      count.textContent = `${S.shops.length} shops · ${pref} preferred${blocked ? ` · ${blocked} blocked` : ""}`;
    }
    if (!S.shops.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="rp-table-empty">Add the shops you already use — a name and an email address are enough to send the first quote request.</td></tr>`;
      return;
    }
    tbody.innerHTML = S.shops.map((s) => {
      const services = Array.isArray(s.service_categories) ? s.service_categories.join(", ") : "";
      const flags = [s.mobile_service ? "mobile" : null, s.towing_available ? "towing" : null,
        s.after_hours ? "after-hours" : null].filter(Boolean).join(" · ");
      const blocked = s.preferred_status === "blocked";
      return `<tr class="rp-shoprow${blocked ? " rp-dim" : ""}" data-rp-shop="${esc(s.id)}">
        <td><span class="rp-strong">${esc(s.name)}</span><span class="rp-cell-sub">${esc([s.address, s.city].filter(Boolean).join(" · ") || s.hours_note || "")}</span></td>
        <td><span>${esc(s.kind || "repair")}</span><span class="rp-cell-sub">${esc([services, flags].filter(Boolean).join(" · "))}</span></td>
        <td><span>${esc(s.contact_name || "—")}</span><span class="rp-cell-sub">${esc([s.contact_phone, s.contact_email].filter(Boolean).join(" · "))}</span></td>
        <td class="num">${s.avg_response_hours != null ? `~${esc(String(s.avg_response_hours))}h` : `<span class="rp-muted">—</span>`}</td>
        <td class="num">${esc(String(s.quotes_submitted ?? 0))}</td>
        <td class="num">${s.open_cases > 0 ? `<span class="status-pill rp-pill-info">${esc(String(s.open_cases))} active</span>` : `<span class="rp-muted">—</span>`}</td>
        <td>${shopClassPill(s)}${blocked && s.blocked_reason ? `<span class="rp-cell-sub">${esc(s.blocked_reason)}</span>` : ""}</td>
        <td class="num"><button type="button" class="rp-btn rp-btn-sm" data-rp-shop-edit="${esc(s.id)}">Edit</button></td>
      </tr>`;
    }).join("");
  }

  function newShop(shopId) {
    injectCss();
    el("rr-rp-modal")?.remove();
    const s = S.shops.find((x) => x.id === shopId) || {};
    const wrap = document.createElement("div");
    wrap.id = "rr-rp-modal";
    const kindOpts = ["repair", "mobile", "tow", "parts", "other"].map((k) =>
      `<option value="${k}"${(s.kind || "repair") === k ? " selected" : ""}>${k[0].toUpperCase() + k.slice(1)}</option>`).join("");
    const classOpts = Object.entries(SHOP_CLASS_LABEL).map(([k, label]) =>
      `<option value="${k}"${(s.preferred_status || "approved") === k ? " selected" : ""}>${label}</option>`).join("");
    wrap.innerHTML = `
      <div class="rp-modal-scrim" data-rp-mclose></div>
      <div class="rp-modal-card rp-modal-wide" role="dialog" aria-modal="true" aria-label="${shopId ? "Edit shop" : "Add shop"}">
        <header class="rp-modal-head"><h3>${shopId ? "Edit shop" : "Add shop"}</h3><button type="button" class="rp-drawer-x" data-rp-mclose aria-label="Close">✕</button></header>
        <div class="rp-modal-body">
          <div class="rp-form-grid">
            <label class="rp-field"><span>Shop name <em>*</em></span><input id="rr-rp-sh-name" class="rp-input" maxlength="120" value="${esc(s.name || "")}"></label>
            <label class="rp-field"><span>Type</span><select id="rr-rp-sh-kind" class="rp-input">${kindOpts}</select></label>
            <label class="rp-field"><span>Contact name</span><input id="rr-rp-sh-cname" class="rp-input" maxlength="80" value="${esc(s.contact_name || "")}"></label>
            <label class="rp-field"><span>Phone</span><input id="rr-rp-sh-phone" class="rp-input" maxlength="30" value="${esc(s.contact_phone || "")}"></label>
            <label class="rp-field rp-span2"><span>Email (quote requests go here)</span><input id="rr-rp-sh-email" class="rp-input" maxlength="120" inputmode="email" value="${esc(s.contact_email || "")}"></label>
            <label class="rp-field rp-span2"><span>Address</span><input id="rr-rp-sh-address" class="rp-input" maxlength="200" value="${esc(s.address || "")}"></label>
            <label class="rp-field"><span>Distance (mi)</span><input id="rr-rp-sh-dist" class="rp-input" inputmode="decimal" value="${esc(s.distance_mi != null ? String(s.distance_mi) : "")}"></label>
            <label class="rp-field"><span>Hours</span><input id="rr-rp-sh-hours" class="rp-input" maxlength="120" value="${esc(s.hours_note || "")}" placeholder="e.g. Mon–Sat 7–6"></label>
            <label class="rp-field"><span>Classification</span><select id="rr-rp-sh-class" class="rp-input">${classOpts}</select></label>
            <label class="rp-field" id="rr-rp-sh-blockwrap" ${((s.preferred_status || "approved") !== "blocked") ? "hidden" : ""}><span>Blocked reason</span><input id="rr-rp-sh-blockreason" class="rp-input" maxlength="200" value="${esc(s.blocked_reason || "")}"></label>
            <label class="rp-field rp-span2"><span>Services (comma separated)</span><input id="rr-rp-sh-services" class="rp-input" maxlength="300" value="${esc(Array.isArray(s.service_categories) ? s.service_categories.join(", ") : "")}" placeholder="e.g. brakes, tires, collision, glass"></label>
            <div class="rp-field rp-span2" style="flex-direction:row;gap:16px;align-items:center">
              <label class="rp-checkline"><input type="checkbox" id="rr-rp-sh-mobile" ${s.mobile_service ? "checked" : ""}> Mobile service</label>
              <label class="rp-checkline"><input type="checkbox" id="rr-rp-sh-towing" ${s.towing_available ? "checked" : ""}> Towing</label>
              <label class="rp-checkline"><input type="checkbox" id="rr-rp-sh-afterhours" ${s.after_hours ? "checked" : ""}> After hours</label>
            </div>
            <label class="rp-field rp-span2"><span>Internal notes (never shown to shops)</span><textarea id="rr-rp-sh-notes" class="rp-input rp-input-ta" rows="2" maxlength="1000">${esc(s.notes || "")}</textarea></label>
          </div>
        </div>
        <footer class="rp-modal-foot">
          <button type="button" class="rp-btn" data-rp-mclose>Cancel</button>
          <button type="button" class="rp-btn rp-btn-primary" data-rp-sh-save>${shopId ? "Save shop" : "Add shop"}</button>
        </footer>
      </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector("#rr-rp-sh-class").addEventListener("change", (e) => {
      wrap.querySelector("#rr-rp-sh-blockwrap").hidden = e.target.value !== "blocked";
    });
    wrap.addEventListener("click", async (e) => {
      if (e.target.closest("[data-rp-mclose]")) { wrap.remove(); return; }
      if (!e.target.closest("[data-rp-sh-save]")) return;
      const name = wrap.querySelector("#rr-rp-sh-name").value.trim();
      if (!name) { say("Give the shop a name", "warn"); return; }
      const services = wrap.querySelector("#rr-rp-sh-services").value
        .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
      const distRaw = wrap.querySelector("#rr-rp-sh-dist").value.replace(/[^\d.]/g, "");
      const btn = e.target.closest("[data-rp-sh-save]");
      btn.disabled = true;
      const { error } = await sb().rpc("repair_vendor_save", {
        p_id: shopId || null,
        p_patch: {
          name,
          kind: wrap.querySelector("#rr-rp-sh-kind").value,
          contact_name: wrap.querySelector("#rr-rp-sh-cname").value.trim() || null,
          contact_phone: wrap.querySelector("#rr-rp-sh-phone").value.trim() || null,
          contact_email: wrap.querySelector("#rr-rp-sh-email").value.trim() || null,
          address: wrap.querySelector("#rr-rp-sh-address").value.trim() || null,
          distance_mi: distRaw ? parseFloat(distRaw) : null,
          hours_note: wrap.querySelector("#rr-rp-sh-hours").value.trim() || null,
          preferred_status: wrap.querySelector("#rr-rp-sh-class").value,
          blocked_reason: wrap.querySelector("#rr-rp-sh-blockreason")?.value.trim() || null,
          service_categories: services,
          mobile_service: wrap.querySelector("#rr-rp-sh-mobile").checked,
          towing_available: wrap.querySelector("#rr-rp-sh-towing").checked,
          after_hours: wrap.querySelector("#rr-rp-sh-afterhours").checked,
          notes: wrap.querySelector("#rr-rp-sh-notes").value.trim() || null,
        },
      });
      btn.disabled = false;
      if (error) { fail("Couldn't save the shop", error); return; }
      wrap.remove();
      say("Shop saved");
      await loadShops(true);
    });
    wrap.querySelector("#rr-rp-sh-name")?.focus();
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
      const tone = (e.kind === "grounded" || e.kind === "email_bounced") ? "r"
        : (e.kind === "returned_to_service" || e.kind === "ungrounded"
           || e.kind === "authorization_acknowledged" || e.kind === "vehicle_picked_up"
           || e.kind === "invoice_settled") ? "g"
        : (e.kind === "stage_changed" || e.kind === "created" || e.kind === "ro_linked"
           || e.kind === "authorization_issued"
           || e.kind === "visit_scheduled" || e.kind === "visit_checked_in") ? "b" : "n";
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
    const extractable = (a) => a.mime_type === "application/pdf" || /^image\//.test(a.mime_type || "");
    const items = list.map((a) => `
      <div class="rp-att" data-rp-att-path="${esc(a.storage_path)}" data-rp-att-bucket="${esc(a.storage_bucket)}" role="button" tabindex="0" title="Open ${esc(a.file_name)}">
        <span class="rp-att-name">${esc(a.file_name)}</span>
        <span class="rp-att-sub">${esc([a.attachment_type.replace(/_/g, " "), formatDay(a.created_at)].join(" · "))}</span>
        ${extractable(a) ? `<button type="button" class="rp-btn rp-btn-sm rp-att-extract" data-rp-extract="${esc(a.id)}" title="Read this document into a draft quote for review">Extract quote</button>` : ""}
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
    // Dedicated affordances own these: cancel/return buttons below, and
    // scheduled / at_shop / ready_for_pickup via the In-Shop Tracker so
    // a stage move never happens without its visit record.
    const owned = ["cancelled", "returned", "scheduled", "at_shop", "ready_for_pickup"];
    for (const s of next) {
      if (owned.includes(s)) continue;
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

  // ── In-Shop Tracker section (Phase 6) ────────────────────────────────
  const PRE_SHOP_STAGES = ["reported", "review", "quoting", "quotes_in", "awaiting_approval", "approved", "scheduled"];

  function visitSection(c) {
    const v = c.visit;
    const rows = [];
    const row = (k, val, cls) => rows.push(
      `<div class="rp-visit-row"><span class="rp-fact-k">${esc(k)}</span><span class="rp-fact-v${cls ? ` ${cls}` : ""}">${val}</span></div>`);
    const btns = [];

    if (v) {
      row("Status", shopStatusPill(v.shop_status) || esc(v.shop_status));
      if (v.appointment_at && !v.dropped_off_at) row("Appointment", esc(formatWhen(v.appointment_at, nowIso())));
      if (v.dropped_off_at) row("Dropped off", esc(formatWhen(v.dropped_off_at, nowIso())));
      if (v.shop_work_order_number) row("WO #", esc(v.shop_work_order_number));
      if (v.service_advisor) row("Advisor", esc(v.service_advisor));
      if (v.promised_completion_at) row("Promised", esc(formatDay(v.promised_completion_at)));
      if (v.revised_completion_at) row("Revised", esc(formatDay(v.revised_completion_at)));
      if (v.current_delay_reason) row("Delay", esc(v.current_delay_reason));
    }

    if (!v && PRE_SHOP_STAGES.includes(c.stage)) {
      btns.push(`<button type="button" class="rp-btn rp-btn-primary" data-rp-vis-schedule>Schedule drop-off…</button>`);
      btns.push(`<button type="button" class="rp-btn" data-rp-vis-checkin title="The van is already at the shop (tow-in / walk-in)">Check in at shop…</button>`);
    } else if (v && !v.dropped_off_at) {
      btns.push(`<button type="button" class="rp-btn rp-btn-primary" data-rp-vis-checkin>Check in at shop…</button>`);
      btns.push(`<button type="button" class="rp-btn" data-rp-vis-schedule>Reschedule…</button>`);
    } else if (v && v.shop_status !== "picked_up") {
      btns.push(`<button type="button" class="rp-btn rp-btn-primary" data-rp-vis-update>Update shop status…</button>`);
      btns.push(`<button type="button" class="rp-btn" data-rp-vis-pickup>Picked up…</button>`);
    }

    if (!rows.length && !btns.length) {
      return `<div class="rp-table-empty" style="padding:var(--s-2) 0;text-align:left">${
        c.stage === "quality_check" ? "Picked up — run the quality check, then return the van to service." : "No shop visit tracked."}</div>`;
    }
    return `${rows.length ? `<div class="rp-visit-grid">${rows.join("")}</div>` : ""}
      ${btns.length ? `<div class="rp-visit-actions">${btns.join("")}</div>` : ""}`;
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
        ${c.invoice_total_cents != null && c.approved_total_cents != null && c.invoice_total_cents > c.approved_total_cents
          ? `<div class="rp-callout rp-callout-bad">Invoice exceeds the authorization by ${esc(formatCents(c.invoice_total_cents - c.approved_total_cents))}.</div>` : ""}
        ${c.limitation_note ? `<div class="rp-callout rp-callout-warn">Limited use: ${esc(c.limitation_note)}</div>` : ""}
        <div class="rp-drawer-body">
          ${c.description ? `<p class="rp-drawer-desc">${esc(c.description)}</p>` : ""}
          <div class="rp-facts">${drawerFacts(c)}</div>
          <div class="rp-drawer-actions">${stageActions(c)}
            <button type="button" class="rp-btn" data-rp-log>Log update…</button>
            <button type="button" class="rp-btn" data-rp-use-part title="Pull a part from on-hand stock for this job — feeds the van's cost history">Use a part…</button>
            ${!c.ro ? `<button type="button" class="rp-btn" data-rp-link-ro>Open RO</button>` : ""}
            ${typeof window.openFleetDrawer === "function" ? `<button type="button" class="rp-btn" data-rp-fleet>Fleet record</button>` : ""}
          </div>
          <h4 class="rp-drawer-h4">In-shop tracker</h4>
          <div class="rp-visit">${visitSection(c)}</div>
          <h4 class="rp-drawer-h4">Quotes &amp; shops</h4>
          <div class="rp-qsec" id="rr-rp-quotes">
            <div class="rp-table-empty rp-qsec-loading">Loading quotes…</div>
          </div>
          <div class="rp-drawer-actions" style="border-top:none;margin-bottom:0;padding-bottom:0">
            <button type="button" class="rp-btn rp-btn-primary" data-rp-request-quotes>Request quotes…</button>
            <button type="button" class="rp-btn" data-rp-phone-quote>Log phone quote…</button>
            <button type="button" class="rp-btn" data-rp-authorize="" title="Authorize diagnostics or set a not-to-exceed cap — a quote isn't required">Authorize work…</button>
          </div>
          <h4 class="rp-drawer-h4">Invoice &amp; reconciliation</h4>
          <div class="rp-qsec" id="rr-rp-invoices">
            <div class="rp-table-empty rp-qsec-loading">Loading…</div>
          </div>
          <div class="rp-drawer-actions" style="border-top:none;margin-bottom:0;padding-bottom:0">
            <button type="button" class="rp-btn" data-rp-log-invoice>Log invoice…</button>
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
      if (e.target.closest("[data-rp-use-part]")) { await openUsePartModal(c); return; }
      if (e.target.closest("[data-rp-link-ro]")) { await doLinkRo(c.id); return; }
      if (e.target.closest("[data-rp-fleet]")) { closeDrawer(); window.openFleetDrawer(c.vehicle?.id); return; }
      if (e.target.closest("[data-rp-request-quotes]")) { openRequestModal(c); return; }
      if (e.target.closest("[data-rp-phone-quote]")) { openPhoneQuoteModal(c); return; }
      if (e.target.closest("[data-rp-compare]")) { openCompareModal(c); return; }
      if (e.target.closest("[data-rp-vis-schedule]")) { openScheduleVisitModal(c); return; }
      if (e.target.closest("[data-rp-vis-checkin]")) { openCheckinModal(c); return; }
      if (e.target.closest("[data-rp-vis-update]")) { openVisitUpdateModal(c); return; }
      if (e.target.closest("[data-rp-vis-pickup]")) { await doVisitPickup(c); return; }
      const authBtn = e.target.closest("[data-rp-authorize]");
      if (authBtn) {
        const qid = authBtn.getAttribute("data-rp-authorize");
        const quote = (S.drawerQuotes?.quotes || []).find((q) => q.id === qid) || null;
        openAuthorizeModal(c, quote);
        return;
      }
      const authAct = e.target.closest("[data-rp-auth-action]");
      if (authAct) {
        await doAuthAction(c, authAct.getAttribute("data-rp-auth-id"), authAct.getAttribute("data-rp-auth-action"));
        return;
      }
      const authLines = e.target.closest("[data-rp-auth-lines]");
      if (authLines) {
        const items = wrap.querySelector(`[data-rp-auth-items="${authLines.getAttribute("data-rp-auth-lines")}"]`);
        if (items) items.hidden = !items.hidden;
        return;
      }
      if (e.target.closest("[data-rp-log-invoice]")) { openLogInvoiceModal(c); return; }
      const invReview = e.target.closest("[data-rp-inv-review]");
      if (invReview) {
        const inv = (S.drawerInvoices?.invoices || []).find((i) => i.id === invReview.getAttribute("data-rp-inv-review"));
        if (inv) openInvoiceReviewModal(c, inv);
        return;
      }
      const invRec = e.target.closest("[data-rp-inv-reconcile]");
      if (invRec) {
        const inv = (S.drawerInvoices?.invoices || []).find((i) => i.id === invRec.getAttribute("data-rp-inv-reconcile"));
        if (inv) openReconcileModal(c, inv);
        return;
      }
      const reviewBtn = e.target.closest("[data-rp-review]");
      if (reviewBtn) {
        const quote = (S.drawerQuotes?.quotes || []).find((q) => q.id === reviewBtn.getAttribute("data-rp-review"));
        if (quote) openExtractReviewModal(c, quote);
        return;
      }
      const reqAct = e.target.closest("[data-rp-req-action]");
      if (reqAct) {
        await doRequestAction(c, reqAct.getAttribute("data-rp-req-id"), reqAct.getAttribute("data-rp-req-action"));
        return;
      }
      const qToggle = e.target.closest("[data-rp-quote-toggle]");
      if (qToggle) {
        const items = wrap.querySelector(`[data-rp-quote-items="${qToggle.getAttribute("data-rp-quote-toggle")}"]`);
        if (items) items.hidden = !items.hidden;
        return;
      }
      const extractBtn = e.target.closest("[data-rp-extract]");
      if (extractBtn) { await doExtractAttachment(c, extractBtn); return; }
      const att = e.target.closest("[data-rp-att-path]");
      if (att) { await openAttachment(att.getAttribute("data-rp-att-bucket"), att.getAttribute("data-rp-att-path")); return; }
      if (e.target.closest(".rp-att-add .rp-link-btn")) { el("rr-rp-att-input")?.click(); }
    });
    const fileInput = wrap.querySelector("#rr-rp-att-input");
    if (fileInput) fileInput.addEventListener("change", () => uploadAttachments(c, fileInput.files));
    document.addEventListener("keydown", drawerEsc);
    loadDrawerQuotes(c.id);   // async fill; drawer stays responsive
    loadDrawerInvoices(c.id);
  }

  // ── quotes section (drawer) ──────────────────────────────────────────
  async function loadDrawerQuotes(caseId) {
    const host = el("rr-rp-quotes");
    if (!host) return;
    const { data, error } = await sb().rpc("repair_case_quotes", { p_case_id: caseId });
    if (!el("rr-rp-quotes")) return; // drawer closed meanwhile
    if (error || !data) {
      host.innerHTML = `<div class="rp-table-empty rp-error">Couldn't load quotes · ${esc(error?.message || "try again")}</div>`;
      return;
    }
    S.drawerQuotes = data;
    renderDrawerQuotes(host, data);
  }

  // The current authorization + its history, rendered above the quotes.
  function authSection(auths) {
    if (!auths.length) return "";
    const current = auths.find((a) => a.status === "issued" || a.status === "acknowledged");
    const history = auths.filter((a) => a !== current);
    const authPill = (a) =>
      `<span class="status-pill rp-pill-${esc(AUTH_STATUS_TONE[a.status] || "neutral")}">${esc(AUTH_STATUS_LABEL[a.status] || a.status)}</span>`;
    let html = "";
    if (current) {
      const approved = (current.lines || []).filter((l) => l.decision === "approved");
      const declined = (current.lines || []).filter((l) => l.decision === "declined");
      const amount = current.authorized_total_cents != null
        ? `${formatCents(current.authorized_total_cents)}${current.authorization_type === "not_to_exceed" ? " cap" : ""}`
        : (current.authorization_type === "diagnostics_only" ? "fee TBD" : "—");
      const subBits = [
        current.vendor_name,
        `authorized ${formatWhen(current.authorized_at, nowIso())}`,
        current.po_number ? (/^po/i.test(current.po_number) ? current.po_number : `PO ${current.po_number}`) : null,
        current.status === "acknowledged" && current.acknowledged_by ? `ack. ${current.acknowledged_by}` : null,
        declined.length ? `${declined.length} line${declined.length > 1 ? "s" : ""} declined` : null,
      ].filter(Boolean).join(" · ");
      const lineRows = (current.lines || []).map((l) => `
        <div class="rp-qli${l.decision === "declined" ? " rp-qli-declined" : ""}">
          <span class="rp-qli-desc">${esc(l.description)}${l.decision === "declined" ? ` <span class="rp-cell-sub" style="display:inline">· not approved</span>` : ""}</span>
          <span class="rp-qli-amt">${esc(formatCents(l.line_total_cents))}</span>
        </div>`).join("");
      html += `
      <div class="rp-auth-card">
        <div class="rp-qrow" style="border-bottom:none;padding-bottom:0">
          <div class="rp-qrow-main">
            <span class="rp-strong">${esc(AUTH_TYPE_LABEL[current.authorization_type] || current.authorization_type)}
              ${current.version > 1 ? `<span class="rp-cell-sub" style="display:inline"> · v${esc(String(current.version))}</span>` : ""}
            </span>
            <span class="rp-cell-sub">${esc(subBits)}</span>
          </div>
          <span class="rp-strong rp-qamt">${esc(amount)}</span>
          ${authPill(current)}
        </div>
        ${current.notes ? `<div class="rp-cell-sub" style="margin:var(--s-1) 0 0">${esc(current.notes)}</div>` : ""}
        <div class="rp-auth-actions">
          ${approved.length || declined.length
            ? `<button type="button" class="rp-btn rp-btn-sm" data-rp-auth-lines="${esc(current.id)}">${approved.length + declined.length} lines</button>` : ""}
          <button type="button" class="rp-btn rp-btn-sm" data-rp-auth-action="resend" data-rp-auth-id="${esc(current.id)}" title="Email the authorization to the shop again (fresh link)">Resend</button>
          ${current.status === "issued"
            ? `<button type="button" class="rp-btn rp-btn-sm" data-rp-auth-action="mark_acknowledged" data-rp-auth-id="${esc(current.id)}" title="Record an acknowledgement received by phone or email">Mark acknowledged</button>` : ""}
          <button type="button" class="rp-btn rp-btn-sm rp-btn-danger" data-rp-auth-action="revoke" data-rp-auth-id="${esc(current.id)}">Revoke</button>
        </div>
        ${lineRows ? `<div class="rp-qitems" data-rp-auth-items="${esc(current.id)}" hidden>${lineRows}</div>` : ""}
      </div>`;
    }
    if (history.length) {
      html += history.map((a) => `
        <div class="rp-qrow rp-auth-hist">
          <div class="rp-qrow-main">
            <span class="rp-cell-sub">v${esc(String(a.version))} · ${esc(AUTH_TYPE_LABEL[a.authorization_type] || a.authorization_type)}${a.authorized_total_cents != null ? ` · ${esc(formatCents(a.authorized_total_cents))}` : ""}${a.revoke_reason ? ` — ${esc(a.revoke_reason)}` : ""}</span>
          </div>
          ${authPill(a)}
        </div>`).join("");
    }
    return `<div class="rp-qhead">Authorization</div>${html}`;
  }

  // Extracted drafts awaiting human review (Phase 7). Money shown here
  // is the server-recomputed total of the TRANSCRIBED lines — accepting
  // never changes a number, it only makes the quote count.
  function extractedDraftRows(drafts) {
    if (!drafts.length) return "";
    const rows = drafts.map((q) => {
      const conf = q.extraction_confidence != null
        ? `${Math.round(Number(q.extraction_confidence) * 100)}% confidence` : "";
      const sub = [
        q.vendor_name || "shop not identified",
        conf,
        q.quote_number ? `#${q.quote_number}` : null,
      ].filter(Boolean).join(" · ");
      return `
      <div class="rp-qrow">
        <div class="rp-qrow-main">
          <span class="rp-strong">Extracted estimate
            ${q.totals_mismatch ? `<span class="status-pill rp-pill-warn" title="The document's printed total doesn't match its own line items">Totals differ</span>` : ""}
          </span>
          <span class="rp-cell-sub">${esc(sub)}</span>
        </div>
        <span class="rp-strong rp-qamt">${esc(formatCents(q.grand_total_cents ?? q.shop_reported_total_cents))}</span>
        <button type="button" class="rp-btn rp-btn-sm rp-btn-primary" data-rp-review="${esc(q.id)}">Review…</button>
      </div>`;
    }).join("");
    return `<div class="rp-qhead">Needs review <span class="status-pill rp-pill-warn">extracted, unconfirmed</span></div>${rows}`;
  }

  function renderDrawerQuotes(host, data) {
    const requests = data.requests || [];
    const allQuotes = data.quotes || [];
    const drafts = allQuotes.filter((q) => q.status === "draft" && q.extracted_at);
    const quotes = allQuotes.filter((q) => !(q.status === "draft"));
    const auths = data.authorizations || [];
    if (!requests.length && !allQuotes.length && !auths.length) {
      host.innerHTML = `<div class="rp-table-empty" style="padding:var(--s-3) 0;text-align:left">No quotes yet — send this case to your shops, or log a phone quote.</div>`;
      return;
    }
    const reqPill = (r) =>
      `<span class="status-pill rp-pill-${esc(REQUEST_STATUS_TONE[r.request_status] || "neutral")}">${esc(REQUEST_STATUS_LABEL[r.request_status] || r.request_status)}</span>`;
    const reqSub = (r) => {
      if (r.request_status === "submitted") return `quote in ${formatWhen(r.submitted_at, nowIso())}`;
      if (r.request_status === "declined") return [`declined ${formatWhen(r.declined_at, nowIso())}`, r.decline_reason].filter(Boolean).join(" — ");
      if (r.request_status === "opened") return `opened ${formatWhen(r.opened_at, nowIso())}`;
      if (r.request_status === "sent") return `sent ${formatWhen(r.sent_at, nowIso())}${r.reminder_count ? ` · ${r.reminder_count} reminder${r.reminder_count > 1 ? "s" : ""}` : ""}`;
      return "";
    };
    const reqRows = requests.map((r) => `
      <div class="rp-qrow">
        <div class="rp-qrow-main">
          <span class="rp-strong">${esc(r.vendor_name || "Shop")}</span>
          <span class="rp-cell-sub">${esc(reqSub(r))}</span>
        </div>
        ${reqPill(r)}
        ${["sent", "opened"].includes(r.request_status)
          ? `<button type="button" class="rp-btn rp-btn-sm" data-rp-req-action="remind" data-rp-req-id="${esc(r.id)}" title="Send a reminder email">Remind</button>`
          : ""}
        ${!["declined", "expired", "failed"].includes(r.request_status)
          ? `<button type="button" class="rp-btn rp-btn-sm" data-rp-req-action="regenerate" data-rp-req-id="${esc(r.id)}" title="Copy a fresh secure link">Copy link</button>`
          : ""}
        ${["queued", "sent", "opened"].includes(r.request_status)
          ? `<button type="button" class="rp-btn rp-btn-sm rp-btn-danger" data-rp-req-action="revoke" data-rp-req-id="${esc(r.id)}" title="Revoke the secure link">Revoke</button>`
          : ""}
      </div>`).join("");

    const quoteRows = quotes.map((q) => {
      const meta = [
        q.earliest_appointment_at ? `appt ${formatDay(q.earliest_appointment_at)}` : null,
        q.estimated_completion_at ? `done ${formatDay(q.estimated_completion_at)}` : null,
        q.warranty_summary || null,
        q.source !== "shop_form" ? q.source.replace(/_/g, " ") : null,
      ].filter(Boolean).join(" · ");
      const items = (q.line_items || []).map((li) => `
        <div class="rp-qli">
          <span class="rp-qli-desc">${esc(li.description)}${li.part_number ? ` <span class="rp-cell-sub" style="display:inline">· ${esc(li.part_number)}</span>` : ""}</span>
          <span class="rp-qli-amt">${esc(formatCents(li.line_total_cents))}</span>
        </div>`).join("");
      const statusPill = (q.status === "accepted" || q.status === "declined")
        ? `<span class="status-pill rp-pill-${esc(QUOTE_STATUS_TONE[q.status] || "neutral")}">${esc(QUOTE_STATUS_LABEL[q.status] || q.status)}</span>`
        : "";
      return `
      <div class="rp-qrow rp-qrow-quote">
        <div class="rp-qrow-main">
          <span class="rp-strong">${esc(q.vendor_name || "Shop")}
            ${statusPill}
            ${q.totals_mismatch ? `<span class="status-pill rp-pill-warn" title="The shop's own total doesn't match its line items">Totals differ</span>` : ""}
            ${q.version > 1 ? `<span class="rp-cell-sub" style="display:inline"> · v${esc(String(q.version))}</span>` : ""}
          </span>
          <span class="rp-cell-sub">${esc(meta || "—")}</span>
        </div>
        <span class="rp-strong rp-qamt">${esc(formatCents(q.grand_total_cents ?? q.shop_reported_total_cents))}</span>
        ${(q.line_items || []).length
          ? `<button type="button" class="rp-btn rp-btn-sm" data-rp-quote-toggle="${esc(q.id)}">${(q.line_items || []).length} lines</button>`
          : ""}
        ${q.status === "submitted"
          ? `<button type="button" class="rp-btn rp-btn-sm" data-rp-authorize="${esc(q.id)}">Authorize…</button>`
          : ""}
      </div>
      ${(q.line_items || []).length ? `<div class="rp-qitems" data-rp-quote-items="${esc(q.id)}" hidden>${items}</div>` : ""}`;
    }).join("");

    const compareBtn = comparableQuotes(quotes).length >= 2
      ? `<button type="button" class="rp-link-btn" data-rp-compare>Compare side by side →</button>`
      : "";
    host.innerHTML = `
      ${extractedDraftRows(drafts)}
      ${authSection(auths)}
      ${quotes.length ? `<div class="rp-qhead rp-qhead-row"><span>Quotes received</span>${compareBtn}</div>${quoteRows}` : ""}
      ${requests.length ? `<div class="rp-qhead">Requests</div>${reqRows}` : ""}`;
  }

  async function doRequestAction(c, requestId, action) {
    if (action === "revoke") {
      const ok = typeof window._rrConfirmDialog === "function"
        ? await window._rrConfirmDialog({ title: "Revoke this link?", body: "The shop's secure link stops working immediately. You can copy a fresh link afterwards if needed.", confirmLabel: "Revoke link" })
        : window.confirm("Revoke this shop's secure link?");
      if (!ok) return;
    }
    const { data, error } = await sb().rpc("repair_quote_request_action", {
      p_request_id: requestId, p_action: action,
    });
    if (error) { fail("Couldn't update the request", error); return; }
    if (action === "regenerate" && data?.link) {
      try {
        await navigator.clipboard.writeText(data.link);
        say("Fresh link copied to clipboard");
      } catch {
        window.prompt("Copy the fresh secure link:", data.link);
      }
    } else if (action === "remind") {
      say("Reminder queued");
    } else {
      say("Link revoked");
    }
    loadDrawerQuotes(c.id);
  }

  // ── request-quotes modal ─────────────────────────────────────────────
  async function openRequestModal(c) {
    injectCss();
    el("rr-rp-modal")?.remove();
    const shops = await loadShops();
    const wrap = document.createElement("div");
    wrap.id = "rr-rp-modal";
    const rows = shops.map((s) => {
      const blocked = s.preferred_status === "blocked";
      const noEmail = !s.contact_email;
      const disabled = blocked || noEmail;
      const why = blocked ? (s.blocked_reason ? `Blocked — ${s.blocked_reason}` : "Blocked")
        : noEmail ? "No email on file — edit the shop first" : "";
      const perf = [
        s.avg_response_hours != null ? `responds ~${s.avg_response_hours}h` : null,
        s.quotes_submitted ? `${s.quotes_submitted} quotes` : null,
        s.distance_mi != null ? `${s.distance_mi} mi` : null,
      ].filter(Boolean).join(" · ");
      return `<label class="rp-shoppick${disabled ? " rp-dim" : ""}">
        <input type="checkbox" value="${esc(s.id)}" ${disabled ? "disabled" : ""}>
        <span class="rp-shoppick-main">
          <span class="rp-strong">${esc(s.name)}</span>
          <span class="rp-cell-sub">${esc(disabled ? why : [SHOP_CLASS_LABEL[s.preferred_status] || "", s.kind, perf].filter(Boolean).join(" · "))}</span>
        </span>
        ${shopClassPill(s)}
      </label>`;
    }).join("");
    const defaultRespond = new Date(Date.now() + 2 * 24 * 3600e3);
    defaultRespond.setHours(12, 0, 0, 0);
    const pad = (n) => String(n).padStart(2, "0");
    const respondVal = `${defaultRespond.getFullYear()}-${pad(defaultRespond.getMonth() + 1)}-${pad(defaultRespond.getDate())}T${pad(defaultRespond.getHours())}:${pad(defaultRespond.getMinutes())}`;
    const photoCount = (c.attachments || []).filter((a) => /^image\//.test(a.mime_type || "")).length;
    wrap.innerHTML = `
      <div class="rp-modal-scrim" data-rp-mclose></div>
      <div class="rp-modal-card rp-modal-wide" role="dialog" aria-modal="true" aria-label="Request quotes">
        <header class="rp-modal-head"><h3>Request quotes — ${esc(c.case_number)}</h3><button type="button" class="rp-drawer-x" data-rp-mclose aria-label="Close">✕</button></header>
        <div class="rp-modal-body">
          <div class="rp-field"><span>Shops to contact <em>*</em></span></div>
          <div class="rp-shoplist">${rows || `<div class="rp-table-empty">No shops yet — add one from the Shop Directory tab first.</div>`}</div>
          <div class="rp-form-grid" style="margin-top:var(--s-3)">
            <label class="rp-field"><span>Respond by</span><input id="rr-rp-rq-respond" class="rp-input" type="datetime-local" value="${respondVal}"></label>
            <label class="rp-field"><span>Link expires</span>
              <select id="rr-rp-rq-expires" class="rp-input">
                <option value="7" selected>7 days after send</option>
                <option value="14">14 days after send</option>
                <option value="30">30 days after send</option>
              </select>
            </label>
            <label class="rp-field rp-span2"><span>Message to shops</span>
              <textarea id="rr-rp-rq-message" class="rp-input rp-input-ta" rows="3" maxlength="1500">${esc(c.description || c.title || "")}</textarea>
            </label>
            <div class="rp-field rp-span2" style="flex-direction:row;gap:16px;align-items:center;flex-wrap:wrap">
              <label class="rp-checkline"><input type="checkbox" id="rr-rp-rq-mask" checked> Mask VIN to last 8</label>
              <label class="rp-checkline"><input type="checkbox" id="rr-rp-rq-photos" ${photoCount ? "checked" : "disabled"}> Share photos (${photoCount})</label>
            </div>
          </div>
          <div class="rp-callout rp-callout-info" style="margin:var(--s-3) 0 0">Each shop gets its own secure link and email. Shops never see each other, competing quotes, or your internal notes.</div>
          <div id="rr-rp-rq-results" style="margin-top:var(--s-3)"></div>
        </div>
        <footer class="rp-modal-foot">
          <button type="button" class="rp-btn" data-rp-mclose>Cancel</button>
          <button type="button" class="rp-btn rp-btn-primary" data-rp-rq-send>Send quote requests</button>
        </footer>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener("click", async (e) => {
      if (e.target.closest("[data-rp-mclose]")) { wrap.remove(); return; }
      const copyBtn = e.target.closest("[data-rp-copy-link]");
      if (copyBtn) {
        try { await navigator.clipboard.writeText(copyBtn.getAttribute("data-rp-copy-link")); say("Link copied"); }
        catch { window.prompt("Copy the secure link:", copyBtn.getAttribute("data-rp-copy-link")); }
        return;
      }
      if (!e.target.closest("[data-rp-rq-send]")) return;
      const picked = [...wrap.querySelectorAll(".rp-shoplist input:checked")].map((i) => i.value);
      if (!picked.length) { say("Pick at least one shop", "warn"); return; }
      const respond = wrap.querySelector("#rr-rp-rq-respond").value;
      const btn = e.target.closest("[data-rp-rq-send]");
      btn.disabled = true;
      const { data, error } = await sb().rpc("repair_quote_requests_send", {
        p_case_id: c.id,
        p_vendor_ids: picked,
        p_message: wrap.querySelector("#rr-rp-rq-message").value.trim() || null,
        p_respond_by: respond ? new Date(respond).toISOString() : null,
        p_expires_days: parseInt(wrap.querySelector("#rr-rp-rq-expires").value, 10),
        p_mask_vin: wrap.querySelector("#rr-rp-rq-mask").checked,
        p_share_photos: wrap.querySelector("#rr-rp-rq-photos").checked,
      });
      btn.disabled = false;
      if (error) { fail("Couldn't send the requests", error); return; }
      const results = Array.isArray(data) ? data : [];
      const okCount = results.filter((r) => r.ok).length;
      const resHtml = results.map((r) => r.ok
        ? `<div class="rp-qrow"><div class="rp-qrow-main"><span class="rp-strong">${esc(r.vendor_name)}</span><span class="rp-cell-sub">request sent</span></div><span class="status-pill rp-pill-ok">Sent</span><button type="button" class="rp-btn rp-btn-sm" data-rp-copy-link="${esc(r.link)}">Copy link</button></div>`
        : `<div class="rp-qrow"><div class="rp-qrow-main"><span class="rp-strong">${esc(r.vendor_name || "Shop")}</span><span class="rp-cell-sub">${esc({ vendor_no_email: "no email on file", vendor_blocked: "blocked", request_already_active: "a request is already active", vendor_not_found: "not found" }[r.error] || r.error)}</span></div><span class="status-pill rp-pill-bad">Not sent</span></div>`
      ).join("");
      wrap.querySelector("#rr-rp-rq-results").innerHTML = resHtml;
      btn.remove();
      wrap.querySelector("[data-rp-mclose].rp-btn").textContent = "Done";
      say(okCount ? `${okCount} request${okCount > 1 ? "s" : ""} sent` : "No requests sent", okCount ? undefined : "warn");
      await loadView(true);
      loadDrawerQuotes(c.id);
    });
  }

  // ── phone/manual quote modal ─────────────────────────────────────────
  async function openPhoneQuoteModal(c) {
    injectCss();
    el("rr-rp-modal")?.remove();
    const shops = await loadShops();
    const wrap = document.createElement("div");
    wrap.id = "rr-rp-modal";
    const opts = shops.filter((s) => s.preferred_status !== "blocked")
      .map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
    wrap.innerHTML = `
      <div class="rp-modal-scrim" data-rp-mclose></div>
      <div class="rp-modal-card" role="dialog" aria-modal="true" aria-label="Log phone quote">
        <header class="rp-modal-head"><h3>Log a phone quote</h3><button type="button" class="rp-drawer-x" data-rp-mclose aria-label="Close">✕</button></header>
        <div class="rp-modal-body">
          <label class="rp-field"><span>Shop <em>*</em></span><select id="rr-rp-pq-shop" class="rp-input">${opts || `<option value="">No shops yet</option>`}</select></label>
          <div class="rp-form-grid">
            <label class="rp-field"><span>Quoted total ($) <em>*</em></span><input id="rr-rp-pq-total" class="rp-input" inputmode="decimal" placeholder="e.g. 918.00"></label>
            <label class="rp-field"><span>Earliest appointment</span><input id="rr-rp-pq-appt" class="rp-input" type="date"></label>
          </div>
          <label class="rp-field"><span>Notes (who you spoke to, scope, exclusions)</span><textarea id="rr-rp-pq-notes" class="rp-input rp-input-ta" rows="3" maxlength="1000"></textarea></label>
        </div>
        <footer class="rp-modal-foot">
          <button type="button" class="rp-btn" data-rp-mclose>Cancel</button>
          <button type="button" class="rp-btn rp-btn-primary" data-rp-pq-save>Record quote</button>
        </footer>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener("click", async (e) => {
      if (e.target.closest("[data-rp-mclose]")) { wrap.remove(); return; }
      if (!e.target.closest("[data-rp-pq-save]")) return;
      const shopId = wrap.querySelector("#rr-rp-pq-shop").value;
      if (!shopId) { say("Pick a shop", "warn"); return; }
      const totalRaw = wrap.querySelector("#rr-rp-pq-total").value.replace(/[^0-9.]/g, "");
      const total = totalRaw ? Math.round(parseFloat(totalRaw) * 100) : NaN;
      if (!Number.isFinite(total)) { say("Enter the quoted total", "warn"); return; }
      const appt = wrap.querySelector("#rr-rp-pq-appt").value;
      const btn = e.target.closest("[data-rp-pq-save]");
      btn.disabled = true;
      const { error } = await sb().rpc("repair_quote_manual_add", {
        p_case_id: c.id, p_vendor_id: shopId, p_source: "phone",
        p_grand_total_cents: total, p_line_items: [],
        p_details: {
          notes: wrap.querySelector("#rr-rp-pq-notes").value.trim() || null,
          earliest_appointment_at: appt ? new Date(`${appt}T09:00:00`).toISOString() : null,
        },
      });
      btn.disabled = false;
      if (error) { fail("Couldn't record the quote", error); return; }
      wrap.remove();
      say("Phone quote recorded");
      await loadView(true);
      loadDrawerQuotes(c.id);
    });
  }

  // ── quote comparison modal (Phase 5) ─────────────────────────────────
  // Pure display over stored, server-computed totals: buildComparison()
  // in the engine does the matching; scope differences are WARNED about,
  // never papered over.
  function openCompareModal(c) {
    injectCss();
    el("rr-rp-modal")?.remove();
    const data = S.drawerQuotes;
    const cmp = buildComparison(data?.quotes || []);
    if (cmp.quotes.length < 2) { say("Need at least two open quotes to compare", "warn"); return; }
    const wrap = document.createElement("div");
    wrap.id = "rr-rp-modal";

    const headCells = cmp.quotes.map((q) => {
      const pills = [
        q.is_cheapest ? `<span class="status-pill rp-pill-ok">Lowest</span>` : "",
        q.status === "accepted" ? `<span class="status-pill rp-pill-ok">Accepted</span>` : "",
        q.totals_mismatch ? `<span class="status-pill rp-pill-warn" title="The shop's own total doesn't match its line items">Totals differ</span>` : "",
      ].filter(Boolean).join(" ");
      const meta = [
        q.earliest_appointment_at ? `appt ${formatDay(q.earliest_appointment_at)}` : null,
        q.estimated_completion_at ? `done ${formatDay(q.estimated_completion_at)}` : null,
        q.warranty_summary || null,
      ].filter(Boolean).join(" · ");
      return `<th class="rp-cmp-col">
        <div class="rp-strong">${esc(q.vendor_name || "Shop")}${q.version > 1 ? ` <span class="rp-cell-sub" style="display:inline">v${esc(String(q.version))}</span>` : ""}</div>
        <div class="rp-cmp-total">${esc(formatCents(q.compare_total_cents))}</div>
        ${q.delta_vs_cheapest_cents != null && q.delta_vs_cheapest_cents !== 0
          ? `<div class="rp-cmp-delta">+${esc(formatCents(q.delta_vs_cheapest_cents))} vs lowest</div>` : ""}
        ${pills ? `<div class="rp-cmp-pills">${pills}</div>` : ""}
        ${meta ? `<div class="rp-cell-sub">${esc(meta)}</div>` : ""}
        ${q.status === "submitted" || q.status === "accepted"
          ? `<button type="button" class="rp-btn rp-btn-sm rp-btn-primary" data-rp-cmp-auth="${esc(q.id)}" style="margin-top:var(--s-2)">Authorize…</button>` : ""}
      </th>`;
    }).join("");

    const bodyRows = cmp.rows.map((r) => {
      const cells = cmp.quotes.map((q) => {
        const cell = r.cells[q.id];
        if (!cell) return `<td class="num rp-cmp-missing" title="Not in this quote">—</td>`;
        return `<td class="num">${esc(formatCents(cell.cents))}${cell.count > 1 ? ` <span class="rp-cell-sub" style="display:inline">×${cell.count}</span>` : ""}</td>`;
      }).join("");
      return `<tr>
        <td><span class="rp-cmp-desc">${esc(r.description)}</span>${r.category ? `<span class="rp-cell-sub">${esc(r.category.replace(/_/g, " "))}</span>` : ""}</td>
        ${cells}
      </tr>`;
    }).join("");

    wrap.innerHTML = `
      <div class="rp-modal-scrim" data-rp-mclose></div>
      <div class="rp-modal-card rp-modal-xwide" role="dialog" aria-modal="true" aria-label="Compare quotes">
        <header class="rp-modal-head"><h3>Compare quotes — ${esc(c.case_number)}</h3><button type="button" class="rp-drawer-x" data-rp-mclose aria-label="Close">✕</button></header>
        <div class="rp-modal-body">
          ${cmp.warnings.length ? `<div class="rp-callout rp-callout-warn" style="margin:0 0 var(--s-3)"><strong>The quotes don't cover the same work.</strong><br>${cmp.warnings.map(esc).join("<br>")}</div>` : ""}
          <div class="rp-cmp-scroll">
            <table class="rp-cmp">
              <thead><tr><th class="rp-cmp-rowhead"></th>${headCells}</tr></thead>
              <tbody>
                ${bodyRows || `<tr><td class="rp-cell-sub" colspan="${cmp.quotes.length + 1}" style="padding:var(--s-3) 0">No line detail to compare — the totals above are all the shops provided.</td></tr>`}
                <tr class="rp-cmp-totalrow">
                  <td><span class="rp-strong">Total</span><span class="rp-cell-sub">as quoted, incl. tax</span></td>
                  ${cmp.quotes.map((q) => `<td class="num rp-strong">${esc(formatCents(q.compare_total_cents))}</td>`).join("")}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <footer class="rp-modal-foot">
          <button type="button" class="rp-btn" data-rp-mclose>Close</button>
        </footer>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener("click", (e) => {
      if (e.target.closest("[data-rp-mclose]")) { wrap.remove(); return; }
      const authBtn = e.target.closest("[data-rp-cmp-auth]");
      if (authBtn) {
        const quote = (data?.quotes || []).find((q) => q.id === authBtn.getAttribute("data-rp-cmp-auth"));
        openAuthorizeModal(c, quote || null);
      }
    });
  }

  // ── authorize modal (Phase 5) ────────────────────────────────────────
  // The client only collects the DECISION — every authorized amount is
  // recomputed server-side by repair_authorization_issue().
  async function openAuthorizeModal(c, quote) {
    injectCss();
    el("rr-rp-modal")?.remove();
    const shops = quote ? [] : await loadShops();
    const wrap = document.createElement("div");
    wrap.id = "rr-rp-modal";
    const types = quote
      ? [["full", "Full quote", "Everything on the quote"],
         ["selected_lines", "Selected lines", "Approve some items, decline the rest"],
         ["diagnostics_only", "Diagnostics only", "Diagnose first, quote the fix after"],
         ["not_to_exceed", "Not-to-exceed", "Cap the spend, shop proceeds up to it"]]
      : [["diagnostics_only", "Diagnostics only", "Diagnose first, quote the fix after"],
         ["not_to_exceed", "Not-to-exceed", "Cap the spend, shop proceeds up to it"]];
    const typeBtns = types.map(([k, label, hint], i) => `
      <label class="rp-authtype-opt" title="${esc(hint)}">
        <input type="radio" name="rr-rp-au-type" value="${esc(k)}" ${i === 0 ? "checked" : ""}>
        <span>${esc(label)}</span>
      </label>`).join("");
    const lineRows = (quote?.line_items || []).map((li) => `
      <label class="rp-authline">
        <input type="checkbox" data-rp-au-line="${esc(li.id)}" data-rp-au-cents="${esc(String(li.line_total_cents ?? 0))}" checked>
        <span class="rp-authline-desc">${esc(li.description)}${li.recommended && !li.required ? ` <span class="rp-cell-sub" style="display:inline">· recommended</span>` : ""}</span>
        <span class="rp-qli-amt">${esc(formatCents(li.line_total_cents))}</span>
      </label>`).join("");
    const shopOpts = shops.filter((s) => s.preferred_status !== "blocked")
      .map((s) => `<option value="${esc(s.id)}"${s.id === c.vendor?.id ? " selected" : ""}>${esc(s.name)}</option>`).join("");
    const otherSubmitted = (S.drawerQuotes?.quotes || [])
      .filter((q) => q.status === "submitted" && (!quote || q.id !== quote.id)).length;
    const quoteTotal = quote ? (quote.grand_total_cents ?? quote.shop_reported_total_cents) : null;

    wrap.innerHTML = `
      <div class="rp-modal-scrim" data-rp-mclose></div>
      <div class="rp-modal-card rp-modal-wide" role="dialog" aria-modal="true" aria-label="Authorize work">
        <header class="rp-modal-head"><h3>Authorize work — ${esc(c.case_number)}</h3><button type="button" class="rp-drawer-x" data-rp-mclose aria-label="Close">✕</button></header>
        <div class="rp-modal-body">
          ${quote
            ? `<div class="rp-qrow" style="border-bottom:1px solid var(--border-subtle);padding-top:0">
                 <div class="rp-qrow-main"><span class="rp-strong">${esc(quote.vendor_name || "Shop")}</span>
                 <span class="rp-cell-sub">${esc([quote.quote_number ? `quote ${quote.quote_number}` : null, `${(quote.line_items || []).length} lines`].filter(Boolean).join(" · "))}</span></div>
                 <span class="rp-strong rp-qamt">${esc(formatCents(quoteTotal))}</span>
               </div>`
            : `<label class="rp-field"><span>Shop <em>*</em></span><select id="rr-rp-au-shop" class="rp-input">${shopOpts || `<option value="">No shops yet</option>`}</select></label>`}
          <div class="rp-field" style="margin-top:var(--s-3)"><span>What's authorized?</span></div>
          <div class="rp-authtype">${typeBtns}</div>
          <div id="rr-rp-au-lines-wrap" hidden style="margin-top:var(--s-3)">
            <div class="rp-authlines">${lineRows}</div>
            <div class="rp-authsum">Selected total <strong id="rr-rp-au-sum">${esc(formatCents(quote ? sumCents((quote.line_items || []).map((li) => li.line_total_cents)) : 0))}</strong> <span class="rp-cell-sub" style="display:inline">— recomputed by the server at issue</span></div>
          </div>
          <div class="rp-form-grid" style="margin-top:var(--s-3)">
            <label class="rp-field" id="rr-rp-au-amount-wrap" hidden><span id="rr-rp-au-amount-label">Cap ($)</span>
              <input id="rr-rp-au-amount" class="rp-input" inputmode="decimal" placeholder="e.g. 500.00"></label>
            <label class="rp-field"><span>PO number</span><input id="rr-rp-au-po" class="rp-input" maxlength="60"></label>
            <label class="rp-field rp-span2"><span>Note to the shop</span>
              <textarea id="rr-rp-au-notes" class="rp-input rp-input-ta" rows="2" maxlength="2000" placeholder="e.g. Please call before replacing anything beyond the approved lines"></textarea></label>
            <div class="rp-field rp-span2" style="flex-direction:row;gap:16px;align-items:center;flex-wrap:wrap">
              <label class="rp-checkline"><input type="checkbox" id="rr-rp-au-email" checked> Email the shop (with an acknowledge link)</label>
              ${quote && otherSubmitted
                ? `<label class="rp-checkline"><input type="checkbox" id="rr-rp-au-decline"> Decline the ${otherSubmitted} other quote${otherSubmitted > 1 ? "s" : ""}</label>` : ""}
            </div>
          </div>
        </div>
        <footer class="rp-modal-foot">
          <button type="button" class="rp-btn" data-rp-mclose>Cancel</button>
          <button type="button" class="rp-btn rp-btn-primary" data-rp-au-issue>Issue authorization</button>
        </footer>
      </div>`;
    document.body.appendChild(wrap);

    const syncType = () => {
      const t = wrap.querySelector("input[name='rr-rp-au-type']:checked")?.value;
      wrap.querySelector("#rr-rp-au-lines-wrap").hidden = t !== "selected_lines";
      const amtWrap = wrap.querySelector("#rr-rp-au-amount-wrap");
      amtWrap.hidden = t !== "not_to_exceed" && t !== "diagnostics_only";
      wrap.querySelector("#rr-rp-au-amount-label").textContent =
        t === "not_to_exceed" ? "Cap ($) *" : "Diagnostic cap ($, optional)";
    };
    wrap.querySelectorAll("input[name='rr-rp-au-type']").forEach((r) => r.addEventListener("change", syncType));
    syncType();
    const syncSum = () => {
      const cents = [...wrap.querySelectorAll("[data-rp-au-line]:checked")]
        .map((i) => parseInt(i.getAttribute("data-rp-au-cents"), 10));
      const sumEl = wrap.querySelector("#rr-rp-au-sum");
      if (sumEl) sumEl.textContent = formatCents(sumCents(cents));
    };
    wrap.querySelectorAll("[data-rp-au-line]").forEach((i) => i.addEventListener("change", syncSum));

    wrap.addEventListener("click", async (e) => {
      if (e.target.closest("[data-rp-mclose]")) { wrap.remove(); return; }
      if (!e.target.closest("[data-rp-au-issue]")) return;
      const type = wrap.querySelector("input[name='rr-rp-au-type']:checked")?.value;
      const vendorId = quote ? null : wrap.querySelector("#rr-rp-au-shop")?.value;
      if (!quote && !vendorId) { say("Pick a shop", "warn"); return; }
      let lineDecisions = [];
      if (type === "selected_lines") {
        const boxes = [...wrap.querySelectorAll("[data-rp-au-line]")];
        lineDecisions = boxes.map((b) => ({
          id: b.getAttribute("data-rp-au-line"),
          decision: b.checked ? "approved" : "declined",
        }));
        if (!lineDecisions.some((d) => d.decision === "approved")) {
          say("Approve at least one line — or decline the quote instead", "warn");
          return;
        }
      }
      let amountCents = null;
      if (type === "not_to_exceed" || type === "diagnostics_only") {
        const m = parseMoney(wrap.querySelector("#rr-rp-au-amount").value);
        if (!m.ok) {
          say(m.reason === "too_large" ? "That cap looks wrong — amounts above $1,000,000 aren't accepted"
            : m.reason === "negative" ? "The cap can't be negative"
            : "Enter the cap as a dollar amount, e.g. 500.00", "warn");
          return;
        }
        if (type === "not_to_exceed" && (m.cents == null || m.cents <= 0)) {
          say("A not-to-exceed authorization needs a cap amount", "warn");
          return;
        }
        amountCents = m.cents;
      }
      const btn = e.target.closest("[data-rp-au-issue]");
      btn.disabled = true;
      const { data, error } = await sb().rpc("repair_authorization_issue", {
        p_case_id: c.id,
        p_type: type,
        p_quote_id: quote?.id || null,
        p_vendor_id: vendorId || null,
        p_line_decisions: lineDecisions,
        p_amount_cents: amountCents,
        p_po_number: wrap.querySelector("#rr-rp-au-po").value.trim() || null,
        p_notes: wrap.querySelector("#rr-rp-au-notes").value.trim() || null,
        p_decline_others: wrap.querySelector("#rr-rp-au-decline")?.checked || false,
        p_send_email: wrap.querySelector("#rr-rp-au-email").checked,
      });
      btn.disabled = false;
      if (error) { fail("Couldn't issue the authorization", error); return; }
      wrap.remove();
      if (data?.email_queued) say("Authorization issued and emailed to the shop");
      else say("Authorization issued — the shop has no email on file, so tell them directly", "warn");
      await refreshDrawer(c.id);
    });
  }

  async function doAuthAction(c, authId, action) {
    let note = null;
    if (action === "revoke") {
      note = window.prompt("Revoke this authorization? The shop should stop any unstarted work.\nOptional reason (shared with the shop):", "");
      if (note === null) return;
      note = note.trim() || null;
    } else if (action === "mark_acknowledged") {
      note = window.prompt("Record the acknowledgement — who confirmed it (name, optional)?", "");
      if (note === null) return;
      note = note.trim() || null;
    }
    const { data, error } = await sb().rpc("repair_authorization_action", {
      p_authorization_id: authId, p_action: action, p_note: note,
    });
    if (error) { fail("Couldn't update the authorization", error); return; }
    if (action === "resend") {
      say(data?.email_queued ? "Authorization email queued" : "Couldn't email — the shop has no address on file", data?.email_queued ? undefined : "warn");
      loadDrawerQuotes(c.id);
    } else if (action === "mark_acknowledged") {
      say("Acknowledgement recorded");
      loadDrawerQuotes(c.id);
    } else {
      say("Authorization revoked");
      await refreshDrawer(c.id);
    }
  }

  // ── invoices & reconciliation (Phase 8) ──────────────────────────────
  async function loadDrawerInvoices(caseId) {
    const host = el("rr-rp-invoices");
    if (!host) return;
    const { data, error } = await sb().rpc("repair_case_invoices", { p_case_id: caseId });
    if (!el("rr-rp-invoices")) return; // drawer closed meanwhile
    if (error || !data) {
      host.innerHTML = `<div class="rp-table-empty rp-error">Couldn't load invoices · ${esc(error?.message || "try again")}</div>`;
      return;
    }
    S.drawerInvoices = data;
    renderDrawerInvoices(host, data);
  }

  function renderDrawerInvoices(host, data) {
    const invoices = data.invoices || [];
    const auth = data.authorization;
    if (!invoices.length) {
      host.innerHTML = `<div class="rp-table-empty" style="padding:var(--s-2) 0;text-align:left">No invoice yet — it arrives by email or upload (extracted automatically), or log it manually.</div>`;
      return;
    }
    host.innerHTML = invoices.map((inv) => {
      const rec = buildReconciliation(inv, auth);
      const pills = [
        `<span class="status-pill rp-pill-${esc(INVOICE_STATUS_TONE[inv.status] || "neutral")}">${esc(INVOICE_STATUS_LABEL[inv.status] || inv.status)}</span>`,
        inv.totals_mismatch ? `<span class="status-pill rp-pill-warn" title="The invoice's printed total doesn't match its own line items">Totals differ</span>` : "",
        rec.over && inv.status !== "superseded"
          ? `<span class="status-pill rp-pill-bad" title="Invoice total is above the authorized amount">+${esc(formatCents(rec.variance_cents))} over</span>` : "",
      ].filter(Boolean).join(" ");
      const sub = [
        inv.vendor_name || "shop not identified",
        inv.invoice_number ? `#${inv.invoice_number}` : null,
        inv.status === "settled" && inv.variance_note ? `variance: ${inv.variance_note}` : null,
        inv.status === "disputed" && inv.dispute_note ? `dispute: ${inv.dispute_note}` : null,
      ].filter(Boolean).join(" · ");
      const action = inv.status === "draft"
        ? `<button type="button" class="rp-btn rp-btn-sm rp-btn-primary" data-rp-inv-review="${esc(inv.id)}">Review…</button>`
        : (inv.status === "recorded" || inv.status === "disputed")
          ? `<button type="button" class="rp-btn rp-btn-sm rp-btn-primary" data-rp-inv-reconcile="${esc(inv.id)}">Reconcile…</button>`
          : "";
      return `
      <div class="rp-qrow${inv.status === "superseded" ? " rp-dim" : ""}">
        <div class="rp-qrow-main">
          <span class="rp-strong">Invoice ${pills}</span>
          <span class="rp-cell-sub">${esc(sub)}</span>
        </div>
        <span class="rp-strong rp-qamt">${esc(formatCents(inv.grand_total_cents ?? inv.shop_reported_total_cents))}</span>
        ${action}
      </div>`;
    }).join("");
  }

  // Draft invoice review — record or discard, numbers never editable.
  async function openInvoiceReviewModal(c, inv) {
    injectCss();
    el("rr-rp-modal")?.remove();
    const shops = inv.vendor_id ? [] : await loadShops();
    const wrap = document.createElement("div");
    wrap.id = "rr-rp-modal";
    const shopOpts = shops.filter((s) => s.preferred_status !== "blocked")
      .map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
    const srcAtt = (c.attachments || []).find((a) => a.id === inv.extracted_from_attachment_id);
    const items = (inv.line_items || []).map((li) => `
      <div class="rp-qli">
        <span class="rp-qli-desc">${esc(li.description)}</span>
        <span class="rp-qli-amt">${esc(formatCents(li.line_total_cents))}</span>
      </div>`).join("");
    wrap.innerHTML = `
      <div class="rp-modal-scrim" data-rp-mclose></div>
      <div class="rp-modal-card rp-modal-wide" role="dialog" aria-modal="true" aria-label="Review extracted invoice">
        <header class="rp-modal-head"><h3>Review extracted invoice — ${esc(c.case_number)}</h3><button type="button" class="rp-drawer-x" data-rp-mclose aria-label="Close">✕</button></header>
        <div class="rp-modal-body">
          <div class="rp-callout rp-callout-warn" style="margin:0 0 var(--s-3)">Read by AI from the document — <strong>check the numbers against the original</strong>. Recording doesn't approve anything; reconciliation against the authorization comes next.</div>
          <div class="rp-qrow" style="padding-top:0">
            <div class="rp-qrow-main">
              <span class="rp-strong">${esc(inv.vendor_name || "Shop not identified")}</span>
              <span class="rp-cell-sub">${esc([inv.invoice_number ? `#${inv.invoice_number}` : null, `${(inv.line_items || []).length} lines`].filter(Boolean).join(" · "))}</span>
            </div>
            ${srcAtt ? `<button type="button" class="rp-btn rp-btn-sm" data-rp-att-path="${esc(srcAtt.storage_path)}" data-rp-att-bucket="${esc(srcAtt.storage_bucket)}">Open document</button>` : ""}
          </div>
          ${inv.vendor_id ? "" : `<label class="rp-field" style="margin-bottom:var(--s-3)"><span>Which shop sent this? <em>*</em></span><select id="rr-rp-iv-shop" class="rp-input">${shopOpts || `<option value="">No shops yet</option>`}</select></label>`}
          <div class="rp-qitems" style="margin:0">${items || `<div class="rp-cell-sub">No line detail was readable.</div>`}</div>
          <div class="rp-qrow" style="border-bottom:none">
            <div class="rp-qrow-main"><span class="rp-strong">Computed total</span><span class="rp-cell-sub">recomputed from the lines by the server</span></div>
            <span class="rp-strong rp-qamt">${esc(formatCents(inv.grand_total_cents))}</span>
          </div>
          ${inv.totals_mismatch ? `<div class="rp-callout rp-callout-warn" style="margin:var(--s-2) 0 0">The invoice's printed total (${esc(formatCents(inv.shop_reported_total_cents))}) doesn't match its own line items — flagged, not corrected.</div>` : ""}
        </div>
        <footer class="rp-modal-foot">
          <button type="button" class="rp-btn rp-btn-danger" data-rp-iv-discard>Discard</button>
          <span style="flex:1"></span>
          <button type="button" class="rp-btn" data-rp-mclose>Cancel</button>
          <button type="button" class="rp-btn rp-btn-primary" data-rp-iv-record>Record invoice</button>
        </footer>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener("click", async (e) => {
      if (e.target.closest("[data-rp-mclose]")) { wrap.remove(); return; }
      const openDoc = e.target.closest("[data-rp-att-path]");
      if (openDoc) { await openAttachment(openDoc.getAttribute("data-rp-att-bucket"), openDoc.getAttribute("data-rp-att-path")); return; }
      const record = e.target.closest("[data-rp-iv-record]");
      const discard = e.target.closest("[data-rp-iv-discard]");
      if (!record && !discard) return;
      let vendorId = null;
      if (record && !inv.vendor_id) {
        vendorId = wrap.querySelector("#rr-rp-iv-shop")?.value || null;
        if (!vendorId) { say("Pick the shop this invoice came from", "warn"); return; }
      }
      const btn = record || discard;
      btn.disabled = true;
      const { error } = await sb().rpc("repair_invoice_review", {
        p_invoice_id: inv.id,
        p_action: record ? "record" : "discard",
        p_vendor_id: vendorId,
      });
      btn.disabled = false;
      if (error) { fail("Couldn't save the review", error); return; }
      wrap.remove();
      say(record ? "Invoice recorded — reconcile it next" : "Extraction discarded", record ? "warn" : undefined);
      loadDrawerInvoices(c.id);
    });
  }

  // Reconciliation — the invoice diffed line-by-line against the
  // authorization snapshot. Display math (engine buildReconciliation);
  // the settle RPC re-derives the authoritative variance in SQL and
  // refuses an over-authorization settle without a reason.
  function openReconcileModal(c, inv) {
    injectCss();
    el("rr-rp-modal")?.remove();
    const auth = S.drawerInvoices?.authorization || null;
    const rec = buildReconciliation(inv, auth);
    const wrap = document.createElement("div");
    wrap.id = "rr-rp-modal";
    const rowHtml = (r) => {
      const tag = r.state === "not_authorized"
        ? ` <span class="status-pill rp-pill-warn">not authorized</span>`
        : r.state === "not_invoiced" ? ` <span class="rp-cell-sub" style="display:inline">not invoiced</span>` : "";
      return `<tr class="${r.state === "not_invoiced" ? "rp-dim" : ""}">
        <td><span class="rp-cmp-desc">${esc(r.description)}</span>${r.category ? `<span class="rp-cell-sub">${esc(String(r.category).replace(/_/g, " "))}</span>` : ""}</td>
        <td class="num">${r.authorized_cents != null ? esc(formatCents(r.authorized_cents)) : `<span class="rp-cmp-missing">—</span>`}</td>
        <td class="num">${r.invoice_cents != null ? esc(formatCents(r.invoice_cents)) + tag : `<span class="rp-cmp-missing">—</span>`}</td>
        <td class="num">${r.delta_cents != null && r.delta_cents !== 0
          ? `<span class="${r.delta_cents > 0 ? "rp-money-over" : ""}">${r.delta_cents > 0 ? "+" : ""}${esc(formatCents(r.delta_cents))}</span>`
          : `<span class="rp-cmp-missing">${r.delta_cents === 0 ? "±0" : "—"}</span>`}</td>
      </tr>`;
    };
    wrap.innerHTML = `
      <div class="rp-modal-scrim" data-rp-mclose></div>
      <div class="rp-modal-card rp-modal-xwide" role="dialog" aria-modal="true" aria-label="Reconcile invoice">
        <header class="rp-modal-head"><h3>Reconcile invoice — ${esc(c.case_number)}</h3><button type="button" class="rp-drawer-x" data-rp-mclose aria-label="Close">✕</button></header>
        <div class="rp-modal-body">
          ${!rec.has_authorization ? `<div class="rp-callout rp-callout-warn" style="margin:0 0 var(--s-3)">No active authorization on this case — there's nothing to reconcile against. You can still settle, but consider why work happened without an authorization.</div>` : ""}
          ${rec.over ? `<div class="rp-callout rp-callout-bad" style="margin:0 0 var(--s-3)"><strong>Invoice exceeds the authorization by ${esc(formatCents(rec.variance_cents))}.</strong> Settling requires a reason — it goes on the timeline and the audit log.</div>` : ""}
          ${rec.unauthorized_cents > 0 ? `<div class="rp-callout rp-callout-warn" style="margin:0 0 var(--s-3)">${esc(formatCents(rec.unauthorized_cents))} of line items fall outside the authorized scope (tagged below).</div>` : ""}
          <div class="rp-cmp-scroll">
            <table class="rp-cmp">
              <thead><tr><th></th><th class="num">Authorized</th><th class="num">Invoice</th><th class="num">Δ</th></tr></thead>
              <tbody>
                ${rec.rows.map(rowHtml).join("") || `<tr><td colspan="4" class="rp-cell-sub" style="padding:var(--s-3) 0">No line detail on either side — totals-only reconciliation.</td></tr>`}
                <tr class="rp-cmp-totalrow">
                  <td><span class="rp-strong">Total</span></td>
                  <td class="num rp-strong">${esc(formatCents(rec.authorized_cents))}</td>
                  <td class="num rp-strong">${esc(formatCents(rec.invoiced_cents))}</td>
                  <td class="num rp-strong">${rec.variance_cents != null
                    ? `<span class="${rec.variance_cents > 0 ? "rp-money-over" : ""}">${rec.variance_cents > 0 ? "+" : ""}${esc(formatCents(rec.variance_cents))}</span>` : "—"}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <label class="rp-field" style="margin-top:var(--s-3)"><span>${rec.over ? "Reason for accepting the variance <em>*</em>" : "Note (required to dispute)"}</span>
            <textarea id="rr-rp-rc-note" class="rp-input rp-input-ta" rows="2" maxlength="500" placeholder="${rec.over ? "e.g. Shop called 7/15 — seized caliper bolt added 0.5h labor, approved by phone" : "e.g. Disputing the second diagnostic charge — already paid on the estimate"}"></textarea>
          </label>
        </div>
        <footer class="rp-modal-foot">
          <button type="button" class="rp-btn rp-btn-danger" data-rp-rc-dispute>Dispute…</button>
          <span style="flex:1"></span>
          <button type="button" class="rp-btn" data-rp-mclose>Cancel</button>
          <button type="button" class="rp-btn rp-btn-primary" data-rp-rc-accept>Accept &amp; settle</button>
        </footer>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener("click", async (e) => {
      if (e.target.closest("[data-rp-mclose]")) { wrap.remove(); return; }
      const accept = e.target.closest("[data-rp-rc-accept]");
      const dispute = e.target.closest("[data-rp-rc-dispute]");
      if (!accept && !dispute) return;
      const note = wrap.querySelector("#rr-rp-rc-note").value.trim();
      if (accept && rec.over && !note) {
        say("A reason is required to settle above the authorization", "warn");
        return;
      }
      if (dispute && !note) {
        say("Write what you're disputing first", "warn");
        return;
      }
      const btn = accept || dispute;
      btn.disabled = true;
      const { error } = await sb().rpc("repair_invoice_settle", {
        p_invoice_id: inv.id,
        p_action: accept ? "accept" : "dispute",
        p_note: note || null,
      });
      btn.disabled = false;
      if (error) { fail("Couldn't save the reconciliation", error); return; }
      wrap.remove();
      say(accept ? "Invoice settled" : "Invoice disputed — logged on the timeline", accept ? undefined : "warn");
      await refreshDrawer(c.id);
    });
  }

  // Manual invoice entry (paper/phone).
  async function openLogInvoiceModal(c) {
    injectCss();
    el("rr-rp-modal")?.remove();
    const shops = await loadShops();
    const wrap = document.createElement("div");
    wrap.id = "rr-rp-modal";
    const opts = shops.filter((s) => s.preferred_status !== "blocked")
      .map((s) => `<option value="${esc(s.id)}"${s.id === c.vendor?.id ? " selected" : ""}>${esc(s.name)}</option>`).join("");
    wrap.innerHTML = `
      <div class="rp-modal-scrim" data-rp-mclose></div>
      <div class="rp-modal-card" role="dialog" aria-modal="true" aria-label="Log invoice">
        <header class="rp-modal-head"><h3>Log invoice — ${esc(c.case_number)}</h3><button type="button" class="rp-drawer-x" data-rp-mclose aria-label="Close">✕</button></header>
        <div class="rp-modal-body">
          <label class="rp-field"><span>Shop <em>*</em></span><select id="rr-rp-li-shop" class="rp-input">${opts || `<option value="">No shops yet</option>`}</select></label>
          <div class="rp-form-grid">
            <label class="rp-field"><span>Invoice total ($) <em>*</em></span><input id="rr-rp-li-total" class="rp-input" inputmode="decimal" placeholder="e.g. 641.98"></label>
            <label class="rp-field"><span>Invoice #</span><input id="rr-rp-li-number" class="rp-input" maxlength="60"></label>
          </div>
          <label class="rp-field"><span>Notes</span><textarea id="rr-rp-li-notes" class="rp-input rp-input-ta" rows="2" maxlength="1000"></textarea></label>
        </div>
        <footer class="rp-modal-foot">
          <button type="button" class="rp-btn" data-rp-mclose>Cancel</button>
          <button type="button" class="rp-btn rp-btn-primary" data-rp-li-save>Record invoice</button>
        </footer>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener("click", async (e) => {
      if (e.target.closest("[data-rp-mclose]")) { wrap.remove(); return; }
      if (!e.target.closest("[data-rp-li-save]")) return;
      const shopId = wrap.querySelector("#rr-rp-li-shop").value;
      if (!shopId) { say("Pick a shop", "warn"); return; }
      const m = parseMoney(wrap.querySelector("#rr-rp-li-total").value);
      if (!m.ok || m.cents == null) {
        say(m.reason === "too_large" ? "That total looks wrong — amounts above $1,000,000 aren't accepted"
          : "Enter the invoice total as a dollar amount, e.g. 641.98", "warn");
        return;
      }
      const btn = e.target.closest("[data-rp-li-save]");
      btn.disabled = true;
      const { error } = await sb().rpc("repair_invoice_manual_add", {
        p_case_id: c.id, p_vendor_id: shopId,
        p_grand_total_cents: m.cents, p_line_items: [],
        p_details: {
          invoice_number: wrap.querySelector("#rr-rp-li-number").value.trim() || null,
          notes: wrap.querySelector("#rr-rp-li-notes").value.trim() || null,
        },
      });
      btn.disabled = false;
      if (error) { fail("Couldn't record the invoice", error); return; }
      wrap.remove();
      say("Invoice recorded — reconcile it when ready");
      loadDrawerInvoices(c.id);
    });
  }

  // ── extracted-quote review (Phase 7) ─────────────────────────────────
  async function doExtractAttachment(c, btn) {
    const attachmentId = btn.getAttribute("data-rp-extract");
    btn.disabled = true;
    btn.textContent = "Reading…";
    const { data, error } = await sb().functions.invoke("repair-quote-extract", {
      body: { attachment_id: attachmentId },
    });
    btn.disabled = false;
    btn.textContent = "Extract quote";
    if (error || !data?.ok) {
      fail("Couldn't read the document", error || { message: data?.error || "try again" });
      return;
    }
    if (data.kind === "estimate" && data.quote_id) {
      say("Estimate extracted — review it under Quotes & shops", "warn");
    } else if (data.kind === "invoice") {
      say("That's an invoice — saved for reconciliation (coming in the next phase)", "warn");
    } else {
      say("Document read — no estimate found in it", "warn");
    }
    loadDrawerQuotes(c.id);
  }

  // Human confirmation of an extracted draft. The modal never edits the
  // transcribed numbers — accept/discard only, with the source document
  // one click away for eyeball verification.
  async function openExtractReviewModal(c, q) {
    injectCss();
    el("rr-rp-modal")?.remove();
    const shops = q.vendor_id ? [] : await loadShops();
    const wrap = document.createElement("div");
    wrap.id = "rr-rp-modal";
    const shopOpts = shops.filter((s) => s.preferred_status !== "blocked")
      .map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
    const srcAtt = (c.attachments || []).find((a) => a.id === q.extracted_from_attachment_id);
    const conf = q.extraction_confidence != null
      ? `${Math.round(Number(q.extraction_confidence) * 100)}%` : "—";
    const items = (q.line_items || []).map((li) => `
      <div class="rp-qli">
        <span class="rp-qli-desc">${esc(li.description)}${li.part_number ? ` <span class="rp-cell-sub" style="display:inline">· ${esc(li.part_number)}</span>` : ""}</span>
        <span class="rp-qli-amt">${esc(formatCents(li.line_total_cents))}</span>
      </div>`).join("");
    wrap.innerHTML = `
      <div class="rp-modal-scrim" data-rp-mclose></div>
      <div class="rp-modal-card rp-modal-wide" role="dialog" aria-modal="true" aria-label="Review extracted estimate">
        <header class="rp-modal-head"><h3>Review extracted estimate — ${esc(c.case_number)}</h3><button type="button" class="rp-drawer-x" data-rp-mclose aria-label="Close">✕</button></header>
        <div class="rp-modal-body">
          <div class="rp-callout rp-callout-warn" style="margin:0 0 var(--s-3)">Read by AI from the document — <strong>check the numbers against the original before accepting</strong>. Accepting never changes an amount; it only lets this estimate count as a quote.</div>
          <div class="rp-qrow" style="padding-top:0">
            <div class="rp-qrow-main">
              <span class="rp-strong">${esc(q.vendor_name || "Shop not identified")}</span>
              <span class="rp-cell-sub">${esc([q.quote_number ? `#${q.quote_number}` : null, `${(q.line_items || []).length} lines`, `${conf} confidence`].filter(Boolean).join(" · "))}</span>
            </div>
            ${srcAtt ? `<button type="button" class="rp-btn rp-btn-sm" data-rp-att-path="${esc(srcAtt.storage_path)}" data-rp-att-bucket="${esc(srcAtt.storage_bucket)}">Open document</button>` : ""}
          </div>
          ${q.vendor_id ? "" : `<label class="rp-field" style="margin-bottom:var(--s-3)"><span>Which shop sent this? <em>*</em></span><select id="rr-rp-rv-shop" class="rp-input">${shopOpts || `<option value="">No shops yet</option>`}</select></label>`}
          <div class="rp-qitems" style="margin:0">${items || `<div class="rp-cell-sub">No line detail was readable.</div>`}</div>
          <div class="rp-qrow" style="border-bottom:none">
            <div class="rp-qrow-main"><span class="rp-strong">Computed total</span><span class="rp-cell-sub">recomputed from the lines by the server</span></div>
            <span class="rp-strong rp-qamt">${esc(formatCents(q.grand_total_cents))}</span>
          </div>
          ${q.shop_reported_total_cents != null && q.shop_reported_total_cents !== q.grand_total_cents ? `
          <div class="rp-qrow" style="border-bottom:none;padding-top:0">
            <div class="rp-qrow-main"><span>Document's printed total</span></div>
            <span class="rp-qamt">${esc(formatCents(q.shop_reported_total_cents))}</span>
          </div>` : ""}
          ${q.totals_mismatch ? `<div class="rp-callout rp-callout-warn" style="margin:var(--s-2) 0 0">The document's printed total doesn't match its own line items — flagged, not corrected. Check the original.</div>` : ""}
        </div>
        <footer class="rp-modal-foot">
          <button type="button" class="rp-btn rp-btn-danger" data-rp-rv-discard>Discard</button>
          <span style="flex:1"></span>
          <button type="button" class="rp-btn" data-rp-mclose>Cancel</button>
          <button type="button" class="rp-btn rp-btn-primary" data-rp-rv-accept>Accept as submitted quote</button>
        </footer>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener("click", async (e) => {
      if (e.target.closest("[data-rp-mclose]")) { wrap.remove(); return; }
      const openDoc = e.target.closest("[data-rp-att-path]");
      if (openDoc) { await openAttachment(openDoc.getAttribute("data-rp-att-bucket"), openDoc.getAttribute("data-rp-att-path")); return; }
      const accept = e.target.closest("[data-rp-rv-accept]");
      const discard = e.target.closest("[data-rp-rv-discard]");
      if (!accept && !discard) return;
      let vendorId = null;
      if (accept && !q.vendor_id) {
        vendorId = wrap.querySelector("#rr-rp-rv-shop")?.value || null;
        if (!vendorId) { say("Pick the shop this estimate came from", "warn"); return; }
      }
      if (discard) {
        const ok = typeof window._rrConfirmDialog === "function"
          ? await window._rrConfirmDialog({ title: "Discard this extraction?", body: "The draft is deleted; the source document stays on the case and can be re-extracted any time.", confirmLabel: "Discard" })
          : window.confirm("Discard this extracted draft?");
        if (!ok) return;
      }
      const btn = accept || discard;
      btn.disabled = true;
      const { error } = await sb().rpc("repair_quote_review", {
        p_quote_id: q.id,
        p_action: accept ? "accept" : "discard",
        p_vendor_id: vendorId,
      });
      btn.disabled = false;
      if (error) { fail("Couldn't save the review", error); return; }
      wrap.remove();
      say(accept ? "Quote accepted — it now counts alongside the others" : "Extraction discarded");
      await refreshDrawer(c.id);
    });
  }

  // ── In-Shop Tracker modals (Phase 6) ─────────────────────────────────
  const pad2 = (n) => String(n).padStart(2, "0");
  function dtLocalVal(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  const isoOrNull = (dtLocal) => (dtLocal ? new Date(dtLocal).toISOString() : null);

  async function openScheduleVisitModal(c) {
    injectCss();
    el("rr-rp-modal")?.remove();
    const shops = await loadShops();
    const wrap = document.createElement("div");
    wrap.id = "rr-rp-modal";
    const currentVendor = c.visit?.vendor_id || c.vendor?.id || "";
    const opts = shops.filter((s) => s.preferred_status !== "blocked")
      .map((s) => `<option value="${esc(s.id)}"${s.id === currentVendor ? " selected" : ""}>${esc(s.name)}</option>`).join("");
    const def = new Date(Date.now() + 24 * 3600e3);
    def.setHours(9, 0, 0, 0);
    const apptVal = dtLocalVal(c.visit?.appointment_at) || dtLocalVal(def.toISOString());
    wrap.innerHTML = `
      <div class="rp-modal-scrim" data-rp-mclose></div>
      <div class="rp-modal-card" role="dialog" aria-modal="true" aria-label="Schedule drop-off">
        <header class="rp-modal-head"><h3>${c.visit ? "Reschedule drop-off" : "Schedule drop-off"} — ${esc(c.case_number)}</h3><button type="button" class="rp-drawer-x" data-rp-mclose aria-label="Close">✕</button></header>
        <div class="rp-modal-body">
          <label class="rp-field"><span>Shop <em>*</em></span><select id="rr-rp-vs-shop" class="rp-input">${opts || `<option value="">No shops yet</option>`}</select></label>
          <label class="rp-field"><span>Drop-off appointment <em>*</em></span><input id="rr-rp-vs-when" class="rp-input" type="datetime-local" value="${apptVal}"></label>
          ${c.towing_required ? `
          <div class="rp-form-grid">
            <label class="rp-field"><span>Tow provider</span><input id="rr-rp-vs-tow" class="rp-input" maxlength="120" value="${esc(c.visit?.tow_provider || "")}"></label>
            <label class="rp-field"><span>Tow reference</span><input id="rr-rp-vs-towref" class="rp-input" maxlength="80" value="${esc(c.visit?.tow_reference || "")}"></label>
          </div>` : ""}
          <label class="rp-field"><span>Note (timeline)</span><input id="rr-rp-vs-note" class="rp-input" maxlength="200"></label>
        </div>
        <footer class="rp-modal-foot">
          <button type="button" class="rp-btn" data-rp-mclose>Cancel</button>
          <button type="button" class="rp-btn rp-btn-primary" data-rp-vs-save>${c.visit ? "Save" : "Schedule"}</button>
        </footer>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener("click", async (e) => {
      if (e.target.closest("[data-rp-mclose]")) { wrap.remove(); return; }
      if (!e.target.closest("[data-rp-vs-save]")) return;
      const shop = wrap.querySelector("#rr-rp-vs-shop").value;
      const when = wrap.querySelector("#rr-rp-vs-when").value;
      if (!shop) { say("Pick a shop", "warn"); return; }
      if (!when) { say("Pick the drop-off time", "warn"); return; }
      const btn = e.target.closest("[data-rp-vs-save]");
      btn.disabled = true;
      const { error } = await sb().rpc("repair_visit_schedule", {
        p_case_id: c.id,
        p_appointment_at: isoOrNull(when),
        p_vendor_id: shop,
        p_tow_provider: wrap.querySelector("#rr-rp-vs-tow")?.value.trim() || null,
        p_tow_reference: wrap.querySelector("#rr-rp-vs-towref")?.value.trim() || null,
        p_note: wrap.querySelector("#rr-rp-vs-note").value.trim() || null,
      });
      btn.disabled = false;
      if (error) { fail("Couldn't schedule the drop-off", error); return; }
      wrap.remove();
      say("Drop-off scheduled");
      await refreshDrawer(c.id);
    });
  }

  async function openCheckinModal(c) {
    injectCss();
    el("rr-rp-modal")?.remove();
    const needShop = !c.visit?.vendor_id && !c.vendor?.id;
    const shops = needShop || !c.visit ? await loadShops() : [];
    const wrap = document.createElement("div");
    wrap.id = "rr-rp-modal";
    const currentVendor = c.visit?.vendor_id || c.vendor?.id || "";
    const opts = shops.filter((s) => s.preferred_status !== "blocked")
      .map((s) => `<option value="${esc(s.id)}"${s.id === currentVendor ? " selected" : ""}>${esc(s.name)}</option>`).join("");
    wrap.innerHTML = `
      <div class="rp-modal-scrim" data-rp-mclose></div>
      <div class="rp-modal-card" role="dialog" aria-modal="true" aria-label="Check in at shop">
        <header class="rp-modal-head"><h3>Check in at shop — ${esc(c.case_number)}</h3><button type="button" class="rp-drawer-x" data-rp-mclose aria-label="Close">✕</button></header>
        <div class="rp-modal-body">
          ${opts ? `<label class="rp-field"><span>Shop <em>*</em></span><select id="rr-rp-ci-shop" class="rp-input">${opts}</select></label>`
                 : `<div class="rp-field"><span>Shop</span><div class="rp-fact-v">${esc(c.vendor?.name || "—")}</div></div>`}
          <label class="rp-field"><span>Dropped off</span><input id="rr-rp-ci-when" class="rp-input" type="datetime-local" value="${dtLocalVal(new Date().toISOString())}"></label>
          <label class="rp-field"><span>Note (timeline)</span><input id="rr-rp-ci-note" class="rp-input" maxlength="200" placeholder="e.g. Towed in by Bluegrass Towing, keys in drop box"></label>
          <div class="rp-callout rp-callout-info">Checking in marks the van at the shop and starts the shop clock. The promise date comes next — add it from “Update shop status” once the shop commits.</div>
        </div>
        <footer class="rp-modal-foot">
          <button type="button" class="rp-btn" data-rp-mclose>Cancel</button>
          <button type="button" class="rp-btn rp-btn-primary" data-rp-ci-save>Check in</button>
        </footer>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener("click", async (e) => {
      if (e.target.closest("[data-rp-mclose]")) { wrap.remove(); return; }
      if (!e.target.closest("[data-rp-ci-save]")) return;
      const shopSel = wrap.querySelector("#rr-rp-ci-shop");
      if (shopSel && !shopSel.value) { say("Pick a shop", "warn"); return; }
      const btn = e.target.closest("[data-rp-ci-save]");
      btn.disabled = true;
      const { error } = await sb().rpc("repair_visit_checkin", {
        p_case_id: c.id,
        p_dropped_off_at: isoOrNull(wrap.querySelector("#rr-rp-ci-when").value),
        p_vendor_id: shopSel?.value || null,
        p_note: wrap.querySelector("#rr-rp-ci-note").value.trim() || null,
      });
      btn.disabled = false;
      if (error) { fail("Couldn't check the van in", error); return; }
      wrap.remove();
      say("Checked in at the shop");
      await refreshDrawer(c.id);
    });
  }

  function openVisitUpdateModal(c) {
    injectCss();
    el("rr-rp-modal")?.remove();
    const v = c.visit || {};
    const wrap = document.createElement("div");
    wrap.id = "rr-rp-modal";
    const statusOpts = SHOP_STATUS_FLOW.map((s) =>
      `<option value="${esc(s)}"${s === v.shop_status ? " selected" : ""}>${esc(SHOP_STATUS_LABEL[s])}</option>`).join("");
    wrap.innerHTML = `
      <div class="rp-modal-scrim" data-rp-mclose></div>
      <div class="rp-modal-card rp-modal-wide" role="dialog" aria-modal="true" aria-label="Update shop status">
        <header class="rp-modal-head"><h3>Update shop status — ${esc(c.case_number)}</h3><button type="button" class="rp-drawer-x" data-rp-mclose aria-label="Close">✕</button></header>
        <div class="rp-modal-body">
          <div class="rp-form-grid">
            <label class="rp-field"><span>Status</span><select id="rr-rp-vu-status" class="rp-input">${statusOpts}</select></label>
            <label class="rp-field"><span>Work order #</span><input id="rr-rp-vu-wo" class="rp-input" maxlength="80" value="${esc(v.shop_work_order_number || "")}"></label>
            <label class="rp-field"><span>Service advisor</span><input id="rr-rp-vu-advisor" class="rp-input" maxlength="120" value="${esc(v.service_advisor || "")}"></label>
            <label class="rp-field"><span>Promised completion</span><input id="rr-rp-vu-promised" class="rp-input" type="datetime-local" value="${dtLocalVal(v.promised_completion_at)}"></label>
            <label class="rp-field"><span>Revised completion</span><input id="rr-rp-vu-revised" class="rp-input" type="datetime-local" value="${dtLocalVal(v.revised_completion_at)}"></label>
            <label class="rp-field"><span>Delay reason (shown on the queue)</span><input id="rr-rp-vu-delay" class="rp-input" maxlength="300" value="${esc(v.current_delay_reason || "")}" placeholder="e.g. Door cable assembly backordered"></label>
            <label class="rp-field rp-span2"><span>Note (timeline)</span><input id="rr-rp-vu-note" class="rp-input" maxlength="200" placeholder="e.g. Called shop — tech starts tomorrow morning"></label>
          </div>
        </div>
        <footer class="rp-modal-foot">
          <button type="button" class="rp-btn" data-rp-mclose>Cancel</button>
          <button type="button" class="rp-btn rp-btn-primary" data-rp-vu-save>Save update</button>
        </footer>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener("click", async (e) => {
      if (e.target.closest("[data-rp-mclose]")) { wrap.remove(); return; }
      if (!e.target.closest("[data-rp-vu-save]")) return;
      const btn = e.target.closest("[data-rp-vu-save]");
      btn.disabled = true;
      const { error } = await sb().rpc("repair_visit_update", {
        p_case_id: c.id,
        p_patch: {
          shop_status: wrap.querySelector("#rr-rp-vu-status").value,
          shop_work_order_number: wrap.querySelector("#rr-rp-vu-wo").value.trim() || null,
          service_advisor: wrap.querySelector("#rr-rp-vu-advisor").value.trim() || null,
          promised_completion_at: isoOrNull(wrap.querySelector("#rr-rp-vu-promised").value),
          revised_completion_at: isoOrNull(wrap.querySelector("#rr-rp-vu-revised").value),
          current_delay_reason: wrap.querySelector("#rr-rp-vu-delay").value.trim() || null,
        },
        p_note: wrap.querySelector("#rr-rp-vu-note").value.trim() || null,
      });
      btn.disabled = false;
      if (error) { fail("Couldn't save the shop update", error); return; }
      wrap.remove();
      say("Shop status updated");
      await refreshDrawer(c.id);
    });
  }

  async function doVisitPickup(c) {
    const ok = typeof window._rrConfirmDialog === "function"
      ? await window._rrConfirmDialog({
          title: "Mark picked up?",
          body: "The van leaves the shop and moves to quality check. Run the QC, then return it to service from this drawer.",
          confirmLabel: "Picked up" })
      : window.confirm("Mark the van picked up from the shop?");
    if (!ok) return;
    const { error } = await sb().rpc("repair_visit_pickup", { p_case_id: c.id, p_note: null });
    if (error) { fail("Couldn't record the pickup", error); return; }
    say("Picked up — quality check next");
    await refreshDrawer(c.id);
  }

  function drawerEsc(e) { if (e.key === "Escape") closeDrawer(); }
  function closeDrawer() {
    document.removeEventListener("keydown", drawerEsc);
    el("rr-rp-drawer")?.remove();
    S.drawerCase = null;
    S.drawerQuotes = null;
    S.drawerInvoices = null;
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
    const odo = parseOdometer(raw);
    if (!odo.ok) {
      say(odo.reason === "too_large"
        ? `Odometer looks wrong — readings above ${ODOMETER_MAX.toLocaleString("en-US")} miles aren't accepted`
        : "Odometer must be a number", "warn");
      return;
    }
    const { error } = await sb().rpc("repair_case_return_to_service", {
      p_id: c.id, p_odometer: odo.value, p_note: null, p_close: true,
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
  // ── Use a part — consume on-hand stock against this case ────────────
  // parts_stock_move (0540) links the movement to the case + its van, so
  // the pull lands in the van's cost history AND the shelf count drops.
  // Pre-0540 (RPC missing) this degrades to a setup pointer.
  async function openUsePartModal(c) {
    injectCss();
    // Station lens (Codex review): a scoped dispatcher sees that
    // station's shelf + shared items — the RPC's contract — so a
    // same-named item at another station can't be decremented by
    // mistake. All-stations mode shows everything, with the station
    // code on each option so items stay distinguishable.
    const _stnId = (typeof window.rrStationScopeId === "function") ? window.rrStationScopeId() : null;
    const { data, error } = await sb().rpc("parts_stock_list", _stnId ? { p_station_id: _stnId } : {});
    if (error) {
      if (error.code === "PGRST202" || /could not find the function/i.test(error.message || "")) {
        say("Parts inventory needs migration 0540 — apply it, then stock the shelf in Fleet → Parts", "warn");
      } else {
        fail("Couldn't load the parts inventory", error);
      }
      return;
    }
    const items = (data && Array.isArray(data.items)) ? data.items.filter((i) => i.active !== false) : [];
    if (!items.length) {
      say("No stock items yet — add them in Fleet → Parts → On-hand inventory", "warn");
      return;
    }
    el("rr-rp-modal")?.remove();
    const wrap = document.createElement("div");
    wrap.id = "rr-rp-modal";
    const opts = items.map((i) => {
      const bits = [i.part_number, i.station_code || "", i.bin_location ? `bin ${i.bin_location}` : "", `${i.qty_on_hand} on hand`].filter(Boolean).join(" · ");
      return `<option value="${esc(i.id)}"${i.qty_on_hand <= 0 ? " disabled" : ""}>${esc(i.name)}${bits ? ` — ${esc(bits)}` : ""}</option>`;
    }).join("");
    wrap.innerHTML = `
      <div class="rp-modal-scrim" data-rp-mclose></div>
      <div class="rp-modal-card" role="dialog" aria-modal="true" aria-label="Use a part">
        <header class="rp-modal-head"><h3>Use a part · ${esc(c.case_number || "")}</h3><button type="button" class="rp-drawer-x" data-rp-mclose aria-label="Close">✕</button></header>
        <div class="rp-modal-body">
          <label class="rp-field"><span>Part</span>
            <select id="rr-rp-part-item" class="rp-input">${opts}</select>
          </label>
          <label class="rp-field"><span>Quantity</span>
            <input id="rr-rp-part-qty" class="rp-input" type="number" min="1" step="1" value="1">
          </label>
          <label class="rp-field"><span>Note</span>
            <input id="rr-rp-part-note" class="rp-input" type="text" maxlength="200" placeholder="optional — e.g. replaced under diag">
          </label>
        </div>
        <footer class="rp-modal-foot">
          <button type="button" class="rp-btn" data-rp-mclose>Cancel</button>
          <button type="button" class="rp-btn rp-btn-primary" data-rp-part-save>Record usage</button>
        </footer>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener("click", async (e) => {
      if (e.target.closest("[data-rp-mclose]")) { wrap.remove(); return; }
      if (!e.target.closest("[data-rp-part-save]")) return;
      const itemId = el("rr-rp-part-item").value;
      const qty = parseInt(el("rr-rp-part-qty").value || "", 10);
      if (!itemId || !Number.isFinite(qty) || qty <= 0) { say("Pick a part and a quantity", "warn"); return; }
      const item = items.find((i) => i.id === itemId);
      const { error: mvErr } = await sb().rpc("parts_stock_move", {
        p_item_id: itemId,
        p_kind: "consume",
        p_qty: qty,
        p_unit_cost_cents: null,
        p_vehicle_id: c.vehicle?.id || null,
        p_repair_case_id: c.id,
        p_note: (el("rr-rp-part-note").value || "").trim() || null,
      });
      if (mvErr) {
        if (/insufficient_stock/.test(mvErr.message || "")) { say("Not enough on hand for that quantity", "warn"); return; }
        fail("Couldn't record the part usage", mvErr);
        return;
      }
      // Surface it on the case timeline so the pull is part of the story.
      await sb().rpc("repair_case_log_event", {
        p_case_id: c.id, p_kind: "note",
        p_message: `Used ${qty}× ${item ? item.name : "part"} from stock${item?.part_number ? ` (${item.part_number})` : ""}`,
        p_source: "dsp", p_visible_to_shop: false,
      }).catch(() => {});
      wrap.remove();
      say("Part usage recorded");
      openCase(c.id);
    });
  }

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
      const odoField = wrap.querySelector("#rr-rp-nc-odo");
      const odo = parseOdometer(odoField.value);
      if (!odo.ok) {
        say(odo.reason === "too_large"
          ? `Odometer looks wrong — readings above ${ODOMETER_MAX.toLocaleString("en-US")} miles aren't accepted`
          : "Odometer must be a number", "warn");
        odoField.focus();
        return;
      }
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
        p_odometer: odo.value,
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
      const shopEdit = e.target.closest("[data-rp-shop-edit]");
      if (shopEdit) { newShop(shopEdit.getAttribute("data-rp-shop-edit")); return; }
      const shopRow = e.target.closest(".rp-shoprow[data-rp-shop]");
      if (shopRow) { newShop(shopRow.getAttribute("data-rp-shop")); return; }
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
    const repPeriod = el("rr-repair-rep-period");
    if (repPeriod) repPeriod.addEventListener("change", () => loadReport());
    const repLedger = el("rr-repair-rep-ledger");
    if (repLedger) repLedger.addEventListener("click", () => {
      // goto loads the workbooks module lazily; the deep-link hook opens
      // (or provisions) the singleton Repair Spend ledger once it's up.
      if (typeof window.goto === "function") window.goto("workbooks");
      let tries = 0;
      const kick = () => {
        if (typeof window.rrOpenRepairSpendLedger === "function") { window.rrOpenRepairSpendLedger(); return; }
        if (++tries < 40) setTimeout(kick, 250);
      };
      kick();
    });
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
#rr-rp-drawer .rp-att-extract{margin-top:var(--s-1)}
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
/* author display rules would otherwise defeat the hidden attribute */
#rr-rp-modal [hidden],#rr-rp-drawer [hidden]{display:none}
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
.rp-btn-sm{padding:var(--s-1) var(--s-2);font-size:var(--fs-xs)}
.rp-checkline{display:inline-flex;align-items:center;gap:6px;font-size:var(--fs-sm);font-weight:500;color:var(--text);cursor:pointer}
.rp-dim{opacity:.55}
.rp-shoplist{display:flex;flex-direction:column;gap:var(--s-1);max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:var(--r-md);padding:var(--s-1)}
.rp-shoppick{display:flex;align-items:center;gap:var(--s-2-5);padding:var(--s-2) var(--s-2-5);border-radius:var(--r-sm);cursor:pointer}
.rp-shoppick:hover{background:var(--surface-hover)}
.rp-shoppick-main{flex:1;min-width:0}
.rp-shoppick-main .rp-strong,.rp-shoppick-main .rp-cell-sub{display:block}
.rp-qsec{display:flex;flex-direction:column;gap:2px;margin-bottom:var(--s-3)}
.rp-qhead{font-size:var(--fs-xs);font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--text-subtle);margin:var(--s-2) 0 var(--s-1)}
.rp-qrow{display:flex;align-items:center;gap:var(--s-2);padding:var(--s-2) 0;border-bottom:1px solid var(--border-subtle)}
.rp-qrow:last-child{border-bottom:none}
.rp-qrow-main{flex:1;min-width:0}
.rp-qrow-main .rp-strong,.rp-qrow-main .rp-cell-sub{display:block}
.rp-qamt{font-variant-numeric:tabular-nums;white-space:nowrap}
.rp-qitems{border:1px solid var(--border-subtle);border-radius:var(--r-md);padding:var(--s-2) var(--s-3);margin:0 0 var(--s-2);background:var(--canvas)}
.rp-qhead-row{display:flex;align-items:center;justify-content:space-between;gap:var(--s-2)}
.rp-visit{margin-bottom:var(--s-3)}
.rp-visit-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:var(--s-2) var(--s-4);margin-bottom:var(--s-2)}
.rp-visit-actions{display:flex;gap:var(--s-2);flex-wrap:wrap}
.rp-auth-card{border:1px solid var(--border);border-radius:var(--r-md);padding:var(--s-2-5) var(--s-3);margin-bottom:var(--s-2);background:var(--canvas)}
.rp-auth-card .rp-qitems{margin:var(--s-2) 0 0;background:var(--surface)}
.rp-auth-actions{display:flex;gap:var(--s-2);flex-wrap:wrap;margin-top:var(--s-2)}
.rp-auth-hist{padding:var(--s-1) 0}
.rp-money-over{color:var(--red)}
.rp-qli-declined{opacity:.6}
.rp-qli-declined .rp-qli-desc{text-decoration:line-through}
#rr-rp-modal .rp-modal-xwide{max-width:960px}
.rp-cmp-scroll{overflow-x:auto}
.rp-cmp{border-collapse:collapse;width:100%}
.rp-cmp th,.rp-cmp td{padding:var(--s-2) var(--s-2-5);border-bottom:1px solid var(--border-subtle);text-align:left;vertical-align:top;font-size:var(--fs-sm)}
.rp-cmp thead th{border-bottom:1px solid var(--border)}
.rp-cmp .rp-cmp-col{min-width:150px}
.rp-cmp .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.rp-cmp-total{font-size:var(--fs-lg);font-weight:700;color:var(--text);font-variant-numeric:tabular-nums;margin-top:2px}
.rp-cmp-delta{font-size:var(--fs-xs);color:var(--text-muted);font-variant-numeric:tabular-nums}
.rp-cmp-pills{display:flex;gap:var(--s-1);flex-wrap:wrap;margin-top:var(--s-1)}
.rp-cmp-missing{color:var(--text-subtle)}
.rp-cmp-desc{display:block;font-weight:600;color:var(--text)}
.rp-cmp td .rp-cell-sub,.rp-cmp th .rp-cell-sub{display:block}
.rp-cmp-totalrow td{border-top:1px solid var(--border);border-bottom:none}
.rp-authtype{display:flex;gap:var(--s-2);flex-wrap:wrap}
.rp-authtype-opt{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:var(--r-md);padding:var(--s-2) var(--s-3);font-size:var(--fs-sm);font-weight:600;color:var(--text);cursor:pointer;background:var(--surface)}
.rp-authtype-opt:has(input:checked){border-color:var(--accent);box-shadow:var(--ring-focus);background:var(--surface-hover)}
.rp-authtype-opt input{margin:0}
.rp-authlines{border:1px solid var(--border);border-radius:var(--r-md);max-height:240px;overflow:auto;padding:var(--s-1)}
.rp-authline{display:flex;align-items:center;gap:var(--s-2-5);padding:var(--s-1-5,6px) var(--s-2);border-radius:var(--r-sm);cursor:pointer;font-size:var(--fs-sm)}
.rp-authline:hover{background:var(--surface-hover)}
.rp-authline-desc{flex:1;min-width:0}
.rp-authline:has(input:not(:checked)) .rp-authline-desc{opacity:.55;text-decoration:line-through}
.rp-authsum{margin-top:var(--s-2);font-size:var(--fs-sm);color:var(--text)}
.rp-qli{display:flex;justify-content:space-between;gap:var(--s-3);padding:3px 0;font-size:var(--fs-sm)}
.rp-qli-amt{font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:600}
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
    newShop,
    // Fleet-side hook: create a case pre-targeted at a vehicle.
    createForVehicle: (vehicleId) => newCase(vehicleId),
  };
})();
