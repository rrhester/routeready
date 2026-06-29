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
const SW_DEPLOY_NONCE = "2026-06-29.46";

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
