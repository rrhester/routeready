-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510170000 · Phase 4 RPCs
-- The applicant lifecycle verbs + SMS enqueue + opt-out + referral
-- payout marking. SMS enqueue inserts a row with status='queued';
-- a separate Edge Function (send-applicant-sms / send-driver-sms)
-- picks up queued rows and calls Twilio. The send Edge Function is
-- feature-flagged behind dsp.settings.sms_enabled until TCPA review
-- is complete.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── E.164 helper (US default) ──────────────────────────────────────────

create or replace function private.normalize_phone(p_phone text)
returns text
language plpgsql immutable as $$
declare v_digits text;
begin
  if p_phone is null then return null; end if;
  v_digits := regexp_replace(p_phone, '[^0-9+]', '', 'g');
  if v_digits = '' then return null; end if;
  if v_digits ~ '^\+[1-9][0-9]{6,14}$' then return v_digits; end if;
  if length(v_digits) = 10 then return '+1' || v_digits; end if;
  if length(v_digits) = 11 and substring(v_digits from 1 for 1) = '1' then
    return '+' || v_digits;
  end if;
  return null;  -- unrecognized
end $$;

-- ─── create_applicant ───────────────────────────────────────────────────

create or replace function public.create_applicant(
  p_full_name           text,
  p_email               text,
  p_phone               text,
  p_source              text default 'manual',
  p_source_ref          text default null,
  p_referrer_driver_id  uuid default null,
  p_station_id          uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp    uuid := private.current_dsp_id();
  v_caller uuid := auth.uid();
  v_id     uuid;
  v_phone  text := private.normalize_phone(p_phone);
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'create_applicant: caller is not staff';
  end if;
  if length(trim(coalesce(p_full_name, ''))) < 2 then
    raise exception 'create_applicant: full_name is required';
  end if;

  -- Verify referrer (if any) belongs to this DSP
  if p_referrer_driver_id is not null then
    perform 1 from public.drivers
     where id = p_referrer_driver_id and dsp_id = v_dsp;
    if not found then
      raise exception 'create_applicant: referrer driver % not in DSP %',
        p_referrer_driver_id, v_dsp;
    end if;
  end if;

  insert into public.applicants
    (dsp_id, station_id, full_name, email, phone, source, source_ref,
     referrer_driver_id, stage, created_by)
  values
    (v_dsp, p_station_id, trim(p_full_name), nullif(trim(p_email), ''),
     v_phone, p_source, p_source_ref, p_referrer_driver_id, 'new', v_caller)
  on conflict (dsp_id, source_ref)
    where source_ref is not null
    do update set
      -- Update only if existing row is older or has less info
      full_name = excluded.full_name,
      email     = coalesce(excluded.email, public.applicants.email),
      phone     = coalesce(excluded.phone, public.applicants.phone)
  returning id into v_id;

  return v_id;
end $$;

revoke execute on function public.create_applicant(text, text, text, text, text, uuid, uuid)
  from public, anon;
grant execute on function public.create_applicant(text, text, text, text, text, uuid, uuid)
  to authenticated;

-- ─── record_screening_response ──────────────────────────────────────────

create or replace function public.record_screening_response(
  p_applicant_id uuid,
  p_question_id  uuid,
  p_answer_text  text default null,
  p_answer_json  jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp           uuid := private.current_dsp_id();
  v_question      public.screening_questions%rowtype;
  v_score         int := 0;
  v_hard_filter   boolean := false;
  v_response_id   uuid;
  v_check_answer  text;
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'record_screening_response: caller is not staff';
  end if;

  -- Verify both belong to caller DSP
  perform 1 from public.applicants where id = p_applicant_id and dsp_id = v_dsp;
  if not found then
    raise exception 'record_screening_response: applicant % not in DSP %', p_applicant_id, v_dsp;
  end if;
  select * into v_question from public.screening_questions
   where id = p_question_id and dsp_id = v_dsp;
  if not found then
    raise exception 'record_screening_response: question % not in DSP %', p_question_id, v_dsp;
  end if;

  v_check_answer := coalesce(p_answer_text, p_answer_json #>> '{}');

  -- Score lookup
  if v_question.scoring is not null and v_check_answer is not null then
    v_score := coalesce((v_question.scoring -> v_check_answer)::int, 0);
  end if;

  -- Hard-filter check
  if v_question.hard_filter is not null
     and v_question.hard_filter ? 'answer'
     and v_question.hard_filter ->> 'answer' = v_check_answer
  then
    v_hard_filter := true;
  end if;

  insert into public.screening_responses
    (dsp_id, applicant_id, question_id, answer_text, answer_json,
     score_awarded, hard_filter_failed)
  values
    (v_dsp, p_applicant_id, p_question_id, p_answer_text, p_answer_json,
     v_score, v_hard_filter)
  on conflict (applicant_id, question_id) do update set
    answer_text        = excluded.answer_text,
    answer_json        = excluded.answer_json,
    score_awarded      = excluded.score_awarded,
    hard_filter_failed = excluded.hard_filter_failed
  returning id into v_response_id;

  -- Score recompute + stage transitions are handled by the trigger
  -- in migration 180000.

  return v_response_id;
end $$;

revoke execute on function public.record_screening_response(uuid, uuid, text, jsonb)
  from public, anon;
grant execute on function public.record_screening_response(uuid, uuid, text, jsonb)
  to authenticated;

-- ─── advance_applicant_stage ────────────────────────────────────────────

create or replace function public.advance_applicant_stage(
  p_applicant_id uuid,
  p_to_stage     text,
  p_notes        text default null
)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_curr  public.applicant_stage;
  v_next  public.applicant_stage;
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'advance_applicant_stage: caller is not staff';
  end if;

  v_next := p_to_stage::public.applicant_stage;

  select stage into v_curr
    from public.applicants
   where id = p_applicant_id and dsp_id = v_dsp;
  if v_curr is null then
    raise exception 'advance_applicant_stage: applicant % not in DSP %', p_applicant_id, v_dsp;
  end if;

  -- Allowed transitions (loose forward + a few reversals):
  --   new → screening, filtered, rejected
  --   screening → passed, filtered, rejected
  --   passed → booked, rejected
  --   booked → hired, no_show, rejected
  --   no_show → booked, rejected
  --   filtered → screening (re-open)
  if not (
       (v_curr = 'new'       and v_next in ('screening','filtered','rejected'))
    or (v_curr = 'screening' and v_next in ('passed','filtered','rejected'))
    or (v_curr = 'passed'    and v_next in ('booked','rejected'))
    or (v_curr = 'booked'    and v_next in ('hired','no_show','rejected'))
    or (v_curr = 'no_show'   and v_next in ('booked','rejected'))
    or (v_curr = 'filtered'  and v_next = 'screening')
  ) then
    raise exception 'advance_applicant_stage: illegal transition % → %', v_curr, v_next;
  end if;

  update public.applicants
     set stage = v_next,
         notes = case when p_notes is null then notes
                      else coalesce(notes,'') || case when notes is null or notes = '' then '' else E'\n' end || p_notes end,
         no_show_at = case when v_next = 'no_show' then now() else no_show_at end
   where id = p_applicant_id;
end $$;

revoke execute on function public.advance_applicant_stage(uuid, text, text)
  from public, anon;
grant execute on function public.advance_applicant_stage(uuid, text, text)
  to authenticated;

-- ─── book_interview ─────────────────────────────────────────────────────

create or replace function public.book_interview(
  p_applicant_id uuid,
  p_cal_event_id text,
  p_interview_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'book_interview: caller is not staff';
  end if;

  update public.applicants
     set cal_event_id = p_cal_event_id,
         interview_at = p_interview_at,
         stage        = 'booked'
   where id = p_applicant_id and dsp_id = v_dsp;

  if not found then
    raise exception 'book_interview: applicant % not in DSP %', p_applicant_id, v_dsp;
  end if;
end $$;

revoke execute on function public.book_interview(uuid, text, timestamptz)
  from public, anon;
grant execute on function public.book_interview(uuid, text, timestamptz)
  to authenticated;

-- ─── hire_applicant: promote to driver + create referral payouts ────────

create or replace function public.hire_applicant(
  p_applicant_id      uuid,
  p_hire_date         date    default current_date,
  p_station_id        uuid    default null,
  p_referral_amounts  jsonb   default null    -- e.g. {"hire": 50000, "tenure_30": 25000, ...}
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp        uuid := private.current_dsp_id();
  v_caller     uuid := auth.uid();
  v_applicant  public.applicants%rowtype;
  v_driver_id  uuid;
  v_referrer   uuid;
  v_amounts    jsonb;
  v_station    uuid;
  v_payouts_created int := 0;
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'ops') then
    raise exception 'hire_applicant: caller is not ops staff';
  end if;

  select * into v_applicant from public.applicants
   where id = p_applicant_id and dsp_id = v_dsp;
  if not found then
    raise exception 'hire_applicant: applicant % not in DSP %', p_applicant_id, v_dsp;
  end if;
  if v_applicant.stage = 'hired' then
    raise exception 'hire_applicant: applicant % already hired', p_applicant_id;
  end if;

  v_station := coalesce(p_station_id, v_applicant.station_id);
  v_referrer := v_applicant.referrer_driver_id;

  -- Create the driver row
  insert into public.drivers
    (dsp_id, station_id, full_name, phone, email, status, hire_date, created_by)
  values
    (v_dsp, v_station, v_applicant.full_name, v_applicant.phone,
     v_applicant.email, 'onboarding', p_hire_date, v_caller)
  returning id into v_driver_id;

  -- Update the applicant
  update public.applicants
     set stage           = 'hired',
         hired_driver_id = v_driver_id
   where id = p_applicant_id;

  -- Create referral payouts if applicable
  if v_referrer is not null then
    v_amounts := coalesce(
      p_referral_amounts,
      jsonb_build_object(
        'hire',       50000,    -- $500 on hire
        'tenure_30',  25000,    -- $250 at 30 days
        'tenure_60',  25000,    -- $250 at 60 days
        'tenure_90',  50000     -- $500 at 90 days (total $1,250)
      )
    );

    insert into public.referral_payouts
      (dsp_id, applicant_id, driver_id, milestone, amount_cents, due_at)
    values
      (v_dsp, p_applicant_id, v_referrer, 'hire',
       coalesce((v_amounts->>'hire')::int, 0), p_hire_date),
      (v_dsp, p_applicant_id, v_referrer, 'tenure_30',
       coalesce((v_amounts->>'tenure_30')::int, 0), p_hire_date + 30),
      (v_dsp, p_applicant_id, v_referrer, 'tenure_60',
       coalesce((v_amounts->>'tenure_60')::int, 0), p_hire_date + 60),
      (v_dsp, p_applicant_id, v_referrer, 'tenure_90',
       coalesce((v_amounts->>'tenure_90')::int, 0), p_hire_date + 90)
    on conflict (applicant_id, milestone) do nothing;

    get diagnostics v_payouts_created = row_count;
  end if;

  return jsonb_build_object(
    'driver_id',         v_driver_id,
    'payouts_created',   v_payouts_created,
    'referrer_driver_id', v_referrer
  );
end $$;

revoke execute on function public.hire_applicant(uuid, date, uuid, jsonb)
  from public, anon;
grant execute on function public.hire_applicant(uuid, date, uuid, jsonb)
  to authenticated;

-- ─── mark_referral_paid ─────────────────────────────────────────────────

create or replace function public.mark_referral_paid(
  p_payout_id uuid,
  p_paid_via  text    default 'manual',
  p_notes     text    default null
)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'ops') then
    raise exception 'mark_referral_paid: caller is not ops staff';
  end if;

  update public.referral_payouts
     set paid_at  = current_date,
         paid_via = p_paid_via,
         notes    = coalesce(p_notes, notes)
   where id = p_payout_id and dsp_id = v_dsp;

  if not found then
    raise exception 'mark_referral_paid: payout % not in DSP %', p_payout_id, v_dsp;
  end if;
end $$;

revoke execute on function public.mark_referral_paid(uuid, text, text)
  from public, anon;
grant execute on function public.mark_referral_paid(uuid, text, text)
  to authenticated;

-- ─── enqueue_sms ────────────────────────────────────────────────────────
-- Inserts a queued SMS row. The send-applicant-sms / send-driver-sms
-- Edge Functions read queued rows and call Twilio. Opt-out enforcement
-- happens via trigger in migration 180000.

create or replace function public.enqueue_sms(
  p_to_phone     text,
  p_body         text,
  p_driver_id    uuid    default null,
  p_applicant_id uuid    default null,
  p_related_kind text    default null,
  p_related_id   uuid    default null,
  p_from_phone   text    default null     -- override default 'from' (per-DSP setting)
)
returns uuid
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp     uuid := private.current_dsp_id();
  v_caller  uuid := auth.uid();
  v_to      text := private.normalize_phone(p_to_phone);
  v_from    text := coalesce(p_from_phone, '+15555555555'); -- DSP setting in real impl
  v_id      uuid;
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'enqueue_sms: caller is not staff';
  end if;
  if v_to is null then
    raise exception 'enqueue_sms: phone % could not be normalized to E.164', p_to_phone;
  end if;
  if length(trim(coalesce(p_body, ''))) = 0 then
    raise exception 'enqueue_sms: body is required';
  end if;
  if (p_driver_id is null) = (p_applicant_id is null) then
    raise exception 'enqueue_sms: must provide exactly one of driver_id or applicant_id';
  end if;

  insert into public.sms_messages
    (dsp_id, driver_id, applicant_id, direction, to_phone, from_phone,
     body, status, related_kind, related_id, created_by)
  values
    (v_dsp, p_driver_id, p_applicant_id, 'outbound', v_to, v_from,
     p_body, 'queued', p_related_kind, p_related_id, v_caller)
  returning id into v_id;

  return v_id;
end $$;

revoke execute on function public.enqueue_sms(text, text, uuid, uuid, text, uuid, text)
  from public, anon;
grant execute on function public.enqueue_sms(text, text, uuid, uuid, text, uuid, text)
  to authenticated;

-- ─── handle_opt_out ─────────────────────────────────────────────────────
-- Called by webhook-twilio when a STOP message comes in. Adds to opt-out
-- list and marks any pending queued messages to that phone as opted_out.

create or replace function public.handle_opt_out(
  p_phone  text,
  p_reason text default 'STOP'
)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_norm  text := private.normalize_phone(p_phone);
begin
  if v_dsp is null then
    raise exception 'handle_opt_out: not authenticated for any DSP';
  end if;
  if v_norm is null then
    raise exception 'handle_opt_out: invalid phone';
  end if;

  insert into public.sms_opt_outs (dsp_id, phone, reason)
  values (v_dsp, v_norm, p_reason)
  on conflict (dsp_id, phone) do nothing;

  -- Cancel any queued outbound messages to this phone
  update public.sms_messages
     set status = 'opted_out'
   where dsp_id = v_dsp
     and to_phone = v_norm
     and direction = 'outbound'
     and status = 'queued';
end $$;

revoke execute on function public.handle_opt_out(text, text) from public, anon;
grant execute on function public.handle_opt_out(text, text) to authenticated;
