# Onboarding → Funnel — 100 improvement ideas (2026-07)

Scope: the Onboarding page's **Funnel** tab — the applicant list
(`dashboard/live.js` `renderApplicantCard` / `loadPipeline` /
`handleAction` / `_paOpenRecord` families, `dashboard/views/view-pipeline.frag`,
`dashboard/onboarding-rrx.css`), its stage chips, Action-needed triage,
right-rail funnel panel, and the RPCs behind them (`pipeline_list`,
`pipeline_counts`, `pipeline_kpis`, `pipeline_funnel_kpis`).

Items are referenced as `F#NN`. Grounded against HEAD 2026-07-18; several
are confirmed bugs (F#21, F#22, F#24, F#51, F#69, F#82, F#83, F#91).

## A. Triage & working the queue (F#1–10)

1. **Explain the ranking** — Action-needed cards should say *why* they're
   ranked ("6d past Screening target · Score 9 · one step from booked");
   `_attentionScore` is invisible, so the order looks arbitrary.
2. **Snooze** — "hide until Friday / until they reply" so half-chased
   applicants stop resurfacing on every visit.
3. **Split Action needed** into "Your move" vs "Waiting on applicant"
   groups — the per-card `ctaNeedsAction` flag already computes this.
4. **Queue mode** — a one-at-a-time "work the queue" flow (like Interview
   Day) stepping through Action-needed cards with keyboard advance.
5. **Overdue rollup banner** — "12 applicants past stage target", click to
   filter (today only per-card amber chips).
6. **Per-tab overdue dots** — amber dot on stage chips that contain
   overdue applicants.
7. **Sort dropdown** on non-triage tabs (newest / oldest /
   longest-waiting / score) — server order only today.
8. **Remember the active stage tab** across visits (resets to All).
9. **Batch prompt on Screening** — "4 screened candidates are ready —
   send all booking links" one-shot.
10. **Stale filter + cut-and-run** — a 30d+ view (the live list has 41–54d
    waiters) with bulk archive.

## B. Find & organize (F#11–20)

11. **Search box** (name / phone / email) — none exists.
12. **Filter by source** (`a.source` is already on the row).
13. **Filter by score band** (7+, 4–6, <4, unscored).
14. **Saved views** (filter + sort combos persisted).
15. **Bulk-select checkboxes** + bulk actions (resend, decline, archive).
16. **Pagination** — `pipeline_list` silently caps at `p_limit: 200`;
    show "200 of N" + load-more.
17. **Sortable columns** (Last contact / Added).
18. **Density toggle** (comfortable / compact).
19. **Manual stage override** (⋯ → "Move to…") for out-of-band phone
    hires.
20. **Export current view to CSV** (mirror `_obDownloadCsv`).

## C. Row content & correctness (F#21–30)

21. **BUG: the Offer dot is dead** — `_pipelineStageIndex` never returns 3,
    so "Offer" can never be the current stage; add a real offer stage or
    drop the node.
22. **BUG: `rrTitleCaseName` mangles names** — "MCDONALD" → "Mcdonald",
    "O'BRIEN III" → "O'Brien Iii"; only fold when input is ALL-CAPS and
    handle Mc/Mac/O'/roman numerals.
23. **Format phones** for display (+14175976776 → (417) 597-6776).
24. **BUG: `sourceMetaTxt` is computed but never rendered** in
    `renderApplicantCard` — add the "via Indeed" source chip it was for.
25. **Notes indicator** — dot on the ⋯/notes entry when notes exist.
26. **SMS opt-out badge** from `sms_optouts` (0504) so operators stop
    resending into a STOP.
27. **Screening answers as chips** (days available, earliest start) on
    screened cards — today they're not surfaced at all on the live card.
28. **Video tooltip** = answer count + total duration.
29. **Show city/location** (mock cards had "Springfield, MO"; live cards
    don't).
30. **Neutral avatar tint for unscored applicants** —
    `_tierClassFromScore` shouldn't rank before screening completes.

## D. Actions & communication (F#31–40)

31. **Channel choice on invites** — the CTA now only opens the email
    composer; restore an SMS option (server path exists) as a split
    button.
32. **Replace native `prompt()`/`confirm()`** (reschedule reason, remove
    booking, decline-without-email) with in-app modals.
33. **Undo toast after decline** (status→rejected is revertible).
34. **Decline reason picker** (no CDL / failed screen / ghosted / filled)
    stored for analytics.
35. **Call outcome logging** after the tel: action (no answer / voicemail
    / talked) → note + last-contact.
36. **Last contact is SMS-only** (`last_sms_at`) — sent emails don't move
    the column; stamp and show them ("Email · Yesterday").
37. **SMS thread in the record drawer** (inbound already lands via
    webhook-twilio).
38. **Copy booking link** — mint + clipboard for operators who text from
    their own phone.
39. **"Book for them"** — operator picks the interview slot directly,
    skipping applicant self-serve.
40. **"Remind me" quick-task always available** in ⋯ — today `rrQtLink`
    only appears once a card is overdue.

## E. Automation (F#41–50)

41. **Auto-nudge cadence** (opt-in): +2d/+5d reminders on unanswered
    screening invites, quiet hours, stop on reply/opt-out.
42. **Auto-archive stale applicants** after N days + digest of what was
    archived.
43. **Instant new-applicant alert** (push/SMS) — first-hour response wins
    driver hiring.
44. **Daily digest email** ("33 need action") with deep links.
45. **Auto-send booking link** above a score threshold (opt-in).
46. **No-show recovery** — auto re-invite when Interview Day marks a
    no-show.
47. **Waitlist mode** — no open interview slots → queue and auto-invite
    when slots open.
48. **Duplicate detection** (same phone/email) with a merge UI.
49. **Auto-tag test rows** (example.com emails, 555 numbers — "Test
    Applicant" sits in the live list) and exclude them from KPIs.
50. **Hire goal + pace** — monthly target tracked in the sidebar funnel.

## F. Data model (F#51–60)

51. **BUG-ish: real `stage_entered_at` history** — `_stageAnchorIso` uses
    `last_sms_at` for booking_pending, so resending the link *resets*
    "Waiting Nd"; record true stage transitions.
52. **Server-side video-watched flag** (localStorage-only today — lost
    across devices/staff).
53. **Triage ranking server-side** in `pipeline_list` so order is
    consistent and pageable.
54. **One RPC round trip** — merge `pipeline_list` + `pipeline_counts`.
55. **Server-side search/pagination args** on `pipeline_list`.
56. **Outcome/decline analytics table.**
57. **Offer-stage columns** if the Offer node stays (pairs with F#21).
58. **`last_email_at` column** (pairs with F#36).
59. **Applicant tags** (text[]) + filter chips.
60. **`applied_at` vs `created_at`** for CSV-imported applicants so ages
    read the true application date, not the import date.

## G. Analytics & KPIs (F#61–70)

61. **Time-to-hire** (median applied→hired) in the sidebar.
62. **Median time-in-stage per stage** — find the bottleneck.
63. **Trend deltas** vs the prior window on funnel rows (▲/▼).
64. **Source performance** (applicants→hires by source).
65. **Drop-off reason chart** (needs F#34).
66. **Speed-to-first-contact KPI.**
67. **Weekly cohort strip** — applied per week and where they are now.
68. **Clickable funnel sidebar rows** → filter the list to that cohort.
69. **BUG: show-rate / hire-rate render nowhere** — `loadPipelineKpis`
    computes them every load but `hp-show-rate`/`hp-hire-rate` hosts no
    longer exist in any markup; resurface in the sidebar.
70. **Print/PDF funnel report.**

## H. Accessibility & keyboard (F#71–80)

71. **aria-label the 5-dot timeline** ("Stage 3 of 5 · Interview") —
    color-only today.
72. **Enter/Space opens the record drawer** from a focused card
    (cards have tabindex=0 but no key handler).
73. **j/k card navigation** + action hotkeys.
74. **aria-live announcements** for action results and list refreshes.
75. **Focus restoration** across `loadPipeline` innerHTML wipes.
76. **Stage chips as a real tablist** (role/aria-selected).
77. **sr-only text for the amber overdue chip.**
78. **Contrast pass** on `--text-subtle` at `--fs-xs`.
79. **prefers-reduced-motion** for skeleton shimmer / progress animation.
80. **≥44px touch targets** for the icon action row.

## I. Performance & robustness (F#81–90)

81. **Patch one card after an action** instead of refetching the whole
    list (`_rrPipelineById` already caches the row).
82. **BUG: out-of-order loads** — rapid stage-tab clicks have no request
    token; stage A's slow response can paint over stage B.
83. **BUG: failed load leaves skeletons forever** — `loadPipeline`'s
    error path toasts and returns with the skeleton still in place; add
    an error state + Retry.
84. **Stale-while-revalidate** — repaint instantly from cache on tab
    switch, refresh behind (today: 4-skeleton flash every switch).
85. **`content-visibility:auto`** on cards for long lists.
86. **Scope realtime refresh** — applicants-table events should only
    reload the pipeline when the pipeline view is visible.
87. **Debounce the body ResizeObserver refit** (`_rrRefit`).
88. **Skeletons matching the real 5-column layout** (no CLS).
89. **Add-applicant validation** — junk names ("New Years" is live),
    E.164 phone check, email normalization.
90. **Playwright e2e for the funnel** (stubbed like tests/login-e2e):
    tabs, CTA→composer, decline, empty states.

## J. Polish & hygiene (F#91–100)

91. **BUG: frag markup typo** — booking-pending mock card's "Immediately"
    answer uses class `pa-qa-q` (should be `pa-qa-a`),
    view-pipeline.frag:179.
92. **Retire the mock seeded cards** in view-pipeline.frag (Marcus Hill…)
    — they can flash before the live paint; start with skeletons.
93. **Stage-specific empty states** per chip ("No one is in screening —
    invites appear here once sent").
94. **First-run zero state** — apply link + QR + Add applicant + CSV
    import, instead of one text line.
95. **Single source of truth for counts** — chips vs "Applicants (N)"
    header can disagree once the 200 cap bites.
96. **One vocabulary** — chip "Screening" vs pill "Screened" vs sidebar
    "Screening passed".
97. **Persist the KPI window toggle** (Week / 4wk / All) and relabel
    "All" (it's 3650d).
98. **Right-rail behavior** — sticky funnel panel; collapse on narrow
    screens.
99. **Printable applicant one-pager** for interview-day clipboards.
100. **Tab-title + nav badges** — "Onboarding · 33 need action" in
     document.title and a count on the sidebar nav item.
