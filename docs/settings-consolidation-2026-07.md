# Settings consolidation plan (2026-07)

Consolidate the standalone **Settings** page — improving it and pushing
each section next to the workflow it governs — while keeping a lean
org-config home. Tracked on branch
`claude/settings-consolidation-dashboard-wkgfly`.

## Guiding principle

The codebase already established the direction. Several settings have
been pulled out of the Settings page and placed behind a **"Rules"**
affordance on the view they control:

- *SMS & messaging* → Onboarding → Funnel ▸ Rules
- *License renewals* → Onboarding → Roster → Licences ▸ Rules
- *Attendance policy* → Onboarding → Roster → Attendance ▸ Rules

Finish that migration. Sort every remaining section into one of two
buckets:

1. **Operational rules** — govern one view's workflow → live on that
   view, behind a gear / "Rules" affordance.
2. **Org identity + account + billing** — belong nowhere else → stay in a
   slim Settings home.

## Current inventory → destination

Source: `dashboard/views/view-settings.frag` (+ the `Portal sync` tab
injected by `dashboard/fleet-sync.js`).

| Section (nav tab) | frag lines | Verdict | Destination |
|---|---|---|---|
| **Workspace** — DSP name, team email, reply email, business address, station code, time zone, weather lat/lng + backfill | 38–174 | Keep (org identity) | Settings home |
| — Password, Two-factor, Export data (inside Workspace) | 133–173 | **Split out** (per-user, not org) | New **Account & security** page (profile popover) |
| **Team** — roles / access / invite | 478–525 | Keep | Settings home |
| **Hiring messages** — SMS/email templates | 527–536 | **Move** | Onboarding → Funnel (next to where messages fire) |
| **Hiring referrals** — KPIs, leaderboard, auto-invite, milestone payouts | 539–737 | **Move** (it's a mini-dashboard, not a settings pane) | Onboarding, own tile/sub-view |
| **Scheduling** — availability rules, fleet auto-assign, always-enforced floor, working-hour limits, pay & OT, self-service, attendance windows, geofences | 190–474 | **Move** (biggest win) | Schedule view, DSP-wide rules drawer |
| **Recognition** — birthday/anniversary/holiday auto-fire toggles | 742–762 | **Move** (message automation) | Near Messages (or a People view) |
| **Billing** — subscription, invoices, payment | 765–792 | Keep | Settings home |
| **Portal sync** (injected) — sync-box setup/health | fleet-sync.js 234+ | **Move** | Fleet (or "Integrations" in Settings home) |

**Net:** Settings collapses from 8 tabs to **Workspace / Team / Billing /
Integrations** (org config only) + a per-user **Account & security** page.

## Wiring facts that make the moves safe

- Scheduling save handlers use **document-level event delegation** keyed on
  element IDs (`#rr-woc-save` live.js:78043, `#rr-pay-save` :78128,
  `#rr-att-windows-save` :64852) and attribute-populated forms
  (`[data-rr-avail-settings]` :49790, `[data-rr-woc-form]`,
  `[data-rr-pay-form]`). Markup can physically relocate **as long as the
  IDs/attributes are preserved** and the populate/prefill functions still
  run when the destination view opens.
- `setSettingsSection(btn)` (live.js) drives tab show/hide via
  `data-set`. Any relocated block must stop depending on it — trigger its
  prefill on the destination view's open instead (mirror
  `_rrPrefillLicenseSettings`, which already fires on both `settings` and
  `schedule` view open — live.js:22173).
- Schedule already has a gear → `#rr-sched-quick-settings-popover` (this
  week's overrides) with an inline **"Advanced settings…"** expander
  (live.js:59525). The DSP-wide rules want a **separate full drawer/sub-
  view**, not that small popover — reuse `loadSchedulingSettings` for
  prefill.
- Referrals **"Save program"** is currently a **mock** (toast only, no
  persistence — frag 706–736). The Time-zone `<select>` (frag 102–107)
  has **no save wiring**. Fix both when their sections are touched.

## Sequencing (each = its own browser-verifiable PR)

1. **Account & security split** — lowest risk, self-contained. Pull
   Password / 2FA / Export data into a new page reached from the profile
   popover; leave Workspace org-only. Verify: profile popover → page
   renders, password + 2FA handlers still fire.
2. **Scheduling → Schedule rules drawer** — highest value. New DSP-wide
   rules drawer on Schedule; relocate the 8 rules groups, preserve every
   ID/attribute, prefill on Schedule open. Verify via `verify` skill
   (Playwright): each save round-trips.
3. **Hiring messages + Referrals → Onboarding** — templates to Funnel,
   Referrals as its own Onboarding tile. Wire Referrals "Save program" to
   a real RPC (needs a migration — paste SQL in chat).
4. **Recognition → Messages** and **Portal sync → Fleet** — smaller moves.
5. **Slim the Settings home** — remove emptied tabs, fix time-zone save,
   fold remaining into Admin if warranted.

## Status

- [x] Recommendation + inventory (this doc)
- [x] **Step 1 — Account & security split** — new `data-set="account"` pane
  holds Password / Two-factor / Export data (moved verbatim from
  Workspace, IDs preserved). Profile popover deep-links via
  `rrOpenAccountSettings()` (defers past `goto`'s Workspace reset). Browser-
  verified with Playwright: nav shows the tab, pane renders all three
  controls, Workspace no longer carries them, deep-link lands. SW nonce
  bumped to `2026-07-19.5`.
- [x] **Step 2 — Scheduling rules drawer** — new "Schedule rules" button on
  the Schedule ribbon opens a slide-over drawer (`#rr-schedrules-drawer`).
  On first open, `_rrScheduleRulesDrawer` (live.js) HOISTS the
  `.settings-section[data-set="scheduling"]` node out of `#view-settings`
  into the drawer body — same DOM node, so every element id + delegated
  save handler (`#rr-woc-save`, `#rr-pay-save`, `#rr-att-windows-save`,
  geofences, self-service toggles) is preserved verbatim. On each open it
  fires the exact loaders the old Settings→Scheduling tab click used
  (`loadAttendancePolicy` / `loadAvailabilityRequests` / woc·pay·pickup·swap
  paints / `loadStationGeofences` / `loadAttendanceWindows`). Settings→
  Scheduling nav tab removed; `gotoSettingsScheduling()` now opens the
  drawer. Drawer CSS is token-only (ratchet held). Browser-verified with
  Playwright: tab gone from Settings, button present, drawer opens on-
  screen, all 8 rule groups render (woc/pay/att-windows/geofences/pickup/
  avail/floor), section left `#view-settings`, close works. SW nonce
  `2026-07-19.6`.
  - **NOTE / reversal:** code comments (`gotoSettingsScheduling`, the
    77873/77888 handlers) show these rules were *previously* moved the
    other way — from a Schedule "Rules" sub-tab INTO Settings→Scheduling.
    This step reverses that placement per the operator's 2026-07-19 request
    to consolidate settings onto the dashboard. Flagged in the PR so it's an
    informed call. Shipped for operator browser QA — NOT auto-merged.
- [~] **Step 3 — Hiring → Onboarding** (split into 3a/3b)
  - [x] **3a — Hiring messages** → Onboarding. New "Edit message templates…"
    button in the Funnel → Rules popover's "SMS & messaging" block opens a
    shared slide-over (`.rr-slideover`, added to inline-styles.css for reuse)
    that HOISTS the `.settings-section[data-set="hiring-messages"]` node out
    of `#view-settings`, preserving `#rr-messages-list` + `loadMessagesTab`
    (fired on each open). Settings→Hiring-messages nav tab removed. Browser-
    verified with Playwright. SW nonce `2026-07-19.7`.
  - [ ] **3b — Referrals** → Onboarding (own tile/sub-view). Blocked on
    wiring the mock "Save program" to a real RPC → needs a migration
    (paste SQL in chat). Not started.
- [~] **Step 4 — Recognition / Portal sync** (split into 4a/4b)
  - [x] **4a — Recognition** → Messages. New Recognition button in the
    Messages header opens the shared slide-over, hoisting the
    `.settings-section[data-set="recognition"]` node out of `#view-settings`
    (loadRecognitionSettings + "Run now" preserved). Settings→Recognition
    nav tab removed. Browser-verified. SW nonce `2026-07-19.8`.
  - [ ] **4b — Portal sync** → Fleet. Different shape: `fleet-sync.js`
    *injects* the section into `#view-settings` at boot, so this is a change
    to the injection target (Fleet view), not a static hoist. Not started.
- [ ] Step 5 — Settings home slim-down (remove emptied nav plumbing, fix
  time-zone select save + referrals mock save)
