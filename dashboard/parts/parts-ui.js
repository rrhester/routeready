// ─── parts-ui.js · Parts Intelligence — Fleet sub-tab UI ───────────────────
//
// Owns the whole "Parts" tab inside the Fleet page (#fl-sub-parts). Rendered
// on demand by live.js's fleetSub('parts') → window.RRParts.mount(). Uses the
// shared window.sb (no second Supabase client) and the pure parts-engine for
// all fitment / landed-cost / ranking math.
//
// MVP surface (matches the mockups + the plan's MVP scope):
//   · search header with vehicle context + query/part-number + filters
//   · results summary strip + offer comparison table (ranked, fitment-scored)
//   · manual supplier-quote entry (the MVP's working supplier connector)
//   · NHTSA VIN decode (best-effort, via the vin-decode edge function)
//   · part detail drawer: fitment reasons, pricing breakdown, price history
//   · save-to-watchlist, record-purchase, export-to-Workbook / CSV
//   · supplier & crawl-source health mini-admin
//
// All supplier/seller text is treated as untrusted — everything is escaped.
import {
  computeLandedCost, evaluateFitment, rankOffers, detectOfferFlags,
  normalizePartTerms, FITMENT_LABEL, FITMENT_CLASS, formatCents, formatDelivery,
} from "./parts-engine.js";
import { makeNhtsaProvider } from "./adapters/nhtsa.js";

(() => {
  "use strict";
  if (window.RRParts) return;

  const S = {
    hostId: null,
    booted: false,
    loading: false,
    vehicles: [],
    sources: [],
    vehicleId: null,
    query: "",
    partNumber: "",
    filters: { condition: "any", oem: "any", maxLanded: null },
    search: null,          // current part_searches row
    offers: [],            // ranked offers for the current search
    weights: null,
    stock: null,           // parts_stock_list payload (0540) · null = not loaded · {missing:true} = pre-migration
    stockLoading: false,
  };

  const sb = () => window.sb;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const el = (id) => document.getElementById(id);
  const host = () => el(S.hostId);
  const veh = () => S.vehicles.find((v) => v.id === S.vehicleId) || null;
  const cents = (v) => (v === "" || v == null || isNaN(+v) ? null : Math.round(parseFloat(v) * 100));

  // ── Styles (scoped, token-based) ──────────────────────────────────────
  function injectStyles() {
    if (el("rr-parts-style")) return;
    const s = document.createElement("style");
    s.id = "rr-parts-style";
    s.textContent = `
    #fl-sub-parts .rrp-wrap{display:flex;flex-direction:column;gap:14px}
    #fl-sub-parts .rrp-veh{display:flex;align-items:center;gap:12px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:11px 14px}
    #fl-sub-parts .rrp-veh select{margin-left:auto;background:var(--canvas);border:1px solid var(--border);border-radius:var(--r-md);padding:6px 10px;font:inherit;font-size:var(--fs-md);color:var(--text)}
    #fl-sub-parts .rrp-veh .nm{font-weight:700;font-size:var(--fs-lg)}
    #fl-sub-parts .rrp-veh .ln{color:var(--text-subtle);font-size:var(--fs-sm);margin-top:2px}
    #fl-sub-parts .rrp-attrs{display:flex;gap:6px;flex-wrap:wrap}
    #fl-sub-parts .rrp-attr{font-size:var(--fs-xs);font-weight:600;color:var(--text-muted);background:var(--surface-2,#F3F4F6);border:1px solid var(--border);border-radius:var(--r-md);padding:3px 8px}
    #fl-sub-parts .rrp-search{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:14px}
    #fl-sub-parts .rrp-srow{display:flex;gap:10px;flex-wrap:wrap}
    #fl-sub-parts .rrp-field{flex:1;min-width:220px;display:flex;flex-direction:column;gap:4px}
    #fl-sub-parts .rrp-field label{font-size:var(--fs-xs);font-weight:600;color:var(--text-subtle);text-transform:uppercase;letter-spacing:.04em}
    #fl-sub-parts .rrp-field input,#fl-sub-parts .rrp-field select{border:1px solid var(--border);border-radius:var(--r-md);background:var(--surface);padding:8px 10px;font:inherit;font-size:var(--fs-md);color:var(--text)}
    #fl-sub-parts .rrp-filters{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid var(--border-subtle)}
    #fl-sub-parts .rrp-filters .rrp-field{min-width:150px;flex:0 1 auto}
    #fl-sub-parts .rrp-kpis{display:flex;gap:10px;flex-wrap:wrap}
    #fl-sub-parts .rrp-kpi{flex:1;min-width:120px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:9px 12px}
    #fl-sub-parts .rrp-kpi .lab{font-size:var(--fs-xs);font-weight:600;color:var(--text-subtle);text-transform:uppercase;letter-spacing:.04em}
    #fl-sub-parts .rrp-kpi .val{font-size:var(--fs-xl);font-weight:700;letter-spacing:-.02em;margin-top:2px}
    #fl-sub-parts .rrp-tbl-scroll{overflow-x:auto}
    #fl-sub-parts table.rrp-tbl{border-collapse:collapse;width:100%;min-width:1080px;font-size:var(--fs-md)}
    #fl-sub-parts .rrp-tbl thead th{position:sticky;top:0;background:var(--surface-2,#F3F4F6);text-align:left;font-size:var(--fs-xs);font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:var(--text-subtle);padding:9px 11px;border-bottom:1px solid var(--border);white-space:nowrap}
    #fl-sub-parts .rrp-tbl thead th.r{text-align:right}
    #fl-sub-parts .rrp-tbl tbody td{padding:10px 11px;border-bottom:1px solid var(--border-subtle);vertical-align:middle}
    #fl-sub-parts .rrp-tbl tbody tr{cursor:pointer}
    #fl-sub-parts .rrp-tbl tbody tr:hover{background:var(--surface-hover,#F9FAFB)}
    #fl-sub-parts .rrp-tbl td.r{text-align:right;font-variant-numeric:tabular-nums}
    #fl-sub-parts .rrp-partnm{font-weight:600}
    #fl-sub-parts .rrp-sub{font-size:var(--fs-xs);color:var(--text-subtle);margin-top:1px}
    #fl-sub-parts .rrp-fit{display:inline-flex;align-items:center;gap:6px;font-size:var(--fs-xs);font-weight:700;padding:3px 9px;border-radius:var(--r-pill);white-space:nowrap}
    #fl-sub-parts .rrp-fit .d{width:7px;height:7px;border-radius:50%}
    #fl-sub-parts .rrp-fit.exact{background:var(--green-soft,#ECFDF3);color:var(--green-text,#15803D)} #fl-sub-parts .rrp-fit.exact .d{background:var(--green,#16A34A)}
    #fl-sub-parts .rrp-fit.high{background:var(--accent-soft,#EFF4FF);color:var(--accent-text,#1E40AF)} #fl-sub-parts .rrp-fit.high .d{background:var(--accent,#2563EB)}
    #fl-sub-parts .rrp-fit.likely{background:var(--surface-2,#F3F4F6);color:var(--text-muted)} #fl-sub-parts .rrp-fit.likely .d{background:var(--text-subtle)}
    #fl-sub-parts .rrp-fit.verify{background:var(--amber-soft,#FFF7ED);color:var(--amber-text,#B45309)} #fl-sub-parts .rrp-fit.verify .d{background:var(--amber,#D97706)}
    #fl-sub-parts .rrp-fit.incompatible{background:var(--red-soft,#FEF2F2);color:var(--red-text,#B91C1C)} #fl-sub-parts .rrp-fit.incompatible .d{background:var(--red,#DC2626)}
    #fl-sub-parts .rrp-rec{font-size:var(--fs-xs);font-weight:700;padding:2px 7px;border-radius:var(--r-md);display:inline-block;white-space:nowrap}
    #fl-sub-parts .rrp-rec.best{background:var(--accent,#2563EB);color:#fff}
    #fl-sub-parts .rrp-rec.cheap{background:var(--green-soft,#ECFDF3);color:var(--green-text,#15803D)}
    #fl-sub-parts .rrp-rec.fast{background:var(--accent-soft,#EFF4FF);color:var(--accent-text,#1E40AF)}
    #fl-sub-parts .rrp-rec.oem,#fl-sub-parts .rrp-rec.aftermarket,#fl-sub-parts .rrp-rec.lowrisk{background:var(--surface-2,#F3F4F6);color:var(--text-muted);border:1px solid var(--border)}
    #fl-sub-parts .rrp-tagoem{font-size:var(--fs-xs);font-weight:700;padding:2px 6px;border-radius:var(--r-sm,4px);background:var(--slate-900,#0F172A);color:#fff}
    #fl-sub-parts .rrp-tagam{font-size:var(--fs-xs);font-weight:700;padding:2px 6px;border-radius:var(--r-sm,4px);background:var(--surface-2,#F3F4F6);color:var(--text-muted);border:1px solid var(--border)}
    #fl-sub-parts .rrp-empty{padding:34px 20px;text-align:center;color:var(--text-subtle);border:1px dashed var(--border-strong,#D1D5DB);border-radius:var(--r-lg);background:var(--surface)}
    #fl-sub-parts .rrp-empty h3{margin:0 0 5px;font-size:var(--fs-lg);color:var(--text)}
    #fl-sub-parts .rrp-shop{display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:11px 14px;margin:2px 0 2px}
    #fl-sub-parts .rrp-shop-lbl{font-weight:700;font-size:var(--fs-md);margin-right:2px}
    #fl-sub-parts .rrp-shop-link{text-decoration:none}
    #fl-sub-parts .rrp-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:2px}
    #fl-sub-parts .rrp-warn{display:flex;gap:9px;align-items:flex-start;background:var(--red-soft,#FEF2F2);border:1px solid var(--red-border,#FECACA);border-radius:var(--r-md);padding:9px 12px;font-size:var(--fs-sm);color:var(--red-text,#B91C1C)}
    /* modal + drawer share the app overlay tokens */
    .rrp-overlay{position:fixed;inset:0;background:var(--overlay,rgba(16,24,40,.4));z-index:9998;display:flex}
    .rrp-modal{background:var(--surface);border-radius:var(--r-lg);max-width:640px;width:100%;margin:auto;max-height:88vh;overflow-y:auto;box-shadow:var(--shadow-lg,0 10px 40px rgba(0,0,0,.2))}
    .rrp-drawer-o{justify-content:flex-end}
    .rrp-drawer{background:var(--surface);width:460px;max-width:100%;height:100%;overflow-y:auto;border-left:1px solid var(--border);display:flex;flex-direction:column}
    .rrp-mh{padding:15px 18px;border-bottom:1px solid var(--border-subtle);display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
    .rrp-mh h3{margin:0;font-size:var(--fs-lg);font-weight:700}
    .rrp-mh .x{background:none;border:0;font-size:22px;line-height:1;color:var(--text-muted);cursor:pointer;padding:0 4px}
    .rrp-mb{padding:16px 18px}
    .rrp-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .rrp-fg{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
    .rrp-fg label{font-size:var(--fs-xs);font-weight:600;color:var(--text-subtle);text-transform:uppercase;letter-spacing:.04em}
    .rrp-fg input,.rrp-fg select,.rrp-fg textarea{border:1px solid var(--border);border-radius:var(--r-md);background:var(--canvas);padding:8px 10px;font:inherit;font-size:var(--fs-md);color:var(--text)}
    .rrp-mf{padding:13px 18px;border-top:1px solid var(--border-subtle);display:flex;justify-content:flex-end;gap:8px;position:sticky;bottom:0;background:var(--surface)}
    .rrp-sec{margin-bottom:16px}
    .rrp-sec-h{font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-subtle);margin-bottom:8px}
    .rrp-ev{display:flex;gap:8px;padding:7px 0;border-top:1px solid var(--border-subtle);font-size:var(--fs-sm)}
    .rrp-ev:first-child{border-top:0}
    .rrp-ev .i{width:16px;height:16px;flex:0 0 auto;margin-top:1px}
    .rrp-ev.pos .i{color:var(--green,#16A34A)} .rrp-ev.neg .i{color:var(--red,#DC2626)} .rrp-ev.warn .i{color:var(--amber,#D97706)}
    .rrp-pb{background:var(--surface-2,#F3F4F6);border-radius:var(--r-md);padding:12px 14px}
    .rrp-pb .r{display:flex;justify-content:space-between;padding:3px 0;font-size:var(--fs-md);font-variant-numeric:tabular-nums}
    .rrp-pb .r.tot{border-top:1px solid var(--border);margin-top:5px;padding-top:7px;font-weight:700}
    .rrp-spark{width:100%;height:56px}
    .rrp-src{display:grid;grid-template-columns:1.4fr .8fr 1fr 1fr auto;gap:10px;align-items:center;padding:10px 0;border-top:1px solid var(--border-subtle);font-size:var(--fs-md)}
    .rrp-src.h{border-top:0;font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:var(--text-subtle)}
    .rrp-dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:5px}
    /* On-hand inventory (0540) */
    #fl-sub-parts .rrp-stk{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:14px}
    #fl-sub-parts .rrp-stk-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px}
    #fl-sub-parts .rrp-stk-title{font-weight:700;font-size:var(--fs-lg)}
    #fl-sub-parts .rrp-stk-sub{color:var(--text-subtle);font-size:var(--fs-sm);margin-top:2px;max-width:560px}
    #fl-sub-parts .rrp-stk-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    #fl-sub-parts .rrp-stk-sum{font-size:var(--fs-sm);color:var(--text-muted)}
    #fl-sub-parts .rrp-stk-sum .rrp-stk-low-b{color:var(--amber-dark,#B45309)}
    #fl-sub-parts .rrp-stk-empty{padding:18px;text-align:center;color:var(--text-subtle);font-size:var(--fs-sm);border:1px dashed var(--border);border-radius:var(--r-md)}
    #fl-sub-parts .rrp-stk-table{width:100%;border-collapse:collapse;font-size:var(--fs-md)}
    #fl-sub-parts .rrp-stk-table th{font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-subtle);text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)}
    #fl-sub-parts .rrp-stk-table td{padding:8px;border-bottom:1px solid var(--border-subtle);vertical-align:top}
    #fl-sub-parts .rrp-stk-name{background:none;border:0;padding:0;font:inherit;font-weight:600;color:var(--text);cursor:pointer;text-align:left}
    #fl-sub-parts .rrp-stk-name:hover{color:var(--accent-text,#1E40AF);text-decoration:underline}
    #fl-sub-parts .rrp-stk-meta{font-size:var(--fs-xs);color:var(--text-subtle);margin-top:2px}
    #fl-sub-parts .rrp-stk-qty{font-variant-numeric:tabular-nums;font-weight:600}
    #fl-sub-parts .rrp-stk-low{font-size:10px;font-weight:800;letter-spacing:.05em;color:var(--amber-dark,#B45309);background:var(--amber-soft,#FEF3C7);border-radius:var(--r-pill,999px);padding:1px 6px;margin-left:4px}
    #fl-sub-parts .rrp-stk-lowrow td{background:var(--amber-soft,#FFFBEB)}
    #fl-sub-parts .rrp-stk-inactive td{opacity:.55}
    #fl-sub-parts .rrp-stk-act{white-space:nowrap;text-align:right}
    #fl-sub-parts .rrp-stk-act .btn{padding:3px 8px;font-size:var(--fs-xs)}
    `;
    document.head.appendChild(s);
  }

  const svg = (p, w) => `<svg viewBox="0 0 24 24" width="${w || 15}" height="${w || 15}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  const ICON = {
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    warn: '<path d="M10.3 3.6 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    bookmark: '<path d="M5 3h14v18l-7-4-7 4Z"/>',
    sheet: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
    cart: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/>',
  };

  // ── Boot: load vehicles + sources ─────────────────────────────────────
  async function boot() {
    if (S.booted) return;
    S.loading = true;
    try {
      const [vr, sr] = await Promise.all([
        sb().rpc("vehicles_roster"),
        sb().rpc("parts_supplier_sources_list"),
      ]);
      S.vehicles = Array.isArray(vr.data) ? vr.data : [];
      let sources = Array.isArray(sr.data) ? sr.data : [];
      if (!sources.length) {
        const seed = await sb().rpc("parts_seed_default_sources");
        sources = Array.isArray(seed.data) ? seed.data : [];
      }
      S.sources = sources;
      S.booted = true;
    } catch (e) {
      console.warn("parts boot failed", e);
    } finally {
      S.loading = false;
    }
  }

  // ── Public API ────────────────────────────────────────────────────────
  async function mount(hostId) {
    S.hostId = hostId || "fl-sub-parts";
    injectStyles();
    const h = host();
    if (!h) return;
    if (!S.booted) {
      h.innerHTML = `<div class="rrp-empty"><h3>Loading Parts Intelligence…</h3></div>`;
      await boot();
    } else {
      // Re-pull the roster on every mount so a VIN just added on the Vehicles
      // tab shows up here (the picker + Decode VIN read from this list).
      await refreshVehicles();
    }
    render();
  }

  async function refreshVehicles() {
    try {
      const { data } = await sb().rpc("vehicles_roster");
      if (Array.isArray(data)) S.vehicles = data;
    } catch (e) { /* keep cached list */ }
  }

  async function searchForVehicle(vehicleId) {
    S.vehicleId = vehicleId;
    S.hostId = S.hostId || "fl-sub-parts";
    injectStyles();
    if (!S.booted) await boot();
    // If the vehicle isn't in the roster cache, refetch once.
    if (vehicleId && !veh()) { S.booted = false; await boot(); }
    S.search = null; S.offers = [];
    render();
    const qi = el("rrp-q"); if (qi) qi.focus();
  }

  // ── Render the page ───────────────────────────────────────────────────
  function render() {
    const h = host();
    if (!h) return;
    const v = veh();
    const vehLine = v
      ? [v.year, v.make, v.model, v.trim_level].filter(Boolean).join(" ")
      : "";
    const vehSub = v
      ? [v.vin ? "VIN " + esc(v.vin) : "No VIN on record", v.station_code ? "Station " + esc(v.station_code) : null, v.mileage ? (Number(v.mileage).toLocaleString() + " mi") : null].filter(Boolean).join(" · ")
      : "Pick a vehicle to scope fitment, or search unscoped.";
    const dec = v && v._decoded;
    const decLine = dec
      ? [dec.year, dec.make, dec.model, dec.body_class, dec.drive_type, dec.engine, dec.wheelbase ? dec.wheelbase + '" WB' : null].filter(Boolean).join(" · ")
      : "";

    h.innerHTML = `
    <div class="rrp-wrap">
      <div class="rrp-veh">
        <div style="min-width:0">
          <div class="nm">${v ? esc(v.name || "Van") + (vehLine ? " · " + esc(vehLine) : "") : "Any vehicle"}</div>
          <div class="ln">${vehSub}</div>
          ${decLine ? `<div class="ln" style="color:var(--accent-text,#1E40AF);margin-top:3px;font-weight:600">Decoded (NHTSA): ${esc(decLine)}</div>` : ""}
        </div>
        <select id="rrp-vehsel" aria-label="Vehicle">
          <option value="">Any vehicle (unscoped)</option>
          ${S.vehicles.map((x) => `<option value="${esc(x.id)}" ${x.id === S.vehicleId ? "selected" : ""}>${esc(x.name || "Van")}${x.vin ? " · " + esc(x.vin) : ""}</option>`).join("")}
        </select>
      </div>

      <div class="rrp-search">
        <div class="rrp-srow">
          <div class="rrp-field" style="flex:2">
            <label>Describe the part</label>
            <input id="rrp-q" type="search" placeholder="e.g. passenger side power heated mirror" value="${esc(S.query)}" autocomplete="off">
          </div>
          <div class="rrp-field">
            <label>OEM / aftermarket part #</label>
            <input id="rrp-pn" type="text" placeholder="e.g. LK4Z-17683-AA" value="${esc(S.partNumber)}" autocomplete="off">
          </div>
        </div>
        <div class="rrp-filters">
          <div class="rrp-field"><label>Condition</label>
            <select id="rrp-fcond">
              <option value="any">Any</option><option value="new">New</option>
              <option value="new_or_reman">New + reman</option><option value="used_ok">Include used</option>
            </select></div>
          <div class="rrp-field"><label>OEM preference</label>
            <select id="rrp-foem">
              <option value="any">Any</option><option value="prefer_oem">Prefer OEM</option>
              <option value="oem_only">OEM only</option><option value="prefer_aftermarket">Prefer aftermarket</option>
            </select></div>
          <div class="rrp-field"><label>Max landed ($)</label>
            <input id="rrp-fmax" type="number" min="0" step="1" placeholder="—" style="width:110px"></div>
          <div style="flex:1"></div>
          <button class="btn btn-sm" id="rrp-decode" title="Decode a VIN via the free NHTSA database">${svg('<path d="M3 12h18M3 6h18M3 18h18"/>',13)} Decode VIN</button>
          <button class="btn btn-primary" id="rrp-run">${svg(ICON.search)} Search parts</button>
        </div>
      </div>

      <div id="rrp-results"></div>

      <div id="rrp-stock"></div>
    </div>`;

    // Restore filter selections
    if (el("rrp-fcond")) el("rrp-fcond").value = S.filters.condition;
    if (el("rrp-foem")) el("rrp-foem").value = S.filters.oem;
    if (el("rrp-fmax") && S.filters.maxLanded != null) el("rrp-fmax").value = S.filters.maxLanded / 100;

    wireHeader();
    renderResults();
    renderStock();
    if (S.stock === null) loadStock();
  }

  function wireHeader() {
    const vehsel = el("rrp-vehsel");
    if (vehsel) vehsel.onchange = () => { S.vehicleId = vehsel.value || null; S.search = null; S.offers = []; render(); };
    const run = el("rrp-run");
    if (run) run.onclick = runSearch;
    const dec = el("rrp-decode");
    if (dec) dec.onclick = decodeVin;
    ["rrp-q", "rrp-pn"].forEach((id) => {
      const inp = el(id);
      if (inp) inp.onkeydown = (e) => { if (e.key === "Enter") runSearch(); };
    });
  }

  function readFilters() {
    S.query = (el("rrp-q") && el("rrp-q").value.trim()) || "";
    S.partNumber = (el("rrp-pn") && el("rrp-pn").value.trim()) || "";
    S.filters.condition = (el("rrp-fcond") && el("rrp-fcond").value) || "any";
    S.filters.oem = (el("rrp-foem") && el("rrp-foem").value) || "any";
    S.filters.maxLanded = cents(el("rrp-fmax") && el("rrp-fmax").value);
  }

  // ── Run a search ──────────────────────────────────────────────────────
  async function runSearch() {
    readFilters();
    if (!S.query && !S.partNumber) { toast("Enter a part description or part number."); return; }
    const btn = el("rrp-run"); if (btn) { btn.disabled = true; btn.textContent = "Searching…"; }
    try {
      const v = veh();
      const { data, error } = await sb().rpc("parts_search_start", {
        p_vehicle_id: S.vehicleId, p_query: S.query || null, p_part_number: S.partNumber || null,
        p_vin: (v && v.vin) || null,
        p_requested_sources: JSON.stringify(S.sources.filter((s) => s.active).map((s) => s.id)),
        p_filters: JSON.stringify(S.filters),
      });
      if (error) throw error;
      S.search = data;
      // Run enabled live suppliers (server-side proxy), plus manual entries
      // already saved. A supplier failure never fails the whole search.
      const perSource = await runLiveSuppliers();
      await sb().rpc("parts_search_finish", {
        p_search_id: S.search.id,
        p_status: perSource && perSource._anyError ? "partial" : "complete",
        p_per_source: JSON.stringify(perSource || {}),
      });
      await reloadResults();
      if (perSource && perSource._noApi) {
        toast("No live API source is enabled — add a supplier quote, or enable eBay under Sources & health.");
      } else if (perSource && perSource.ebay && perSource.ebay.status === "no_credentials") {
        toast("eBay is enabled but its API keys aren't set yet (see docs/PARTS-INTELLIGENCE.md).");
      }
    } catch (e) {
      toast("Search failed: " + (e.message || e));
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = svg(ICON.search) + " Search parts"; }
    }
  }

  // Call the parts-search edge function for every enabled non-manual source,
  // score fitment client-side (we hold the vehicle context), and persist each
  // offer. Returns a per-source status map for the search job.
  async function runLiveSuppliers() {
    const apiSources = S.sources.filter((s) => s.active && s.source_type !== "manual");
    if (!apiSources.length) return { _noApi: true };
    const v = veh();
    // Decode the VIN first (auto, no click needed) so the search is driven by
    // the VIN — the authoritative source — rather than whatever's typed in the
    // van record. Falls back to record fields if there's no VIN / decode fails.
    await ensureVehicleDecoded(v);
    const terms = normalizePartTerms([S.query, S.partNumber].filter(Boolean).join(" "));
    const part = {
      oem_part_numbers: S.partNumber ? [S.partNumber] : [],
      aftermarket_part_numbers: [],
      side: terms.side,
      connector_type: (v && v.required_connector) || null,
      attributes: { required: (v && v.required_features) || {} },
    };
    // Scope the keyword search to the selected van. Prefer the DECODED VIN
    // (year/make/model from NHTSA); fall back to the van record only if the VIN
    // couldn't be decoded. A part-number search is already specific → left as-is.
    const dec = v && v._decoded;
    const vehQ = v ? [
      (dec && dec.year) || v.year,
      (dec && dec.make) || v.make,
      (dec && dec.model) || v.model,
    ].filter(Boolean).join(" ") : "";
    const scopedQuery = [S.query, vehQ].filter(Boolean).join(" ").trim() || null;
    let perSource = {};
    try {
      const { data, error } = await sb().functions.invoke("parts-search", {
        body: { query: scopedQuery, part_number: S.partNumber || null, limit: 25 },
      });
      if (error) throw error;
      perSource = (data && data.source_status) || {};
      const offers = (data && data.offers) || [];
      for (const o of offers) {
        const srcRow = S.sources.find((s) => new RegExp(o.provider, "i").test(s.name)) || null;
        const fit = evaluateFitment(v || {}, part, {
          seller_part_number: o.seller_part_number, product_title: o.product_title,
          fitment_claim: o.product_title, features: {}, connector_type: null,
        });
        try {
          await sb().rpc("parts_offer_save", {
            p_search_id: S.search.id, p_source_id: srcRow ? srcRow.id : null, p_vehicle_id: S.vehicleId,
            p_seller_name: o.seller_name, p_seller_part_number: o.seller_part_number, p_title: o.product_title,
            p_url: o.product_url, p_condition: o.condition && o.condition !== "unknown" ? o.condition : "used",
            p_price_cents: o.price_cents, p_shipping_cents: o.shipping_cents, p_availability: o.availability,
            p_seller_rating: o.seller_rating, p_fitment_claim: o.product_title,
            p_fitment_confidence: fit.level, p_fitment_score: fit.score, p_fitment_reasons: JSON.stringify(fit.reasons),
            p_raw_source_id: o.raw_source_id,
          });
        } catch (e) { /* skip a bad row, keep the rest */ }
      }
    } catch (e) {
      perSource._anyError = String(e.message || e);
    }
    return perSource;
  }

  async function reloadResults() {
    if (!S.search) return;
    const { data, error } = await sb().rpc("parts_search_results", { p_search_id: S.search.id });
    if (error) { toast("Couldn't load results"); return; }
    const raw = (data && data.offers) || [];
    // Derive OEM vs aftermarket from brand/title (no is_oem column on the row).
    raw.forEach((o) => {
      if (o.is_oem == null) o.is_oem = /\b(oem|genuine oem|mopar|motorcraft|ac ?delco|genuine (ford|gm|toyota|honda|ram|mercedes))\b/i.test(
        [o.product_title, o.seller_part_number].filter(Boolean).join(" "));
    });
    // Client-side rank + flag (deterministic engine).
    const landedVals = raw.map((o) => o.total_landed_cents).filter((n) => n > 0);
    const median = landedVals.length ? landedVals.slice().sort((a, b) => a - b)[Math.floor(landedVals.length / 2)] : 0;
    const nowMs = Date.now();
    raw.forEach((o) => { o.flags = detectOfferFlags(o, { medianLanded: median, nowMs }); });
    S.offers = rankOffers(raw, { oemPreference: S.filters.oem, weights: S.weights });
    renderResults();
  }

  // ── "Shop this part" · zero-setup buy links ───────────────────────────
  // Deep-links to each retailer's own search for the part + vehicle. No API,
  // no key, no cost — just hyperlinks that send you to buy. This is always
  // available the moment you search, independent of any connected supplier.
  function shopLinksHtml() {
    const v = veh();
    const base = [S.partNumber || S.query, v && v.year, v && v.make, v && v.model].filter(Boolean).join(" ").trim();
    if (!base) return "";
    const q = encodeURIComponent(base);
    const links = [
      ["eBay Motors", `https://www.ebay.com/sch/6030/i.html?_nkw=${q}`],
      ["Amazon", `https://www.amazon.com/s?k=${q}&i=automotive`],
      ["Google Shopping", `https://www.google.com/search?tbm=shop&q=${q}`],
      ["Walmart", `https://www.walmart.com/search?q=${q}`],
      ["RockAuto", `https://www.google.com/search?q=${encodeURIComponent(base + " site:rockauto.com")}`],
    ];
    return `<div class="rrp-shop">
      <span class="rrp-shop-lbl">Shop this part${v ? " for " + esc(v.name || "this van") : ""}:</span>
      ${links.map(([l, u]) => `<a class="btn btn-sm rrp-shop-link" href="${u}" target="_blank" rel="noopener noreferrer">${esc(l)} ↗</a>`).join("")}
    </div>`;
  }

  // ── Results (summary + comparison table) ──────────────────────────────
  function renderResults() {
    const host2 = el("rrp-results");
    if (!host2) return;
    if (!S.search) {
      host2.innerHTML = `<div class="rrp-empty"><h3>Search for a part</h3><p>Describe the part or paste a part number, then choose your suppliers and filters.</p></div>`;
      return;
    }
    const offers = S.offers;
    const fits = offers.filter((o) => o.fitment_confidence === "exact" || o.fitment_confidence === "high").length;
    const rankable = offers.filter((o) => o.fitment_confidence !== "incompatible" && o.total_landed_cents > 0);
    const lowest = rankable.length ? Math.min(...rankable.map((o) => o.total_landed_cents)) : null;
    const fastest = rankable.map((o) => o.delivery_days_max ?? o.delivery_days_min).filter((n) => Number.isFinite(n));
    const fastestD = fastest.length ? Math.min(...fastest) : null;

    const summary = `
      <div class="rrp-kpis">
        <div class="rrp-kpi"><div class="lab">Sources</div><div class="val">${S.sources.filter((s) => s.active).length}</div></div>
        <div class="rrp-kpi"><div class="lab">Offers</div><div class="val">${offers.length}</div></div>
        <div class="rrp-kpi"><div class="lab">Exact / high fit</div><div class="val">${fits}</div></div>
        <div class="rrp-kpi"><div class="lab">Lowest landed</div><div class="val">${lowest != null ? formatCents(lowest) : "—"}</div></div>
        <div class="rrp-kpi"><div class="lab">Fastest</div><div class="val">${fastestD != null ? fastestD + "d" : "—"}</div></div>
      </div>`;

    const actions = `
      <div class="rrp-actions" style="margin:12px 0">
        <button class="btn btn-sm btn-primary" id="rrp-addoffer">${svg(ICON.plus, 13)} Add supplier quote</button>
        <div style="flex:1"></div>
        <button class="btn btn-sm" id="rrp-watch">${svg(ICON.bookmark, 13)} Save to watchlist</button>
        <button class="btn btn-sm" id="rrp-export">${svg(ICON.sheet, 13)} Export to Workbook</button>
        <button class="btn btn-sm" id="rrp-csv">Export CSV</button>
        <button class="btn btn-sm" id="rrp-sources">Sources &amp; health</button>
      </div>`;

    let body;
    if (!offers.length) {
      body = `<div class="rrp-empty"><h3>No supplier offers yet</h3>
        <p>No connected supplier returned a priced offer. Use <b>Shop this part</b> above to buy directly at a retailer, add a supplier quote manually, or connect a supplier under <b>Sources &amp; health</b>.</p></div>`;
    } else {
      body = `<div class="table-wrap"><div class="rrp-tbl-scroll"><table class="rrp-tbl">
        <thead><tr>
          <th>Recommend</th><th>Part</th><th>Type</th><th>Cond.</th><th>Fitment</th>
          <th class="r">Part</th><th class="r">Ship</th><th class="r">Core</th><th class="r">Landed</th>
          <th>Avail.</th><th>Delivery</th><th>Seller</th><th>Warranty</th><th>Return</th>
        </tr></thead><tbody>${offers.map(rowHtml).join("")}</tbody></table></div></div>`;
    }
    host2.innerHTML = summary + shopLinksHtml() + actions + body;

    // Wire actions
    el("rrp-addoffer").onclick = () => openOfferModal();
    el("rrp-watch").onclick = saveWatchlist;
    el("rrp-export").onclick = exportWorkbook;
    el("rrp-csv").onclick = exportCsv;
    el("rrp-sources").onclick = openSources;
    host2.querySelectorAll("tbody tr[data-oid]").forEach((tr) => {
      tr.onclick = () => openOfferDrawer(offers.find((o) => o.id === tr.getAttribute("data-oid")));
    });
  }

  function rowHtml(o) {
    const rec = (o._recommendations || [])[0];
    const recCls = rec ? rec.key : "";
    const conf = o.fitment_confidence || "unknown";
    const reasons = Array.isArray(o.fitment_reasons) ? o.fitment_reasons : [];
    const why = reasons.find((r) => r.tone === "pos") || reasons[0];
    const availLabel = { in_stock: "In stock", low_stock: "Low stock", backorder: "Backorder", out_of_stock: "Out of stock" }[o.availability] || "—";
    const availCls = o.availability === "out_of_stock" ? "color:var(--red-text,#B91C1C);font-weight:600" : o.availability === "low_stock" ? "color:var(--amber-text,#B45309);font-weight:600" : o.availability === "in_stock" ? "color:var(--green-text,#15803D);font-weight:600" : "color:var(--text-subtle)";
    const suspicious = (o.flags || []).includes("suspicious_price");
    return `<tr data-oid="${esc(o.id)}">
      <td>${rec ? `<span class="rrp-rec ${esc(recCls)}" title="${esc(rec.why)}">${esc(rec.label)}</span>` : ""}</td>
      <td><div class="rrp-partnm">${esc(o.product_title || "Part")}</div><div class="rrp-sub">${esc(o.seller_part_number || "")}</div></td>
      <td>${o.is_oem ? '<span class="rrp-tagoem">OEM</span>' : '<span class="rrp-tagam">Aftmkt</span>'}</td>
      <td class="rrp-sub" style="text-transform:capitalize">${esc(o.condition || "")}</td>
      <td><span class="rrp-fit ${esc(FITMENT_CLASS[conf] || "verify")}"><span class="d"></span>${esc(FITMENT_LABEL[conf] || "Unknown")}</span>${why ? `<div class="rrp-sub" style="max-width:200px">${esc(why.label)}</div>` : ""}</td>
      <td class="r">${o.price_cents != null ? formatCents(o.price_cents) : "—"}</td>
      <td class="r">${o.shipping_cents ? formatCents(o.shipping_cents) : "Free"}</td>
      <td class="r">${o.core_charge_cents ? formatCents(o.core_charge_cents) : "—"}</td>
      <td class="r"><b${suspicious ? ' style="color:var(--red-text,#B91C1C)"' : ""}>${o.total_landed_cents != null ? formatCents(o.total_landed_cents) : "—"}</b></td>
      <td style="${availCls}">${esc(availLabel)}</td>
      <td>${esc(formatDelivery(o))}</td>
      <td>${esc(o.seller_name || o.source_name || "—")}${o.seller_rating ? `<div class="rrp-sub">${o.seller_rating}★</div>` : ""}</td>
      <td class="rrp-sub">${esc(o.warranty || "—")}</td>
      <td class="rrp-sub">${esc(o.return_policy || "—")}</td>
    </tr>`;
  }

  // ── Add supplier quote (manual connector) ─────────────────────────────
  function openOfferModal() {
    const v = veh();
    const terms = normalizePartTerms([S.query, S.partNumber].filter(Boolean).join(" "));
    const srcOpts = S.sources.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
    const modal = overlay(`<div class="rrp-modal">
      <div class="rrp-mh"><h3>Add supplier quote</h3><button class="x" data-close>×</button></div>
      <div class="rrp-mb">
        <div class="rrp-grid">
          <div class="rrp-fg"><label>Supplier source</label><select id="of-src">${srcOpts}</select></div>
          <div class="rrp-fg"><label>Seller name</label><input id="of-seller" placeholder="e.g. Parts Authority"></div>
          <div class="rrp-fg"><label>Part number</label><input id="of-pn" value="${esc(S.partNumber)}"></div>
          <div class="rrp-fg"><label>Title / description</label><input id="of-title" value="${esc(S.query)}"></div>
          <div class="rrp-fg"><label>Condition</label><select id="of-cond"><option value="new">New</option><option value="remanufactured">Remanufactured</option><option value="refurbished">Refurbished</option><option value="used">Used</option><option value="nos">NOS</option></select></div>
          <div class="rrp-fg"><label>OEM part?</label><select id="of-oem"><option value="0">Aftermarket</option><option value="1">OEM</option></select></div>
          <div class="rrp-fg"><label>Price ($)</label><input id="of-price" type="number" min="0" step="0.01"></div>
          <div class="rrp-fg"><label>Shipping ($)</label><input id="of-ship" type="number" min="0" step="0.01"></div>
          <div class="rrp-fg"><label>Tax ($)</label><input id="of-tax" type="number" min="0" step="0.01"></div>
          <div class="rrp-fg"><label>Core charge ($)</label><input id="of-core" type="number" min="0" step="0.01"></div>
          <div class="rrp-fg"><label>Availability</label><select id="of-avail"><option value="in_stock">In stock</option><option value="low_stock">Low stock</option><option value="backorder">Backorder</option><option value="out_of_stock">Out of stock</option></select></div>
          <div class="rrp-fg"><label>Delivery (days)</label><input id="of-days" type="number" min="0" step="1"></div>
          <div class="rrp-fg"><label>Warranty</label><input id="of-warr" placeholder="e.g. 12 month"></div>
          <div class="rrp-fg"><label>Return policy</label><input id="of-ret" placeholder="e.g. 30-day returns"></div>
          <div class="rrp-fg"><label>Seller rating (0–5)</label><input id="of-rating" type="number" min="0" max="5" step="0.1"></div>
          <div class="rrp-fg"><label>Connector</label><input id="of-conn" placeholder="e.g. 14-pin"></div>
          <div class="rrp-fg"><label>Heated</label><select id="of-heat"><option value="">Unknown</option><option value="1">Yes</option><option value="0">No</option></select></div>
          <div class="rrp-fg"><label>Power fold</label><select id="of-power"><option value="">Unknown</option><option value="1">Yes</option><option value="0">No</option></select></div>
        </div>
        <div class="rrp-fg" style="margin-top:6px"><label>Fitment evidence</label>
          <select id="of-evidence">
            <option value="none">No special evidence — score from attributes</option>
            <option value="oem_vin">OEM part # confirmed for THIS VIN (→ can be Exact)</option>
            <option value="oem_catalog">OEM part # matches the catalog (year/make/model)</option>
            <option value="seller">Seller claims it fits (unverified)</option>
          </select>
        </div>
        <div class="rrp-sub">Side inferred from your search: <b>${esc(terms.side || "not specified")}</b>. Fitment is computed by the engine and shown before you save.</div>
      </div>
      <div class="rrp-mf"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="of-save">Add quote</button></div>
    </div>`);
    if (el("of-pn")) el("of-pn").focus();
    el("of-save").onclick = () => saveOffer(modal, terms);
  }

  async function saveOffer(modal, terms) {
    const val = (id) => (el(id) ? el(id).value : "");
    const v = veh();
    const pn = val("of-pn").trim();
    const isOem = val("of-oem") === "1";
    const feat = {};
    if (val("of-heat") !== "") feat.heated = val("of-heat") === "1";
    if (val("of-power") !== "") feat.power = val("of-power") === "1";
    const connector = val("of-conn").trim() || null;

    // Build a lightweight canonical part + offer for the engine.
    const part = {
      oem_part_numbers: isOem && pn ? [pn] : [],
      aftermarket_part_numbers: !isOem && pn ? [pn] : [],
      interchange_numbers: [],
      side: terms.side,
      connector_type: (v && v.required_connector) || null,
      attributes: { required: (v && v.required_features) || {} },
    };
    const offerObj = {
      seller_part_number: pn,
      product_title: val("of-title").trim(),
      fitment_claim: val("of-title").trim(),
      connector_type: connector,
      features: feat,
    };
    const ev = val("of-evidence");
    const evidence = {};
    if (ev === "oem_vin") evidence.oemMatchForVin = true;
    if (ev === "oem_catalog") evidence.oemMatchCatalog = true;
    if (ev === "seller") evidence.sellerClaimsFit = true;
    const fit = evaluateFitment(v || {}, part, offerObj, evidence);

    // Upsert a canonical part so offers dedupe onto a shared identity.
    let canonId = null;
    try {
      const { data: cp } = await sb().rpc("parts_canonical_upsert", {
        p_category: terms.category, p_part_type: null, p_side: terms.side, p_brand: isOem ? "OEM" : null,
        p_is_oem: isOem, p_oem_numbers: part.oem_part_numbers, p_am_numbers: part.aftermarket_part_numbers,
        p_description: offerObj.product_title, p_connector_type: connector,
      });
      canonId = cp && cp.id;
    } catch (e) { /* non-fatal */ }

    const days = val("of-days") ? parseInt(val("of-days"), 10) : null;
    try {
      const { error } = await sb().rpc("parts_offer_save", {
        p_search_id: S.search.id, p_source_id: val("of-src") || null, p_canonical_part_id: canonId,
        p_vehicle_id: S.vehicleId, p_seller_name: val("of-seller").trim() || null, p_seller_part_number: pn || null,
        p_title: offerObj.product_title || null, p_condition: val("of-cond") || "new",
        p_price_cents: cents(val("of-price")), p_shipping_cents: cents(val("of-ship")),
        p_tax_cents: cents(val("of-tax")), p_core_charge_cents: cents(val("of-core")),
        p_availability: val("of-avail") || null, p_delivery_days_min: days, p_delivery_days_max: days,
        p_warranty: val("of-warr").trim() || null, p_return_policy: val("of-ret").trim() || null,
        p_seller_rating: val("of-rating") ? parseFloat(val("of-rating")) : null,
        p_fitment_claim: offerObj.fitment_claim || null, p_fitment_confidence: fit.level,
        p_fitment_score: fit.score, p_fitment_reasons: JSON.stringify(fit.reasons),
      });
      if (error) throw error;
      modal.remove();
      await reloadResults();
      toast("Quote added · fitment: " + fit.label);
    } catch (e) {
      toast("Couldn't save quote: " + (e.message || e));
    }
  }

  // ── Offer detail drawer ───────────────────────────────────────────────
  async function openOfferDrawer(o) {
    if (!o) return;
    const conf = o.fitment_confidence || "unknown";
    const reasons = Array.isArray(o.fitment_reasons) ? o.fitment_reasons : [];
    const flags = o.flags || [];
    const dwr = overlay(`<div class="rrp-drawer">
      <div class="rrp-mh"><div>
        <div class="rrp-sub" style="text-transform:uppercase;letter-spacing:.05em;color:var(--accent-text,#1E40AF);font-weight:700">${esc(o.seller_name || o.source_name || "Offer")}</div>
        <h3>${esc(o.product_title || "Part")}</h3>
        <div class="rrp-sub">${o.is_oem ? "OEM" : "Aftermarket"}${o.seller_part_number ? " · " + esc(o.seller_part_number) : ""}</div>
      </div><button class="x" data-close>×</button></div>
      <div class="rrp-mb" style="flex:1">
        ${flags.includes("incompatible") ? `<div class="rrp-warn">${svg(ICON.warn, 16)}<div>This part is not compatible with the selected vehicle. Do not order.</div></div>` : ""}
        ${flags.includes("suspicious_price") ? `<div class="rrp-warn" style="margin-top:8px">${svg(ICON.warn, 16)}<div>Price is far below the median for this part — verify the listing before buying.</div></div>` : ""}
        <div class="rrp-sec" style="margin-top:${flags.length ? "14px" : "0"}">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
            <span class="rrp-fit ${esc(FITMENT_CLASS[conf] || "verify")}" style="font-size:var(--fs-sm);padding:5px 12px"><span class="d"></span>${esc(FITMENT_LABEL[conf])}</span>
            ${o.fitment_score != null ? `<span class="rrp-sub">confidence ${o.fitment_score}</span>` : ""}
          </div>
          <div class="rrp-sec-h">Why this ${conf === "incompatible" ? "does not fit" : "fits"}</div>
          ${reasons.length ? reasons.map((r) => `<div class="rrp-ev ${esc(r.tone || "pos")}">${svg(r.tone === "neg" ? ICON.x : r.tone === "warn" ? ICON.warn : ICON.check, 16)}<div>${esc(r.label)}</div></div>`).join("") : `<div class="rrp-sub">No structured evidence recorded.</div>`}
          <div style="margin-top:10px"><button class="btn btn-sm" id="dr-verify">${svg(ICON.check, 13)} Verify / override fitment</button></div>
        </div>
        <div class="rrp-sec">
          <div class="rrp-sec-h">Pricing breakdown</div>
          <div class="rrp-pb">
            <div class="r"><span>Part price</span><span>${o.price_cents != null ? formatCents(o.price_cents) : "—"}</span></div>
            <div class="r"><span>Shipping</span><span>${o.shipping_cents ? formatCents(o.shipping_cents) : "Free"}</span></div>
            <div class="r"><span>Tax (est.)</span><span>${o.tax_cents ? formatCents(o.tax_cents) : "—"}</span></div>
            <div class="r"><span>Core charge</span><span>${o.core_charge_cents ? formatCents(o.core_charge_cents) : "—"}</span></div>
            ${o.discount_cents ? `<div class="r"><span>Discount</span><span>−${formatCents(o.discount_cents)}</span></div>` : ""}
            <div class="r tot"><span>Total landed</span><span>${o.total_landed_cents != null ? formatCents(o.total_landed_cents) : "—"}</span></div>
          </div>
          <div class="rrp-sub" style="margin-top:8px">Delivery ${esc(formatDelivery(o))} · Warranty ${esc(o.warranty || "—")} · Returns ${esc(o.return_policy || "—")}</div>
        </div>
        <div class="rrp-sec" id="dr-history"><div class="rrp-sec-h">Price history</div><div class="rrp-sub">Loading…</div></div>
      </div>
      <div class="rrp-mf">
        <button class="btn" data-close>Close</button>
        <button class="btn btn-primary" id="dr-buy">${svg(ICON.cart, 13)} Record purchase</button>
      </div>
    </div>`, "rrp-drawer-o");
    el("dr-verify").onclick = () => verifyFitment(o, dwr);
    el("dr-buy").onclick = () => { dwr.remove(); openPurchaseModal(o); };
    loadHistory(o);
  }

  async function loadHistory(o) {
    const box = el("dr-history"); if (!box) return;
    if (!o.seller_part_number) { box.innerHTML = `<div class="rrp-sec-h">Price history</div><div class="rrp-sub">No part number to chart.</div>`; return; }
    try {
      const { data } = await sb().rpc("parts_price_history", { p_part_number: o.seller_part_number, p_days: 90 });
      const pts = (data || []).filter((p) => p.total_landed_cents > 0);
      if (pts.length < 2) { box.innerHTML = `<div class="rrp-sec-h">Price history</div><div class="rrp-sub">Not enough observations yet — history builds as prices are checked over time.</div>`; return; }
      const vals = pts.map((p) => p.total_landed_cents);
      const min = Math.min(...vals), max = Math.max(...vals), avg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
      const w = 300, hh = 56, span = Math.max(1, max - min);
      const d = pts.map((p, i) => `${(i / (pts.length - 1)) * w},${hh - ((p.total_landed_cents - min) / span) * (hh - 6) - 3}`).join(" L");
      box.innerHTML = `<div class="rrp-sec-h">Price history · ${pts.length} obs (90d)</div>
        <svg class="rrp-spark" viewBox="0 0 ${w} ${hh}" preserveAspectRatio="none"><path d="M${d}" fill="none" stroke="var(--accent,#2563EB)" stroke-width="2"/></svg>
        <div class="rrp-sub" style="display:flex;gap:16px;margin-top:6px">
          <span>Low <b style="color:var(--green-text,#15803D)">${formatCents(min)}</b></span>
          <span>Avg <b>${formatCents(avg)}</b></span>
          <span>High <b>${formatCents(max)}</b></span>
        </div>`;
    } catch (e) { box.innerHTML = `<div class="rrp-sec-h">Price history</div><div class="rrp-sub">Couldn't load history.</div>`; }
  }

  async function verifyFitment(o, dwr) {
    if (!S.vehicleId || !o.canonical_part_id) { toast("Fitment override needs a scoped vehicle and a canonical part."); return; }
    const choice = prompt("Set fitment for this part on this vehicle:\nexact / high / likely / verify / incompatible", o.fitment_confidence || "verify");
    if (!choice) return;
    if (!["exact", "high", "likely", "verify", "incompatible"].includes(choice)) { toast("Invalid fitment level."); return; }
    try {
      await sb().rpc("parts_compat_override", { p_vehicle_id: S.vehicleId, p_canonical_part_id: o.canonical_part_id, p_status: choice, p_note: "Manual override from Parts drawer" });
      toast("Fitment override recorded (audit-logged).");
      dwr.remove();
    } catch (e) { toast("Override failed: " + (e.message || e)); }
  }

  // ── Record purchase ───────────────────────────────────────────────────
  function openPurchaseModal(o) {
    const v = veh();
    const modal = overlay(`<div class="rrp-modal" style="max-width:480px">
      <div class="rrp-mh"><h3>Record purchase</h3><button class="x" data-close>×</button></div>
      <div class="rrp-mb">
        <div class="rrp-sub" style="margin-bottom:10px">${esc(o.product_title || "Part")} · ${esc(o.seller_name || "")}</div>
        <div class="rrp-grid">
          <div class="rrp-fg"><label>Quantity</label><input id="pu-qty" type="number" min="1" value="1"></div>
          <div class="rrp-fg"><label>Final cost ($)</label><input id="pu-cost" type="number" min="0" step="0.01" value="${o.total_landed_cents != null ? (o.total_landed_cents / 100).toFixed(2) : ""}"></div>
          <div class="rrp-fg"><label>PO number</label><input id="pu-po"></div>
          <div class="rrp-fg"><label>Installer</label><input id="pu-inst"></div>
          <div class="rrp-fg"><label>Warranty expires</label><input id="pu-warr" type="date"></div>
          <div class="rrp-fg"><label>Return deadline</label><input id="pu-ret" type="date"></div>
        </div>
      </div>
      <div class="rrp-mf"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="pu-save">Record</button></div>
    </div>`);
    el("pu-save").onclick = async () => {
      const val = (id) => (el(id) ? el(id).value : "");
      try {
        await sb().rpc("parts_purchase_save", {
          p_vehicle_id: S.vehicleId, p_canonical_part_id: o.canonical_part_id, p_supplier_source_id: o.supplier_source_id,
          p_supplier_offer_id: o.id, p_seller_name: o.seller_name || null, p_part_number: o.seller_part_number || null,
          p_description: o.product_title || null, p_condition: o.condition || null,
          p_quantity: parseInt(val("pu-qty") || "1", 10), p_final_cost_cents: cents(val("pu-cost")),
          p_po_number: val("pu-po").trim() || null, p_installer: val("pu-inst").trim() || null,
          p_warranty_expires_on: val("pu-warr") || null, p_return_deadline: val("pu-ret") || null,
          p_status: "ordered", p_fitment_confidence: o.fitment_confidence,
        });
        modal.remove();
        toast("Purchase recorded" + (v ? " for " + esc(v.name || "vehicle") : "") + ".");
      } catch (e) { toast("Couldn't record purchase: " + (e.message || e)); }
    };
  }

  // ── Watchlist ─────────────────────────────────────────────────────────
  async function saveWatchlist() {
    if (!S.query && !S.partNumber) { toast("Nothing to watch — run a search first."); return; }
    const max = prompt("Alert me when landed cost drops to or below ($). Leave blank for stock/OEM alerts:", S.filters.maxLanded ? (S.filters.maxLanded / 100).toString() : "");
    if (max === null) return;
    try {
      await sb().rpc("parts_watchlist_save", {
        p_vehicle_id: S.vehicleId, p_label: S.query || S.partNumber, p_query: S.query || null, p_part_number: S.partNumber || null,
        p_max_price_cents: cents(max), p_oem_preference: S.filters.oem, p_condition_preference: S.filters.condition,
      });
      toast("Saved to watchlist.");
    } catch (e) { toast("Couldn't save watchlist: " + (e.message || e)); }
  }

  // ── Sources & health mini-admin ───────────────────────────────────────
  function openSources() {
    const rows = S.sources.map((s) => {
      const dot = s.health_status === "healthy" ? "var(--green,#16A34A)" : s.health_status === "blocked" || s.health_status === "error" ? "var(--red,#DC2626)" : s.health_status === "slow" || s.health_status === "degraded" ? "var(--amber,#D97706)" : "var(--text-subtle)";
      return `<div class="rrp-src">
        <div><b>${esc(s.name)}</b><div class="rrp-sub">${esc(s.base_url || "")}</div></div>
        <div class="rrp-sub" style="text-transform:capitalize">${esc(s.source_type.replace(/_/g, " "))}</div>
        <div class="rrp-sub">${esc(s.terms_status)} · robots ${esc(s.robots_status)}</div>
        <div><span class="rrp-dot" style="background:${dot}"></span>${esc(s.health_status)}</div>
        <div><label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" data-src="${esc(s.id)}" ${s.active ? "checked" : ""}> Active</label></div>
      </div>`;
    }).join("");
    const modal = overlay(`<div class="rrp-modal">
      <div class="rrp-mh"><h3>Supplier sources &amp; crawl health</h3><button class="x" data-close>×</button></div>
      <div class="rrp-mb">
        <div class="rrp-src h"><span>Source</span><span>Type</span><span>Policy</span><span>Health</span><span>Enabled</span></div>
        ${rows}
        <div class="rrp-sub" style="margin-top:12px">API / crawler sources need approved credentials and a completed terms review before they can be enabled. Credentials are stored as server-side edge secrets, never here.</div>
      </div>
      <div class="rrp-mf"><button class="btn btn-primary" data-close>Done</button></div>
    </div>`);
    modal.querySelectorAll("input[data-src]").forEach((cb) => {
      cb.onchange = async () => {
        try {
          await sb().rpc("parts_source_set_active", { p_id: cb.getAttribute("data-src"), p_active: cb.checked });
          const src = S.sources.find((x) => x.id === cb.getAttribute("data-src"));
          if (src) src.active = cb.checked;
        } catch (e) { toast("Couldn't update source"); cb.checked = !cb.checked; }
      };
    });
  }

  // ── VIN decode ────────────────────────────────────────────────────────
  // Decodes against the free public NHTSA vPIC database. Runs DIRECTLY from the
  // browser (keyless, CORS-enabled US-gov API) so there is nothing to deploy;
  // if that ever fails it falls back to the optional vin-decode edge function.
  const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

  async function decodeVin() {
    const v = veh();
    let vin = (v && v.vin ? String(v.vin) : "").toUpperCase().replace(/\s/g, "");
    if (!VIN_RE.test(vin)) {
      const entered = window.prompt(v ? `${v.name || "This van"} has no valid VIN on record. Enter a 17-character VIN to decode:` : "Enter a 17-character VIN to decode:", vin || "");
      if (entered == null) return;
      vin = entered.toUpperCase().replace(/\s/g, "");
    }
    if (!VIN_RE.test(vin)) { toast("That isn't a valid 17-character VIN (no I, O, or Q)."); return; }

    const btn = el("rrp-decode"); if (btn) { btn.disabled = true; btn.textContent = "Decoding…"; }
    try {
      const c = await decodeVinAnywhere(vin);
      if (!c || (!c.make && !c.model && !c.year)) { toast("NHTSA had no data for that VIN."); return; }
      if (v) {
        v._decoded = c;
        v.required_features = c.required_features || v.required_features;
        v.required_connector = c.required_connector || v.required_connector;
      }
      render();
      const bits = [c.year, c.make, c.model].filter(Boolean).join(" ");
      toast("Decoded: " + (bits || "VIN"));
    } catch (e) {
      toast("Couldn't reach the VIN database. " + (e.message || ""));
    } finally {
      const b = el("rrp-decode"); if (b) { b.disabled = false; b.innerHTML = svg('<path d="M3 12h18M3 6h18M3 18h18"/>', 13) + " Decode VIN"; }
    }
  }

  // Auto-decode a vehicle's VIN once and cache it on the row, so the search can
  // be VIN-driven without the user clicking "Decode VIN". No-op if the van has
  // no valid VIN or is already decoded; swallows failures (search still runs).
  async function ensureVehicleDecoded(v) {
    if (!v || v._decoded) return;
    const vin = String(v.vin || "").toUpperCase().replace(/\s/g, "");
    if (!VIN_RE.test(vin)) return;
    try {
      const c = await decodeVinAnywhere(vin);
      if (c && (c.make || c.model || c.year)) {
        v._decoded = c;
        v.required_features = c.required_features || v.required_features;
        v.required_connector = c.required_connector || v.required_connector;
      }
    } catch (e) { /* leave undecoded; search falls back to record fields */ }
  }

  // Direct browser → NHTSA; fall back to the edge function if the direct call
  // is blocked. Normalizes to the same shape the edge function returns.
  async function decodeVinAnywhere(vin) {
    try {
      const res = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`);
      if (res.ok) {
        const p = await res.json();
        return normalizeNhtsa((p && p.Results && p.Results[0]) || {});
      }
    } catch (e) { /* fall through to edge function */ }
    const provider = makeNhtsaProvider((name, opts) => sb().functions.invoke(name, opts));
    return await provider.decodeVin(vin);
  }

  function normalizeNhtsa(r) {
    const s = (val) => { const t = String(val == null ? "" : val).trim(); return t && t !== "Not Applicable" && t !== "0" ? t : null; };
    return {
      make: s(r.Make), model: s(r.Model), year: s(r.ModelYear),
      trim: s(r.Trim) || s(r.Series),
      body_class: s(r.BodyClass), drive_type: s(r.DriveType),
      engine: [s(r.DisplacementL) ? s(r.DisplacementL) + "L" : null, s(r.EngineCylinders) ? "V" + s(r.EngineCylinders) : null].filter(Boolean).join(" ") || s(r.EngineModel),
      wheelbase: s(r.WheelBaseShort) || s(r.WheelBaseLong) || s(r.WheelBaseInches),
      gvwr: s(r.GVWR),
      required_features: {}, required_connector: null,
    };
  }

  // ── Workbook / CSV export ─────────────────────────────────────────────
  const COLS = ["Recommendation", "Part", "Brand", "OEM/Aftermarket", "Condition", "Fitment", "Part $", "Shipping $", "Core $", "Landed $", "Availability", "Delivery", "Seller", "Warranty", "Return", "URL"];
  function exportRows() {
    return S.offers.map((o) => [
      (o._recommendations || []).map((r) => r.label).join("; "),
      o.product_title || "", o.is_oem ? (o.brand || "OEM") : (o.brand || ""), o.is_oem ? "OEM" : "Aftermarket",
      o.condition || "", FITMENT_LABEL[o.fitment_confidence] || "",
      cToN(o.price_cents), cToN(o.shipping_cents), cToN(o.core_charge_cents), cToN(o.total_landed_cents),
      o.availability || "", formatDelivery(o), o.seller_name || o.source_name || "", o.warranty || "", o.return_policy || "", o.product_url || "",
    ]);
  }
  const cToN = (c) => (c == null ? "" : (c / 100).toFixed(2));

  async function exportWorkbook() {
    if (!S.offers.length) { toast("No offers to export."); return; }
    const v = veh();
    const title = "Parts — " + (S.query || S.partNumber || "search") + (v ? " · " + (v.name || "") : "");
    if (typeof window.__rrCreateReportWorkbook === "function") {
      try {
        await window.__rrCreateReportWorkbook({
          title, description: "Offer comparison exported from Parts Intelligence · " + new Date().toISOString().slice(0, 10),
          headers: COLS, rows: exportRows(), sheetName: "Offers",
        });
        toast("Exported to a new Workbook.");
        return;
      } catch (e) { /* fall through to CSV */ }
    }
    exportCsv();
  }

  function exportCsv() {
    if (!S.offers.length) { toast("No offers to export."); return; }
    const q = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
    const csv = [COLS.map(q).join(",")].concat(exportRows().map((r) => r.map(q).join(","))).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "parts-offers-" + new Date().toISOString().slice(0, 10) + ".csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ── Overlay + toast helpers ───────────────────────────────────────────
  // ── On-hand inventory (the parts room · migration 0540) ─────────────
  // Stock items with bins + min-quantity reorder points; quantity moves
  // ONLY through parts_stock_move (receive / use / return / adjust), so
  // the movement ledger always explains the shelf count. Consumption can
  // tag a van, which feeds that van's cost history (vehicle_cost_summary).
  const usd = (c) => (c == null ? "—" : "$" + (Number(c) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

  async function loadStock() {
    if (S.stockLoading) return;
    S.stockLoading = true;
    try {
      const stn = (typeof window.rrStationScopeId === "function") ? window.rrStationScopeId() : null;
      const { data, error } = await sb().rpc("parts_stock_list", stn ? { p_station_id: stn } : {});
      if (error) {
        S.stock = (error.code === "PGRST202" || /could not find the function/i.test(error.message || ""))
          ? { missing: true }
          : { error: error.message || "Couldn't load inventory" };
      } else {
        S.stock = data || { items: [], summary: {} };
      }
    } catch (e) {
      S.stock = { error: String(e && e.message || e) };
    } finally {
      S.stockLoading = false;
      renderStock();
    }
  }

  function renderStock() {
    const h = el("rrp-stock");
    if (!h) return;
    const st = S.stock;
    const header = (right) => `<div class="rrp-stk-head">
      <div>
        <div class="rrp-stk-title">On-hand inventory</div>
        <div class="rrp-stk-sub">The parts room — shelf stock, bins, and reorder points. Using a part on a van adds it to that van's cost history.</div>
      </div>
      <div class="rrp-stk-actions">${right || ""}</div>
    </div>`;
    if (st === null || S.stockLoading) {
      h.innerHTML = `<div class="rrp-stk">${header("")}<div class="rrp-stk-empty">Loading inventory…</div></div>`;
      return;
    }
    if (st.missing) {
      h.innerHTML = `<div class="rrp-stk">${header("")}
        <div class="rrp-stk-empty"><b>Inventory isn't set up yet.</b> Apply migration <b>0540</b> in Supabase → SQL editor, then reload — you'll get stock items, bins, receive/use tracking, and low-stock flags.</div>
      </div>`;
      return;
    }
    if (st.error) {
      h.innerHTML = `<div class="rrp-stk">${header("")}<div class="rrp-stk-empty">Couldn't load inventory · ${esc(st.error)}</div></div>`;
      return;
    }
    const items = Array.isArray(st.items) ? st.items : [];
    const sum = st.summary || {};
    const summaryTxt = items.length
      ? `${sum.items ?? items.length} item${(sum.items ?? items.length) === 1 ? "" : "s"}${sum.low_stock_count ? ` · <b class="rrp-stk-low-b">${sum.low_stock_count} low</b>` : ""} · ${usd(sum.total_value_cents ?? 0)} on hand`
      : "";
    const addBtn = `<button class="btn btn-sm btn-primary" id="rrp-stk-add">${svg(ICON.plus, 13)} Add stock item</button>`;
    if (!items.length) {
      h.innerHTML = `<div class="rrp-stk">${header(addBtn)}
        <div class="rrp-stk-empty">No stock tracked yet. Add the parts you keep on the shelf — filters, brake pads, mirrors, bulbs — with a bin and a minimum quantity, and the low-stock flag tells you when to reorder.</div>
      </div>`;
      wireStock();
      return;
    }
    const rows = items.map((it) => {
      const low = !!it.low_stock;
      return `<tr class="${low ? "rrp-stk-lowrow" : ""}${it.active === false ? " rrp-stk-inactive" : ""}">
        <td>
          <button type="button" class="rrp-stk-name" data-stk-hist="${esc(it.id)}" title="View movement history">${esc(it.name)}</button>
          <div class="rrp-stk-meta">${[it.part_number ? esc(it.part_number) : "", it.category ? esc(it.category) : "", it.station_code ? esc(it.station_code) : ""].filter(Boolean).join(" · ") || ""}</div>
        </td>
        <td>${it.bin_location ? esc(it.bin_location) : "—"}</td>
        <td class="rrp-stk-qty">${Number(it.qty_on_hand).toLocaleString()}${low ? ` <span class="rrp-stk-low">LOW</span>` : ""}</td>
        <td>${it.min_qty != null ? Number(it.min_qty).toLocaleString() : "—"}</td>
        <td>${usd(it.unit_cost_cents)}</td>
        <td>${usd(it.value_cents)}</td>
        <td class="rrp-stk-act">
          <button class="btn btn-sm" data-stk-move="receive" data-stk-id="${esc(it.id)}" title="Receive stock in">＋</button>
          <button class="btn btn-sm" data-stk-move="consume" data-stk-id="${esc(it.id)}" title="Use on a van">Use</button>
          <button class="btn btn-sm" data-stk-move="adjust" data-stk-id="${esc(it.id)}" title="Cycle count / correct">Adj</button>
          <button class="btn btn-sm" data-stk-edit="${esc(it.id)}" title="Edit item">Edit</button>
        </td>
      </tr>`;
    }).join("");
    h.innerHTML = `<div class="rrp-stk">
      ${header(`<span class="rrp-stk-sum">${summaryTxt}</span>${addBtn}`)}
      <table class="rrp-stk-table">
        <thead><tr><th>Part</th><th>Bin</th><th>On hand</th><th>Min</th><th>Unit cost</th><th>Value</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
    wireStock();
  }

  function wireStock() {
    const h = el("rrp-stock");
    if (!h) return;
    if (h.dataset.wired) return;
    h.dataset.wired = "1";
    h.addEventListener("click", (e) => {
      if (e.target.closest("#rrp-stk-add")) { openStockItemModal(null); return; }
      const edit = e.target.closest("[data-stk-edit]");
      if (edit) { openStockItemModal(stockItem(edit.getAttribute("data-stk-edit"))); return; }
      const mv = e.target.closest("[data-stk-move]");
      if (mv) { openStockMoveModal(stockItem(mv.getAttribute("data-stk-id")), mv.getAttribute("data-stk-move")); return; }
      const hist = e.target.closest("[data-stk-hist]");
      if (hist) { openStockHistory(stockItem(hist.getAttribute("data-stk-hist"))); return; }
    });
  }
  const stockItem = (id) => ((S.stock && Array.isArray(S.stock.items)) ? S.stock.items : []).find((x) => x.id === id) || null;

  function openStockItemModal(item) {
    const it = item || {};
    // Station scoping (optional): the sidebar lens shows a station-tied
    // item only under its station; a no-station item is the shared parts
    // room, visible in every scope. List comes from live.js's exported
    // snapshot; single-station DSPs skip the field entirely.
    const stations = (typeof window.rrStationList === "function") ? window.rrStationList() : [];
    // An item homed at a since-deactivated station keeps a labelled
    // synthetic option (the vehicle station picker's recipe) — otherwise
    // the select would default to "Shared" and an unrelated edit would
    // silently null the assignment (Codex review).
    const stnOrphan = it.station_id && !stations.some((s) => s.id === it.station_id);
    const stnField = (stations.length > 1 || stnOrphan) ? `<div class="rrp-fg"><label>Station</label><select id="stk-stn">
            <option value="">Shared — all stations</option>
            ${stations.map((s) => `<option value="${esc(s.id)}"${it.station_id === s.id ? " selected" : ""}>${esc([s.code, s.name].filter(Boolean).join(" — ") || "Station")}</option>`).join("")}
            ${stnOrphan ? `<option value="${esc(it.station_id)}" selected>${esc(it.station_code || "Current station")} (inactive)</option>` : ""}
          </select></div>` : "";
    const modal = overlay(`<div class="rrp-modal" style="max-width:520px">
      <div class="rrp-mh"><h3>${it.id ? "Edit stock item" : "Add stock item"}</h3><button class="x" data-close>×</button></div>
      <div class="rrp-mb">
        <div class="rrp-grid">
          <div class="rrp-fg" style="grid-column:1/-1"><label>Name *</label><input id="stk-name" maxlength="120" value="${esc(it.name || "")}" placeholder="e.g. Oil filter — Ford Transit 3.5L"></div>
          <div class="rrp-fg"><label>Part number</label><input id="stk-pn" maxlength="60" value="${esc(it.part_number || "")}" placeholder="OEM or aftermarket #"></div>
          <div class="rrp-fg"><label>Category</label><input id="stk-cat" maxlength="40" value="${esc(it.category || "")}" placeholder="filters, brakes, mirrors…"></div>
          <div class="rrp-fg"><label>Bin / location</label><input id="stk-bin" maxlength="40" value="${esc(it.bin_location || "")}" placeholder="e.g. A3, back shelf"></div>
          ${stnField}
          <div class="rrp-fg"><label>Min quantity (reorder at)</label><input id="stk-min" type="number" min="0" step="1" value="${it.min_qty ?? ""}"></div>
          ${it.id ? "" : `<div class="rrp-fg"><label>Opening quantity</label><input id="stk-qty0" type="number" min="0" step="1" placeholder="0"></div>
          <div class="rrp-fg"><label>Unit cost ($)</label><input id="stk-cost0" type="number" min="0" step="0.01" placeholder="0.00"></div>`}
          ${it.id ? `<div class="rrp-fg"><label>Status</label><select id="stk-active"><option value="1"${it.active !== false ? " selected" : ""}>Active</option><option value="0"${it.active === false ? " selected" : ""}>Retired</option></select></div>` : ""}
          <div class="rrp-fg" style="grid-column:1/-1"><label>Notes</label><input id="stk-notes" maxlength="200" value="${esc(it.notes || "")}" placeholder="optional"></div>
        </div>
        ${it.id ? `<div class="rrp-sub">On hand: <b>${Number(it.qty_on_hand).toLocaleString()}</b> — quantity changes go through Receive / Use / Adjust so the ledger stays honest.</div>` : ""}
      </div>
      <div class="rrp-mf"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="stk-save">${it.id ? "Save item" : "Add item"}</button></div>
    </div>`);
    el("stk-name")?.focus();
    el("stk-save").onclick = async () => {
      const name = (el("stk-name")?.value || "").trim();
      if (!name) { toast("Name is required."); return; }
      const btn = el("stk-save"); btn.disabled = true;
      const args = {
        p_id: it.id || null,
        p_name: name,
        p_part_number: (el("stk-pn")?.value || "").trim() || null,
        p_category: (el("stk-cat")?.value || "").trim() || null,
        p_bin_location: (el("stk-bin")?.value || "").trim() || null,
        p_min_qty: el("stk-min")?.value ? parseInt(el("stk-min").value, 10) : null,
        p_active: it.id ? el("stk-active")?.value !== "0" : true,
        p_notes: (el("stk-notes")?.value || "").trim() || null,
        p_canonical_part_id: it.canonical_part_id || null,
        p_station_id: el("stk-stn") ? (el("stk-stn").value || null) : (it.station_id || null),
      };
      if (!it.id) {
        args.p_initial_qty = el("stk-qty0")?.value ? Math.max(0, parseInt(el("stk-qty0").value, 10) || 0) : null;
        args.p_unit_cost_cents = cents(el("stk-cost0")?.value);
      } else {
        args.p_unit_cost_cents = null; // keep the moving average
      }
      const { error } = await sb().rpc("parts_stock_item_save", args);
      btn.disabled = false;
      if (error) { toast("Couldn't save item: " + error.message); return; }
      modal.remove();
      toast(it.id ? "Item updated." : "Item added.");
      S.stock = null;
      loadStock();
    };
  }

  function openStockMoveModal(item, kind) {
    if (!item) return;
    const K = {
      receive: { title: "Receive stock", verb: "Receive", qtyLbl: "Quantity received", showCost: true, showVeh: false },
      consume: { title: "Use on a van", verb: "Use", qtyLbl: "Quantity used", showCost: false, showVeh: true },
      adjust:  { title: "Adjust count", verb: "Adjust", qtyLbl: "New counted quantity", showCost: false, showVeh: false },
    }[kind] || { title: "Move stock", verb: "Save", qtyLbl: "Quantity" };
    const vehOpts = S.vehicles.map((x) => `<option value="${esc(x.id)}">${esc(x.name || "Van")}${x.plate ? " · " + esc(x.plate) : ""}</option>`).join("");
    const modal = overlay(`<div class="rrp-modal" style="max-width:460px">
      <div class="rrp-mh"><h3>${esc(K.title)} · ${esc(item.name)}</h3><button class="x" data-close>×</button></div>
      <div class="rrp-mb">
        <div class="rrp-grid">
          <div class="rrp-fg"><label>${esc(K.qtyLbl)} *</label><input id="mv-qty" type="number" min="0" step="1" value="${kind === "adjust" ? Number(item.qty_on_hand) : ""}"></div>
          ${K.showCost ? `<div class="rrp-fg"><label>Unit cost ($)</label><input id="mv-cost" type="number" min="0" step="0.01" placeholder="updates the moving average"></div>` : ""}
          ${K.showVeh ? `<div class="rrp-fg" style="grid-column:1/-1"><label>Used on van</label><select id="mv-veh"><option value="">— Not van-specific</option>${vehOpts}</select></div>` : ""}
          <div class="rrp-fg" style="grid-column:1/-1"><label>Note</label><input id="mv-note" maxlength="200" placeholder="optional"></div>
        </div>
        <div class="rrp-sub">On hand now: <b>${Number(item.qty_on_hand).toLocaleString()}</b>${kind === "adjust" ? " — enter the count you see on the shelf." : ""}</div>
      </div>
      <div class="rrp-mf"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="mv-save">${esc(K.verb)}</button></div>
    </div>`);
    el("mv-qty")?.focus();
    el("mv-save").onclick = async () => {
      const qty = parseInt(el("mv-qty")?.value || "", 10);
      if (!Number.isFinite(qty) || qty < 0 || (kind !== "adjust" && qty <= 0)) { toast("Enter a quantity."); return; }
      const btn = el("mv-save"); btn.disabled = true;
      const { error } = await sb().rpc("parts_stock_move", {
        p_item_id: item.id,
        p_kind: kind,
        p_qty: qty,
        p_unit_cost_cents: K.showCost ? cents(el("mv-cost")?.value) : null,
        p_vehicle_id: K.showVeh ? (el("mv-veh")?.value || null) : null,
        p_repair_case_id: null,
        p_note: (el("mv-note")?.value || "").trim() || null,
      });
      btn.disabled = false;
      if (error) {
        toast(error.message === "insufficient_stock" || /insufficient_stock/.test(error.message || "")
          ? "Not enough on hand for that." : "Couldn't record the movement: " + error.message);
        return;
      }
      modal.remove();
      toast(kind === "receive" ? "Stock received." : kind === "consume" ? "Usage recorded." : "Count adjusted.");
      S.stock = null;
      loadStock();
    };
  }

  async function openStockHistory(item) {
    if (!item) return;
    const modal = overlay(`<div class="rrp-modal" style="max-width:560px">
      <div class="rrp-mh"><h3>${esc(item.name)} · movements</h3><button class="x" data-close>×</button></div>
      <div class="rrp-mb" id="stk-hist-body"><div class="rrp-stk-empty">Loading…</div></div>
      <div class="rrp-mf"><button class="btn" data-close>Close</button></div>
    </div>`);
    const body = el("stk-hist-body");
    const { data, error } = await sb().rpc("parts_stock_movements_list", { p_item_id: item.id, p_limit: 50 });
    if (!body) return;
    if (error) { body.innerHTML = `<div class="rrp-stk-empty">Couldn't load history · ${esc(error.message)}</div>`; return; }
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) { body.innerHTML = `<div class="rrp-stk-empty">No movements yet.</div>`; return; }
    const kindLbl = { receive: "Received", consume: "Used", return: "Returned", adjust: "Adjusted" };
    body.innerHTML = rows.map((m) => `<div class="rrp-ev ${m.qty_delta > 0 ? "pos" : "neg"}">
      <span class="i">${svg(m.qty_delta > 0 ? ICON.plus : ICON.x, 14)}</span>
      <div>
        <b>${esc(kindLbl[m.kind] || m.kind)} ${m.qty_delta > 0 ? "+" : ""}${m.qty_delta}</b>
        ${m.unit_cost_cents != null ? ` @ ${usd(m.unit_cost_cents)}` : ""}
        ${m.vehicle_name ? ` · ${esc(m.vehicle_name)}` : ""}
        ${m.note ? `<div class="rrp-stk-meta">${esc(m.note)}</div>` : ""}
        <div class="rrp-stk-meta">${esc(new Date(m.created_at).toLocaleString())}</div>
      </div>
    </div>`).join("");
  }

  function overlay(inner, extraCls) {
    const o = document.createElement("div");
    o.className = "rrp-overlay" + (extraCls ? " " + extraCls : "");
    o.innerHTML = inner;
    o.addEventListener("click", (e) => { if (e.target === o || e.target.closest("[data-close]")) o.remove(); });
    document.body.appendChild(o);
    return o;
  }
  function toast(msg) {
    if (window.toast) return window.toast(msg);
    if (window.showToast) return window.showToast(msg);
    let t = el("rrp-toast");
    if (!t) { t = document.createElement("div"); t.id = "rrp-toast"; t.style.cssText = "position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:var(--slate-900,#0F172A);color:#fff;padding:10px 16px;border-radius:8px;z-index:10000;font-size:13px;max-width:80vw"; document.body.appendChild(t); }
    t.textContent = msg;
    t.style.opacity = "1";
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.style.opacity = "0"; }, 3200);
  }

  window.RRParts = { mount, searchForVehicle };
})();
