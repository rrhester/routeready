# RouteReady project review — 100 recommendations (2026-07-17)

A whole-project review: dashboard SPA, driver PWA, Supabase schema + edge
functions, TS engines/solver, satellite services, CI, security, a11y, docs.
Produced by nine parallel deep-review passes, deduplicated and prioritized.
Reference items as `PR#NN` (project-review) to avoid clashing with the
workbook/calendar `#NN` lists.

Every item was verified against the code at commit time; file/line refs are
approximate anchors, not exact contracts. Impact tags: **[high]** = real
user-facing or operational risk / big win, **[med]** = worth scheduling,
**[low]** = cheap hygiene or polish.

Excluded by design: items already on the active Workbook 100-list (batches
10–15) and the completed Calendar 100-list.

---

## A. Security & headers (1–8)

1. **Ship a baseline Content-Security-Policy (incl. `frame-ancestors`) and a header-parity check** — both `_headers:24` and `netlify.toml:135` explicitly defer CSP; only XFO/nosniff/Referrer-Policy/HSTS ship today. With ~1,082 `innerHTML` sites in `dashboard/live.js` and JWTs in localStorage, any single XSS has full blast radius. A baseline `default-src 'self'` + explicit CDN allowlist + `frame-ancestors 'self'` can ship without the inline-handler refactor. The header set is also duplicated across the two host configs with no parity test — add one so Netlify/Cloudflare can't silently drift. [high]

2. **Constrain third-party script risk (SRI + fewer runtime CDN imports)** — supabase-js and libraries load at runtime with no `integrity` from jsdelivr/esm.sh/unpkg on both authenticated and public pages: `live.js:10`, `login.html:116`, `booking.html:175`, `rsvp.html:73`, `screening.html:748`, `dashboard/index.html:178`, TipTap (`live.js:37`), Leaflet (`live.js:17419`), mammoth/xlsx (`live.js:89876`), `meet.js:38/1160`. A CDN compromise executes inside the dashboard with session + PII. Pair with A1's allowlist; vendor what's boot-critical (see D5). [high]

3. **Fix the open redirect via `next` on the login page** — `dashboard/login.html:123` feeds `params.get("next")` unvalidated to `location.replace(next)` (lines 140, 223, 250, 277). `login.html?next=https://evil.example` redirects right after a genuine sign-in. Restrict to leading-`/`, non-`//` relative paths. [med]

4. **Guard `window.__rrApplySession`** — `login.html:136` exposes a global that sets caller-supplied access/refresh tokens then redirects, with no origin check, nonce, or one-shot guard. Any same-origin script (or future XSS) can swap the operator's session. [med]

5. **Reduce token-theft exposure from localStorage sessions** — the Supabase client persists sessions in the SDK's default localStorage store (`login.html:119`), readable by any script on the origin; combined with A1/A2, one XSS exfiltrates a full session. Consider a custom cookie-backed storage adapter or at minimum ship A1/A2 as compensating controls; `IDLE_TIMEOUT_MINUTES` doesn't mitigate theft. [med]

6. **Validate `postMessage` origins in both directions** — the Google/Finch popup listeners gate only on `ev.data.type`, never `ev.origin` (`live.js:25854, 32887, 89205, 91184`) even though the callback pages target `location.origin` correctly; and `booking.html:264` posts its height beacon with target `"*"`. Enforce origins on receive and a configured origin on send. [med]

7. **Harden the two weak escape sinks** — `_rrNtSanitize` (`live.js:11934`) allows `<img src>`/`<a href>` and rejects only `javascript:`, so `data:`/remote URLs pass (tracking/exfil beacons); and `verify.html:112`'s `checkRow` interpolates its `detail` arg raw into `innerHTML` on a public page (escape-by-convention). Filter URL schemes/hosts in the sanitizer; escape inside `checkRow`. [low]

8. **Stop passing the driver session token in the Meet URL** — `meet.js:94` reads `?dtok=<token>` from `location.search`; URLs persist in history/logs and are readable by same-page CDN scripts (MediaPipe, `meet.js:1160`). Move to fragment (`#`) at minimum, or POST/session handoff. [low]

## B. Dashboard architecture & correctness (9–20)

9. **Fix the UTC "today" off-by-one** — `fmtIsoDate` is `d.toISOString().slice(0,10)` (`live.js:47155`), i.e. UTC, and 33 call sites use `fmtIsoDate(new Date())` as "today" (`live.js:7414, 11437, 15051, …`). For US operators after ~7–8pm local, tasks/attendance/status effective dates compute as *tomorrow*. Local-date builders already exist ad hoc (`live.js:12373, 13040`) — consolidate on one helper and sweep. [high]

10. **Stop discarding `sb.rpc` failures** — supabase-js v2 returns `{error}` rather than throwing, so ~27 bare `await sb.rpc(...)` calls (e.g. `mark_applicant_email_sent` inside `try{}catch(_){}` at `live.js:2959`) make failed writes look like success; the surrounding try/catch is dead code. Add an `rpcOrToast()` wrapper for mutations and sweep the bare sites. [high]

11. **Route the ~390 silent catches into the error telemetry** — 377 `catch(_){}` + 11 `catch(e){}` in live.js, while the `client_errors` pipeline (`live.js:256–294`) only sees uncaught errors; `window._rrReportError` is defined (`live.js:292`) and called zero times. A `_rrSwallow(label, e)` that forwards to it makes best-effort breakage visible in production. [high]

12. **Replace the `window.goto` wrapper chain with a dispatcher** — `goto` is rewrapped 7 times in live.js (4988, 17961, 22121, 49213, 70986, 71500, 75499) on top of `mock-wiring.js:271/832`; behavior depends on evaluation order. One `goto` with a registry of per-view enter/leave hooks is a mechanical refactor. [high]

13. **Vendor the boot-critical supabase-js for the dashboard** — `live.js:10` and `meet.js:38` import supabase-js from cdn.jsdelivr.net on the login/boot critical path; a CDN outage or corporate proxy takes down the dashboard. The driver app already vendors it (`app/vendor/supabase-js.mjs`) precisely because "the esm.sh import killed offline boot". Keep lazy CDN loads for optional features only (pdf-lib, qrcode, pdfjs, mammoth/xlsx, TipTap, Leaflet). [high]

14. **Extract one shared escape/toast module (`dashboard/rr-utils.mjs`)** — HTML escaping exists in ≥5 divergent copies: `escapeHtml` (`live.js:33639`), `escapeHtmlLocal` (`live.js:86648`), `esc` (`reports.js:21`), `esc` in `view-notebooks.frag:908` (misses `'`), and `_rrTextToHtml`'s inline esc (`live.js:2924`) which misses `"` yet interpolates into `href="$1"` — an attribute-breakout hazard. `toast` is tripled (`live.js:1061`, `meet.js:1422`, `parts-ui.js:930`). Expose `window.RRUtil` for classic scripts/frags. [med]

15. **Extract a tested date module; rename `startOfWeekMonday`** — `isoWeek` (`live.js:24472`) and `isoWeekNumber` (`live.js:47698`) are byte-identical; pull them plus `startOfWeek`/`addDays`/`fmtIsoDate` (`live.js:47147–47157`) into a module with tests (the cal-tz extraction found a real DST bug in exactly this kind of cluster). `startOfWeekMonday` (`live.js:47154`) has been Sunday-anchored since the 0265 convention change — rename it, keep no alias. [med]

16. **Retire mock-wiring.js wave by wave; stop emitting inline `onclick`** — 5,100 lines of mockup-era code still ship as a blocking classic script defining ~226 globals, most re-overridden by live.js. Inventory which globals the 182 inline `onclick=` handlers in `views/*.frag` still reference, port those, delete the rest. New live.js-generated HTML should use delegated `data-` listeners (pattern already at `live.js:90440`) instead of the 25 remaining `onclick="` template emissions. [med]

17. **Move view-notebooks.frag's script into a real module** — the frag is a hidden second monolith: 5,528 lines with one giant inline non-module script re-executed by the injector's script cloning; it can't `import` (hence the `window.RRTipTap` bridge, `live.js:29–95`) and carries its own weaker `esc`. As `dashboard/notebooks.js` it becomes smoke-checkable and testable. [med]

18. **Stop guarding same-module calls with `typeof`** — 560 `typeof X === "function"` guards (94 on `window.*`); `window._rrLoadSfRules` is defined exactly once (`live.js:51521`) yet ~20 call sites guard it and substitute `{}` on miss; `toast` is guarded 100+ times. These convert renames/regressions into silent no-ops. Reserve guards for genuine cross-script boundaries. [med]

19. **Continue high-value extractions from live.js** — the forecast/simulation cluster (`live.js:3661–4900`: risk forecast, 13-week simulation, backward-solve, hiring pulse, what-if) is mostly pure math and `forecast-core.js` already exists with a test; schedule assignment/publish logic and RPC payload shaping are next. Also fix `scripts/test-checklist-completion.mjs`, which tests a *mirrored copy* of a live.js expression instead of importing the real one (drift-prone). [med]

20. **Namespace new state under `window.RR`** — 271 unique `window.X =` assignments in live.js form the de facto state store, invisible to grep-by-feature and collision-prone with mock-wiring's 226 globals. Adopt per-feature state objects under the existing `window.RR` (`live.js:221`); no new bare window flags. [med]

## C. Performance & delivery (21–32)

21. **Split live.js and lazy-load per-view modules** — `live.js` is 5,160,040 B raw (1.39 MB gz) and statically imports `workbook.js` (1.38 MB / 371 KB gz) + `reports.js` at lines 16–17, so the whole spreadsheet engine parses before first paint even if Workbooks is never opened. Convert per-view features (workbook, reports, parts, repair) to `await import()` behind nav — the pattern already exists for tiptap/pdf-lib/xlsx (`live.js:43–56, 14827, 89877`). Drop the matching `modulepreload` hints (`dashboard/index.html:179–184`). [high]

22. **Add immutable long-cache headers for `?v=`-versioned JS/CSS/fonts** — `bust-cache.mjs` already makes every `?v=` token deploy-unique, yet `netlify.toml` sets Cache-Control only for HTML/SW/manifest; JS/CSS fall to `max-age=0, must-revalidate`, so every load revalidates ~8 MB. `_headers` already does `immutable` for `/dashboard/views/*` (98–99) — extend `public, max-age=31536000, immutable` to `*.js`/`*.css`/fonts on both hosts. [high]

23. **Shrink the 2.3 MB of render-blocking CSS** — `inline-styles.css` is 1,975,817 B / 33,217 lines (1,503 exactly-duplicated lines; 1,512 `!important`; duplicate selectors like `.rr-drive-v2` ×74) plus `schedule-rrx.css` at 341 KB, all blocking `<link>`s (`dashboard/index.html:185–203`). Dedupe, run a one-off unused-selector pass (Playwright coverage), and split per-view CSS to load with its view. [high]

24. **Scope the realtime channel and diff before re-rendering** — `live.js:46929–46947` subscribes one channel to `postgres_changes` on 13+ tables with **no `filter:`**, so any row change anywhere (any tenant) triggers `refreshActiveView` → full repaint (600 ms debounce). Add `filter: "dsp_id=eq.<id>"` per table and make loaders skip repaint on unchanged data — `loadDriversRoster` (`live.js:7343`) currently blanks the tbody to skeletons and rebuilds every time. [high]

25. **Push roster attendance aggregation into SQL** — `loadDriversRoster` (`live.js:7343–7420`) fetches up to 20,000 raw `shifts` + 2,000 `coachings` + 500 drivers and aggregates per-driver in JS, on a 30 s interval plus every realtime event. One RPC doing `group by driver_id` server-side drops megabytes of JSON to a few hundred rows. [high]

26. **Kill the two megabyte-scale images** — `header-bg.png` (922,646 B) is referenced *only* as the favicon of `verify.html:8` (a public token-link page opened from SMS): point it at `app/icons/favicon-32.png` (1.9 KB) and delete the file. `app/Icon.png` (346,820 B, 1024²) is the `rel="icon"`/apple-touch-icon of `index.html:8–9` and `dashboard/index.html:134–135` *and* the largest driver-app precache entry (`app/sw.js:283`) while rendering at 64 px on the login tile — use the existing small derivatives. [high]

27. **Clean up marketing-page delivery** — `index.html:10–11` loads a render-blocking Google Fonts sheet for 10 font weights while line 14 also declares local Inter from `app/fonts/`; self-host both families as variable woff2 and drop the third-party chain. `terms.html` (90 KB) and `privacy.html` (80 KB) each embed ~53 KB of duplicated inline CSS re-downloaded every visit (HTML is `no-cache`) — extract one `marketing.css?v=` riding C22's immutable rule. [med]

28. **Trim dashboard/sw.js's comment changelog** — 103,887 B for ~300 effective lines: the deploy-nonce section is an ever-growing per-PR changelog, served `no-cache` and refetched on every navigation; any byte change force-reloads all open operator windows. Keep one nonce line, move history to git; reconsider forced reload on *every* deploy now that bust-cache guarantees fresh assets. [med]

29. **Fix unbounded fetches; audit `select('*')` sites** — `openCoachingPrintView` (`live.js:33943–33947`) pulls the tenant's *entire* `coaching_edits` + `coaching_attachments` history (no filter, no limit) to print one driver's record. Live.js has ~70 query sites but only 48 `.limit(` calls — sweep the rest. [med]

30. **Gate dashboard timers on visibility; audit listener lifecycle** — 36 `setInterval` sites; the global 30 s `refreshActiveView` (`live.js:46950`) and 8 s chat poll (`live.js:40041`) never check `document.hidden`, so a background tab polls all shift (a few timers like `live.js:19801` already do it right — make it the rule). Also: 1,274 addEventListener sites vs 106 removes with 1,069 `innerHTML` re-render sites — one grep-audit for `document`/`window`-level listeners registered inside refreshable loaders would confirm or clear the accumulation risk. [med]

31. **Keep shrinking the no-cache shell** — `dashboard/index.html` is 398,107 B (80 KB gz, 5,629 lines) served `no-store` on every navigation, still carrying ~30 modals, 24 inline `<script>` blocks, and 337 `style=` attributes. Continue moving stable markup into immutable-cached `views/*.frag`; fix the stale `netlify.toml:107–113` comment claiming CSS is still inlined. [med]

32. **Quantize generated PNGs; set image dimensions** — `app/icons/` totals ~1.7 MB (16 iOS splash PNGs, 111–119 KB 512px icons); `scripts/generate-driver-icons.mjs` could emit palette-quantized output (40–60% smaller via pngquant/oxipng). No `<img>` in the repo sets `width`/`height` (layout shift); future marketing imagery should ship AVIF/WebP. [low]

## D. Driver app (33–44)

33. **Race the SW's network-first shell fetch against a short timeout** — `app/sw.js:312–339` serves shell assets network-first with a bare `fetch`; on a stalled-but-connected cell link a launch hangs until the OS timeout instead of serving the cached shell instantly. Race against a ~3–4 s AbortController, serve cache on loss, refresh cache in background. [high]

34. **Handle `pushsubscriptionchange` and re-register push on boot** — no handler exists in sw.js, and `ensurePushSubscription` is only invoked from the Chat screen's nudge (`app.js:341–346`); when the browser rotates the subscription, pushes silently die. The SW already holds token+url+anonKey in IndexedDB (`sw.js:344–375`) so it can re-subscribe and call `driver_push_register` itself; also call it from `render()` when permission is already granted. [high]

35. **Centralize RPC error handling in one wrapper** — 125 raw `sb.rpc(` sites but only ~9 screens check `unauthorized|revoked|inactive` and clear the session; a revoked token on Today/Tasks leaves a signed-in shell erroring generically forever. A small `rpc()` wrapper signs out once on auth errors and adds one jittered retry for idempotent reads (`_friendlyError` at `app.js:757` already classifies network failures). [high]

36. **Gate schedule pollers on `document.hidden`; slow them while realtime is up** — `_coverOfferTimer` (15 s), `_pickupTimer` (20 s), `_swapInboxTimer` (20 s), `_shiftConfirmTimer` (30 s) fire unconditionally (chat pollers already skip when hidden, `app.js:5971–5976`) while `_rrLiveRefresh` (`app.js:2126`) pushes the same refreshes instantly. Straight battery/data savings. [med]

37. **Rebuild `_rrLiveChannel` on foreground like the presence channel** — v183 fixed the dead-socket-after-background bug for calls via `_drvPresenceRewire()` in `refreshOnFocus`, but `_rrLiveStart` early-returns on the surviving channel object with no status callback (`app.js:2114–2123`), so the app-wide message/offer/badge bus has the identical failure mode. [med]

38. **Check for SW updates on foreground; nudge on `controllerchange`** — `reg.update()` runs only in the `load` handler (`app.js:62–75`); installed iOS PWAs resume from freeze without firing `load`, and there's no `controllerchange` listener, so a driver who keeps the app open all shift runs stale app.js against evolving RPC shapes. Add `reg.update()` to `refreshOnFocus` plus a quiet "update ready" toast. [med]

39. **Actually call the Capacitor bridge for haptics and badges** — `RRNative.haptic`/`setBadge` (`app/comms-native.js:89–103`) are dead code; `_haptic` uses `navigator.vibrate` (a no-op in iOS WKWebView) and badging is web-API-only, so the native shell ships with neither despite the seam existing. [med]

40. **Refresh capacitor.config.json for the shipped redesign** — it still sets `backgroundColor: "#0b1220"` (pre-v181 navy) against today's white chrome, guaranteeing a navy flash at launch/keyboard/rotation; there's no StatusBar/SplashScreen plugin config; `bundledWebRuntime` is dead config in Capacitor ≥5. [med]

41. **Move the type scale to rem for OS large-text support** — all 141 `font-size` declarations in `app/styles.css` are px on px tokens (`--fs-xs: 11px…`, `styles.css:121–122`), so OS/browser text-size accessibility settings do nothing. Converting just the `:root` tokens to rem scales most of the UI in one spot. [med]

42. **Split app.js along its section seams; lazy-load the scanner** — 13,594 lines / 700 KB in one module file that already `import`s (`form-validation.js`), so extraction needs no build step: scanner/OCR (~2965–5248), chat/calls (~5248–7523), forms/checklists (~9193–10700). The ~2,300-line scanner block should become a dynamic `import()` on first open (Tesseract is already lazy at `app.js:3681`); add extracted files to `SHELL_FILES` + bust-cache's FILES. [med]

43. **Queue chat attachments and voice notes offline, not just text** — the outbox (`app.js:3873–3963`) queues text only; failed photo/voice sends are tap-to-retry stubs whose staged blobs die if the driver navigates away or the PWA is killed in a dead zone. The receipt queue (`app.js:4490`) already persists blobs in IndexedDB — reuse it. [low]

44. **Make keep/drop decisions on the redesign proposal's unshipped items** — from `design/driver-app-redesign/PROPOSAL.md`: break tracking (§9.1), server-side inspection gating of check-out (§9.2), one-tap sticky check-in with undo (§9.4), the Concept-A timeline drill-in (§3), and the §9 "what changed" in-app note never landed. Ticket them so the proposal isn't the only record. [low]

## E. Database & migrations (45–56)

45. **Stop minting duplicate migration ordinals; gate in CI** — 31 ordinals are shared by 68 files (three-way collisions at 0433/0436/0439/0445/0490/0492; fresh two-way at 0500). The operator's known 0432 skip almost certainly came from the `0432_gcal_two_way_sync` / `0432_team_tasks` pair ("I already ran 0432"). Fail PRs introducing a duplicate prefix not on a frozen allowlist. [high]

46. **Make manual pastes self-recording; derive a generic schema version** — SQL-Editor pastes never write any ledger, so drift like 0432 is invisible. Create `private.applied_migrations` and end every new migration with an `insert … on conflict do nothing`; then replace the calendar-only `calendar_schema_version()` (a literal `select 498`, already frozen while 0499–0501 shipped, matched by a hardcoded `_IVCAL_SCHEMA_EXPECTED` in live.js) with `rr_schema_version()` derived from the ledger, and make the dashboard banner generic. [high]

47. **Converge the 0432 drift with a re-assert migration** — CI replays `0432_gcal_two_way_sync.sql` from scratch but prod never ran it, so green CI validates a schema prod doesn't have; 0496 already had to re-assert 0432's `last_pulled_at` ad hoc. One idempotent 05xx re-asserting all 0432 objects (tables/columns/`gcal-pull` cron) makes prod match the repo and finally activates the pull cron. [med]

48. **Fix `scripts/apply-migrations.sh` hygiene** — it creates `public.rr_migrations` with no RLS (the moment `SUPABASE_DB_URL` is configured, the deploy ledger becomes anon-read/writable via PostgREST; deleted rows would cause re-application), and its `BASELINE="0373"` is stale — enabling the runner today would re-execute 0374+ including the deliberately-skipped 0432. Move the table to `private`, bump the baseline to the hand-applied head, document the 0432 exception inline. [med]

49. **Wrap RLS tenant checks in initplan subselects** — virtually every policy uses bare `dsp_id = private.current_dsp_id()` (pattern set in 0002; exactly one wrapped occurrence exists repo-wide), re-evaluating the security-definer `app_users` lookup per row. Rewriting hot-table policies (shifts, driver_messages, workbook_cells, cal_events) as `dsp_id = (select private.current_dsp_id())` is the standard Supabase initplan optimization — one idempotent migration. [med]

50. **Close FK index gaps on cascade paths** — 192 tables FK `dsps` and 63 FK `drivers`, mostly `on delete cascade`; confirmed unindexed FKs include `assignment_audit.actor_driver_id` (0182), `document_events.actor_driver_id` (0152), `checklist_submissions.schedule_shift_id` (0415), `receipt_uploads.shift_id` (0435), `driver_channel_messages.sender_driver_id` (0073). Driver deletes and `admin-delete-dsp` seq-scan these. Generate one migration from the standard missing-FK-index catalog query. [med]

51. **Enable RLS on `public.cal_event_reminders`** — created in 0406 with no RLS, no policies, no revokes; verified as the only public table with neither. With default grants, anon/authenticated can read, insert (suppress any tenant's reminders — the dedupe in 0406/0430/0497 trusts this table), or mass-delete (duplicate reminder sends). One idempotent migration: enable RLS, no client policies. [high]

52. **Harden `client_errors` inserts and add retention** — 0385 uses `with check (true)` for authenticated inserts, so any user can spoof `dsp_id`/`user_id` (which 0443 aggregates into per-DSP health signals) and insert unbounded rows; no purge job exists. Bind `user_id = auth.uid()`, length-cap message/stack, add a pg_cron retention delete. [low]

53. **Inventory-test anon-granted definer RPCs** — dozens of `security definer` functions are granted `to anon` on token-keyed flows (0004, 0017, 0038, 0052, 0054, 0056, …). Function hygiene is otherwise excellent (`set search_path = ''` is universal), but the cross-tenant test suite covers tables, not RPCs: add a SQL test that enumerates anon-executable functions and fails when a new one appears without a token/captcha argument. [med]

54. **Emit a schema dump artifact; plan a squash baseline** — `migration-check.yml` already builds a fully-migrated throwaway DB; add `pg_dump --schema-only` and commit/upload it (`db/schema.sql`) for reviewable per-PR schema diffs, DR, and the generated schema doc docs/ lacks. Once trusted, declare a baseline at ~0500 (seed CI from the dump, apply only post-baseline files) — 537 serial replays are CI's critical path and keep growing. [med]

55. **Add a demo seed for local dev and e2e** — `supabase/seeds/` has only `seed_attendance_test.sql`; a local stack starts empty and Playwright suites must fabricate data. One idempotent `seed_demo.sql` (one tenant, a week of shifts, a few applicants) loaded after migrations in CI strengthens the e2e too. [low]

56. **Assert the expected pg_cron inventory** — 16+ jobs are scheduled across migrations (`flush-scheduled-messages` every minute, reminder/reconcile/digest jobs, five dailies), but nothing detects a missing job in prod — `gcal-pull` has been silently absent for months. Add `rr_cron_expected()` comparing `cron.job` to the expected list, surfaced in the admin panel and asserted in migration-check. [low]

## F. Edge functions (57–67)

57. **Lock down `webhook-apply` (SMS-pumping surface)** — `webhook-apply/index.ts:23–26` makes `APPLY_SHARED_SECRET` optional, and with `auto_send_screening` on, any anonymous POST queues an SMS to an attacker-chosen phone (lines 43–70) with no rate limit, captcha, or dedupe — toll-fraud plus junk-applicant spam. Require the secret, rate-limit, and dedupe by phone before auto-send. [high]

58. **Make SMS STOP/START durable** — `webhook-twilio` promises "Reply START to opt back in," but `send-sms/index.ts:99–115` suppresses on any STOP in the last 200 inbound rows regardless of a later START; conversely a chatty thread can push STOP out of the window and sends silently resume. Persist an opt-out flag flipped by webhook-twilio (set on STOP, clear on START). [med]

59. **Add outbound timeouts and a stuck-`sending` sweeper** — only vin-decode uses AbortController; Resend, Twilio, Anthropic, Cal.com, APNs/FCM calls are bare `fetch`, so one hung upstream stalls a queue drain — and rows claimed queued→`sending` are stranded forever if the isolate crashes or `resp.json()` throws (`send-email/index.ts:159–164, 296`). Add a shared `fetchWithTimeout` in `_shared/` plus a cron requeue for `sending` older than N minutes. [med]

60. **Extract real shared helpers; adopt an import map** — 37 functions each define their own CORS constant; JWT+role gating is re-implemented at least six ways and the role lists have diverged (`cal-availability:31` omits `platform_admin`; `workbook-ai:197` includes it); `driver-document-fetch` shadows `_shared`'s helpers. Extract `corsHeaders()` / `requireUser()` / `requireStaffRole(roles)`. Also: the `esm.sh/@supabase/supabase-js@2.45.4` pin is repeated in ~30 files and esm.sh flakiness has already failed deploys twice — one `deno.json` import map (or jsr) gives a single bump point. [med]

61. **Standardize error responses; stop leaking internals** — `health/index.ts:44` returns raw Postgres errors publicly; `driver-document-fetch:85–93` echoes full PostgREST code/details/hint; `webhook-apply:34` and `box-ingest:58` return raw `error.message`. And `cal-availability:248–251` wraps *every* failure (including raw Cal API bodies and a `found_slugs` dump) as HTTP 200, defeating monitoring. Map to stable error codes; keep detail in `console.error`; use real status codes. [med]

62. **Bring all AI endpoints under the same abuse controls** — `workbook-ai` rate-limits 20/10 min and caps conversation turns, but `analytics-ai:733` accepts an unbounded client-supplied conversation (including forgeable `tool_result` blocks) with up to 10 tool iterations per request on the shared Anthropic key, and `notebook-ai` has no limiter. Reuse the DB-backed quota `ai-proxy:102` already has instead of per-isolate in-memory maps. [med]

63. **Make booking-confirmation sends idempotent under webhook retries** — `webhook-cal:99–105` invokes `send_booking_confirmation` unconditionally on every `BOOKING_CREATED`/`BOOKING_RESCHEDULED` delivery, and Cal.com retries failed deliveries — duplicate email+SMS to applicants. Enforce idempotency per `provider_event_id` on the confirmation itself, not just `book_event`. [med]

64. **Declare `verify_jwt` in config.toml for all no-verify functions** — config.toml pins it for only 6 of the 29 functions the deploy workflow passes `--no-verify-jwt` for; the CLI reverts to `verify_jwt=true` without an entry, so any manual `supabase functions deploy webhook-twilio` silently breaks Twilio inbound. Make config, not a workflow flag, authoritative. [med]

65. **Give push-fanout a retry/dead-letter path** — APNs/FCM failures are only counted and returned (`push-fanout:243–265`) and the trigger call is fire-and-forget; a transient provider outage loses notifications with no record. Persist failed attempts (token, message, error) or requeue with backoff. [med]

66. **Cap applicant video uploads; store paths not expiring URLs** — one valid screening token permits unlimited 50 MB uploads to unique `Date.now()` paths (`upload-applicant-video:62`), and `applicants.video_url` stores a 30-day signed URL that goes dead (74–81). Cap per applicant; store the object path and sign at read time. [low]

67. **Use constant-time comparisons for signatures and shared secrets** — `webhook-twilio:33`, `webhook-cal:22`, the Svix `some(===)` in webhook-email-inbound/events, the raw bearer compare at `webhook-email-inbound:220`, plus `solver-service/rr_solver/main.py:59` and `services/document-sealing/src/index.ts:213`. Centralize a timing-safe compare in `_shared/` (and `hmac.compare_digest` in Python). [low]

## G. Engines, solver & satellite services (68–76)

68. **Trigger the flex-capacity edge function deploy on its TS source** — `supabase/functions/flex-capacity/index.ts` imports `../../../flex-capacity/src/*.ts`, but `deploy-migrations.yml` triggers only on `paths: supabase/**`; a change to `flex-capacity/src/` alone never redeploys, so production runs the old engine until an unrelated supabase change ships. [high]

69. **Run solver-service tests in CI and gate deploy on them** — `solver-service/tests/` holds 8 pytest files (~75 KB incl. CP-SAT objective and trace tests) plus `requirements-dev.txt`, but no workflow runs pytest; `deploy-solver-service.yml` goes straight to `flyctl deploy` on any push to main. Add a test job and make deploy `needs:` it. [high]

70. **Enforce engine↔solver rule parity with shared golden fixtures** — `rr_solver/eligibility.py` "mirrors the in-browser engine's R002→…→R003 chain" and `cpsat_model.py` re-implements max_days/WOC/weekly-cap/R022 semantics, but parity lives in prose and two hand-maintained suites. Shared golden JSON fixtures asserting identical hard-eligibility verdicts, consumed by both `engine/test/` and `solver-service/tests/`. [high]

71. **Fix the generated-bundle drift guards** — `engine-tests.yml` runs `git diff --exit-code dashboard/scheduling-engine.js` but triggers on `engine/**` only, so a PR hand-editing the 96 KB generated file never runs the check (add the file to `paths:`). And `dashboard/flex-capacity.js` is a dead checked-in bundle — nothing imports it (live.js invokes the edge function); delete it and the `build:dashboard` path, or wire the claimed consumer plus a drift guard. [med]

72. **Typecheck and modularize document-sealing** — the Worker is a single 2,091-line `src/index.ts` mixing routing, PDF layout, ECDSA sealing, RFC 3161 TSA client, and Supabase REST helpers, with no `typecheck` script and nothing exercising its tsconfig; `deploy-document-sealing.yml` goes install→`wrangler deploy` (wrangler bundles but doesn't run tsc). Add `tsc --noEmit` to the workflow and split the file. [med]

73. **Pin deploy toolchains to immutable refs** — `superfly/flyctl-actions/setup-flyctl@master` (a moving branch on a production deploy path) and `supabase/setup-cli@v1` with `version: latest`. Pin tags/SHAs for reproducibility and supply-chain resistance. [med]

74. **Resolve the desktop signing/auto-update contradiction** — `desktop-build.yml` disables macOS signing and there's no Windows signing config, yet `desktop/main.js` runs electron-updater with `autoDownload = true` from GitHub releases; macOS electron-updater refuses to install into an unsigned app and Gatekeeper/SmartScreen block first installs — the update loop is broken on two platforms while appearing configured. Acquire certs or gate the updater per-platform. [med]

75. **Add value-pinning tests for engine soft-scoring rules** — `rules.test.ts` covers hard rules R001–R011/R019–R022, but the scoring functions in `r012_patterns.ts` (`patternMaxBonus`, `historicalPoints`), `r013_attendance.ts` (weight table), `r017_preferred.ts`, and `r018_consecutive.ts` (10/15-point adjacency) have none; a scoring regression surfaces only as opaque end-to-end assignment diffs. [med]

76. **Give apps-script push tooling or a version marker** — `setup-automation-sheet.gs` (530 lines) is installed by manual paste; with no `.clasp.json` and no version constant, drift between repo and deployed script is undetectable. Add clasp, or at minimum a `SCRIPT_VERSION` surfaced in the RouteReady Tools menu. [low]

## H. Testing & CI (77–88)

77. **Add a CI gate for edge functions** — 57 functions with webhook signature handling, OAuth callbacks, and the bearer gate in `_shared/supabase.ts` have zero pre-merge checks; a PR touching only `supabase/functions/**` triggers *no* workflow, then auto-deploys on merge. Run `deno check` on every function plus `deno test` for the pure logic (Svix/Twilio HMAC verifiers, `_shared/google_crypto.ts`, `_shared/ics.ts` are cheap to unit-test). [high]

78. **Add a deploy-list drift check to deploy-migrations.yml** — the two hardcoded function loops omit at least 10–11 existing function dirs (`microsoft-*` ×4, `booking-captcha`, `google-calendar-reconcile`, `analytics-ai`, `explain-optimization-run`, `parts-search`, `vin-decode`, `vehicle-document-fetch`) — merged changes to those silently never ship (`analytics-ai` is a 749-line live feature). Generate the list from the directory, or assert directory == deploy-list ∪ manual-allowlist in CI. [high]

79. **Fix path-filter gaps so suites run when their sources change** — `test-labor-forecast.mjs` imports `dashboard/forecast-core.js`, the parts tests import `dashboard/parts/**`, and the receipt/scanner tests read `app/app.js`, but no workflow's `paths:` covers those sources — editing them runs zero relevant CI. [high]

80. **Put flex-capacity under CI (tests + bundle freshness + build fix)** — its 5 `node --test` suites run nowhere in CI, there's no freshness check for its dashboard bundle (engine-tests.yml does this for scheduling-engine.js), and `build:dashboard` can't even run from a clean checkout (invokes esbuild, which isn't in devDependencies — engine correctly pins `esbuild 0.28.0`). Clone engine-tests.yml and pin esbuild. [high]

81. **Commit lockfiles; use `npm ci` and cache** — zero `package-lock.json` files exist anywhere. Engine CI floats `typescript ^6`, document-sealing resolves wrangler fresh per run, desktop ships installers from floating `electron ^32`, and the Playwright suites install unpinned `@playwright/test` (a Playwright release can shift rendering and break visual baselines with no code change). Then cache `~/.cache/ms-playwright` keyed on the pinned version — three workflows currently cold-install browsers every run (~1–2 min each). [high]

82. **Add Playwright e2e for the flows that matter most** — the entire e2e surface is 2 booking tests + 10 driver-form tests. Nothing exercises login/session, any live.js view interaction (assign shift, publish schedule), driver check-in, or `rsvp.html`. The stubbed-Supabase pattern in `tests/booking-e2e/playwright.config.mjs` and the `verify` harness prove it's feasible without credentials; the schedule view is the highest-value target. [high]

83. **Migrate scripts/test-*.mjs to `node:test`; turn on coverage** — the 23 suites are bare scripts with hand-rolled pass counters chained with `&&` in package.json, so the first failure hides all later results and nothing parallelizes. engine/ and flex-capacity/ already use `node --test`; assertions already use `node:assert/strict`, so conversion is mechanical — and `--experimental-test-coverage` comes nearly free after. [med]

84. **Add an always-run `ci-ok` aggregator job** — every test workflow is path-filtered, so PR classes exist that run no checks at all, and skipped runs never report to GitHub required-status-checks. A thin job that always runs and `needs:` the triggered suites gives branch protection and the auto-merge convention a single reliable signal. [med]

85. **Add ESLint; extend the parse gate to all shipped JS** — no lint config exists anywhere, and `smoke-check-live.mjs` parses only 4 files (lines 37–42): `app/sw.js` (the cache-bump-critical file), `form-validation.js`, `comms-native.js`, `meet.js`, `mock-wiring.js`, `fleet-sync.js`, `parts-ui.js`, `repair/*`, and frag inline scripts ship with zero parse check. Cheapest: glob all shipped JS into smoke-check; better: minimal flat-config ESLint (`no-undef` with a shared-globals list, `no-unused-vars`), which also catches the shadowed-`esc`/stale-global bug classes this codebase hand-guards against. [med]

86. **Broaden visual regression** — `tests/visual/visual.spec.mjs` takes 4 shots (schedule/fleet chrome, login, booking shell) plus one workbook fixture, yet the workflow triggers on all of `dashboard/**`, `app/**`, `*.html` — an app/ CSS regression triggers the workflow but diffs nothing that could catch it. Add recruiting/calendar/reports/repair/parts views and the driver-app pages. [med]

87. **Schedule weekly drift runs** — everything triggers on PR/push only while toolchains float (`supabase/setup-cli@v1 latest`, TS `^6`, unpinned Playwright), so environment drift surfaces inside unrelated PRs. A weekly `schedule:` on migration-check (also your DR rehearsal) and the Playwright suites isolates "the world changed" from "your change broke it" — and is the natural home for a drifted-baseline migration leg (the 0496-assumed-0432 incident class). [med]

88. **Align the pre-push hook with CI** — `.githooks/pre-push` runs only smoke-check; unit suites, design-lint, and cache-bump-check are CI-only, so failures surface ~5 min post-push. Add a fast changed-file-aware step; note the hook is inert on clones that never ran `npm install` (the `prepare` script wires `core.hooksPath`). [low]

## I. Accessibility & UX (89–96)

89. **Add focus management to the modal system and menus** — `openModal`/`closeModal` (`mock-wiring.js:2421`) just toggle a class: no focus move, no Tab trap, no focus restore; the ~30 `.modal-backdrop` dialogs in dashboard/index.html carry zero `role="dialog"`/`aria-modal`. Native `<dialog>.showModal()` (0 uses today) or one shared trap helper fixes all consumers. Same for `role="menu"` popovers like the roster "Add driver" menu (`live.js:~22995`) that wire only click+Escape — add the APG keyboard pattern or drop the role. [high]

90. **Make toasts announce to screen readers** — `#toast-stack` (`dashboard/index.html:2172`) has no `aria-live`/`role="status"`, yet toasts are the dashboard's primary success/error feedback. One `aria-live="polite"` on the container fixes every toast. [high]

91. **Fix form labeling on the public candidate pages** — `rsvp.html` has zero aria attributes and its propose-time date/time/notes inputs (lines 200–203) are placeholder-only; `booking.html` renders intake questions as `<label>` + `<input data-iq>` with no `for`/`id` association (845–847). These are the pages external applicants use, often on phones with assistive tech. [high]

92. **Add a skip link, `<main>` landmark, and `aria-current` to the dashboard shell** — there's a `<nav>` (`index.html:568`) but no `<main>` and no skip link, so keyboard users tab the entire icon sidebar before content; the active nav item is class-only. [med]

93. **Extend the design ratchet to live.js and public-page inline CSS** — `design-lint.mjs` scans 6 CSS files plus app/app.js, but live.js (the largest template-string render surface) and the embedded `<style>` blocks in booking/rsvp/login/index are ungoverned — raw hex and inline styles can grow there invisibly, defeating the ratchet's purpose. [high]

94. **Add accessibility axes to the design linter** — cheap ratchet-style additions: contrast-check token pairs, count icon-only `<button>`s lacking `aria-label`, flag `outline:none` without a replacement (`login.html:25`), a touch-target floor (booking's `.gslot` is ~40 px), and a reduced-motion check (marketing index.html has 11 animation occurrences and is the only page without a `prefers-reduced-motion` guard). [med]

95. **Decide on dark mode** — inline-styles.css defines 354 tokens but the only `prefers-color-scheme: dark` rule in the entire dashboard is a 3-line block for one search modal (`inline-styles.css:29893`), while schedule-rrx.css hardcodes white 136 times. Either delete the stray block (today users who prefer dark get one dark modal on a light app) or route the token layer through a real theme. [med]

96. **Unify the public-page token palettes** — booking (`--border:#DADCE0`), rsvp (`--border:#E4E4E9`), 404 (`--muted:#475569`), and inline-styles (`--border:#E5E7EB`) define the same semantic names with different values, so "the same gray" differs page to page. One shared public token sheet (or generate the `<style>` blocks from a single source). [med]

## J. Docs & developer experience (97–100)

97. **Write a top-level README** — verified absent; the repo has ~20 top-level surfaces (dashboard, app, engine, flex-capacity, solver-service, services, desktop, apps-script, supabase with 57+ edge functions) and per-package READMEs for only five. A one-page map — what each dir is, how it deploys, where its tests live — is the cheapest onboarding win. [high]

98. **Regenerate supabase/SECRETS.md from code** — it claims to cover "every env var the live backend depends on" and says "all five edge functions"; there are now 57+ function dirs and 59 distinct `Deno.env.get(...)` vars across 46 files (MS_CLIENT_*/TURNSTILE keys are documented only in CLAUDE.md). A small script scraping `Deno.env.get` per function and regenerating the table keeps it honest. [high]

99. **Promote the local-dev recipe and write a deploy runbook** — the only documented way to run the dashboard locally (serve root, seed a fake session, stub the API) lives in `.claude/skills/verify/SKILL.md` where humans won't find it; docs/ has feature essays but no LOCAL-DEV or runbook explaining which of the 16 workflows deploys what and that migrations are applied manually via SQL Editor. [med]

100. **Add CONTRIBUTING.md and a PR template** — `.github/` contains only workflows/; the repo's real conventions (squash-merge, idempotent migrations, cache-bump check, design-ratchet `--update` etiquette, the intentional `\0` escape in workbook.js) exist only in CLAUDE.md, which is written for the AI, not for human contributors. [med]

---

### Suggested first wave (highest risk-to-effort ratio)

- **PR#51** RLS on `cal_event_reminders` (one migration)
- **PR#57** webhook-apply lockdown (SMS pumping)
- **PR#78** deploy-list drift check (features silently not shipping)
- **PR#9** UTC "today" bug (visible data correctness)
- **PR#26** delete the 900 KB favicon (one line)
- **PR#68** flex-capacity deploy trigger paths (one line of YAML)
- **PR#22** immutable cache headers (~8 MB per operator per day)
- **PR#3** login open redirect (few lines)
- **PR#77** `deno check` CI gate for edge functions
- **PR#45–46** migration ordinal gate + applied-migrations ledger
