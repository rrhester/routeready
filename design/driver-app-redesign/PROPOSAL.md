# RouteReady Driver App — visual redesign proposal (Phase 1)

**Status: APPROVED 2026-07-13 (calm Revision-1 treatment) — implemented in
Phase 2 on this branch.** This folder remains the design record; nothing in
the app imports it.

- Mockup gallery: `design/driver-app-redesign/index.html`
- Proposed screens (static HTML): `design/driver-app-redesign/screens/`
- Proposed design system (mockup-only CSS): `design/driver-app-redesign/mockups/rr-mobile.css`
- Rendered screenshots: `design/driver-app-redesign/shots/` (proposed) and `shots/current/` (today's app)

---

## 1 · What the Driver App is today

Captured from the real app (`app/`) with stubbed RPC data — see `shots/current/`.

- **Home (`/profile`)** = a ~350 px navy identity hero (greeting, avatar, date)
  followed by independently-streamed floating cards: check-in card, "Report missed
  day", "N tasks to complete" promo, "Up next" shift card, "Van documents" card.
- **Tabs:** Home · Schedule · Tasks · Chat · Team. Settings (with Availability /
  Attendance / Time off inside) hides behind a gear.
- **Lifecycle:** check-in is gated only by time window + geofence. Inspections are
  generic checklists on the Tasks tab — nothing connects them to the shift.
  There is no break state, no check-out readiness, no explicit progression.
- **Language:** already Fluent-ish at the token level (one blue, hairline
  shadows), but the surface is consumer-style: 12–16 px rounded white cards with
  icon tiles floating on gray, one per concern, equal visual weight.

### Critique (what drives the redesign)

1. **Identity-first, not operations-first.** The first fifth of the viewport
   answers none of the driver's morning questions (when / where / what van /
   what's blocking / what's next).
2. **The shift story is fragmented** across 4–5 unrelated cards; the primary
   action scrolls away; nothing shows where you are in the day.
3. **Requirements aren't a system.** "2 tasks to complete · 2 checklists" is a
   vague promo; inspections/forms/acks live in different places with no gating
   or ordering; nothing distinguishes "blocking" from "nice to have".
4. **Urgent comms are transient chat bubbles.** A safety notice that requires
   acknowledgement is just a red-tinted message you can scroll past.
5. **Navigation spends a primary slot on Team** (low frequency) while Settings
   hoards driver-relevant items; Checklists exist both inside Tasks and as a
   separate hub.
6. **Offline is an afterthought** — a floating amber pill that overlaps the hero,
   with queue state buried per-feature.
7. **Visual identity diverges from RouteReady** — the dashboard Schedule page is
   border-driven, dense, tabular, and status-tinted; the app is pillowy, sparse,
   and gradient-accented.

---

## 2 · Design direction: "RouteReady Operational, on a phone"

The dashboard Schedule (rrx / Fluent 2) language, interpreted for one-handed
mobile use — not shrunk:

| Quality | Desktop Schedule | Mobile interpretation |
|---|---|---|
| Surfaces | white on `#f9fafb`, 1 px `#e5e7eb` borders, no card shadows | identical |
| Radius | 6–8 px | 8 px surfaces / 6 px controls (no 12–16 px pillows) |
| Color | one blue `#2563eb`; color only for meaning | identical; navy reserved for brand chrome |
| Status | tinted fill + darker same-hue text + matching border pill | identical pill system |
| Type | Inter, tabular numerals, uppercase micro-labels | identical; 22 px page titles, 28 px hero times |
| Density | compact rows, hairline dividers | 46 px rows, glove-sized 44–50 px controls |
| Elevation | shadow only on floating layers | sticky CTA bar + sheets only |

**Key structural moves**

- **Home becomes "Today"** — a status board + one dominant next action, not a
  feature dashboard.
- **The shift is a visible state machine:** Check in → Inspect → Drive → Check
  out, drawn as a 4-segment progress rail on every Today screen.
- **One sticky action bar** always carries the single most important action for
  the current state (with an honest disabled state + reason line).
- **Requirements become a gated checklist system** — "Before your shift",
  "Before wave departure", "Before you check out" — with blocking/required/
  optional/waiting/overdue semantics and locked items that explain themselves.
- **Messages get an Inbox** — required acknowledgements pinned at top,
  announcements distinct from conversations; urgent = red left-rule notice, not
  a chat bubble.
- **Offline is a first-class state** — header sync chip, full-width strip, a
  "Waiting to sync" section, per-item Pending/Failed/Retry, honest CTA behavior.

---

## 3 · Home-screen concepts (structurally different)

### Concept A — Shift Timeline ("run of show")
Vertical timeline of the entire day (check in → acknowledge → inspect → wave →
drive → check out) with done/current/locked nodes and the current step expanded
inline. Mockup: `screens/16-concept-a-timeline.html`.

### Concept B — Command Center (recommended)
Compact status card (state pill + shift times + progress rail + 4-cell
assignment board + countdown), then exception-driven sections (blockers,
requirements, messages), then a sticky primary action. Mockups: screens 01–07.

### Evaluation

| Criterion | A · Timeline | B · Command center |
|---|---|---|
| Driver speed (glance → answer) | good | **best** — board + pill answer everything above the fold |
| Clarity of lifecycle | **best** — literally drawn | good — compact rail |
| One-handed use | CTA sticky, but list grows tall | **best** — fixed board + sticky CTA |
| Information density | medium (scaffolding costs space) | **high** |
| RouteReady parity | medium (timelines read consumer) | **high** (KPI-strip / grid DNA) |
| Scalability (more requirement types) | weak — every item stretches the spine | **strong** — sections absorb growth |
| Implementation ease | medium | **easier** — sections map to existing RPCs |
| Offline support | equal | equal |
| Full lifecycle support | equal | equal |

**Recommendation: Concept B**, keeping the best of A as the 4-segment progress
rail. The timeline remains viable as a future "day detail" drill-in.

### Revision 1 — the calmer Today (screens 20–22)

Owner feedback on the first pass: *good, but a bit cluttered.* Screens
`20-clean-ready`, `21-clean-onduty`, `22-clean-active` keep the architecture and
halve the furniture — **one focus item, everything else one tap away**:

- 4-cell assignment board → one meta line (`DAU5 · Van V-214 · Wave 9:35 AM`)
- countdown row + location panel → folded into the sticky action bar's note
- rail labels dropped (segments alone carry progress)
- full requirement lists → a single **Next** item + quiet "See all"
- app-bar eyebrow + sync chip removed (sync appears only when not synced)
- active-shift check-out list → one collapsed row ("2 items before check-out")

If this density is preferred it becomes the default treatment across Schedule,
Tasks, and Messages. Blockers (urgent unacknowledged notice, missing van) still
bring their banners back at full strength — calm by default, loud when wrong.

---

## 4 · Navigation proposal

**Current:** Home · Schedule · Tasks · Chat · Team (+ gear → Settings).
**Proposed:** **Today · Schedule · Tasks · Messages · More.**

- **Today** replaces Home/`/profile` (operational, not identity).
- **Messages** replaces Chat: Inbox (acks + announcements) / Dispatch / Channels.
- **Team moves into More** with Profile, Documents (incl. van docs + license),
  Availability, Time off, Attendance, Scan, Settings, Support, Sign out.
- **Checklists' standalone hub is absorbed by Tasks** (completed history lives
  under Tasks → Completed).
- Badges: blue counts for routine, red for urgent/ack-required; badges dim when
  offline. Active tab = blue label + 2 px top indicator (Schedule-page tab DNA).
- Safe areas: tab bar owns the home-indicator inset; sticky CTA sits above it.

Onboarding shell keeps its reduced tab set (Onboarding · Schedule · Messages).

---

## 5 · Proposed component system (Phase-2 build list)

`rr-appbar` (eyebrow + title + sync chip + avatar) · `rr-shiftcard` (state pill,
times, progress rail, assignment board, countdown) · `rr-section` header ·
`rr-panel` + `rr-row` / `rr-kv` · `rr-pill` status set · `rr-notice`
(info/warn/danger left-rule banners) · `rr-cta-bar` (sticky, with reason note) ·
`rr-task-row` (state ring: done/current/locked/alert) · `rr-progress` ·
`rr-seg` (Pass/Fail) · `rr-week-strip` + `rr-shift-row` · message rows ·
`rr-offline-strip` + sync rows · empty states · bottom sheet.

## 6 · Status styles & terminology

| State | Pill | Usage |
|---|---|---|
| Scheduled | navy tint | before check-in window |
| Ready to check in | blue tint | window open |
| On duty | green tint + dot | checked in |
| Check-out · N items left | amber tint | returned, requirements open |
| Complete | green tint + check | checked out |
| Required / Overdue / Failed | red tint | blocking items |
| Due HH:MM / Pending / Rotation | amber tint | attention, sync queue |
| Waiting / Read / 12 items | neutral tint | non-actionable |

Language stays operational and specific: *Check in · Wave departure · Pre-trip
inspection · goes to Fleet · Acknowledge · Saved on this phone · Report missed
day.*

---

## 7 · Screens to consolidate / reorganize (Phase 2)

- `/profile` home → **Today** (check-in card, action-needed promo, up-next, van
  docs absorbed into the state machine + sections).
- `/checklists` hub → merged into Tasks.
- `/team` → More → Team roster.
- Settings items (Availability, Time off, Attendance) → More (top level).
- Chat → Messages with Inbox/Dispatch/Channels; ack-required items pinned.
- Van documents → Today's van row + More → Documents.
- "Report missed day" → quiet link on Today's pre-shift states.

## 8 · Implementation files likely affected later (Phase 2 — NOT touched now)

- `app/app.js` — `renderShell` tab bar; `routes` table (+`/today` alias);
  `renderProfileHub` → Today composition; `renderCheckinCard` state machine UI;
  `renderTasksHub`, `renderChecklistsHub` merge; `renderChat` → Messages inbox;
  `renderSchedule` visual pass; offline banner → strip + sync center.
- `app/styles.css` — new shell/components (or a phased swap to a mobile rrx layer).
- `app/rr-system.css` — mobile component additions to the rrx system.
- `app/index.html` — theme-color if header chrome changes; cache-bust params.
- `app/sw.js` — cache version bump.
- `tests/driver-app/`, `tests/visual/` — selector/baseline updates.
- No database changes required for the visual redesign. (Break tracking and
  server-enforced inspection gating, if adopted, are schema work — flagged as
  open decisions below.)

## 9 · Risks, assumptions, open product decisions

**Risks**
- `app.js` is a 13k-line single file; the shell swap touches every screen's
  container. Mitigation: keep route names + RPC contracts identical; migrate
  screen-by-screen behind the new shell.
- Visual-regression baselines (`tests/visual/`) will churn; plan one deliberate
  re-baseline commit.
- Two-week muscle memory: tab renames (Home→Today, Chat→Messages) need the
  in-app "what changed" note dispatch can reference.

**Assumptions**
- Time-window + geofence remain the only *hard* check-in gates; requirement
  "gating" shown in mockups is presentational ordering, not new server rules.
- Inspection = existing checklist/form data (`yes_no` ≈ Pass/Fail) — no new
  primitives required for the visuals.
- "Wave departure" data exists (`wave_starts_at`, `report_lead_minutes`).

**Open decisions for you**
1. Break tracking (mocked on the active-shift screen) has no backing data today
   — build it in Phase 2, or drop the row?
2. Should pre-trip inspection *hard-block* check-out server-side, or stay a
   strongly-worded soft gate?
3. Header chrome: mockups use a light header (Schedule-ribbon DNA). Keep the
   navy status-bar band (`#16273f`) above it, or go fully light?
4. Check-in confirm: keep the current confirm sheet, or make the sticky CTA
   one-tap (with undo)?
5. "Open shifts / pick up" placement: Schedule (as mocked) vs also on No-shift
   Today (as mocked) — both, or one home?

---

## 10 · Approval gate

Phase 2 (implementation) is **locked** until you explicitly approve a design
direction, e.g. *"The mockups are approved — implement this design."*
