# Email (Fleet Bridge) — 100 improvements (2026-07-22)

Improvement list for the Email page: the two-level header + unified
three-pane workspace (`dashboard/views/view-email.frag`), the email IIFE
in `dashboard/live.js` (~94968–97272: folders / message list / reading
pane / Documents pseudo-folder / composer / popout), and the server side
— `send-email`, `webhook-email-inbound`, `webhook-email-events` edge
functions and migrations 0317–0321 (+ 0095-era `email_messages`).
Reference items as `EM#NN` to avoid clashing with the workbook `#NN`,
calendar, Targets `TG#NN`, and project-review `PR#NN` lists.

Anchors are approximate, verified against the code 2026-07-22 (post
Email-redesign merge #4113). Impact tags: **[high]** = operators lose
mail, reply to the wrong person, or read wrong state; **[med]** = worth
scheduling; **[low]** = polish.

**STATUS (2026-07-25): Batches A–E (EM#1–58) + EM#74 SHIPPED — the
first 58 items are done.** E2b notes: EM#51 signatures and EM#52
composer templates ship as per-user/per-DSP localStorage v1s (auto-
append on new mail; save-current-as-template with insert/delete) — the
Settings-managed, DSP-wide versions belong to EM#98. EM#53 adds
lists/link/undo/redo riding the existing data-fmt wiring (createLink
forces https/mailto + target=_blank rel=noopener; the execCommand exit
remains future work as the item allows). EM#54 sanitizes pasted rich
content to an allowlist (scripts/images/handlers/mso-styles stripped,
javascript: hrefs dropped, safe inline styles kept) — QA proves a
pasted <script> cannot run and a tracking pixel never enters
body_html. E2a notes (**migration
0538**: send_after + importance): EM#57 undo-send uses a DRAFT-HOLD
model — Send writes the row as a draft and promotes it to queued after
a 10s countdown pill; Undo reopens the composer (attachments +
importance restored — QA caught that gap live); a hidden/pagehide
flush promotes immediately, so a dying tab leaves the mail visibly in
Drafts, never silently unsent. Skipped for scheduled sends and
hook-driven composers (funnel/calendar). EM#58 scheduled rows show a
Scheduled pill + "Scheduled for … Cancel" in the preview (Cancel →
back to Drafts); the drain skips future send_after (pre-0538-tolerant
retry). EM#55 pre-0538 falls back to the ❗ prefix. EM#49 attaches
document-intake originals (own:false — never cleaned up by the
composer; send-email re-signs per-bucket). EM#50: 25MB/15-file caps,
pending chips, send blocks mid-upload. Remaining in E: EM#51
signatures, EM#52 templates, EM#53 toolbar, EM#54 paste sanitation
(E2b). E1 notes: recipient chips replace the single-address inputs
(multi-To joins into `to_email`; `send-email` splits it for Resend);
Bcc is **migration 0537** (`bcc_emails` + the `'draft'` enum value) and
is never silently dropped pre-migration — the send fails with a clear
message instead. Real drafts: autosave every 4s into the Drafts system
folder, close-keeps-draft (Escape can no longer destroy typed mail —
the ribbon Delete tile is the discard path), clicking a draft resumes
the composer, Send PROMOTES the same row to queued (no duplicates).
Autocomplete pool = contacts + applicants + drivers + loaded-folder
addresses, 5-min cache. QA also caught and fixed a live regression:
Escape with the dropdown open used to close the whole composer.
NOTE: apply 0536 and **0537** together — the select's FULL tier now
includes bcc_emails, so a 0536-only DB demotes to the MID tier
(correct data, but star/snooze UI hidden) until 0537 lands. D2 notes: EM#33 shipped as the client-side v1 the item
allows for — the reading pane shows the full conversation (same
normalized subject + same counterpart address, fetched across folders so
the Sent half appears beside the inbound half) as collapsible items;
same-folder LIST collapse and true Message-ID threads wait on EM#76's
header stamping. EM#38/39 live in a read-bar "More ⋯" overflow (print
window + .eml download, multipart when body_html exists). EM#40 opens
the Contacts rail create-form prefilled (name + address). EM#41 chips:
Applicant (via applicant_id, name fetched) → opens the applicant email
thread modal; Repair case (via the 0490 timeline payload) →
RRRepair.openCase. D1 notes: the HTML view (EM#34) is
opt-in per the review — plain text stays the default; body_html renders
ONLY inside a fully-sandboxed iframe (no allow-scripts / no
allow-same-origin) whose srcdoc carries its own `default-src 'none'`
CSP, with remote images blocked until a per-message "Show images"
click (verified in QA: an embedded `<script>` cannot run and a tracker
pixel cannot load). EM#36 shipped with EM#74 (Retry flips
failed→queued for the drain). EM#37's chips re-sign via storage_path
so week-old sends still open. `delivered_at` joined all three select
tiers (0002-era column — safe everywhere). Remaining in D: EM#33
threading, EM#38 print, EM#39 export, EM#40 add-to-contacts, EM#41
context chips (D2). C2 notes: **migration 0536** adds
is_starred/snoozed_until/from_name/has_attachments (+ backfills from
document_intake and the attachments jsonb). The select is now THREE
tiers (FULL 0536 → MID 0535 → LEGACY) so a 0535-but-not-0536 DB
degrades one step without losing server read state. Starred + Snoozed
are VIRTUAL views (`__starred__`/`__snoozed__`, same pattern as
Documents) — guards keep them out of move targets/undo sources/badge
counts. Snooze presets: +4h / tomorrow 8am / next Monday 8am, undo
clears the wake time. webhook-email-inbound stamps
from_name/has_attachments with a legacy-column insert retry so a
pre-0536 DB never drops mail. C1 notes: pagination is a
"Load 200 more" tail row over `.range()` pages sharing the EM#1 race
guard; bulk PATCHes chunk `.in()` at 100 ids; the undo bar (8s, one
slot) covers hover-trash, read-bar moves, drag, popout AND bulk — with
success toasts suppressed it is the only feedback a move happened.
Found while QA'ing EM#23: mock-wiring's global **'c' shortcut opened
the coach drawer from ANY view and stole focus even while typing in
contenteditables** (email composer body, notebooks) — its guard now
covers contenteditable + the email view/overlays. Remaining from C:
EM#24/25/26/28 (star, snooze, paperclip, sender names) ship as C2 with
migration 0536. EM#23's `/`-focuses-search ergonomics stay with EM#71.
Batch B notes: read state is server-side via **migration 0535**
(`email_messages.is_read`, team-inbox semantics — any operator reading
a message marks it handled for the DSP; one-shot backfill starts
existing mail read; graceful localStorage fallback pre-migration, one
failed probe stops further is_read queries). Folder badges upgraded
from "new since last visited" to true unread counts post-0535. EM#16
shipped as a nav DOT + tooltip count, not a numeric pill — house rule
(operator: dots not counts on nav; the retired `.nav-badge` family).
EM#17 shipped client-side (browser Notification on inbound while a
dashboard tab is open, strict opt-in via the ⋮ menu); phone push stays
with the notifications backlog. EM#18 replaced the per-active-folder
realtime subscription with one DSP-wide channel (narrow at
query/render, the Wave F rule) + 300ms coalescing (most of EM#93).
EM#20's pill: INSERT into the folder being read while scrolled → "N new
messages — show" instead of a scroll-jumping re-render.

**STATUS (2026-07-22, earlier): Batch A (EM#1–12) SHIPPED** — all twelve
correctness fixes. Notes: EM#6 turned out worse than written — the 0321
`parent_id` FK is ON DELETE **CASCADE**, so deleting a parent silently
wiped the whole subtree (children now re-parent up a level first).
EM#11 shipped as the honest partial ("N of M messages" via one exact
count at the 200 cap); exact-count-everywhere still lands with EM#66's
counts RPC. EM#4/EM#35 shipped together (`cc_emails` selected with a
pre-0319 fallback + rendered in preview/popout). EM#7 spans client
(`storage_path` in the queued row) + `send-email` (re-signs fresh at
send time; auto-deploys, backward-safe for old rows).

Context worth knowing:

- Messages live in `public.email_messages` (the legacy transactional
  log grew folders); the 0317 `fb_messages`/`fb_attachments`/
  `fb_settings` tables were never adopted and hold no data.
- Success toasts are suppressed app-wide (operator request) — several
  items below exist because destructive actions now have *no* feedback
  channel at all.
- Read state, folder badges, sort/filter/collapse prefs are all
  localStorage-only (per browser, per device).
- The send pipeline is queue-based: composer inserts `status='queued'`,
  a trigger/cron drains via Resend. Statuses (`queued/sending/sent/
  failed`, plus `delivered_at`/`error_code` from webhook-email-events)
  exist in the DB but the Fleet Bridge UI renders none of them.

---

## A. Correctness bugs (1–12)

1. **Folder-switch race can paint the wrong folder's mail** —
   `selectFolder` awaits `loadMessages()` with no request-generation
   guard (`live.js:95903`, `95104`). Click folder A then quickly folder
   B: A's slower response resolves last and overwrites `state.messages`
   under B's title. Same hazard between `refreshMail` and a folder
   click. Tag each load with a token and drop stale resolutions. [high]

2. **Failed sends look sent** — the composer files outbound mail into
   the Sent folder at *queue* time (`sendComposerDraft`,
   `live.js:96425`), and `messageRowHtml`/`renderPreview` never render
   `status`. A `failed` row (Resend error, bad address) sits in Sent
   indistinguishable from delivered mail — the operator believes the
   vendor was told. Render status pills (queued/sending/failed) and
   give failed rows a red treatment. [high]

3. **Reply from the Sent folder targets yourself** — reply/reply-all
   prefill `to = original.from_email` (`live.js:96097`). For an
   outbound row that's the DSP's own team address (stamped by
   send-email at send time), or empty pre-send. Replying to a sent
   message should target its `to_email`. Make the prefill
   direction-aware. [high]

4. **Reply-all's Cc carry-over is silently broken** — `openComposer`
   reads `original.cc_emails` (`live.js:96103`) but `loadMessages`
   never selects that column (`live.js:95108`), so it's always
   `undefined` and reply-all degrades to plain reply without any hint.
   Add `cc_emails` to the select (and see EM#35 for showing it). [high]

5. **Double-send via the ribbon Send tile** — `sendComposerDraft`
   disables only the bottom `#rr-em-composer-send` button
   (`live.js:96422`); the top ribbon Send tile stays live while the
   insert is in flight, and a second click queues a second copy. Guard
   with one in-flight flag covering every entry point (both buttons +
   Cmd/Ctrl+Enter). [high]

6. **Deleting a folder orphans its subfolders** — `deleteFolder`
   re-parents *messages* to Inbox but not child folders
   (`live.js:96031`). Children keep a dead `parent_id`, and
   `renderBranch` only walks reachable parents — the orphaned subtree
   (and every message filed in it) simply vanishes from the aside.
   Re-parent children to the deleted folder's parent, or refuse to
   delete a folder that has children. [high]

7. **Composer attachments expire before stubborn sends** — files are
   signed for 7 days at pick time (`live.js:96336`) and the signed URL
   is frozen into `email_messages.attachments`. A failed→requeued row
   older than that sends without its files (Resend's fetch 403s,
   best-effort drop). Store `storage_path` and re-sign in `send-email`
   at send time — it already does exactly this for message-attachments
   (`send-email/index.ts:231`). [med]

8. **Abandoned composer uploads are orphaned** — attachments upload to
   `fleet-bridge-attachments` the moment they're picked
   (`live.js:96329`), but removing a chip or closing the composer never
   deletes the object. Storage accretes invisible files forever. Delete
   on chip-remove/close, or defer the upload to send time. [med]

9. **Your own sends count as "new mail"** — folder badges count rows
   `created_at > last-viewed` with no direction filter
   (`loadFolderCounts`, `live.js:95139`), so every outbound email ticks
   the Sent badge as if new mail arrived. Exclude
   `direction='outbound'` from the "new" approximation. [med]

10. **HTML-only messages are half-invisible** — snippet, client search,
    and reply quoting all read `body_text` only (`live.js:95430`,
    `95339`, `96076`). Rows whose text is null (some imports/outbound)
    show no snippet, can't be found by body search, and quote nothing
    into replies. Derive a stripped-tags fallback from `body_html` once
    per message. [med]

11. **The Unread tab count lies past 200** — `unreadCount` is computed
    over the loaded page (`live.js:95354`), which is capped at 200
    (EM#21). The header count ("N messages") has the same cap-blindness.
    Use server counts (pairs with EM#66's counts RPC). [med]

12. **Double-click the account chip copies the flash text** —
    `copyTeamAddress` reads the *DOM* label (`live.js:96541`), which
    reads "Copied to clipboard" for 1.4s after a click; a second click
    within the window writes that literal string to the clipboard.
    Keep the address in state, not the label. [low]

## B. Read state & notifications (13–20)

13. **Server-side read state** — reads live in a localStorage set capped
    at 5000 (`live.js:95041`): a second device/browser shows everything
    unread, and cap-eviction resurrects "unread" on old mail.
    Migration: `is_read boolean` on `email_messages` (or a per-user
    receipts table if per-operator state matters), write-through on
    select, backfill from nothing gracefully. [high]

14. **Mark as unread** — no way to flip a message back to unread (the
    universal "deal with this later" gesture). Add to the read bar and
    the row hover actions. [med]

15. **Mark all read** — per folder, one click (header or ⋮ menu). [med]

16. **Unread badge on the sidebar Email nav** — operators only learn
    about vendor mail by visiting the page. Surface the Inbox unread
    count on the app nav item (needs EM#13/EM#66 to be honest). [high]

17. **Push/desktop notification opt-in for inbound mail** — the
    push-fanout infrastructure exists for the messages system; offer
    "notify me on new Fleet Bridge mail" per operator. [med]

18. **Live badges for non-active folders** — the realtime subscription
    filters to the active folder only (`subscribeRealtime`,
    `live.js:95184`), so mail arriving in other folders moves no badge
    until a manual refresh. Subscribe once per DSP (no folder filter —
    RLS + dsp scoping already bound it) and patch counts client-side.
    [med]

19. **Cross-tab consistency** — two dashboard tabs disagree on
    read/badges until reload; listen to `storage` events (or lean on
    EM#13 + realtime) so state converges. [low]

20. **Calm new-mail arrival** — a realtime insert re-renders the list
    under the operator (scroll jump, selection flicker mid-triage).
    Show an inline "1 new message" pill that prepends on click,
    preserving scroll. [med]

## C. Message list (21–32)

21. **Pagination past 200** — `loadMessages` hard-caps at 200
    (`live.js:95111`) and silently truncates; older mail is
    unreachable from the UI entirely. Infinite scroll or a "Load 200
    more" tail row. [high]

22. **Multi-select + bulk actions** — no way to archive/delete/move/
    mark-read more than one message at a time. Checkbox-on-hover +
    shift-click ranges + a bulk action bar. [high]

23. **List keyboard navigation** — zero keyboard support today: ↑/↓ to
    move selection, Enter to open, E archive, Del trash, C compose
    (Gmail muscle memory). Pairs with EM#89's semantics. [med]

24. **Star/flag + a Starred view** — no way to pin important vendor
    threads. Small migration (`is_starred` or per-user), row toggle,
    virtual "Starred" entry in the aside. [med]

25. **Snooze** — hide a message until a chosen time ("resurface Friday
    before the parts order"). `snoozed_until` column + a filter in
    `loadMessages` + a Snoozed virtual folder. [low]

26. **Attachment indicator on rows** — attachments are invisible until
    the message is opened. A paperclip glyph needs a cheap
    `has_attachments` flag stamped by the webhook (or a one-shot join
    on `document_intake`). [med]

27. **Direction affordance in mixed folders** — Sent rows and inbound
    rows render an identical bare address (`live.js:95428`). Prefix
    sent-direction rows with "To:" the way Gmail does, so Archive and
    custom folders read correctly. [med]

28. **Sender display names** — the webhook extracts a sender name for
    `document_intake` but `email_messages` stores only `from_email`;
    the list reads `ap@parts-warehouse-inc.com` instead of "Bob at
    Parts Warehouse". Add `from_name`, stamp it on insert, render
    name-first. [med]

29. **Absolute time on hover** — relative stamps ("3d") need a `title`
    with the full date; switch to absolute display past a week
    (`formatRelative` already falls back after 7d — add the tooltip
    everywhere). [low]

30. **Density toggle** — 3-line rows burn vertical space during triage;
    offer compact (1-line) / comfortable, persisted like sort/filter.
    [low]

31. **Undo for destructive moves** — hover-trash fires instantly, and
    with success toasts suppressed app-wide there is *no feedback at
    all* — the row just vanishes. Show an inline "Moved to Trash ·
    Undo" pill in the list header for ~8s. [high]

32. **First-run empty state teaches the address** — "Your inbox is
    clear" tells a new operator nothing; the empty Inbox should show
    the team address, "mail sent here lands in this inbox", a copy
    button, and — when `short_code` is unset so no address exists — a
    link to Settings to set one (today that hint hides in a tooltip
    and a copy-failure toast). [med]

## D. Reading pane & threading (33–42)

33. **Conversation threading** — every reply renders as an isolated
    row; a 6-email vendor negotiation is 6 rows scattered through the
    list. `provider_message_id` exists on inbound; add `in_reply_to`
    stamping (EM#76) and group by thread in the list + reading pane.
    [high]

34. **Sanitized HTML rendering** — plaintext-only is a sound default,
    but real vendor mail (quotes, order confirmations, tables) turns
    to mush. Render `body_html` through a strict allowlist sanitizer
    into a sandboxed iframe, images blocked until "Show images"
    (tracking pixels stay dead by default). [high]

35. **Show Cc in the preview header** — `cc_emails` is neither selected
    nor rendered (`renderPreview`, `live.js:95508`); an operator can't
    see who else was on the email they're reading. (Select fix shared
    with EM#4.) [med]

36. **Delivery status line for outbound** — `sent_at`, `delivered_at`,
    bounce `error_code`/`error_message` are all in the row and never
    shown. A one-liner under the meta ("Delivered 3:42 PM" / "Bounced:
    mailbox full · Retry") closes the "did they get it?" loop. [high]

37. **Render outbound attachments** — the preview fetches inbound
    attachment chips from `document_intake` but ignores the
    `attachments` jsonb on outbound rows (`live.js:95525`) — a sent
    email shows no trace of the files it carried. [med]

38. **Print message** — operators file paperwork; there's no print
    path (the popout is a styled div, not print-formatted). Print CSS
    or a print button on the read bar. [low]

39. **Export .eml / PDF** — downloading a message for an insurer /
    Amazon dispute is impossible today. [low]

40. **"Add sender to Contacts"** — the Contacts directory is one nav
    tab away, but there's no action to capture a new vendor from the
    email that introduced them. One-click add with name (EM#28) +
    address prefilled. [med]

41. **Context chips for matched mail** — inbound rows matched to an
    applicant carry `applicant_id`; repair-matched mail is linked to a
    case (0490). The preview shows neither. Chip: "Applicant · Jane
    Doe → open thread" / "Repair case #1042 → open" so the three views
    stop being parallel universes. [med]

42. **Reading-pane text zoom** — long vendor emails at a fixed 13px;
    small A−/A+ control, persisted. [low]

## E. Composer (43–58)

43. **Multiple To recipients** — the To field is a single
    `type=email` input (`live.js:96171`) and `send-email` ships
    `to: [row.to_email]` — one recipient, hard stop. Chip-based To
    with comma/semicolon paste, validated per-chip; send the array
    (column is `text` today — either join or migrate to `to_emails`).
    [high]

44. **Bcc** — no field, no column on `email_messages` (0317's unused
    `fb_messages` had one). Tiny migration + composer row + drain
    support. [med]

45. **Recipient autocomplete** — the app knows every contact, vendor,
    driver, and applicant email; the composer autocompletes nothing.
    Suggest-as-you-type across those directories. [high]

46. **Real drafts in the Drafts folder** — a Drafts system folder
    exists and is permanently empty; Save writes ONE localStorage slot
    that only restores into a blank new-mail composer
    (`live.js:96208`). Insert `status='draft'` rows into the Drafts
    folder (cross-device, multiple drafts, resumable), delete on send.
    [high]

47. **Autosave + dirty-close confirm** — Escape/outside-click discards
    a half-written email instantly (`live.js:96195`). Autosave the
    draft (EM#46) every few seconds and confirm before discarding
    unsaved changes. [high]

48. **Reply-all completeness** — with multi-recipient To (EM#43),
    reply-all must merge the original's other To recipients into Cc,
    minus the team address. [med]

49. **Attach from Documents / Drive** — every attachment must be
    re-uploaded from disk; can't attach a file that just arrived in
    the Documents folder or lives in Drive. Picker sourcing
    `document_intake` + the Drive connector. [med]

50. **Attachment guardrails + progress** — no client-side size/count
    cap (Resend rejects ~40MB at send time → a silent `failed` row,
    see EM#2) and no upload progress. Validate before upload, show
    per-file progress, block send while uploads are in flight. [med]

51. **Signatures** — no signature support; every email is hand-signed.
    Per-DSP default block (name, address, phone) with per-user
    override, editable in Settings (EM#98), auto-appended. [med]

52. **Composer templates/snippets** — the Templates nav tab routes to
    *hiring* SMS/email templates; the vendor-mail composer has none.
    Canned replies ("send W-9", "insurance certificate request") with
    variable fill. [med]

53. **Links, lists, undo in the toolbar** — the ribbon covers
    B/I/U/font/color only; no `createLink`, no bullet lists, no
    undo/redo buttons (`live.js:96133`). Also plan the exit from
    deprecated `document.execCommand` while touching this. [med]

54. **Paste sanitation** — pasted rich content (Word/Outlook markup,
    remote images, tracking pixels) enters `body_html` verbatim and
    gets re-sent to vendors. Clean on paste to the toolbar's supported
    subset. [med]

55. **Real importance header** — the ❗ "High importance" tile mutates
    the *subject* (`live.js:96246`). Send actual `X-Priority` /
    `Importance` headers via Resend's `headers` param and leave the
    subject alone. [low]

56. **Discoverable shortcuts** — Cmd/Ctrl+Enter-to-send exists but is
    only hinted in the body placeholder; add it to the Send button
    tooltip and a small "?" shortcut sheet. [low]

57. **Undo send** — queued rows wait up to a minute for the drain;
    a 10-second "Undo" affordance that flips `queued→canceled` is
    nearly free and prevents the classic wrong-recipient panic. Add a
    `canceled` status the drain skips. [med]

58. **Schedule send** — "send tomorrow at 8am" (vendor timezones,
    polite hours). `send_after timestamptz` + drain respects it; the
    scheduled-messages pattern from the SMS side is the template. [low]

## F. Folders (59–66)

59. **Rename folder** — not possible; operators must delete (relocating
    every message to Inbox, EM#6) and re-create. Inline rename on the
    aside row. [med]

60. **Reorder folders** — every custom folder gets `position=100`
    (`live.js:96010`) so order is alphabetical forever. Drag to
    reorder (or Up/Down in a context menu), persist `position`. [low]

61. **Retire native prompt()/confirm() dialogs** — subfolder naming
    uses `prompt()` (`live.js:96872`), folder delete and doc dismiss
    use `confirm()`. Replace with the app's inline form / modal
    patterns (the New-folder inline form already exists as the model).
    [low]

62. **Friendly duplicate-name failures** — `fb_folders_name_uniq` is
    DSP-wide on `lower(name)` (0317), so "ACME" under two different
    parents fails with a raw Postgres message in a toast. Either scope
    uniqueness to `(dsp_id, parent_id)` (migration) or pre-check and
    say "You already have a folder called ACME". [med]

63. **Empty Trash + retention** — Trash accretes forever; there's no
    purge anywhere. "Empty trash" action + a 30-day auto-purge cron
    (and stop badging Trash/Archive as "new mail", EM#9). [med]

64. **Move-to-folder from the reading pane** — Move exists only in the
    double-click popout's menu and via drag-and-drop; the read bar has
    Archive/Delete/Reply/Forward but no Move (`readBarHtml`,
    `live.js:95460`). Filing to custom folders is the whole point of
    folders. [med]

65. **Drag-filing with a hidden folder pane** — below 1080px the aside
    auto-collapses, and drag-to-file becomes impossible (drop targets
    don't exist). Auto-reveal the pane on dragstart, or rely on EM#64.
    [low]

66. **One-query folder counts** — `loadFolderCounts` fires a
    sequential HEAD count per folder every refresh/realtime event
    (`live.js:95139`) — ~8 round-trips where one RPC with a group-by
    (folder_id × last-viewed timestamps) would do, and would also
    power the nav badge (EM#16) and honest counts (EM#11). [med]

## G. Search & filters (67–72)

67. **Server-side, all-mail search** — search filters the loaded 200
    rows of the active folder only (`live.js:95336`); mail older than
    the cap or filed elsewhere is unfindable. RPC with
    ILIKE/websearch_to_tsquery across the DSP's messages + a "Search
    all mail" scope toggle. [high]

68. **Search operators** — `from:`, `to:`, `has:attachment`,
    `before:`/`after:` parsed client-side into RPC params. [low]

69. **More filter scopes** — the All-mail select offers only Unread.
    Add Has attachments, Failed/bounced (pairs with EM#73), and
    From-unknown-senders (non-applicant, non-contact). [med]

70. **Highlight matches** — while searching, bold the matched substring
    in subject/snippet so the eye lands on why a row matched. [low]

71. **Search ergonomics** — `/` focuses the search box, Esc clears it,
    and the last query survives a folder switch (currently cleared
    state but a stale input). [low]

72. **Rules / auto-filing** — "mail from @fleetparts.com always goes to
    Vendors" — a small rules table (sender/domain/subject-contains →
    folder) applied in `webhook-email-inbound` at insert, plus a
    "Create rule from this message" action. This is the single biggest
    step toward an inbox that triages itself. [med]

## H. Send pipeline & deliverability (73–78)

73. **Bounce visibility in the list** — webhook-email-events stamps
    `delivered_at`/`error_code` (0490) but no Fleet Bridge surface
    renders them (see EM#36 for the pane). List-level red pill on
    bounced/failed rows + the EM#69 Failed filter so undelivered
    vendor mail can't hide. [high]

74. **Retry failed sends** — a failed row is a dead end today; add
    Retry (flip `failed→queued`, the drain re-picks it) with the
    stored `error_message` shown so the operator can fix the address
    first. [med]

75. **Generic delivery-event application** — `repair_email_event_apply`
    was built for the repair-quote path; verify every outbound
    `email_messages` row (not just repair mail) gets its
    delivered/bounced stamps, and widen the RPC if not. [med]

76. **Thread headers on replies** — outbound replies send no
    `In-Reply-To`/`References`, so the *vendor's* mail client starts a
    new thread every time. Carry the original's Message-ID through the
    composer into the queued row (new column) and pass Resend the
    headers; also the foundation for EM#33. [high]

77. **Subject prefix hygiene** — the Re:/Fwd: regexes only catch an
    exact leading prefix; "Re: Re: Fwd: quote" chains grow unbounded.
    Collapse to a single prefix when composing. [low]

78. **Queue health surfacing** — rows stuck in `sending` (crash
    mid-drain) are invisible until someone asks why a vendor never
    answered; 0504 added the requeue cron, but nothing tells the
    operator it fired. Show a quiet "N messages had delivery retried"
    note in the ⋮ menu / Settings email section (EM#98). [low]

## I. Inbound pipeline & server hardening (79–86)

79. **Dead-letter unknown recipients** — mail to an unrecognized
    local-part is 200-OK'd and dropped (`webhook-email-inbound:260`);
    a vendor typo'ing the team address vanishes without trace on
    either side. Store unmatched inbound in a quarantine table with a
    platform-admin view, and log daily counts. [high]

80. **Attachment caps on capture** — `_captureAttachments` fetches and
    buffers whatever arrives — no per-file size limit, no per-message
    count limit (`webhook-email-inbound:582`). A 100MB attachment or a
    50-file message hits function memory and storage unbounded. Cap
    (e.g. 25MB/file, 15 files) and log skips. [med]

81. **Inbound rate limiting** — no per-sender or per-DSP throttle: a
    runaway auto-responder loop or deliberate flood fills the inbox,
    `document_intake`, and classification spend (the AI cap protects
    the classifier but not capture/storage). Per-sender hourly cap
    with overflow → quarantine. [med]

82. **Spam signal / quarantine folder** — everything addressed
    correctly lands in Inbox. Read the forwarder's SPF/DKIM/DMARC
    verdicts where present in the payload, add a spam score, and route
    failures to a Quarantine/Junk system folder instead of Inbox.
    [med]

83. **short_code rename safety** — the printed team address is
    `<short_code>@mail…` but inbound matching prefers `dsps.slug` and
    only hits short_code in a full-table fallback scan
    (`webhook-email-inbound:242`). Renaming the code silently changes
    the address operators have given to vendors. Warn in Settings on
    change, and keep prior codes as accepted aliases. [med]

84. **Audit client-write RLS on email_messages** — the dashboard
    inserts/updates rows directly (send, move, folder-delete
    re-parent). Policies date from the transactional-log era; verify
    `with check` prevents cross-tenant `folder_id` targets and that
    update policies can't flip protected columns (status/provider) —
    tighten to the columns the UI actually needs. [med]

85. **Cap stored body size** — inbound `body_html` is stored unbounded;
    multi-MB marketing mail bloats rows and the 200-row list select
    (see EM#95). Truncate at ~512KB with a stored "truncated" marker
    the preview can disclose. [low]

86. **Retire the dead 0317 tables** — `fb_messages`, `fb_attachments`,
    and `fb_settings` (slug/linked_gmail/inbound_secret) were never
    adopted — `email_messages` won — yet three RLS'd tables + realtime
    publication entries + a storage-policy family remain to confuse
    every future migration. Drop them (or write down why they stay).
    [med]

## J. Accessibility (87–92)

87. **Invalid nested interactive elements** — folder rows and message
    rows are `<button>`s *containing* `span[role=button]` controls
    (add-subfolder / delete / trash — `folderHtml` `live.js:95264`,
    `messageRowHtml` `live.js:95439`). Nested interactive content is
    invalid HTML and screen readers announce it unpredictably.
    Restructure rows as non-button containers with real buttons
    inside. [high]

88. **Keyboard-activate the span controls** — those `tabindex="0"`
    spans have no Enter/Space handlers; keyboard users can focus
    "Delete folder" but not press it. (Solved properly by EM#87's real
    buttons.) [high]

89. **List semantics** — the message list is a div of buttons with no
    list/listbox role, no `aria-selected`, and unread conveyed only by
    bold; the folder tree isn't a `tree`/`treeitem` structure with
    `aria-expanded`. Add roles + state so EM#23's keyboard nav has
    something to build on. [med]

90. **Focus traps for composer/popout** — both overlays let Tab walk
    into the page underneath (z-index hides it visually only), and
    closing returns focus nowhere. Trap focus inside, restore to the
    invoking element on close, add `role=dialog`/`aria-modal` (the
    app's `openModal` already does this — the email overlays bypass
    it). [med]

91. **Non-visual feedback for moves** — with toasts suppressed and
    drag-and-drop mouse-only, a screen-reader user gets no
    confirmation a message moved. Route move/archive/delete
    confirmations through the existing `role=status` live region even
    when visually quiet; ship EM#64 as the keyboard path. [med]

92. **Respect prefers-reduced-motion** — the refresh spin, sparkle
    one-shots, and the <960px reading-pane slide-over all animate
    unconditionally. Gate them on the media query. [low]

## K. Performance (93–96)

93. **Coalesce realtime refreshes** — every postgres_changes event
    triggers loadMessages + loadFolderCounts (~9 queries) + three
    renders (`live.js:95188`); a queue drain of 10 sends fires the
    whole stack 10 times. Debounce ~250ms trailing. [med]

94. **Stop full-list re-renders on selection** — selecting an unread
    message rebuilds all 200 rows' innerHTML (`selectMessage` →
    `renderInbox`) to un-bold one row and tick a counter. Patch the
    affected row + tab count in place; virtualize when EM#21 raises
    the cap. [med]

95. **Drop bodies from the list select** — `loadMessages` pulls
    `body_text` AND `body_html` for all 200 rows to render a 110-char
    snippet; with EM#85-size messages that's megabytes per folder
    switch. Select a server-computed snippet (or just body_text) for
    the list and fetch the full body on select. [med]

96. **Lazy-boot the email module** — `init()` runs at DOMContentLoaded
    for every operator, serially awaiting folders → counts → messages
    (~10+ queries) even if the Email view is never opened. Defer until
    first navigation to view-email; parallelize folders+messages;
    defer counts. [med]

## L. Product & platform (97–100)

97. **Decide the station-lens story** — every operational page now
    obeys the master station switcher; Email is DSP-level (one team
    address) with no visible exemption, which reads as a bug under the
    "every page = a new DSP" directive. Either add per-station aliases
    (`dca1-ozrk@mail…` → station-tagged folders/filter) or mark the
    page "All stations · shared inbox" in the header so the exemption
    is explicit. Needs the operator's call. [med]

98. **An Email section in Settings** — the gear jumps to generic
    workspace settings; email-specific knobs are scattered or missing:
    team address (read-only + explainer), reply-to, display name,
    signature (EM#51), rules (EM#72), retention (EM#63), queue health
    (EM#78). One home. [med]

99. **Custom sending domain** — bigger DSPs will balk at
    `@mail.gorouteready.com`; Resend's domains API supports per-tenant
    verified domains. Verified-domain flow (DNS records UI, status
    polling) with the shared domain as the default. [low]

100. **Extract + test the pure core** — none of the email logic is
    under test: pull `dateBucket`, `formatRelative`, address
    parse/format, `quoteOriginal`, subject-prefix logic, and an
    html→text twin of the webhook's into an `email-core.mjs` with an
    `npm test` suite (the msg-core/cal-tz pattern), and promote the
    scratchpad `qa-email.mjs` 66-check Playwright harness into
    `tests/` so regressions on this page fail CI like everywhere else.
    [med]
