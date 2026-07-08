// RouteReady Dispatch · dashboard service worker
//
// ── RECOVERY MODE + FORCED REFRESH ───────────────────────────────
// A prior caching strategy poisoned some operators' browsers with a
// stale MIX of assets across rapid deploys. This worker caches NOTHING
// and PURGES every existing cache the moment it activates, so all
// requests go straight to the network (governed only by the HTTP cache
// headers in _headers — HTML = no-cache; JS/CSS = ?v= versioned).
//
// NEW (forced refresh): on activate we ALSO navigate every open window
// to a fresh copy. An INSTALLED app that's resumed (not cold-launched)
// can sit on a stale shell indefinitely — the no-cache headers never
// get a chance to run because the shell is never re-requested. By
// reloading controlled clients the moment a new worker takes over, a
// deploy reaches even a pinned installed app: the browser fetches the
// new sw.js on launch, this worker activates, wipes caches, and
// navigates the window to the current shell. No DevTools, no incognito,
// no "clear site data" required.
//
// Re-navigation only fires when a NEW worker activates (i.e. when this
// file's bytes change on a deploy), so it cannot loop: the reloaded
// page registers the same worker, finds no update, and nothing else
// fires.

// ── Deploy nonce ─────────────────────────────────────────────────
// Bump this on any CSS/HTML-only deploy that must reach pinned/installed
// apps. sw.js byte-changes are the ONLY trigger for the forced refresh
// below (new worker → activate → purge caches → navigate windows to the
// fresh shell), so a recolor that never touches sw.js can sit invisible
// on a resumed installed app. Bumping forces every open window to the
// current shell on next launch.
//   2026-06-28.10 · Roster: remove Coach-driver toolbar pill; per-row coach icon.
//   2026-06-28.11 · Driver drawer: move Driver's-license section from Credentials to Documents.
//   2026-06-28.12 · Roster: keep the per-row coach menu on-screen (clamp to viewport).
//   2026-06-28.13 · Roster: add a per-row Message-driver icon.
//   2026-06-28.14 · Roster: per-row ⋯ menu (deep-link to record tabs + actions).
//   2026-06-28.15 · Roster: ⋯ tab items open a compact peek popup (one tab, not the full record).
//   2026-06-28.16 · Roster: row click no longer opens the full driver record (use the ⋯ menu).
//   2026-06-28.17 · Schedule: slim right utility rail + slide-out Notes scratchpad.
//   2026-06-28.18 · Schedule: rail flush-top, bookmark icon, push-to-condense, blends with bg.
//   2026-06-28.19 · Schedule: rail shield toggles Operations Health (default hidden); old header toggle removed.
//   2026-06-28.20 · Schedule: rail drops to the grid top; reserve its width so right-edge cells aren't clipped.
//   2026-06-28.21 · Schedule: reliable rail/panel top-sync (grid top); notes panel uses the canvas bg.
//   2026-06-28.22 · Schedule: notes panel goes flat (drop the shadow).
//   2026-06-28.23 · Schedule: rail anchors to the day-header row (true grid top); notes panel bordered all sides.
//   2026-06-28.24 · Schedule: Scratchpad upgraded to a polished Notes & Tasks productivity rail (tabs, rich composer, tasks).
//   2026-06-28.25 · Schedule: split Notes & Tasks into two separate slide-out panels, each with its own rail icon.
//   2026-06-28.26 · Schedule: Google-Calendar-style rail interaction — icon press, yellow ripple, panel slide + content fade.
//   2026-06-28.27 · Schedule: fill in the rail icons (solid Notes bookmark + Tasks tile, matching the shield).
//   2026-06-28.28 · Schedule: anchor the right rail flush with the roster table head (was riding too high on the Roster sub-view).
//   2026-06-28.29 · Schedule: premium V2 polish pass — coverage status card, elevated shift chips + toolbar, softer today wash, calmer hierarchy.
//   2026-06-28.30 · Roster: search now promotes matches to the top (Matches / Other drivers) instead of filtering, so the page stays full.
//   2026-06-28.32 · App Launcher: add an "ADP Sync" item that opens a focused box to connect/sync the DSP with ADP (mock OAuth). (.31 Marketplace reverted.)
//   2026-06-28.33 · ADP Sync goes real: connect/sync via Finch (unified HR API) — finch-* edge functions + 0398 migration; box now talks to the server.
//   2026-06-28.34 · Forms quick-access tab: force pinned/installed apps to the new shell (the forms-tab deploy was HTML/CSS-only and never bumped sw.js, so resumed apps stayed on the pre-feature shell).
//   2026-06-28.35 · ADP Sync: surface Finch's real connect error in the toast (no more generic "not set up"); finch-oauth-start tries both session endpoints.
//   2026-06-28.36 · Force installed/resumed clients to fetch the bumped worker: register with updateViaCache:"none" + active reg.update() on load and on return-to-app, so a deploy reaches pinned apps that never cold-launch (forms tab was never appearing for these clients).
//   2026-06-28.37 · Forms: open the forms slide-out from a Forms icon on the Schedule right-side utility rail (beside Notes/Tasks/Operations Health) instead of a floating tab; the slide-out now lists the operator's REAL forms (live cache) rather than placeholder rows. Floating #rr-forms-tab removed.
//   2026-06-28.38 · Forms: render the Forms panel as the SAME compact rail push-panel as Notes/Tasks (matching width, simple "Forms" + X header, one-at-a-time behavior) instead of the wide full-height detail-drawer with the oversized header. Old #rr-forms-tool-drawer removed; rows restyled to match the Tasks list.
//   2026-06-28.39 · ADP Sync: "Create driver records" — import active ADP employees as onboarding drivers (review count + one-click), matched so existing drivers aren't duplicated.
//   2026-06-28.40 · Roster: restore the per-row phone ("See driver's app view") icon on the active-driver rows — opens the driver-app preview, beside Message/Coach/More; actions column widened for the 4th icon.
//   2026-06-28.41 · Forms: redesign the Schedule rail's Forms panel into a polished "Driver Forms" surface — header + subtitle + primary New Form button, search, trigger filter chips, clean white form cards with soft muted status/requirement badges + monochrome icons, and Showing 1–N pagination (understated Google-Workspace aesthetic; blue reserved for primary action + selected chip).
//   2026-06-28.42 · Form builder: enterprise refresh — collapsible/searchable toolbox with field cards, Build/Logic/Settings/Preview tabs, refined draggable field blocks (type/required badges + hover toolbar + duplicate), document-style header with category chips, accordion properties, live Driver-App preview (phone/tablet/desktop), premium empty state, bottom drop zone, status footer. Conditional logic is a deliberate follow-up.
//   2026-06-28.43 · Form builder V2-a: the Driver-App preview is now a PERMANENT ~320px column on the Build tab (4-column grid: toolbox · canvas · preview · properties; widened modal) with two-way canvas↔preview selection sync (click a preview row to select it; selected field rings in both panes) and Phone/Tablet/Portrait/Landscape device toggles. Properties panel restructured into 5 tabs (Field/Rules/Logic/Style/More). Added an "All changes saved / Unsaved changes" header indicator, plus Copy (copies field JSON to clipboard) and a conditional Logic badge on field blocks. The redundant Preview tab was removed; preview column collapses below ~1100px. Conditional logic ships in V2-b.
//   2026-06-28.44 · Form builder V2-b: conditional logic. The Logic tab is now a real editor — "Always show" vs "Show only if <earlier question> is/is not <value>", with a calm visual rule summary. The Logic badge on a block lights up for real, and the Driver-App preview annotates conditional fields ("Shown when … is Yes"). Stored as an optional field.condition jsonb (no migration). Driver App (app/) enforces it live: hidden conditional fields are not required and not submitted; revealed ones participate normally. (Driver runtime ships via the app/ SW shell-cache bump.)
//   2026-06-28.45 · Form builder: fix drag-and-drop. Reordering a field block now works again — dragging is driven from the ⋮⋮ handle only (the row is no longer draggable=true), so grabbing a disabled preview input, a toolbar button, or a badge can't start or swallow the drag. The toolbox now also supports drag-to-insert: drag a field-type card from the left palette into the canvas (onto a position, the bottom drop zone, or empty canvas) to insert a new field of that type. Click-to-add, the keyboard ▲▼ nudge, selection, and the live preview are unchanged.
//   2026-06-29.46 · Form builder: the Driver preview now renders inside a realistic phone mockup (titanium bezel, dynamic island, status bar) instead of a plain rectangular frame — reusing the marketing iPhone-frame chrome (terms.html/privacy.html), re-scoped as .bdev-* under the preview column. The live form scrolls inside the phone screen; canvas↔preview selection sync and the Phone/Tablet/Portrait/Landscape device toggle are unchanged.
//   2026-06-29.47 · Form builder: keep the Driver-preview phone mockup a FIXED height. Previously the phone grew taller as fields were added and overflowed the modal; now the device fills the preview column's available height (capped per device/orientation) and the form scrolls INSIDE the screen, with the status bar + dynamic island pinned at the top. CSS-only — preview content, selection sync, and the device toggle are unchanged.
//   2026-06-29.48 · Form builder: give the Driver-preview phone a FIXED phone SHAPE so it never looks stubby. The previous fix used flex:1 + max-height, so a short/empty form still shrank the device to its content — an empty "Nothing to preview yet" rendered a squat box. Now each device/orientation has DEFINITE dimensions (explicit width + height; phone portrait ~268×581, a tall ~9:19.5 phone), independent of field count, capped to the column; the .bdev-viewport is the only scroll area and the empty state is centered. Empty and full previews show the identical full-height phone. Tablet + Portrait/Landscape are each definite shapes too. CSS-only.
//   2026-06-29.49 · Form builder: replace the Driver-preview phone mockup with a PLAIN preview panel. The realistic iPhone chrome (titanium bezel, dynamic island, 9:41 status bar, side buttons) is gone; the live driver form now renders inside a clean bordered card (--surface panel, --border hairline, --r-xl radius, subtle shadow). Everything else is preserved: the permanent DRIVER PREVIEW column, the Phone/Tablet/Portrait/Landscape toggle (now resizing the plain panel), live updates, two-way selection sync, the conditional-logic annotation, and the fixed-height card with the form scrolling internally. CSS + markup-trim only.
//   2026-07-05.50 · Workbook: emails/URLs render as clickable hyperlinks; clicking an email opens the RouteReady composer (never Gmail). Force pinned/installed/resumed apps off the stale shell so the new workbook.js (link handling) actually loads — the workbook link work was JS-only and never bumped this nonce, so resumed apps kept the pre-feature bundle and still opened Gmail.
//   2026-07-06.51 · Schedule: add Callout Exposure to the Operations Health side panel. Per-day math — at-risk scheduled drivers (attendance score < 70) vs the cushion (scheduled drivers − required routes); a day is "exposed" only when at-risk drivers outnumber the cushion, otherwise "Covered by +N" / "Covered exactly". Panel shows the worst-day summary; click opens a by-day breakdown. Finalize warns (advisory, non-blocking) when any day is exposed. Grid/day-headers/shift-cards unchanged.
//   2026-07-06.52 · Callout Exposure: the "at-risk" driver is now the roster's High-Risk designation (an active final/termination corrective action), loaded in the schedule render so it's correct without opening the roster first — not the attendance score. Cushion math + panel + finalize warning unchanged.
//   2026-07-06.53 · Callout Exposure: narrow "High Risk" to exactly an active (unresolved) FINAL corrective action (drop termination) per operator definition.
//   2026-07-06.54 · Callout Exposure: recommend + apply a fix. The by-day drill-down now proposes a backup-coverage plan — for each exposed day it picks enough available, low-risk drivers (respecting availability, PTO, max-days) to bring the day back to covered, and an "Apply backups" button creates those shifts (copying the day's real station/wave times). Additive only; re-renders with the new cushion folded in.
//   2026-07-06.55 · Callout Exposure backups: always assign SP (standard parcel) — never inherit an XL/other route type from the day's first shift. Recommendation now honors the enforced Smart Fill rules too: DL valid through the shift date + weekly hour cap, on top of active/PTO/max-days/availability (certs are moot since backups are SP).
//   2026-07-06.56 · Workbook: email links (spreadsheet cells AND rich-text note blocks) now open the RouteReady composer instead of Gmail. Force pinned/installed/resumed apps to the new shell so the new workbook.js actually loads — otherwise a resumed app kept the old bundle and mailto: links still opened Gmail.
//   2026-07-06.57 · Callout Exposure backups: add the last two always-enforced WOC rules — max consecutive working days and min rest between shifts (from get_woc_settings; defaults 6 days / 10h). The recommender now honors every enforced Smart Fill hard gate.
//   2026-07-06.58 · Schedule: remove the Max/day row (Flex Capacity) from the Operations Health side panel, along with its "Max routes/day" drill-down modal and its Flex Capacity entry in the KPI selector. The flex-capacity engine bundle is no longer imported by the dashboard (the edge function is untouched).
//   2026-07-06.59 · Schedule rail: split the combined Checklists / My Tasks panel into two slide-outs, each with its own rail icon — the green check tile now opens Checklists directly, and a new violet circle-check (carrying the open-task badge) opens the personal My Tasks list. The in-panel segmented switcher is gone.
//   2026-07-07.60 · Messages: URLs in chat bodies render as clickable links (driver chat, channels, support threads, orientation chat — dashboard side matches the driver app), and Ctrl+V pastes an image from the clipboard straight into the direct-chat/channel composer as a pending attachment.
//   2026-07-07.61 · My Tasks → team tasks (migration 0432): the rail list is now server-backed (public.team_tasks) so it follows the account to any desktop, and a leader can assign tasks to other leadership via the new "Assign to" picker. My Tasks / Delegated view chips (with open counts), "from X" / "→ X" provenance pills, assignee avatars, realtime per-DSP sync with an in-app popup when a task is assigned to you (no email), one-time import of the old device-local list (backup kept), and a full localStorage fallback until the migration is applied.
//   2026-07-07.62 · My Tasks: tone down the new team-tasks accents per operator — the My Tasks / Delegated switcher becomes flat text tabs with a dark-slate underline on a hairline (no violet pills), "from X" / "→ X" provenance is plain muted text (no pill), and teammate avatars drop the violet tint. CSS-only.
//   2026-07-07.63 · Schedule rail → Driver Forms: the per-card ⋮ button now opens a real Edit / Delete menu (it was a visual-only stub that swallowed the click). Edit reuses the card's existing open-builder path; Delete confirms, calls the same delete_form RPC as the Forms workspace grid, drops the form from the shared live cache, and repaints the panel. Menu dismisses on outside click / Escape, and reuses the checklist panel's dropdown styling.
//   2026-07-07.64 · Team tasks × calendar (migration 0433): open tasks now render as quiet slate chips on their due date across the operations calendar (all-day lane in day/week views, above the pills in month cells, busy dots in year view), gated by a new "Tasks" row in My Calendars. Chips complete in place (small check), click through to the rail Tasks panel, and drag to another day to reschedule (team_task_set_due; works on the localStorage fallback too). The calendar Create → Task dialog gains the leadership "Assign to" picker (parity with the rail form), and tasks due today nudge once per day via the reminder tick (in-app toast + browser notification — no email).
//   2026-07-07.65 · Team tasks accountability (migration 0434): clicking a task opens a detail modal with an activity trail (created / assigned / due changed / completed / reopened / acknowledged, auto-logged by a DB trigger) interleaved with a per-task comment thread. Delegated tasks gain an "Acknowledge — I've got this" action for the assignee, an at-a-glance ✓/● ack indicator on rows, and a realtime in-app notice to the assigner when their task is acknowledged or commented on (no email). Falls back cleanly (rows non-clickable) until the migration is applied.
//   2026-07-07.66 · Team tasks unread messages (migration 0435): tasks with a comment now carry a 💬 count on the row, lit blue with a pip when there's a message you haven't seen, and the My Tasks rail icon shows a small blue unread dot — so a comment left while you were away is flagged persistently instead of only a transient toast. Opening a task marks it read (per-user), and the Delegated view doubles as a "did anyone reply?" inbox. Realtime comment now also refreshes the row badges. No email.
//   2026-07-07.67 · Workbook dashboard: tone down the loud accents per operator. The "Auto-build" / "Ask" / "Auto-build from my data" buttons and the Auto-Insights icon drop the violet→blue gradient and purple glow for a flat, on-brand accent blue; the hero KPI band softens from a tri-colour violet gradient to a quiet single-hue blue; and the AI ask-bar loses its purple-tinted shadow. CSS-only.
//   2026-07-07.68 · Workbook dashboard: drop the redundant "Build your dashboard" empty-state card. An empty dashboard now stays clean — the always-visible top bar (✨ Auto-build · ＋ Add widget) and the "Ask about your data" bar already offer every action the card duplicated.
//   2026-07-07.69 · AI-built dashboards read cleaner + more professional: the auto-build and "Ask" builders now render one restrained brand-blue scorecard system instead of an 8-hue rainbow — KPI numbers go ink (accent lives only in the sparkline + tile edge), charts drop the "vibrant" theme for the curated RouteReady palette, and the hero becomes a refined light header (surface + slim accent edge, ink title) rather than a heavy saturated blue slab.
//   2026-07-07.70 · Recruiting Calendar polish: event blocks now read by calendar/kind so the grid matches the "My calendars" legend — one --ev-hue drives a crisp colored left rail, soft fill, hairline and text (interviews blue, orientations amber, events teal, sessions purple), restoring the accent rail the earlier weight-reduction pass had flattened. Exception statuses keep their alarm colors (no-show red, declined/cancelled gray + strikethrough); pending RSVPs get a dashed rail (week/day) and a hollow ring dot (month). Weekend columns/headers/month cells get a whisper-quiet wash and the today column's blue is lifted. Applies across Week / Work Week / Day / Month / Agenda / all-day lane.
//   2026-07-07.71 · Receipt Ledger (Receipt Intake): the Status column now reliably renders as a colored dropdown — a client-side guard re-applies the data-validation rule to the ledger sheet whenever it's opened (any way), so a ledger created before the rule existed is fixed in place. Adds a "How it works" tab explaining the scanner → ledger → reconcile → delete flow, and a "Delete entry" action in the View Receipt modal. Bumps the nonce so the earlier workbook.js changes (View Receipt cell, template card, delete) actually ship past the service-worker cache.
//   2026-07-07.72 · Workbook template gallery: for now the "New workbook" gallery offers only the Receipt Ledger template (the other templates stay defined so existing workbooks keep their badges, they're just hidden from the picker). CSS/logic only.
//   2026-07-07.73 · Schedule week board "Direction A" maturity pass: the coverage floating card folds into the command bar as a slim inline meter (green/amber/red by state), the red "V" / gold "OT" row dots become quiet soft-fill chips, grid digits go tabular so columns align, and standard shift chips flatten to a hairline with a receded route code so the time leads. CSS in inline-styles.css + a small coverage-meter injection in live.js renderScheduleWeek.
//   2026-07-08.1 · DSP control center (platform admin): world-class redesign of the DSP Account Management view — KPI hero now carries live context lines (new-in-30d, % operating with a utilisation bar, oldest-pending age) plus a control-center band with a prioritised "Needs attention" queue (no-owner / pending-aging / zero-drivers / idle signals, click to focus a DSP) and a Portfolio snapshot (drivers under management + plan-mix bars). The table gains a health dot and a Modules column. New: per-DSP page + feature entitlements — an "Access & modules" drawer lets an admin turn top-level pages (Schedule, Onboarding, Fleet, Workbooks, Messages, Email, Recognition) and in-app features (Notes, Tasks, Checklists, Contacts, Ops Health, Forms, Kudos) on/off for a whole DSP; the dashboard hides the disabled nav items / feature buttons via an injected stylesheet. Backed by migration 0442 (admin_set_dsp_entitlements + admin_list_dsps now returns the entitlement lists).
//   2026-07-08.2 · Schedule week board accessibility: the driver grid now carries WAI-ARIA grid semantics (role=grid/row/columnheader/rowheader/gridcell + per-cell aria-labels), a single roving tabindex with Arrow/Home/End keyboard navigation across day cells, and a keyboard-only assign flow — focus an open-shift chip, press Enter to "pick it up", navigate to a driver-day cell, and press Enter to assign (Escape cancels). Actions are announced via an aria-live region. A keyboard/screen-reader operator can now schedule without a mouse; previously drag-and-drop was the only path. live.js (_rrA11yStampScheduleGrid + keyboard handler in bindSchedWeekNav) + schedule-rrx.css focus/carry styles.
//   2026-07-08.3 · DSP control center — data integrity + drill-down. Signals are now backed by real data: a true dsps.last_seen_at (bumped by touch_dsp_activity() on boot) replaces the newest-teammate-signup proxy behind idle/last-active; the Routes column shows real distinct scheduled route codes for the week instead of a hardcoded 0; and a per-DSP 7-day client-error count feeds a new attention signal + health dot. Clicking a DSP (row "View details" or an attention row) now opens a full profile drawer — usage tiles (drivers / users / routes / errors / last-active / plan), an entitlements summary, the latest support thread with unread count, and recent client errors — with Edit / Manage users / Access & modules / Suspend quick actions. Backed by migration 0443 (touch_dsp_activity, admin_list_dsps gains route_count/error_count_7d/real last-active, admin_dsp_detail gains the profile payload).
//   2026-07-08.4 · Checklists: palette + theming polish for the flag-resolution and compliance-insights drawers — swap the raw #hex accents/reds to the canonical --accent / --red / --border-strong tokens so both drawers track the app theme instead of being hardcoded light, and raise their overlay z-index to the modal convention (9999). live.js (_clfOpenFlags/_clfLoadFlags/_clfOpenInsights/_clfLoadInsights) + view-schedule.frag flags badge.
const SW_DEPLOY_NONCE = "2026-07-08.4";

self.addEventListener("install", () => {
  // Take over as soon as possible so the purge + refresh run without
  // waiting for every dashboard tab to close.
  try { console.log("[rr-sw] installing build", SW_DEPLOY_NONCE); } catch (e) {}
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: "window", includeUncontrolled: true }))
      .then((clients) => {
        clients.forEach((client) => {
          // Reload each open window to the fresh shell. Best-effort —
          // one client that refuses to navigate can't abort the rest.
          try { client.navigate(client.url); } catch (e) { /* ignore */ }
        });
      }),
  );
});

// No fetch handler that responds from cache. Without respondWith the
// browser performs its default network fetch, so nothing is served
// from a Service-Worker cache. (We don't register a fetch listener at
// all — pure pass-through.)

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "rr:skip-waiting") self.skipWaiting();
});
