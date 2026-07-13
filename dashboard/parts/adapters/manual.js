// ─── adapters/manual.js · manual supplier-quote connector ──────────────────
//
// The MVP's working "supplier": local vendor quotes a fleet manager enters by
// hand. It performs no network I/O — searchParts returns nothing (offers are
// authored in the UI and persisted via parts_offer_save), but it implements
// the full contract so the orchestrator and health/admin surfaces treat it
// exactly like an API adapter.
export const manualAdapter = {
  key: "manual",
  label: "Manual entries",
  sourceType: "manual",
  async searchParts() { return []; },
  async lookupPartNumber() { return []; },
  // Manual rows are already in the normalized shape the UI builds.
  normalizeOffer(raw) { return raw; },
  async healthCheck() { return { ok: true, latencyMs: 0 }; },
};
