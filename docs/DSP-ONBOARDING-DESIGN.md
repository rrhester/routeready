# RouteReady — DSP Onboarding Design & Implementation Audit

*Senior product architecture + onboarding UX + implementation audit. Codebase-grounded. No code shipped yet — this is the recommendation document.*

---

## 1. Executive summary

**The single most important finding: RouteReady already has a DSP onboarding wizard, and it is thin.**

Migration `0126_dsp_onboarding.sql` plus the `_onb*` controller in `dashboard/live.js` (lines ~4401–4673) implement a real, server-backed, autosaving, resumable 3-step wizard — **Company → Contact → Billing → Activate**. It gates the whole dashboard: when `dsps.status ∈ {pending, onboarding}`, the normal chrome is hidden and `#view-onboarding` takes over (`live.js:319–331`). On completion the DSP flips to `active` and a **first-run "Get RouteReady running" checklist** appears on the dashboard for 14 days (`view-dashboard.frag:8–69`, `live.js:_initFirstRunZone` ~244–299).

So this is **not a greenfield build**. It is an **extension + consolidation** job. The existing wizard captures who the company is and how to bill it — but sets up *none* of the operational data that makes the product usable: no station, no roster, no fleet, no schedule rules, no driver-app invites, no forms. Today a freshly-activated DSP lands on an **empty Schedule view** because `stations` are not auto-seeded and `okami_demand` is empty.

**The recommended shape:** keep the 3-step activation wizard essentially as-is (it is the legal/identity/billing gate), then **replace the passive 14-day first-run banner with an active, persistent "Launch Checklist"** that drives the operational setup (roster → fleet → schedule rules → invite team → invite drivers). Operational setup should be **checklist-driven, resumable, and skippable** — not a giant blocking form. Import beats manual entry; defaults beat questions; a launch-readiness checklist beats forcing every field before access.

**What already exists and is strong (reuse):** the multi-tenant model (`dsps → stations → app_users`, RLS via `private.current_dsp_id()`), the wizard state machine + RPCs, the branded email/SMS queue-and-trigger pipeline, the `invite-team-member` edge function (with an `isOwnerOnboarding` branch already written), the entire driver-app invite/PIN/activation stack (`0052`, `0253`, `send_onboarding_invite`), a **best-in-class client-side roster importer** with a header-synonym field map + availability grammar parser (`live.js` ~21225–22050), and the workbook CSV/XLSX parsing primitives.

**The real gaps (build):** no bulk **vehicle** import (G1 — highest-effort net-new), no **bulk driver-app invite** (G2), no seeding of scheduling/blueprint/checklist defaults on DSP create (G5), the wizard covers only company/contact/billing (G6), and two **overlapping/divergent bulk-driver flows** that must be consolidated first (G7). Plus a handful of missing columns (`legal_name`, `region`, `launch_date`, Amazon program/`transporter_id`) and a fragmented scheduling-policy store.

**Simplest path to build first (Phase 1):** (a) fix the empty-workspace problem by seeding a station + sensible scheduling defaults at DSP creation, (b) turn the first-run banner into a persistent Launch Checklist tied to live head-counts, (c) wire the two highest-value tiles — **Import roster** (reuse the existing importer) and **Add vans**. That alone takes a new DSP from "empty and confusing" to "roster loaded, schedule buildable" — the first aha moment — without a single giant form.

---

## 2. Current-state code / product map

### 2.0 Naming hazard — three different things are called "onboarding"

This trips up everyone. Keep them straight:

| # | Concept | Where | What it is | Relevance |
|---|---|---|---|---|
| **A** | **DSP account onboarding** (this project) | `0126_dsp_onboarding.sql`; `live.js:_onb*`; `#view-onboarding` (index.html 1432–1637); CSS `rr-onb-*` in **`inline-styles.css`** | Company-level activation wizard. `dsps.status` pending→onboarding→active; `onboarding_step ∈ {not_started,company,contact,billing,complete}` | **The thing we extend** |
| **B** | **Driver readiness (post-hire)** | `view-onboarding-ops.frag`; `onboarding-rrx.css`; `onboarding_blueprint` (0178); `driver_onboarding_state` (0179) | Getting a *hired* driver ready to drive (bg check, drug test, I-9, handbook) | Reuse its blueprint engine; **ignore its UI** for account onboarding |
| **C** | **Hiring pipeline (pre-hire)** | `view-pipeline.frag`; `applicants` (0002) | Applicant funnel applied→interviewed→hired | Out of scope |

> ⚠️ The CSS file named `onboarding-rrx.css` styles concept **B** (`#view-onboarding-ops`), **not** the account wizard. The account wizard's styles live in `inline-styles.css` under `rr-onb-*`. A new operational-setup surface should avoid the `onboarding-ops` namespace entirely.

### 2.1 Frontend routing & shell

- **View shell:** `dashboard/index.html` — each module is a `<div class="view" id="view-NAME" data-rr-view-src="views/view-NAME.frag">`. Loader IIFE (`index.html:5054–5098`, `window.__RR_VIEWS_READY`) fetches all `.frag` files in parallel, injects HTML, re-executes inline scripts. `#view-onboarding` is a **non-`.view` full-screen takeover**.
- **Router:** `goto(view)` in `dashboard/mock-wiring.js:271` — toggles `.view.active`, sets `body.dataset.rrActiveView`, updates nav + page title.
- **Nav:** `index.html:489–1131` — `.nav-item[data-view]`; role-filtered (`live.js` ~215–232); admin item hidden except `platform_admin`.
- **Boot / gate:** `live.js:354` loads `window.RR.dsp` (`id, name, short_code, timezone, metadata`). Gate `live.js:319–331`: pending/onboarding + non-admin → `body.dataset.rrOnboarding="1"` + `_mountOnboarding()`.

### 2.2 The existing DSP account wizard (concept A) — reuse & extend

| Piece | Location | What it does |
|---|---|---|
| Markup | `index.html:1432–1637` (`#view-onboarding`) | `.rr-onb-shell`, 3-dot progress rail (`.rr-onb-progress-step[data-rr-onb-step]`), 3 `.rr-onb-card`s, `#rr-onb-success` |
| Controller | `live.js:4420–4673` (`_onb`) | `_onbLoadState` (RPC `onboarding_get_state`), `_onbPaintFromState`, `_onbResumeStep` (resume at first incomplete), `_onbBindHandlers` (500 ms blur-autosave → `onboarding_save_step`), `_onbSubmitStep` (client validation), `_onbActivate` (`onboarding_complete` → reload) |
| Styles | `inline-styles.css` (`rr-onb-*`) | Stepper, cards, save-status, error banner |
| Schema | `0126_dsp_onboarding.sql` | `dsps.onboarding_step`, `onboarded_at`, `activated_at`, `welcome_sent_at`, `billing jsonb`, `owner_*`, `dba`, `business_*`, `support_email` |
| RPCs | `0126` | `onboarding_get_state()` (auto-flips pending→onboarding), `onboarding_save_step(step,payload)` (monotonic), `onboarding_complete(payload)` (→active, idempotent) |

**Step fields today:** *Company* = name, DBA, business address, business phone, support email, timezone (7 US zones). *Contact* = owner name/phone, emergency contact name/phone. *Billing* = plan (read-only), cardholder, card last-4, billing email (placeholder billing).

### 2.3 The first-run checklist (concept A, post-activation) — reuse & upgrade

- **Markup:** `view-dashboard.frag:8–69` — `#rr-firstrun`, welcome banner + 4 `.rr-firstrun-tile[data-fr-step]`: Add drivers, Add vans, Build first week, Invite dispatcher.
- **Controller:** `live.js:_initFirstRunZone` (~244–299) — shown only within 14 days of `dsps.activated_at`; tiles auto-`.done` via live head-count queries on `drivers`/`vehicles`/`shifts`; dismiss persisted to `dsps.metadata.first_run_dismissed_at`.
- **This is the seed of the Launch Checklist.** It already does live completion detection — the exact mechanic we want, just made persistent (until 100 %, not 14 days) and expanded.

### 2.4 Provisioning (how a DSP is born today)

- **Platform-admin console:** `view-admin.frag` (cross-tenant, `platform_admin` only). "Add DSP client" modal (`index.html:2296–2347`): company name, owner name, owner email, phone, plan, address, notes → `admin_create_dsp(...)` (`0124`/`0141`).
- `admin_create_dsp` (`0141`): creates DSP as `pending`, stashes `metadata.pending_owner`, **seeds `screening_questions` + `message_templates` from the template DSP** (`private.template_dsp_id()`). Owner then gets an invite; first login triggers the wizard.
- **No self-serve signup path today** — every DSP is admin-provisioned. `dsps` has **no INSERT RLS policy** ("provisioning is service-role only", `0001`).

### 2.5 Data model (tenancy)

- Root `public.dsps`; `public.stations` (dsp_id, code e.g. `DCA1`, name, timezone); `public.app_users` (id=auth.uid, dsp_id, role `driver<dispatcher<ops<owner<platform_admin`).
- RLS everywhere: `dsp_id = private.current_dsp_id()`; writes on P0 tables gated `is_staff(dsp,'dispatcher')` after `0445`.
- **Two auth worlds:** staff = `auth.users ⇄ app_users` (JWT); drivers = **no auth.users**, opaque tokens in `driver_sessions`, all writes via SECURITY DEFINER RPCs.

### 2.6 Module-by-module setup requirements

| Module | Views / files | Config store | What must exist before it's usable |
|---|---|---|---|
| **Scheduling** | `view-schedule.frag`, `view-build.frag`, `scheduling-engine.js`, `SCHEDULING_PLAN.md` | `scheduling_settings` (per-week: block_hours 10, cushion_pct 10, max_days_per_week 5, waves, tz); `dsps.metadata.scheduling` WOC (max_hours 55, max_consec 6, min_rest 10) via `get/set_woc_settings`; pay/OT; attendance windows | ≥1 **station**, `okami_demand` targets, wave start-times, active drivers w/ availability, **real timezone** (default UTC is wrong) |
| **Attendance / risk** | `view-compliance.frag`; `attendance_risk_all` (0205) | Thresholds **hardcoded** (15%/7%, 90-day); knobs = attendance windows (lead 15/tardy 10/ncns 60) | Shift history to compute against; no weighting to configure |
| **Forms** | `view-forms.frag`; `forms` (0080) | Per-form `fields`/`settings` jsonb; **Install "Vehicle Concerns"** one-click template exists | Nothing ships by default |
| **Checklists (driver)** | `checklist_forms` (0415) | `checklist_forms`/`items`/`assignments` | Nothing ships by default |
| **Documents / intake** | `view-documents.frag`; `document_intake` (0330) | Buckets (private, DSP-path-scoped); reviewer = dispatcher+; inbound email via `webhook-email-inbound` | Templates are null; inbound email address unset |
| **Receipts / scanner** | `receipt_uploads` (0435); on-device PDF in `app/app.js` | Fixed categories (Fuel/Maintenance/…); attach to driver/van/route_date/shift | Bucket exists; nothing to configure |
| **Fleet** | `view-fleet2.frag`; `vehicles` (0186/0213) | `vehicle_upsert` RPC (single only) | — |
| **Driver app** | `app/app.js`; `driver_me` (0393) | `dsps.metadata.request_features` (availability/time-off/questions), entitlements `metadata.disabled_pages/features` (0442), station geofences | Invite path + `request_features` defaults |
| **Forecasting** | `route_forecasts` (0137), `okami_grid` (0025) | route_slots per week, DPR, cushion | Optional demand seeds |

---

## 3. Existing assets RouteReady can reuse

| Asset | Location | Verdict | Why it matters for onboarding |
|---|---|---|---|
| **Wizard state machine + RPCs** | `0126`; `live.js:4420–4673` | **Reuse / extend** | Takeover, stepper, autosave, resume, `pending→active` lifecycle already solved |
| **First-run checklist** | `view-dashboard.frag:8–69`; `live.js:244` | **Upgrade** | Live head-count completion detection = the Launch Checklist engine |
| **Roster importer (field map)** | `live.js` ~21225–22050 (`_bdImportFieldMap`, `parseBulkText`, availability grammar, station-code→id resolution, backfill-upsert) | **Reuse (route through server RPC)** | The crown jewel; header-synonym mapping + "Mon-Fri/MWF/Weekends" parsing is exactly what roster import needs |
| **CSV/XLSX primitives** | `workbook.js` `parseCsv`/`toCsv`/`csvSafe` + dependency-free XLSX parser | **Reuse** | Best-tested parsing layer; foundation for a generic importer |
| **Server bulk driver insert** | `bulk_create_drivers` (0130) | **Reuse / widen** | SECURITY DEFINER, staff-gated, per-row try/catch; template for `bulk_create_vehicles` |
| **`vehicle_upsert` RPC** | `0186/0231/0232/0233` | **Reuse** | Canonical single-van create for "add van" |
| **Driver invite / activation stack** | `0052`, `0253`; `send_onboarding_invite`; `app/app.js` | **Reuse as-is** | Invite code → deep link `/app/?code=` → phone+PIN; SMS-or-email auto-select |
| **`invite-team-member` edge fn** | `functions/invite-team-member` | **Reuse** | Branded owner/team invites; has `isOwnerOnboarding` variant already |
| **Email/SMS pipeline** | `email_messages`/`sms_messages` + `fire_message_send` trigger (0007); `send-email`(Resend)/`send-sms`(Twilio); `render_template` | **Reuse** | Insert queue rows; never call Resend/Twilio directly |
| **Onboarding blueprint engine** | `onboarding_blueprint` (0178); `_OB_DEFAULT_BLUEPRINT` (`live.js` ~8083) | **Reuse** | Configurable default driver-readiness steps |
| **Seed-from-template** | `admin_create_dsp` (0141) | **Extend** | Already seeds screening Qs + templates; extend to seed scheduling/blueprint/checklist defaults |
| **Dual client+server validation** | `app/form-validation.js` + `0439` + shared fixtures | **Reuse pattern** | Model for import/wizard field validation |
| **UI primitives** | `toast`/`toastAction`, `openModal`, `.rr-onb-*` stepper, `.rr-firstrun-*` tiles, `.form-*`, `.btn-*`, admin table + `.rr-admin-empty` empty-state, `#modal-bulk-driver-ingest` | **Reuse** | Full vocabulary for the setup surface — nothing new to invent visually |

---

## 4. Gaps and risks

**Structural gaps (build):**

- **G1 — No bulk vehicle import.** `vehicle_upsert` is single-only; no CSV parser, no field map, no `bulk_create_vehicles`. Highest-effort net-new piece. `fleet-sync.js` only enqueues Amazon sync requests, it does not parse uploads.
- **G2 — No bulk driver-app invite.** `send_onboarding_invite`/`issue_driver_invite` are one-driver-at-a-time. Need an "invite all imported drivers" batch RPC.
- **G5 — Defaults not seeded on create.** `admin_create_dsp` seeds only screening Qs + message templates. No station, no scheduling settings, no blueprint, no checklists. `onboarding_blueprint` self-seeds lazily on first read. **Result: empty, unusable workspace at activation.**
- **G6 — Wizard covers company/contact/billing only.** No station, roster, fleet, team, or schedule steps.
- **G7 — Two divergent bulk-driver flows.** `modal-bulk-drivers` (RPC-backed, 4 fields, status `onboarding`) vs `modal-bulk-driver-ingest` (rich client-insert, wide columns, status `active`). Divergent defaults and validation depth. **Consolidate before building on top**, or onboarding inherits the ambiguity.

**Missing columns / data-model gaps:**

- `dsps` has **no `legal_name`** (only `name` + `dba`), **no `region`/market**, **no `launch_date`/go-live**, **no Amazon program field** (AMZL/RSR/DOT — service *types* exist but describe route categories, not the DSP's program).
- **Station code lives on `stations`, not `dsps`**, and there is **no owner-facing RPC to create the first station** (owner-write RLS only). Onboarding must create a `stations` row.
- `drivers` has **no `transporter_id`**; availability/preferred-days/restrictions are loose `metadata` jsonb, not structured columns.
- **Scheduling policy is fragmented** across `scheduling_settings` (per-week!), `dsps.metadata.scheduling`, and RPC constants — there is no single per-DSP "schedule policy" row. `max_consecutive_days`/`rest_hours`/`hour_cap` live in `metadata`, others per-week.

**UX / friction risks:**

- **Empty-workspace cliff.** Activation → empty Schedule with no explanation. The #1 risk.
- **Timezone footgun.** Wizard captures tz, but `scheduling_settings.timezone` defaults to **UTC** and the **Settings timezone control appears unwired** (`view-settings.frag` — static `<select>`, no id/handler). Daily checklists and shift roll-over depend on DSP-local date.
- **Naming collision** (§2.0) risks a developer wiring the new surface into the wrong view.
- **Too many potential required fields.** Emergency contact, DBA, billing-in-trial are all *asked* today but not *needed* to reach value — they belong in "later."
- **No resume state for operational setup** (only the 3-step wizard resumes). A Launch Checklist must persist progress in `dsps.metadata`.
- **Data-quality risk from import:** the rich importer inserts drivers as `active` directly from the client with no server defense-in-depth — bad rows become bad schedule candidates. Route through a validating server RPC.
- **No audit trail** for onboarding actions (who imported what, when). Consider `metadata.onboarding_log` or reuse `client_errors`/team-task events patterns.

---

## 5. Recommended onboarding funnel

Two distinct phases with a hard line between them:

**Phase I — Activation gate (blocking, ~2 min):** identity + billing. This is the existing 3-step wizard, lightly trimmed. Nothing operational here.

**Phase II — Launch setup (non-blocking, resumable, checklist-driven):** the operational data. The user reaches the dashboard immediately after Phase I and completes Phase II at their own pace via a persistent Launch Checklist. Each item deep-links into the real module (roster, fleet, schedule settings) rather than a bespoke onboarding form — so the data they enter is production data, edited in the tool they'll use forever.

### Stage-by-stage

| # | Stage | Blocking? | RouteReady needs | Required | Optional / skip | Import? | Infer / default | Feeds | After step |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **Welcome / account** | — | Provisioned by admin (or future self-serve) | owner email | — | — | plan=starter, status=pending | `dsps`, `app_users` | Magic-link → wizard |
| 2 | **DSP profile** (Company step) | ✅ | name, timezone, address | name, timezone | DBA, support email, business phone | — | tz→scheduling; short_code from admin | `dsps` | Autosave → Contact |
| 3 | **Station & operation** *(NEW in wizard)* | ✅ (1 station) | station code(s), operating days, wave start times | ≥1 station code | 2nd station, peak routes | — | days=Mon–Sat; waves from tz; typical routes | `stations`, `scheduling_settings`, `okami_demand` | Seeds a usable schedule week |
| 4 | **Team / admins** | skip | admin names + emails + roles | — (owner already exists) | dispatchers/ops | — | role=dispatcher | `app_users` via `invite-team-member` | Invites queued |
| 5 | **Driver roster import** | skip (checklist) | driver list | name (+phone to invite) | email, certs, availability, DL, status | ✅ **CSV/paste** | status, hire_date=today | `drivers` via widened bulk RPC | Roster loaded ✅ |
| 6 | **Certs & availability** | skip | per-driver DOT/XL/EDV, availability | — | all | ✅ (in roster file) | certs=false; avail=all-days | `drivers` (certs, `metadata.availability`) | Smart Fill has candidates |
| 7 | **Fleet import** | skip (checklist) | van list | van name/number | VIN, plate, type, ownership, odometer | ✅ **CSV/paste** *(G1 build)* | kind=van, status=active, ownership=dsp_owned | `vehicles` via new bulk RPC | Fleet loaded ✅ |
| 8 | **Schedule rules** | skip | staffing prefs | — | max days/consec, rest, hour cap, cushion | — | 5 / 6 / 10h / 55h / 10% | `scheduling_settings`, `metadata.scheduling` | First schedule buildable ✅ |
| 9 | **Attendance / risk** | skip | attendance windows | — | lead/tardy/ncns | — | 15 / 10 / 60 min | `dsps.metadata` | Risk forecast ready |
| 10 | **Driver app invites** | skip (checklist) | which drivers to invite | — | select subset | — | invite all with phone | `driver_invite_codes` via batch RPC *(G2 build)* | Drivers can log in ✅ |
| 11 | **Forms / checklists** | skip | enable defaults | — | which forms | — | install Vehicle Concerns + daily DVIC | `forms`, `checklist_forms` | Drivers see day-1 tasks |
| 12 | **Scanner / documents** | skip | intake prefs | — | inbound email, reviewer | — | reviewer=owner; buckets exist | `document_intake` | Intake ready |
| 13 | **Launch checklist** | — | (roll-up of 3–12) | — | — | — | live head-counts | dashboard | Shows % ready |
| 14 | **First recommended action** | — | — | — | — | — | "Build this week's schedule" | Schedule | **Aha moment** |

**Friction/simplify notes per stage** are folded into §6/§9. The governing rule: **only stages 2 and 3 block** (identity + one station, because scheduling is dead without a station). Everything else is a Launch Checklist item the owner can do now, later, or never.

---

## 6. Recommended onboarding form structure

Do **not** build one form. Build **two surfaces**:

1. **Activation wizard (extend existing `#view-onboarding`)** — 3 short steps, blocking, ≤2 min. Add **one** new step: *Station & Operation* (between Company and Contact) so a usable schedule seed exists at activation. Keep autosave + resume.

2. **Launch Checklist (upgrade `#rr-firstrun`)** — a persistent dashboard card, each row deep-linking to the real module, with live completion detection. Progress persisted in `dsps.metadata.onboarding.launch` so it survives sessions and never blocks access.

**Wizard step order (revised):** Company → **Station & Operation (new)** → Contact → Billing → Activate.
**Launch Checklist rows:** Import roster · Add vans · Set schedule rules · Invite your team · Invite drivers to the app · Turn on forms · Build your first week.

Progressive disclosure everywhere: each checklist row opens the existing module drawer/modal (e.g. `#modal-bulk-driver-ingest`, `openFleetDrawer`, Settings→Scheduling), pre-scoped to the onboarding task. No new mega-forms.

---

## 7. Required field table (shown during initial onboarding)

Only these gate progress. Everything is either already-provisioned, or has a safe default.

| Step | Field | Type | Req | Default | Validation | Table.field | Module | Helper text |
|---|---|---|---|---|---|---|---|---|
| Company | DSP name | text | ✅ | — | non-empty, ≤120 | `dsps.name` | All | "Your company name as it should appear in RouteReady." |
| Company | Time zone | select | ✅ | `America/New_York` | IANA tz | `dsps.timezone` (+ propagate to `scheduling_settings.timezone`, `metadata.scheduling.tz`) | Scheduling, driver app | "We use this for schedules, check-ins, and daily task roll-over." |
| Company | Business address | text | ✅ | — | non-empty | `dsps.business_address` (+ `dsps.address`) | Docs, billing | "Used on documents and invoices." |
| Station | Amazon station code | text | ✅ | — | `^[A-Z0-9]{3,5}$` | `stations.code` | Scheduling, geofence, driver app | "Your delivery station, e.g. DCA1. You can add more later." |
| Station | Operating days | multiselect | ✅ | Mon–Sat | ≥1 day | `scheduling_settings.waves`/demand seed | Scheduling | "Days you dispatch. Sets your default week." |
| Station | First wave start time | time | ✅ | 10:15 | valid time | `scheduling_settings.waves[0].start` | Scheduling | "Your main dispatch start time. Add more waves later." |
| Contact | Owner name | text | ✅ | (from provisioning) | non-empty | `dsps.owner_name` | Account | "Primary owner/operator." |
| Billing | Cardholder + last-4 | text | ✅* | — | last-4 numeric | `dsps.billing` jsonb | Billing | *Trial-only placeholder; can be deferred if starting a free trial. |

> **Owner email / admin email** are captured at provisioning (`admin_create_dsp` / future self-serve signup), not re-asked in the wizard. **Short_code** is set by admin at creation; onboarding should let the owner confirm/edit it in Settings, not force it in the wizard.

---

## 8. Optional / advanced field table (default or move to settings)

| Category | Field | Type | Default | Where it belongs | Table.field | Notes |
|---|---|---|---|---|---|---|
| Company | Legal business name | text | = DSP name | Advanced (add column) | `dsps.legal_name` *(new)* | Only if billing/legal needs it |
| Company | DBA | text | — | Wizard (optional) | `dsps.dba` | Exists |
| Company | Support email / business phone | text | — | Wizard (optional) | `dsps.support_email`, `business_phone` | Exists |
| Company | Operating region / market | text | — | Advanced (add column) | `dsps.region` *(new)* | Nice-to-have |
| Company | Desired go-live date | date | — | Wizard (optional) | `dsps.launch_date` *(new)* | Drives a countdown, not required |
| Contact | Emergency contact | text | — | **Move to Settings** | `dsps.emergency_contact_*` | Not needed to reach value |
| Operation | Peak route count | number | typical×1.5 | Settings→Scheduling | `okami_demand`/forecast | Inferable |
| Operation | Standard shift length | number | 10 | Settings→Scheduling | `scheduling_settings.default_block_hours` | Default good |
| Operation | Cushion % | number | 10 | Settings→Scheduling | `scheduling_settings.cushion_pct` | Default good |
| Operation | Lunch deduction | toggle/number | 0.5h | Settings→Scheduling | `metadata.scheduling` | Default |
| Operation | Service types run (SP/XL/EDV/DOT) | multiselect | SP active | Wizard station step (optional) | `service_types.active` | Auto-seeded; activate the rest |
| Scheduling | Max days/week | number | 5 | Settings→Scheduling | `scheduling_settings.max_days_per_week` | Default |
| Scheduling | Max consecutive days | number | 6 | Settings→Scheduling | `metadata.scheduling.max_consecutive_days` | Default |
| Scheduling | Min rest (h) | number | 10 | Settings→Scheduling | `metadata.scheduling.min_rest_hours` | Default |
| Scheduling | Weekly hour cap | number | 55 | Settings→Scheduling | `metadata.scheduling.max_hours_per_week` | Default |
| Scheduling | Allow 5th day / stability pref | toggle | on / stable | Settings→Scheduling | `metadata.scheduling` | Default |
| Scheduling | Smart Fill vs manual | toggle | Smart Fill | Settings→Scheduling | engine mode | Default |
| Scheduling | Same vs flexible weekly | toggle | flexible | Settings→Scheduling | `scheduling_settings` per-week | Default |
| Roster | first/last/full name | text | — | Import | `drivers.*` | Required=name only |
| Roster | phone | text | — | Import | `drivers.phone` | Needed to invite |
| Roster | email | text | — | Import | `drivers.email` | Optional |
| Roster | DOT/XL/EDV certified | bool | false | Import | `drivers.dot_/xl_/edv_certified` | Import can set |
| Roster | availability / preferred days | text→jsonb | all days | Import | `drivers.metadata.availability` | Grammar parser exists |
| Roster | employment status | enum | onboarding/active | Import | `drivers.status` | **Pick one convention (G7)** |
| Roster | transporter_id | text | — | Advanced (add column) | `drivers.transporter_id` *(new)* | Amazon ID |
| Fleet | van name/number | text | — | Import | `vehicles.name` | Required |
| Fleet | VIN / plate / plate_state | text | — | Import | `vehicles.vin/plate/plate_state` | Optional |
| Fleet | type | enum | van | Import | `vehicles.van_type`/`kind` | edv/step_van/cargo_van/box_truck |
| Fleet | ownership/rental | enum | dsp_owned | Import | `vehicles.ownership` | amazon/dsp/rental/leased |
| Fleet | odometer | number | — | Import | `vehicles.mileage` | Optional |
| Fleet | maintenance tracking | toggle | on | Settings→Fleet | `fleet_settings` | Default |
| Driver app | can update availability | toggle | on | Settings | `metadata.request_features` | Default |
| Driver app | complete checklists / upload docs / receipts | toggle | on | Settings | `metadata.request_features` / entitlements | Default |
| Forms | enable default checklists | toggle | on | Launch checklist | `checklist_forms` | Install DVIC + Vehicle Concerns |
| Scanner | receipt/document scanning | toggle | on | Settings | buckets exist | Default |
| Scanner | who reviews | select | owner | Settings | reviewer role | Default dispatcher+ |
| Scanner | upload categories / attach-to | (fixed) | Fuel/Maint/… ; driver/van/shift | — | `receipt_uploads` | Fixed defaults, no setup |
| Attendance | lead/tardy/ncns windows | number | 15/10/60 | Settings→Scheduling | `metadata` | Defaults good |

---

## 9. UX recommendation

**Pattern: hybrid — full-screen wizard for activation, persistent dashboard checklist for setup.** This matches what already exists and keeps the tool honest and calm.

- **Activation = full-screen takeover** (existing `#view-onboarding`). Blocking, minimal, ~2 min. Right because identity/billing must precede workspace access and it's short.
- **Operational setup = persistent dashboard Launch Checklist** (upgraded `#rr-firstrun`). Non-blocking, resumable, each row deep-links into the real module. Right because it lets a busy owner reach value immediately and finish at their pace, and because the data they enter is production data in the real tool.

**Answers to the specific UX questions:**

- **First screen copy:** *"Welcome to RouteReady. Let's get your workspace ready — this takes about two minutes."* Calm, no exclamation-mark energy.
- **Step count:** Wizard = **4** (Company · Station · Contact · Billing). Launch Checklist = **7** rows.
- **Progress indicator:** Wizard = the existing 3→4-dot rail (`.rr-onb-progress-step`). Checklist = a thin **"X of 7 complete"** bar + per-row check states (reuse `.rr-firstrun-tile.done`). No confetti, no big percentages.
- **"Skip for now":** bottom-left of every non-blocking wizard step and implicit on every checklist row (a row is skippable by simply not doing it).
- **"Finish later":** the wizard's existing **"Save & sign out"** stays; the checklist persists automatically — no explicit control needed.
- **Showing incomplete setup later:** a quiet **"Finish setup (X of 7)"** chip in the top-right header next to the workspace name, visible until 100 %. Clicking scrolls to the Launch Checklist. Also surfaced as the checklist card on the dashboard.
- **Where setup status lives:** **header chip + dashboard card.** Not buried in Settings. Settings is where you *edit* the underlying config forever; the checklist is the *first-time nudge*.
- **On completion:** checklist collapses to a one-line "Setup complete ✓" that auto-dismisses after a few sessions; header chip disappears.
- **First aha moment:** **"Build this week's schedule"** — with roster + one station + defaults seeded, the owner clicks once and sees a filled schedule grid. That is the product proving itself.
- **What the owner sees first after onboarding:** the **Schedule view** (the app's default `active` view) with the Launch Checklist card pinned at top and a single primary CTA: *Build this week*.

**Simplest version first:** extend the wizard by one step (Station), seed defaults at creation, make the existing first-run banner persistent, and wire two checklist rows (Import roster, Add vans). **Best-in-class version:** add bulk fleet import + column-mapping preview, bulk driver-app invite, service-type activation, default forms/checklists install, a live launch-readiness score, and an inbound-email/scanner setup row — all as additional checklist rows, none blocking.

**Tone guardrails:** greys and one restrained accent (reuse `--rr-*` tokens and Fluent-2 rebind already in `inline-styles.css`/`schedule-rrx.css`); no illustration mascots, no animation beyond the existing subtle transitions; enterprise, operational, quiet.

---

## 10. Launch-readiness checklist (definition of "ready")

Each item auto-detected via live query (extend `_initFirstRunZone`'s pattern). Persist in `dsps.metadata.onboarding.launch`.

| Item | "Done" when | Detection |
|---|---|---|
| DSP profile complete | name + timezone + ≥1 station | `dsps` + `stations` |
| Roster loaded | `count(drivers where status≠terminated) ≥ 1` | `drivers` |
| Fleet loaded | `count(vehicles where archived_at is null) ≥ 1` | `vehicles` |
| Scheduling rules configured | `scheduling_settings` row for current/future week exists | `scheduling_settings` |
| Team invited (optional) | `count(app_users where role≥dispatcher) ≥ 2` | `app_users` |
| Driver app invites ready | `count(driver_invite_codes active) ≥ 1` | `driver_invite_codes` |
| Forms/checklists enabled | ≥1 active `checklist_forms` **or** ≥1 published form | `checklist_forms`/`forms` |
| Scanner categories configured | buckets present (always true) + reviewer set | config |
| First schedule ready to build | ≥1 station + ≥1 active driver + settings | derived |
| Risk forecast ready to view | ≥1 completed shift in window | `shifts` |

Minimum "launch-ready" = profile + roster + scheduling rules + first-schedule-buildable. The rest are green-stars, not gates.

---

## 11. Implementation phases

### Phase 1 — Minimum viable onboarding *(Complexity: Medium)*
- **Goal:** New DSP is never empty; reaches "roster loaded, schedule buildable" without a mega-form.
- **Files:** `0126`-style new migration (seed defaults + station RPC); `admin_create_dsp` (0141, extend); `live.js` (`_onb*` add Station step, `_initFirstRunZone`→persistent checklist); `index.html` (`#view-onboarding` new card; header setup chip); `view-dashboard.frag` (checklist card); `inline-styles.css`.
- **DB changes:** `station_create_self(code,name)` owner RPC (fills the missing self-serve station gap); seed `scheduling_settings` + `okami_demand` + activate default service type + set real timezone on DSP create; add `dsps.metadata.onboarding.launch` persistence. Optionally add `dsps.legal_name/region/launch_date` columns.
- **Components:** wizard Station step; persistent Launch Checklist; header "Finish setup" chip; wire "Import roster" row → existing `#modal-bulk-driver-ingest`.
- **Acceptance:** brand-new DSP → wizard (4 steps) → dashboard with a station, sensible defaults, non-empty schedule scaffold, and a live Launch Checklist that survives reload/sign-out.
- **QA:** create pending DSP → sign in → complete wizard → verify station row, `scheduling_settings` seeded with DSP tz (not UTC), checklist renders + persists.
- **Edge cases:** multi-station DSP; duplicate short_code; owner refreshes mid-wizard (resume); already-active/backfilled DSP must **not** see the wizard.

### Phase 2 — Import & validation improvements *(Complexity: High)*
- **Goal:** One trustworthy importer for roster **and** fleet, server-validated.
- **Files:** `workbook.js` (parseCsv/XLSX — reuse); `live.js` (consolidate G7: retire `modal-bulk-drivers`, keep `#modal-bulk-driver-ingest` field map, route through RPC); new `bulk_create_vehicles` migration (G1, mirror `bulk_create_drivers`).
- **DB:** widen `bulk_create_drivers` column set; add `bulk_create_vehicles(p_rows jsonb)` (staff-gated, per-row try/catch, dedupe by name/VIN); add `drivers.transporter_id`.
- **Components:** column-mapping preview modal (headers → canonical fields), row-level error surfacing, "download template CSV."
- **Acceptance:** paste/upload a messy roster or fleet CSV → mapped preview → server insert with per-row results; drivers land with **one** consistent status convention.
- **QA:** synonym headers, "Mon-Fri"/"MWF" availability, station-code resolution, VIN dedupe, injection-safe CSV.
- **Edge cases:** partial failures, existing-driver backfill (never overwrite), 2000-row cap messaging.

### Phase 3 — Driver-app invitation flow *(Complexity: Medium)*
- **Goal:** "Invite all imported drivers" in one action.
- **Files:** new batch RPC (wrap `send_onboarding_invite`); `live.js` checklist row + selection UI; `app/app.js` (already handles `?code=`).
- **DB:** `bulk_send_onboarding_invites(driver_ids uuid[])` (G2) — mints codes, queues SMS-or-email via existing pipeline; returns per-driver result.
- **Acceptance:** select imported drivers → invites queued → codes issued → deep links delivered.
- **QA:** driver with no phone (falls back to email / flagged), re-invite revokes prior code, rate limits.
- **Edge cases:** drivers without phone or email; already-activated drivers skipped.

### Phase 4 — Launch checklist & setup health *(Complexity: Low–Medium)*
- **Goal:** Live readiness signal + gentle nudges.
- **Files:** `live.js` (detection queries per §10), header chip, dashboard card; optional `send-email` onboarding digest (G3).
- **DB:** none (read-only detection) beyond `metadata.onboarding.launch`.
- **Acceptance:** each item flips green on real data; 100 % collapses the card; chip hides.
- **QA:** each detector true/false transition; persistence across sessions/devices.
- **Edge cases:** items completed outside onboarding (e.g. a driver added weeks later) still reconcile.

### Phase 5 — Best-in-class guided setup *(Complexity: High)*
- **Goal:** Full white-glove: service-type activation, default forms/checklists install, scheduling-preference step, scanner/inbound-email setup, launch-readiness score, optional self-serve signup.
- **Files:** extend seed migration (blueprint + starter checklist + Vehicle Concerns install on create — G5); `view-settings.frag` (wire the unwired timezone control); optional new `signup.html` + service-role provisioning edge fn.
- **DB:** seed `onboarding_blueprint` + starter `checklist_forms` at create; per-DSP `schedule_policy` consolidation (optional).
- **Acceptance:** a non-technical owner completes end-to-end unaided; drivers have day-1 tasks; schedule, risk, and fleet views are all populated.
- **QA:** full funnel walkthrough on a fresh tenant; no empty states anywhere on the launch path.
- **Edge cases:** self-serve signup abuse (short_code squatting, email verification), template-DSP drift.

---

## 12. QA checklist (cross-cutting)

- [ ] Brand-new pending DSP routes into the wizard; active/backfilled DSPs never do (respect `onboarding_step='complete'`).
- [ ] Wizard autosaves on blur, resumes at first incomplete step, survives "Save & sign out."
- [ ] Timezone entered in wizard is written to `dsps.timezone` **and** `scheduling_settings.timezone` **and** `metadata.scheduling` — never left UTC.
- [ ] At least one `stations` row exists before the dashboard loads; Schedule view is not blank-with-no-explanation.
- [ ] Roster/fleet import: server-validated, per-row errors surfaced, one consistent driver-status convention, injection-safe CSV, backfill never overwrites existing rows.
- [ ] Bulk invite: SMS-or-email fallback correct, prior codes revoked, rate-limited.
- [ ] Launch Checklist detectors match reality and persist across sessions/devices.
- [ ] All writes respect RLS (`is_staff(dsp,'owner'/'dispatcher')`); no cross-tenant leakage; drivers still use opaque-token RPCs.
- [ ] Empty states everywhere on the launch path (roster/fleet/schedule) have copy + a CTA, never a blank grid.
- [ ] Onboarding actions leave an audit trace (`metadata.onboarding.log` or events).
- [ ] Tone: no color/animation regressions vs the Fluent-2 rebind; header chip is quiet.

---

## 13. Final recommendation — the simplest path to build first

**Ship Phase 1 only, first.** It removes the single biggest failure — the empty, confusing workspace — with the least new surface area, entirely on top of code that already exists:

1. **Seed defaults at DSP creation** (extend `admin_create_dsp`): create the DSP's station, write `scheduling_settings` with the *real* timezone, activate the default service type, and seed a first-week demand scaffold. This alone kills the empty-Schedule cliff.
2. **Add one wizard step — "Station & Operation"** — between Company and Contact, so single-station DSPs (the common case) are self-service and a schedule seed exists at activation. Reuse the existing `rr-onb-*` stepper.
3. **Turn the 14-day first-run banner into a persistent Launch Checklist** (upgrade `_initFirstRunZone`) with the §10 live detectors, a header "Finish setup (X of 7)" chip, and progress persisted in `dsps.metadata`.
4. **Wire the two highest-value rows to existing surfaces:** "Import roster" → the existing `#modal-bulk-driver-ingest` field-map importer; "Add vans" → `openFleetDrawer`.

That is a **Medium**-complexity change, reuses the wizard, the importer, the checklist engine, and the email pipeline, and takes a new DSP from *empty and confused* to *roster loaded → click "Build this week" → see a filled schedule* — the aha moment — without one giant form.

Then layer Phases 2–5 as **additional non-blocking checklist rows**, in this order of value: consolidate the two bulk-driver flows + add fleet import (Phase 2), bulk driver-app invite (Phase 3), launch-health polish (Phase 4), and the white-glove defaults/self-serve (Phase 5). Nothing after Phase 1 blocks access; every step is skippable and resumable; imports are preferred over typing; defaults are preferred over questions. That keeps the experience exactly what a busy DSP owner needs: *answer a few clear questions, import your core data, invite your team, and RouteReady is ready to work.*

---

### Appendix — key file references

- Wizard: `0126_dsp_onboarding.sql`; `dashboard/live.js:4420–4673`; `dashboard/index.html:1432–1637`; `rr-onb-*` in `dashboard/inline-styles.css`
- Gate: `dashboard/live.js:319–331`
- First-run checklist: `dashboard/views/view-dashboard.frag:8–69`; `dashboard/live.js:~244–299`
- Provisioning/seed: `0124_platform_admin.sql`, `0141_seed_new_dsp_config.sql`
- Roster importer: `dashboard/live.js:~21225–22050` (`_bdImportFieldMap`); server `0130_bulk_create_drivers.sql`
- CSV/XLSX: `dashboard/workbook.js` (`parseCsv`, XLSX parser)
- Fleet: `0186_van_assignments.sql`, `0213_fleet_roster.sql`; `vehicle_upsert`
- Driver invites: `0052_driver_invite_codes.sql`, `0253_driver_activation_unified.sql` (`send_onboarding_invite`); `app/app.js`
- Team invites/email: `supabase/functions/invite-team-member`; `send-email`/`send-sms`; `fire_message_send` (0007)
- Scheduling config: `0034` (`scheduling_settings`), `0199` (WOC), `SCHEDULING_PLAN.md`; `dashboard/scheduling-engine.js`
- Blueprint/forms: `0178_onboarding_blueprint.sql`, `0080_forms.sql`, `0415_driver_checklist_forms.sql`
- Tenancy/RLS: `0001_foundation.sql`, `0445_role_gate_core_tables.sql`, `0442_dsp_entitlements.sql`
