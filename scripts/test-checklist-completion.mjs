#!/usr/bin/env node
// Contract tests for the checklist completion + timezone rules that
// migration 0436 encodes.
//
//   node scripts/test-checklist-completion.mjs
//
// The real logic lives in Postgres (private.checklist_instance_reconcile,
// private.dsp_today, private.clf_* helpers) and, for the runner UI, in
// dashboard/live.js. There is no DB in CI, so this file pins the *rules* as
// executable specs: the truth table for "is this instance complete?" and the
// "today in the DSP timezone" derivation. If someone changes one side of the
// mirror, these assertions document what the other side still expects.
//
// The completion rule is no longer hand-mirrored here: it's imported from
// dashboard/checklist-core.mjs — the SAME function dashboard/live.js calls —
// so the runner UI and this spec cannot drift (project-review PR#19). The
// timezone/reminder/weekday rules below still mirror Postgres (no importable
// JS source for those).
import assert from "node:assert/strict";
import { isChecklistComplete } from "../dashboard/checklist-core.mjs";

let n = 0;
const ok = (name, got, want) => { n++; assert.deepEqual(got, want, `${name}\n got ${JSON.stringify(got)}\n want ${JSON.stringify(want)}`); };

// ── 1. Completion rule ────────────────────────────────────────────────
// The REAL shared implementation (dashboard/checklist-core.mjs), the same
// one dashboard/live.js calls. These test items use a `done` flag, so tell
// the shared rule to read it — live.js passes `i => !!i.completed_at`. If
// live.js and this spec ever disagree, it's now a code change to one shared
// function, not a silent drift between two copies.
const deriveComplete = (items) => isChecklistComplete(items, (i) => i.done);
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

// ── 3. Due / overdue reminder kind ────────────────────────────────────
// Mirror of the window logic in public.checklist_due_reminders_run
// (migration 0438): past due ⇒ 'overdue'; within p_soon_minutes before
// due ⇒ 'due_soon'; otherwise no reminder; and nothing without a due time.
function reminderKind(dueAtMs, nowMs, soonMinutes) {
  if (dueAtMs == null) return null;
  if (dueAtMs < nowMs) return "overdue";
  if (dueAtMs <= nowMs + soonMinutes * 60000) return "due_soon";
  return null;
}
const NOW = Date.parse("2026-07-07T15:00:00Z");
const MIN = 60000;
ok("past due ⇒ overdue",              reminderKind(NOW - 5 * MIN, NOW, 45), "overdue");
ok("30m before due, 45m window ⇒ due_soon", reminderKind(NOW + 30 * MIN, NOW, 45), "due_soon");
ok("exactly at window edge ⇒ due_soon",     reminderKind(NOW + 45 * MIN, NOW, 45), "due_soon");
ok("beyond window ⇒ no reminder",     reminderKind(NOW + 90 * MIN, NOW, 45), null);
ok("no due time ⇒ no reminder",       reminderKind(null, NOW, 45), null);

// ── 4. Weekly weekday gate ────────────────────────────────────────────
// Mirror of private.clf_in_window's weekly branch (migration 0439): a
// weekly assignment with repeat_rule.weekday set is only in-window on that
// ISO weekday (1=Mon…7=Sun); blank/absent stays every-day.
function weeklyInWindow(weekday, isoDow) {
  const wd = weekday === "" || weekday == null ? null : parseInt(weekday, 10);
  if (wd == null || Number.isNaN(wd)) return true;
  return isoDow === wd;
}
ok("weekly no weekday ⇒ any day",       weeklyInWindow(null, 3), true);
ok("weekly blank weekday ⇒ any day",    weeklyInWindow("", 3), true);
ok("weekly Mon ⇒ visible Monday",       weeklyInWindow(1, 1), true);
ok("weekly Mon ⇒ hidden Wednesday",     weeklyInWindow(1, 3), false);
ok("weekly Sun(7) ⇒ visible Sunday",    weeklyInWindow(7, 7), true);

console.log(`\n✓ checklist completion/timezone/reminder/weekday contract — ${n} assertions passed`);
