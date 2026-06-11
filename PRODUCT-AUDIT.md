# RouteReady — Total Product Audit

> **Scope:** every surface of the RouteReady product — operator dashboard,
> driver PWA, guest/auth flows, marketing + legal pages, and the desktop
> shell. ~221,000 lines reviewed for **total product consistency**.
>
> **Status of this document:** findings + remediation plan only. **No
> product code was changed** in producing it. It is the single source of
> truth for the consistency program, modeled on the existing
> [`dashboard/KPI-CONTRACT.md`](dashboard/KPI-CONTRACT.md) process
> (reverse-engineer the master → tokenize → audit every instance →
> standardize → verify headless → ship).
>
> **Method:** static read of the full tree (CSS, the 18 dashboard view
> fragments, `live.js`, every standalone HTML surface, the design system,
> CI config) plus targeted counts. Every headline number below is grepped,
> not estimated. `file:line` references point at representative evidence,
> not every occurrence.

---

## 0. The one-sentence finding

**RouteReady's consistency problem is not a missing design system — it is a
finished design system that was never adopted.** `app/rr-system.css` is a
complete Microsoft Fluent 2 implementation with a full primitive set
(button, icon-button, card, chip, status-chip, input, search-box, field,
table, data-grid, KPI, modal, drawer, panel, command-bar, toolbar,
filter-bar, segmented, empty-state, skeleton, toast, page-shell, sidebar)
mapping 1:1 to a documented `RR*` component contract. **Only 5 of ~24
product surfaces consume it.** Everything else still runs on one of two
older design eras plus ~1,030 inline `style=""` attributes. "Total
consistency" therefore means *completing a stalled migration*, not
inventing anything new.

---

## 1. Surface inventory

### 1a. Operator dashboard — 18 primary views

Single-page app: `dashboard/index.html` shell + 18 `view-*.frag` fragments,
all driven by `dashboard/live.js` (65,789 lines, ~927 named functions).

| View | Purpose | DS era |
|---|---|---|
| `view-dashboard` | Today's plan, first-run onboarding, KPI overview | **rrx (partial)** |
| `view-schedule` | Weekly roster, smart fill, OKAMI — the product's center of gravity | legacy `.sched-*` + 155 inline styles |
| `view-drivers` | Driver roster, licenses, work-auth, attendance | legacy `.dr-*` |
| `view-onboarding-ops` | Hiring funnel, interview calendar, applicant pipeline | **rrx (partial)** |
| `view-pipeline` | **DEPRECATED** — redirects into onboarding-ops | legacy (dead) |
| `view-recognition` | Birthdays, anniversaries, celebrations | **rrx (partial)** |
| `view-compliance` | Exception rules, violations, sweeps | legacy |
| `view-okami` | 13-week staffing forecast, targets | legacy |
| `view-fleet2` | Vehicles, maintenance, grounding, insurance | legacy `.fl-*` |
| `view-email` | Fleet Bridge team inbox | legacy |
| `view-messages` | Driver chat / channels | legacy `.rr-mc-*` |
| `view-documents` | Reusable PDFs, packets, e-sign | legacy `.docs-*` |
| `view-forms` | Workflows | legacy |
| `view-checklists` | Recurring task boards | legacy |
| `view-workspaces` | Operational boards | legacy `.ws-*` |
| `view-build` | Custom tool builder | legacy + 27 inline styles |
| `view-settings` | Workspace config, team, billing | legacy + **94 inline styles** |
| `view-admin` | Platform DSP management (platform admins) | legacy `.rr-admin-*` |

Plus **25 named modals** and **14 named drawers** defined inline in
`index.html` (not separate fragments) — see §3.

### 1b. Driver PWA — separate silo (intentional)

`app/index.html` + `app/app.js` (8,469 lines) + `app/styles.css` (2,698
lines). Mobile-first, tab-based, own token namespace. Loads
`rr-system.css`. This silo is **intentionally separate** in UX paradigm,
but it forks the brand color (§2).

### 1c. Guest / auth / marketing / legal — ~13 standalone HTML surfaces

| Surface | Audience | DS era / brand blue |
|---|---|---|
| `index.html` (marketing) | public | own Fluent tokens, `#0F6CBD` |
| `download.html`, `installed.html` | operators | ~95% duplicate of marketing tokens |
| `verify.html` | public | **isolated** dashboard palette `#2563EB` |
| `privacy.html`, `terms.html` | public | **separate** palette + DM Serif editorial |
| `dashboard/login.html` | operators | `#2563EB` |
| `dashboard/screening.html` (1,345 ln) | applicants | **unique** `#146EB4` |
| `dashboard/booking.html` | applicants | `#0F6CBD` |
| `dashboard/refer.html` | drivers | `#2563EB` |
| `dashboard/rsvp.html` | drivers | `#0F6CBD` |
| `dashboard/coaching.html` | drivers | `#2563EB` — **orphaned**, no inbound links |
| `dashboard/gcal-callback.html` | system | none (bridge) |

### 1d. Desktop shell

Electron app under `desktop/` (`main.js` 1,653 ln, `agent.js`, `scraper.js`,
`renderer/`). Out of scope for visual consistency but shares the dashboard's
rendered surface. Not audited for chrome here.

---

## 2. The design-system situation (root cause)

**Three eras coexist:**

1. **Legacy dashboard** — `dashboard/inline-styles.css` ("extracted verbatim
   from index.html"), ~149 tokens (`--canvas`, `--text`, `--r-md`, `--s-*`),
   ~500 `.rr-*` classes plus per-view prefixes (`.sched-`, `.dr-`, `.fl-`,
   `.ob-`, `.ws-`, `.docs-`, `.rr-mc-`).
2. **Fluent 2 refactor** — `app/rr-system.css`, 56 canonical `--rr-*` tokens
   + the full `.rrx-*` primitive set. **The intended destination.**
3. **Driver PWA** — `app/styles.css`, ~122 own tokens.

**Hard conflicts (same concept, different values):**

| Concept | Legacy | Fluent 2 | PWA / marketing |
|---|---|---|---|
| Brand blue | `--accent #2563EB` | `--rr-brand-primary #0078D4` | `#0F6CBD` / `#146EB4` |
| Canvas | `--canvas #FEFEFF` | `--rr-bg-canvas #F3F2F1` | — |
| Border | `--border rgba(15,23,42,.20)` | `--rr-border-primary #E1DFDD` | — |
| Radius "medium" | `--r-md 6px` | `--rr-radius-medium 6px` | `--r-md` (12px fallback elsewhere) |

There are **four+ brand blues in production** (`#2563EB`, `#0078D4`,
`#0F6CBD`, `#146EB4`). A user who clicks marketing → login → referral →
booking crosses three of them.

**Adoption scorecard:** `5 / 24` surfaces reference `.rrx-` (verified):
`index.html` shell, `app/index.html`, and the `dashboard`, `onboarding-ops`,
`recognition` view frags — and even those only *partially*. The migration is
~20% started, ~5% complete.

---

## 3. Findings (severity-ordered, with evidence)

Severity: 🔴 critical · 🟠 major · 🟡 moderate · 🔵 minor.

### 🔴 F1 — Token system has no single source of truth
Three token files with duplicate names at different values (§2). Brand
color forked four ways. A single brand change today requires edits in 5+
files and still misses inline styles.
*Evidence:* `app/rr-system.css:104`, `dashboard/inline-styles.css:16-290`,
`app/styles.css:9-124`, `index.html:60`, `dashboard/login.html:13`.

### 🔴 F2 — ~1,030 inline `style=""` attributes bypass tokens entirely
Verified count across `index.html` + the 18 frags. Worst offenders:
`view-schedule.frag` (155), `view-settings.frag` (94), `view-drivers.frag`
(29), `view-build.frag`/`view-okami.frag` (27 each). Every one is an
un-tokenized magic number immune to a global design change.

### 🔴 F3 — 313 distinct hardcoded hex colors in CSS
Verified across `dashboard/*.css` + `app/*.css` (plus more in inline styles
and `live.js` template literals). Route-classification colors (13), text
ramps, borders, and semantic fills are all hand-coded rather than
tokenized.
*Evidence:* `dashboard/inline-styles.css` (945 raw color occurrences).

### 🟠 F4 — `window.goto` router wrapped 9 times (decorator chain)
The single router is re-assigned by 9 different modules, each prepending
side-effects. Control flow is opaque; a change to navigation must thread
through all 9 wrappers.
*Evidence:* `live.js` reassignments at ~2914, 10673, 14461, 35268, 50391,
53223 (`window.goto =` ×9 verified).

### 🟠 F5 — No component abstraction: modals/drawers hand-wired 39 ways
25 modals + 14 drawers each have bespoke `open*/close*/load*/render*`
functions. Three different ways to edit a driver alone
(`modal-add-driver`, `modal-bulk-driver-ingest`, `driver-drawer`). Every
call site defensively guards `if (typeof window.openModal === 'function')`.
A finished `.rrx-modal` / `.rrx-side-drawer` primitive exists and is unused
by the dashboard.
*Evidence:* `live.js:20549` `openDriverDrawer`, `:20256`
`openDriverDetail /* superseded */`, modal opens at 3410/3796/3845/15272.

### 🟠 F6 — Empty / loading / error states are fragmented
≥8 different empty-state class names (`.rr-empty-inline`, `.dr-empty`,
`.rr-intel-empty`, `.onb-notes-empty`, `.onb-chat-empty`, `.wx-empty-text`,
`.docs-empty`, `.ws-empty`). Errors are hand-built `innerHTML` in 50+
places. A `_drEmptyCard()` helper (`live.js:5080`) exists but is used
inconsistently. Loading is sometimes a skeleton (`.ob-sk-tr`), sometimes
`<div class="rr-loading">Loading…</div>`. The DS ships `.rrx-empty-state`
and `.rrx-skeleton` — unused on the dashboard.

### 🟠 F7 — Guest/auth surfaces each re-implement buttons, cards, tokens
`login`, `refer`, `rsvp`, `booking`, `screening`, `verify` each redeclare
`:root` tokens and button/card CSS inline, with divergent padding, radius,
and hover timing. No shared stylesheet links them.
*Evidence:* `index.html:81`, `download.html:81`, `dashboard/rsvp.html:29`,
`dashboard/login.html:25`.

### 🟠 F8 — Semantic colors disagree across surfaces
Success green spans `#107C41 → #16A34A`; error red `#C50F1F → #DC2626`;
warning is sometimes indigo `#6366F1`, sometimes amber `#F59E0B`. Same
status, different color depending on which page you're on.
*Evidence:* `index.html:70`, `dashboard/login.html:30`,
`dashboard/screening.html:26`, `app/styles.css:67`.

### 🟡 F9 — Typography sprawl
75+ distinct `font-size` px values; weights 600 and 700 used
interchangeably for "strong" (739 vs 411 occurrences). Six standardized
`--rr-font-*` composites exist but aren't applied broadly. Legal pages
introduce a serif (DM Serif Display) found nowhere else.

### 🟡 F10 — Radius/spacing namespace soup
Radius referenced via 6 token namespaces (`--r-*`, `--rr-radius-*`,
`--sch-radius`, `--kpi-radius`, `--docs-radius`, `--flu-radius`) with
**conflicting fallbacks** (`var(--r-lg,10px)` vs `var(--r-lg,12px)`).
Spacing split across `--s-*` and `--rr-space-*` plus ~1,239 raw values.

### 🟡 F11 — Dead / superseded code in `live.js`
30 `superseded`/`deprecated`/`_legacy` markers verified. Examples: no-op
stubs `renderRenewalsPanel`, `licResendNow`, `licMarkRenewed`,
`licApplyAll` (`live.js:8948-8951`); `openDriverDetail` (`:20256`);
`_ensureComposerResizeWatch /* deprecated */` (`:25544`). `view-pipeline`
is a whole deprecated view that only redirects.

### 🟡 F12 — 197 `console.*` calls in `live.js`
Verified. Mostly `warn`/`error`, but includes verbose debug
(`assignVans tile click · state=…`, `live.js:37201`). No log-level gating.

### 🟡 F13 — State scattered as 20+ module-level consts
`_admin`, `_driverStage`, `_ivcalView`, etc. live as loose
function/module-scope blocks with no central store — hard to trace, test,
or reset on navigation.
*Evidence:* `live.js:2989`, `:16640`.

### 🟡 F14 — `live.js` is one 65,789-line file
48 `// ── section ──` markers but no module boundaries. This is the single
biggest tax on every future change and the main blocker to deduping F4–F6.

### 🔵 F15 — Orphaned page: `dashboard/coaching.html`
Fully functional, backend-wired, reachable only by deep link `/c/<token>`;
linked from nowhere. Either surface it or document it as link-only.

### 🔵 F16 — No navigation continuity across guest flows
Marketing has nav+footer; `login`/`refer`/`rsvp`/`booking` are isolated
cards with no way back to the product. No breadcrumb/back strategy.

### 🔵 F17 — Asset hygiene
Duplicate/oversized committed binaries at repo root: `header-bg.png`
**and** `header-bg.png.png` (identical 922 KB), plus a 922 KB
`ChatGPT Image …png`. Dead weight in every clone and deploy.

---

## 4. What is already *good* (don't touch by accident)

- `app/rr-system.css` is a genuinely complete, well-documented Fluent 2
  system. It's the destination, not a problem.
- `KPI-CONTRACT.md` proves the standardize-then-tokenize playbook works and
  is the template to scale.
- No `TODO/FIXME/HACK` debt markers anywhere — the code is *stable*, just
  *layered*.
- The `.rrx-` namespacing decision (avoid clobbering ~500 live `.rr-`
  selectors) is sound; migration can proceed page-by-page safely.
- Consistent modal backdrop dismissal pattern; heavy `escapeHtml()`
  discipline on `innerHTML`.

---

## 5. Remediation roadmap (deep refactor, incl. JS)

Sequenced so **every phase is independently shippable and CI-green**.
Guardrails (§6) apply to all. Phases are ordered by leverage-per-risk.

**Phase 0 — Freeze the contract.** Pick the single canonical brand blue
(recommend `#0078D4`, the documented `--rr-brand-primary`) and ratify
`--rr-*` as the *only* token namespace. Add CI lint: fail on new raw hex in
CSS/frags and on new brand-blue literals. *No visual change.*

**Phase 1 — Token unification (CSS-only, pixel-frozen).** Re-point legacy
`--canvas/--text/--border/--r-*/--s-*` and the per-page radius namespaces to
`--rr-*` aliases with exact current values. Regenerate the 4 visual
baselines only where a value legitimately moves. *Mechanical, low risk.*

**Phase 2 — Shared guest/auth stylesheet.** Extract one `tokens.css`/DS
link consumed by `login/refer/rsvp/booking/screening/verify/download/
installed`. Kill the per-page `:root` and button/card duplication (F7, F8).
Collapse the four brand blues to one.

**Phase 3 — Migrate dashboard views to `.rrx-` primitives, view by view.**
One PR per view, in this order (lowest-traffic / least-inline first to build
confidence, then the heavy hitters): admin → workspaces → checklists →
forms → documents → recognition* → compliance → okami → fleet2 → messages →
email → drivers → settings → schedule. Each PR: swap legacy classes for
`.rrx-*`, delete that view's inline styles, regenerate its baseline.

**Phase 4 — Componentize states + overlays (JS).** Introduce
`renderEmptyState()`, `renderErrorState()`, `renderSkeleton()`,
`openModal()/openDrawer()` wrappers backed by the `.rrx-` primitives;
migrate the 39 hand-wired overlays and ≥8 empty-state variants onto them
(F5, F6). This is the JS dedup the audit recommends.

**Phase 5 — Router + state cleanup (JS).** Collapse the 9 `window.goto`
wrappers into one registry (`registerSubNav(view, handler)`); move the 20+
loose state consts into a single `AppState`. Delete the 30 superseded
stubs, the dead `view-pipeline`, and gate the 197 `console.*` behind a debug
flag (F4, F11, F12, F13).

**Phase 6 — Split `live.js`.** With overlays/state/router centralized,
carve the 48 marked sections into domain modules (schedule/, onboarding/,
fleet/, …) behind the existing build. Unblocks everything after it (F14).

**Phase 7 — Hygiene.** Remove `header-bg.png.png` + stray image, surface or
document `coaching.html`, add guest-flow nav continuity (F15–F17).

---

## 6. Guardrails (how this ships without breaking prod)

- **Visual-regression CI** screenshots `login`, `booking`, `dashboard-fleet`,
  `dashboard-schedule` and diffs against `tests/visual/baselines/`. Any
  intended visual change must regenerate and commit baselines in the same
  PR. Pixel-frozen phases (0–1) must produce **no** diff.
- **pre-push smoke gate** (`scripts/smoke-check-live.mjs`) acorn-parses
  `live.js`; never `--no-verify`.
- **One concern per PR**, squash-merge, never merge red — per repo
  convention and `CLAUDE.md`.
- **Headless verify** every visual change (the KPI-contract discipline)
  before merge.
- Expand visual coverage beyond 4 pages before Phase 3 so view migrations
  are actually gated.

---

## 7. Scorecard

| Dimension | State | Severity |
|---|---|---|
| Token source of truth | 3 competing systems, 4 brand blues | 🔴 |
| Inline styles | ~1,030 attributes | 🔴 |
| Hardcoded colors | 313 distinct hex in CSS alone | 🔴 |
| Router architecture | 9 stacked `goto` wrappers | 🟠 |
| Overlay components | 39 hand-wired, DS unused | 🟠 |
| Empty/loading/error | ≥8 variants, no shared component | 🟠 |
| Guest-flow consistency | per-page reimplementation | 🟠 |
| Semantic colors | disagree across surfaces | 🟠 |
| Typography | 75+ sizes, 600/700 mixed | 🟡 |
| Radius/spacing | 6 namespaces, conflicting fallbacks | 🟡 |
| Dead code | 30 markers + dead view | 🟡 |
| Logging | 197 `console.*`, no gating | 🟡 |
| `live.js` size | 65,789 lines, one file | 🟡 |
| DS adoption | **5 / 24 surfaces** | 🔴 |

**Bottom line:** the destination already exists. The work is finishing the
migration — token unification, then a view-by-view `.rrx-` adoption with a
JS dedup of overlays/router/state — shipped in the small, CI-gated
increments this repo is already built for.
