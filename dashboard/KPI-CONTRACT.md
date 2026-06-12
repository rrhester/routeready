# RouteReady KPI Design Contract

The **Schedule page KPI strip** (`#rr-sched-kpis .sched-kpi-pills`) is the
permanent master template for every KPI strip in RouteReady. This document
reverse-engineers its design DNA, formalizes it as a token-backed contract,
audits the platform, and records the standardization work.

The contract is **live**: the values below are defined once as `--kpi-*`
tokens in [`app/rr-system.css`](../app/rr-system.css) (the shared design
system loaded by both the dashboard and the driver app) and every KPI strip
consumes them. Change a number there and every strip moves together.

---

## Phase 1 — KPI DNA (measured from the master)

The master is **not** a "big number" strip. It is an Outlook-style row of
**status cells**: one rounded surface card, divided by hairlines into
content-sized cells, each cell = `status dot/icon` + `bold headline` +
`muted sub`. Color is reserved for status; numbers are tabular.

### Layout
| Property | Value | Source token |
|---|---|---|
| Strip container | one card, `display:flex; flex-wrap:wrap; align-items:stretch; gap:0; padding:0; overflow:hidden` | — |
| Card/cell height | **46px** (locked) | `--kpi-height` / `--tcp-kpi-h` |
| Cell width | content-sized (`inline-flex`, no fixed width); strip is full-width; cells wrap | — |
| Internal padding | **12px 24px** | `--kpi-pad-y` / `--kpi-pad-x` |
| Gap between cards | **0** — cells are joined, separated by a 1px divider | — |
| Dot → text gap | **10px** | `--kpi-gap` |
| Divider | 1px right-border between cells (none on last) | `--kpi-divider` |
| Container margin | `0 0 8px` | `--kpi-margin-bottom` |
| Alignment | dot/icon vertically centered against the two-line text block; text left-aligned, stacked | — |
| Radius | **4px** | `--kpi-radius` |
| Elevation | `0 2px 6px rgba(15,23,42,.05), 0 14px 34px rgba(15,23,42,.10)` | `--kpi-shadow` |

### Typography
| Element | Font | Token |
|---|---|---|
| Value / headline (`.sched-kpi-val`) | `600 14px/1.15` Segoe UI Variable, `tabular-nums`, `#111827` | `--kpi-value-font` + `--kpi-text-primary` |
| Sub / label (`.sched-kpi-sub`) | `500 12px/16px`, `#6B7280`, no transform, no tracking | `--kpi-label-font` + `--kpi-text-secondary` |
| Font family | `'Segoe UI Variable','Segoe UI',-apple-system,…` | `--rr-font-family` |

### Color system
| Role | Value | Token |
|---|---|---|
| Surface | `#FFFFFF` | `--kpi-bg` |
| Outer border | `rgba(15,23,42,.22)` | `--kpi-border` |
| Inter-cell divider | `rgba(15,23,42,.18)` | `--kpi-divider` |
| Primary text | `#111827` | `--kpi-text-primary` |
| Secondary text | `#6B7280` | `--kpi-text-secondary` |
| Neutral status dot | `#1E293B` (navy) | `--kpi-dot-neutral` |
| Success | `#16A34A` | `--kpi-success` |
| Warning | `#F59E0B` | `--kpi-warning` |
| Danger | `#DC2626` | `--kpi-danger` |
| Brand | `#2563EB` | `--kpi-brand` |

### Icon / status-indicator system
| Property | Value | Token |
|---|---|---|
| Status dot | **7×7px** circle, `border-radius:50%`, `flex-shrink:0`, background = status color | `--kpi-dot-size` |
| Status icon | **16×16px** SVG (gradient fill, `stroke-width:1`) — *replaces* the dot when a metric is in an alert tier | `--kpi-icon-size` |
| Placement | leading (left of text), vertically centered, `--kpi-gap` to text | — |
| Alert hierarchy | at-rest neutral navy dot → alert red dot (violations / OT flare); tiered status **icon** for graded metrics (green strong → yellow caution → red below target) | — |

### Why it works (visual hierarchy)
- **Eye flow:** left→right; within a cell, the colored dot grabs status first, the bold headline confirms, the muted sub supplies the number.
- **Information hierarchy:** status color (dot) > headline (14/600 dark ink) > sub (12/500 gray).
- **Scan speed:** uniform 46px cells, hairline dividers, and `tabular-nums` give an Outlook command-bar rhythm — the eye lands on a fixed grid.
- **Contrast hierarchy:** one white surface, two ink levels (`#111827` / `#6B7280`), color spent only on meaning → low-noise, "calm, operational."

---

## Phase 2 — KPI Component Specification

Defined once in `app/rr-system.css :root` and consumed everywhere:

```css
/* KPI CONTRACT — reverse-engineered from the Schedule KPI strip */
--kpi-bg:             #FFFFFF;                /* surface-1 */
--kpi-border:         rgba(15,23,42,.22);     /* outer strip border */
--kpi-divider:        rgba(15,23,42,.18);     /* inter-cell hairline */
--kpi-radius:         4px;
--kpi-shadow:         0 2px 6px rgba(15,23,42,.05), 0 14px 34px rgba(15,23,42,.10);
--kpi-height:         46px;                   /* locked cell + strip height */
--kpi-pad-y:          12px;
--kpi-pad-x:          24px;
--kpi-gap:            10px;                    /* dot ↔ text */
--kpi-margin-bottom:  8px;
--kpi-text-primary:   #111827;                /* value */
--kpi-text-secondary: #6B7280;                /* sub / label */
--kpi-value-font:     600 14px/1.15 var(--rr-font-family);
--kpi-label-font:     500 12px/16px var(--rr-font-family);
--kpi-dot-size:       7px;
--kpi-icon-size:      16px;
--kpi-dot-neutral:    #1E293B;
--kpi-success:        #16A34A;
--kpi-warning:        #F59E0B;
--kpi-danger:         #DC2626;
--kpi-brand:          #2563EB;
```

**Anatomy (markup the contract expects):**
```html
<div class="…-kpi-pills">                <!-- strip card -->
  <span class="…-kpi-pill">              <!-- cell -->
    <span class="…-kpi-dot"></span>      <!-- 7px status dot (or 16px icon) -->
    <span class="…-kpi-text">            <!-- flex column -->
      <span class="…-kpi-val">Headline</span>
      <span class="…-kpi-sub">sub / number</span>
    </span>
  </span>
  …
</div>
```

---

## Phase 3 — Platform KPI Audit

> **Specificity note:** on the live Schedule/Roster/Onboarding pages the
> `#view-… .rrx-…` rules in `schedule-rrx.css` win the cascade over the older
> `.sched-kpi-*` base rules in `index.html`. The effective master is therefore
> the rrx values measured above (46px / 12·24 / 10 / 7px / 14·600 / 12·500),
> **not** the legacy `index.html` base block (2px·10 / 6px dot) which is
> overridden on every canonical page.

| Page / strip | Mount | Classes | Status |
|---|---|---|---|
| **Schedule (Week)** | `#rr-sched-kpis` | `.sched-kpi-*` | ✅ **MASTER** |
| Schedule (Requests) | `#rr-sched-kpis` | `.sched-kpi-*` | ✅ canonical (reuses host) |
| Onboarding (Steps / Funnel) | `#rr-ob-kpis` | `.sched-kpi-*` | ✅ canonical (shared selector) |
| Roster (Drivers) | `#rr-roster-kpis` | `.sched-kpi-*` | ✅ canonical (shared selector) |
| Today (mirror) | `#rr-tp-kpis` → schedule host | `.tp-kpi-*` | ✅ canonical on-page (rrx selector forces 7px dot, contract type) |
| **Fleet** | `#rr-fleet-exec-strip` | `.fl-kpi-*` | ⚠️ **drifted → standardized** (was: no shadow, `#E5E7EB` border, 8px dot, `--fs-sm` value) |
| **Workspaces** | `#rr-ws-kpis` | `.ws-kpis` | ⚠️ **drifted → standardized** (was: no shadow, 16px top+bottom margin) |
| Schedule Targets | `#rr-sched-targets-kpis` | `.rr-tgt-kpi-*` | ◑ input-bearing variant — already on the master **container**; cells host numeric inputs (functional, left as-is) |
| Legacy base (`index.html`) | — | `.sched-kpi-*`, `.tp-kpi-*` | ◑ superseded on every canonical page by the rrx rules; left in place to avoid touching non-KPI surfaces |

### Out of contract — by design (not KPI status strips)
These are **different component types**; forcing them into the 46px status-cell
strip would change their structure/content/functionality (forbidden by the
task). Documented as intentional exceptions:

- **Availability detail cards** (`.di-card` / `.di-card-clickable`, Driver
  Detail → Availability): a 4-up grid of clickable **drill-down** cards with a
  large value, caret affordance, and active state. A different pattern (detail
  cards), not a metric strip.
- **Message-Center status chips** (`.rr-mc-stat-*`, driver-thread header):
  app-status indicators with 24px tone-colored icon boxes living in a header,
  not a metric row.
- **Marketing landing grid** (`.hp-kpi-*`, root `index.html`): the public
  marketing site, intentionally on its own brand styling (`Inter Tight`, grid).
  Outside the product app.

---

## Phase 4 — Standardization

All changes are **CSS-only / presentational** — no KPI content, data, RPC, or
functionality changed.

### Files modified
1. **`app/rr-system.css`** — added the `--kpi-*` contract token block to
   `:root` (the new single source of truth).
2. **`dashboard/schedule-rrx.css`** — wired the master strip's container, cell,
   dot, value, icon, and sub rules to the `--kpi-*` tokens (exact equivalents →
   zero visual change). Added explicit `.sched-kpi-val` / `.sched-kpi-icon`
   rules so value typography and icon sizing are contract-governed for all
   strips that share these selectors (Schedule, Roster, Onboarding, Today).
3. **`dashboard/index.html`** —
   - **Fleet** (`.fl-kpi-*`): re-pointed container + cell + dot + line + sub to
     the `--kpi-*` tokens → now pixel-identical to the master (added the
     master shadow, `--kpi-border`/`--kpi-divider`, dot 8px→7px, value
     `--fs-sm`→14px, value weight 700→600, sub→`--kpi-label-font`).
   - **Workspaces** (`.ws-kpis`): added the master shadow, switched border/
     radius/height/margin to the contract tokens (margin `16px 0 16px`→`0 0 8px`).

### Verification
Rendered the master and the standardized Fleet strip against the real shared
stylesheets in a headless browser. Computed styles match exactly:

| | container h / radius / shadow | cell pad / gap / h | value | sub | dot |
|---|---|---|---|---|---|
| Master | 46px / 4px / *2-layer* | 12·24 / 10 / 46 | 14/600/#111827 | 12/500/#6B7280 | 7px |
| Fleet  | 46px / 4px / *2-layer* | 12·24 / 10 / 46 | 14/600/#111827 | 12/500/#6B7280 | 7px |

---

## Confirmation

- ✅ Every **KPI status strip** in the product (Schedule, Requests, Onboarding,
  Roster, Today, **Fleet**, **Workspaces**) now renders from the single
  `--kpi-*` contract — same height, spacing, typography, dot/icon sizing, color
  hierarchy, border, radius, and shadow.
- ✅ The Schedule strip is the permanent master; the contract lives in
  `app/rr-system.css`, so future strips opt in by consuming the tokens and
  cannot drift on the numbers.
- ◑ Three surfaces are intentionally **out of contract** because they are not
  KPI status strips (Availability drill-down cards, Message-Center header
  chips, marketing landing grid) — documented above.
- ✅ No KPI content or functionality changed; presentation only.
