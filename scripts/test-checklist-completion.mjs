#!/usr/bin/env node
// Contract tests for the checklist completion + timezone rules that
// migration 0436 encodes.
//
//   node scripts/test-checklist-completion.mjs
//
// The real logic lives in Postgres (private.checklist_instance_reconcile,
// private.dsp_today, private.clf_* helpers) and, for the runner UI, in a
// mirrored expression in dashboard/live.js. There is no DB in CI, so this
// file pins the *rules* as executable specs: the truth table for "is this
// instance complete?" and the "today in the DSP timezone" derivation.
// If someone changes one side of the mirror, these assertions document
// what the other side still expects.
import assert from "node:assert/strict";

let n = 0;
const ok = (name, got, want) => { n++; assert.deepEqual(got, want, `${name}\n got ${JSON.stringify(got)}\n want ${JSON.stringify(want)}`); };

// ── 1. Completion rule ────────────────────────────────────────────────
// Mirror of private.checklist_instance_reconcile (migration 0436) AND the
// runner's shouldBeCompleted expression (dashboard/live.js). Complete when
// every REQUIRED item is done; with no required items, fall back to "every
// item done"; an empty checklist never completes.
function deriveComplete(items) {
  const required = items.filter((i) => i.required);
  if (required.length > 0) return required.every((i) => i.done);
  return items.length > 0 && items.every((i) => i.done);
}
const R = (done) => ({ required: true,  done });
const O = (done) => ({ required: false, done });

ok("empty checklist never completes",           deriveComplete([]), false);
ok("all required done ⇒ complete",              deriveComplete([R(true), R(true)]), true);
ok("one required outstanding ⇒ not complete",   deriveComplete([R(true), R(false)]), false);
ok("required done, optional not ⇒ complete",    deriveComplete([R(true), O(false)]), true);
// The bug 0436 fixes: an all-optional checklist used to be stuck 'active'
// forever because the old rule required required_count > 0.
ok("all-optional, all done ⇒ complete",         deriveComplete([O(true), O(true)]), true);
ok("all-optional, one open ⇒ not complete",     deriveComplete([O(true), O(false)]), false);
ok("all-optional, none done ⇒ not complete",    deriveComplete([O(false)]), false);
ok("single required done ⇒ complete",           deriveComplete([R(true)]), true);

// ── 2. "Today" in the DSP timezone ────────────────────────────────────
// Mirror of private.dsp_today(dsp_id) = (now() at time zone tz)::date.
// The bug 0436 fixes: driver checklist date logic used the server's UTC
// date, so an evening-in-America timestamp resolved to *tomorrow* — daily
// checklists rolled early and scheduled_today stopped matching.
function dspToday(nowUtcISO, tz) {
  // en-CA formats as YYYY-MM-DD, matching a SQL date cast.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(nowUtcISO));
}

// 02:00Z on Jul 7 is still 22:00 on Jul 6 in New York — the case that
// silently rolled the checklist period a day early under raw current_date.
ok("evening ET resolves to the local (prior) day", dspToday("2026-07-07T02:00:00Z", "America/New_York"), "2026-07-06");
ok("same instant in UTC is already the next day",  dspToday("2026-07-07T02:00:00Z", "UTC"),              "2026-07-07");
ok("midday ET stays the same day",                 dspToday("2026-07-07T16:00:00Z", "America/New_York"), "2026-07-07");
ok("evening PT resolves to the local (prior) day", dspToday("2026-07-07T05:00:00Z", "America/Los_Angeles"), "2026-07-06");

console.log(`\n✓ checklist completion/timezone contract — ${n} assertions passed`);
