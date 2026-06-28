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
  EMAIL_INBOUND_SECRET=$(openssl rand -hex 32) \
  EMAIL_INBOUND_DOMAIN=reply.gorouteready.com \
  RESEND_WEBHOOK_SECRET=whsec_... \
  CAL_WEBHOOK_SECRET=... \
  APPLY_SHARED_SECRET=$(openssl rand -hex 32) \
  PUBLIC_BASE_URL=https://doiwrhkirgblcvuskhno.functions.supabase.co/webhook-twilio \
  VAPID_PUBLIC_KEY=BJ... \
  VAPID_PRIVATE_KEY=... \
  VAPID_SUBJECT=mailto:support@gorouteready.com \
  FINCH_CLIENT_ID=... \
  FINCH_CLIENT_SECRET=... \
  FINCH_REDIRECT_URI=https://doiwrhkirgblcvuskhno.functions.supabase.co/finch-oauth-callback \
  FINCH_SANDBOX=finch
```

> **Setting secrets without the CLI:** you can also set every one of these in
> the dashboard — `Project Settings → Edge Functions → Secrets` (or
> `Project Settings → Vault`). The `finch-*` functions read them at runtime, so
> a redeploy isn't needed after you add or change a secret.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected by the
edge runtime — you do **not** set them yourself.

| Secret | Required by | What breaks if missing |
| --- | --- | --- |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | `send-sms`, `webhook-twilio` (signature check) | All SMS sends + signature verification fail. |
| `TWILIO_MESSAGING_SERVICE_SID` *or* `TWILIO_FROM_NUMBER` | `send-sms` | At least one is required. Messaging Service is preferred. |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | `send-email` | All email sends fail with `resend_credentials_missing`. |
| `RESEND_REPLY_TO` | `send-email` | Optional. Reply-To for non-applicant mail (a per-DSP `reply_to_email` in `dsps.metadata` overrides it). |
| `RESEND_WEBHOOK_SECRET` | `webhook-email-inbound` | The `whsec_…` signing secret Resend shows on the inbound webhook. Required if you use Resend's webhook (it's Svix-signed — there's no custom-header option). |
| `EMAIL_INBOUND_SECRET` | `webhook-email-inbound` | Bearer token for *non-Resend* inbound forwarders (Cloudflare Email Worker, a custom relay, …) that send `Authorization: Bearer …`. At least one of this or `RESEND_WEBHOOK_SECRET` must be set, else every POST 500s (`inbound_secret_missing`); a request that satisfies neither check 401s. |
| `EMAIL_INBOUND_DOMAIN` | `send-email` | Optional but **required for applicant replies to thread back into the Pipeline**. When set, `send-email` rewrites the Reply-To on applicant-attributed mail to `<dsp-slug>@<this-domain>` so replies land on the inbound parser instead of a dead inbox. Leave unset to keep the old behavior (Reply-To = `RESEND_REPLY_TO` / per-DSP). |
| `CAL_WEBHOOK_SECRET` | `webhook-cal` | Cal webhooks rejected with `cal_secret_missing`. Set this to the secret you configure in Cal.com → Settings → Webhooks. |
| `CAL_API_KEY` | `cal-availability` | The dashboard's Calendar tab availability editor calls Cal's REST API. Generate at app.cal.com → Settings → Developer → API keys. Format `cal_live_…` (or `cal_test_…`). |
| `CAL_USERNAME` | `cal-availability` | Cal username we manage (default `Routeready`). |
| `CAL_INTERVIEW_SLUG` | `cal-availability` | Slug of the event type the editor manages (default `interview`). |
| `APPLY_SHARED_SECRET` | `webhook-apply` | If unset, the function accepts any caller. Set + send `x-apply-secret: <value>` from external integrations. |
| `PUBLIC_BASE_URL` | `webhook-twilio` (signature check) | Twilio signatures verify against the URL Twilio called; set to the function's public URL. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | `send-driver-push` | Required to sign Web Push JWTs. Driver PWA notifications + home-screen badge stop firing if missing. Generate once with `npx web-push generate-vapid-keys`. The public key is also written to a database setting (see §5) so the driver app can fetch it via the `driver_push_vapid_key()` RPC. |
| `FINCH_CLIENT_ID`, `FINCH_CLIENT_SECRET` | `finch-oauth-start`, `finch-oauth-callback`, `finch-sync` | ADP/HRIS sync via Finch. From your app at <https://tryfinch.com>. If missing, the launcher's **ADP Sync → Connect** shows "ADP isn't set up on the server yet." |
| `FINCH_REDIRECT_URI` | `finch-oauth-start`, `finch-oauth-callback` | The deployed `finch-oauth-callback` URL, e.g. `https://doiwrhkirgblcvuskhno.functions.supabase.co/finch-oauth-callback`. Must **also** be registered as a redirect URI in the Finch dashboard, or the connect popup errors. |
| `FINCH_SANDBOX` | `finch-oauth-start` | Optional. Set `finch` (Finch-simulated) or `provider` to test without a live ADP account. Omit in production. |
| `FINCH_API_VERSION` | `finch-sync`, `finch-oauth-callback` | Optional. Defaults to `2020-09-17`. |
| *(reused)* `GOOGLE_TOKEN_ENC_KEY`, `OAUTH_STATE_SECRET`, `DASHBOARD_URL` | Finch + Google | The Finch functions reuse the Google integration's token-encryption key, signed-state secret, and dashboard base URL — no new values needed if Google Calendar already works. |

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

### Configure Resend (outbound)

Resend → Domains → add `gorouteready.com`, complete DNS verification, then:

- Set `RESEND_FROM_EMAIL` to a sender on that verified domain (e.g. `RouteReady <hello@gorouteready.com>`). `send-email` rewrites the local-part to a per-DSP slug at send time, so the recipient sees `Acme Logistics <acme-logistics@gorouteready.com>`.
- (Optional) set `RESEND_REPLY_TO` to your support inbox. This is used for non-applicant mail only — see below.

### Inbound email — applicant replies into the Pipeline

The dashboard's applicant **Email** thread shows replies as `inbound` rows. They get there via the `webhook-email-inbound` edge function (already deployed, `--no-verify-jwt`, so it's publicly reachable at `https://doiwrhkirgblcvuskhno.functions.supabase.co/webhook-email-inbound`). What it needs:

1. **Pick an inbound domain.** Use a dedicated subdomain so you don't touch the main domain's mail flow — e.g. `reply.gorouteready.com`. Set `EMAIL_INBOUND_DOMAIN` to it (a Supabase secret). `send-email` will then put `Reply-To: <dsp-slug>@reply.gorouteready.com` on every applicant-attributed email; the `<dsp-slug>` local-part is what the webhook uses to find the tenant, and the sender's address is matched to an applicant inside it.

2. **Point that domain's MX at an inbound parser**, and have the parser POST the parsed message to the function URL above. Pick one:
   - **Resend Email Receiving** (recommended if you already use Resend). On the `reply.gorouteready.com` domain in Resend: turn off "Enable Sending" (you don't need it — outbound goes from the apex), add the **DKIM TXT** + **inbound MX** records it lists at your DNS host, and wait for it to verify. Then Resend → **Webhooks** → Add webhook → URL = the function URL, event = `email.received` → create. Open the webhook → copy its **Signing Secret** (`whsec_…`) → `supabase secrets set RESEND_WEBHOOK_SECRET=whsec_…`. (Resend webhooks are Svix-signed; the function verifies that signature — there's no custom-header option, so `EMAIL_INBOUND_SECRET` is *not* used on this path.)
   - **Cloudflare Email Workers** (if `reply.gorouteready.com` is on Cloudflare). Enable Email Routing on the subdomain, deploy a small worker that parses the message (`postal-mime`) and `fetch()`s the function URL with `{ to, from, subject, text, html, messageId }` JSON and an `Authorization: Bearer <EMAIL_INBOUND_SECRET>` header, and add a catch-all route → that worker. Set `EMAIL_INBOUND_SECRET` to match. Portable; works regardless of your email provider.
   - Anything else (Postmark inbound, Mailgun routes, SendGrid Inbound Parse, …): same idea — POST `{ to, from, subject, text, html, messageId }` to the function URL with `Authorization: Bearer <EMAIL_INBOUND_SECRET>`, mapping fields to the shape in the docstring at the top of `supabase/functions/webhook-email-inbound/index.ts`.

3. **Set the matching secret** (`RESEND_WEBHOOK_SECRET` for the Resend path, `EMAIL_INBOUND_SECRET` for the rest — see the secrets table above). With neither set the function 500s (`inbound_secret_missing`); a request that satisfies neither check 401s.

4. **Verify.** Send a reply from the dashboard (applicant Email modal → "Send reply"), reply to it from the applicant's mailbox, then re-open the modal — the reply should appear as an `inbound` row within a few seconds. If it doesn't: check the `webhook-email-inbound` logs (Supabase → Edge Functions → Logs) — `unknown_recipient_slug` means the Reply-To local-part doesn't match a DSP's slugified name or `short_code`; `missing_addresses` means the upstream payload shape doesn't line up; `unauthorized`/`inbound_secret_missing` means the signing secret / bearer is off.

Notes:
- The webhook 200s even when it can't attribute a message (so the upstream doesn't retry forever); those just don't show up in any thread. An inbound mail it *can* match to a DSP but *not* to an applicant is still stored (DSP-scoped, `applicant_id` null) — it just won't surface on a card.
- Idempotency is on `(provider='inbound', provider_message_id)`, so a parser that re-delivers the same `messageId` is a no-op.

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

-- Driver Web Push (PR #289). Same value as VAPID_PUBLIC_KEY.
-- Read by driver_push_vapid_key() so the PWA can subscribe.
alter database postgres set "app.vapid_public_key"
  to 'BJ_REPLACE_WITH_REAL_VALUE';
```

**Generating VAPID keys (one-time):**

```bash
npx web-push generate-vapid-keys
```

Copy `Public Key` → `VAPID_PUBLIC_KEY` (Supabase secret) **and** `app.vapid_public_key` (database setting). Copy `Private Key` → `VAPID_PRIVATE_KEY` (Supabase secret only). Set `VAPID_SUBJECT` to a contact URL like `mailto:support@gorouteready.com`. Don't rotate VAPID keys casually — every existing push subscription will silently stop working until the driver re-subscribes.

Run these once in the Supabase SQL editor as the postgres role. They
persist across connections for the entire database. Existing connections
need to reconnect to pick them up — the dashboard's SQL editor and edge
functions automatically open fresh connections, so it's a non-issue.

The triggers silently no-op if either setting is missing or empty, so
running migration 0007 before setting them is safe — the cron drainer
(below) picks up any rows the trigger skipped.

### Document sealing service

A separate Cloudflare Worker (`services/document-sealing`) stamps the driver's signature onto the source PDF, appends a Certificate of Completion, uploads both, and logs `pdf_sealed` to the audit chain. It's invoked by a Postgres trigger on `document_envelopes` when `status` flips to `signed` (migration `0155`).

```sql
insert into private.app_settings (key, value) values
  ('sealing_service_url',    'https://rr-document-sealing.<account>.workers.dev'),
  ('sealing_service_secret', '<openssl rand -hex 32 — same value set on the Worker>')
on conflict (key) do update set value = excluded.value, updated_at = now();
```

If either setting is missing or empty, the trigger no-ops with a notice (the signing flow still completes; the envelope just doesn't get sealed until you wire this up). See `services/document-sealing/README.md` for the one-time Worker setup (`wrangler secret put SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SEALING_SECRET` and `wrangler deploy`).

PKCS#7 detached signature + RFC 3161 timestamping land in a follow-up. Until then sealed PDFs are human-defensible (signature visible, Certificate of Completion attached, hash-chained audit trail intact) but not cryptographically tamper-evident to a PDF reader's "✓ Signed" check.

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
