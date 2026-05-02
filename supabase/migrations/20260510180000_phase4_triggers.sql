-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510180000 · Phase 4 triggers
--   1. Recompute applicant.score on every screening_response insert/update
--   2. Auto-flip stage to 'filtered' on hard_filter_failed
--   3. Block outbound sms_messages to opted-out phones
--   4. (Optional, deferred) When applicant.stage flips to 'hired' via
--      direct UPDATE, ensure a hired_driver_id exists. The hire_applicant
--      RPC already does this; the trigger is a safety net.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── 1 + 2: Score recompute + hard-filter cascade ───────────────────────

create or replace function private.fn_screening_response_score()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_total int;
  v_hard  boolean;
begin
  -- Recompute total score from all responses for the applicant
  select coalesce(sum(score_awarded), 0),
         bool_or(hard_filter_failed)
    into v_total, v_hard
    from public.screening_responses
   where applicant_id = new.applicant_id;

  if v_hard then
    update public.applicants
       set score = v_total,
           stage = case when stage in ('new','screening') then 'filtered'::public.applicant_stage
                        else stage end
     where id = new.applicant_id;
  else
    update public.applicants
       set score = v_total,
           -- Auto-advance new → screening on first response
           stage = case when stage = 'new' then 'screening'::public.applicant_stage
                        else stage end
     where id = new.applicant_id;
  end if;

  return new;
end $$;

create trigger trg_screening_responses_score
  after insert or update on public.screening_responses
  for each row execute function private.fn_screening_response_score();

comment on function private.fn_screening_response_score() is
  'After every screening_response insert/update, recomputes the ' ||
  'applicant.score and flips stage to filtered if any hard_filter ' ||
  'failed, or new → screening on first response.';

-- ─── 3: Block outbound SMS to opted-out phones ──────────────────────────

create or replace function private.fn_sms_check_opt_out()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_norm text;
begin
  if new.direction = 'outbound' then
    v_norm := private.normalize_phone(new.to_phone);
    if v_norm is null then
      raise exception 'sms_messages: outbound to_phone % is not valid E.164', new.to_phone;
    end if;
    if exists (
      select 1 from public.sms_opt_outs
       where dsp_id = new.dsp_id and phone = v_norm
    ) then
      -- Don't insert; instead, raise so the calling RPC fails loudly.
      raise exception 'sms_messages: phone % has opted out for DSP %', v_norm, new.dsp_id
        using errcode = 'restrict_violation';
    end if;
    -- Persist normalized form
    new.to_phone := v_norm;
  end if;
  return new;
end $$;

create trigger trg_sms_messages_check_opt_out
  before insert on public.sms_messages
  for each row execute function private.fn_sms_check_opt_out();

comment on function private.fn_sms_check_opt_out() is
  'Outbound sms_messages: normalize to_phone to E.164 and reject if the ' ||
  'phone is in sms_opt_outs for this DSP. TCPA-required guard.';

-- ─── 4: Hire safety net ────────────────────────────────────────────────
-- If someone updates applicants.stage directly to 'hired' without going
-- through hire_applicant(), we DON'T auto-create the driver — but we DO
-- raise so the bypass is visible. The proper path is the RPC.

create or replace function private.fn_applicant_hire_guard()
returns trigger
language plpgsql as $$
begin
  if new.stage = 'hired' and old.stage <> 'hired' and new.hired_driver_id is null then
    raise exception 'applicants: cannot set stage=hired without hired_driver_id. ' ||
                    'Use public.hire_applicant() instead of direct UPDATE.';
  end if;
  return new;
end $$;

create trigger trg_applicants_hire_guard
  before update on public.applicants
  for each row execute function private.fn_applicant_hire_guard();
