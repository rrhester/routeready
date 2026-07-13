#!/usr/bin/env node
// Tests for dashboard/parts/parts-engine.js — the Parts Intelligence math:
// normalization, landed cost, fitment confidence, ranking, flags.
// Run: node scripts/test-parts-engine.mjs (also part of `npm test`).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  computeLandedCost,
  normalizeSide, normalizePosition, normalizeCondition, normalizeCategory,
  normalizePartTerms, canonPartNumber, partNumberIn,
  deriveFitmentSignals, scoreFitment, evaluateFitment,
  rankOffers, detectOfferFlags, DEFAULT_WEIGHTS,
  FITMENT_LABEL, formatCents, formatDelivery,
} from "../dashboard/parts/parts-engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f) => JSON.parse(readFileSync(join(here, "../tests/fixtures/parts", f), "utf8"));
const vehicles = fx("vehicles.json");
const parts = fx("parts.json");
const offers = fx("offers.json");

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; }
  catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// ── Normalization ──────────────────────────────────────────────────────
t("normalizeSide resolves the mirror synonym cluster", () => {
  for (const s of ["Passenger mirror", "Right mirror", "RH mirror", "right-side exterior mirror", "passenger-side mirror assembly"])
    assert.equal(normalizeSide(s), "right", s);
  for (const s of ["Driver mirror", "LH mirror", "left-hand mirror"])
    assert.equal(normalizeSide(s), "left", s);
  assert.equal(normalizeSide("pair of mirrors"), "both");
  assert.equal(normalizeSide("mirror"), null);
});

t("normalizeCondition maps seller terms", () => {
  assert.equal(normalizeCondition("Brand New"), "new");
  assert.equal(normalizeCondition("Remanufactured"), "remanufactured");
  assert.equal(normalizeCondition("rebuilt unit"), "remanufactured");
  assert.equal(normalizeCondition("Refurbished / Renewed"), "refurbished");
  assert.equal(normalizeCondition("Used - OEM take off"), "used");
  assert.equal(normalizeCondition("New Old Stock"), "nos");
  assert.equal(normalizeCondition("core only"), "core");
  assert.equal(normalizeCondition(""), "unknown");
});

t("normalizeCategory + position + full term extraction", () => {
  assert.equal(normalizeCategory("Passenger door mirror assembly"), "mirror");
  assert.equal(normalizeCategory("Front brake pads set"), "brake");
  assert.equal(normalizePosition("front left"), "front");
  const terms = normalizePartTerms("RH front heated power mirror, brand new");
  assert.deepEqual(terms, { category: "mirror", side: "right", position: "front", condition: "new" });
});

t("part number canonicalization is separator-insensitive", () => {
  assert.equal(canonPartNumber("LK4Z-17683-AA"), "LK4Z17683AA");
  assert.equal(canonPartNumber("lk4z 17683 aa"), "LK4Z17683AA");
  assert.ok(partNumberIn("LK4Z 17683 AA", ["LK4Z-17683-AA"]));
  assert.ok(!partNumberIn("XXX", ["LK4Z-17683-AA"]));
});

// ── Landed cost ────────────────────────────────────────────────────────
t("landed cost sums components and subtracts discount", () => {
  assert.equal(computeLandedCost(offers.oem_exact), 18900 + 0 + 1560 + 0 - 0);
  assert.equal(computeLandedCost(offers.reman_used_ymm_only), 9800 + 1850 + 0 + 2500 - 0);
  assert.equal(computeLandedCost({ price_cents: 1000, discount_cents: 300 }), 700);
});
t("landed cost never goes negative and treats missing as 0", () => {
  assert.equal(computeLandedCost({ discount_cents: 500 }), 0);
  assert.equal(computeLandedCost({}), 0);
});

// ── Fitment confidence ─────────────────────────────────────────────────
t("OEM part-number match FOR THE VIN yields Exact", () => {
  const sig = { oemMatchForVin: true, connectorMatch: true, featureMatch: true };
  const r = scoreFitment(sig);
  assert.equal(r.level, "exact");
  assert.ok(r.reasons.some((x) => x.id === "oem_vin"));
});

t("OEM catalog match (no VIN) never exceeds High", () => {
  const r = scoreFitment({ oemMatchCatalog: true, sideMatch: true, connectorMatch: true, featureMatch: true });
  assert.equal(r.level, "high");
});

t("Year/make/model agreement alone can never exceed Likely", () => {
  // Only weak signals (seller claim + side) — must not reach high/exact.
  const r = scoreFitment({ sideMatch: true, sellerClaimsFit: true });
  assert.ok(["likely", "verify"].includes(r.level), `got ${r.level}`);
  assert.notEqual(r.level, "exact");
  assert.notEqual(r.level, "high");
});

t("a required connector conflict forces Incompatible regardless of other evidence", () => {
  const r = scoreFitment({ oemMatchForVin: true, requiredConflicts: ["connector"] });
  assert.equal(r.level, "incompatible");
  assert.equal(r.score, 0);
});

t("manual override wins outright (both directions)", () => {
  assert.equal(scoreFitment({ manualVerified: "exact" }).level, "exact");
  assert.equal(scoreFitment({ manualVerified: "incompatible", oemMatchForVin: true }).level, "incompatible");
});

t("deriveFitmentSignals flags the non-heated 3-pin mirror as a hard conflict", () => {
  const sig = deriveFitmentSignals(vehicles.transit_250, parts.transit_rh_mirror_oem, offers.incompatible_manual);
  assert.equal(sig.connectorMatch, false);
  assert.ok(sig.requiredConflicts.includes("connector"));
  assert.ok(sig.requiredConflicts.includes("missing_heated"));
  const r = scoreFitment(sig);
  assert.equal(r.level, "incompatible");
});

t("evaluateFitment end-to-end: OEM exact offer on matching vehicle", () => {
  const r = evaluateFitment(vehicles.transit_250, parts.transit_rh_mirror_oem, offers.oem_exact,
    { oemMatchForVin: true });
  assert.equal(r.level, "exact");
  assert.ok(r.reasons.length >= 1);
});

t("every fitment level carries at least one reason", () => {
  for (const sig of [{ oemMatchForVin: true }, { oemMatchCatalog: true, connectorMatch: true, featureMatch: true, sideMatch: true }, { sideMatch: true }, {}, { requiredConflicts: ["connector"] }]) {
    const r = scoreFitment(sig);
    assert.ok(r.reasons.length >= 1, `level ${r.level} had no reasons`);
    assert.ok(FITMENT_LABEL[r.level]);
  }
});

// ── Ranking ────────────────────────────────────────────────────────────
function offerSet() {
  return [
    { ...offers.oem_exact, fitment_confidence: "exact", total_landed_cents: computeLandedCost(offers.oem_exact) },
    { ...offers.aftermarket_cheap, fitment_confidence: "high", total_landed_cents: computeLandedCost(offers.aftermarket_cheap) },
    { ...offers.aftermarket_fast, fitment_confidence: "high", total_landed_cents: computeLandedCost(offers.aftermarket_fast) },
    { ...offers.reman_used_ymm_only, fitment_confidence: "likely", total_landed_cents: computeLandedCost(offers.reman_used_ymm_only) },
    { ...offers.incompatible_manual, fitment_confidence: "incompatible", total_landed_cents: computeLandedCost(offers.incompatible_manual) },
  ];
}

t("ranking labels are awarded with a rationale, and incompatible sorts last", () => {
  const ranked = rankOffers(offerSet(), { oemPreference: "prefer_oem" });
  assert.equal(ranked[ranked.length - 1].fitment_confidence, "incompatible");
  const best = ranked.find((o) => o._recommendations.some((r) => r.key === "best"));
  assert.ok(best, "a best-overall was chosen");
  assert.ok(best._recommendations.every((r) => r.why && r.why.length > 0));
});

t("lowest landed and fastest labels land on the right offers", () => {
  const ranked = rankOffers(offerSet());
  const cheap = ranked.find((o) => o._recommendations.some((r) => r.key === "cheap"));
  const fast = ranked.find((o) => o._recommendations.some((r) => r.key === "fast"));
  assert.equal(cheap.seller_part_number, "KS-9920");   // reman is cheapest landed here
  assert.equal(fast.seller_part_number, "TYC-5730151"); // 1-day
});

t("incompatible offers are never recommended but are not discarded", () => {
  const ranked = rankOffers(offerSet());
  assert.equal(ranked.length, 5); // nothing dropped
  const incompat = ranked.find((o) => o.fitment_confidence === "incompatible");
  assert.equal(incompat._recommendations.length, 0);
});

t("oem_only preference zeroes non-OEM offers", () => {
  const ranked = rankOffers(offerSet(), { oemPreference: "oem_only" });
  for (const o of ranked) if (!o.is_oem) assert.equal(o._rankScore, 0);
  assert.ok(ranked[0].is_oem);
});

t("weights are configurable — cranking cost weight favours the cheapest", () => {
  const costHeavy = rankOffers(offerSet(), { weights: { ...DEFAULT_WEIGHTS, landedCost: 0.9, fitment: 0.05 } });
  // Cheapest rankable offer should now be at or near the top (excluding incompatible).
  const topRankable = costHeavy.filter((o) => o.fitment_confidence !== "incompatible")[0];
  assert.equal(topRankable.seller_part_number, "KS-9920");
});

// ── Flags ──────────────────────────────────────────────────────────────
t("suspicious price + unavailable + incompatible flags fire", () => {
  const f = detectOfferFlags({ ...offers.incompatible_manual, fitment_confidence: "incompatible", total_landed_cents: 5198, availability: "out_of_stock" },
    { medianLanded: 20000 });
  assert.ok(f.includes("incompatible"));
  assert.ok(f.includes("unavailable"));
  assert.ok(f.includes("suspicious_price"));
});
t("a normal-priced in-stock offer has no risk flags", () => {
  const f = detectOfferFlags({ ...offers.oem_exact, fitment_confidence: "exact", total_landed_cents: 20460, availability: "in_stock" }, { medianLanded: 20000 });
  assert.deepEqual(f, []);
});

// ── Formatting ─────────────────────────────────────────────────────────
t("formatting helpers", () => {
  assert.equal(formatCents(20460), "$204.60");
  assert.equal(formatCents(null), "—");
  assert.equal(formatDelivery({ delivery_days_min: 2, delivery_days_max: 2 }), "2 days");
  assert.equal(formatDelivery({ delivery_days_min: 1, delivery_days_max: 1 }), "1 day");
  assert.equal(formatDelivery({ delivery_days_min: 2, delivery_days_max: 4 }), "2–4 days");
});

console.log(`✓ parts-engine: ${passed} tests passed`);
