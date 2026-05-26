// Ad-hoc constraint index.
//
// Compiles the engine's input ad_hoc_constraints[] into fast-lookup
// structures the hard-rule evaluators can consult during eligibility.
// Templates implemented for the heuristic engine (v1):
//
//   driver_lock_to_day        → pre-assignment pass (step1_5_locks.ts)
//   driver_exclude_from_day   → block when shift's DOW matches
//   date_blackout_driver      → block when shift's date in range
//   driver_pair_forbidden     → block when forbidden partner already
//                               assigned to the same shift_id
//   driver_max_days_override  → tighter cap than the global max_days
//
// Soft hardness is ignored by the heuristic (CP-SAT compiles those into
// penalty terms; v1 of the heuristic only honors hard rules). Unknown
// kinds are silently skipped — forward-compatible with future templates
// the dashboard adds before the heuristic ships compiler support.

import type { AdHocConstraint } from "./types.ts";
import { isValidDate } from "./dates.ts";

export interface AdHocIndex {
  /** driver_id → Set<dow> of forbidden weekdays. */
  excludeFromDay: Map<string, Set<number>>;
  /** driver_id → list of [start, end] ISO date ranges the driver is unavailable. */
  blackouts: Map<string, Array<[string, string]>>;
  /** Symmetric: driver_id → Set<other_driver_id> they can't share a shift with. */
  pairForbidden: Map<string, Set<string>>;
  /** driver_id → tighter per-driver max-days cap. */
  maxDaysOverride: Map<string, number>;
}

const EMPTY: AdHocIndex = Object.freeze({
  excludeFromDay: new Map(),
  blackouts: new Map(),
  pairForbidden: new Map(),
  maxDaysOverride: new Map(),
}) as AdHocIndex;

/** Build a fast-lookup index from the raw ad_hoc_constraints array. */
export function indexAdHoc(constraints: AdHocConstraint[] | undefined): AdHocIndex {
  if (!constraints || constraints.length === 0) return EMPTY;
  const idx: AdHocIndex = {
    excludeFromDay: new Map(),
    blackouts: new Map(),
    pairForbidden: new Map(),
    maxDaysOverride: new Map(),
  };
  for (const c of constraints) {
    if (!c || c.hardness !== "hard") continue;
    const p = c.payload ?? {};
    switch (c.kind) {
      case "driver_exclude_from_day": {
        const did = p.driver_id;
        const dow = p.dow;
        if (typeof did !== "string" || typeof dow !== "number") break;
        if (!Number.isInteger(dow) || dow < 0 || dow > 6) break;
        let set = idx.excludeFromDay.get(did);
        if (!set) { set = new Set(); idx.excludeFromDay.set(did, set); }
        set.add(dow);
        break;
      }
      case "date_blackout_driver": {
        const did = p.driver_id;
        const from = p.date_from;
        const to = p.date_to;
        if (typeof did !== "string") break;
        if (typeof from !== "string" || !isValidDate(from)) break;
        if (typeof to !== "string" || !isValidDate(to)) break;
        if (to < from) break;
        let arr = idx.blackouts.get(did);
        if (!arr) { arr = []; idx.blackouts.set(did, arr); }
        arr.push([from, to]);
        break;
      }
      case "driver_pair_forbidden": {
        const a = p.driver_a;
        const b = p.driver_b;
        if (typeof a !== "string" || typeof b !== "string" || a === b) break;
        let sa = idx.pairForbidden.get(a);
        if (!sa) { sa = new Set(); idx.pairForbidden.set(a, sa); }
        sa.add(b);
        let sb = idx.pairForbidden.get(b);
        if (!sb) { sb = new Set(); idx.pairForbidden.set(b, sb); }
        sb.add(a);
        break;
      }
      case "driver_max_days_override": {
        const did = p.driver_id;
        const cap = p.max_days;
        if (typeof did !== "string" || typeof cap !== "number") break;
        if (!Number.isFinite(cap) || cap < 0) break;
        const intCap = Math.floor(cap);
        // If multiple overrides exist for the same driver, keep the
        // TIGHTEST (lowest) — strictly more conservative.
        const prev = idx.maxDaysOverride.get(did);
        if (prev === undefined || intCap < prev) {
          idx.maxDaysOverride.set(did, intCap);
        }
        break;
      }
      // driver_lock_to_day is handled by step1_5_locks, not here.
      default:
        break;
    }
  }
  return idx;
}

/** True when `iso` falls inside any of the blackout ranges (inclusive). */
export function inBlackoutRange(
  iso: string,
  ranges: Array<[string, string]> | undefined,
): boolean {
  if (!ranges) return false;
  for (const [from, to] of ranges) {
    if (iso >= from && iso <= to) return true;
  }
  return false;
}
