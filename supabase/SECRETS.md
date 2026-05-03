# Supabase secrets / runtime config

This file lists every env var the live RouteReady backend depends on, where
to set it, and what happens if it's missing. **Nothing in this file is
secret** — it just tells you which keys to set and where.

## 1. GitHub Actions secrets (CI)

`Settings → Secrets and variables → Actions` on the repo.

| Secret | Purpose |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Personal access token from <https://supabase.com/dashboard/account/tokens>. Lets CI run `supabase link` + `db push` + `functions deploy`. |
| `SUPABASE_DB_PASSWORD`  | DB password set when the project was created. Required by `supabase db push`. |
| `SUPABASE_PROJECT_REF`  | `doiwrhkirgblcvuskhno`. The Supabase project ref. |

These are already documented in `.github/workflows/deploy-migrations.yml`.

## 2. Edge function runtime secrets

Set on the Supabase project so all five edge functions can read them:

```bash
supabase secrets set --project-ref doiwrhkirgblcvuskhno \
  TWILIO_ACCOUNT_SID=AC... \
  TWILIO_AUTH_TOKEN=... \
  TWILIO_MESSAGING_SERVICE_SID=MG... \
  TWILIO_FROM_NUMBER=+15551234567 \
  RESEND_API_KEY=re_... \
  RESEND_FROM_EMAIL='RouteReady <hello@gorouteready.com>' \
  RESEND_REPLY_TO=support@gorouteready.com \
  CAL_WEBHOOK_SECRET=... \
  APPLY_SHARED_SECRET=$(openssl rand -hex 32) \
  PUBLIC_BASE_URL=https://doiwrhkirgblcvuskhno.functions.supabase.co/webhook-twilio
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected by the
edge runtime — you do **not** set them yourself.

| Secret | Required by | What breaks if missing |
| --- | --- | --- |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | `send-sms`, `webhook-twilio` (signature check) | All SMS sends + signature verification fail. |
| `TWILIO_MESSAGING_SERVICE_SID` *or* `TWILIO_FROM_NUMBER` | `send-sms` | At least one is required. Messaging Service is preferred. |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | `send-email` | All email sends fail with `resend_credentials_missing`. |
| `RESEND_REPLY_TO` | `send-email` | Optional. |
| `CAL_WEBHOOK_SECRET` | `webhook-cal` | Cal webhooks rejected with `cal_secret_missing`. Set this to the secret you configure in Cal.com → Settings → Webhooks. |
| `CAL_API_KEY` | `cal-availability` | The dashboard's Calendar tab availability editor calls Cal's REST API. Generate at app.cal.com → Settings → Developer → API keys. Format `cal_live_…` (or `cal_test_…`). |
| `CAL_USERNAME` | `cal-availability` | Cal username we manage (default `Routeready`). |
| `CAL_INTERVIEW_SLUG` | `cal-availability` | Slug of the event type the editor manages (default `interview`). |
| `APPLY_SHARED_SECRET` | `webhook-apply` | If unset, the function accepts any caller. Set + send `x-apply-secret: <value>` from external integrations. |
| `PUBLIC_BASE_URL` | `webhook-twilio` (signature check) | Twilio signatures verify against the URL Twilio called; set to the function's public URL. |

### Configure Twilio Messaging Service

In the Twilio console → Messaging → Services → your service:

1. Add the `TWILIO_FROM_NUMBER` (or pool) to the service.
2. **Inbound Settings → Webhook URL:** `https://doiwrhkirgblcvuskhno.functions.supabase.co/webhook-twilio` (POST)
3. **Status callback URL:** same URL.

### Configure Cal.com webhook

Cal.com → Settings → Developer → Webhooks → New:

- Subscriber URL: `https://doiwrhkirgblcvuskhno.functions.supabase.co/webhook-cal`
- Secret: paste the value of `CAL_WEBHOOK_SECRET`.
- Events: `BOOKING_CREATED`, `BOOKING_RESCHEDULED`, `BOOKING_CANCELLED`, `MEETING_ENDED`, `BOOKING_NO_SHOW_UPDATED`.
- Create the event types `interview` and `orientation-day` under your Cal team username; the seed in `0005_seed_and_auth.sql` references those slugs.

### Configure Resend

Resend → Domains → add `gorouteready.com`, complete DNS verification, then:

- Set `RESEND_FROM_EMAIL` to a sender on that verified domain.
- (Optional) set `RESEND_REPLY_TO` to your support inbox.

## 3. Front-end (browser) config

`dashboard/config.js` is committed to the repo and shipped to browsers. It
holds:

- `SUPABASE_URL` — public.
- `SUPABASE_ANON_KEY` — **public; safe to ship.** RLS + RPC grants enforce
  every restriction; the anon key alone can't bypass them.
- `ALLOWED_SIGNUP_DOMAINS` — gate enforced both client-side (UX) and in the
  `on_auth_user_created` trigger (authoritative).

Replace the `REPLACE_WITH_ANON_PUBLIC_KEY` placeholder with the value from
`Project Settings → API → anon public` and commit.

## 4. Auth redirect URLs

`supabase/config.toml` already lists `https://gorouteready.com/dashboard/`
under `additional_redirect_urls`. Make sure the live project's auth
settings include the same allow-list (Dashboard → Authentication → URL
Configuration), since `config.toml` is local-only by default.

## 5. Database settings (immediate-send triggers)

Migration `0007_immediate_send_triggers.sql` adds AFTER INSERT triggers on
`sms_messages` and `email_messages` that fire the matching edge function
the moment a queued row lands — so SMS goes out in seconds, not on the
next cron tick. Both triggers read two database-level settings:

```sql
alter database postgres set "app.functions_base_url"
  to 'https://doiwrhkirgblcvuskhno.functions.supabase.co';

alter database postgres set "app.service_role_key"
  to 'sb_secret_REPLACE_WITH_REAL_VALUE';
```

Run these once in the Supabase SQL editor as the postgres role. They
persist across connections for the entire database. Existing connections
need to reconnect to pick them up — the dashboard's SQL editor and edge
functions automatically open fresh connections, so it's a non-issue.

The triggers silently no-op if either setting is missing or empty, so
running migration 0007 before setting them is safe — the cron drainer
(below) picks up any rows the trigger skipped.

## 6. Cron drainer (safety net)

A 1-minute cron job catches anything the immediate-send triggers missed
(network blip, edge-function cold start, etc.). Set this up once:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'drain-sms-every-minute',
  '* * * * *',
  $$
    select net.http_post(
      url := 'https://doiwrhkirgblcvuskhno.functions.supabase.co/send-sms',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || current_setting('app.service_role_key')
      ),
      body := '{}'::jsonb
    );
  $$
);

select cron.schedule(
  'drain-email-every-minute',
  '* * * * *',
  $$
    select net.http_post(
      url := 'https://doiwrhkirgblcvuskhno.functions.supabase.co/send-email',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || current_setting('app.service_role_key')
      ),
      body := '{}'::jsonb
    );
  $$
);
```

To inspect runs: `select * from cron.job_run_details order by start_time desc limit 20;`

To pause: `select cron.unschedule('drain-sms-every-minute');`
