# Endpoint map: Apps Script → Supabase Edge Functions

Every `?action=...` from the current Apps Script `doGet`/`doPost` becomes its
own Supabase Edge Function. This file is the working checklist.

**Auth column key:**
- `dashboard` = requires logged-in DSP user (uses anon key + JWT)
- `public`    = no auth, called from `record.html` etc. (uses anon key only;
                Edge Function validates the applicant_token)
- `cron`      = called only by pg_cron, never from outside
- `webhook`   = called by external services (Cal.com, Twilio status callbacks)

**Status column key:**
- `todo` — not started
- `wip`  — in progress
- `done` — deployed and tested

## Dashboard reads

| Action | Auth | Status | Notes |
|---|---|---|---|
| `getDashboard` (replaces unkeyed `doGet`) | dashboard | todo | The big one — replaces the entire `payload` object built at the bottom of `doGet`. Becomes a single query joining applicants + recent screening + counts + settings. |
| `getCalSchedule` | dashboard | todo | Proxies Cal.com v2 `/schedules/:id` |
| `getSchedule` | dashboard | todo | Proxies `buildCalSchedulePayload()` (bookings + overrides) |
| `getReferralSettings` | dashboard | todo | Reads 4 settings rows |
| `bonusReport` | dashboard | todo | Aggregates `referrals` table, returns by status |
| `bonusReportCsv` | dashboard | todo | CSV version of `bonusReport` |
| `exportDataCounts` | dashboard | todo | Counts per export type |
| `exportData` (`type=applicants\|hired\|history\|bonus`) | dashboard | todo | CSV download |
| `getScreeningQuestions` | dashboard | todo | Joins `screening_selections` + `question_bank` |

## Dashboard writes

| Action | Auth | Status | Notes |
|---|---|---|---|
| `saveSettings` | dashboard | todo | Upsert into `settings` table |
| `setThrottle` | dashboard | todo | Two settings rows |
| `markHired` | dashboard | todo | Updates applicant + triggers Claude eval + referral promotion + own-referral-code generation |
| `markNoShow` | dashboard | todo | Updates applicant + triggers Claude eval |
| `markNotHired` | dashboard | todo | Updates applicant + triggers Claude eval |
| `resendCalLink` | dashboard | todo | Re-sends booking link via SMS+email |
| `resendScreening` | dashboard | todo | Re-sends screening link |
| `moveToWaitlist` | dashboard | todo | Status change + waitlist insert |
| `dismissStale` | dashboard | todo | Insert into `dismissals` |
| `addApplicant` | dashboard | todo | Manual applicant entry, three stages |
| `closeCycle` | dashboard | todo | Snapshot to `cycle_archive` + delete actioned applicants + bump cycle_number |
| `blockCalDate` / `unblockCalDate` | dashboard | todo | Cal.com API |
| `saveReferralSettings` | dashboard | todo | Upsert 4 settings |
| `markBonusPaid` | dashboard | todo | Update referral row |
| `saveScreeningQuestions` | dashboard | todo | Replace screening_selections rows for this DSP |
| `aiReviewScreeningQuestion` | dashboard | todo | Claude proxy, server-side prompt |
| `sendManualMessage` | dashboard | todo | Insert message_queue row, trigger drain |
| `saveMessageTemplates` | dashboard | todo | Upsert message_templates rows |
| `aiWriteMessage` | dashboard | todo | Claude proxy, server-side prompt |
| `updateCalSchedule` | dashboard | todo | Cal.com PATCH |

## Coaching / performance (dashboard reads)

| Action | Auth | Status | Notes |
|---|---|---|---|
| `getDriverRoster` | dashboard | todo | Driver autocomplete |
| `coachingQueue` | dashboard | todo | SQL view |
| `weeklyTotals` | dashboard | todo | SQL view |
| `decisionView` | dashboard | todo | Old composite view (likely retire) |
| `decisionViewV2` | dashboard | todo | Composite scoring view |
| `decisionViewTiered` | dashboard | todo | Tier 1/2/3 view (current production) |
| `getDriverMath` | dashboard | todo | Per-driver math breakdown |
| `getMorningPerformance` | dashboard | todo | 7AM briefing data |
| `driverRecentActivity` | dashboard | todo | Per-driver timeline (5 most recent) |
| `driversList` | dashboard | todo | Full drivers list view |
| `driverRecord` | dashboard | todo | Full coaching record + timeline |

## Coaching / performance (dashboard writes)

| Action | Auth | Status | Notes |
|---|---|---|---|
| `coachDriver` | dashboard | todo | Twilio SMS + insert coaching_log |
| `generateCoachingMessage` | dashboard | todo | Claude proxy |
| `uploadCoachingAttachment` | dashboard | todo | Becomes presigned R2 URL (no base64 round-trip) |
| `sendCoaching` | dashboard | todo | Twilio + log multiple events |
| `logFormalOneOnOne` | dashboard | todo | Insert coaching_log InPerson row |
| `logInPerson` | dashboard | todo | Same as above (older alias?) |
| `skipCoaching` | dashboard | todo | Insert coaching_log Skipped row |
| `setDriverStatus` | dashboard | todo | Update driver_roster + log StatusChange |
| `updateDriverPhone` | dashboard | todo | Update driver_roster |

## Public applicant flow (record.html)

| Action | Auth | Status | Notes |
|---|---|---|---|
| `getRecordConfig` | public | todo | Resolves DSP from token, returns prompts + form questions |
| `getR2UploadUrl` | public | todo | Generates presigned PUT URL — port `r2PresignPutUrl` to Deno |
| `uploadVideoComplete` | public | todo | (legacy Drive path — drop, R2 only) |
| `finalizeApplication` | public | todo | Server-side filter check, applicant insert, video URL save, SMS confirm |
| `sendVideoLink` | dashboard | todo | Generates token, SMS or email link |
| `videoApprove` | dashboard | todo | Marks applicant.video_status = 'Approved' |

## Cron (replaces Apps Script time triggers)

| Schedule | Function | Status | Notes |
|---|---|---|---|
| Daily 6:45am | `runDailyIntelligence` | todo | Builds snapshot, calls Claude, writes settings |
| Daily 8am | `sendOrientationReminders` | todo | T-2 and T-0 reminders |
| Daily 9am | `sendReferralOutreach` | todo | Day-N referral outreach SMS |
| Daily 9:10am | `updateBonusStatuses` | todo | Pending → Owed |
| Every 5min | `processPendingVideoTranscriptions` | todo | (placeholder for now — manual review) |
| Every 5min | `drainQueue` | todo | Sends pending message_queue rows |

## Webhooks

| Action | Auth | Status | Notes |
|---|---|---|---|
| Cal.com → `BOOKING_CREATED` | webhook | todo | Marks applicant Booked |
| Cal.com → `BOOKING_CANCELLED` | webhook | todo | Promotes from waitlist |
| Twilio status callback | webhook | todo | Update message_queue.status, log failures |

## Things being intentionally dropped

- `getAllMessageTemplates_` — folded into `getDashboard`
- `dismissStaleBooking` Apps Script logic for sheet-creation — table already exists
- `clearVideoChunks` — chunked upload path is dead
- `createUploadSession`, `uploadVideoChunk`, `assembleChunks` — superseded by direct R2 PUT
- `setupSheets`, `setupVideoScreening`, `setupScreeningTabs`, `runSetup`, `installVideoTrigger`, `setupTrigger` — replaced by SQL migrations + pg_cron
- `beautifySheets` — irrelevant
- `processIngest` — manual Indeed CSV import; if you still need it, becomes a small Edge Function with a CSV body

## Open questions for later sprints

- **Claude audio transcription**: current code is a stub. Decide whether to use OpenAI Whisper, AssemblyAI, or Claude when audio support stabilizes.
- **R2 vs Supabase Storage** for coaching attachments: R2 is already wired, but Supabase Storage would be one less moving part. Pick later.
- **Per-DSP signup flow**: when a new DSP signs up, what triggers default `screening_selections` and `message_templates` rows? Probably a database trigger on `dsps` insert.
