// ─── adapters/index.js · supplier-adapter registry ─────────────────────────
//
// Central registry the search orchestrator consults. Adapters are matched to
// enabled supplier_sources rows by `key`. New connectors (RockAuto, eBay,
// approved crawlers) register here as they gain approved credentials/terms —
// the core engine and UI never hardcode a supplier.
import { manualAdapter } from "./manual.js";
import { makeAdapter } from "./base.js";

const REGISTRY = new Map();

export function registerAdapter(spec, cfg) {
  REGISTRY.set(spec.key, makeAdapter(spec, cfg || {}));
}

export function getAdapter(key) { return REGISTRY.get(key); }
export function listAdapters() { return Array.from(REGISTRY.values()); }

// Built-in: the always-available manual connector.
registerAdapter(manualAdapter, { rateLimitPerMin: 0 });

// API/crawler adapters (RockAuto, eBay, WorldPac, …) self-register here once
// their credentials + terms review land — kept out of the MVP until then so
// nothing ships that could hit an un-reviewed source.
