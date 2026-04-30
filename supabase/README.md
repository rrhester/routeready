# RouteReady — Supabase migration

This folder contains everything needed to stand up the new Supabase backend
that replaces the Google Apps Script + Google Sheets system.

## What's here right now

```
supabase/
├── migrations/
│   ├── 0001_init.sql      # 24 tables, indexes, types, seed data (question_bank)
│   └── 0002_rls.sql       # Row Level Security — every table scoped by dsp_id
├── functions/             # (empty — Edge Functions go here later)
└── README.md              # this file
```

## What still needs to be written

In rough order:

1. `0003_views.sql` — Postgres views for the heavy read queries
   (decision view, coaching queue, weekly totals, morning briefing).
   These replace the in-JS aggregations from the Apps Script.
2. `functions/` — one Edge Function per `?action=...` endpoint
   (~55 endpoints, ~15 of which are the public applicant flow).
3. `cron.sql` — pg_cron schedules to replace the Apps Script time triggers
   (daily 6:45am intelligence, queue drain, referral outreach, etc.).
4. Frontend changes — swap the Apps Script URL in `dashboard.html`,
   `record.html`, etc. for Supabase Edge Function URLs, plus add
   Supabase Auth login on the dashboard.

I'll produce these one at a time as we go, in that order.

## What you need to do on your side, in order

### 1. Rotate the Claude API key — DO THIS FIRST

The `CONFIG.CLAUDE_API_KEY` in your Apps Script was pasted into chat.
Even though I'm the only one who saw it, treat it as compromised.

- Go to https://console.anthropic.com/settings/keys
- Revoke the key starting `sk-ant-api03-54A5AeD9Q…`
- Create a new one. Don't paste it back into chat. We'll add it to
  Supabase secrets directly when the time comes.

### 2. Create a Supabase account + project

- Sign up at https://supabase.com (the free tier is fine to start)
- Create one project. Pick the region closest to you.
- Save the project URL and the `anon` key — you'll need both for the frontend.
- Save the `service_role` key in a password manager. It bypasses
  all security, so it stays out of the frontend forever.

### 3. Run the migrations

In the Supabase dashboard:

- Open the **SQL Editor**
- Paste the entire contents of `0001_init.sql`. Run it. (Should take ~2 seconds.)
- Paste the entire contents of `0002_rls.sql`. Run it.

You should now see all 24 tables in **Table Editor**, and `question_bank`
should already have 14 rows in it.

### 4. Create your first DSP (yourself)

In the SQL Editor, run:

```sql
-- Replace with your real values
insert into public.dsps (name, slug, primary_phone, support_email)
values ('Aircapital', 'aircapital', '+15551234567', 'support@gorouteready.com')
returning id;
```

Save the returned UUID. You'll need it in the next step.

Then sign yourself up via Supabase Auth (Authentication → Users → Add User → Create new user with email).

Finally, link your auth user to your DSP:

```sql
-- Replace with your auth user UUID and the DSP UUID from above
insert into public.profiles (user_id, dsp_id, full_name, role)
values ('<your-auth-user-uuid>', '<your-dsp-uuid>', 'Mark', 'owner');
```

### 5. Create a Resend account

- Sign up at https://resend.com (free tier: 3000 emails/month)
- Verify your domain `gorouteready.com` (15-minute DNS setup)
- Create an API key, save it. We'll add it to Supabase secrets later.

### 6. Tell me when steps 1–5 are done

Once Supabase is up with the schema running and you have a DSP + a user
profile, message me and I'll start producing the Edge Functions, beginning
with the dashboard read endpoint (the equivalent of the current
`doGet` payload).

## Decisions locked in

- **Multi-tenant.** Every per-DSP table has a `dsp_id` and RLS.
  Up to ~100 DSPs in one project.
- **Fresh start.** No data migration from the existing spreadsheet.
  The spreadsheet stays as a read-only archive.
- **Frontend stays on Netlify.** Just the `fetch()` URLs change.
- **Email via Resend.** `GmailApp` doesn't exist outside Apps Script.
- **Auth via Supabase Auth.** The old SHA-256 dashboard password
  is replaced by Supabase email/password login. The `DashboardPasswordHash`
  setting is dropped from the schema.

## What changes architecturally

| Old (Apps Script) | New (Supabase) |
|---|---|
| Google Sheets tabs | Postgres tables (with `dsp_id` everywhere) |
| `doGet` / `doPost` with `?action=` | Individual Edge Functions per action |
| `getSetting()` / `setSetting()` | `settings` table (key-value per DSP) |
| Time-based triggers | `pg_cron` schedules |
| `GmailApp.sendEmail` | Resend HTTP API |
| Single SHA-256 password | Supabase Auth (email + password) |
| `CacheService` (5-min cache) | Dropped — Postgres is fast enough |
| Whole-sheet reads + JS aggregation | SQL views + indexes |
| Apps Script web app URL | Edge Function URLs (one per action) |
| R2 presigned URLs | Same — code ports almost verbatim to Deno |
| Twilio (UrlFetchApp) | Same — fetch() in Edge Function |
| Claude API (UrlFetchApp) | Same — fetch() in Edge Function |
| Cal.com proxy | Same — fetch() in Edge Function |
