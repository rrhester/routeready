-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0253 · Unified applicant → driver activation
--
-- Goal: from the moment an applicant becomes a driver (record_outcome →
-- hired), there is ONE long-lived driver record that already knows the
-- person's name, phone, email, screening score, applicant source, and
-- video URL, and a single secure activation path the driver follows to
-- claim that record on their phone.
--
-- This migration:
--
--   1. Adds activation columns to public.drivers
--        - phone_normalized (digits-only US phone, maintained by trigger)
--        - pin_hash         (bcrypt hash of the driver's 4–6 digit PIN)
--        - pin_set_at       (when PIN was last set)
--        - activated_at     (first successful activation = account live)
--        - applicant_snapshot (jsonb capture of what we knew at hire)
--      and a partial unique index on (dsp_id, phone_normalized) so two
--      active drivers can never share the same phone within a DSP.
--
--   2. Updates public.record_outcome() so on hire it now also copies
--      the applicant's score and metadata (source, video_url, …) into
--      the driver row + applicant_snapshot, and seeds an
--      onboarding_progress row with welcome_email_sent_at = now() so
--      the onboarding funnel starts the moment the applicant is hired.
--
--   3. Adds driver-facing activation RPCs (all anon-callable):
--        - driver_activation_lookup(code) → name + masked phone + dsp
--        - driver_activate(code, phone, pin) → session token, sets PIN
--        - driver_signin_with_phone(phone, pin) → session token
--      Phone+PIN becomes the long-term login identity. The invite code
--      remains the one-shot bootstrap to bind PIN to a known driver.
--
--   4. Adds public.send_onboarding_invite(driver_id) so dispatchers can
--      re-trigger the invite SMS/email at any time without re-hiring,
--      reusing the same template the hire path uses.
--
--   5. Rewrites the applicant.outcome_hired SMS+email templates to the
--      "Activate your driver profile" copy and points the link at the
--      activation surface. Honors operator customizations: only rows
--      whose body still matches the previously-seeded text are updated.
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. drivers · activation columns ───────────────────────────────────

alter table public.drivers
  add column if not exists phone_normalized   text,
  add column if not exists pin_hash           text,
  add column if not exists pin_set_at         timestamptz,
  add column if not exists activated_at       timestamptz,
  add column if not exists applicant_snapshot jsonb not null default '{}'::jsonb;

-- Normalize a phone number: strip everything except digits, drop the US
-- country-code leading 1 so "+1 (555) 123-4567", "555-123-4567" and
-- "5551234567" all collapse to the same 10-digit string.  Returns NULL
-- when the input is empty or has fewer than 10 digits.
create or replace function private.normalize_phone(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  with d as (
    select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as digits
  )
  select case
    when length(digits) < 10 then null
    when length(digits) = 11 and left(digits, 1) = '1' then right(digits, 10)
    else right(digits, 10)
  end
  from d;
$$;

-- Trigger keeps phone_normalized in lock-step with phone on every write.
create or replace function private.drivers_normalize_phone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.phone_normalized := private.normalize_phone(new.phone);
  return new;
end;
$$;

drop trigger if exists trg_drivers_normalize_phone on public.drivers;
create trigger trg_drivers_normalize_phone
  before insert or update of phone on public.drivers
  for each row execute function private.drivers_normalize_phone();

-- Backfill existing rows.
update public.drivers
   set phone_normalized = private.normalize_phone(phone)
 where phone is not null and phone_normalized is null;

-- One active driver per phone per DSP. Terminated drivers are exempt so
-- a re-hire (same person, new driver row after a previous separation)
-- doesn't collide with the historical record.
drop index if exists public.drivers_dsp_phone_unique;
create unique index drivers_dsp_phone_unique
  on public.drivers (dsp_id, phone_normalized)
  where phone_normalized is not null and status <> 'terminated';


-- ── 2. record_outcome — inherit applicant metadata + seed progress ───
--
-- Same surface as 0014, but on hire we now:
--   • Copy applicant.score and roll source / video_url / metadata into
--     drivers.applicant_snapshot so the operator + driver-app code can
--     see "what we knew at hire" without joining back to applicants.
--   • If the driver row already exists (re-click), refresh those fields
--     so editing the applicant before re-firing the outcome still wins.
--   • Seed an onboarding_progress row with welcome_email_sent_at = now()
--     — the hired email IS the welcome email, so the funnel should
--     start green on step 1 the moment the outcome fires.

create or replace function public.record_outcome(
  p_applicant_id     uuid,
  p_outcome          public.interview_outcome,
  p_notes            text default null,
  p_interview_day_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_app public.applicants;
  v_day public.interview_days;
  v_event_date date;
  v_tz text;
  v_driver_id uuid;
  v_snapshot jsonb;
  v_msg_error text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_app from public.applicants where id = p_applicant_id and dsp_id = v_dsp;
  if v_app.id is null then raise exception 'applicant_not_found'; end if;

  -- Day resolution preserved from 0146: prefer the day the caller is
  -- showing, fall back to the applicant's latest active cal_event date,
  -- fall back to today.  Keeps the operator's "I'm acting on Tuesday's
  -- roster" intent intact even if today is a different day.
  if p_interview_day_id is not null then
    select * into v_day from public.interview_days where id = p_interview_day_id and dsp_id = v_dsp;
  end if;
  if v_day.id is null then
    select timezone into v_tz from public.dsps where id = v_dsp;
    select (ce.starts_at at time zone coalesce(v_tz, 'UTC'))::date
      into v_event_date
    from public.cal_events ce
    where ce.dsp_id = v_dsp
      and ce.applicant_id = p_applicant_id
      and ce.status in ('scheduled','rescheduled','completed','no_show')
    order by ce.starts_at desc
    limit 1;
    if v_event_date is null then
      v_event_date := (now() at time zone coalesce(v_tz, 'UTC'))::date;
    end if;
    v_day := public.open_interview_day(v_event_date, null);
  end if;

  insert into public.interview_outcomes
    (dsp_id, interview_day_id, applicant_id, outcome, decided_by, notes)
  values
    (v_dsp, v_day.id, p_applicant_id, p_outcome, v_uid, p_notes)
  on conflict (interview_day_id, applicant_id) do update
    set outcome = excluded.outcome,
        decided_by = excluded.decided_by,
        notes = excluded.notes,
        decided_at = now();

  update public.applicants
     set status = case
       when p_outcome = 'hired'  then 'hired'::public.applicant_status
       else 'not_hired'::public.applicant_status
     end
   where id = p_applicant_id;

  if p_outcome = 'hired' then
    v_snapshot := jsonb_build_object(
      'applicant_id',           v_app.id,
      'source',                 v_app.source,
      'source_ref',             v_app.source_ref,
      'score',                  v_app.score,
      'video_url',              v_app.video_url,
      'screening_completed_at', v_app.screening_completed_at,
      'metadata',               coalesce(v_app.metadata, '{}'::jsonb),
      'hired_at',               now()
    );

    select id into v_driver_id from public.drivers
     where applicant_id = p_applicant_id and dsp_id = v_dsp
     limit 1;

    -- Fall back to phone match within the DSP so a manually-created
    -- driver row that predates the hire decision is bound to the
    -- applicant instead of getting a duplicate.
    if v_driver_id is null and private.normalize_phone(v_app.phone) is not null then
      select id into v_driver_id from public.drivers
       where dsp_id = v_dsp
         and status <> 'terminated'
         and phone_normalized = private.normalize_phone(v_app.phone)
       order by created_at asc
       limit 1;
    end if;

    if v_driver_id is null then
      insert into public.drivers
        (dsp_id, station_id, applicant_id,
         first_name, last_name, full_name, email, phone,
         status, hire_date, score, applicant_snapshot)
      values
        (v_dsp, v_app.station_id, v_app.id,
         v_app.first_name, v_app.last_name, v_app.full_name, v_app.email, v_app.phone,
         'onboarding', current_date, v_app.score, v_snapshot)
      returning id into v_driver_id;
    else
      -- Refresh inherited fields. Don't overwrite identity-binding
      -- columns the operator has already edited on the driver row
      -- (preferred_name, address, etc.) — just the at-hire snapshot
      -- and the contact fallbacks if they're still null on the driver.
      update public.drivers
         set applicant_id = coalesce(applicant_id, v_app.id),
             first_name   = coalesce(first_name, v_app.first_name),
             last_name    = coalesce(last_name, v_app.last_name),
             email        = coalesce(email, v_app.email),
             phone        = coalesce(phone, v_app.phone),
             score        = coalesce(score, v_app.score),
             applicant_snapshot = v_snapshot
       where id = v_driver_id;
    end if;

    -- Seed onboarding_progress. The "welcome email" IS this outcome
    -- message; mark it sent inline so the funnel starts at step 1
    -- without requiring a second dispatcher click.
    insert into public.onboarding_progress
      (driver_id, dsp_id, welcome_email_sent_at)
    values
      (v_driver_id, v_dsp, now())
    on conflict (driver_id) do update
      set welcome_email_sent_at = coalesce(public.onboarding_progress.welcome_email_sent_at, excluded.welcome_email_sent_at),
          updated_at = now();
  end if;

  -- Best-effort applicant notification (preserved from 0146).  Wraps
  -- queue_outcome_message in a sub-block so a missing/broken template
  -- can't roll back the outcome we just recorded.
  begin
    perform private.queue_outcome_message(p_applicant_id, p_outcome::text);
  exception when others then
    v_msg_error := sqlerrm;
    raise notice 'record_outcome: queue_outcome_message failed for applicant % (%): %',
      p_applicant_id, p_outcome, v_msg_error;
  end;

  return jsonb_build_object(
    'applicant_id',     p_applicant_id,
    'outcome',          p_outcome,
    'driver_id',        v_driver_id,
    'interview_day_id', v_day.id,
    'message_error',    v_msg_error
  );
end;
$$;
grant execute on function public.record_outcome(uuid, public.interview_outcome, text, uuid) to authenticated;


-- ── 3a. driver_activation_lookup — anon, by invite code ──────────────
--
-- Pre-fills the activation screen.  Returns just enough to identify the
-- driver to themselves (display name, masked phone, DSP name) without
-- leaking enough to enumerate the database. Invalid / expired codes
-- surface a generic error so brute-forcing a code can't distinguish
-- "wrong code" from "right code but expired".

create or replace function public.driver_activation_lookup(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_invite public.driver_invite_codes;
  v_drv    public.drivers;
  v_dsp    public.dsps;
  v_phone  text;
  v_hint   text;
begin
  select * into v_invite
    from public.driver_invite_codes
   where code = upper(trim(coalesce(p_code, '')))
     and consumed_at is null
     and expires_at > now();
  if v_invite.code is null then
    raise exception 'invalid_or_expired_code' using errcode = 'P0001';
  end if;

  select * into v_drv from public.drivers where id = v_invite.driver_id;
  if v_drv.id is null or v_drv.status not in ('active','onboarding') then
    raise exception 'invalid_or_expired_code' using errcode = 'P0001';
  end if;

  select * into v_dsp from public.dsps where id = v_drv.dsp_id;

  v_phone := v_drv.phone_normalized;
  if v_phone is not null and length(v_phone) >= 4 then
    v_hint := '(•••) •••-' || right(v_phone, 4);
  else
    v_hint := null;
  end if;

  return jsonb_build_object(
    'code',          v_invite.code,
    'driver_id',     v_drv.id,
    'name',          coalesce(nullif(trim(v_drv.preferred_name), ''),
                              nullif(trim(v_drv.first_name), ''),
                              v_drv.full_name),
    'full_name',     v_drv.full_name,
    'phone_hint',    v_hint,
    'has_phone',     v_phone is not null,
    'dsp_name',      coalesce(v_dsp.name, ''),
    'already_activated', v_drv.activated_at is not null,
    'status',        v_drv.status
  );
end;
$$;
grant execute on function public.driver_activation_lookup(text) to anon, authenticated;


-- ── 3b. driver_activate — anon, redeems code + sets PIN ──────────────
--
-- The activation flow on the driver's first tap.  Accepts the invite
-- code, the driver's confirmed phone (editable in case the row we
-- created from the applicant had a wrong number), and a 4–6 digit PIN.
-- On success:
--   • Sets drivers.phone (if changed) and re-normalizes
--   • Stores bcrypt(pin) in drivers.pin_hash
--   • Marks activated_at = now() if not already
--   • Consumes the invite code
--   • Issues a long-lived driver_sessions token and returns it
--
-- The same call works for re-activations (driver lost phone, dispatcher
-- issued a new code) — the existing PIN is overwritten and any prior
-- sessions for that driver are revoked.

create or replace function public.driver_activate(
  p_code   text,
  p_phone  text,
  p_pin    text,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite        public.driver_invite_codes;
  v_drv           public.drivers;
  v_dsp           public.dsps;
  v_phone_norm    text;
  v_phone_clash   uuid;
  v_token         text;
  v_pin_clean     text;
begin
  -- Validate code first so we never leak phone/PIN failures separately.
  select * into v_invite
    from public.driver_invite_codes
   where code = upper(trim(coalesce(p_code, '')))
     and consumed_at is null
     and expires_at > now();
  if v_invite.code is null then
    raise exception 'invalid_or_expired_code' using errcode = 'P0001';
  end if;

  select * into v_drv from public.drivers where id = v_invite.driver_id;
  if v_drv.id is null or v_drv.status not in ('active','onboarding') then
    raise exception 'driver_inactive' using errcode = 'P0001';
  end if;

  v_pin_clean := regexp_replace(coalesce(p_pin, ''), '[^0-9]', '', 'g');
  if length(v_pin_clean) < 4 or length(v_pin_clean) > 6 then
    raise exception 'pin_must_be_4_to_6_digits' using errcode = '22023';
  end if;

  -- Blank phone input ⇒ "keep what's on file" (the driver tapped
  -- Activate without editing the prefilled field).  We only require an
  -- explicit phone when the driver record has none yet.
  v_phone_norm := private.normalize_phone(p_phone);
  if v_phone_norm is null then
    if v_drv.phone_normalized is null then
      raise exception 'phone_required' using errcode = '22023';
    end if;
    v_phone_norm := v_drv.phone_normalized;
  end if;

  -- If the driver edited their phone, make sure it doesn't collide with
  -- another active driver in the same DSP.
  if v_phone_norm <> coalesce(v_drv.phone_normalized, '') then
    select id into v_phone_clash from public.drivers
     where dsp_id = v_drv.dsp_id
       and status <> 'terminated'
       and phone_normalized = v_phone_norm
       and id <> v_drv.id
     limit 1;
    if v_phone_clash is not null then
      raise exception 'phone_already_in_use' using errcode = '23505';
    end if;
  end if;

  update public.drivers
     set phone        = case when v_phone_norm <> coalesce(phone_normalized, '') then p_phone else phone end,
         pin_hash     = extensions.crypt(v_pin_clean, extensions.gen_salt('bf', 10)),
         pin_set_at   = now(),
         activated_at = coalesce(activated_at, now()),
         updated_at   = now()
   where id = v_drv.id
   returning * into v_drv;

  -- Consume the code.
  update public.driver_invite_codes
     set consumed_at = now()
   where code = v_invite.code;

  -- Re-activation revokes any prior sessions so the old device drops.
  update public.driver_sessions
     set revoked_at = now()
   where driver_id = v_drv.id
     and revoked_at is null;

  v_token := replace(gen_random_uuid()::text, '-', '')
          || replace(gen_random_uuid()::text, '-', '');

  insert into public.driver_sessions (token, dsp_id, driver_id, user_agent)
  values (v_token, v_drv.dsp_id, v_drv.id, p_user_agent);

  select * into v_dsp from public.dsps where id = v_drv.dsp_id;

  return jsonb_build_object(
    'token', v_token,
    'driver', jsonb_build_object(
      'id',         v_drv.id,
      'dsp_id',     v_drv.dsp_id,
      'full_name',  v_drv.full_name,
      'name',       coalesce(nullif(trim(v_drv.preferred_name), ''), v_drv.full_name),
      'station_id', v_drv.station_id,
      'tier',       v_drv.tier,
      'status',     v_drv.status,
      'dsp_name',   coalesce(v_dsp.name, ''),
      'phone_normalized', v_drv.phone_normalized
    )
  );
end;
$$;
grant execute on function public.driver_activate(text, text, text, text) to anon, authenticated;


-- ── 3c. driver_signin_with_phone — anon, phone+PIN for returning users
--
-- Once activated, this is the long-term login.  Verifies bcrypt PIN,
-- issues a session.  A brief rate-limit lives in driver_pin_attempts:
-- five failed attempts in 15 minutes on a given phone lock the phone
-- until the window rolls.  The error message is intentionally generic
-- ("invalid_phone_or_pin") to avoid distinguishing "no such driver"
-- from "wrong PIN" to a passive attacker.

create table if not exists public.driver_pin_attempts (
  phone_normalized text primary key,
  failed_count     int  not null default 0,
  last_failed_at   timestamptz,
  locked_until     timestamptz
);
alter table public.driver_pin_attempts enable row level security;
-- No public policies — only the SECURITY DEFINER RPCs touch it.

create or replace function public.driver_signin_with_phone(
  p_phone text,
  p_pin   text,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone_norm text;
  v_pin_clean  text;
  v_drv        public.drivers;
  v_dsp        public.dsps;
  v_token      text;
  v_att        public.driver_pin_attempts;
begin
  v_phone_norm := private.normalize_phone(p_phone);
  v_pin_clean  := regexp_replace(coalesce(p_pin, ''), '[^0-9]', '', 'g');
  if v_phone_norm is null or length(v_pin_clean) < 4 then
    raise exception 'invalid_phone_or_pin' using errcode = '22023';
  end if;

  -- Rate-limit check.
  select * into v_att from public.driver_pin_attempts where phone_normalized = v_phone_norm;
  if v_att.locked_until is not null and v_att.locked_until > now() then
    raise exception 'too_many_attempts' using errcode = '42501';
  end if;

  -- Pick the most-recently active driver for this phone within ANY DSP.
  -- The partial unique index guarantees at most one per DSP, and we
  -- preferentially pick onboarding/active over leave/inactive.
  select * into v_drv from public.drivers
   where phone_normalized = v_phone_norm
     and status in ('active','onboarding')
     and pin_hash is not null
   order by case status when 'active' then 0 when 'onboarding' then 1 else 2 end,
            updated_at desc
   limit 1;

  if v_drv.id is null
     or v_drv.pin_hash is null
     or v_drv.pin_hash <> extensions.crypt(v_pin_clean, v_drv.pin_hash) then
    -- Record failed attempt + maybe lock.
    insert into public.driver_pin_attempts (phone_normalized, failed_count, last_failed_at)
    values (v_phone_norm, 1, now())
    on conflict (phone_normalized) do update
      set failed_count   = public.driver_pin_attempts.failed_count + 1,
          last_failed_at = now(),
          locked_until   = case
            when public.driver_pin_attempts.failed_count + 1 >= 5 then now() + interval '15 minutes'
            else public.driver_pin_attempts.locked_until
          end;
    raise exception 'invalid_phone_or_pin' using errcode = '42501';
  end if;

  -- Success: clear the attempt row.
  delete from public.driver_pin_attempts where phone_normalized = v_phone_norm;

  v_token := replace(gen_random_uuid()::text, '-', '')
          || replace(gen_random_uuid()::text, '-', '');

  insert into public.driver_sessions (token, dsp_id, driver_id, user_agent)
  values (v_token, v_drv.dsp_id, v_drv.id, p_user_agent);

  select * into v_dsp from public.dsps where id = v_drv.dsp_id;

  return jsonb_build_object(
    'token', v_token,
    'driver', jsonb_build_object(
      'id',         v_drv.id,
      'dsp_id',     v_drv.dsp_id,
      'full_name',  v_drv.full_name,
      'name',       coalesce(nullif(trim(v_drv.preferred_name), ''), v_drv.full_name),
      'station_id', v_drv.station_id,
      'tier',       v_drv.tier,
      'status',     v_drv.status,
      'dsp_name',   coalesce(v_dsp.name, ''),
      'phone_normalized', v_drv.phone_normalized
    )
  );
end;
$$;
grant execute on function public.driver_signin_with_phone(text, text, text) to anon, authenticated;


-- ── 4. send_onboarding_invite — dispatcher resend ────────────────────
--
-- Wraps issue_driver_invite + the queue_outcome_message path so a
-- dispatcher can re-trigger the activation SMS/email at any time.
-- Useful when:
--   • The driver lost their phone with the invite still un-redeemed
--   • The previous code expired (>14 days)
--   • The applicant's phone or email was corrected after hire
--
-- Returns { code, code_expires_at, message_channel } so the dashboard
-- can show "Sent · code expires Mon 14th" inline.

create or replace function public.send_onboarding_invite(p_driver_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_drv public.drivers;
  v_dsp_row public.dsps;
  v_code text;
  v_alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_collision boolean;
  v_attempts int := 0;
  v_base_url text;
  v_app_url  text;
  v_app_login_url text;
  v_first_name text;
  v_dsp_name text;
  v_msg record;
  v_channel text := null;
  v_expires timestamptz;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_drv from public.drivers where id = p_driver_id and dsp_id = v_dsp;
  if v_drv.id is null then
    raise exception 'driver_not_found' using errcode = 'P0002';
  end if;
  if v_drv.status = 'terminated' then
    raise exception 'driver_terminated' using errcode = 'P0001';
  end if;

  -- Mint a code (matches issue_driver_invite's alphabet & uniqueness loop).
  loop
    v_code := '';
    for i in 1..8 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    select exists(select 1 from public.driver_invite_codes where code = v_code) into v_collision;
    v_attempts := v_attempts + 1;
    exit when not v_collision or v_attempts > 8;
  end loop;
  if v_collision then
    raise exception 'code_generation_failed';
  end if;

  -- Revoke any prior un-consumed code (one active at a time).
  update public.driver_invite_codes
     set expires_at = now()
   where driver_id = v_drv.id
     and consumed_at is null
     and expires_at > now();

  insert into public.driver_invite_codes (code, dsp_id, driver_id, created_by, expires_at)
  values (v_code, v_dsp, v_drv.id, auth.uid(), now() + interval '14 days')
  returning expires_at into v_expires;

  select * into v_dsp_row from public.dsps where id = v_dsp;
  v_base_url := coalesce(v_dsp_row.metadata->>'public_base_url', 'https://gorouteready.com');
  v_app_url       := v_base_url || '/app/';
  v_app_login_url := v_app_url || '?code=' || v_code;
  v_first_name    := coalesce(nullif(trim(v_drv.first_name), ''),
                              nullif(trim(v_drv.preferred_name), ''),
                              v_drv.full_name);
  v_dsp_name      := coalesce(v_dsp_row.name, '');

  -- Send via SMS if we have a phone, otherwise email.
  if v_drv.phone is not null then
    select * into v_msg from private.render_template(
      v_dsp, 'sms', 'applicant.outcome_hired',
      jsonb_build_object(
        'first_name',    v_first_name,
        'invite_code',   v_code,
        'app_url',       v_app_url,
        'app_login_url', v_app_login_url,
        'dsp_name',      v_dsp_name
      )
    );
    insert into public.sms_messages
      (dsp_id, applicant_id, direction, status, to_phone, body)
    values
      (v_dsp, v_drv.applicant_id, 'outbound', 'queued', v_drv.phone, v_msg.body);
    v_channel := 'sms';
  elsif v_drv.email is not null then
    select * into v_msg from private.render_template(
      v_dsp, 'email', 'applicant.outcome_hired',
      jsonb_build_object(
        'first_name',    v_first_name,
        'invite_code',   v_code,
        'app_url',       v_app_url,
        'app_login_url', v_app_login_url,
        'dsp_name',      v_dsp_name
      )
    );
    insert into public.email_messages
      (dsp_id, applicant_id, direction, status, to_email, subject, body_text)
    values
      (v_dsp, v_drv.applicant_id, 'outbound', 'queued', v_drv.email, v_msg.subject, v_msg.body);
    v_channel := 'email';
  end if;

  -- Record that we (re-)sent the welcome on the funnel.
  insert into public.onboarding_progress (driver_id, dsp_id, welcome_email_sent_at)
  values (v_drv.id, v_dsp, now())
  on conflict (driver_id) do update
    set welcome_email_sent_at = now(),
        updated_at = now();

  return jsonb_build_object(
    'code',            v_code,
    'code_expires_at', v_expires,
    'app_login_url',   v_app_login_url,
    'message_channel', v_channel,
    'sent_to',         case when v_channel = 'sms' then v_drv.phone
                            when v_channel = 'email' then v_drv.email
                            else null end
  );
end;
$$;
grant execute on function public.send_onboarding_invite(uuid) to authenticated;


-- ── 5. Refresh hire templates with activation copy ───────────────────
--
-- New copy reads as "Activate your driver profile" instead of "create
-- an account" — same payload (link with embedded code), warmer tone.
-- Only updates the global default (00..0d000) row + any tenant rows
-- whose body still matches the previous seed verbatim.

update public.message_templates
   set body = E'Welcome to {{dsp_name}}, {{first_name}}! Activate your driver profile here: {{app_login_url}}\n\nTap the link, confirm your phone, and pick a 4-digit PIN — that''s it. We''ve got your application details on file.\n\nYour personal activation code is {{invite_code}}.',
       updated_at = now()
 where channel = 'sms'
   and key = 'applicant.outcome_hired'
   and (body like 'Welcome to {{dsp_name}}, {{first_name}}! Download the {{dsp_name}} driver app:%'
        or body like 'Congrats {{first_name}}! You''ve been hired%');

update public.message_templates
   set subject = 'Activate your {{dsp_name}} driver profile',
       body = E'Hi {{first_name}},\n\nWelcome to the {{dsp_name}} team! We''re excited to get you on the road.\n\nWe''ve already set up your driver profile with the details from your application.  To finish, just activate it on your phone:\n\n   {{app_login_url}}\n\nWhat happens next:\n\n   1. Tap the link above on your phone.\n   2. Confirm your number (we''ll pre-fill what we have on file).\n   3. Pick a 4-digit PIN — that becomes your sign-in for next time.\n\nYour personal activation code is {{invite_code}}.  If you tap the link, the code is filled in for you automatically.\n\nOnce you''re in, your onboarding steps are waiting — handbook, Form I-9, and your start date.\n\n— The {{dsp_name}} team',
       updated_at = now()
 where channel = 'email'
   and key = 'applicant.outcome_hired'
   and (subject like 'Welcome to {{dsp_name}} — install your driver app%'
        or body like 'Congrats {{first_name}}!%');


notify pgrst, 'reload schema';
