// ─── parts-engine.js · Parts Intelligence deterministic math ───────────────
//
// The single source of truth for the four numbers/decisions the Parts
// Intelligence feature makes about every supplier offer:
//   1. landed cost         — computeLandedCost()
//   2. fitment confidence  — scoreFitment()  (deterministic, evidence-gated)
//   3. offer ranking       — rankOffers()    (configurable weighted score)
//   4. term normalization  — normalizePartTerms() / normalizeSide() / …
//
// Pure module: no DOM, no Supabase, no Date.now(). Callers pass `nowIso`
// where "now" matters. That is what makes this testable from node
// (scripts/test-parts-*.mjs) and safe to import from the browser UI.
//
// FITMENT PRINCIPLE (non-negotiable): a result is NEVER "Exact fit" without
// explicit supporting evidence (an OEM part-number match for the VIN, or a
// manual RouteReady verification). Year/make/model agreement alone can never
// exceed "Likely fit". A required-attribute conflict (wrong connector,
// missing required feature) forces "Incompatible" regardless of everything
// else. AI extraction may populate signals but must never assert a level.

// ── Fitment levels · canonical vocabulary ──────────────────────────────
export const FITMENT_LEVELS = ["exact", "high", "likely", "verify", "incompatible", "unknown"];
export const FITMENT_LABEL = {
  exact: "Exact fit",
  high: "High confidence",
  likely: "Likely fit",
  verify: "Requires verification",
  incompatible: "Known incompatible",
  unknown: "Unknown",
};
// CSS class hooks (mirror the mockup / inline-styles risk vocabulary).
export const FITMENT_CLASS = {
  exact: "exact", high: "high", likely: "likely", verify: "verify",
  incompatible: "incompatible", unknown: "verify",
};
const FITMENT_RANK = { exact: 5, high: 4, likely: 3, verify: 2, unknown: 1, incompatible: 0 };

// ── 1. Landed cost ─────────────────────────────────────────────────────
// Total the buyer actually pays: part + shipping + tax + core charge − discount.
// Everything in integer cents; missing components count as 0. Never negative.
export function computeLandedCost(offer) {
  const c = (v) => (Number.isFinite(v) ? Math.round(v) : 0);
  const total =
    c(offer.price_cents) +
    c(offer.shipping_cents) +
    c(offer.tax_cents) +
    c(offer.core_charge_cents) -
    c(offer.discount_cents);
  return Math.max(0, total);
}

// ── Normalization ──────────────────────────────────────────────────────
// Resolve inconsistent seller terminology to canonical values. Deterministic
// rules first; the UI/AI can pre-fill but these guarantee a stable identity.

export function normalizeSide(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (/\b(passenger|right|rh|r\/h|right-?hand|right-?side|pass\.?)\b/.test(s)) return "right";
  if (/\b(driver|left|lh|l\/h|left-?hand|left-?side|drv\.?)\b/.test(s)) return "left";
  if (/\bboth|pair|set\b/.test(s)) return "both";
  return null;
}

export function normalizePosition(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (/\bfront|fr\b/.test(s)) return "front";
  if (/\brear|back|rr\b/.test(s)) return "rear";
  if (/\bupper|top\b/.test(s)) return "upper";
  if (/\blower|bottom\b/.test(s)) return "lower";
  return null;
}

const CONDITION_MAP = [
  // Specific multi-word / distinctive conditions first, so the generic "new"
  // rule doesn't swallow "New Old Stock".
  [/\b(nos|new old stock)\b/, "nos"],
  [/\b(reman|remanufactured|rebuilt)\b/, "remanufactured"],
  [/\b(refurb|refurbished|renewed)\b/, "refurbished"],
  [/\b(used|pre-?owned|salvage|take-?off|oem take off)\b/, "used"],
  [/\bcore\b/, "core"],
  [/\b(brand ?new|new|nib)\b/, "new"],
];
export function normalizeCondition(raw) {
  if (!raw) return "unknown";
  const s = String(raw).toLowerCase();
  for (const [re, val] of CONDITION_MAP) if (re.test(s)) return val;
  return "unknown";
}

// Category from a free-text description (coarse, extensible).
const CATEGORY_MAP = [
  [/\bmirror\b/, "mirror"],
  [/\b(brake|pad|rotor|caliper)\b/, "brake"],
  [/\b(head ?light|tail ?light|lamp|bulb|turn signal)\b/, "lighting"],
  [/\b(alternator|starter|battery)\b/, "electrical"],
  [/\b(belt|serpentine|tensioner)\b/, "belt"],
  [/\b(bumper|fender|door|panel|grille|hood)\b/, "body"],
  [/\b(filter|oil|coolant|fluid)\b/, "maintenance"],
  [/\b(sensor|camera|radar|blis|abs)\b/, "sensor"],
  [/\b(roller|hinge|latch|handle)\b/, "hardware"],
];
export function normalizeCategory(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  for (const [re, val] of CATEGORY_MAP) if (re.test(s)) return val;
  return null;
}

// Normalize a raw seller title / description into canonical part terms.
export function normalizePartTerms(text) {
  return {
    category: normalizeCategory(text),
    side: normalizeSide(text),
    position: normalizePosition(text),
    condition: normalizeCondition(text),
  };
}

// Canonicalize a part number for comparison: uppercase, strip separators.
export function canonPartNumber(pn) {
  return String(pn || "").toUpperCase().replace(/[\s\-._/]/g, "");
}

// Does `list` (array of part numbers) contain `pn`, separator-insensitively?
export function partNumberIn(pn, list) {
  if (!pn || !Array.isArray(list)) return false;
  const target = canonPartNumber(pn);
  return list.some((x) => canonPartNumber(x) === target);
}

// ── 2. Fitment confidence ──────────────────────────────────────────────
// `signals` is a plain object of evidence flags/values. deriveFitmentSignals()
// builds a baseline from vehicle+part+offer; callers may add manufacturer or
// VIN-level evidence. scoreFitment() maps signals → { level, score, reasons }.
//
// Signal keys (all optional):
//   oemMatchForVin       bool  OEM part # matches the manufacturer catalog for THIS vin
//   oemMatchCatalog      bool  OEM part # matches the catalog (year/make/model, not vin)
//   interchangeMatch     bool  matches a known interchange / superseded number
//   sideMatch            bool|null
//   positionMatch        bool|null
//   engineMatch          bool|null
//   wheelbaseMatch       bool|null
//   roofMatch            bool|null
//   productionDateInRange bool|null
//   connectorMatch       bool|null   (null = unknown)
//   featureMatch         bool|null   (required feature present, e.g. heated/power)
//   sellerClaimsFit      bool
//   historicalSuccess    bool  a prior successful purchase of this part on a like vehicle
//   manualVerified       'exact'|'incompatible'|null
//   requiredConflicts    string[]  hard blockers (e.g. ['connector','missing_heat'])

export function deriveFitmentSignals(vehicle = {}, part = {}, offer = {}) {
  const sig = { requiredConflicts: [] };
  const oem = part.oem_part_numbers || [];
  const am = part.aftermarket_part_numbers || [];
  const inter = [].concat(part.interchange_numbers || [], part.superseded_part_numbers || []);
  const pn = offer.seller_part_number;

  if (pn) {
    if (partNumberIn(pn, oem)) sig.oemMatchCatalog = true;
    if (partNumberIn(pn, inter)) sig.interchangeMatch = true;
  }

  // Side: compare canonical part side to canonical offer side (from title).
  const partSide = part.side || normalizeSide(part.description);
  const offerSide = normalizeSide(offer.product_title) || normalizeSide(offer.fitment_claim);
  if (partSide && offerSide) sig.sideMatch = partSide === "both" || offerSide === "both" || partSide === offerSide;

  // Connector: if the part declares a required connector and the offer states a
  // different one, that is a hard conflict.
  const need = part.connector_type;
  const has = offer.connector_type;
  if (need && has) {
    if (canonPartNumber(need) === canonPartNumber(has)) sig.connectorMatch = true;
    else { sig.connectorMatch = false; sig.requiredConflicts.push("connector"); }
  }

  // Required features declared on the part's attributes (e.g. {heated:true}).
  const reqFeatures = (part.attributes && part.attributes.required) || {};
  const offFeatures = offer.features || {};
  const missing = [];
  for (const k of Object.keys(reqFeatures)) {
    if (reqFeatures[k] && offFeatures[k] === false) missing.push(k);
  }
  if (missing.length) { sig.featureMatch = false; missing.forEach((m) => sig.requiredConflicts.push("missing_" + m)); }
  else if (Object.keys(reqFeatures).length) sig.featureMatch = true;

  sig.sellerClaimsFit = !!(offer.fitment_claim && /\b(fits|compatible|direct|oe replacement)\b/i.test(offer.fitment_claim));
  return sig;
}

export function scoreFitment(signals = {}) {
  const reasons = [];
  const conflicts = signals.requiredConflicts || [];

  // Manual override wins outright.
  if (signals.manualVerified === "incompatible")
    return finalize("incompatible", 0, [reason("manual", "Manually marked incompatible by RouteReady", "neg")]);
  if (signals.manualVerified === "exact")
    return finalize("exact", 1, [reason("manual", "Manually verified as an exact fit", "pos")]);

  // Hard gate: any required conflict → incompatible.
  if (conflicts.length) {
    for (const c of conflicts) reasons.push(reason("conflict", conflictLabel(c), "neg"));
    return finalize("incompatible", 0, reasons);
  }

  // Positive evidence accumulation (weights sum to a 0..1 score).
  let score = 0;
  const add = (w, id, label) => { score += w; reasons.push(reason(id, label, "pos")); };

  if (signals.oemMatchForVin) add(0.55, "oem_vin", "OEM part number matches the manufacturer catalog for this VIN");
  else if (signals.oemMatchCatalog) add(0.4, "oem_catalog", "OEM part number matches the catalog for this year/make/model");
  if (signals.interchangeMatch) add(0.2, "interchange", "Matches a known interchange / superseded number");
  if (signals.sideMatch === true) add(0.08, "side", "Side / position matches");
  if (signals.positionMatch === true) add(0.05, "position", "Mounting position matches");
  if (signals.engineMatch === true) add(0.06, "engine", "Engine matches");
  if (signals.wheelbaseMatch === true) add(0.05, "wheelbase", "Wheelbase matches");
  if (signals.roofMatch === true) add(0.04, "roof", "Roof height matches");
  if (signals.productionDateInRange === true) add(0.04, "proddate", "Within the production-date range");
  if (signals.connectorMatch === true) add(0.1, "connector", "Connector matches");
  if (signals.featureMatch === true) add(0.08, "feature", "Required features present");
  if (signals.historicalSuccess) add(0.12, "history", "A prior purchase of this part fit a like vehicle");
  if (signals.sellerClaimsFit) add(0.05, "seller", "Seller claims this fits (unverified)");

  score = Math.min(1, score);

  // Note unknowns so the reason list explains the ceiling.
  if (signals.connectorMatch == null) reasons.push(reason("connector_unk", "Connector not confirmed", "warn"));
  if (signals.featureMatch == null && !signals.oemMatchForVin) reasons.push(reason("feature_unk", "Required features not confirmed", "warn"));

  // Level mapping WITH gates (evidence, not score alone, unlocks a level).
  let level;
  if (signals.oemMatchForVin && signals.connectorMatch !== false && signals.featureMatch !== false) {
    level = "exact";
  } else if (
    (signals.oemMatchCatalog || signals.interchangeMatch) &&
    signals.connectorMatch !== false && signals.featureMatch !== false && score >= 0.45
  ) {
    level = "high";
  } else if (score >= 0.2) {
    level = "likely";
  } else {
    level = "verify";
  }

  return finalize(level, round2(score), reasons);
}

function finalize(level, score, reasons) { return { level, score, reasons, label: FITMENT_LABEL[level], cssClass: FITMENT_CLASS[level] }; }
function reason(id, label, tone) { return { id, label, tone }; } // tone: pos|neg|warn
function conflictLabel(c) {
  if (c === "connector") return "Connector does not match this vehicle's harness";
  if (c.startsWith("missing_")) return "Missing a required feature: " + c.slice(8).replace(/_/g, " ");
  return "Incompatible: " + c.replace(/_/g, " ");
}
function round2(n) { return Math.round(n * 100) / 100; }

// End-to-end helper the UI uses: derive baseline signals, merge caller-supplied
// evidence, score. `evidence` overrides/augments derived signals.
export function evaluateFitment(vehicle, part, offer, evidence = {}) {
  const base = deriveFitmentSignals(vehicle, part, offer);
  const merged = { ...base, ...evidence,
    requiredConflicts: [].concat(base.requiredConflicts || [], evidence.requiredConflicts || []) };
  return scoreFitment(merged);
}

// ── 3. Offer ranking ───────────────────────────────────────────────────
// Weighted score over normalized factors, plus recommendation labels. Weights
// are configurable so a fleet manager can prioritise (e.g. downtime urgency).
export const DEFAULT_WEIGHTS = {
  fitment: 0.34,
  landedCost: 0.24,
  delivery: 0.16,
  availability: 0.08,
  seller: 0.08,
  warranty: 0.05,
  returnPolicy: 0.05,
};

const AVAILABILITY_SCORE = { in_stock: 1, low_stock: 0.7, backorder: 0.35, out_of_stock: 0, unknown: 0.5 };

// Score every offer 0..1 (higher = better) and attach recommendation labels.
// `opts`: { weights, oemPreference:'any'|'prefer_oem'|'oem_only', urgencyDays }
export function rankOffers(offers, opts = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };
  const list = offers.map((o) => ({ ...o, total_landed_cents: o.total_landed_cents ?? computeLandedCost(o) }));

  // Only rank offers that aren't hard-incompatible; keep them for display but
  // never recommend. Never silently discard ambiguous offers.
  const rankable = list.filter((o) => o.fitment_confidence !== "incompatible");

  const landedVals = rankable.map((o) => o.total_landed_cents).filter((v) => Number.isFinite(v) && v > 0);
  const minLanded = landedVals.length ? Math.min(...landedVals) : 0;
  const maxLanded = landedVals.length ? Math.max(...landedVals) : 0;
  const deliveryVals = rankable.map((o) => deliveryDays(o)).filter((v) => Number.isFinite(v));
  const minDelivery = deliveryVals.length ? Math.min(...deliveryVals) : 0;
  const maxDelivery = deliveryVals.length ? Math.max(...deliveryVals) : 0;

  for (const o of list) {
    const parts = {};
    parts.fitment = (FITMENT_RANK[o.fitment_confidence] ?? 1) / 5;
    parts.landedCost = norm(o.total_landed_cents, minLanded, maxLanded, true);
    parts.delivery = norm(deliveryDays(o), minDelivery, maxDelivery, true);
    parts.availability = AVAILABILITY_SCORE[o.availability] ?? 0.5;
    parts.seller = Number.isFinite(o.seller_rating) ? clamp01(o.seller_rating / 5) : 0.5;
    parts.warranty = o.warranty && !/none|no warranty/i.test(o.warranty) ? 1 : 0;
    parts.returnPolicy = o.return_policy && !/no returns?/i.test(o.return_policy) ? 1 : 0;

    let score = 0;
    for (const k of Object.keys(weights)) score += (weights[k] || 0) * (parts[k] || 0);

    // OEM preference nudge / gate.
    const isOem = !!o.is_oem;
    if (opts.oemPreference === "oem_only" && !isOem) score = 0;
    else if (opts.oemPreference === "prefer_oem" && isOem) score += 0.05;

    o._rankScore = round2(clamp01(score));
    o._rankParts = parts;
    o._recommendations = [];
  }

  // Recommendation labels — only awarded with a shown rationale.
  labelBest(rankable, "best", (o) => o._rankScore, "Best overall", "highest weighted score");
  labelBest(rankable.filter((o) => Number.isFinite(o.total_landed_cents) && o.total_landed_cents > 0),
    "cheap", (o) => -o.total_landed_cents, "Lowest landed cost", "cheapest total landed cost");
  labelBest(rankable, "fast", (o) => -deliveryDays(o), "Fastest delivery", "soonest delivery");
  labelBest(rankable.filter((o) => o.is_oem), "oem", (o) => o._rankScore, "Best OEM option", "top OEM offer");
  labelBest(rankable.filter((o) => !o.is_oem), "aftermarket", (o) => o._rankScore, "Best aftermarket", "top aftermarket offer");
  labelBest(rankable.filter((o) => lowRisk(o)), "lowrisk", (o) => o._rankScore, "Lowest risk", "high fitment + returnable + warrantied");

  return list.sort((a, b) => {
    // Incompatible always last; then by rank score desc, landed asc.
    const ai = a.fitment_confidence === "incompatible" ? 1 : 0;
    const bi = b.fitment_confidence === "incompatible" ? 1 : 0;
    if (ai !== bi) return ai - bi;
    if ((b._rankScore || 0) !== (a._rankScore || 0)) return (b._rankScore || 0) - (a._rankScore || 0);
    return (a.total_landed_cents || Infinity) - (b.total_landed_cents || Infinity);
  });
}

function labelBest(pool, key, keyFn, label, why) {
  if (!pool.length) return;
  let best = pool[0], bv = keyFn(pool[0]);
  for (const o of pool) { const v = keyFn(o); if (Number.isFinite(v) && v > bv) { bv = v; best = o; } }
  best._recommendations.push({ key, label, why });
}
function lowRisk(o) {
  return (FITMENT_RANK[o.fitment_confidence] ?? 0) >= 4 &&
    o.return_policy && !/no returns?/i.test(o.return_policy) &&
    o.warranty && !/none|no warranty/i.test(o.warranty);
}
function deliveryDays(o) {
  if (Number.isFinite(o.delivery_days_max)) return o.delivery_days_max;
  if (Number.isFinite(o.delivery_days_min)) return o.delivery_days_min;
  return NaN;
}
function norm(v, min, max, invert) {
  if (!Number.isFinite(v) || max === min) return 0.5;
  const t = (v - min) / (max - min);
  return clamp01(invert ? 1 - t : t);
}
function clamp01(v) { return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0)); }

// ── Flags · risk detection over an offer (red states) ──────────────────
// Returns an array of flag ids. `medianLanded` lets us spot suspicious prices.
export function detectOfferFlags(offer, ctx = {}) {
  const flags = [];
  const landed = offer.total_landed_cents ?? computeLandedCost(offer);
  if (offer.fitment_confidence === "incompatible") flags.push("incompatible");
  if (offer.availability === "out_of_stock") flags.push("unavailable");
  if (Number.isFinite(ctx.medianLanded) && ctx.medianLanded > 0 && landed > 0 && landed < ctx.medianLanded * 0.35)
    flags.push("suspicious_price");
  if (offer.source_ts && ctx.nowMs && (ctx.nowMs - Date.parse(offer.source_ts)) > (ctx.staleMs || 7 * 864e5))
    flags.push("stale");
  return flags;
}

// ── Formatting helpers (shared by UI) ──────────────────────────────────
export function formatCents(cents, currency = "USD") {
  if (!Number.isFinite(cents)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}
export function formatDelivery(o) {
  const a = o.delivery_days_min, b = o.delivery_days_max;
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return `${a}–${b} days`;
  const d = Number.isFinite(b) ? b : a;
  if (!Number.isFinite(d)) return "—";
  return d <= 1 ? `${d} day` : `${d} days`;
}
