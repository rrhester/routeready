-- ───────────────────────────────────────────────────────────────────────
-- 0504 · Reliability + hardening support (project-review Wave C/D)
--
-- Support objects the Wave C edge-function hardening codes against (all
-- with graceful fallbacks until this is applied), plus the Wave D
-- database items:
--   1. sms_optouts             durable TCPA STOP/START flag (PR#58)
--   2. cal_webhook_events      booking-confirmation idempotency (PR#63)
--   3. push_delivery_failures  push dead-letter (PR#65)
--   4. stuck-'sending' sweeper for sms/email queues + claim stamp (PR#59)
--   5. cal_event_reminders     enable RLS — was the ONLY public table
--                              with none (PR#51)
--   6. client_errors           spoof-proof inserts + caps + retention (PR#52)
--   7. public.ai_proxy_note_request wrapper — the private.* function was
--      NEVER PostgREST-callable, so the AI daily cap silently never
--      enforced for ai-proxy (and now analytics-ai / notebook-ai)
--   8. private.rr_migrations ledger + public.rr_schema_version()
--      (PR#46) — manual SQL-editor pastes become self-recording
--   9. public.rr_cron_health() — expected-vs-actual pg_cron inventory
--      (PR#56; gcal-pull was silently absent for months)
--  10. roster_attendance_counts RPC (PR#25) + supporting index — replaces
--      the dashboard fetching 20,000 raw shift rows every 30 s
--  11. Missing FK indexes on cascade paths (PR#50)
--  12. Initplan-wrapped RLS on hot tables (PR#49)
--  13. Anon default-privilege revoke for future functions (PR#53)
--
-- Idempotent: safe to re-run in full if a paste partially applied.
-- ───────────────────────────────────────────────────────────────────────

-- ── 1 · sms_optouts ─────────────────────────────────────────────────────
create table if not exists public.sms_optouts (
  phone        text primary key,
  dsp_id       uuid references public.dsps(id) on delete set null,
  opted_out_at timestamptz not null default now(),
  source       text not null default 'twilio_stop'
);
alter table public.sms_optouts enable row level security;
revoke all on public.sms_optouts from anon, authenticated;

-- ── 2 · cal_webhook_events ──────────────────────────────────────────────
-- starts_at is TEXT (raw provider string, '' when absent) so the unique
-- key never has NULLs — Postgres treats NULLs as distinct, which would
-- defeat the dedupe for events without a startTime.
create table if not exists public.cal_webhook_events (
  provider_event_id text not null,
  trigger_event     text not null,
  starts_at         text not null default '',
  created_at        timestamptz not null default now(),
  primary key (provider_event_id, trigger_event, starts_at)
);
alter table public.cal_webhook_events enable row level security;
revoke all on public.cal_webhook_events from anon, authenticated;

-- ── 3 · push_delivery_failures ──────────────────────────────────────────
create table if not exists public.push_delivery_failures (
  id         uuid primary key default gen_random_uuid(),
  driver_id  uuid,
  token_id   uuid,
  kind       text,
  title      text,
  body       text,
  data       jsonb,
  created_at timestamptz not null default now()
);
alter table public.push_delivery_failures enable row level security;
revoke all on public.push_delivery_failures from anon, authenticated;
create index if not exists push_delivery_failures_created_idx
  on public.push_delivery_failures (created_at);

-- ── 4 · stuck-'sending' sweeper ─────────────────────────────────────────
-- Claim timestamp is stamped by TRIGGER (not by the edge functions), so
-- deploy order can't break sends: the column and trigger exist entirely
-- DB-side.
alter table public.sms_messages   add column if not exists sending_at timestamptz;
alter table public.email_messages add column if not exists sending_at timestamptz;

create or replace function private.stamp_sending_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'sending' and (old.status is distinct from 'sending') then
    new.sending_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists sms_messages_stamp_sending on public.sms_messages;
create trigger sms_messages_stamp_sending
  before update on public.sms_messages
  for each row execute function private.stamp_sending_at();

drop trigger if exists email_messages_stamp_sending on public.email_messages;
create trigger email_messages_stamp_sending
  before update on public.email_messages
  for each row execute function private.stamp_sending_at();

create or replace function private.requeue_stuck_sends()
returns void language plpgsql security definer set search_path = '' as $$
begin
  -- A row stuck in 'sending' for 15+ minutes means the drain isolate died
  -- or the provider call was never resolved — requeue so the next drain
  -- retries. Duplicate-send safety: the claimed row's provider call either
  -- never happened (crash before fetch) or failed/timed out; Twilio/Resend
  -- accepted sends flip the row to sent/failed within seconds.
  update public.sms_messages
     set status = 'queued', sending_at = null
   where status = 'sending' and sending_at is not null
     and sending_at < now() - interval '15 minutes';
  update public.email_messages
     set status = 'queued', sending_at = null
   where status = 'sending' and sending_at is not null
     and sending_at < now() - interval '15 minutes';
  -- Retention for the push dead-letter while we're here (30 days).
  delete from public.push_delivery_failures where created_at < now() - interval '30 days';
end;
$$;

-- One-time: requeue rows stranded in 'sending' BEFORE the claim stamp
-- existed (sending_at is null for them). Anything actively sending right
-- now will re-stamp within seconds via the trigger, so a momentary
-- requeue race is acceptable and self-heals on the next drain.
update public.sms_messages   set status = 'queued' where status = 'sending' and sending_at is null;
update public.email_messages set status = 'queued' where status = 'sending' and sending_at is null;

do $$ begin
  perform cron.unschedule('requeue-stuck-sends');
exception when others then null; end $$;
select cron.schedule(
  'requeue-stuck-sends',
  '*/10 * * * *',
  $cron$ select private.requeue_stuck_sends(); $cron$
);

-- ── 5 · cal_event_reminders RLS ─────────────────────────────────────────
-- Created in 0406 with no RLS, no policies, no revokes: with Supabase's
-- default grants, anon could read / insert (suppressing any tenant's
-- reminders via the dedupe check) / mass-delete (duplicate sends). Only
-- server-side code (service role) ever touches it.
alter table public.cal_event_reminders enable row level security;
revoke all on public.cal_event_reminders from anon, authenticated;

-- ── 6 · client_errors hardening ─────────────────────────────────────────
-- 0385's insert policy was `with check (true)` for authenticated — any
-- user could spoof dsp_id/user_id (which 0443 aggregates into per-DSP
-- health signals) and insert unbounded rows. Bind identity, cap sizes,
-- add retention.
do $$ begin
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'client_errors') then
    drop policy if exists client_errors_insert_authed on public.client_errors;
    create policy client_errors_insert_authed
      on public.client_errors for insert
      to authenticated
      with check (
        (user_id is null or user_id = (select auth.uid()))
        and (dsp_id is null or dsp_id = (select private.current_dsp_id()))
      );
  end if;
end $$;

create or replace function private.clamp_client_error()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.message := left(coalesce(new.message, ''), 2000);
  if new.stack is not null then new.stack := left(new.stack, 8000); end if;
  return new;
end;
$$;
do $$ begin
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'client_errors') then
    drop trigger if exists client_errors_clamp on public.client_errors;
    create trigger client_errors_clamp
      before insert on public.client_errors
      for each row execute function private.clamp_client_error();
  end if;
end $$;

create or replace function private.purge_client_errors()
returns void language sql security definer set search_path = '' as $$
  delete from public.client_errors where created_at < now() - interval '90 days';
$$;
do $$ begin
  perform cron.unschedule('purge-client-errors');
exception when others then null; end $$;
select cron.schedule(
  'purge-client-errors',
  '20 8 * * *',
  $cron$ select private.purge_client_errors(); $cron$
);

-- ── 7 · PostgREST-callable AI quota wrapper ─────────────────────────────
-- private.ai_proxy_note_request (0469) is NOT in an exposed schema, so
-- every edge-function `.rpc("ai_proxy_note_request")` call has errored —
-- and callers deliberately treat metering errors as non-fatal, so the
-- daily AI cap has silently never enforced. Service-role only.
create or replace function public.ai_proxy_note_request(p_dsp_id uuid, p_default_cap int default 200)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.ai_proxy_note_request(p_dsp_id, p_default_cap);
$$;
revoke all on function public.ai_proxy_note_request(uuid, int) from public, anon, authenticated;
grant execute on function public.ai_proxy_note_request(uuid, int) to service_role;

-- ── 8 · applied-migrations ledger + schema version ──────────────────────
create table if not exists private.rr_migrations (
  filename   text primary key,
  applied_at timestamptz not null default now()
);

-- Everything through 0501 was applied by hand before the ledger existed;
-- record the head as a baseline marker. (0432_gcal_two_way_sync is the
-- known exception — never applied; 0503 re-asserts it and records itself.)
insert into private.rr_migrations (filename)
values ('0501_workbook_mention_delivery.sql')
on conflict (filename) do nothing;

create or replace function public.rr_schema_version()
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(max((regexp_match(filename, '^(\d{4})'))[1]::int), 0)
  from private.rr_migrations;
$$;
grant execute on function public.rr_schema_version() to authenticated;

-- ── 9 · pg_cron inventory health ────────────────────────────────────────
-- gcal-pull was silently missing for months; nothing compared what SHOULD
-- be scheduled against cron.job. Staff-visible (read-only names only).
create or replace function public.rr_cron_health()
returns table (jobname text, scheduled boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with expected(jobname) as (values
    ('booking-nudge-run'),
    ('calendar-digest'),
    ('checklist-due-reminders'),
    ('dispatch-referral-invites-daily'),
    ('dvic-ai-sweep'),
    ('event-reminders'),
    ('flush-scheduled-messages'),
    ('gcal-pull'),
    ('gcal-reconcile'),
    ('interview-reminders'),
    ('license-expiry-reminders-daily'),
    ('purge-client-errors'),
    ('recognition-autofire-daily'),
    ('requeue-stuck-sends'),
    ('sweep-expired-schedule-requests'),
    ('team-task-forever-topup'),
    ('unconfirmed-escalation')
  )
  select e.jobname, exists (select 1 from cron.job j where j.jobname = e.jobname)
  from expected e;
$$;
grant execute on function public.rr_cron_health() to authenticated;

-- ── 10 · roster attendance RPC ──────────────────────────────────────────
-- Replaces the dashboard's 20,000-row raw `shifts` fetch (re-run every
-- 30 s while the roster is open) with one grouped query. Same model as
-- the driver record: worked = completed+late; eligible adds
-- no_show+called_off.
create or replace function public.roster_attendance_counts(p_days int default 30)
returns table (driver_id uuid, worked int, eligible int)
language sql
stable
security definer
set search_path = ''
as $$
  select s.driver_id,
         count(*) filter (where s.status in ('completed','late'))::int as worked,
         count(*)::int as eligible
  from public.shifts s
  where s.dsp_id = private.current_dsp_id()
    and s.driver_id is not null
    and s.status in ('completed','late','no_show','called_off')
    and s.date >= (current_date - make_interval(days => greatest(coalesce(p_days, 30), 1)))::date
  group by s.driver_id;
$$;
revoke all on function public.roster_attendance_counts(int) from public, anon;
grant execute on function public.roster_attendance_counts(int) to authenticated;

create index if not exists shifts_dsp_driver_att_idx
  on public.shifts (dsp_id, driver_id, date)
  where status in ('completed','late','no_show','called_off');

-- ── 11 · missing FK indexes on cascade paths (PR#50) ────────────────────
-- Driver deletes / admin-delete-dsp seq-scanned these child tables.
create index if not exists assignment_audit_actor_driver_idx
  on public.assignment_audit (actor_driver_id) where actor_driver_id is not null;
create index if not exists document_events_actor_driver_idx
  on public.document_events (actor_driver_id) where actor_driver_id is not null;
create index if not exists checklist_submissions_shift_idx
  on public.checklist_submissions (schedule_shift_id) where schedule_shift_id is not null;
create index if not exists receipt_uploads_shift_idx
  on public.receipt_uploads (shift_id) where shift_id is not null;
create index if not exists driver_channel_messages_sender_idx
  on public.driver_channel_messages (sender_driver_id) where sender_driver_id is not null;

-- ── 12 · initplan-wrapped RLS on the hot tables (PR#49) ─────────────────
-- Bare `dsp_id = private.current_dsp_id()` re-evaluates the definer
-- function per ROW; `(select ...)` evaluates once per statement (the
-- standard Supabase initplan optimization). Recreated verbatim from
-- 0445/0468/0054 with only that change.

-- shifts (0445)
drop policy if exists "shifts_tenant_select" on public.shifts;
create policy "shifts_tenant_select"
  on public.shifts for select
  to authenticated
  using (dsp_id = (select private.current_dsp_id()));

drop policy if exists "shifts_staff_insert" on public.shifts;
create policy "shifts_staff_insert"
  on public.shifts for insert
  to authenticated
  with check (dsp_id = (select private.current_dsp_id())
              and (select private.is_staff(private.current_dsp_id(), 'dispatcher')));

drop policy if exists "shifts_staff_update" on public.shifts;
create policy "shifts_staff_update"
  on public.shifts for update
  to authenticated
  using (dsp_id = (select private.current_dsp_id())
         and (select private.is_staff(private.current_dsp_id(), 'dispatcher')))
  with check (dsp_id = (select private.current_dsp_id())
              and (select private.is_staff(private.current_dsp_id(), 'dispatcher')));

drop policy if exists "shifts_staff_delete" on public.shifts;
create policy "shifts_staff_delete"
  on public.shifts for delete
  to authenticated
  using (dsp_id = (select private.current_dsp_id())
         and (select private.is_staff(private.current_dsp_id(), 'dispatcher')));

-- cal_events (0468)
drop policy if exists "cal_events_tenant_select" on public.cal_events;
create policy "cal_events_tenant_select"
  on public.cal_events for select
  to authenticated
  using (dsp_id = (select private.current_dsp_id()));

drop policy if exists "cal_events_staff_insert" on public.cal_events;
create policy "cal_events_staff_insert"
  on public.cal_events for insert
  to authenticated
  with check (dsp_id = (select private.current_dsp_id())
              and (select private.is_staff(private.current_dsp_id(), 'dispatcher')));

drop policy if exists "cal_events_staff_update" on public.cal_events;
create policy "cal_events_staff_update"
  on public.cal_events for update
  to authenticated
  using (dsp_id = (select private.current_dsp_id())
         and (select private.is_staff(private.current_dsp_id(), 'dispatcher')))
  with check (dsp_id = (select private.current_dsp_id())
              and (select private.is_staff(private.current_dsp_id(), 'dispatcher')));

drop policy if exists "cal_events_staff_delete" on public.cal_events;
create policy "cal_events_staff_delete"
  on public.cal_events for delete
  to authenticated
  using (dsp_id = (select private.current_dsp_id())
         and (select private.is_staff(private.current_dsp_id(), 'dispatcher')));

-- driver_messages (0054)
drop policy if exists "driver_messages_tenant_r" on public.driver_messages;
create policy "driver_messages_tenant_r"
  on public.driver_messages for select
  using (dsp_id = (select private.current_dsp_id()));

-- ── 13 · future functions are NOT anon-executable by default (PR#53) ────
-- Supabase's default privileges grant EXECUTE to anon on every function
-- created in public — which is why ~500 staff RPCs show as
-- anon-executable and rely solely on in-body auth gates. Existing
-- functions keep their grants (nothing breaks); FUTURE functions start
-- anon-locked, so an anon-facing RPC now requires an explicit
--   grant execute on function public.X to anon;
-- in its migration — a visible, reviewable line instead of an invisible
-- default. (Authenticated/service_role defaults are unchanged.)
alter default privileges in schema public revoke execute on functions from anon;

-- Self-record.
insert into private.rr_migrations (filename)
values ('0504_reliability_and_hardening.sql')
on conflict (filename) do nothing;
